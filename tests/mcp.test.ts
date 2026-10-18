/** B 阶段：工具注册表、MCP client/manager、/api/mcp 等接口。 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
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
      assert.equal(tools.length, 1);
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
    assert.equal(status.toolCount, 1);
    assert.ok(registry.get(`${status.id}__echo`));
    assert.equal(manager.toolCount(), 1);

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
    const driver = { submit() {}, async whenIdle() {}, stallMs: 12000 };
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
    assert.equal(addedBody.server.toolCount, 1);
    const id = addedBody.server.id;

    const testConn = await fetch(`${base}/api/mcp/${id}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(testConn.status, 200);
    const testBody = (await testConn.json()) as { ok: boolean; tools: unknown[] };
    assert.equal(testBody.ok, true);
    assert.equal(testBody.tools.length, 1);

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
