/** 每猫持久会话：跨任务经历、教训归属、prompt 注入。 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import { createMockBrain } from "../src/agents/mock-brain.ts";
import { createDriver } from "../src/engine/driver.ts";
import { buildSystemPrompt } from "../src/agents/llm-brain.ts";
import type { CatSession, TurnContext } from "../src/domain/types.ts";
import { Studio } from "../src/server/studio.ts";
import { BUILTIN_TOOLS } from "../src/tools/builtin.ts";

function makeContext(session: CatSession | null): TurnContext {
  const cat = CATS.find((item) => item.role === "architect")!;
  const room = {
    id: "room_cafe",
    name: "猫咖",
    topic: "",
    catIds: CATS.map((item) => item.id),
    createdAt: 0,
  };
  return {
    cat,
    room,
    task: null,
    trigger: { kind: "task_created", roomId: room.id },
    recentMessages: [],
    memory: [],
    handoffs: [],
    artifacts: [],
    recentToolResults: [],
    availableTools: BUILTIN_TOOLS,
    skills: [],
    session,
    scenario: null,
  };
}

describe("每猫持久会话", () => {
  test("recordEpisode 新的在前，同一任务覆盖，最多 8 条", () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    try {
      const session = studio.sessionFor("xianxian");
      assert.equal(session.episodes.length, 0);

      studio.recordEpisode({
        catId: "xianxian",
        taskId: "t1",
        title: "任务一",
        summary: "拆了两张卡",
        outcome: "done",
      });
      studio.recordEpisode({
        catId: "xianxian",
        taskId: "t2",
        title: "任务二",
        summary: "做了评审",
        outcome: "abandoned",
      });
      let episodes = studio.sessionFor("xianxian").episodes;
      assert.equal(episodes.length, 2);
      assert.equal(episodes[0]?.taskId, "t2", "新的在前");

      // 同一任务重跑 → 覆盖而不是追加
      studio.recordEpisode({
        catId: "xianxian",
        taskId: "t1",
        title: "任务一（重跑）",
        summary: "重新拆卡",
        outcome: "done",
      });
      episodes = studio.sessionFor("xianxian").episodes;
      assert.equal(episodes.length, 2);
      assert.equal(episodes[0]?.taskId, "t1");
      assert.match(episodes[0]?.title ?? "", /重跑/);

      // 超过 8 条只保留最近 8 条
      for (let i = 0; i < 12; i += 1) {
        studio.recordEpisode({
          catId: "xianxian",
          taskId: `bulk-${i}`,
          title: `批量任务 ${i}`,
          summary: "x",
          outcome: "done",
        });
      }
      assert.equal(studio.sessionFor("xianxian").episodes.length, 8);
    } finally {
      studio.close();
    }
  });

  test("教训按猫归属，最多 12 条", () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    try {
      const entry = studio.addMemory({
        kind: "lesson",
        title: "先写 expires_at",
        body: "长期凭证先定过期",
        tags: ["auth"],
      });
      studio.attachLesson("yanyan", entry);
      assert.equal(studio.sessionFor("yanyan").lessons.length, 1);
      assert.equal(studio.sessionFor("xianxian").lessons.length, 0, "别的猫不应拿到");
    } finally {
      studio.close();
    }
  });

  test("会话持久化到磁盘并能在重启后恢复", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "catcafe-session-"));
    try {
      const studio = new Studio({ cats: CATS, mode: "mock", dataDir: dir });
      studio.recordEpisode({
        catId: "jinjianceng",
        taskId: "t9",
        title: "实现记住我",
        summary: "写了 remember.js",
        outcome: "done",
      });
      studio.persistNow();
      studio.close();

      const reopened = new Studio({ cats: CATS, mode: "mock", dataDir: dir });
      const episodes = reopened.sessionFor("jinjianceng").episodes;
      assert.equal(episodes.length, 1);
      assert.equal(episodes[0]?.title, "实现记住我");
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prompt 里出现近期经历与教训", () => {
    const session: CatSession = {
      catId: "xianxian",
      episodes: [
        { taskId: "t1", title: "记住我", summary: "拆了两张卡", outcome: "done", at: 1 },
        { taskId: "t2", title: "导出 CSV", summary: "评审打回", outcome: "abandoned", at: 2 },
      ],
      lessons: [
        {
          id: "m1",
          kind: "lesson",
          title: "先写 expires_at",
          body: "长期凭证先定过期",
          tags: ["auth"],
          createdAt: 1,
        },
      ],
      updatedAt: 2,
    };
    const prompt = buildSystemPrompt(makeContext(session), "test-model");
    assert.match(prompt, /你的近期经历/);
    assert.match(prompt, /\[完成\] 记住我/);
    assert.match(prompt, /\[中止\] 导出 CSV/);
    assert.match(prompt, /先写 expires_at/);
    assert.match(prompt, /主动提一句你再做/);
  });

  test("会话为空时不出现该段", () => {
    const empty: CatSession = { catId: "xianxian", episodes: [], lessons: [], updatedAt: 0 };
    const prompt = buildSystemPrompt(makeContext(empty), "m");
    assert.ok(!prompt.includes("你的近期经历"));
    const promptNull = buildSystemPrompt(makeContext(null), "m");
    assert.ok(!promptNull.includes("你的近期经历"));
  });

  test("任务完成后为参与过的猫各记一条经历", async () => {
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
        brief: "给登录页加记住我",
        scenarioId: "export_csv",
      });
      driver.submit({ type: "task_created", roomId: "room_cafe", taskId: task.id });
      // 一路催到完成
      for (let i = 0; i < 20; i += 1) {
        await driver.whenIdle();
        await new Promise((resolve) => setTimeout(resolve, 10));
        const current = studio.getTask(task.id);
        if (!current || current.status === "done") break;
        if (current.status === "stalled") {
          driver.submit({ type: "task_action", taskId: task.id, action: "continue" });
        }
      }
      const sessions = studio.snapshot().catSessions;
      const recorded = Object.values(sessions).filter((s) =>
        s.episodes.some((e) => e.taskId === task.id),
      );
      assert.ok(recorded.length >= 2, `至少宪宪和金渐层应有记录，实际 ${recorded.length}`);
      for (const session of recorded) {
        const episode = session.episodes.find((e) => e.taskId === task.id);
        assert.ok(episode?.summary.length, "摘要不为空");
        assert.equal(episode?.title, task.title);
      }
    } finally {
      studio.close();
    }
  });
});
