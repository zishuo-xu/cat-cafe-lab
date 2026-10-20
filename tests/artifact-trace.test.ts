/**
 * 产物溯源：每条产物都要能回答「我是哪次模型调用、在哪个阶段写出来的」。
 *
 * 背景：任务轨迹能回答「时间花在哪」，但反过来「这个 patch 出自第几次调用、
 * 当时在评审哪条 blocker」以前答不出来 —— 产物与调用之间没有连线，
 * 可追溯性只做了半件。
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { createMockBrain } from "../src/agents/mock-brain.ts";
import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import type { Artifact, Driver, LlmCall, Task } from "../src/domain/types.ts";
import { createDriver } from "../src/engine/driver.ts";
import { createHttpServer } from "../src/server/http.ts";
import { Studio } from "../src/server/studio.ts";
import { fakeDriver } from "./helpers/fake-driver.ts";

interface TraceEntry {
  at: number;
  kind: string;
  detail: string;
  meta?: Record<string, unknown>;
}

interface TraceResponse {
  task: Task;
  entries: TraceEntry[];
  summary: Record<string, number>;
}

describe("产物溯源", () => {
  let studio: Studio;
  let driver: Driver;
  let server: ReturnType<typeof createHttpServer>;
  let base: string;
  let taskId: string;

  before(async () => {
    studio = new Studio({ cats: CATS.map((cat) => ({ ...cat })), mode: "mock" });
    driver = createDriver({
      studio,
      brain: createMockBrain(SCENARIOS),
      wait: async () => {},
      stallMs: 5_000,
    });
    server = createHttpServer({
      studio,
      driver,
      scenarios: SCENARIOS,
      mode: "mock",
      publicDir: resolve(import.meta.dirname, "../public"),
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("no port");
    base = `http://127.0.0.1:${address.port}`;

    const created = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "room_cafe", brief: "导出 CSV 加 UTF-8 BOM", scenarioId: "export_csv" }),
    });
    assert.equal(created.status, 201);
    taskId = ((await created.json()) as Task).id;

    // 内置剧本埋了「交接漏 @」，最多催几次跑到收尾。
    for (let round = 0; round < 6; round += 1) {
      await driver.whenIdle();
      const current = studio.getTask(taskId);
      if (!current || current.status === "done") break;
      driver.submit({ type: "nudge", taskId });
    }
  });

  after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    studio.close();
  });

  function artifactsOfTask(): Artifact[] {
    return studio.state.artifacts.filter((artifact) => artifact.taskId === taskId);
  }

  test("任务跑完后每条产物都带 trace（阶段 + 模型调用 id）", () => {
    const artifacts = artifactsOfTask();
    assert.ok(artifacts.length > 0, "应有产物");
    for (const artifact of artifacts) {
      assert.ok(artifact.trace, `产物「${artifact.title}」缺少 trace`);
      assert.ok(artifact.trace?.stage, "trace 应记录阶段");
    }
  });

  test("trace.llmCallId 指向真实存在、且属于同一任务的模型调用", () => {
    const calls = new Map<string, LlmCall>(
      studio.state.llmCalls.filter((call) => call.taskId === taskId).map((call) => [call.id, call]),
    );
    let linked = 0;
    for (const artifact of artifactsOfTask()) {
      const callId = artifact.trace?.llmCallId;
      if (!callId) continue;
      linked += 1;
      const call = calls.get(callId);
      assert.ok(call, `产物「${artifact.title}」指向的调用 ${callId} 不存在`);
      assert.equal(call?.taskId, taskId, "不该链到别的任务的调用");
    }
    assert.ok(linked > 0, "至少一部分产物应链到模型调用");
  });

  test("产物的阶段与它产生时所处的阶段一致", () => {
    const artifacts = artifactsOfTask();
    const review = artifacts.find((artifact) => artifact.kind === "review");
    assert.ok(review, "应有 review 产物");
    assert.equal(review?.trace?.stage, "reviewing", "review 产物应记录在 reviewing 阶段");

    const decision = artifacts.find((artifact) => artifact.kind === "decision");
    assert.ok(decision, "应有 decision 产物");
    assert.equal(decision?.trace?.stage, "done", "收尾决策应记录在 done 阶段");
  });

  test("轨迹接口把产物和模型调用连起来（meta 可互相定位）", async () => {
    const res = await fetch(`${base}/api/tasks/${taskId}/trace`);
    assert.equal(res.status, 200);
    const trace = (await res.json()) as TraceResponse;

    const llmEntries = trace.entries.filter((entry) => entry.kind === "llm");
    const artifactEntries = trace.entries.filter((entry) => entry.kind === "artifact");
    assert.ok(llmEntries.length > 0, "轨迹里应有模型调用");
    assert.ok(artifactEntries.length > 0, "轨迹里应有产物");

    // 每次模型调用都有 id，前端才能定位/高亮。
    for (const entry of llmEntries) {
      assert.equal(typeof entry.meta?.id, "string", "llm 条目应带 call id");
    }
    const llmIds = new Set(llmEntries.map((entry) => String(entry.meta?.id)));

    // 产物条目上的 llmCallId 必须能在同一条轨迹里找到。
    let linkedArtifacts = 0;
    for (const entry of artifactEntries) {
      const llmCallId = entry.meta?.llmCallId;
      if (typeof llmCallId !== "string") continue;
      linkedArtifacts += 1;
      assert.ok(llmIds.has(llmCallId), `产物指向的调用 ${llmCallId} 不在轨迹里`);
      assert.equal(typeof entry.meta?.artifactId, "string", "产物条目应带 artifactId");
    }
    assert.ok(linkedArtifacts > 0, "轨迹里至少应有一条产物能链到调用");
  });

  test("摘要里的产物数量与产物列表一致", async () => {
    const res = await fetch(`${base}/api/tasks/${taskId}/trace`);
    const trace = (await res.json()) as TraceResponse;
    assert.equal(trace.summary.artifacts, artifactsOfTask().length);
  });
});
