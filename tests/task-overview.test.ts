/**
 * 跨房间任务总览：`GET /api/tasks?q=`
 *
 * 左栏任务列表按房间过滤，房间一多就找不回「我记得做过一个 CSV 的任务，
 * 但忘了在哪个房间」。这个接口给前端一个能跨房间检索的入口。
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import { createHttpServer } from "../src/server/http.ts";
import { Studio } from "../src/server/studio.ts";
import { fakeDriver } from "./helpers/fake-driver.ts";

describe("GET /api/tasks 跨房间总览", () => {
  let studio: Studio;
  let server: ReturnType<typeof createHttpServer>;
  let base: string;

  before(async () => {
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
  });

  test("返回所有房间的任务，并带上房间名", async () => {
    const room = studio.getRoom("room_cafe");
    assert.ok(room, "默认房间应存在");

    studio.createTask({
      roomId: room.id,
      brief: "导出 CSV 时中文乱码，加 UTF-8 BOM",
      scenarioId: "export_csv",
    });
    studio.createTask({
      roomId: room.id,
      brief: "给登录页加一个记住我勾选框",
      scenarioId: "remember_me",
    });

    const response = await fetch(`${base}/api/tasks`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      tasks: Array<{ title: string; roomName: string; roomId: string }>;
    };
    assert.equal(body.tasks.length, 2);
    for (const task of body.tasks) {
      assert.equal(task.roomName, room.name, "应带上房间名，便于跨房间辨认");
    }
  });

  test("按关键词同时匹配标题和需求原文", async () => {
    const response = await fetch(`${base}/api/tasks?q=CSV`);
    const body = (await response.json()) as { tasks: Array<{ title: string }> };
    assert.equal(body.tasks.length, 1, `应只命中 CSV 那条，实际 ${JSON.stringify(body.tasks)}`);
    assert.match(body.tasks[0]?.title ?? "", /CSV/);
  });

  test("关键词大小写不敏感；命中不到时返回空数组", async () => {
    const lower = await fetch(`${base}/api/tasks?q=csv`);
    const lowerBody = (await lower.json()) as { tasks: unknown[] };
    assert.equal(lowerBody.tasks.length, 1, "小写也应命中");

    const none = await fetch(`${base}/api/tasks?q=不存在的关键词xyz`);
    const noneBody = (await none.json()) as { tasks: unknown[] };
    assert.equal(noneBody.tasks.length, 0);
  });

  test("按创建时间倒序，新的在前", async () => {
    const response = await fetch(`${base}/api/tasks`);
    const body = (await response.json()) as {
      tasks: Array<{ createdAt: number }>;
    };
    const times = body.tasks.map((task) => task.createdAt);
    const sorted = [...times].sort((a, b) => b - a);
    assert.deepEqual(times, sorted);
  });

  test("q 为空串等同于不筛选", async () => {
    const response = await fetch(`${base}/api/tasks?q=%20%20`);
    const body = (await response.json()) as { tasks: unknown[] };
    assert.equal(body.tasks.length, 2, "空白关键词应视为不筛选");
  });
});
