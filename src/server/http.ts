/**
 * HTTP 层：REST + SSE + 静态前端。只做校验和转发，所有状态变更都在 Studio / Driver 里。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

import type {
  ApprovalGate,
  CatId,
  Driver,
  ToolRegistry,
  RoomId,
  Scenario,
  SettingsApi,
  SettingsPatch,
  StudioState,
  TaskId,
} from "../domain/types.ts";
import {
  addScenario,
  listScenarios,
  removeScenario,
} from "../agents/scenario-registry.ts";
import type { CatPatch, Studio } from "./studio.ts";
import type { Sandbox } from "../tools/sandbox.ts";
import type { McpManager, McpInput } from "../mcp/manager.ts";
import type { WorkspaceManager } from "../workspaces/manager.ts";
import { TestRunner } from "./test-runner.ts";
import { listSkills } from "../skills/registry.ts";

export interface HttpDeps {
  studio: Studio;
  driver: Driver;
  publicDir: string;
  scenarios: Scenario[];
  mode?: "mock" | "llm";
  /** 设置面板后端；不传则相关接口返回 503（测试/精简启动可用）。 */
  settingsApi?: SettingsApi;
  /** 沙盒工具运行时；不传则 workspace 接口返回 503。 */
  sandbox?: Sandbox;
  /** 审批闸门；不传则审批接口返回 503。 */
  approvals?: ApprovalGate;
  /** 工具注册表（GET /api/tools）。 */
  tools?: ToolRegistry;
  /** MCP 管理器；不传则 MCP 接口返回 503。 */
  mcp?: McpManager;
  /** 工作区管理器；不传则 workspaces 接口返回 503。 */
  workspaces?: WorkspaceManager;
  /** 测试中心；不传则 tests 接口返回 503。 */
  tests?: TestRunner;
  /** 前端用来判断「卡住」的阈值；不传按 driver.stallMs / 12s。 */
  stallMs?: number;
}

const MAX_BODY = 64 * 1024;
const MAX_TEXT = 2000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function fail(res: ServerResponse, status: number, message: string): void {
  json(res, status, { error: message });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new Error("request body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("invalid JSON body");
  }
}

/** 从文本里解析 @名字 / @id。 */
export function parseMentions(text: string, studio: Studio, roomId: RoomId): CatId[] {
  const room = studio.getRoom(roomId);
  if (!room) return [];
  const cats = studio.state.cats.filter((c) => room.catIds.includes(c.id));
  const found = new Set<CatId>();
  const re = /@([^\s@，。！？,.!?、:：;；]+)/g;
  for (const match of text.matchAll(re)) {
    const token = match[1] ?? "";
    const byName = cats.find((c) => token.startsWith(c.name) || token === c.name);
    const byId = cats.find((c) => token === c.id);
    const cat = byName ?? byId;
    if (cat) found.add(cat.id);
  }
  return [...found];
}

function pickScenario(scenarios: Scenario[], brief: string): string {
  const text = brief.toLowerCase();
  let best: { id: string; score: number } | null = null;
  for (const scenario of scenarios) {
    let score = 0;
    for (const tag of scenario.tags) if (text.includes(tag.toLowerCase())) score += 2;
    for (const word of scenario.sampleBrief.split(/[\s，。,.!?？、]+/)) {
      if (word.length >= 2 && text.includes(word.toLowerCase())) score += 1;
    }
    if (!best || score > best.score) best = { id: scenario.id, score };
  }
  return best?.id ?? scenarios[0]?.id ?? "remember_me";
}

const CAT_TEXT_FIELDS = ["name", "title", "persona", "catchphrase", "greeting", "accent"] as const;

function parseCatPatch(body: unknown): CatPatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("请求体必须是对象");
  }
  const record = body as Record<string, unknown>;
  const patch: CatPatch = {};
  for (const field of CAT_TEXT_FIELDS) {
    const value = record[field];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new Error(`${field} 必须是字符串`);
    patch[field] = value;
  }
  const model = record["llmModel"];
  if (model !== undefined) {
    if (model !== null && typeof model !== "string") {
      throw new Error("llmModel 必须是字符串或 null");
    }
    patch.llmModel = model;
  }
  const temperature = record["llmTemperature"];
  if (temperature !== undefined) {
    if (temperature !== null && typeof temperature !== "number") {
      throw new Error("llmTemperature 必须是数字或 null");
    }
    patch.llmTemperature = temperature;
  }
  for (const field of ["tools", "skills"] as const) {
    const value = record[field];
    if (value === undefined) continue;
    if (value !== null && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
      throw new Error(`${field} 必须是字符串数组或 null`);
    }
    patch[field] = value as string[] | null;
  }
  if (Object.keys(patch).length === 0) throw new Error("没有可更新的字段");
  return patch;
}

function serveStatic(res: ServerResponse, publicDir: string, pathname: string): void {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (rel.includes("..") || rel.startsWith(".")) {
    fail(res, 400, "bad path");
    return;
  }
  const allowed = new Set([".html", ".js", ".css", ".svg", ".png", ".ico"]);
  if (!allowed.has(extname(rel))) {
    fail(res, 404, "not found");
    return;
  }
  const root = resolve(publicDir);
  const file = normalize(join(root, rel));
  if (!file.startsWith(root)) {
    fail(res, 400, "bad path");
    return;
  }
  readFile(file)
    .then((buf) => {
      res.writeHead(200, {
        "Content-Type": MIME[extname(rel)] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(buf);
    })
    .catch(() => {
      if (extname(rel) === ".html") fail(res, 404, "index.html missing");
      else fail(res, 404, "not found");
    });
}

export function createHttpServer(deps: HttpDeps): Server {
  const { studio, driver, scenarios, settingsApi, sandbox, approvals, tools, mcp, workspaces } = deps;
  const tests = deps.tests;
  const publicDir = deps.publicDir;

  return createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "internal error";
      if (!res.headersSent) fail(res, 500, message);
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && pathname === "/api/health") {
      json(res, 200, {
        ok: true,
        mode: studio.state.mode ?? deps.mode ?? "mock",
        seq: studio.state.seq,
        stallMs: deps.stallMs ?? driver.stallMs ?? 12000,
        settings: Boolean(settingsApi),
      });
      return;
    }

    if (pathname === "/api/settings") {
      if (!settingsApi) {
        fail(res, 503, "settings api not enabled");
        return;
      }
      if (method === "GET") {
        json(res, 200, settingsApi.getPublic());
        return;
      }
      if (method === "PUT") {
        const body = (await readBody(req)) as SettingsPatch;
        if (!body || typeof body !== "object") {
          fail(res, 400, "invalid settings payload");
          return;
        }
        try {
          json(res, 200, await settingsApi.update(body));
        } catch (err) {
          fail(res, 400, err instanceof Error ? err.message : "invalid settings");
        }
        return;
      }
      fail(res, 405, "method not allowed");
      return;
    }

    if (method === "POST" && pathname === "/api/settings/test") {
      if (!settingsApi) {
        fail(res, 503, "settings api not enabled");
        return;
      }
      const body = (await readBody(req)) as {
        baseUrl?: unknown;
        model?: unknown;
        apiKey?: unknown;
      };
      const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : "";
      const model = typeof body.model === "string" ? body.model : "";
      const apiKey = typeof body.apiKey === "string" ? body.apiKey : undefined;
      if (!baseUrl.trim() || !model.trim()) {
        fail(res, 400, "baseUrl 和 model 都必填");
        return;
      }
      json(res, 200, await settingsApi.test({ baseUrl, model, ...(apiKey ? { apiKey } : {}) }));
      return;
    }

    if (method === "GET" && pathname === "/api/state") {
      json(res, 200, studio.snapshot());
      return;
    }

    if (method === "GET" && pathname === "/api/events") {
      streamEvents(req, res);
      return;
    }

    if (method === "POST" && pathname === "/api/reset") {
      const state = studio.reset();
      json(res, 200, { ok: true, seq: state.seq });
      return;
    }

    if (pathname === "/api/workspaces" && (method === "GET" || method === "POST")) {
      if (!workspaces) {
        fail(res, 503, "workspace manager not enabled");
        return;
      }
      if (method === "GET") {
        const bound = new Set(studio.state.rooms.map((room) => room.workspaceId));
        json(res, 200, {
          workspaces: workspaces.list().map((workspace) => ({
            ...workspace,
            roomCount: studio.state.rooms.filter((room) => room.workspaceId === workspace.id).length,
            bound: bound.has(workspace.id),
          })),
        });
        return;
      }
      const body = (await readBody(req)) as Record<string, unknown>;
      if (body["policy"] === "read-write" && body["confirm"] !== true) {
        fail(res, 400, "添加读写工作区需要显式确认（confirm: true）");
        return;
      }
      try {
        json(res, 201, { workspace: workspaces.add(body) });
      } catch (err) {
        fail(res, 400, err instanceof Error ? err.message : "invalid workspace");
      }
      return;
    }

    {
      const workspaceMatch = /^\/api\/workspaces\/([^/]+)(?:\/(git|files|file))?(?:\/(diff))?$/.exec(pathname);
      if (workspaceMatch && method === "GET") {
        if (!workspaces) {
          fail(res, 503, "workspace manager not enabled");
          return;
        }
        const workspaceId = decodeURIComponent(workspaceMatch[1] ?? "");
        const action = workspaceMatch[2];
        const sub = workspaceMatch[3];
        if (!workspaces.get(workspaceId)) {
          fail(res, 404, "工作区不存在");
          return;
        }
        if (!action) {
          json(res, 200, { workspace: workspaces.get(workspaceId) });
          return;
        }
        if (action === "files") {
          json(res, 200, { files: workspaces.files(workspaceId) });
          return;
        }
        if (action === "file") {
          const path = url.searchParams.get("path") ?? "";
          try {
            json(res, 200, workspaces.rawSandbox(workspaceId).readTextFile(path));
          } catch (err) {
            fail(res, 400, err instanceof Error ? err.message : "cannot read file");
          }
          return;
        }
        if (action === "git" && sub === "diff") {
          json(res, 200, await workspaces.gitDiff(workspaceId));
          return;
        }
        if (action === "git") {
          json(res, 200, await workspaces.gitInfo(workspaceId));
          return;
        }
        fail(res, 404, "not found");
        return;
      }
      if (workspaceMatch && method === "DELETE" && !workspaceMatch[2]) {
        if (!workspaces) {
          fail(res, 503, "workspace manager not enabled");
          return;
        }
        const workspaceId = decodeURIComponent(workspaceMatch[1] ?? "");
        if (studio.state.rooms.some((room) => room.workspaceId === workspaceId)) {
          fail(res, 400, "还有房间绑定这个工作区，先解绑再删除");
          return;
        }
        try {
          if (!workspaces.remove(workspaceId)) {
            fail(res, 404, "工作区不存在");
            return;
          }
          json(res, 200, { ok: true });
        } catch (err) {
          fail(res, 400, err instanceof Error ? err.message : "cannot remove workspace");
        }
        return;
      }
    }

    if (pathname === "/api/rooms" && method === "POST") {
      if (!workspaces) {
        fail(res, 503, "workspace manager not enabled");
        return;
      }
      const body = (await readBody(req)) as {
        name?: unknown;
        workspaceId?: unknown;
        topic?: unknown;
      };
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
      if (!workspaces.get(workspaceId)) {
        fail(res, 400, "workspaceId 不存在");
        return;
      }
      try {
        const room = studio.createRoom({
          name,
          workspaceId,
          ...(typeof body.topic === "string" ? { topic: body.topic } : {}),
        });
        json(res, 201, room);
      } catch (err) {
        fail(res, 400, err instanceof Error ? err.message : "invalid room");
      }
      return;
    }

    {
      const roomMatch = /^\/api\/rooms\/([^/]+)$/.exec(pathname);
      if (roomMatch && method === "PATCH") {
        const roomId = decodeURIComponent(roomMatch[1] ?? "");
        if (!studio.getRoom(roomId)) {
          fail(res, 404, "房间不存在");
          return;
        }
        const rawBody = await readBody(req);
        if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
          fail(res, 400, "请求体必须是对象");
          return;
        }
        const body = rawBody as {
          name?: unknown;
          topic?: unknown;
          workspaceId?: unknown;
        };
        const patch: { name?: string; topic?: string; workspaceId?: string } = {};
        if (body.name !== undefined) {
          if (typeof body.name !== "string") {
            fail(res, 400, "name 必须是字符串");
            return;
          }
          const name = body.name.trim();
          if (name.length < 1 || name.length > 30) {
            fail(res, 400, "房间名需要 1–30 个字符");
            return;
          }
          if (studio.state.rooms.some((room) => room.id !== roomId && room.name === name)) {
            fail(res, 400, `房间「${name}」已存在`);
            return;
          }
          patch.name = name;
        }
        if (body.topic !== undefined) {
          if (typeof body.topic !== "string") {
            fail(res, 400, "topic 必须是字符串");
            return;
          }
          const topic = body.topic.trim();
          if (topic.length > 120) {
            fail(res, 400, "主题不能超过 120 个字符");
            return;
          }
          patch.topic = topic;
        }
        if (body.workspaceId !== undefined) {
          if (!workspaces) {
            fail(res, 503, "workspace manager not enabled");
            return;
          }
          if (typeof body.workspaceId !== "string" || !workspaces.get(body.workspaceId)) {
            fail(res, 400, "workspaceId 不存在");
            return;
          }
          patch.workspaceId = body.workspaceId;
        }
        if (Object.keys(patch).length === 0) {
          fail(res, 400, "没有可更新的字段");
          return;
        }
        try {
          json(res, 200, studio.updateRoom(roomId, patch));
        } catch (err) {
          fail(res, 400, err instanceof Error ? err.message : "invalid room patch");
        }
        return;
      }
      if (roomMatch && method === "DELETE") {
        const roomId = decodeURIComponent(roomMatch[1] ?? "");
        if (!studio.getRoom(roomId)) {
          fail(res, 404, "房间不存在");
          return;
        }
        try {
          json(res, 200, { ok: true, removed: studio.deleteRoom(roomId) });
        } catch (err) {
          fail(res, 400, err instanceof Error ? err.message : "cannot delete room");
        }
        return;
      }
    }

    {
      const roomMatch = /^\/api\/rooms\/([^/]+)$/.exec(pathname);
      if (roomMatch && method === "PUT") {
        if (!workspaces) {
          fail(res, 503, "workspace manager not enabled");
          return;
        }
        const roomId = decodeURIComponent(roomMatch[1] ?? "");
        const body = (await readBody(req)) as { workspaceId?: unknown };
        const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
        if (!workspaces.get(workspaceId)) {
          fail(res, 400, "workspaceId 不存在");
          return;
        }
        if (!studio.getRoom(roomId)) {
          fail(res, 404, "房间不存在");
          return;
        }
        json(res, 200, studio.setRoomWorkspace(roomId, workspaceId));
        return;
      }
    }

    if (pathname === "/api/tests/run" && method === "POST") {
      if (!tests) {
        fail(res, 503, "test runner not enabled");
        return;
      }
      const body = (await readBody(req)) as {
        kind?: unknown;
        scenario?: unknown;
      };
      const kind = body.kind;
      if (kind !== "unit" && kind !== "real" && kind !== "scenario") {
        fail(res, 400, "kind 只能是 unit / real / scenario");
        return;
      }
      const scenario = typeof body.scenario === "string" ? body.scenario : undefined;
      try {
        const run = tests.start(kind, scenario);
        json(res, 202, {
          runId: run.id,
          kind: run.kind,
          ...(run.scenario ? { scenario: run.scenario } : {}),
          startedAt: run.startedAt,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "cannot start test";
        // 已经在跑 → 409；其它（没配 key / 未知场景）→ 400。
        fail(res, message.includes("已经在跑") ? 409 : 400, message);
      }
      return;
    }

    if (pathname === "/api/tests/runs" && method === "GET") {
      if (!tests) {
        fail(res, 503, "test runner not enabled");
        return;
      }
      json(res, 200, { runs: tests.list() });
      return;
    }

    if (pathname === "/api/tests/stream" && method === "GET") {
      if (!tests) {
        fail(res, 503, "test runner not enabled");
        return;
      }
      streamTestEvents(req, res);
      return;
    }

    {
      const testRunMatch = /^\/api\/tests\/runs\/([^/]+)$/.exec(pathname);
      if (testRunMatch) {
        if (!tests) {
          fail(res, 503, "test runner not enabled");
          return;
        }
        const runId = decodeURIComponent(testRunMatch[1] ?? "");
        const run = tests.get(runId);
        if (!run) {
          fail(res, 404, "测试记录不存在");
          return;
        }
        if (method === "GET") {
          json(res, 200, run);
          return;
        }
        if (method === "DELETE") {
          const cancelled = tests.cancel(runId);
          json(res, cancelled ? 200 : 409, cancelled ? { ok: true } : { error: "该测试不在运行中" });
          return;
        }
        fail(res, 405, "method not allowed");
        return;
      }
    }

    if (pathname === "/api/tools" && method === "GET") {
      json(res, 200, { tools: tools?.list() ?? [] });
      return;
    }

    if (pathname === "/api/skills" && method === "GET") {
      json(res, 200, { skills: listSkills() });
      return;
    }

    if (pathname === "/api/mcp" && (method === "GET" || method === "POST")) {
      if (!mcp) {
        fail(res, 503, "mcp manager not enabled");
        return;
      }
      if (method === "GET") {
        json(res, 200, { servers: mcp.list() });
        return;
      }
      const body = (await readBody(req)) as McpInput;
      if (!body || typeof body !== "object") {
        fail(res, 400, "invalid mcp payload");
        return;
      }
      try {
        json(res, 201, { server: await mcp.add(body) });
      } catch (err) {
        fail(res, 400, err instanceof Error ? err.message : "invalid mcp server");
      }
      return;
    }

    {
      const mcpMatch = /^\/api\/mcp\/([^/]+)(?:\/(test|toggle))?$/.exec(pathname);
      if (mcpMatch) {
        if (!mcp) {
          fail(res, 503, "mcp manager not enabled");
          return;
        }
        const serverId = decodeURIComponent(mcpMatch[1] ?? "");
        const action = mcpMatch[2];
        if (method === "DELETE" && !action) {
          if (!(await mcp.remove(serverId))) {
            fail(res, 404, "MCP server 不存在");
            return;
          }
          json(res, 200, { ok: true });
          return;
        }
        if (method === "PUT" && !action) {
          const body = (await readBody(req)) as McpInput;
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            fail(res, 400, "invalid mcp payload");
            return;
          }
          if (!mcp.list().some((server) => server.id === serverId)) {
            fail(res, 404, "MCP server 不存在");
            return;
          }
          try {
            json(res, 200, { server: await mcp.update(serverId, body) });
          } catch (err) {
            fail(res, 400, err instanceof Error ? err.message : "invalid mcp server");
          }
          return;
        }
        if (method === "POST" && action === "test") {
          const body = (await readBody(req)) as McpInput;
          json(res, 200, await mcp.test({ ...body, id: serverId }));
          return;
        }
        if (method === "POST" && action === "toggle") {
          const body = (await readBody(req)) as { enabled?: unknown };
          if (typeof body.enabled !== "boolean") {
            fail(res, 400, "enabled 必须是布尔值");
            return;
          }
          try {
            json(res, 200, { server: await mcp.setEnabled(serverId, body.enabled) });
          } catch (err) {
            fail(res, 404, err instanceof Error ? err.message : "MCP server 不存在");
          }
          return;
        }
        fail(res, 405, "method not allowed");
        return;
      }
    }

    {
      const approvalMatch = /^\/api\/tool-calls\/([^/]+)\/(approve|reject)$/.exec(pathname);
      if (approvalMatch && method === "POST") {
        if (!approvals) {
          fail(res, 503, "approval queue not enabled");
          return;
        }
        const callId = decodeURIComponent(approvalMatch[1] ?? "");
        const decision = approvalMatch[2] === "approve" ? "approved" : "rejected";
        if (!approvals.resolve(callId, decision)) {
          fail(res, 404, "没有等待中的审批（可能已经处理过）");
          return;
        }
        json(res, 200, { ok: true, decision });
        return;
      }
    }

    if (pathname === "/api/approvals" && method === "GET") {
      if (!approvals) {
        fail(res, 503, "approval queue not enabled");
        return;
      }
      const queue = approvals as ApprovalGate & { list?: () => unknown[] };
      json(res, 200, { pending: queue.list?.() ?? [] });
      return;
    }

    if (pathname === "/api/workspace/tree" && method === "GET") {
      if (!sandbox) {
        fail(res, 503, "sandbox not enabled");
        return;
      }
      json(res, 200, { root: sandbox.root, files: sandbox.listFiles() });
      return;
    }

    if (pathname === "/api/workspace/file" && method === "GET") {
      if (!sandbox) {
        fail(res, 503, "sandbox not enabled");
        return;
      }
      const path = url.searchParams.get("path") ?? "";
      try {
        json(res, 200, sandbox.readTextFile(path));
      } catch (err) {
        fail(res, 400, err instanceof Error ? err.message : "cannot read file");
      }
      return;
    }

    if (pathname === "/api/workspace/reset" && method === "POST") {
      if (!sandbox) {
        fail(res, 503, "sandbox not enabled");
        return;
      }
      sandbox.reset();
      json(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/cats" && method === "GET") {
      json(res, 200, { cats: studio.state.cats });
      return;
    }

    {
      const catMatch = /^\/api\/cats\/([^/]+)$/.exec(pathname);
      if (catMatch && method === "PUT") {
        const catId = decodeURIComponent(catMatch[1] ?? "");
        const body = await readBody(req);
        let patch: CatPatch;
        try {
          patch = parseCatPatch(body);
        } catch (err) {
          fail(res, 400, err instanceof Error ? err.message : "invalid cat patch");
          return;
        }
        try {
          json(res, 200, studio.updateCat(catId, patch));
        } catch (err) {
          const message = err instanceof Error ? err.message : "invalid cat patch";
          fail(res, message.includes("not found") ? 404 : 400, message);
        }
        return;
      }
    }

    if (pathname === "/api/scenarios") {
      if (method === "GET") {
        json(res, 200, { scenarios: listScenarios() });
        return;
      }
      if (method === "POST") {
        const body = await readBody(req);
        const raw =
          body && typeof body === "object" && !Array.isArray(body) && "scenario" in body
            ? (body as { scenario: unknown }).scenario
            : body;
        const result = addScenario(raw);
        if (result.ok) {
          json(res, 201, { scenario: result.scenario, source: "custom" });
          return;
        }
        const conflict = result.errors.some((message) => message.includes("已存在"));
        json(res, conflict ? 409 : 400, {
          error: result.errors[0] ?? "invalid scenario",
          errors: result.errors,
        });
        return;
      }
      fail(res, 405, "method not allowed");
      return;
    }

    {
      const scenarioMatch = /^\/api\/scenarios\/([^/]+)$/.exec(pathname);
      if (scenarioMatch && method === "DELETE") {
        const scenarioId = decodeURIComponent(scenarioMatch[1] ?? "");
        const outcome = removeScenario(scenarioId);
        if (outcome === "builtin") {
          fail(res, 400, "内置剧本不能删除");
          return;
        }
        if (outcome === "not_found") {
          fail(res, 404, "剧本不存在");
          return;
        }
        json(res, 200, { ok: true });
        return;
      }
    }

    const msgMatch = /^\/api\/rooms\/([^/]+)\/messages$/.exec(pathname);
    if (method === "POST" && msgMatch) {
      const roomId = decodeURIComponent(msgMatch[1] ?? "");
      const body = (await readBody(req)) as { text?: unknown };
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (text.length < 1 || text.length > MAX_TEXT) {
        fail(res, 400, `text must be 1..${MAX_TEXT} chars`);
        return;
      }
      const mentions = parseMentions(text, studio, roomId);
      const message = studio.appendMessage({
        roomId,
        author: "user",
        kind: "chat",
        text,
        mentions,
      });
      driver.submit({ type: "user_message", roomId, text, mentions });
      json(res, 201, message);
      return;
    }

    if (method === "POST" && pathname === "/api/tasks") {
      const body = (await readBody(req)) as {
        roomId?: unknown;
        brief?: unknown;
        scenarioId?: unknown;
      };
      const roomId = typeof body.roomId === "string" ? body.roomId : "room_cafe";
      const brief = typeof body.brief === "string" ? body.brief.trim() : "";
      if (brief.length < 4 || brief.length > MAX_TEXT) {
        fail(res, 400, `brief must be 4..${MAX_TEXT} chars`);
        return;
      }
      const scenarioId =
        typeof body.scenarioId === "string" && scenarios.some((s) => s.id === body.scenarioId)
          ? body.scenarioId
          : pickScenario(scenarios, brief);
      const task = studio.createTask({ roomId, brief, scenarioId });
      // 读写 git 工作区：任务开始前建分支（工作树不干净时只记录提示，不阻塞任务）。
      const room = studio.getRoom(roomId);
      if (room && workspaces) {
        const workspace = workspaces.get(room.workspaceId ?? "");
        if (
          workspace &&
          workspace.isGit &&
          workspace.policy === "read-write" &&
          workspace.branchPerTask
        ) {
          const branch = await workspaces.createTaskBranch(workspace.id, task.id);
          studio.updateTaskGit(task.id, {
            ...(branch.branch ? { branch: branch.branch } : {}),
            ...(branch.baseBranch ? { baseBranch: branch.baseBranch } : {}),
            ...(branch.baseCommit ? { baseCommit: branch.baseCommit } : {}),
            ...(branch.error ? { error: branch.error } : {}),
          });
        }
      }
      studio.appendMessage({
        roomId,
        author: "user",
        kind: "chat",
        text: brief,
        taskId: task.id,
      });
      driver.submit({ type: "task_created", roomId, taskId: task.id });
      json(res, 201, task);
      return;
    }

    {
      const taskGitMatch = /^\/api\/tasks\/([^/]+)\/(diff|commit|rollback)$/.exec(pathname);
      if (taskGitMatch) {
        if (!workspaces) {
          fail(res, 503, "workspace manager not enabled");
          return;
        }
        const taskId = decodeURIComponent(taskGitMatch[1] ?? "");
        const action = taskGitMatch[2];
        const task = studio.getTask(taskId);
        if (!task) {
          fail(res, 404, "任务不存在");
          return;
        }
        const room = studio.getRoom(task.roomId);
        const workspace = room ? workspaces.get(room.workspaceId ?? "") : undefined;
        if (!workspace) {
          fail(res, 400, "任务所在房间没有工作区");
          return;
        }

        if (action === "diff" && method === "GET") {
          json(res, 200, await workspaces.taskDiff(workspace.id, task.git));
          return;
        }

        if (action === "commit" && method === "POST") {
          const body = (await readBody(req)) as { message?: unknown; confirm?: unknown };
          if (body.confirm !== true) {
            fail(res, 400, "提交需要显式确认（confirm: true）");
            return;
          }
          const message = typeof body.message === "string" ? body.message : "";
          const result = await workspaces.commitTask(workspace.id, task.git, message);
          if (!result.ok) {
            fail(res, 400, result.error ?? "commit failed");
            return;
          }
          const updated = studio.updateTaskGit(task.id, {
            ...task.git,
            ...(result.commit ? { commit: result.commit } : {}),
            committedAt: Date.now(),
          });
          json(res, 200, { ok: true, commit: result.commit, task: updated });
          return;
        }

        if (action === "rollback" && method === "POST") {
          const body = (await readBody(req)) as { confirm?: unknown };
          if (body.confirm !== true) {
            fail(res, 400, "回滚需要显式确认（confirm: true）");
            return;
          }
          const result = await workspaces.rollbackTask(workspace.id, task.git, task.id);
          if (!result.ok) {
            fail(res, 400, result.error ?? "rollback failed");
            return;
          }
          const updated = studio.updateTaskGit(task.id, {
            ...(task.git?.baseBranch ? { baseBranch: task.git.baseBranch } : {}),
            ...(task.git?.baseCommit ? { baseCommit: task.git.baseCommit } : {}),
            stashedAt: Date.now(),
          });
          json(res, 200, { ok: true, note: result.note, stash: result.stash, task: updated });
          return;
        }

        fail(res, 405, "method not allowed");
        return;
      }
    }

    const nudgeMatch = /^\/api\/tasks\/([^/]+)\/nudge$/.exec(pathname);
    if (method === "POST" && nudgeMatch) {
      const taskId = decodeURIComponent(nudgeMatch[1] ?? "") as TaskId;
      const task = studio.getTask(taskId);
      if (!task) {
        fail(res, 404, "task not found");
        return;
      }
      driver.submit({ type: "nudge", taskId });
      json(res, 202, { ok: true });
      return;
    }

    if (method === "GET") {
      serveStatic(res, publicDir, pathname);
      return;
    }

    fail(res, 404, "not found");
  }

  function streamTestEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");

    const send = (event: unknown): void => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = tests?.subscribe(send) ?? (() => undefined);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
    heartbeat.unref?.();
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }

  function streamEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");

    const send = (state: StudioState): void => {
      res.write(`data: ${JSON.stringify({ seq: state.seq, state })}\n\n`);
    };
    send(studio.snapshot());

    const unsubscribe = studio.subscribe(send);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
    heartbeat.unref?.();

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }
}
