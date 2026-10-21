/**
 * 端到端集成测试（T4 验收）：
 *
 *   POST /api/tasks  →  真实 driver + 场景 beats 跑完整六阶段  →  任务 done
 *   →  五栏 handoff / review 打回后 v2 patch / memory 有 decision  /  SSE 可连
 *
 * 依赖：T1 `src/engine/driver.ts` 的真实状态机 + T2 场景 beats（均已落地）。
 * 不跳任何用例：这条链路是 M4 的验收项，必须真跑。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { createLlmBrain } from "../src/agents/llm-brain.ts";
import { createMockBrain } from "../src/agents/mock-brain.ts";
import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import type {
  Artifact,
  Driver,
  Handoff,
  MemoryEntry,
  Message,
  StudioState,
  Task,
  TaskStage,
} from "../src/domain/types.ts";
import { createDriver } from "../src/engine/driver.ts";
import { createHttpServer } from "../src/server/http.ts";
import { Studio } from "../src/server/studio.ts";

const BRIEF = "给登录页加一个「记住我」勾选框，7 天内免登录。";
const TASK_TIMEOUT_MS = 20_000;

// ───────────────────────── 小工具 ─────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function getState(base: string): Promise<StudioState> {
  const res = await fetch(`${base}/api/state`);
  assert.equal(res.status, 200, "GET /api/state 必须 200");
  return (await res.json()) as StudioState;
}

function findTask(state: StudioState, taskId: string): Task {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`state 里找不到任务 ${taskId}`);
  return task;
}

/** Studio 是 200ms debounce 落盘，这里轮询等文件真正出现（最多 1s）。 */
async function waitForFile(path: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await sleep(25);
  }
  throw new Error(`文件未在 ${timeoutMs}ms 内落盘：${path}`);
}

/**
 * 轮询 /api/state 直到任务 done。
 * 演示场景里埋了 missed_mention 故障，靠「催一下」恢复，所以卡住时自动 nudge（最多 3 次）。
 */
async function waitForTaskDone(
  base: string,
  taskId: string,
  timeoutMs = TASK_TIMEOUT_MS,
): Promise<StudioState> {
  const deadline = Date.now() + timeoutMs;
  let lastStage = "";
  let lastChangeAt = Date.now();
  let nudges = 0;

  while (Date.now() < deadline) {
    const state = await getState(base);
    const task = findTask(state, taskId);
    if (task.status === "done" || task.stage === "done") return state;

    if (task.stage !== lastStage) {
      lastStage = task.stage;
      lastChangeAt = Date.now();
    }
    const stuck = task.status === "stalled" || Date.now() - lastChangeAt > 1200;
    if (stuck && nudges < 3) {
      nudges += 1;
      const res = await fetch(`${base}/api/tasks/${taskId}/nudge`, { method: "POST" });
      assert.equal(res.status, 202, "nudge 应返回 202");
      lastChangeAt = Date.now();
    }
    await sleep(40);
  }

  const snapshot = await getState(base);
  const task = findTask(snapshot, taskId);
  const history = snapshot.messages
    .filter((message) => message.taskId === taskId)
    .map((message) => `[${message.kind}] ${message.author}: ${message.text}`)
    .join("\n");
  throw new Error(
    `任务 ${TASK_TIMEOUT_MS}ms 内未 done（stage=${task.stage}, status=${task.status}）\n${history}`,
  );
}

/**
 * 轮询 /api/state 直到任务进入指定状态。
 * 模型失败的新语义：任务会被 driver 暂停成 stalled，而不是降级跑完。
 */
async function waitForTaskStatus(
  base: string,
  taskId: string,
  status: Task["status"],
  timeoutMs = 10_000,
): Promise<StudioState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getState(base);
    const task = findTask(state, taskId);
    if (task.status === status) return state;
    await sleep(40);
  }
  const snapshot = await getState(base);
  const task = findTask(snapshot, taskId);
  throw new Error(
    `任务未在 ${timeoutMs}ms 内进入 status=${status}（实际 stage=${task.stage}, status=${task.status}）`,
  );
}

/** 等「模型调用失败」系统消息累计到 minCount 条，且任务处于 stalled。 */
async function waitForModelFailureMessages(
  base: string,
  taskId: string,
  minCount: number,
  timeoutMs = 10_000,
): Promise<StudioState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getState(base);
    const task = findTask(state, taskId);
    const count = state.messages.filter(
      (message) =>
        message.taskId === taskId &&
        message.author === "system" &&
        /模型调用失败/.test(message.text),
    ).length;
    if (count >= minCount && task.status === "stalled") return state;
    await sleep(40);
  }
  throw new Error(`模型失败暂停消息未累计到 ${minCount} 条`);
}

/** 读 SSE 的第一条 data 事件（连接时服务端会先推一次全量快照）。 */
async function readFirstSseEvent(
  base: string,
): Promise<{ seq: number; state: StudioState }> {
  const controller = new AbortController();
  try {
    const res = await fetch(`${base}/api/events`, { signal: controller.signal });
    assert.equal(res.status, 200, "GET /api/events 必须 200");
    assert.match(String(res.headers.get("content-type")), /text\/event-stream/);

    const body = res.body;
    assert.ok(body, "SSE 响应应有 body");
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 3000;

    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const match = /data: ([^\n]+)\n\n/.exec(buffer);
      if (match?.[1]) {
        return JSON.parse(match[1]) as { seq: number; state: StudioState };
      }
    }
    throw new Error(`SSE 3s 内没有收到 data 事件，已收到：${buffer.slice(0, 200)}`);
  } finally {
    controller.abort();
  }
}

// ───────────────────────── 用例 ─────────────────────────

describe("集成 · 完整协作链路（mock 模式）", () => {
  let dataDir: string;
  let studio: Studio;
  let driver: Driver;
  let server: ReturnType<typeof createHttpServer>;
  let base: string;
  let taskId: string;
  let state: StudioState;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "deliverylab-e2e-"));
    studio = new Studio({ cats: CATS, mode: "mock", dataDir });
    driver = createDriver({
      studio,
      brain: createMockBrain(SCENARIOS),
      // 测试里不需要真等打字延迟，瞬间推进。
      wait: async () => {},
      stallMs: 300,
    });
    server = createHttpServer({
      studio,
      driver,
      publicDir: resolve(import.meta.dirname, "../public"),
      scenarios: SCENARIOS,
      mode: "mock",
    });
    await new Promise<void>((resolveListen) =>
      server.listen(0, "127.0.0.1", () => resolveListen()),
    );
    const address = server.address();
    assert.ok(address && typeof address === "object");
    base = `http://127.0.0.1:${address.port}`;

    // 起任务：走 HTTP，和真实用户路径一致。
    const res = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "room_cafe", brief: BRIEF }),
    });
    assert.equal(res.status, 201, "POST /api/tasks 应返回 201");
    const task = (await res.json()) as Task;
    assert.equal(task.stage, "intake");
    taskId = task.id;

    state = await waitForTaskDone(base, taskId);
  });

  after(async () => {
    await driver.whenIdle().catch(() => {});
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    studio.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("任务最终 done，且六个阶段都走过", () => {
    const task = findTask(state, taskId);
    assert.equal(task.status, "done");
    assert.equal(task.stage, "done");
    assert.ok(task.steps.length >= 3, `应走过至少 3 个阶段，实际 ${task.steps.length} 步`);

    const stages = new Set<TaskStage>(task.steps.map((step) => step.stage));
    for (const stage of [
      "intake",
      "planning",
      "working",
      "reviewing",
      "revising",
      "done",
    ] satisfies TaskStage[]) {
      assert.ok(stages.has(stage), `阶段轨迹里应有 ${stage}，实际：${[...stages].join(",")}`);
    }
  });

  test("至少一张五栏交接卡，且五栏都不缺", () => {
    const handoffs = state.handoffs.filter(
      (handoff: Handoff) => handoff.taskId === taskId,
    );
    assert.ok(handoffs.length >= 1, "至少要有一次 handoff");

    for (const handoff of handoffs) {
      const card = handoff.card;
      assert.equal(typeof card.what, "string");
      assert.equal(typeof card.why, "string");
      assert.equal(typeof card.tradeoff, "string");
      assert.equal(typeof card.nextAction, "string");
      assert.ok(Array.isArray(card.openQuestions), "openQuestions 必须是数组");
      assert.ok(card.what.trim(), "what 不能为空");
      assert.ok(card.why.trim(), "why 不能为空");
      assert.ok(card.tradeoff.trim(), "tradeoff 不能为空");
      assert.ok(card.nextAction.trim(), "nextAction 不能为空");
      assert.notEqual(handoff.from, handoff.to, "交接双方不能是同一只猫");
    }

    // 先把设计和实现两张卡发出去，才有后面的评审链。
    const targets = new Set(handoffs.map((handoff) => handoff.to));
    assert.ok(targets.has("zhoushuo"), "应有一张给周烁的设计交接卡");
    assert.ok(targets.has("chenshi"), "应有一张给陈实的实现交接卡");
  });

  test("review 打回后产生了 v2 patch", () => {
    const messages = state.messages.filter(
      (message: Message) => message.taskId === taskId,
    );
    const reviewArtifacts = state.artifacts.filter(
      (artifact: Artifact) =>
        artifact.taskId === taskId && artifact.kind === "review",
    );
    const reviewTraces = [
      ...messages.filter((message) => message.kind === "review").map((m) => m.text),
      ...reviewArtifacts.map((artifact) => `${artifact.title}\n${artifact.body}`),
    ];
    assert.ok(reviewTraces.length > 0, "应有 review 记录（message.kind=review + review artifact）");
    const requestedChanges = reviewTraces.some((text) =>
      /request_changes|打回|要求修改|blocker|需要修改/i.test(text),
    );
    assert.ok(requestedChanges, `review 应打回过一次，实际记录：\n${reviewTraces.join("\n---\n")}`);
    assert.ok(
      reviewArtifacts.some((artifact) => /verdict:\s*approve/.test(artifact.body)),
      "打回改完后应有一次 approve",
    );

    const patches = state.artifacts.filter(
      (artifact: Artifact) => artifact.taskId === taskId && artifact.kind === "patch",
    );
    assert.ok(patches.length >= 1, "实现稿应产出 patch");
    assert.ok(
      patches.some((patch) => patch.version >= 2),
      `打回后应出现 v2 patch，实际版本：${patches.map((p) => p.version).join(",")}`,
    );
    // patch 作者是实现猫，review 作者是 reviewer（跨猫互审）。
    assert.ok(
      patches.every((patch) => patch.author === "chenshi"),
      "实现稿应由陈实产出",
    );
    assert.ok(
      reviewArtifacts.every((artifact) => artifact.author === "shenyan"),
      "review 应由沈砚产出",
    );
  });

  test("memory 里有本任务的 decision 和 lesson", () => {
    const taskMemory = state.memory.filter(
      (entry: MemoryEntry) => entry.sourceTaskId === taskId,
    );
    const decisions = taskMemory.filter((entry) => entry.kind === "decision");
    assert.ok(
      decisions.length >= 1,
      `应有 decision 记忆，实际 memory：${JSON.stringify(state.memory)}`,
    );
    assert.ok(decisions[0]?.title.trim(), "decision 应有标题");
    assert.ok(decisions[0]?.body.trim(), "decision 应有正文");
    assert.ok(
      taskMemory.some((entry) => entry.kind === "lesson"),
      "review 发现的问题应沉淀成 lesson",
    );
  });

  test("SSE /api/events 能连上并先推全量快照", async () => {
    const event = await readFirstSseEvent(base);
    assert.equal(event.seq, event.state.seq);
    assert.ok(event.state.tasks.length >= 1);
    assert.equal(event.state.mode, "mock");
  });

  test("任务状态落盘到临时 dataDir", async () => {
    const file = join(dataDir, "studio.json");
    await waitForFile(file);
    const persisted = JSON.parse(readFileSync(file, "utf8")) as StudioState;
    const task = persisted.tasks.find((candidate) => candidate.id === taskId);
    assert.ok(task, "dataDir/studio.json 里应有任务");
    assert.equal(task?.status, "done");
    assert.ok(persisted.memory.length >= 1);
    assert.ok(persisted.handoffs.length >= 1);
  });
});

describe("集成 · 模型不可用时任务暂停", () => {
  let dataDir: string;
  let studio: Studio;
  let driver: Driver;
  let server: ReturnType<typeof createHttpServer>;
  let base: string;
  let taskId: string;
  let state: StudioState;
  let warnLines: string[] = [];
  let originalWarn: typeof console.warn | null = null;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "deliverylab-e2e-llm-"));
    studio = new Studio({ cats: CATS, mode: "llm", dataDir });

    // 断头端点：真实模式每次调用都会失败。新语义下不再退回演出台词，
    // 而是暂停任务、把决定权交回负责人。
    const llm = createLlmBrain(
      {
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "sk-integration-secret-key",
        model: "dead-model",
        temperature: 0.7,
      },
      createMockBrain(SCENARIOS),
      { timeoutMs: 800 },
    );

    driver = createDriver({ studio, brain: llm, wait: async () => {}, stallMs: 300 });
    server = createHttpServer({
      studio,
      driver,
      publicDir: resolve(import.meta.dirname, "../public"),
      scenarios: SCENARIOS,
      mode: "llm",
    });
    await new Promise<void>((resolveListen) =>
      server.listen(0, "127.0.0.1", () => resolveListen()),
    );
    const address = server.address();
    assert.ok(address && typeof address === "object");
    base = `http://127.0.0.1:${address.port}`;

    // 收集失败日志，最后统一断言（避免刷屏）。
    originalWarn = console.warn;
    warnLines = [];
    console.warn = (...args: unknown[]) => {
      warnLines.push(args.map((arg) => String(arg)).join(" "));
    };

    const res = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "room_cafe", brief: BRIEF }),
    });
    assert.equal(res.status, 201);
    taskId = ((await res.json()) as Task).id;
    state = await waitForTaskStatus(base, taskId, "stalled");
  });

  after(async () => {
    if (originalWarn) console.warn = originalWarn;
    await driver.whenIdle().catch(() => {});
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    studio.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("模型不可用时任务暂停，并给出失败原因", () => {
    const task = findTask(state, taskId);
    assert.equal(task.status, "stalled", "模型失败必须暂停任务，不能假装跑完");
    assert.notEqual(task.stage, "done", "暂停的任务不应被标记为完成");

    const failMessage = state.messages.find(
      (message) =>
        message.taskId === taskId &&
        message.author === "system" &&
        /模型调用失败/.test(message.text),
    );
    assert.ok(failMessage, "应留下一条「模型调用失败」的系统消息");
    assert.match(failMessage?.text ?? "", /任务已暂停/);
    assert.match(failMessage?.text ?? "", /网络错误|超时/, "系统消息应带可读的失败原因");

    // 不再退回演出台词：没有交接、产物、决策被伪造出来。
    assert.equal(state.handoffs.length, 0, "失败后不应继续自动交接");
    assert.equal(state.artifacts.length, 0, "失败后不应伪造产物");
    assert.equal(
      state.memory.filter((entry) => entry.sourceTaskId === taskId).length,
      0,
      "失败后不应写共享记忆",
    );
    assert.ok(
      (task.health?.degradedCount ?? 0) >= 1,
      `失败应汇总到任务健康度，实际 health=${JSON.stringify(task.health)}`,
    );
    assert.ok(task.health?.lastDegradeReason, "健康度应记录最近失败原因");
  });

  test("失败日志说明原因且不泄露 apiKey", () => {
    const llmWarns = warnLines.filter((line) => line.includes("[llm-brain]"));
    assert.ok(llmWarns.length >= 1, `应有失败日志，实际：${warnLines.join("\n")}`);
    for (const line of llmWarns) {
      assert.match(line, /任务将暂停/, `日志格式应说明后果：${line}`);
      assert.ok(
        !line.includes("sk-integration-secret-key"),
        `日志里绝不能出现 apiKey：${line}`,
      );
    }
  });

  test("/api/health 报告 mode=llm（未接 settingsApi 时视为已配置）", async () => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      mode: string;
      configured: boolean;
      settings: boolean;
    };
    assert.equal(body.mode, "llm");
    assert.equal(body.configured, true);
    assert.equal(body.settings, false);
  });

  test("暂停后可以「继续」；模型仍不可用时会再次暂停并追加原因", async () => {
    const beforeState = await getState(base);
    const beforeCount = beforeState.messages.filter(
      (message) =>
        message.taskId === taskId &&
        message.author === "system" &&
        /模型调用失败/.test(message.text),
    ).length;

    const res = await fetch(`${base}/api/tasks/${taskId}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "continue" }),
    });
    assert.equal(res.status, 202, "暂停的任务应接受「继续」恢复动作");

    await driver.whenIdle();
    const afterState = await waitForModelFailureMessages(base, taskId, beforeCount + 1);
    const task = findTask(afterState, taskId);
    assert.equal(task.status, "stalled", "恢复后再次失败应再次暂停");
    assert.ok(
      (task.health?.degradedCount ?? 0) > (findTask(beforeState, taskId).health?.degradedCount ?? 0),
      "恢复后的失败也要累计到健康度",
    );
  });
});
