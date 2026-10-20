/**
 * HTTP 层：REST + SSE + 静态前端。只做校验和转发，所有状态变更都在 Studio / Driver 里。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

import type {
  ApprovalGate,
  MemberId,
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
  setValidMemberIds,
} from "../agents/scenario-registry.ts";
import type { CatPatch, Studio } from "./studio.ts";
import type { Sandbox } from "../tools/sandbox.ts";
import type { McpManager, McpInput } from "../mcp/manager.ts";
import type { WorkspaceManager } from "../workspaces/manager.ts";
import { TestRunner } from "./test-runner.ts";
import { listSkills } from "../skills/registry.ts";
import { MODEL_PROFILES, findProfile, suggestedProfile } from "./model-profiles.ts";

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
/**
 * SSE 合并窗口（ms）。
 *
 * 一次状态变更链会连着触发很多次 notify（落一条消息、改一个状态位、清个草稿…），
 * 每条都推全量快照会把带宽和前端渲染打满：实测 14 秒 39 个事件、共 1.8MB。
 * 合并到每 120ms 最多一帧，只发最新状态；人眼感知不到这点延迟，长任务却稳很多。
 */
const SSE_COALESCE_MS = 120;

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

/** 带 HTTP 状态码的请求体错误，让上层能返回正确的码而不是统一 500。 */
class BodyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) {
      throw new BodyError(413, `请求体超过 ${Math.round(MAX_BODY / 1024)}KB 上限`);
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new BodyError(400, "请求体不是合法的 JSON");
  }
}

/** 从文本里解析 @名字 / @id。 */
export function parseMentions(text: string, studio: Studio, roomId: RoomId): MemberId[] {
  const room = studio.getRoom(roomId);
  if (!room) return [];
  const cats = studio.state.cats.filter((c) => room.catIds.includes(c.id));
  const found = new Set<MemberId>();
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

/**
 * 按需求关键词选剧本。
 *
 * 注意 `matched`：以前不管有没有命中，都退回 `scenarios[0]`，而且外面完全不知道
 * 这是「没匹配上」。结果是把「记住我」的剧本演给「优化首页加载速度」，
 * 跑完还往共享记忆里写 token 过期策略 —— 需求被一个不相干的剧本代表，
 * 新手会直接判断「它根本没懂」。
 */
function pickScenario(
  scenarios: Scenario[],
  brief: string,
): { id: string; matched: boolean } {
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
  const fallbackId = scenarios[0]?.id ?? "remember_me";
  if (!best) return { id: fallbackId, matched: false };
  return { id: best.id, matched: best.score > 0 };
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
      // 请求体错误有自己的状态码（413/400），不要一律 500。
      const status = err instanceof BodyError ? err.status : 500;
      if (!res.headersSent) fail(res, status, message);
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
          const updated = await settingsApi.update(body);
          // 主动协作设置变了 → 同步巡查启停。
          if (body.proactive !== undefined || body.proactiveIntervalMs !== undefined) {
            driver.setProactive(
              updated.proactive === "watch",
              updated.proactiveIntervalMs,
            );
          }
          json(res, 200, updated);
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
      const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
      // 必填字段没传，和「传了但查不到」是两回事：以前都报「不存在」，
      // 用户看着自己明明没传这个字段，不知道该怎么办。
      if (!workspaceId) {
        fail(
          res,
          400,
          "workspaceId 必填：先选一个工作区（内置 ws_sandbox，或先在设置里添加仓库）",
        );
        return;
      }
      if (!workspaces.get(workspaceId)) {
        fail(res, 400, `workspaceId 不存在：${workspaceId}`);
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

    {
      // 任务级 trace：把一次协作的完整链路按时间线拼出来。
      const traceMatch = /^\/api\/tasks\/([^/]+)\/trace$/.exec(pathname);
      if (traceMatch && method === "GET") {
        const taskId = decodeURIComponent(traceMatch[1] ?? "");
        const task = studio.getTask(taskId);
        if (!task) {
          fail(res, 404, "任务不存在");
          return;
        }
        const state = studio.snapshot();
        const names = new Map(state.cats.map((cat) => [cat.id, cat.name]));
        type Entry = {
          at: number;
          kind: string;
          actor?: string;
          actorName?: string;
          detail: string;
          meta?: Record<string, unknown>;
        };
        const entries: Entry[] = [];

        for (const step of task.steps) {
          entries.push({
            at: step.startedAt ?? task.createdAt,
            kind: "stage",
            actor: step.owner,
            actorName: names.get(step.owner) ?? step.owner,
            detail: `进入阶段 ${step.stage}`,
            meta: { stage: step.stage, doneAt: step.doneAt },
          });
        }
        for (const message of state.messages) {
          if (message.taskId !== taskId) continue;
          entries.push({
            at: message.at,
            kind: message.kind,
            ...(message.author !== "user" && message.author !== "system"
              ? { actor: message.author, actorName: names.get(message.author) ?? message.author }
              : { actor: message.author }),
            detail: message.text.slice(0, 200),
            ...(message.mentions.length ? { meta: { mentions: message.mentions } } : {}),
          });
        }
        for (const handoff of state.handoffs) {
          if (handoff.taskId !== taskId) continue;
          entries.push({
            at: handoff.createdAt,
            kind: "handoff",
            actor: handoff.from,
            actorName: names.get(handoff.from),
            detail: `交接给 ${names.get(handoff.to) ?? handoff.to}：${handoff.card.what.slice(0, 80)}`,
            meta: { to: handoff.to, openQuestions: handoff.card.openQuestions.length },
          });
        }
        for (const artifact of state.artifacts) {
          if (artifact.taskId !== taskId) continue;
          entries.push({
            at: artifact.createdAt,
            kind: "artifact",
            actor: artifact.author,
            actorName: names.get(artifact.author),
            detail: `${artifact.kind}「${artifact.title}」v${artifact.version}`,
            meta: {
              artifactId: artifact.id,
              version: artifact.version,
              // 产物溯源：前端据此从产物跳回产生它的那次模型调用。
              ...(artifact.trace
                ? {
                    stage: artifact.trace.stage,
                    ...(artifact.trace.llmCallId ? { llmCallId: artifact.trace.llmCallId } : {}),
                    ...(artifact.trace.trigger ? { trigger: artifact.trace.trigger } : {}),
                  }
                : {}),
            },
          });
        }
        for (const call of state.toolCalls) {
          if (call.taskId !== taskId) continue;
          entries.push({
            at: call.startedAt,
            kind: "tool",
            actor: call.catId,
            actorName: names.get(call.catId),
            detail: `${call.tool} ${call.status}${call.exitCode !== undefined ? ` (exit ${call.exitCode})` : ""}`,
            meta: { label: call.label, durationMs: (call.finishedAt ?? 0) - call.startedAt },
          });
        }
        for (const call of state.llmCalls) {
          if (call.taskId !== taskId) continue;
          entries.push({
            at: call.startedAt,
            kind: "llm",
            actor: call.catId,
            actorName: names.get(call.catId),
            detail:
              `${call.model} · ${call.durationMs ?? 0}ms` +
              (call.inputTokens !== undefined ? ` · in ${call.inputTokens}/out ${call.outputTokens ?? 0}` : "") +
              (call.degraded ? " · 降级" : "") +
              (call.retried ? " · 重试" : ""),
            meta: {
              id: call.id,
              stage: call.stage,
              trigger: call.trigger,
              engine: call.engine,
              streamed: call.streamed,
              degraded: call.degraded,
              degradeReason: call.degradeReason,
              durationMs: call.durationMs ?? 0,
              ...(call.inputTokens !== undefined
                ? { inputTokens: call.inputTokens, outputTokens: call.outputTokens ?? 0 }
                : {}),
            },
          });
        }
        for (const entry of state.memory) {
          if (entry.sourceTaskId !== taskId) continue;
          entries.push({
            at: entry.createdAt,
            kind: "memory",
            detail: `${entry.kind}「${entry.title}」`,
          });
        }

        entries.sort((a, b) => a.at - b.at);

        // 汇总：模型调用总耗时 / token / 降级次数 / 工具耗时
        const llmForTask = state.llmCalls.filter((call) => call.taskId === taskId);
        const toolForTask = state.toolCalls.filter((call) => call.taskId === taskId);
        const summary = {
          durationMs: (task.doneAt ?? Date.now()) - task.createdAt,
          llmCalls: llmForTask.length,
          llmDurationMs: llmForTask.reduce((sum, call) => sum + (call.durationMs ?? 0), 0),
          inputTokens: llmForTask.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0),
          outputTokens: llmForTask.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0),
          degradations: llmForTask.filter((call) => call.degraded).length,
          retries: llmForTask.filter((call) => call.retried).length,
          toolCalls: toolForTask.length,
          // rejected = 被拒；pending = 还在等；approved = 批过（由 tool 状态推断）
          rejected: toolForTask.filter((call) => call.status === "rejected").length,
          approvalWaitMs: toolForTask.reduce((sum, call) => {
            if (!call.approvalRequestedAt || !call.approvalDecidedAt) return sum;
            return sum + Math.max(0, call.approvalDecidedAt - call.approvalRequestedAt);
          }, 0),
          handoffs: state.handoffs.filter((handoff) => handoff.taskId === taskId).length,
          artifacts: state.artifacts.filter((artifact) => artifact.taskId === taskId).length,
        };

        json(res, 200, { task, entries, summary });
        return;
      }
    }

    if (pathname === "/api/tools" && method === "GET") {
      json(res, 200, { tools: tools?.list() ?? [] });
      return;
    }

    if (pathname === "/api/patrol" && method === "POST") {
      // 手动让团队看一眼现在有什么事（主动协作的"现在就看"按钮）。
      await driver.patrol();
      json(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/model-profiles" && method === "GET") {
      const current = settingsApi?.getPublic();
      const baseUrl = current?.llm.baseUrl ?? "";
      json(res, 200, {
        profiles: MODEL_PROFILES,
        suggested: suggestedProfile(baseUrl).id,
      });
      return;
    }

    if (pathname === "/api/model-profiles/apply" && method === "POST") {
      const body = (await readBody(req)) as { id?: unknown };
      const profile = typeof body.id === "string" ? findProfile(body.id) : undefined;
      if (!profile) {
        fail(res, 400, "未知的模型档案");
        return;
      }
      const updated: Array<{ catId: string; model?: string }> = [];
      for (const assignment of profile.assignments) {
        const cat = studio.updateCat(assignment.catId, {
          llmModel: assignment.model,
          llmTemperature: assignment.temperature,
        });
        updated.push({ catId: cat.id, model: cat.llmModel });
      }
      if (profile.assignments.length === 0) {
        // 「统一模型」：清掉所有覆盖。
        for (const cat of studio.state.cats) {
          if (!cat.llmModel) continue;
          studio.updateCat(cat.id, { llmModel: null, llmTemperature: null });
          updated.push({ catId: cat.id, model: undefined });
        }
      }
      json(res, 200, { ok: true, profile: profile.id, cats: updated });
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
        const body = (await readBody(req)) as { remember?: unknown };
        const decision = approvalMatch[2] === "approve" ? "approved" : "rejected";
        const queue = approvals as ApprovalGate & {
          remember?: (id: string, value: typeof decision) => boolean;
        };
        // remember=true：同一个成员 + 同一个工具后续不再询问。
        const handled =
          body.remember === true && queue.remember
            ? queue.remember(callId, decision)
            : approvals.resolve(callId, decision);
        if (!handled) {
          fail(res, 404, "没有等待中的审批（可能已经处理过）");
          return;
        }
        json(res, 200, { ok: true, decision, remembered: body.remember === true });
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

    if (pathname === "/api/tasks" && method === "GET") {
      // 跨房间的任务总览：左栏任务列表按房间过滤，房间一多就找不回
      // 「我记得做过一个 CSV 的任务，但忘了在哪个房间」。
      const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const tasks = studio.state.tasks
        .filter((task) => {
          if (!query) return true;
          return (
            task.title.toLowerCase().includes(query) || task.brief.toLowerCase().includes(query)
          );
        })
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt);
      json(res, 200, {
        tasks: tasks.map((task) => ({
          ...task,
          roomName: studio.getRoom(task.roomId)?.name ?? "",
        })),
      });
      return;
    }

    if (pathname === "/api/cats" && method === "GET") {
      json(res, 200, {
        cats: studio.state.cats,
        retired: studio.state.retiredCats,
      });
      return;
    }

    if (pathname === "/api/cats" && method === "POST") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        fail(res, 400, "请求体必须是对象");
        return;
      }
      const record = body as Record<string, unknown>;
      const role = record["role"];
      if (
        role !== "architect" &&
        role !== "reviewer" &&
        role !== "designer" &&
        role !== "implementer"
      ) {
        fail(res, 400, "role 只能是 architect / reviewer / designer / implementer");
        return;
      }
      try {
        const cat = studio.addCat({
          name: typeof record["name"] === "string" ? record["name"] : "",
          role,
          ...(typeof record["persona"] === "string" ? { persona: record["persona"] } : {}),
        });
        setValidMemberIds(studio.state.cats.map((item) => item.id));
        json(res, 201, cat);
      } catch (err) {
        fail(res, 400, err instanceof Error ? err.message : "invalid member");
      }
      return;
    }

    {
      const catMatch = /^\/api\/cats\/([^/]+)$/.exec(pathname);
      if (catMatch && method === "DELETE") {
        const catId = decodeURIComponent(catMatch[1] ?? "");
        if (!studio.getCat(catId)) {
          fail(res, 404, "成员不存在");
          return;
        }
        try {
          const retired = studio.removeCat(catId);
          setValidMemberIds(studio.state.cats.map((item) => item.id));
          json(res, 200, { ok: true, retired });
        } catch (err) {
          fail(res, 400, err instanceof Error ? err.message : "cannot remove member");
        }
        return;
      }
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
      const body = (await readBody(req)) as { text?: unknown; force?: unknown };
      const text = typeof body.text === "string" ? body.text.trim() : "";
      const force = body.force === true;
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
      driver.submit({ type: "user_message", roomId, text, mentions, ...(force ? { force } : {}) });
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
        fail(res, 400, `brief 长度需在 4..${MAX_TEXT} 字之间`);
        return;
      }
      // 房间必须先存在：否则 createTask 抛错会变成 500。
      if (!studio.getRoom(roomId)) {
        fail(res, 404, `房间不存在：${roomId}`);
        return;
      }
      // 同一房间一次只做一件事。
      // 只拦「正在推进」的任务（正在接单/规划/实现/评审/修订）——
      // 单纯停在 intake 的任务（驱动没跑、或测试/脚本直接建出来的）不算占用房间，
      // 否则「连续建任务做 git 分支测试」这类正常用法会被误伤。
      const busy = studio.state.tasks.find(
        (item) =>
          item.roomId === roomId &&
          item.status !== "done" &&
          item.stage !== "intake",
      );
      if (busy) {
        fail(
          res,
          409,
          `这个房间还有正在进行的任务「${busy.title}」（${busy.stage}）；` +
            `同一房间一次只做一件事，请等它结束，或新建一个房间。`,
        );
        return;
      }
      // 显式指定剧本时以用户为准；否则按关键词匹配，并记住有没有真的命中。
      const explicitScenarioId =
        typeof body.scenarioId === "string" && scenarios.some((s) => s.id === body.scenarioId)
          ? body.scenarioId
          : null;
      const picked = explicitScenarioId
        ? { id: explicitScenarioId, matched: true }
        : pickScenario(scenarios, brief);
      const task = studio.createTask({
        roomId,
        brief,
        scenarioId: picked.id,
        ...(picked.matched ? {} : { scenarioFallback: true }),
      });
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
      if (!picked.matched) {
        studio.appendMessage({
          roomId,
          author: "system",
          kind: "system",
          taskId: task.id,
          text:
            `这个需求没有匹配的演示剧本，本轮用「${picked.id}」近似演出：` +
            `过程可以参考，但台词和决策跟你的需求无关，也不会写进共享记忆。` +
            `想看到针对性的演出，可以在「＋ 新任务」里显式选一个剧本。`,
        });
      }
      driver.submit({ type: "task_created", roomId, taskId: task.id });
      json(res, 201, task);
      return;
    }

    {
      const taskGitMatch = /^\/api\/tasks\/([^/]+)\/(diff|commit|rollback|merge)$/.exec(pathname);
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
          json(res, 200, {
            ok: true,
            commit: result.commit,
            task: updated,
            // 被挡下的敏感文件：告诉负责人它们还在工作区里，但没进这次提交。
            ...(result.skipped?.length ? { skipped: result.skipped } : {}),
          });
          return;
        }

        if (action === "merge" && method === "POST") {
          const body = (await readBody(req)) as { confirm?: unknown };
          if (body.confirm !== true) {
            fail(res, 400, "合并需要显式确认（confirm: true）");
            return;
          }
          const result = await workspaces.mergeTaskBranch(workspace.id, task.git, task.id);
          if (!result.ok) {
            json(res, 400, {
              error: result.error ?? "merge failed",
              ...(result.conflicts?.length ? { conflicts: result.conflicts } : {}),
            });
            return;
          }
          const updated = studio.updateTaskGit(task.id, {
            ...task.git,
            ...(result.merged
              ? { mergeCommit: result.merged, mergedAt: Date.now() }
              : {}),
          });
          json(res, 200, {
            ok: true,
            merged: result.merged,
            note: result.note,
            task: updated,
          });
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

    {
      const actionMatch = /^\/api\/tasks\/([^/]+)\/action$/.exec(pathname);
      if (actionMatch && method === "POST") {
        const taskId = decodeURIComponent(actionMatch[1] ?? "") as TaskId;
        const task = studio.getTask(taskId);
        if (!task) {
          fail(res, 404, "任务不存在");
          return;
        }
        const body = (await readBody(req)) as { action?: unknown; note?: unknown };
        const action = body.action;
        if (action !== "continue" && action !== "pivot" && action !== "close") {
          fail(res, 400, "action 只能是 continue / pivot / close");
          return;
        }
        const note = typeof body.note === "string" ? body.note.slice(0, 500) : undefined;
        driver.submit({ type: "task_action", taskId, action, ...(note ? { note } : {}) });
        json(res, 202, { ok: true, action });
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

    const write = (state: StudioState): void => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ seq: state.seq, state })}\n\n`);
    };
    // 连上先给一帧全量快照，首屏不等合并窗口。
    write(studio.snapshot());

    // 之后的变更合并推送：只保留最新状态，每 SSE_COALESCE_MS 最多发一帧。
    let flushTimer: NodeJS.Timeout | null = null;
    let pending: StudioState | null = null;
    const schedule = (state: StudioState): void => {
      pending = state;
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        const latest = pending;
        pending = null;
        if (latest) write(latest);
      }, SSE_COALESCE_MS);
      flushTimer.unref?.();
    };

    const unsubscribe = studio.subscribe(schedule);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
    heartbeat.unref?.();

    req.on("close", () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      clearInterval(heartbeat);
      unsubscribe();
    });
  }
}
