/** 设置面板后端：SettingsStore 与 /api/settings 契约。 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import { createMockBrain } from "../src/agents/mock-brain.ts";
import type { Driver, LlmSettings, StudioSettings } from "../src/domain/types.ts";
import { createHttpServer } from "../src/server/http.ts";
import { SettingsStore, SwitchableBrain } from "../src/server/settings-store.ts";
import { Studio } from "../src/server/studio.ts";
import { fakeDriver } from "./helpers/fake-driver.ts";

function baseSettings(overrides: Partial<StudioSettings> = {}): StudioSettings {
  return {
    port: 4318,
    dataDir: "",
    mode: "mock",
    llm: null,
    stallMs: 12000,
    ...overrides,
  };
}

function makeStore(dir: string, overrides: Partial<StudioSettings> = {}) {
  const studio = new Studio({ cats: CATS, mode: "mock" });
  const mock = createMockBrain(SCENARIOS);
  const switchable = new SwitchableBrain(mock);
  const store = new SettingsStore({
    studio,
    mock,
    switchable,
    settings: baseSettings({ dataDir: dir, ...overrides }),
    dataDirAbs: dir,
    port: 4318,
  });
  return { studio, mock, switchable, store };
}


async function listen(server: Server): Promise<number> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("no port");
  return address.port;
}

describe("SettingsStore", () => {
  let dir: string;
  let ctx: ReturnType<typeof makeStore>;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "deliverylab-settings-"));
    ctx = makeStore(dir);
  });

  after(() => {
    ctx.studio.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("初始只有真实模式、未配置、正常节奏、没有 key", () => {
    const pub = ctx.store.getPublic();
    assert.equal(pub.mode, "llm", "mode 恒为 llm：产品只有真实模式");
    assert.equal(pub.configured, false, "没填 Base URL / 模型时应为未配置");
    assert.equal(ctx.store.isConfigured(), false);
    assert.equal(pub.speed, "normal");
    assert.equal(pub.llm.hasKey, false);
    assert.equal(pub.llm.keySource, null);
    assert.equal(pub.envDefaults, false);
    assert.equal(pub.stallMs, 12000);
    assert.ok(pub.version.length > 0);
  });

  test("切换节奏会改变延迟系数", async () => {
    assert.equal(ctx.store.factor(), 1);
    await ctx.store.update({ speed: "fast" });
    assert.equal(ctx.store.factor(), 0.5);
    await ctx.store.update({ speed: "slow" });
    assert.equal(ctx.store.factor(), 1.7);
    await ctx.store.update({ speed: "normal" });
  });

  test("mode 已废弃：传 mock 被忽略不报错，mode 恒为 llm", async () => {
    const pub = await ctx.store.update({ mode: "mock" });
    assert.equal(pub.mode, "llm", "切模式已废弃，写入被忽略");
    assert.equal(pub.configured, false, "传 mode 不等于配置了模型");
    assert.equal(ctx.store.getPublic().mode, "llm");
    assert.equal(ctx.store.getPublic().configured, false);
  });

  test("配置 LLM 后 configured=true，key 只进内存", async () => {
    const pub = await ctx.store.update({
      mode: "llm",
      llm: {
        baseUrl: "http://127.0.0.1:9/v1/",
        model: "cat-chat",
        temperature: 1.2,
        apiKey: "sk-test-secret",
      },
    });
    assert.equal(pub.mode, "llm");
    assert.equal(pub.configured, true, "baseUrl + model 齐了就应标记已配置");
    assert.equal(ctx.store.isConfigured(), true);
    assert.equal(pub.llm.baseUrl, "http://127.0.0.1:9/v1");
    assert.equal(pub.llm.model, "cat-chat");
    assert.equal(pub.llm.temperature, 1.2);
    assert.equal(pub.llm.hasKey, true);
    assert.equal(pub.llm.keySource, "ui");
    assert.equal(ctx.switchable.mode, "llm");
    assert.equal(ctx.studio.state.mode, "llm");

    // 公开 JSON 里绝不能出现 key。
    assert.ok(!JSON.stringify(pub).includes("sk-test-secret"));

    // 落盘文件里也没有 key。
    const persisted = readFileSync(join(dir, "settings.json"), "utf8");
    assert.ok(!persisted.includes("sk-test-secret"));
    assert.ok(persisted.includes("cat-chat"));
  });

  test("清空 key 后 hasKey 变 false", async () => {
    const pub = await ctx.store.update({ llm: { clearKey: true } });
    assert.equal(pub.llm.hasKey, false);
    assert.equal(pub.llm.keySource, null);
  });

  test("温度被夹到 0..2，非法值报错", async () => {
    const high = await ctx.store.update({ llm: { temperature: 9 } });
    assert.equal(high.llm.temperature, 2);
    await assert.rejects(
      () => ctx.store.update({ llm: { temperature: Number.NaN } }),
      /温度/,
    );
    await ctx.store.update({ llm: { temperature: 0.8 } });
  });

  test("Base URL 协议校验", async () => {
    await assert.rejects(
      () => ctx.store.update({ llm: { baseUrl: "api.example.com" } }),
      /http/,
    );
  });

  test("重启后恢复非敏感配置，但 key 不再存在", async () => {
    await ctx.store.update({
      mode: "llm",
      llm: { baseUrl: "http://127.0.0.1:9/v1", model: "cat-chat", apiKey: "sk-again" },
    });
    ctx.studio.close();

    const reopened = makeStore(dir);
    const pub = reopened.store.getPublic();
    assert.equal(pub.mode, "llm");
    assert.equal(pub.configured, true, "恢复配置后应标记为已配置");
    assert.equal(reopened.store.isConfigured(), true);
    assert.equal(pub.llm.baseUrl, "http://127.0.0.1:9/v1");
    assert.equal(pub.llm.model, "cat-chat");
    assert.equal(pub.llm.hasKey, false);
    reopened.studio.close();
  });
});

describe("SettingsStore 环境变量", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "deliverylab-env-"));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("env 可提供 LLM 默认值与 key 来源", () => {
    const llm: LlmSettings = {
      baseUrl: "https://api.example.com/v1",
      model: "env-model",
      apiKey: "sk-env",
      temperature: 0.3,
    };
    const ctx = makeStore(dir, { mode: "llm", llm });
    const pub = ctx.store.getPublic();
    assert.equal(pub.mode, "llm");
    assert.equal(pub.configured, true);
    assert.equal(ctx.store.isConfigured(), true);
    assert.equal(pub.envDefaults, true);
    assert.equal(pub.llm.keySource, "env");
    assert.equal(pub.llm.hasKey, true);
    assert.equal(pub.llm.temperature, 0.3);
    ctx.studio.close();
  });
});

describe("SettingsStore.test", () => {
  let dir: string;
  let ctx: ReturnType<typeof makeStore>;
  let fake: Server;
  let fakePort: number;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "deliverylab-testconn-"));
    ctx = makeStore(dir);
    fake = createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }));
        return;
      }
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "pong" } }] }));
        return;
      }
      res.writeHead(404);
      res.end("nope");
    });
    fakePort = await listen(fake);
  });

  after(async () => {
    await new Promise<void>((done) => fake.close(() => done()));
    ctx.studio.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("连接成功：跑通一次真实对话，并报告模型数量", async () => {
    const result = await ctx.store.test({
      baseUrl: `http://127.0.0.1:${fakePort}/v1`,
      model: "cat-chat",
    });
    assert.equal(result.ok, true);
    assert.match(result.detail, /跑通一次真实对话/);
    assert.match(result.detail, /可用模型 2 个/);
    assert.ok(result.latencyMs >= 0);
  });

  test("缺字段直接返回失败原因", async () => {
    const result = await ctx.store.test({ baseUrl: "", model: "" });
    assert.equal(result.ok, false);
    assert.match(result.detail, /Base URL 和模型名/);
  });

  test("连不上的端点返回失败且不泄露 key", async () => {
    const result = await ctx.store.test({
      baseUrl: "http://127.0.0.1:1/v1",
      model: "cat-chat",
      apiKey: "sk-secret-xyz",
    });
    assert.equal(result.ok, false);
    assert.ok(!result.detail.includes("sk-secret-xyz"));
  });
});

describe("HTTP /api/settings", () => {
  let dir: string;
  let ctx: ReturnType<typeof makeStore>;
  let server: ReturnType<typeof createHttpServer>;
  let base: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "deliverylab-http-settings-"));
    ctx = makeStore(dir);
    server = createHttpServer({
      studio: ctx.studio,
      driver: fakeDriver(),
      publicDir: resolve(import.meta.dirname, "../public"),
      scenarios: SCENARIOS,
      settingsApi: ctx.store,
      mode: "mock",
    });
    const port = await listen(server);
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    ctx.studio.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("GET 返回安全设置", async () => {
    const res = await fetch(`${base}/api/settings`);
    assert.equal(res.status, 200);
    const pub = (await res.json()) as {
      mode: string;
      configured: boolean;
      llm: { hasKey: boolean };
    };
    assert.equal(pub.mode, "llm", "只有真实模式");
    assert.equal(pub.configured, false);
    assert.equal(pub.llm.hasKey, false);
  });

  test("未配置模型时 POST /api/tasks → 412 { code: llm_unconfigured }", async () => {
    const res = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "room_cafe", brief: "还没接模型就派活" }),
    });
    assert.equal(res.status, 412, "未配置模型时必须拦下派活");
    const body = (await res.json()) as { error: string; code: string };
    assert.equal(body.code, "llm_unconfigured");
    assert.match(body.error, /模型/);
    const state = (await (await fetch(`${base}/api/state`)).json()) as { tasks: unknown[] };
    assert.equal(state.tasks.length, 0, "被拦下后不应落任务");
  });

  test("PUT 更新节奏；非法值 400", async () => {
    const ok = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ speed: "fast" }),
    });
    assert.equal(ok.status, 200);
    const pub = (await ok.json()) as { speed: string };
    assert.equal(pub.speed, "fast");

    const bad = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ speed: "warp" }),
    });
    assert.equal(bad.status, 400);
  });

  test("PUT 配置 LLM 后响应不含 key，健康检查变真实模式", async () => {
    const res = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "llm",
        llm: { baseUrl: "http://127.0.0.1:9/v1", model: "m", apiKey: "sk-hidden" },
      }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes("sk-hidden"));
    const pub = JSON.parse(text) as {
      mode: string;
      configured: boolean;
      llm: { hasKey: boolean; model: string };
    };
    assert.equal(pub.mode, "llm");
    assert.equal(pub.configured, true);
    assert.equal(pub.llm.model, "m");
    assert.equal(pub.llm.hasKey, true);

    const health = await fetch(`${base}/api/health`);
    const healthBody = (await health.json()) as {
      mode: string;
      settings: boolean;
      configured: boolean;
      model?: string;
      engine?: string;
    };
    assert.equal(healthBody.mode, "llm");
    assert.equal(healthBody.settings, true);
    assert.equal(healthBody.configured, true, "健康检查应反映配置状态");
    assert.equal(healthBody.model, "m");
    assert.ok(healthBody.engine === "api" || healthBody.engine === "cli");
  });

  test("配置模型后派活不再被 412 拦截", async () => {
    const res = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "room_cafe", brief: "配好模型后可以派活" }),
    });
    assert.equal(res.status, 201);
    const task = (await res.json()) as { id: string; status: string };
    assert.ok(task.id);
    assert.equal(task.status, "active");
  });

  test("测试连接接口校验必填字段", async () => {
    const res = await fetch(`${base}/api/settings/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "", model: "" }),
    });
    assert.equal(res.status, 400);
  });

  test("未启用 settingsApi 时返回 503", async () => {
    const bare = createHttpServer({
      studio: ctx.studio,
      driver: fakeDriver(),
      publicDir: resolve(import.meta.dirname, "../public"),
      scenarios: SCENARIOS,
    });
    const port = await listen(bare);
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`);
    assert.equal(res.status, 503);
    await new Promise<void>((done) => bare.close(() => done()));
  });
});

describe("工具执行开关", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "deliverylab-tools-flag-"));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("默认开启；关闭后落盘；重启保持", async () => {
    const ctx = makeStore(dir);
    assert.equal(ctx.store.getPublic().toolsEnabled, true);
    assert.equal(ctx.store.toolsOn(), true);
    assert.equal(ctx.store.getPublic().toolApproval, "commands");
    assert.equal(ctx.store.approvalMode(), "commands");

    const pub = await ctx.store.update({ toolsEnabled: false });
    assert.equal(pub.toolsEnabled, false);
    assert.equal(ctx.store.toolsOn(), false);

    const persisted = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as {
      toolsEnabled?: boolean;
    };
    assert.equal(persisted.toolsEnabled, false);
    ctx.studio.close();

    const reopened = makeStore(dir);
    assert.equal(reopened.store.getPublic().toolsEnabled, false);
    reopened.studio.close();
  });

  test("审批策略可保存并持久化", async () => {
    const ctx = makeStore(dir);
    const pub = await ctx.store.update({ toolApproval: "all" });
    assert.equal(pub.toolApproval, "all");
    assert.equal(ctx.store.approvalMode(), "all");
    const persisted = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as {
      toolApproval?: string;
    };
    assert.equal(persisted.toolApproval, "all");
    await assert.rejects(
      () => ctx.store.update({ toolApproval: "sometimes" as unknown as "auto" }),
      /auto.*commands.*all/,
    );
    await ctx.store.update({ toolApproval: "commands" });
    ctx.studio.close();
  });

  test("非布尔值被拒绝", async () => {
    const ctx = makeStore(dir);
    await assert.rejects(
      () => ctx.store.update({ toolsEnabled: "yes" as unknown as boolean }),
      /布尔/,
    );
    ctx.studio.close();
  });
});

describe("测试连接不能假阳性（/models 通但对话端 400）", () => {
  let fake: Server;
  let fakePort: number;
  let dir: string;
  let ctx: ReturnType<typeof makeStore>;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "deliverylab-testconn-gate-"));
    ctx = makeStore(dir);
    fake = createServer((req, res) => {
      // 复刻 opencode zen 的真实行为：/models 不校验 session 头 → 200
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "a" }] }));
        return;
      }
      // 但对话端点缺 x-opencode-session → 400 MissingSessionID
      if (req.url === "/v1/chat/completions") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "MissingSessionID", message: "missing x-opencode-session" },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end("nope");
    });
    fakePort = await listen(fake);
  });

  after(async () => {
    await new Promise<void>((done) => fake.close(() => done()));
    ctx.studio.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("缺 session 头时测试连接失败，并告诉你去补请求头", async () => {
    const result = await ctx.store.test({
      baseUrl: `http://127.0.0.1:${fakePort}/v1`,
      model: "cat-chat",
      apiKey: "sk-secret-xyz",
    });
    assert.equal(result.ok, false, "不能因为 /models 通就报成功");
    assert.match(result.detail, /x-opencode-session/);
    assert.ok(!result.detail.includes("sk-secret-xyz"));
  });

  test("带上 session 头后测试连接通过", async () => {
    const fakeOk = createServer((req, res) => {
      if (req.url === "/v1/chat/completions") {
        const ok = req.headers["x-opencode-session"] === "s1";
        res.writeHead(ok ? 200 : 400, { "content-type": "application/json" });
        res.end(ok ? JSON.stringify({ choices: [{ message: { content: "pong" } }] }) : "{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const port = await listen(fakeOk);
    try {
      const result = await ctx.store.test({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "cat-chat",
        headers: { "x-opencode-session": "s1" },
      });
      assert.equal(result.ok, true);
      assert.match(result.detail, /跑通一次真实对话/);
    } finally {
      await new Promise<void>((done) => fakeOk.close(() => done()));
    }
  });
});
