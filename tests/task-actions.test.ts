/** 失败恢复：continue / pivot / close 三种负责人动作。 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import { createMockBrain } from "../src/agents/mock-brain.ts";
import { createDriver } from "../src/engine/driver.ts";
import { createHttpServer } from "../src/server/http.ts";
import { Studio } from "../src/server/studio.ts";

function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) {
        resolvePromise(true);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        resolvePromise(false);
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe("task actions", () => {
  test("close：任务立刻 done，并记一条 manual-close 教训", async () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    const driver = createDriver({
      studio,
      brain: createMockBrain(SCENARIOS),
      wait: () => Promise.resolve(),
      stallMs: 5000,
    });
    try {
      const task = studio.createTask({
        roomId: "room_cafe",
        brief: "会被手动收尾的任务",
        scenarioId: "export_csv",
      });
      driver.submit({ type: "task_created", roomId: "room_cafe", taskId: task.id });
      await driver.whenIdle();
      studio.setTaskStatus(task.id, "stalled");

      driver.submit({ type: "task_action", taskId: task.id, action: "close", note: "时间不够了" });
      await driver.whenIdle();

      const final = studio.getTask(task.id);
      assert.equal(final?.status, "done");
      assert.equal(final?.stage, "done");
      assert.ok(
        studio.snapshot().memory.some((entry) => entry.tags.includes("manual-close")),
      );
      assert.ok(
        studio
          .snapshot()
          .messages.some((message) => message.kind === "system" && message.text.includes("时间不够了")),
      );
    } finally {
      studio.close();
    }
  });

  test("continue：解除 stalled 并重新唤醒主理猫", async () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    const driver = createDriver({
      studio,
      brain: createMockBrain(SCENARIOS),
      wait: () => Promise.resolve(),
      stallMs: 5000,
    });
    try {
      const task = studio.createTask({
        roomId: "room_cafe",
        brief: "继续试试",
        scenarioId: "export_csv",
      });
      driver.submit({ type: "task_created", roomId: "room_cafe", taskId: task.id });
      await driver.whenIdle();
      studio.setTaskStatus(task.id, "stalled");

      const before = studio.snapshot().messages.length;
      driver.submit({ type: "task_action", taskId: task.id, action: "continue" });
      await driver.whenIdle();

      assert.notEqual(studio.getTask(task.id)?.status, "stalled");
      assert.ok(studio.snapshot().messages.length > before, "应有新消息");
    } finally {
      studio.close();
    }
  });

  test("pivot：写入换方案指令并解除卡住", async () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    const driver = createDriver({
      studio,
      brain: createMockBrain(SCENARIOS),
      wait: () => Promise.resolve(),
      stallMs: 5000,
    });
    try {
      const task = studio.createTask({
        roomId: "room_cafe",
        brief: "换个思路",
        scenarioId: "export_csv",
      });
      driver.submit({ type: "task_created", roomId: "room_cafe", taskId: task.id });
      await driver.whenIdle();
      studio.setTaskStatus(task.id, "stalled");

      driver.submit({
        type: "task_action",
        taskId: task.id,
        action: "pivot",
        note: "别读文件了，直接写结论",
      });
      await driver.whenIdle();

      assert.notEqual(studio.getTask(task.id)?.status, "stalled");
      assert.ok(
        studio
          .snapshot()
          .messages.some(
            (message) =>
              message.author === "user" && message.text.includes("别读文件了，直接写结论"),
          ),
      );
    } finally {
      studio.close();
    }
  });
});

describe("HTTP /api/tasks/:id/action", () => {
  let dir: string;
  let studio: Studio;
  let server: ReturnType<typeof createHttpServer>;
  let base: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "catcafe-action-"));
    studio = new Studio({ cats: CATS, mode: "mock" });
    const driver = createDriver({
      studio,
      brain: createMockBrain(SCENARIOS),
      wait: () => Promise.resolve(),
      stallMs: 60_000,
    });
    server = createHttpServer({
      studio,
      driver,
      publicDir: resolve(import.meta.dirname, "../public"),
      scenarios: SCENARIOS,
      mode: "mock",
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("no port");
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    studio.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("close / continue / pivot 都能调用；非法 action 400", async () => {
    const task = studio.createTask({
      roomId: "room_cafe",
      brief: "HTTP 动作测试",
      scenarioId: "export_csv",
    });

    const closed = await fetch(`${base}/api/tasks/${task.id}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "close", note: "测试收尾" }),
    });
    assert.equal(closed.status, 202);
    assert.ok(await waitFor(() => studio.getTask(task.id)?.status === "done"));

    const bad = await fetch(`${base}/api/tasks/${task.id}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "explode" }),
    });
    assert.equal(bad.status, 400);

    const missing = await fetch(`${base}/api/tasks/nope/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "close" }),
    });
    assert.equal(missing.status, 404);
  });
});

describe("被强制收尾的任务可以复活", () => {
  test("review-loop 的 done 任务能 continue；正常 done 任务不能", async () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    const driver = createDriver({
      studio,
      brain: createMockBrain(SCENARIOS),
      wait: () => Promise.resolve(),
      stallMs: 5000,
    });
    try {
      const forced = studio.createTask({
        roomId: "room_cafe",
        brief: "被强制收尾的任务",
        scenarioId: "export_csv",
      });
      studio.setTaskStatus(forced.id, "done");
      studio.addMemory({
        kind: "lesson",
        title: "评审反复打回",
        body: "3 轮未通过",
        tags: ["review-loop"],
        sourceTaskId: forced.id,
      });

      driver.submit({ type: "task_action", taskId: forced.id, action: "continue" });
      await driver.whenIdle();
      assert.notEqual(studio.getTask(forced.id)?.status, "done", "forced-close 任务应能复活");

      const normal = studio.createTask({
        roomId: "room_cafe",
        brief: "正常完成的任务",
        scenarioId: "export_csv",
      });
      studio.setTaskStatus(normal.id, "done");
      driver.submit({ type: "task_action", taskId: normal.id, action: "continue" });
      await driver.whenIdle();
      assert.equal(studio.getTask(normal.id)?.status, "done", "正常完成的任务不应被重开");
    } finally {
      studio.close();
    }
  });
});
