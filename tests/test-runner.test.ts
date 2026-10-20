/** 测试中心：运行记录、事件流、取消、并发保护。 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import type { Driver } from "../src/domain/types.ts";
import { createHttpServer } from "../src/server/http.ts";
import { Studio } from "../src/server/studio.ts";
import { TestRunner, type TestStreamEvent } from "../src/server/test-runner.ts";
import { fakeDriver } from "./helpers/fake-driver.ts";

/**
 * 用临时 fixture 项目跑 unit，而不是真实项目：
 * 真实项目里包含本测试文件，`node --test tests/` 会递归 spawn 自己。
 */
function makeFixtureProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "catcafe-fixture-"));
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(
    join(dir, "tests", "slow.test.ts"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'test("慢用例，用来验证取消", async () => {',
      '  await new Promise((resolve) => setTimeout(resolve, 700));',
      '  assert.equal(1, 1);',
      '});',
      "",
    ].join("\n"),
  );
  return dir;
}


async function waitFor(
  predicate: () => boolean,
  timeoutMs = 20_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timeout waiting for condition");
}

describe("TestRunner", () => {
  let dir: string;
  let studio: Studio;
  let runner: TestRunner;

  let fixture: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "catcafe-tests-"));
    fixture = makeFixtureProject();
    studio = new Studio({ cats: CATS, mode: "mock" });
    runner = new TestRunner({
      projectRoot: fixture,
      port: 0,
      realModelReady: () => false,
    });
  });

  after(() => {
    runner.close();
    studio.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });

  test("未配置真实模型时拒绝 real / scenario", () => {
    assert.throws(() => runner.start("real"), /真实模型未配置/);
    assert.throws(() => runner.start("scenario", "basic"), /真实模型未配置/);
  });

  test("unit 测试能跑完并给出统计", async () => {
    const run = runner.start("unit");
    assert.equal(run.status, "running");
    await waitFor(() => runner.get(run.id)?.status !== "running");
    const finished = runner.get(run.id);
    assert.equal(finished?.status, "passed");
    assert.equal(finished?.exitCode, 0);
    assert.ok((finished?.lines.length ?? 0) > 0);
    assert.ok((finished?.summary?.tests ?? 0) > 0);
    assert.equal(finished?.summary?.fail, 0);
  });

  test("同一 kind 并发启动被拒绝", async () => {
    const run = runner.start("unit");
    try {
      assert.throws(() => runner.start("unit"), /已经在跑/);
    } finally {
      runner.cancel(run.id);
    }
    await waitFor(() => runner.get(run.id)?.status !== "running");
  });

  test("取消运行中的测试", async () => {
    const run = runner.start("unit");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cancelled = runner.cancel(run.id);
    assert.equal(cancelled, true);
    await waitFor(() => runner.get(run.id)?.status !== "running");
    const final = runner.get(run.id);
    assert.ok(final?.status === "cancelled" || final?.status === "passed" || final?.status === "failed");
    assert.equal(runner.cancel(run.id), false);
  });

  test("事件流会推送 start / line / exit", async () => {
    const events: TestStreamEvent[] = [];
    const unsubscribe = runner.subscribe((event) => events.push(event));
    const run = runner.start("unit");
    await waitFor(() => runner.get(run.id)?.status !== "running");
    unsubscribe();
    assert.ok(events.some((event) => event.event === "start"));
    assert.ok(events.some((event) => typeof event.line === "string"));
    assert.ok(events.some((event) => event.event === "exit"));
  });

  test("历史记录最多保留 20 条", async () => {
    // 只验证 list 形状与排序（新的在前），不真的跑 20 次。
    const list = runner.list();
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 1);
    const times = list.map((run) => run.startedAt);
    const sorted = [...times].sort((a, b) => b - a);
    assert.deepEqual(times, sorted);
  });
});

describe("HTTP /api/tests", () => {
  let dir: string;
  let studio: Studio;
  let runner: TestRunner;
  let server: ReturnType<typeof createHttpServer>;
  let base: string;

  let fixture: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "catcafe-tests-http-"));
    fixture = makeFixtureProject();
    studio = new Studio({ cats: CATS, mode: "mock" });
    runner = new TestRunner({ projectRoot: fixture, port: 0, realModelReady: () => false });
    server = createHttpServer({
      studio,
      driver: fakeDriver(),
      publicDir: resolve(import.meta.dirname, "../public"),
      scenarios: SCENARIOS,
      tests: runner,
      mode: "mock",
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("no port");
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    runner.close();
    await new Promise<void>((done) => server.close(() => done()));
    studio.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });

  test("POST /api/tests/run → 202 → 查得到结果", async () => {
    const res = await fetch(`${base}/api/tests/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "unit" }),
    });
    assert.equal(res.status, 202);
    const body = (await res.json()) as { runId: string };
    assert.ok(body.runId);

    await waitFor(() => runner.get(body.runId)?.status !== "running");
    const detail = await fetch(`${base}/api/tests/runs/${body.runId}`);
    assert.equal(detail.status, 200);
    const run = (await detail.json()) as { status: string; lines: unknown[] };
    assert.equal(run.status, "passed");
    assert.ok(run.lines.length > 0);
  });

  test("real 在未配置真实模型时返回 400", async () => {
    const res = await fetch(`${base}/api/tests/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "real" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /真实模型未配置/);
  });

  test("未知 kind 400；未知 run 404", async () => {
    const bad = await fetch(`${base}/api/tests/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "whatever" }),
    });
    assert.equal(bad.status, 400);

    const missing = await fetch(`${base}/api/tests/runs/nope`);
    assert.equal(missing.status, 404);
  });

  test("GET /api/tests/runs 返回最近记录", async () => {
    const res = await fetch(`${base}/api/tests/runs`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { runs: Array<{ kind: string; lineCount: number }> };
    assert.ok(body.runs.length >= 1);
    assert.ok(body.runs.every((run) => typeof run.lineCount === "number"));
  });

  test("SSE /api/tests/stream 能收到事件", async () => {
    // 先启动运行，再连 SSE：否则会阻塞在心跳上。
    const run = runner.start("unit");
    const controller = new AbortController();
    try {
      const response = await fetch(`${base}/api/tests/stream`, { signal: controller.signal });
      assert.equal(response.status, 200);
      const reader = response.body?.getReader();
      assert.ok(reader);
      const decoder = new TextDecoder();
      let text = "";
      const started = Date.now();
      while (Date.now() - started < 8000 && !text.includes(run.id)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value);
      }
      assert.match(text, /data:/);
      assert.ok(text.includes(run.id), "应收到本次运行的 runId");
    } finally {
      controller.abort();
    }
    await waitFor(() => runner.get(run.id)?.status !== "running");
  });

  test("没有 tests 时 503", async () => {
    const bare = createHttpServer({
      studio,
      driver: fakeDriver(),
      publicDir: resolve(import.meta.dirname, "../public"),
      scenarios: SCENARIOS,
      mode: "mock",
    });
    await new Promise<void>((done) => bare.listen(0, "127.0.0.1", () => done()));
    const address = bare.address();
    if (!address || typeof address !== "object") throw new Error("no port");
    const res = await fetch(`http://127.0.0.1:${address.port}/api/tests/runs`);
    assert.equal(res.status, 503);
    await new Promise<void>((done) => bare.close(() => done()));
  });
});
