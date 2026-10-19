/** 主动协作：巡查挑选、silence 出口、不越权推进阶段。 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import { createMockBrain } from "../src/agents/mock-brain.ts";
import { createDriver } from "../src/engine/driver.ts";
import type { CatBrain, CatTurn, TurnContext } from "../src/domain/types.ts";
import { Studio } from "../src/server/studio.ts";

/** 只发一条消息就停：制造"任务还在进行中"的状态，便于测巡查。 */
function stallingBrain(): CatBrain {
  return {
    mode: "mock",
    async think(ctx): Promise<CatTurn[]> {
      if (ctx.trigger.kind === "proactive") return [{ kind: "silence", reason: "未指定" }];
      return [{ kind: "message", text: "我先看看" }];
    },
  };
}

/** 记录每次 think 的上下文，方便断言"谁被巡查唤醒了"。 */
function recordingBrain(
  inner: CatBrain,
): { brain: CatBrain; calls: TurnContext[] } {
  const calls: TurnContext[] = [];
  return {
    calls,
    brain: {
      mode: inner.mode,
      think(ctx) {
        calls.push(ctx);
        return inner.think(ctx);
      },
    },
  };
}

describe("主动巡查", () => {
  test("巡查只唤醒非 owner 的猫，且 trigger.kind = proactive", async () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    const record = recordingBrain(stallingBrain());
    const driver = createDriver({
      studio,
      brain: record.brain,
      wait: () => Promise.resolve(),
      stallMs: 5000,
    });
    try {
      const task = studio.createTask({
        roomId: "room_cafe",
        brief: "巡查测试",
        scenarioId: "export_csv",
      });
      driver.submit({ type: "task_created", roomId: "room_cafe", taskId: task.id });
      await driver.whenIdle();

      const before = record.calls.length;
      await driver.patrol();
      await driver.whenIdle();
      const patrolCalls = record.calls.slice(before).filter((ctx) => ctx.trigger.kind === "proactive");
      assert.equal(patrolCalls.length, 1, "一次巡查只叫一只猫");
      const owner = studio.getTask(task.id)?.owner;
      assert.notEqual(patrolCalls[0]?.cat.id, owner, "不应该让 owner 巡查自己");
      assert.equal(patrolCalls[0]?.task?.id, task.id);
    } finally {
      studio.close();
    }
  });

  test("优先挑 reviewer 巡查", async () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    const record = recordingBrain(stallingBrain());
    const driver = createDriver({
      studio,
      brain: record.brain,
      wait: () => Promise.resolve(),
      stallMs: 5000,
    });
    try {
      const task = studio.createTask({
        roomId: "room_cafe",
        brief: "优先 reviewer",
        scenarioId: "export_csv",
      });
      driver.submit({ type: "task_created", roomId: "room_cafe", taskId: task.id });
      await driver.whenIdle();
      const before = record.calls.length;
      await driver.patrol();
      await driver.whenIdle();
      const patrolCat = record.calls.slice(before).find((ctx) => ctx.trigger.kind === "proactive");
      assert.equal(patrolCat?.cat.role, "reviewer", "第一次巡查应优先 reviewer");
    } finally {
      studio.close();
    }
  });

  test("silence turn 不产生任何消息", async () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    const silentBrain: CatBrain = {
      mode: "mock",
      async think(ctx): Promise<CatTurn[]> {
        // 巡查轮一律沉默；其他轮正常说话
        if (ctx.trigger.kind === "proactive") return [{ kind: "silence", reason: "没我什么事" }];
        return [{ kind: "message", text: "我在做活" }];
      },
    };
    const driver = createDriver({
      studio,
      brain: silentBrain,
      wait: () => Promise.resolve(),
      stallMs: 5000,
    });
    try {
      const task = studio.createTask({
        roomId: "room_cafe",
        brief: "沉默测试",
        scenarioId: "export_csv",
      });
      driver.submit({ type: "task_created", roomId: "room_cafe", taskId: task.id });
      await driver.whenIdle();
      const before = studio.snapshot().messages.length;
      await driver.patrol();
      await driver.whenIdle();
      assert.equal(
        studio.snapshot().messages.length,
        before,
        "沉默不应产生消息",
      );
    } finally {
      studio.close();
    }
  });

  test("巡查轮不能推进阶段（handoff 被忽略）", async () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    const pushingBrain: CatBrain = {
      mode: "mock",
      async think(ctx): Promise<CatTurn[]> {
        if (ctx.trigger.kind === "proactive") {
          return [
            { kind: "message", text: "我提一句" },
            {
              kind: "handoff",
              to: "jinjianceng",
              card: { what: "越权交接", why: "x", tradeoff: "x", openQuestions: [], nextAction: "x" },
            },
          ];
        }
        return [{ kind: "message", text: "正常" }];
      },
    };
    const driver = createDriver({
      studio,
      brain: pushingBrain,
      wait: () => Promise.resolve(),
      stallMs: 5000,
    });
    try {
      const task = studio.createTask({
        roomId: "room_cafe",
        brief: "越权测试",
        scenarioId: "export_csv",
      });
      driver.submit({ type: "task_created", roomId: "room_cafe", taskId: task.id });
      await driver.whenIdle();
      const stageBefore = studio.getTask(task.id)?.stage;
      const handoffsBefore = studio.snapshot().handoffs.length;
      await driver.patrol();
      await driver.whenIdle();
      assert.equal(studio.getTask(task.id)?.stage, stageBefore, "巡查不应推进阶段");
      assert.equal(
        studio.snapshot().handoffs.length,
        handoffsBefore,
        "巡查轮不应产生交接",
      );
    } finally {
      studio.close();
    }
  });

  test("没有活跃任务时巡查不唤醒任何人", async () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    const record = recordingBrain(stallingBrain());
    const driver = createDriver({
      studio,
      brain: record.brain,
      wait: () => Promise.resolve(),
      stallMs: 5000,
    });
    try {
      const before = record.calls.length;
      await driver.patrol();
      await driver.whenIdle();
      assert.equal(record.calls.length, before, "没活就别叫猫");
    } finally {
      studio.close();
    }
  });

  test("setProactive(false) 后没有残留定时器", async () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    const driver = createDriver({
      studio,
      brain: createMockBrain(SCENARIOS),
      wait: () => Promise.resolve(),
      stallMs: 5000,
    });
    try {
      driver.setProactive(true, 50);
      driver.setProactive(false);
      const before = studio.snapshot().messages.length;
      await new Promise((resolve) => setTimeout(resolve, 160));
      assert.equal(studio.snapshot().messages.length, before, "关闭后不应继续巡查");
    } finally {
      studio.close();
    }
  });
});
