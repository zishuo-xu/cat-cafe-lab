/** 铲屎官审批：队列语义 + HTTP approve/reject 契约。 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import type { Driver } from "../src/domain/types.ts";
import { createHttpServer } from "../src/server/http.ts";
import { Studio } from "../src/server/studio.ts";
import { ApprovalQueue } from "../src/tools/approval.ts";
import { fakeDriver } from "./helpers/fake-driver.ts";


describe("ApprovalQueue", () => {
  test("request 悬挂，resolve 后拿到决定", async () => {
    const queue = new ApprovalQueue();
    const pending = queue.request({
      callId: "call_1",
      mode: "commands",
      tool: "run_command",
      label: "运行 node --test",
      catId: "jinjianceng",
    });
    assert.equal(queue.list().length, 1);
    assert.equal(queue.list()[0]?.callId, "call_1");

    assert.equal(queue.resolve("call_1", "approved"), true);
    assert.equal(await pending, "approved");
    assert.equal(queue.list().length, 0);
    assert.equal(queue.resolve("call_1", "rejected"), false);
  });

  test("rejectAll 把所有悬挂审批按拒绝收口", async () => {
    const queue = new ApprovalQueue();
    const a = queue.request({ callId: "a", mode: "all", tool: "write_file", label: "写", catId: "xianxian" });
    const b = queue.request({ callId: "b", mode: "commands", tool: "run_command", label: "跑", catId: "yanyan" });
    queue.rejectAll();
    assert.deepEqual(await Promise.all([a, b]), ["rejected", "rejected"]);
    assert.equal(queue.list().length, 0);
  });
});

describe("HTTP /api/tool-calls", () => {
  let dir: string;
  let studio: Studio;
  let queue: ApprovalQueue;
  let server: ReturnType<typeof createHttpServer>;
  let bare: ReturnType<typeof createHttpServer>;
  let base: string;
  let bareBase: string;

  async function listen(target: ReturnType<typeof createHttpServer>): Promise<string> {
    await new Promise<void>((done) => target.listen(0, "127.0.0.1", () => done()));
    const address = target.address();
    if (!address || typeof address !== "object") throw new Error("no port");
    return `http://127.0.0.1:${address.port}`;
  }

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "catcafe-approvals-"));
    studio = new Studio({ cats: CATS, mode: "llm" });
    queue = new ApprovalQueue();
    server = createHttpServer({
      studio,
      driver: fakeDriver(),
      publicDir: resolve(import.meta.dirname, "../public"),
      scenarios: SCENARIOS,
      approvals: queue,
      mode: "llm",
    });
    bare = createHttpServer({
      studio,
      driver: fakeDriver(),
      publicDir: resolve(import.meta.dirname, "../public"),
      scenarios: SCENARIOS,
      mode: "llm",
    });
    base = await listen(server);
    bareBase = await listen(bare);
  });

  after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await new Promise<void>((done) => bare.close(() => done()));
    studio.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("approve 会 resolve 悬挂的请求", async () => {
    const pending = queue.request({
      callId: "call_http",
      mode: "commands",
      tool: "run_command",
      label: "跑测试",
      catId: "jinjianceng",
    });
    const res = await fetch(`${base}/api/tool-calls/call_http/approve`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { decision: string };
    assert.equal(body.decision, "approved");
    assert.equal(await pending, "approved");
  });

  test("reject 同理；重复处理返回 404", async () => {
    const pending = queue.request({
      callId: "call_reject",
      mode: "all",
      tool: "write_file",
      label: "写文件",
      catId: "xianxian",
    });
    const res = await fetch(`${base}/api/tool-calls/call_reject/reject`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(await pending, "rejected");

    const again = await fetch(`${base}/api/tool-calls/call_reject/reject`, { method: "POST" });
    assert.equal(again.status, 404);
  });

  test("GET /api/approvals 列出等待中的审批", async () => {
    void queue.request({
      callId: "call_list",
      mode: "commands",
      tool: "run_command",
      label: "跑测试",
      catId: "yanyan",
    });
    const res = await fetch(`${base}/api/approvals`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pending: Array<{ callId: string }> };
    assert.ok(body.pending.some((item) => item.callId === "call_list"));
    queue.resolve("call_list", "rejected");
  });

  test("approve 带 remember=true 会记住选择", async () => {
    const first = queue.request({
      callId: "call_remember",
      mode: "commands",
      tool: "run_command",
      label: "跑测试",
      catId: "jinjianceng",
    });
    const res = await fetch(`${base}/api/tool-calls/call_remember/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remember: true }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { remembered: boolean };
    assert.equal(body.remembered, true);
    assert.equal(await first, "approved");

    // 下一次同猫同工具直接放行，不会出现在 pending 列表。
    const next = queue.request({
      callId: "call_remember_2",
      mode: "commands",
      tool: "run_command",
      label: "再跑",
      catId: "jinjianceng",
    });
    assert.equal(await next, "approved");
    const list = await fetch(`${base}/api/approvals`);
    const pending = (await list.json()) as { pending: Array<{ callId: string }> };
    assert.ok(!pending.pending.some((item) => item.callId === "call_remember_2"));
    queue.clearRemembered();
  });

  test("没有审批队列时 503", async () => {
    const res = await fetch(`${bareBase}/api/tool-calls/x/approve`, { method: "POST" });
    assert.equal(res.status, 503);
    const list = await fetch(`${bareBase}/api/approvals`);
    assert.equal(list.status, 503);
  });
});


describe("审批记忆与超时", () => {
  test("remember 后同类审批直接返回，不再挂起", async () => {
    const queue = new ApprovalQueue();
    const first = queue.request({
      callId: "c1",
      mode: "commands",
      tool: "run_command",
      label: "跑测试",
      catId: "jinjianceng",
    });
    assert.equal(queue.remember("c1", "approved"), true);
    assert.equal(await first, "approved");
    assert.equal(queue.rememberedCount(), 1);

    // 同猫同工具的第二次请求：立刻返回，不进入等待列表。
    const second = await queue.request({
      callId: "c2",
      mode: "commands",
      tool: "run_command",
      label: "再跑一次",
      catId: "jinjianceng",
    });
    assert.equal(second, "approved");
    assert.equal(queue.list().length, 0);

    // 换一只猫还是要问。
    const pendingOther = queue.request({
      callId: "c3",
      mode: "commands",
      tool: "run_command",
      label: "砚砚跑",
      catId: "yanyan",
    });
    assert.equal(queue.list().length, 1);
    queue.resolve("c3", "rejected");
    assert.equal(await pendingOther, "rejected");
  });

  test("clearRemembered 后重新询问", async () => {
    const queue = new ApprovalQueue();
    const first = queue.request({ callId: "a", mode: "commands", tool: "run_command", label: "x", catId: "xianxian" });
    queue.remember("a", "rejected");
    assert.equal(await first, "rejected");
    queue.clearRemembered();
    const pending = queue.request({ callId: "b", mode: "commands", tool: "run_command", label: "y", catId: "xianxian" });
    assert.equal(queue.list().length, 1);
    queue.resolve("b", "approved");
    assert.equal(await pending, "approved");
  });

  test("remember 未知 callId 返回 false", () => {
    const queue = new ApprovalQueue();
    assert.equal(queue.remember("nope", "approved"), false);
  });
});
