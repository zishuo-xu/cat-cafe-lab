/**
 * 任务级模型健康度：降级必须能到达负责人。
 *
 * 背景：模型调用失败会静默降级回演出台词，任务照常跑完但产出质量掉档。
 * 以前 degraded 只留在 LlmCall 上，不翻任务轨迹根本看不出来，
 * 负责人会以为自己看到的是模型真实判断。
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { CATS } from "../src/agents/personas.ts";
import type { AgentBrain } from "../src/domain/types.ts";
import { createDriver } from "../src/engine/driver.ts";
import { Studio } from "../src/server/studio.ts";

const ROOM_ID = "room_cafe";

function makeStudio(): Studio {
  return new Studio({ cats: CATS.map((cat) => ({ ...cat })), mode: "mock" });
}

describe("任务健康度：降级可见", () => {
  test("降级累加到任务上，并留下一条系统消息", () => {
    const studio = makeStudio();
    const task = studio.createTask({
      roomId: ROOM_ID,
      brief: "给登录页加一个记住我勾选框，7天内免登录",
      scenarioId: "remember_me",
    });

    const call = studio.startLlmCall({
      catId: "linzhiyuan",
      model: "some-model",
      engine: "api",
      taskId: task.id,
      stage: "working",
    });
    studio.finishLlmCall(call.id, {
      degraded: true,
      degradeReason: "LLM_MODEL 缺失",
    });

    const updated = studio.getTask(task.id);
    assert.equal(updated?.health?.degradedCount, 1, "应记 1 次降级");
    assert.equal(updated?.health?.lastDegradeReason, "LLM_MODEL 缺失");
    assert.equal(updated?.health?.lastDegradeStage, "working");

    const systemMessages = studio.state.messages.filter(
      (message) => message.taskId === task.id && message.author === "system",
    );
    assert.equal(systemMessages.length, 1, "第一次降级应留一条系统消息");
    assert.match(systemMessages[0]?.text ?? "", /可能不可信/);

    studio.close();
  });

  test("多次降级只提示一次，但计数继续累加", () => {
    const studio = makeStudio();
    const task = studio.createTask({
      roomId: ROOM_ID,
      brief: "导出 CSV 加 BOM",
      scenarioId: "export_csv",
    });

    for (let i = 0; i < 5; i += 1) {
      const call = studio.startLlmCall({
        catId: "chenshi",
        model: "some-model",
        engine: "api",
        taskId: task.id,
        stage: "working",
      });
      studio.finishLlmCall(call.id, { degraded: true, degradeReason: `原因 ${i}` });
    }

    const updated = studio.getTask(task.id);
    assert.equal(updated?.health?.degradedCount, 5, "5 次降级都要计数");
    assert.equal(updated?.health?.lastDegradeReason, "原因 4", "记录最近一次原因");

    const systemMessages = studio.state.messages.filter(
      (message) => message.taskId === task.id && message.author === "system",
    );
    assert.equal(systemMessages.length, 1, "多次降级只能提示一次，避免刷屏");

    studio.close();
  });

  test("没降级时不产生 health 字段与系统消息", () => {
    const studio = makeStudio();
    const task = studio.createTask({
      roomId: ROOM_ID,
      brief: "导出 CSV 加 BOM",
      scenarioId: "export_csv",
    });

    const call = studio.startLlmCall({
      catId: "chenshi",
      model: "some-model",
      engine: "api",
      taskId: task.id,
      stage: "working",
    });
    studio.finishLlmCall(call.id, { inputTokens: 100, outputTokens: 50 });

    const updated = studio.getTask(task.id);
    assert.equal(updated?.health, undefined, "正常调用不该写 health");

    const systemMessages = studio.state.messages.filter(
      (message) => message.taskId === task.id && message.author === "system",
    );
    assert.equal(systemMessages.length, 0, "正常调用不该有系统消息");

    studio.close();
  });

  test("降级发生在没有 taskId 的调用上（房间闲聊）不会崩", () => {
    const studio = makeStudio();
    const call = studio.startLlmCall({
      catId: "linzhiyuan",
      model: "some-model",
      engine: "api",
    });
    studio.finishLlmCall(call.id, { degraded: true, degradeReason: "端点不可达" });
    assert.equal(studio.state.tasks.length, 0);
    studio.close();
  });
});

describe("任务健康度：端到端（brain 降级 → 任务可见）", () => {
  test("brain 通过 onReport 上报降级后，任务上能看到计数和系统消息", async () => {
    const studio = makeStudio();
    const task = studio.createTask({
      roomId: ROOM_ID,
      brief: "给登录页加一个记住我勾选框，7天内免登录",
      scenarioId: "remember_me",
    });

    // 模拟真实模式的 brain：第一轮就上报降级，然后退回演出台词。
    // 这条链路才是生产路径：brain.onReport → driver 收集 → finishLlmCall → Task.health
    const brain: AgentBrain = {
      mode: "llm",
      async think(ctx) {
        ctx.onReport?.({
          model: "fake-model",
          engine: "api",
          degraded: true,
          degradeReason: "LLM 端点 502",
        });
        return [{ kind: "message", text: "（降级后的演出台词）" }];
      },
    };

    const driver = createDriver({
      studio,
      brain,
      wait: async () => {},
      stallMs: 60_000,
    });

    try {
      driver.submit({ type: "task_created", roomId: ROOM_ID, taskId: task.id });
      await driver.whenIdle();

      const updated = studio.getTask(task.id);
      assert.ok(updated, "任务应存在");
      assert.ok(
        (updated.health?.degradedCount ?? 0) > 0,
        `降级应汇总到任务上，实际 health=${JSON.stringify(updated.health)}`,
      );
      assert.equal(updated.health?.lastDegradeReason, "LLM 端点 502");

      const warn = studio.state.messages.find(
        (message) =>
          message.taskId === task.id &&
          message.author === "system" &&
          /可能不可信/.test(message.text),
      );
      assert.ok(warn, "应留下一条「产出可能不可信」的系统消息");
    } finally {
      studio.close();
    }
  });
});
