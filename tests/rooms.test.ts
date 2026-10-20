/**
 * 房间管理 API 契约测试：PATCH / DELETE /api/rooms/:roomId。
 *
 * 每个用例起一套独立的 Studio + WorkspaceManager + HTTP server（端口 0），
 * driver 用不干活的假实现 —— 只验证 HTTP 校验与 Studio 级联清理的契约。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import type { Driver, HandoffCard, Room, StudioState } from "../src/domain/types.ts";
import { createHttpServer } from "../src/server/http.ts";
import { Studio } from "../src/server/studio.ts";
import { WorkspaceManager } from "../src/workspaces/manager.ts";
import { fakeDriver } from "./helpers/fake-driver.ts";

const ROOM_ID = "room_cafe";


interface Harness {
  studio: Studio;
  manager: WorkspaceManager;
  server: ReturnType<typeof createHttpServer>;
  base: string;
  /** 额外注册的一个工作区 id（用于 PATCH workspaceId 成功路径）。 */
  workspaceId: string;
  close(): Promise<void>;
}

async function listen(target: ReturnType<typeof createHttpServer>): Promise<string> {
  await new Promise<void>((done) => target.listen(0, "127.0.0.1", () => done()));
  const address = target.address();
  if (!address || typeof address !== "object") throw new Error("server 没有拿到端口");
  return `http://127.0.0.1:${address.port}`;
}

async function createHarness(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "catcafe-rooms-"));
  const repoDir = mkdtempSync(join(tmpdir(), "catcafe-rooms-repo-"));
  const manager = new WorkspaceManager(dataDir);
  const workspace = manager.add({ name: "测试仓库", path: repoDir });
  const studio = new Studio({ cats: CATS, mode: "mock" });
  const server = createHttpServer({
    studio,
    driver: fakeDriver(),
    publicDir: resolve(import.meta.dirname, "../public"),
    scenarios: SCENARIOS,
    workspaces: manager,
    mode: "mock",
  });
  const base = await listen(server);

  return {
    studio,
    manager,
    server,
    base,
    workspaceId: workspace.id,
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((done) => server.close(() => done()));
      manager.close();
      studio.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function requestJson(
  base: string,
  path: string,
  method: string,
  payload?: unknown,
): Promise<JsonResponse> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  return { status: res.status, body };
}

function patchRoom(
  base: string,
  roomId: string,
  payload: unknown,
): Promise<JsonResponse> {
  return requestJson(base, `/api/rooms/${encodeURIComponent(roomId)}`, "PATCH", payload);
}

function deleteRoom(base: string, roomId: string): Promise<JsonResponse> {
  return requestJson(base, `/api/rooms/${encodeURIComponent(roomId)}`, "DELETE");
}

async function createRoom(
  base: string,
  name: string,
  workspaceId = "ws_sandbox",
): Promise<Room> {
  const res = await requestJson(base, "/api/rooms", "POST", { name, workspaceId });
  assert.equal(res.status, 201, `POST /api/rooms 应成功：${JSON.stringify(res.body)}`);
  return res.body as unknown as Room;
}

async function getState(base: string): Promise<StudioState> {
  const res = await fetch(`${base}/api/state`);
  assert.equal(res.status, 200);
  return (await res.json()) as StudioState;
}

function card(what: string): HandoffCard {
  return {
    what,
    why: "为了验证级联清理",
    tradeoff: "测试数据不留痕",
    openQuestions: [],
    nextAction: "删房间",
  };
}

// ───────────────────────── PATCH 成功路径 ─────────────────────────

test("PATCH 房间：改名 / 改 topic / 换 workspaceId 都生效并落库", async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const room = await createRoom(h.base, "第二间");

  const renamed = await patchRoom(h.base, room.id, { name: "改名后的房间" });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, "改名后的房间");

  const retopic = await patchRoom(h.base, room.id, { topic: "新的房间主题" });
  assert.equal(retopic.status, 200);
  assert.equal(retopic.body.topic, "新的房间主题");

  const rebound = await patchRoom(h.base, room.id, { workspaceId: h.workspaceId });
  assert.equal(rebound.status, 200);
  assert.equal(rebound.body.workspaceId, h.workspaceId);

  // 多字段一次更新。
  const combined = await patchRoom(h.base, room.id, {
    name: "合并更新",
    topic: "一次改完",
    workspaceId: "ws_sandbox",
  });
  assert.equal(combined.status, 200);

  const state = await getState(h.base);
  const persisted = state.rooms.find((candidate) => candidate.id === room.id);
  assert.ok(persisted);
  assert.equal(persisted.name, "合并更新");
  assert.equal(persisted.topic, "一次改完");
  assert.equal(persisted.workspaceId, "ws_sandbox");

  // 默认房间也可以编辑；name 前后空白会被 trim。
  const padded = await patchRoom(h.base, ROOM_ID, { name: "  铲屎官大厅  " });
  assert.equal(padded.status, 200);
  assert.equal(padded.body.name, "铲屎官大厅");
});

// ───────────────────────── PATCH 校验 ─────────────────────────

test("PATCH 房间：name / topic / workspaceId 校验与 404", async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const room = await createRoom(h.base, "房间A");
  const existingName = h.studio.state.rooms.find((candidate) => candidate.id === ROOM_ID)?.name;
  assert.ok(existingName);

  // 重名 → 400。
  const duplicate = await patchRoom(h.base, room.id, { name: existingName });
  assert.equal(duplicate.status, 400);
  assert.match(String(duplicate.body.error), /已存在/);

  // 名字长度 1–30。
  for (const name of ["", "   ", "一".repeat(31)]) {
    const res = await patchRoom(h.base, room.id, { name });
    assert.equal(res.status, 400, `name=${JSON.stringify(name)} 应该被拒绝`);
    assert.match(String(res.body.error), /1–30/);
  }
  const maxName = "一".repeat(30);
  const okName = await patchRoom(h.base, room.id, { name: maxName });
  assert.equal(okName.status, 200);
  assert.equal(okName.body.name, maxName);

  // topic ≤ 120。
  const longTopic = await patchRoom(h.base, room.id, { topic: "题".repeat(121) });
  assert.equal(longTopic.status, 400);
  assert.match(String(longTopic.body.error), /120/);
  const maxTopic = "题".repeat(120);
  const okTopic = await patchRoom(h.base, room.id, { topic: maxTopic });
  assert.equal(okTopic.status, 200);
  assert.equal(okTopic.body.topic, maxTopic);

  // 不存在的 workspaceId → 400。
  const badWorkspace = await patchRoom(h.base, room.id, { workspaceId: "ws_missing" });
  assert.equal(badWorkspace.status, 400);
  assert.match(String(badWorkspace.body.error), /workspaceId/);

  // 类型不对 / 空 body / 非对象 body。
  const wrongType = await patchRoom(h.base, room.id, { name: 123 });
  assert.equal(wrongType.status, 400);
  const empty = await patchRoom(h.base, room.id, {});
  assert.equal(empty.status, 400);
  assert.match(String(empty.body.error), /没有可更新/);
  const nullBody = await patchRoom(h.base, room.id, null);
  assert.equal(nullBody.status, 400);

  // 房间不存在 → 404。
  const missing = await patchRoom(h.base, "room_missing", { name: "不存在" });
  assert.equal(missing.status, 404);
  assert.match(String(missing.body.error), /房间不存在/);

  // 校验失败不能污染已有数据。
  const state = await getState(h.base);
  const current = state.rooms.find((candidate) => candidate.id === room.id);
  assert.equal(current?.name, maxName);
  assert.equal(current?.workspaceId, "ws_sandbox");
});

// ───────────────────────── DELETE：最后一个房间 ─────────────────────────

test("DELETE 房间：最后一个房间不能删", async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const res = await deleteRoom(h.base, ROOM_ID);
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /至少保留一个房间/);
  assert.equal(h.studio.state.rooms.length, 1);
});

// ───────────────────────── DELETE：进行中任务 ─────────────────────────

test("DELETE 房间：有 active / stalled 任务时拒绝并附任务数", async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const room = await createRoom(h.base, "有活的房间");
  const task = h.studio.createTask({
    roomId: room.id,
    brief: "做一个会卡住的需求",
    scenarioId: "remember_me",
  });

  const active = await deleteRoom(h.base, room.id);
  assert.equal(active.status, 400);
  assert.match(String(active.body.error), /1 个进行中的任务/);

  h.studio.setTaskStatus(task.id, "stalled");
  const stalled = await deleteRoom(h.base, room.id);
  assert.equal(stalled.status, 400);
  assert.match(String(stalled.body.error), /1 个进行中的任务/);

  // 任务结束后可以删。
  h.studio.setTaskStatus(task.id, "done");
  const ok = await deleteRoom(h.base, room.id);
  assert.equal(ok.status, 200);
});

// ───────────────────────── DELETE：级联清理 ─────────────────────────

test("DELETE 房间：级联清理本房间数据，其它房间不受影响", async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  // 默认房间：留一条无关任务/消息/记忆，删除后必须还在。
  const keepTask = h.studio.createTask({
    roomId: ROOM_ID,
    brief: "默认房间保留的任务",
    scenarioId: "remember_me",
  });
  h.studio.setTaskStatus(keepTask.id, "done");
  const keepMessage = h.studio.appendMessage({
    roomId: ROOM_ID,
    author: "user",
    kind: "chat",
    text: "默认房间的消息",
    taskId: keepTask.id,
  });
  const keepMemory = h.studio.addMemory({
    kind: "decision",
    title: "默认房间的决策",
    body: "要保留",
    tags: ["keep"],
  });

  // 待删除房间：任务 + 消息 + 交接 + 产物 + 工具调用 + 记忆 + typing。
  const room = await createRoom(h.base, "待删除房间");
  const task = h.studio.createTask({
    roomId: room.id,
    brief: "待删除房间的任务",
    scenarioId: "remember_me",
  });
  h.studio.setTaskStatus(task.id, "done");
  h.studio.appendMessage({
    roomId: room.id,
    author: "user",
    kind: "chat",
    text: "待删除房间的消息",
    taskId: task.id,
  });
  const handoff = h.studio.addHandoff({
    taskId: task.id,
    from: "xianxian",
    to: "jinjianceng",
    card: card("测试交接"),
  });
  const artifact = h.studio.addArtifact({
    taskId: task.id,
    kind: "patch",
    title: "测试产物",
    body: "补丁内容",
    author: "jinjianceng",
  });
  const call = h.studio.addToolCall({
    catId: "jinjianceng",
    tool: "read_file",
    args: { path: "src/remember.js" },
    label: "读取 src/remember.js",
    taskId: task.id,
  });
  h.studio.finishToolCall(call.id, { status: "ok", output: "content" });
  const doomedMemory = h.studio.addMemory({
    kind: "lesson",
    title: "待删除房间的教训",
    body: "会随房间删掉",
    tags: ["doomed"],
    sourceTaskId: task.id,
  });
  // 没有 sourceTaskId 的全局记忆要保留。
  const globalMemory = h.studio.addMemory({
    kind: "preference",
    title: "全局偏好",
    body: "不要删",
    tags: ["global"],
  });
  h.studio.setTyping(room.id, "jinjianceng");
  assert.equal(h.studio.state.typing[room.id], "jinjianceng");

  const res = await deleteRoom(h.base, room.id);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.removed, {
    tasks: 1,
    messages: 1,
    handoffs: 1,
    artifacts: 1,
    toolCalls: 1,
  });

  const state = await getState(h.base);
  assert.equal(state.rooms.length, 1);
  assert.equal(state.rooms[0]?.id, ROOM_ID);

  // 目标房间的数据全部清空。
  assert.equal(state.tasks.some((item) => item.id === task.id), false);
  assert.equal(state.messages.some((message) => message.roomId === room.id), false);
  assert.equal(state.handoffs.some((item) => item.id === handoff.id), false);
  assert.equal(state.artifacts.some((item) => item.id === artifact.id), false);
  assert.equal(state.toolCalls.some((item) => item.id === call.id), false);
  assert.equal(state.memory.some((entry) => entry.id === doomedMemory.id), false);
  assert.equal(state.typing[room.id], undefined);

  // 其它房间的数据不受影响。
  assert.ok(state.tasks.some((item) => item.id === keepTask.id));
  assert.ok(state.messages.some((message) => message.id === keepMessage.id));
  assert.ok(state.memory.some((entry) => entry.id === keepMemory.id));
  assert.ok(state.memory.some((entry) => entry.id === globalMemory.id));

  // 已删除的房间再删 → 404。
  const again = await deleteRoom(h.base, room.id);
  assert.equal(again.status, 404);
  assert.match(String(again.body.error), /房间不存在/);
});
