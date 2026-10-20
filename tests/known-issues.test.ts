/**
 * 已知问题回归：几个「不报错但结果不可信 / 不好用」的坑。
 *
 * 1. 需求没命中剧本时，以前静默用第一个剧本演出，还把它自带的决策写进共享记忆；
 * 2. 创建房间漏传 workspaceId，报「不存在」而不是「必填」；
 * 3. SSE 每个 notify 都推全量快照，长任务把带宽和渲染打满；
 * 4. 提交时 `git add -A` 会把模型写出的 .env / 私钥带进 git 历史。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { createMockBrain } from "../src/agents/mock-brain.ts";
import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import type { AgentBrain, Driver, StudioState, Task } from "../src/domain/types.ts";
import { createDriver } from "../src/engine/driver.ts";
import { createHttpServer } from "../src/server/http.ts";
import { Studio } from "../src/server/studio.ts";
import { WorkspaceManager } from "../src/workspaces/manager.ts";
import { fakeDriver } from "./helpers/fake-driver.ts";

const UNMATCHED_BRIEF = "帮我优化一下首页加载速度";
const MATCHED_BRIEF = "给登录页加一个记住我勾选框，7天内免登录";

function makeStudio(dataDir?: string): Studio {
  return new Studio({ cats: CATS.map((cat) => ({ ...cat })), mode: "mock", ...(dataDir ? { dataDir } : {}) });
}

function makeRealDriver(studio: Studio): Driver {
  return createDriver({
    studio,
    brain: createMockBrain(SCENARIOS),
    wait: async () => {},
    stallMs: 5_000,
  });
}

interface Harness {
  studio: Studio;
  driver: Driver;
  server: ReturnType<typeof createHttpServer>;
  base: string;
  close: () => Promise<void>;
}

async function startHarness(options: { workspaces?: WorkspaceManager } = {}): Promise<Harness> {
  const studio = makeStudio();
  const driver = makeRealDriver(studio);
  const server = createHttpServer({
    studio,
    driver,
    scenarios: SCENARIOS,
    mode: "mock",
    publicDir: resolve(import.meta.dirname, "../public"),
    ...(options.workspaces ? { workspaces: options.workspaces } : {}),
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    studio,
    driver,
    server,
    base,
    close: async () => {
      await driver.whenIdle().catch(() => {});
      await new Promise<void>((done) => server.close(() => done()));
      studio.close();
    },
  };
}

/**
 * 把任务跑到 done。内置剧本里埋了「交接漏 @」，会故意停在 working 等负责人催；
 * 这里模拟负责人点「催一下」，直到任务推进完。
 */
async function runTaskToDone(harness: Harness, taskId: string): Promise<Task> {
  for (let round = 0; round < 6; round += 1) {
    await harness.driver.whenIdle();
    const task = harness.studio.getTask(taskId);
    if (!task) throw new Error(`任务不见了：${taskId}`);
    if (task.status === "done") return task;
    harness.driver.submit({ type: "nudge", taskId });
  }
  const task = harness.studio.getTask(taskId);
  throw new Error(`任务没跑完：stage=${task?.stage} status=${task?.status}`);
}

async function postTask(base: string, body: Record<string, unknown>): Promise<Task> {
  const res = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 201, `创建任务应 201，实际 ${res.status}`);
  return (await res.json()) as Task;
}

describe("已知问题 · 剧本只作示例素材（零分回落已废弃）", () => {
  /** 字段已从 Task 删除；用属性存在性断言旧行为确实不存在了。 */
  function scenarioFallbackOf(task: Task): unknown {
    return (task as unknown as Record<string, unknown>)["scenarioFallback"];
  }

  test("需求没命中剧本时不再标记 scenarioFallback，也不发「近似演出」系统说明", async () => {
    const harness = await startHarness();
    try {
      const task = await postTask(harness.base, {
        roomId: "room_cafe",
        brief: UNMATCHED_BRIEF,
      });
      // 只有真实模式：剧本只是示例素材，不再有「没命中就近似演出」的概念。
      assert.equal(scenarioFallbackOf(task), undefined, "不应再标记 scenarioFallback");
      assert.ok(
        typeof task.scenarioId === "string" && task.scenarioId.length > 0,
        "仍应记录一个示例剧本 id 供历史展示",
      );

      const fallbackNote = harness.studio.state.messages.find(
        (message) =>
          message.taskId === task.id &&
          message.author === "system" &&
          /演示剧本|近似演出/.test(message.text),
      );
      assert.equal(fallbackNote, undefined, "不应再留「近似演出」系统消息");
    } finally {
      await harness.close();
    }
  });

  test("命中剧本时同样不会标记 fallback", async () => {
    const harness = await startHarness();
    try {
      const task = await postTask(harness.base, { roomId: "room_cafe", brief: MATCHED_BRIEF });
      assert.equal(scenarioFallbackOf(task), undefined, "不应有 fallback 标记");
    } finally {
      await harness.close();
    }
  });

  test("显式指定剧本时 scenarioId 以用户为准（需求匹配不上也一样）", async () => {
    const harness = await startHarness();
    try {
      const task = await postTask(harness.base, {
        roomId: "room_cafe",
        brief: UNMATCHED_BRIEF,
        scenarioId: "export_csv",
      });
      assert.equal(scenarioFallbackOf(task), undefined, "不应有 fallback 标记");
      assert.equal(task.scenarioId, "export_csv");
    } finally {
      await harness.close();
    }
  });

  test("没命中剧本的任务按普通任务写记忆，不再留 fallback-scenario 教训", async () => {
    const harness = await startHarness();
    try {
      const task = await postTask(harness.base, { roomId: "room_cafe", brief: UNMATCHED_BRIEF });
      await runTaskToDone(harness, task.id);

      const entries = harness.studio.state.memory.filter(
        (entry) => entry.sourceTaskId === task.id,
      );
      const fallbackLessons = entries.filter((entry) =>
        entry.tags.includes("fallback-scenario"),
      );
      assert.equal(
        fallbackLessons.length,
        0,
        `不再有「近似演出」专用教训，实际：${JSON.stringify(fallbackLessons.map((entry) => entry.title))}`,
      );
      const decisions = entries.filter((entry) => entry.kind === "decision");
      assert.ok(
        decisions.length >= 1,
        `剧本只是素材，任务仍应按正常交付写决策记忆，实际：${JSON.stringify(entries.map((entry) => entry.title))}`,
      );
    } finally {
      await harness.close();
    }
  });

  test("正常命中的剧本仍然写决策记忆（没有误伤）", async () => {
    const harness = await startHarness();
    try {
      const task = await postTask(harness.base, { roomId: "room_cafe", brief: MATCHED_BRIEF });
      await runTaskToDone(harness, task.id);
      const decisions = harness.studio.state.memory.filter(
        (entry) => entry.sourceTaskId === task.id && entry.kind === "decision",
      );
      assert.ok(decisions.length >= 1, "命中剧本的任务应正常写决策");
    } finally {
      await harness.close();
    }
  });
});

describe("已知问题 · 创建房间的错误文案", () => {
  let manager: WorkspaceManager;
  let dataDir: string;
  let harness: Harness;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "deliverylab-known-ws-"));
    manager = new WorkspaceManager(dataDir);
    harness = await startHarness({ workspaces: manager });
  });

  after(async () => {
    await harness.close();
    manager.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("漏传 workspaceId 时提示「必填」而不是「不存在」", async () => {
    const res = await fetch(`${harness.base}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "新房间" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /必填/);
    assert.doesNotMatch(body.error, /不存在/);
  });

  test("传了但查不到时提示「不存在」并带上 id", async () => {
    const res = await fetch(`${harness.base}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "新房间", workspaceId: "ws_不存在" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /不存在：ws_不存在/);
  });
});

describe("已知问题 · SSE 合并推送", () => {
  test("连续多次状态变更不会一变更一帧全量快照", async () => {
    const studio = makeStudio();
    const server = createHttpServer({
      studio,
      driver: fakeDriver(),
      scenarios: SCENARIOS,
      mode: "mock",
      publicDir: resolve(import.meta.dirname, "../public"),
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("no port");
    const base = `http://127.0.0.1:${address.port}`;

    const controller = new AbortController();
    try {
      const res = await fetch(`${base}/api/events`, { signal: controller.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // 先读掉连接时的首帧全量快照。
      await readFramesUntil(reader, decoder, () => buffer, (count) => count >= 1, (text) => {
        buffer = text;
      });

      // 制造 30 次状态变更；合并窗口 120ms，预期只收到个位数帧。
      for (let i = 0; i < 30; i += 1) {
        studio.addMemory({
          kind: "lesson",
          title: `压测记忆 ${i}`,
          body: "合并推送测试",
          tags: ["sse-test"],
        });
      }
      const frames = await collectFrames(reader, decoder, 400);
      const count = frames.length;
      assert.ok(
        count < 30,
        `30 次变更不该推 30 帧（合并后应明显更少），实际 ${count} 帧`,
      );
      assert.ok(count >= 1, "至少要推一帧最新状态");
      const last = frames[frames.length - 1];
      assert.equal(
        last?.state.memory.filter((entry) => entry.tags.includes("sse-test")).length,
        30,
        "最后一帧应该是最新状态（包含全部 30 条）",
      );
    } finally {
      controller.abort();
      await new Promise<void>((done) => server.close(() => done()));
      studio.close();
    }
  });
});

type TextDecoderLike = { decode: (input?: Uint8Array, options?: { stream?: boolean }) => string };

async function readFramesUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoderLike,
  getBuffer: () => string,
  done: (count: number) => boolean,
  setBuffer: (text: string) => void,
): Promise<void> {
  let count = 0;
  let buffer = getBuffer();
  while (!done(count)) {
    const { value, done: closed } = await reader.read();
    if (closed) return;
    buffer += decoder.decode(value, { stream: true });
    const matches = buffer.match(/data: [^\n]+\n\n/g) ?? [];
    if (matches.length) {
      count += matches.length;
      buffer = buffer.replace(/data: [^\n]+\n\n/g, "");
    }
    setBuffer(buffer);
  }
}

async function collectFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoderLike,
  windowMs: number,
): Promise<Array<{ seq: number; state: StudioState }>> {
  const frames: Array<{ seq: number; state: StudioState }> = [];
  let buffer = "";
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const timeout = new Promise<"timeout">((resolveTimeout) =>
      setTimeout(() => resolveTimeout("timeout"), Math.max(1, remaining)),
    );
    const next = await Promise.race([reader.read(), timeout]);
    if (next === "timeout") break;
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const matches = buffer.match(/data: ([^\n]+)\n\n/g) ?? [];
    for (const match of matches) {
      frames.push(JSON.parse(match.slice(6).trimEnd()) as { seq: number; state: StudioState });
    }
    buffer = buffer.replace(/data: ([^\n]+)\n\n/g, "");
  }
  return frames;
}

describe("已知问题 · 提交时挡住敏感文件", () => {
  let repoDir: string;
  let dataDir: string;
  let manager: WorkspaceManager;

  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), "deliverylab-known-git-data-"));
    repoDir = mkdtempSync(join(tmpdir(), "deliverylab-known-git-repo-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "cat@example.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Member Café"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# demo\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });
    manager = new WorkspaceManager(dataDir);
  });

  after(() => {
    manager.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  test(".env 与私钥不会被带进提交，但正常文件照常提交", async () => {
    const workspace = manager.add({ name: "Known Issues Repo", path: repoDir, policy: "read-write" });
    assert.equal(workspace.policy, "read-write");
    const workspaceId = workspace.id;

    const branch = await manager.createTaskBranch(workspaceId, "task_known_issues");
    assert.ok(branch.branch, `建分支失败：${branch.error ?? ""}`);

    // 模拟模型顺手写文件：正常代码 + 一个 .env + 一个私钥。
    writeFileSync(join(repoDir, "feature.js"), "export const ok = true;\n", "utf8");
    writeFileSync(join(repoDir, ".env"), "API_KEY=sk-secret\n", "utf8");
    writeFileSync(join(repoDir, "id_rsa"), "-----BEGIN PRIVATE KEY-----\n", "utf8");

    const result = await manager.commitTask(
      workspaceId,
      { branch: branch.branch, baseBranch: branch.baseBranch },
      "feat: 加个 feature",
    );
    assert.equal(result.ok, true, `提交应成功：${result.error ?? ""}`);

    assert.ok(result.commit, "应返回提交 hash");
    const committed = execFileSync("git", ["show", "--name-only", "--format=", result.commit], {
      cwd: repoDir,
      encoding: "utf8",
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    assert.ok(committed.includes("feature.js"), `正常文件应被提交，实际：${committed.join(", ")}`);
    assert.ok(!committed.includes(".env"), "`.env` 不该进提交");
    assert.ok(!committed.includes("id_rsa"), "私钥不该进提交");
    assert.deepEqual(result.skipped?.sort(), [".env", "id_rsa"], "应报告被挡下的文件");
  });
});
