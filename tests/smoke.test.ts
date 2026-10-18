/** Lead 的冒烟测试：Studio 状态容器 + HTTP 层契约。 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import type { Driver, EngineEvent } from "../src/domain/types.ts";
import { createHttpServer } from "../src/server/http.ts";
import { Studio } from "../src/server/studio.ts";

function fakeDriver(): Driver & { events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  return {
    events,
    submit(event) {
      events.push(event);
    },
    async whenIdle() {},
    stallMs: 12000,
  };
}

describe("Studio", () => {
  test("新房间有四只猫的招呼和一条系统消息", () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    assert.equal(studio.state.rooms.length, 1);
    assert.equal(studio.state.messages.length, 5);
    assert.equal(studio.state.messages[0]?.author, "system");
    assert.equal(studio.state.messages[0]?.kind, "system");
    const greetAuthors = new Set(
      studio.state.messages.slice(1).map((m) => m.author),
    );
    assert.deepEqual([...greetAuthors].sort(), CATS.map((c) => c.id).sort());
    studio.close();
  });

  test("appendMessage 只保留本房间猫的 mention", () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    const message = studio.appendMessage({
      roomId: "room_cafe",
      author: "user",
      kind: "chat",
      text: "@烁烁 @不存在的猫",
      mentions: ["shuoshuo", "ghost"],
    });
    assert.deepEqual(message.mentions, ["shuoshuo"]);
    studio.close();
  });

  test("createTask 生成标题、初始阶段与 owner", () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    const task = studio.createTask({
      roomId: "room_cafe",
      brief: "给登录页加一个「记住我」勾选框，7 天内免登录。",
      scenarioId: "remember_me",
    });
    assert.equal(task.stage, "intake");
    assert.equal(task.status, "active");
    assert.equal(task.owner, "xianxian");
    assert.ok(task.title.endsWith("…"));
    studio.close();
  });

  test("memoryForTask 优先返回同 tag 的记忆", () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    const task = studio.createTask({
      roomId: "room_cafe",
      brief: "登录 token 改成 30 天",
      scenarioId: "remember_me",
    });
    studio.addMemory({
      kind: "decision",
      title: "remember-me 用 7 天滚动 token",
      body: "不必每次登录。",
      tags: ["auth", "remember-me"],
      sourceTaskId: task.id,
    });
    studio.addMemory({
      kind: "lesson",
      title: "CSV 导出要校验权限",
      body: "越权导出是事故。",
      tags: ["security"],
    });
    const memory = studio.memoryForTask(task);
    assert.equal(memory[0]?.title, "remember-me 用 7 天滚动 token");
    studio.close();
  });

  test("持久化后重开能恢复状态", () => {
    const dir = mkdtempSync(join(tmpdir(), "catcafe-"));
    try {
      const studio = new Studio({ cats: CATS, mode: "mock", dataDir: dir });
      studio.appendMessage({
        roomId: "room_cafe",
        author: "user",
        kind: "chat",
        text: "你好",
      });
      studio.persistNow();
      const seq = studio.state.seq;
      studio.close();

      const reopened = new Studio({ cats: CATS, mode: "mock", dataDir: dir });
      assert.equal(reopened.state.messages.length, 6);
      assert.equal(reopened.state.messages.at(-1)?.text, "你好");
      assert.ok(reopened.state.seq >= seq);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("HTTP", () => {
  let studio: Studio;
  let driver: ReturnType<typeof fakeDriver>;
  let server: ReturnType<typeof createHttpServer>;
  let base: string;

  before(async () => {
    studio = new Studio({ cats: CATS, mode: "mock" });
    driver = fakeDriver();
    server = createHttpServer({
      studio,
      driver,
      publicDir: resolve(import.meta.dirname, "../public"),
      scenarios: SCENARIOS,
      mode: "mock",
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    studio.close();
  });

  test("GET /api/health", async () => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; mode: string };
    assert.equal(body.ok, true);
    assert.equal(body.mode, "mock");
  });

  test("GET /api/state 返回完整快照", async () => {
    const res = await fetch(`${base}/api/state`);
    const state = (await res.json()) as { cats: unknown[]; rooms: unknown[] };
    assert.equal(state.cats.length, 4);
    assert.equal(state.rooms.length, 1);
  });

  test("POST 消息会解析 mention 并交给 driver", async () => {
    const res = await fetch(`${base}/api/rooms/room_cafe/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "@砚砚 帮忙看下" }),
    });
    assert.equal(res.status, 201);
    const message = (await res.json()) as { mentions: string[]; author: string };
    assert.deepEqual(message.mentions, ["yanyan"]);
    assert.equal(message.author, "user");
    assert.equal(driver.events.at(-1)?.type, "user_message");
  });

  test("POST 任务会创建 task 并触发 task_created", async () => {
    const res = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "room_cafe", brief: "给登录页加记住我" }),
    });
    assert.equal(res.status, 201);
    const task = (await res.json()) as { id: string; status: string };
    assert.equal(task.status, "active");
    assert.equal(driver.events.at(-1)?.type, "task_created");
    const nudge = await fetch(`${base}/api/tasks/${task.id}/nudge`, { method: "POST" });
    assert.equal(nudge.status, 202);
  });

  test("静态首页与路径穿越防护", async () => {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Cat Café Lab/);

    const traversal = await fetch(`${base}/..%2f..%2fpackage.json`);
    assert.notEqual(traversal.status, 200);
  });

  test("校验失败返回 4xx", async () => {
    const empty = await fetch(`${base}/api/rooms/room_cafe/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    assert.equal(empty.status, 400);

    const badTask = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief: "x" }),
    });
    assert.equal(badTask.status, 400);
  });
});
