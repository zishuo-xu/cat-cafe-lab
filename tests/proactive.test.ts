/** 主动协作：巡查挑选、silence 出口、不越权推进阶段。 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import { createMockBrain } from "../src/agents/mock-brain.ts";
import { createDriver } from "../src/engine/driver.ts";
import type { AgentBrain, AgentTurn, TurnContext } from "../src/domain/types.ts";
import { Studio } from "../src/server/studio.ts";

/** 只发一条消息就停：制造"任务还在进行中"的状态，便于测巡查。 */
function stallingBrain(): AgentBrain {
  return {
    mode: "mock",
    async think(ctx): Promise<AgentTurn[]> {
      if (ctx.trigger.kind === "proactive") return [{ kind: "silence", reason: "未指定" }];
      return [{ kind: "message", text: "我先看看" }];
    },
  };
}

/** 记录每次 think 的上下文，方便断言"谁被巡查唤醒了"。 */
function recordingBrain(
  inner: AgentBrain,
): { brain: AgentBrain; calls: TurnContext[] } {
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
    const silentBrain: AgentBrain = {
      mode: "mock",
      async think(ctx): Promise<AgentTurn[]> {
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
    const pushingBrain: AgentBrain = {
      mode: "mock",
      async think(ctx): Promise<AgentTurn[]> {
        if (ctx.trigger.kind === "proactive") {
          return [
            { kind: "message", text: "我提一句" },
            {
              kind: "handoff",
              to: "chenshi",
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

describe("stall 误报防护", () => {
  test("有模型调用在飞行时不标记卡住", async () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    const driver = createDriver({
      studio,
      brain: createMockBrain(SCENARIOS),
      wait: () => Promise.resolve(),
      stallMs: 100,
    });
    try {
      const task = studio.createTask({
        roomId: "room_cafe",
        brief: "慢调用不算卡住",
        scenarioId: "export_csv",
      });
      // 造一条"仍在进行"的模型调用
      const inflight = studio.startLlmCall({
        catId: "chenshi",
        model: "slow-model",
        engine: "api",
        taskId: task.id,
        stage: "working",
      });
      assert.ok(inflight.id);
      studio.setTaskStatus(task.id, "active");
      // 等超过 stallMs，任务不应被判 stalled
      await new Promise((resolve) => setTimeout(resolve, 260));
      assert.notEqual(studio.getTask(task.id)?.status, "stalled", "模型在跑时不应误报卡住");

      // 调用结束后，正常逻辑才能判卡住
      studio.finishLlmCall(inflight.id, {});
    } finally {
      studio.close();
    }
  });
});

describe("房间忙时的新需求（方案 A）", () => {
  test("有活跃任务时发消息会插入系统提醒，并绑定到该任务", async () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    const driver = createDriver({
      studio,
      brain: stallingBrain(),
      wait: () => Promise.resolve(),
      stallMs: 60_000,
    });
    try {
      const task = studio.createTask({
        roomId: "room_cafe",
        brief: "正在做的任务",
        scenarioId: "export_csv",
      });
      driver.submit({ type: "task_created", roomId: "room_cafe", taskId: task.id });
      await driver.whenIdle();
      assert.equal(studio.getTask(task.id)?.status, "active");

      const before = studio.snapshot().messages.length;
      driver.submit({
        type: "user_message",
        roomId: "room_cafe",
        text: "再给我加个新功能",
        mentions: [],
      });
      await driver.whenIdle();

      const messages = studio.snapshot().messages.slice(before);
      const warn = messages.find(
        (m) => m.kind === "system" && m.text.includes("还在进行中"),
      );
      assert.ok(warn, "应插入一条系统提醒");
      assert.match(warn.text, /同一个房间一次只做一件事/);
      assert.match(warn.text, /＋ 新任务/);
    } finally {
      studio.close();
    }
  });

  test("force=true 时不插提醒", async () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    const driver = createDriver({
      studio,
      brain: stallingBrain(),
      wait: () => Promise.resolve(),
      stallMs: 60_000,
    });
    try {
      const task = studio.createTask({
        roomId: "room_cafe",
        brief: "正在做的任务",
        scenarioId: "export_csv",
      });
      driver.submit({ type: "task_created", roomId: "room_cafe", taskId: task.id });
      await driver.whenIdle();

      const before = studio.snapshot().messages.length;
      driver.submit({
        type: "user_message",
        roomId: "room_cafe",
        text: "补充一句：注意兼容老接口",
        mentions: [],
        force: true,
      });
      await driver.whenIdle();
      const messages = studio.snapshot().messages.slice(before);
      assert.ok(
        !messages.some((m) => m.kind === "system" && m.text.includes("还在进行中")),
        "force 时不应插提醒",
      );
    } finally {
      studio.close();
    }
  });

  test("没有活跃任务时不插提醒", async () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    const driver = createDriver({
      studio,
      brain: stallingBrain(),
      wait: () => Promise.resolve(),
      stallMs: 60_000,
    });
    try {
      const task = studio.createTask({
        roomId: "room_cafe",
        brief: "已完成任务",
        scenarioId: "export_csv",
      });
      studio.setTaskStatus(task.id, "done");
      const before = studio.snapshot().messages.length;
      driver.submit({
        type: "user_message",
        roomId: "room_cafe",
        text: "随便聊聊",
        mentions: [],
      });
      await driver.whenIdle();
      const messages = studio.snapshot().messages.slice(before);
      assert.ok(
        !messages.some((m) => m.kind === "system" && m.text.includes("还在进行中")),
        "任务都结束了不该提醒",
      );
    } finally {
      studio.close();
    }
  });
});

describe("stall 判定：四种「在忙」都不该报卡住", () => {
  function setup(stallMs = 120) {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    const driver = createDriver({
      studio,
      brain: stallingBrain(),
      wait: () => Promise.resolve(),
      stallMs,
    });
    const task = studio.createTask({
      roomId: "room_cafe",
      brief: "stall 判定测试",
      scenarioId: "export_csv",
    });
    return { studio, driver, task };
  }

  test("有工具正在执行 → 不判卡住", async () => {
    const { studio, driver, task } = setup();
    try {
      driver.submit({ type: "task_created", roomId: "room_cafe", taskId: task.id });
      await driver.whenIdle();
      const call = studio.addToolCall({
        catId: "chenshi",
        tool: "run_command",
        args: { cmd: "node", args: ["--test"] },
        label: "跑测试",
        taskId: task.id,
        status: "running",
      });
      assert.ok(call.id);
      // 再跑一轮让它重新计时（此时工具 status=running）
      await driver.patrol();
      await driver.whenIdle();
      await new Promise((resolve) => setTimeout(resolve, 320));
      assert.notEqual(studio.getTask(task.id)?.status, "stalled", "工具在跑不该判卡住");
    } finally {
      studio.close();
    }
  });

  test("有工具在等审批 → 不判卡住", async () => {
    const { studio, driver, task } = setup();
    try {
      driver.submit({ type: "task_created", roomId: "room_cafe", taskId: task.id });
      await driver.whenIdle();
      const call = studio.addToolCall({
        catId: "chenshi",
        tool: "run_command",
        args: { cmd: "node", args: ["--test"] },
        label: "跑测试",
        taskId: task.id,
        status: "pending",
      });
      assert.ok(call.approvalRequestedAt, "pending 时应记录审批请求时间");
      await driver.patrol();
      await driver.whenIdle();
      await new Promise((resolve) => setTimeout(resolve, 320));
      assert.notEqual(studio.getTask(task.id)?.status, "stalled", "等审批不该判卡住");
    } finally {
      studio.close();
    }
  });

  test("审批已决定、工具已跑完 → 正常判卡住", async () => {
    const { studio, driver, task } = setup();
    try {
      // 走真实路径：先创建任务让 driver 在 processWake 结束时启动 stall 计时
      driver.submit({ type: "task_created", roomId: "room_cafe", taskId: task.id });
      await driver.whenIdle();

      const call = studio.addToolCall({
        catId: "chenshi",
        tool: "run_command",
        args: { cmd: "node", args: ["--test"] },
        label: "跑测试",
        taskId: task.id,
        status: "pending",
      });
      studio.startToolCall(call.id);
      studio.finishToolCall(call.id, { status: "ok", output: "done" });
      studio.setTaskStatus(task.id, "active");

      // 再跑一轮让它重新计时
      await driver.patrol();
      await driver.whenIdle();
      await new Promise((resolve) => setTimeout(resolve, 320));
      assert.equal(
        studio.getTask(task.id)?.status,
        "stalled",
        "没有任何进行中的事就该判卡住",
      );
    } finally {
      studio.close();
    }
  });

  test("完全没有进行中的事情 → 正常判卡住", async () => {
    const { studio, driver, task } = setup();
    try {
      driver.submit({ type: "task_created", roomId: "room_cafe", taskId: task.id });
      await driver.whenIdle();
      // processWake 结束时已启动 stall 计时
      await new Promise((resolve) => setTimeout(resolve, 320));
      assert.equal(studio.getTask(task.id)?.status, "stalled", "确实没人动就该判卡住");
    } finally {
      studio.close();
    }
  });
});
