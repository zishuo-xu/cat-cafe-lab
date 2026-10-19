/** B 阶段：工具注册表、MCP client/manager、/api/mcp 等接口。 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import type { McpServerConfig, ToolDefinition } from "../src/domain/types.ts";
import { McpClient } from "../src/mcp/client.ts";
import { McpManager, filterToolsForCat } from "../src/mcp/manager.ts";
import { createHttpServer } from "../src/server/http.ts";
import { Studio } from "../src/server/studio.ts";
import { Sandbox } from "../src/tools/sandbox.ts";
import { ToolRegistryImpl } from "../src/tools/registry.ts";
import { BUILTIN_TOOLS } from "../src/tools/builtin.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-mcp-stdio.mjs", import.meta.url));

function stdioConfig(id = "fake"): McpServerConfig {
  return {
    id,
    name: "Fake MCP",
    transport: "stdio",
    command: process.execPath,
    args: [FIXTURE],
    enabled: true,
    risk: "needs_approval",
  };
}

interface RecordedHttpRequest {
  headers: IncomingHttpHeaders;
  body: { id?: number; method?: string; params?: unknown };
}

/** 测试用 http MCP server：记录每次请求的 header，initialize 时下发 session id。 */
async function startRecordingMcpHttpServer(): Promise<{
  url: string;
  requests: RecordedHttpRequest[];
  close: () => Promise<void>;
}> {
  const requests: RecordedHttpRequest[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const message = JSON.parse(raw) as {
        id?: number;
        method?: string;
        params?: unknown;
      };
      requests.push({ headers: req.headers, body: message });
      const reply = (result: unknown): void => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      };
      if (message.method === "initialize") {
        // 下发 session id：客户端之后的请求必须带它，用户 header 不能覆盖。
        res.setHeader("mcp-session-id", "session-abc");
        reply({
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "headers-fake" },
        });
        return;
      }
      if (message.method === "tools/list") {
        reply({
          tools: [
            {
              name: "ping",
              description: "ping",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        });
        return;
      }
      if (message.method === "tools/call") {
        reply({ content: [{ type: "text", text: "pong" }] });
        return;
      }
      res.writeHead(202);
      res.end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    close: async () => {
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

function tempSandbox(): { dir: string; sandbox: Sandbox } {
  const dir = mkdtempSync(join(tmpdir(), "catcafe-registry-"));
  const sandbox = new Sandbox(join(dir, "workspace"));
  sandbox.ensureSeed();
  return { dir, sandbox };
}

describe("ToolRegistry", () => {
  let dir: string;
  let sandbox: Sandbox;
  let registry: ToolRegistryImpl;

  before(() => {
    const created = tempSandbox();
    dir = created.dir;
    sandbox = created.sandbox;
    registry = new ToolRegistryImpl(sandbox);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("内置工具目录与执行", async () => {
    assert.equal(registry.list().length, BUILTIN_TOOLS.length);
    const run = registry.get("run_command");
    assert.equal(run?.risk, "needs_approval");
    assert.equal(run?.source, "sandbox");

    const listed = await registry.execute("list_files", {});
    assert.equal(listed.status, "ok");
    assert.match(listed.output, /package\.json/);

    const missing = await registry.execute("nope", {});
    assert.equal(missing.status, "error");
  });

  test("provider 注册 / 移除 / 执行", async () => {
    const def: ToolDefinition = {
      name: "fake__echo",
      title: "Echo",
      description: "回显",
      inputSchema: { type: "object" },
      risk: "needs_approval",
      source: "mcp",
      serverId: "fake",
    };
    registry.registerProvider("fake", {
      defs: [def],
      execute: async (name, input) => ({
        status: "ok",
        output: `${name}:${String(input["text"] ?? "")}`,
      }),
    });
    assert.ok(registry.list().some((tool) => tool.name === "fake__echo"));
    const result = await registry.execute("fake__echo", { text: "hi" });
    assert.equal(result.output, "fake__echo:hi");

    registry.removeProvider("fake");
    assert.ok(!registry.list().some((tool) => tool.name === "fake__echo"));
  });

  test("按猫过滤工具权限", () => {
    const tools = registry.list();
    assert.equal(filterToolsForCat(tools, undefined).length, tools.length);
    assert.equal(filterToolsForCat(tools, []).length, 0);
    assert.deepEqual(
      filterToolsForCat(tools, ["read_file"]).map((tool) => tool.name),
      ["read_file"],
    );
  });
});

describe("McpClient (stdio)", () => {
  test("connect → tools/list → tools/call → close", async () => {
    const client = new McpClient(stdioConfig());
    try {
      const tools = await client.connect();
      assert.equal(tools.length, 2);
      const tool = tools[0]!;
      assert.equal(tool.name, "fake__echo");
      assert.equal(tool.source, "mcp");
      assert.equal(tool.risk, "needs_approval");

      const result = await client.callTool("fake__echo", { text: "hi" });
      assert.equal(result.status, "ok");
      assert.equal(result.output, "echo:hi");
    } finally {
      await client.close();
    }
    assert.equal(client.status, "disconnected");
  });
});

describe("McpManager", () => {
  let dir: string;
  let sandbox: Sandbox;
  let registry: ToolRegistryImpl;
  let manager: McpManager;

  before(async () => {
    const created = tempSandbox();
    dir = created.dir;
    sandbox = created.sandbox;
    registry = new ToolRegistryImpl(sandbox);
    manager = new McpManager(registry, dir);
    await manager.init();
  });

  after(async () => {
    await manager.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("添加 stdio server 后工具进注册表并落盘", async () => {
    const status = await manager.add({
      name: "Fake MCP",
      transport: "stdio",
      command: process.execPath,
      args: [FIXTURE],
    });
    assert.equal(status.status, "connected");
    assert.equal(status.toolCount, 2);
    assert.ok(registry.get(`${status.id}__echo`));
    assert.equal(manager.toolCount(), 2);

    const persisted = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")) as McpServerConfig[];
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.id, status.id);
    assert.equal(persisted[0]?.args?.[0], FIXTURE);
  });

  test("test() 用临时连接，不注册工具", async () => {
    const result = await manager.test({
      name: "Another",
      transport: "stdio",
      command: process.execPath,
      args: [FIXTURE],
    });
    assert.equal(result.ok, true);
    assert.equal(result.tools[0]?.name, "another__echo");
    assert.ok(!registry.get("another__echo"));
  });

  test("启停会注册/注销工具，删除后配置消失", async () => {
    const id = manager.list().find((server) => server.name === "Fake MCP")?.id;
    assert.ok(id);
    const toolName = `${id}__echo`;

    const disabled = await manager.setEnabled(id, false);
    assert.equal(disabled.enabled, false);
    assert.equal(registry.get(toolName), undefined);
    assert.equal(registry.list().filter((tool) => tool.source === "mcp").length, 0);

    const enabled = await manager.setEnabled(id, true);
    assert.equal(enabled.enabled, true);
    assert.ok(registry.get(toolName));

    assert.equal(await manager.remove(id), true);
    assert.equal(await manager.remove(id), false);
    assert.ok(!registry.get(toolName));
  });

  test("重启后加载配置并自动连接", async () => {
    await manager.add({
      name: "Persist",
      transport: "stdio",
      command: process.execPath,
      args: [FIXTURE],
    });
    await manager.close();

    const registry2 = new ToolRegistryImpl(sandbox);
    const manager2 = new McpManager(registry2, dir);
    await manager2.init();
    try {
      assert.ok(registry2.get("persist__echo"));
      assert.equal(manager2.list()[0]?.status, "connected");
    } finally {
      await manager2.close();
    }
  });
});

describe("McpClient (http)", () => {
  let server: Server;
  let url: string;

  before(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const message = JSON.parse(raw) as { id?: number; method?: string; params?: unknown };
        const reply = (result: unknown): void => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        };
        if (message.method === "initialize") {
          reply({ protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "http-fake" } });
          return;
        }
        if (message.method === "tools/list") {
          reply({
            tools: [
              {
                name: "ping",
                description: "ping",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          });
          return;
        }
        if (message.method === "tools/call") {
          reply({ content: [{ type: "text", text: "pong" }] });
          return;
        }
        res.writeHead(202);
        res.end();
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("no port");
    url = `http://127.0.0.1:${address.port}/mcp`;
  });

  after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  test("http transport connect/call", async () => {
    const client = new McpClient({
      id: "http",
      name: "HTTP fake",
      transport: "http",
      url,
      enabled: true,
    });
    try {
      const tools = await client.connect();
      assert.equal(tools[0]?.name, "http__ping");
      const result = await client.callTool("http__ping", {});
      assert.equal(result.output, "pong");
    } finally {
      await client.close();
    }
  });
});

describe("HTTP /api/mcp /api/tools /api/skills", () => {
  let dir: string;
  let studio: Studio;
  let manager: McpManager;
  let server: ReturnType<typeof createHttpServer>;
  let bare: ReturnType<typeof createHttpServer>;
  let base: string;
  let bareBase: string;

  async function listen(target: ReturnType<typeof createHttpServer>): Promise<string> {
    await new Promise<void>((done) => target.listen(0, "127.0.0.1", () => done()));
    const address = target.address();
    if (!address || typeof address !== "object") throw new Error("no port");
    return `http://127.0.0.1:${address.port}`;
  }

  before(async () => {
    const created = tempSandbox();
    dir = created.dir;
    const registry = new ToolRegistryImpl(created.sandbox);
    manager = new McpManager(registry, dir);
    await manager.init();
    studio = new Studio({ cats: CATS, mode: "mock" });
    const driver = {
      submit() {},
      setProactive() {},
      async patrol() {},
      async whenIdle() {},
      stallMs: 12000,
    };
    server = createHttpServer({
      studio,
      driver,
      publicDir: resolve(import.meta.dirname, "../public"),
      scenarios: SCENARIOS,
      tools: registry,
      mcp: manager,
      mode: "mock",
    });
    bare = createHttpServer({
      studio,
      driver,
      publicDir: resolve(import.meta.dirname, "../public"),
      scenarios: SCENARIOS,
      mode: "mock",
    });
    base = await listen(server);
    bareBase = await listen(bare);
  });

  after(async () => {
    await manager.close();
    await new Promise<void>((done) => server.close(() => done()));
    await new Promise<void>((done) => bare.close(() => done()));
    studio.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("工具与技能目录", async () => {
    const tools = await fetch(`${base}/api/tools`);
    const toolsBody = (await tools.json()) as { tools: ToolDefinition[] };
    assert.equal(toolsBody.tools.length, BUILTIN_TOOLS.length);

    const skills = await fetch(`${base}/api/skills`);
    const skillsBody = (await skills.json()) as { skills: Array<{ id: string }> };
    assert.ok(skillsBody.skills.length >= 4);
  });

  test("MCP 增删查测启停", async () => {
    const list = await fetch(`${base}/api/mcp`);
    assert.deepEqual(((await list.json()) as { servers: unknown[] }).servers, []);

    const added = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "HTTP from API",
        transport: "stdio",
        command: process.execPath,
        args: [FIXTURE],
      }),
    });
    assert.equal(added.status, 201);
    const addedBody = (await added.json()) as { server: { id: string; status: string; toolCount: number } };
    assert.equal(addedBody.server.status, "connected");
    assert.equal(addedBody.server.toolCount, 2);
    const id = addedBody.server.id;

    const testConn = await fetch(`${base}/api/mcp/${id}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(testConn.status, 200);
    const testBody = (await testConn.json()) as { ok: boolean; tools: unknown[] };
    assert.equal(testBody.ok, true);
    assert.equal(testBody.tools.length, 2);

    const toggle = await fetch(`${base}/api/mcp/${id}/toggle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(toggle.status, 200);

    const toolsAfter = await fetch(`${base}/api/tools`);
    const toolsBody = (await toolsAfter.json()) as { tools: ToolDefinition[] };
    assert.ok(!toolsBody.tools.some((tool) => tool.source === "mcp"));

    const removed = await fetch(`${base}/api/mcp/${id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    const missing = await fetch(`${base}/api/mcp/${id}`, { method: "DELETE" });
    assert.equal(missing.status, 404);
  });

  test("非法配置 400", async () => {
    const res = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "", transport: "stdio" }),
    });
    assert.equal(res.status, 400);
  });

  test("给猫设置工具/技能权限", async () => {
    const res = await fetch(`${base}/api/cats/yanyan`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tools: ["read_file"], skills: ["review-checklist"] }),
    });
    assert.equal(res.status, 200);
    const cat = (await res.json()) as { tools: string[]; skills: string[] };
    assert.deepEqual(cat.tools, ["read_file"]);
    assert.deepEqual(cat.skills, ["review-checklist"]);

    const bad = await fetch(`${base}/api/cats/yanyan`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tools: [42] }),
    });
    assert.equal(bad.status, 400);
  });

  test("没有 mcp manager 时 503", async () => {
    const res = await fetch(`${bareBase}/api/mcp`);
    assert.equal(res.status, 503);
    const add = await fetch(`${bareBase}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", transport: "stdio", command: "node" }),
    });
    assert.equal(add.status, 503);
  });
});

// ───────────────────────── T22：MCP 鉴权（env / headers） ─────────────────────────

async function listenServer(
  target: ReturnType<typeof createHttpServer>,
): Promise<string> {
  await new Promise<void>((done) => target.listen(0, "127.0.0.1", () => done()));
  const address = target.address();
  if (!address || typeof address !== "object") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** 临时接管 console.warn，返回期间收集到的日志行。 */
async function captureWarns<T>(
  run: (lines: string[]) => Promise<T>,
): Promise<string[]> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await run(lines);
  } finally {
    console.warn = original;
  }
  return lines;
}

describe("MCP 鉴权 · stdio env", () => {
  let dir: string;
  let registry: ToolRegistryImpl;
  let manager: McpManager;
  let studio: Studio;
  let server: ReturnType<typeof createHttpServer>;
  let base: string;

  before(async () => {
    const created = tempSandbox();
    dir = created.dir;
    registry = new ToolRegistryImpl(created.sandbox);
    manager = new McpManager(registry, dir);
    await manager.init();
    studio = new Studio({ cats: CATS, mode: "mock" });
    const driver = {
      submit() {},
      setProactive() {},
      async patrol() {},
      async whenIdle() {},
      stallMs: 12000,
    };
    server = createHttpServer({
      studio,
      driver,
      publicDir: resolve(import.meta.dirname, "../public"),
      scenarios: SCENARIOS,
      tools: registry,
      mcp: manager,
      mode: "mock",
    });
    base = await listenServer(server);
  });

  after(async () => {
    await manager.close();
    await new Promise<void>((done) => server.close(() => done()));
    studio.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("env 真的传给子进程：client 调 env_echo 能读到 FAKE_TOKEN", async () => {
    const client = new McpClient({
      ...stdioConfig("envclient"),
      env: { FAKE_TOKEN: "s3cr3t-stdio-token" },
    });
    try {
      const tools = await client.connect();
      assert.ok(tools.some((tool) => tool.name === "envclient__env_echo"));
      const result = await client.callTool("envclient__env_echo", {});
      assert.equal(result.status, "ok");
      assert.equal(result.output, "env:s3cr3t-stdio-token");
    } finally {
      await client.close();
    }
  });

  test("POST /api/mcp 带 env：连接成功，GET / test 只回键名、不泄露值", async () => {
    const token = "s3cr3t-stdio-token";
    const added = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Env MCP",
        transport: "stdio",
        command: process.execPath,
        args: [FIXTURE],
        env: { FAKE_TOKEN: token },
      }),
    });
    assert.equal(added.status, 201);
    const addedText = await added.text();
    assert.ok(!addedText.includes(token), "POST 响应不能出现 env 值");
    const addedBody = JSON.parse(addedText) as {
      server: {
        id: string;
        status: string;
        toolCount: number;
        envKeys: string[];
        headerKeys: string[];
      };
    };
    assert.equal(addedBody.server.status, "connected");
    assert.equal(addedBody.server.toolCount, 2);
    assert.deepEqual(addedBody.server.envKeys, ["FAKE_TOKEN"]);
    assert.deepEqual(addedBody.server.headerKeys, []);
    const id = addedBody.server.id;

    // tool 真的能读到 env（说明不是只落盘没生效）。
    const echo = await registry.execute(`${id}__env_echo`, {});
    assert.equal(echo.output, `env:${token}`);

    const listRes = await fetch(`${base}/api/mcp`);
    const listText = await listRes.text();
    assert.ok(!listText.includes(token), "GET /api/mcp 绝不能出现 env 值");
    const listBody = JSON.parse(listText) as {
      servers: Array<{ id: string; envKeys: string[]; headerKeys: string[] }>;
    };
    const entry = listBody.servers.find((item) => item.id === id);
    assert.ok(entry);
    assert.deepEqual(entry.envKeys, ["FAKE_TOKEN"]);
    assert.deepEqual(entry.headerKeys, []);

    // 值需要落盘（重启后还能连），文件 0600，但任何 API 响应都不含它。
    const file = join(dir, "mcp.json");
    assert.ok(readFileSync(file, "utf8").includes(token), "配置需要持久化 env");
    assert.equal(statSync(file).mode & 0o777, 0o600, "mcp.json 应为 0600");

    const testRes = await fetch(`${base}/api/mcp/${id}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(testRes.status, 200);
    const testText = await testRes.text();
    assert.ok(!testText.includes(token), "test() 响应不能回显 env 值");
    assert.equal((JSON.parse(testText) as { ok: boolean }).ok, true);

    await fetch(`${base}/api/mcp/${id}`, { method: "DELETE" });
  });

  test("PUT /api/mcp/:id：更新 env 生效，传 {} 清空生效，enabled/risk 可改", async () => {
    const added = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Env Update",
        transport: "stdio",
        command: process.execPath,
        args: [FIXTURE],
        env: { FAKE_TOKEN: "old-token" },
      }),
    });
    assert.equal(added.status, 201);
    const { server: created } = (await added.json()) as {
      server: { id: string };
    };
    const id = created.id;
    const echo = async (): Promise<string> =>
      (await registry.execute(`${id}__env_echo`, {})).output;

    assert.equal(await echo(), "env:old-token");

    const updated = await fetch(`${base}/api/mcp/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: { FAKE_TOKEN: "new-token" } }),
    });
    assert.equal(updated.status, 200);
    const updatedText = await updated.text();
    assert.ok(!updatedText.includes("new-token"), "PUT 响应不能回显 env 值");
    const updatedBody = JSON.parse(updatedText) as {
      server: { envKeys: string[]; risk: string; enabled: boolean };
    };
    assert.deepEqual(updatedBody.server.envKeys, ["FAKE_TOKEN"]);
    assert.equal(await echo(), "env:new-token", "PUT 后应断线重连并用新 env");

    const cleared = await fetch(`${base}/api/mcp/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: {} }),
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual(
      ((await cleared.json()) as { server: { envKeys: string[] } }).server.envKeys,
      [],
    );
    assert.equal(await echo(), "env:(missing)", "传 {} 应清空 env 并重连");

    const risk = await fetch(`${base}/api/mcp/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ risk: "safe" }),
    });
    assert.equal(risk.status, 200);
    assert.equal(
      ((await risk.json()) as { server: { risk: string } }).server.risk,
      "safe",
    );

    const disabled = await fetch(`${base}/api/mcp/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disabled.status, 200);
    const disabledBody = (await disabled.json()) as {
      server: { enabled: boolean; status: string };
    };
    assert.equal(disabledBody.server.enabled, false);
    assert.equal(disabledBody.server.status, "disconnected");
    assert.equal(registry.get(`${id}__env_echo`), undefined);

    const enabled = await fetch(`${base}/api/mcp/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const enabledBody = (await enabled.json()) as {
      server: { enabled: boolean; status: string };
    };
    assert.equal(enabledBody.server.enabled, true);
    assert.equal(enabledBody.server.status, "connected");
    assert.ok(registry.get(`${id}__env_echo`));

    await fetch(`${base}/api/mcp/${id}`, { method: "DELETE" });
  });

  test("stderr 里的 env 值会脱敏，不落日志", async () => {
    const token = "s3cr3t-stderr-token";
    const lines = await captureWarns(async (captured) => {
      const client = new McpClient({
        ...stdioConfig("stderrtest"),
        env: { FAKE_TOKEN: token, FAKE_STDERR_TOKEN: "1" },
      });
      try {
        await client.connect();
        const deadline = Date.now() + 1500;
        while (
          Date.now() < deadline &&
          !captured.some((line) => line.includes("[mcp:"))
        ) {
          await sleep(20);
        }
      } finally {
        await client.close();
      }
    });

    const mcpLogs = lines.filter((line) => line.includes("[mcp:"));
    assert.ok(mcpLogs.length >= 1, `应有 stderr 日志，实际：${lines.join(" | ")}`);
    for (const line of mcpLogs) {
      assert.ok(!line.includes(token), `日志里绝不能出现 env 值：${line}`);
    }
    assert.ok(
      mcpLogs.some((line) => line.includes("stderr token=***")),
      `stderr 内容应被脱敏：${mcpLogs.join(" | ")}`,
    );
  });

  test("JSON-RPC 错误信息里的 env 值也会脱敏", async () => {
    const token = "s3cr3t-error-token";
    const client = new McpClient({
      ...stdioConfig("errortest"),
      env: { FAKE_TOKEN: token, FAKE_EXTRA_TOOLS: "1" },
    });
    try {
      const tools = await client.connect();
      assert.ok(tools.some((tool) => tool.name === "errortest__token_error"));
      const result = await client.callTool("errortest__token_error", {});
      assert.equal(result.status, "error");
      assert.ok(!result.output.includes(token), `错误输出不能有 env 值：${result.output}`);
      assert.ok(result.output.includes("***"), `错误输出应被脱敏：${result.output}`);
    } finally {
      await client.close();
    }
  });

  test("env / headers 校验失败 400，错误信息不回显值", async () => {
    const tooLong = "x".repeat(501);
    const tooMany = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [`KEY_${index}`, "v"]),
    );
    const badPayloads: Array<Record<string, unknown>> = [
      { env: { "bad key": "v" } },
      { env: { FAKE_TOKEN: tooLong } },
      { env: tooMany },
      { env: "not-an-object" },
      { env: { FAKE_TOKEN: 42 } },
      { headers: { "bad:key": "v" } },
    ];
    for (const payload of badPayloads) {
      const res = await fetch(`${base}/api/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Bad MCP",
          transport: "stdio",
          command: process.execPath,
          args: [FIXTURE],
          ...payload,
        }),
      });
      assert.equal(res.status, 400, `应拒绝：${JSON.stringify(Object.keys(payload))}`);
      const text = await res.text();
      assert.ok(!text.includes(tooLong), "错误信息不能回显超长 env 值");
      assert.ok(!text.includes("not-an-object"), "错误信息不能回显 env 值");
    }

    const missing = await fetch(`${base}/api/mcp/no-such-server`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: {} }),
    });
    assert.equal(missing.status, 404);
  });
});

describe("MCP 鉴权 · http headers", () => {
  let dir: string;
  let fake: Awaited<ReturnType<typeof startRecordingMcpHttpServer>>;
  let registry: ToolRegistryImpl;
  let manager: McpManager;
  let studio: Studio;
  let server: ReturnType<typeof createHttpServer>;
  let base: string;

  before(async () => {
    fake = await startRecordingMcpHttpServer();
    const created = tempSandbox();
    dir = created.dir;
    registry = new ToolRegistryImpl(created.sandbox);
    manager = new McpManager(registry, dir);
    await manager.init();
    studio = new Studio({ cats: CATS, mode: "mock" });
    const driver = {
      submit() {},
      setProactive() {},
      async patrol() {},
      async whenIdle() {},
      stallMs: 12000,
    };
    server = createHttpServer({
      studio,
      driver,
      publicDir: resolve(import.meta.dirname, "../public"),
      scenarios: SCENARIOS,
      tools: registry,
      mcp: manager,
      mode: "mock",
    });
    base = await listenServer(server);
  });

  after(async () => {
    await manager.close();
    await new Promise<void>((done) => server.close(() => done()));
    studio.close();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("headers 真的随每个请求发出：content-type / session 不可覆盖，accept 可覆盖", async () => {
    const client = new McpClient({
      id: "httpheaders",
      name: "HTTP Headers",
      transport: "http",
      url: fake.url,
      enabled: true,
      headers: {
        Authorization: "Bearer s3cr3t-http-token",
        "content-type": "text/plain",
        accept: "application/json",
        "mcp-session-id": "user-session",
      },
    });
    try {
      await client.connect();
      const result = await client.callTool("httpheaders__ping", {});
      assert.equal(result.output, "pong");
    } finally {
      await client.close();
    }

    assert.ok(fake.requests.length >= 3, "initialize / notifications / tools-list 都应请求");
    const first = fake.requests[0];
    assert.ok(first);
    assert.equal(first.headers.authorization, "Bearer s3cr3t-http-token");
    assert.match(String(first.headers["content-type"]), /^application\/json/);
    assert.equal(first.headers.accept, "application/json");
    // initialize 之前没有 session；用户伪造的 mcp-session-id 必须被忽略。
    assert.notEqual(first.headers["mcp-session-id"], "user-session");

    // 服务端下发 session-abc 之后，后续请求必须带它，而不是用户伪造值。
    const listed = fake.requests.find((request) => request.body.method === "tools/list");
    assert.ok(listed);
    assert.equal(listed.headers["mcp-session-id"], "session-abc");
    for (const request of fake.requests) {
      assert.match(String(request.headers["content-type"]), /^application\/json/);
    }
  });

  test("POST /api/mcp（http headers）→ GET 只回 headerKeys；PUT 轮换 / 清空 headers 生效", async () => {
    const secret = "s3cr3t-http-token";
    const added = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "HTTP API",
        transport: "http",
        url: fake.url,
        headers: { Authorization: `Bearer ${secret}` },
      }),
    });
    assert.equal(added.status, 201);
    const addedText = await added.text();
    assert.ok(!addedText.includes(secret), "POST 响应不能出现 header 值");
    const { server: created } = JSON.parse(addedText) as {
      server: {
        id: string;
        status: string;
        toolCount: number;
        envKeys: string[];
        headerKeys: string[];
      };
    };
    assert.equal(created.status, "connected");
    assert.equal(created.toolCount, 1);
    assert.deepEqual(created.headerKeys, ["Authorization"]);
    assert.deepEqual(created.envKeys, []);
    const id = created.id;

    const listText = await (await fetch(`${base}/api/mcp`)).text();
    assert.ok(!listText.includes(secret), "GET /api/mcp 绝不能出现 header 值");

    const ping = async (): Promise<string> =>
      (await registry.execute(`${id}__ping`, {})).output;
    assert.equal(await ping(), "pong");
    assert.equal(fake.requests.at(-1)?.headers.authorization, `Bearer ${secret}`);

    // 轮换 header：重连后新值生效，响应不回显。
    const rotated = await fetch(`${base}/api/mcp/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ headers: { Authorization: "Bearer rotated-token" } }),
    });
    assert.equal(rotated.status, 200);
    const rotatedText = await rotated.text();
    assert.ok(!rotatedText.includes("rotated-token"), "PUT 响应不能回显 header 值");
    assert.deepEqual(
      (JSON.parse(rotatedText) as { server: { headerKeys: string[] } }).server.headerKeys,
      ["Authorization"],
    );
    assert.equal(await ping(), "pong");
    assert.equal(fake.requests.at(-1)?.headers.authorization, "Bearer rotated-token");

    // test 接口在带鉴权时也不回显。
    const testRes = await fetch(`${base}/api/mcp/${id}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(testRes.status, 200);
    const testText = await testRes.text();
    assert.ok(!testText.includes("rotated-token"), "test() 响应不能回显 header 值");
    assert.equal((JSON.parse(testText) as { ok: boolean }).ok, true);

    // 清空 headers：之后请求不再带 Authorization。
    const cleared = await fetch(`${base}/api/mcp/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ headers: {} }),
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual(
      ((await cleared.json()) as { server: { headerKeys: string[] } }).server.headerKeys,
      [],
    );
    assert.equal(await ping(), "pong");
    assert.equal(fake.requests.at(-1)?.headers.authorization, undefined);

    await fetch(`${base}/api/mcp/${id}`, { method: "DELETE" });
  });

  test("PUT 非法 risk 400", async () => {
    const added = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "HTTP Risk",
        transport: "http",
        url: fake.url,
      }),
    });
    assert.equal(added.status, 201);
    const { server: created } = (await added.json()) as { server: { id: string } };
    const res = await fetch(`${base}/api/mcp/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ risk: "whatever" }),
    });
    assert.equal(res.status, 400);
    await fetch(`${base}/api/mcp/${created.id}`, { method: "DELETE" });
  });
});
