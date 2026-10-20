/** 可观测性：LlmCall 记录、trace 汇总。 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { createLlmBrain } from "../src/agents/llm-brain.ts";
import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import { createMockBrain } from "../src/agents/mock-brain.ts";
import type { BrainReport, CatBrain, Driver, LlmSettings, TurnContext } from "../src/domain/types.ts";
import { createDriver } from "../src/engine/driver.ts";
import { createHttpServer } from "../src/server/http.ts";
import { Studio } from "../src/server/studio.ts";
import { BUILTIN_TOOLS } from "../src/tools/builtin.ts";

function fakeDriver(): Driver {
  return {
    submit() {},
    setProactive() {},
    async patrol() {},
    async whenIdle() {},
    stallMs: 12000,
  };
}

function makeContext(
  onReport?: (r: BrainReport) => void,
  onDelta?: (d: { catId: string; roomId: string; text: string }) => void,
): TurnContext {
  const cat = CATS.find((item) => item.role === "architect")!;
  const room = { id: "room_cafe", name: "猫咖", topic: "", catIds: CATS.map((c) => c.id), createdAt: 0 };
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
    session: null,
    roomCats: [],
    scenario: null,
    ...(onReport ? { onReport } : {}),
    ...(onDelta ? { onDelta } : {}),
  };
}

describe("模型调用记录", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw) as { stream?: boolean };
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '[{"kind":"message","text":"hi"}]' }, finish_reason: "stop" }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } })}\n\n`);
          res.end("data: [DONE]\n\n");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: JSON.stringify([{ kind: "message", text: "hi" }]) },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          }),
        );
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("no port");
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  });

  after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  const SETTINGS = (base: string): LlmSettings => ({
    baseUrl: base,
    model: "trace-model",
    apiKey: "k",
    temperature: 0.7,
  });
  const fallback: CatBrain = { mode: "mock", async think() { return [{ kind: "message", text: "fb" }]; } };

  test("非流式：回报 token 用量", async () => {
    let report: BrainReport = {};
    const brain = createLlmBrain(SETTINGS(baseUrl), fallback);
    await brain.think(makeContext((r) => { report = { ...report, ...r }; }));
    assert.equal(report.inputTokens, 100);
    assert.equal(report.outputTokens, 20);
    assert.equal(report.engine, "api");
    assert.notEqual(report.degraded, true);
  });

  test("流式：从收尾 chunk 取 usage", async () => {
    let report: BrainReport = {};
    const brain = createLlmBrain(SETTINGS(baseUrl), fallback, { streaming: true });
    await brain.think(
      makeContext(
        (r) => { report = { ...report, ...r }; },
        () => undefined,
      ),
    );
    assert.equal(report.inputTokens, 120, "应从 choices 为空的收尾 chunk 拿到 usage");
    assert.equal(report.outputTokens, 30);
    assert.equal(report.streamed, true);
  });

  test("降级：回报 degraded 与原因", async () => {
    let report: BrainReport = {};
    const brain = createLlmBrain(SETTINGS("http://127.0.0.1:1/v1"), fallback);
    await brain.think(makeContext((r) => { report = { ...report, ...r }; }));
    assert.equal(report.degraded, true);
    assert.ok((report.degradeReason ?? "").length > 0);
  });
});

describe("Studio 记录与 trace", () => {
  let dir: string;
  let studio: Studio;
  let server: ReturnType<typeof createHttpServer>;
  let base: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "catcafe-trace-"));
    studio = new Studio({ cats: CATS, mode: "mock" });
    server = createHttpServer({
      studio,
      driver: fakeDriver(),
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

  test("startLlmCall / finishLlmCall 记录耗时与用量", () => {
    const call = studio.startLlmCall({
      catId: "xianxian",
      model: "m1",
      engine: "api",
      stage: "planning",
      trigger: "task_created",
    });
    assert.equal(call.startedAt > 0, true);
    const done = studio.finishLlmCall(call.id, {
      inputTokens: 500,
      outputTokens: 80,
      turnKinds: ["message", "handoff"],
    });
    assert.equal(done?.inputTokens, 500);
    assert.ok((done?.durationMs ?? -1) >= 0);
    assert.deepEqual(done?.turnKinds, ["message", "handoff"]);
  });

  test("最多保留 200 条调用记录", () => {
    for (let i = 0; i < 210; i += 1) {
      const call = studio.startLlmCall({ catId: "yanyan", model: "m", engine: "api" });
      studio.finishLlmCall(call.id, {});
    }
    assert.ok(studio.snapshot().llmCalls.length <= 200);
  });

  test("GET /api/tasks/:id/trace 返回时间线与汇总", async () => {
    const task = studio.createTask({
      roomId: "room_cafe",
      brief: "trace 测试任务",
      scenarioId: "export_csv",
    });
    studio.appendMessage({
      roomId: "room_cafe",
      author: "xianxian",
      kind: "chat",
      text: "我先接住",
      taskId: task.id,
    });
    studio.addHandoff({
      taskId: task.id,
      from: "xianxian",
      to: "jinjianceng",
      card: { what: "实现", why: "拆活", tradeoff: "先做最小", openQuestions: [], nextAction: "交实现" },
    });
    const call = studio.startLlmCall({
      catId: "xianxian",
      model: "m",
      engine: "api",
      taskId: task.id,
      stage: "planning",
      trigger: "task_created",
    });
    studio.finishLlmCall(call.id, { inputTokens: 300, outputTokens: 40, degraded: false });

    const res = await fetch(`${base}/api/tasks/${task.id}/trace`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      entries: Array<{ kind: string; at: number }>;
      summary: Record<string, number>;
    };
    assert.ok(body.entries.length >= 3);
    assert.ok(body.entries.some((entry) => entry.kind === "handoff"));
    assert.ok(body.entries.some((entry) => entry.kind === "llm"));
    assert.equal(body.summary.llmCalls, 1);
    assert.equal(body.summary.inputTokens, 300);
    assert.equal(body.summary.handoffs, 1);
    // 时间线按时间升序
    const times = body.entries.map((entry) => entry.at);
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });

  test("trace 对不存在的任务返回 404", async () => {
    const res = await fetch(`${base}/api/tasks/nope/trace`);
    assert.equal(res.status, 404);
  });

  test("driver 每轮都会落一条 LlmCall", async () => {
    const local = new Studio({ cats: CATS, mode: "mock" });
    const driver = createDriver({
      studio: local,
      brain: createMockBrain(SCENARIOS),
      wait: () => Promise.resolve(),
      stallMs: 5000,
    });
    try {
      const task = local.createTask({
        roomId: "room_cafe",
        brief: "记录调用",
        scenarioId: "export_csv",
      });
      driver.submit({ type: "task_created", roomId: "room_cafe", taskId: task.id });
      await driver.whenIdle();
      const calls = local.snapshot().llmCalls.filter((call) => call.taskId === task.id);
      assert.ok(calls.length >= 1, "至少记录一次模型调用");
      assert.ok(calls.every((call) => (call.durationMs ?? 0) >= 0));
      assert.ok(calls.every((call) => Array.isArray(call.turnKinds)));
    } finally {
      local.close();
    }
  });
});

describe("审批等待时间", () => {
  test("pending → start 会记录审批耗时", () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    try {
      const call = studio.addToolCall({
        catId: "jinjianceng",
        tool: "run_command",
        args: { cmd: "node", args: ["--version"] },
        label: "跑版本",
        status: "pending",
      });
      assert.ok(call.approvalRequestedAt, "pending 时应记录请求时间");
      assert.equal(call.approvalDecidedAt, undefined);

      studio.startToolCall(call.id);
      const after = studio.snapshot().toolCalls.find((item) => item.id === call.id);
      assert.ok(after?.approvalDecidedAt, "批准时应记录决定时间");
      assert.ok(
        (after?.approvalDecidedAt ?? 0) >= (after?.approvalRequestedAt ?? 0),
        "决定时间不应早于请求时间",
      );
    } finally {
      studio.close();
    }
  });

  test("trace summary 汇总审批等待时间", async () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    const server = createHttpServer({
      studio,
      driver: fakeDriver(),
      publicDir: resolve(import.meta.dirname, "../public"),
      scenarios: SCENARIOS,
      mode: "mock",
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("no port");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const task = studio.createTask({
        roomId: "room_cafe",
        brief: "审批等待测试",
        scenarioId: "export_csv",
      });
      const call = studio.addToolCall({
        catId: "jinjianceng",
        tool: "run_command",
        args: { cmd: "node", args: ["--version"] },
        label: "跑版本",
        taskId: task.id,
        status: "pending",
      });
      // 手动制造 50ms 的等待
      await new Promise((resolve) => setTimeout(resolve, 50));
      studio.startToolCall(call.id);
      studio.finishToolCall(call.id, { status: "ok", output: "v1" });

      const res = await fetch(`${base}/api/tasks/${task.id}/trace`);
      const body = (await res.json()) as { summary: Record<string, number> };
      assert.ok((body.summary.approvalWaitMs ?? 0) >= 40, `应至少有 40ms，实际 ${body.summary.approvalWaitMs}`);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      studio.close();
    }
  });
});

describe("全量测试发现的问题（回归）", () => {
  test("任务完成时兜底写记忆，不依赖模型输出 memory", () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    try {
      const task = studio.createTask({
        roomId: "room_cafe",
        brief: "记忆兜底测试",
        scenarioId: "export_csv",
      });
      studio.addArtifact({
        taskId: task.id,
        kind: "patch",
        title: "实现补丁",
        body: "…",
        author: "jinjianceng",
      });
      assert.equal(studio.snapshot().memory.length, 0);

      const entry = studio.ensureTaskMemory(task.id);
      assert.ok(entry, "应该生成兜底记忆");
      assert.equal(entry?.kind, "decision");
      assert.equal(entry?.sourceTaskId, task.id);
      assert.match(entry?.title ?? "", /记忆兜底测试/);
      assert.match(entry?.body ?? "", /产出 1 个/);
      assert.match(entry?.body ?? "", /系统自动记录/);

      // 幂等：已有记忆就不再写
      const again = studio.ensureTaskMemory(task.id);
      assert.equal(again, null);
      assert.equal(studio.snapshot().memory.length, 1);
    } finally {
      studio.close();
    }
  });

  test("已有模型写的记忆时，兜底不覆盖", () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    try {
      const task = studio.createTask({
        roomId: "room_cafe",
        brief: "模型自己写了记忆",
        scenarioId: "export_csv",
      });
      studio.addMemory({
        kind: "decision",
        title: "模型写的决策",
        body: "模型自己给的",
        tags: ["x"],
        sourceTaskId: task.id,
      });
      const entry = studio.ensureTaskMemory(task.id);
      assert.equal(entry, null, "模型已经写了就不该再补");
      assert.equal(studio.snapshot().memory.length, 1);
    } finally {
      studio.close();
    }
  });
});
