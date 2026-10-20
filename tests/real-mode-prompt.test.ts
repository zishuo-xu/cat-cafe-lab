/**
 * 真实模式下的两个「不该泄漏的内部信息」回归。
 *
 * 都是真跑一个复杂任务（order-service 三 bug 修复）时暴露的：
 * 1. prompt 里传了内置剧本的 id（export_csv），模型把评语写成「导出 CSV v2 / 权限在
 *    service 层兜住了」——需求明明是修三个 bug。scenarioId 只是 mock 演出的内部标识。
 * 2. 轨迹里 kind 为 `artifact` 的条目有两种来源（消息 / 产物），消息条目没有 meta，
 *    外部集成与前端脚本按产物形状读就会炸。
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { buildSystemPrompt, buildUserPrompt } from "../src/agents/llm-brain.ts";
import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import type { Task, TurnContext } from "../src/domain/types.ts";
import { createHttpServer } from "../src/server/http.ts";
import { Studio } from "../src/server/studio.ts";
import { fakeDriver } from "./helpers/fake-driver.ts";
import { BUILTIN_TOOLS } from "../src/tools/builtin.ts";

function taskWithScenario(scenarioId: string): Task {
  return {
    id: "task_real_1",
    roomId: "room_cafe",
    title: "修 order-service 三个 bug",
    brief: "CSV 导出加 BOM、分页边界、缓存 TTL 单位修好，让 node --test 全绿。",
    scenarioId,
    status: "active",
    stage: "working",
    owner: "chenshi",
    steps: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeContext(task: Task | null): TurnContext {
  const cat = CATS.find((item) => item.role === "implementer") ?? CATS[0]!;
  const room = {
    id: "room_cafe",
    name: "order-service 修复",
    topic: "修三个 bug",
    catIds: CATS.map((item) => item.id),
    createdAt: 0,
  };
  return {
    cat,
    room,
    task,
    trigger: { kind: "handoff", roomId: room.id, taskId: task?.id ?? "", fromMemberId: "linzhiyuan" },
    recentMessages: [],
    memory: [],
    handoffs: [],
    artifacts: [],
    recentToolResults: [],
    availableTools: BUILTIN_TOOLS,
    skills: [],
    session: null,
    scenario: null,
    roomCats: CATS,
  } as TurnContext;
}

describe("真实模式 prompt 不泄漏内部剧本 id", () => {
  test("system prompt 不含 scenarioId", () => {
    const prompt = buildSystemPrompt(makeContext(taskWithScenario("export_csv")), "some-model");
    assert.ok(!prompt.includes("export_csv"), "不该把内部剧本 id 传给模型");
    assert.ok(!prompt.includes("场景 id"), "不该出现「场景 id」字样");
    // 需求原文必须在，模型只能靠它和仓库事实。
    assert.match(prompt, /CSV 导出加 BOM/);
  });

  test("user prompt 也不含 scenarioId", () => {
    const prompt = buildUserPrompt(makeContext(taskWithScenario("remember_me")));
    assert.ok(!prompt.includes("remember_me"));
  });

  test("没有任务时不崩，也不出现场景字样", () => {
    const prompt = buildSystemPrompt(makeContext(null), "m");
    assert.ok(!prompt.includes("场景 id"));
    assert.match(prompt, /没有进行中的任务/);
  });
});

describe("轨迹条目可区分消息与产物", () => {
  let studio: Studio;
  let server: ReturnType<typeof createHttpServer>;
  let base: string;
  let taskId: string;

  before(async () => {
    studio = new Studio({ cats: CATS.map((cat) => ({ ...cat })), mode: "mock" });
    server = createHttpServer({
      studio,
      driver: fakeDriver(),
      scenarios: SCENARIOS,
      mode: "mock",
      publicDir: resolve(import.meta.dirname, "../public"),
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("no port");
    base = `http://127.0.0.1:${address.port}`;

    const task = studio.createTask({
      roomId: "room_cafe",
      brief: "导出 CSV 加 UTF-8 BOM",
      scenarioId: "export_csv",
    });
    taskId = task.id;
    // 一条 kind=artifact 的消息（引用产物的对话），和一条真产物 —— 两者 kind 同名。
    studio.appendMessage({
      roomId: "room_cafe",
      author: "chenshi",
      kind: "artifact",
      text: "导出补丁 v1 在这儿",
      taskId: task.id,
    });
    studio.addArtifact({
      taskId: task.id,
      kind: "patch",
      title: "导出补丁 v1",
      body: "…",
      author: "chenshi",
    });
  });

  after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    studio.close();
  });

  test("消息条目带 messageId，产物条目带 artifactId", async () => {
    const res = await fetch(`${base}/api/tasks/${taskId}/trace`);
    assert.equal(res.status, 200);
    const trace = (await res.json()) as {
      entries: Array<{ kind: string; meta?: Record<string, unknown> }>;
    };

    const artifactKindEntries = trace.entries.filter((entry) => entry.kind === "artifact");
    assert.ok(artifactKindEntries.length >= 2, "应有「消息 + 产物」两类 artifact 条目");

    for (const entry of artifactKindEntries) {
      const meta = entry.meta ?? {};
      const isArtifact = typeof meta.artifactId === "string";
      const isMessage = typeof meta.messageId === "string";
      assert.ok(
        isArtifact || isMessage,
        `artifact 条目必须能用 meta.artifactId / meta.messageId 区分，实际：${JSON.stringify(meta)}`,
      );
    }
    assert.ok(
      artifactKindEntries.some((entry) => typeof entry.meta?.artifactId === "string"),
      "应有真产物条目",
    );
    assert.ok(
      artifactKindEntries.some((entry) => typeof entry.meta?.messageId === "string"),
      "应有消息条目",
    );
  });

  test("每条消息条目都有 messageId（外部集成可定位）", async () => {
    const res = await fetch(`${base}/api/tasks/${taskId}/trace`);
    const trace = (await res.json()) as {
      entries: Array<{ kind: string; meta?: Record<string, unknown> }>;
    };
    const messageKinds = new Set(["chat", "handoff", "review", "decision", "artifact", "tool", "system"]);
    let checked = 0;
    for (const entry of trace.entries) {
      if (!messageKinds.has(entry.kind)) continue;
      // 真产物条目（meta.artifactId）不是消息，不走这条断言。
      if (typeof entry.meta?.artifactId === "string") continue;
      checked += 1;
      assert.equal(
        typeof entry.meta?.messageId,
        "string",
        `${entry.kind} 条目缺 messageId：${JSON.stringify(entry.meta)}`,
      );
    }
    assert.ok(checked > 0, "应至少校验到一条消息条目");
  });
});
