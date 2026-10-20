/**
 * 成员数量可配置：增删成员、角色约束、房间同步、持久化与 HTTP 契约。
 *
 * 引擎的阶段机依赖角色齐全（一个架构师 + 一个评审 + 至少一个干活的），
 * 所以「配置化」不是简单地把数组改长改短，而是在增删时守住这几条不变量。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { createMockBrain } from "../src/agents/mock-brain.ts";
import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import type { Member } from "../src/domain/types.ts";
import { createDriver } from "../src/engine/driver.ts";
import { createHttpServer } from "../src/server/http.ts";
import { Studio } from "../src/server/studio.ts";
import { fakeDriver } from "./helpers/fake-driver.ts";

function makeStudio(dataDir?: string): Studio {
  return new Studio({
    cats: CATS.map((cat) => ({ ...cat })),
    mode: "mock",
    ...(dataDir ? { dataDir } : {}),
  });
}

function countRoles(cats: readonly Member[], role: Member["role"]): number {
  return cats.filter((cat) => cat.role === role).length;
}

describe("成员配置 · Studio 增删", () => {
  test("新增成员：补齐默认字段并加入所有房间", () => {
    const studio = makeStudio();
    try {
      studio.createRoom({ name: "第二个房间", workspaceId: "ws_sandbox" });
      const cat = studio.addCat({ name: "小满", role: "implementer" });

      assert.equal(cat.role, "implementer");
      assert.equal(cat.avatar, "implementer");
      assert.ok(cat.persona.length > 0, "应给一段默认人格");
      assert.equal(studio.state.cats.length, 5);

      for (const room of studio.state.rooms) {
        assert.ok(room.catIds.includes(cat.id), `房间「${room.name}」应包含新成员`);
      }
    } finally {
      studio.close();
    }
  });

  test("实现/设计可以有多个；架构师与评审各只能一个", () => {
    const studio = makeStudio();
    try {
      studio.addCat({ name: "小满", role: "implementer" });
      studio.addCat({ name: "阿灰", role: "designer" });
      assert.equal(countRoles(studio.state.cats, "implementer"), 2);
      assert.equal(countRoles(studio.state.cats, "designer"), 2);

      assert.throws(() => studio.addCat({ name: "老李", role: "architect" }), /只能有一个/);
      assert.throws(() => studio.addCat({ name: "老王", role: "reviewer" }), /只能有一个/);
    } finally {
      studio.close();
    }
  });

  test("新增成员的名字与角色必须合法", () => {
    const studio = makeStudio();
    try {
      assert.throws(() => studio.addCat({ name: "", role: "implementer" }), /名字需要/);
      assert.throws(() => studio.addCat({ name: "一二三四五六七八九", role: "implementer" }), /名字需要/);
      assert.throws(
        () => studio.addCat({ name: "林知远", role: "implementer" }),
        /已经被其他成员用了/,
      );
    } finally {
      studio.close();
    }
  });

  test("移除成员：进 retiredCats、退出房间、会话清掉", () => {
    const studio = makeStudio();
    try {
      const designer = studio.state.cats.find((cat) => cat.role === "designer");
      assert.ok(designer);
      studio.sessionFor(designer.id);

      const retired = studio.removeCat(designer.id);
      assert.equal(retired.id, designer.id);
      assert.equal(studio.getCat(designer.id), undefined, "在职名册里不该再有它");
      assert.ok(studio.state.retiredCats.some((cat) => cat.id === designer.id));
      assert.equal(studio.getCatIncludingRetired(designer.id)?.name, designer.name);

      for (const room of studio.state.rooms) {
        assert.ok(!room.catIds.includes(designer.id), "房间成员里要移除");
      }
      assert.equal(studio.state.catSessions[designer.id], undefined, "会话要清掉");
    } finally {
      studio.close();
    }
  });

  test("移除会破坏角色完整性时拒绝", () => {
    const studio = makeStudio();
    try {
      const architect = studio.state.cats.find((cat) => cat.role === "architect");
      const reviewer = studio.state.cats.find((cat) => cat.role === "reviewer");
      assert.ok(architect && reviewer);
      assert.throws(() => studio.removeCat(architect.id), /架构师/);
      assert.throws(() => studio.removeCat(reviewer.id), /评审/);

      // 只剩一个干活的时，也不能把它移除。
      const designer = studio.state.cats.find((cat) => cat.role === "designer");
      const implementer = studio.state.cats.find((cat) => cat.role === "implementer");
      assert.ok(designer && implementer);
      studio.removeCat(designer.id);
      assert.throws(() => studio.removeCat(implementer.id), /设计或实现/);
    } finally {
      studio.close();
    }
  });

  test("成员手上有未结束任务时拒绝移除", () => {
    const studio = makeStudio();
    try {
      const implementer = studio.state.cats.find((cat) => cat.role === "implementer");
      assert.ok(implementer);
      const task = studio.createTask({
        roomId: "room_cafe",
        brief: "给登录页加一个记住我勾选框，7天内免登录",
        scenarioId: "remember_me",
      });
      // 模拟这个任务当前由实现成员负责。
      studio.setTaskStatus(task.id, "active");
      task.owner = implementer.id;

      assert.throws(() => studio.removeCat(implementer.id), /进行中的任务/);

      // 任务收尾后就可以移除。
      studio.setTaskStatus(task.id, "done");
      assert.doesNotThrow(() => studio.removeCat(implementer.id));
    } finally {
      studio.close();
    }
  });
});

describe("成员配置 · 持久化", () => {
  let dataDir: string;

  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), "deliverylab-members-"));
  });

  after(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("增删结果重启后仍然保留（含 retiredCats）", () => {
    const first = makeStudio(dataDir);
    const added = first.addCat({ name: "小满", role: "implementer" });
    const designer = first.state.cats.find((cat) => cat.role === "designer");
    assert.ok(designer);
    first.removeCat(designer.id);
    first.persistNow();
    first.close();

    const second = makeStudio(dataDir);
    try {
      assert.equal(second.state.cats.length, 4, "4 内置 -1 移除 +1 新增 = 4");
      assert.ok(second.state.cats.some((cat) => cat.id === added.id), "新增成员应恢复");
      assert.ok(
        second.state.retiredCats.some((cat) => cat.id === designer.id),
        "已移除成员应恢复",
      );
      assert.ok(
        !second.state.rooms.some((room) => room.catIds.includes(designer.id)),
        "房间成员不应包含已移除成员",
      );
      assert.equal(second.getCat(added.id)?.name, "小满");
      assert.equal(second.getCat(added.id)?.role, "implementer");
    } finally {
      second.close();
    }
  });

  test("存档名册角色不齐时回退默认名册，应用仍能启动", () => {
    const dir = mkdtempSync(join(tmpdir(), "deliverylab-members-bad-"));
    try {
      const seed = makeStudio(dir);
      // 造一份缺评审的坏存档。
      seed.state.cats = seed.state.cats.filter((cat) => cat.role !== "reviewer");
      seed.persistNow();
      seed.close();

      const restored = makeStudio(dir);
      try {
        assert.equal(
          restored.state.cats.filter((cat) => cat.role === "reviewer").length,
          1,
          "坏存档应回退到默认名册",
        );
      } finally {
        restored.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("成员配置 · HTTP 契约", () => {
  let studio: Studio;
  let server: ReturnType<typeof createHttpServer>;
  let base: string;

  before(async () => {
    studio = makeStudio();
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
  });

  after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    studio.close();
  });

  async function postCat(body: unknown): Promise<Response> {
    return fetch(`${base}/api/cats`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("POST /api/cats 创建成员并返回 201", async () => {
    const res = await postCat({ name: "小满", role: "implementer", persona: "干活快" });
    assert.equal(res.status, 201);
    const cat = (await res.json()) as Member;
    assert.equal(cat.name, "小满");
    assert.equal(cat.role, "implementer");
    assert.equal(cat.persona, "干活快");
    assert.ok(studio.getCat(cat.id));
  });

  test("POST /api/cats 错误返回 400 且信息可读", async () => {
    const badRole = await postCat({ name: "阿黄", role: "janitor" });
    assert.equal(badRole.status, 400);
    assert.match(((await badRole.json()) as { error: string }).error, /role/);

    const dupArchitect = await postCat({ name: "老李", role: "architect" });
    assert.equal(dupArchitect.status, 400);
    assert.match(((await dupArchitect.json()) as { error: string }).error, /只能有一个/);

    const emptyName = await postCat({ name: "", role: "designer" });
    assert.equal(emptyName.status, 400);
  });

  test("DELETE /api/cats/:id 移除成员并返回 retired", async () => {
    const created = (await (await postCat({ name: "临时工", role: "designer" })).json()) as Member;
    const res = await fetch(`${base}/api/cats/${created.id}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; retired: Member };
    assert.equal(body.ok, true);
    assert.equal(body.retired.id, created.id);
    assert.ok(!studio.getCat(created.id));
  });

  test("DELETE 最后一个评审返回 400", async () => {
    const reviewer = studio.state.cats.find((cat) => cat.role === "reviewer");
    assert.ok(reviewer);
    const res = await fetch(`${base}/api/cats/${reviewer.id}`, { method: "DELETE" });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /评审/);
  });

  test("GET /api/cats 同时返回在职与已移除成员", async () => {
    const res = await fetch(`${base}/api/cats`);
    const body = (await res.json()) as { cats: Member[]; retired: Member[] };
    assert.ok(body.cats.length >= 4);
    assert.ok(body.retired.length >= 1, "应能看到已移除成员，供历史渲染");
  });
});

describe("成员配置 · 引擎在 5 人名册下仍能跑完任务", () => {
  test("多加一个实现成员，内置剧本照样走完六阶段", async () => {
    const studio = makeStudio();
    const extra = studio.addCat({ name: "小满", role: "implementer" });
    const driver = createDriver({
      studio,
      brain: createMockBrain(SCENARIOS),
      wait: async () => {},
      stallMs: 5_000,
    });
    try {
      const task = studio.createTask({
        roomId: "room_cafe",
        brief: "导出 CSV 加 UTF-8 BOM",
        scenarioId: "export_csv",
      });
      driver.submit({ type: "task_created", roomId: "room_cafe", taskId: task.id });
      // 内置剧本里埋了「交接漏 @」，最多催几次。
      for (let round = 0; round < 6; round += 1) {
        await driver.whenIdle();
        const current = studio.getTask(task.id);
        if (!current || current.status === "done") break;
        driver.submit({ type: "nudge", taskId: task.id });
      }
      const done = studio.getTask(task.id);
      assert.equal(done?.status, "done", `任务应跑完，实际 ${done?.stage}/${done?.status}`);
      assert.equal(done?.stage, "done");
      // 内置剧本只认原来那几只，新成员不会被点名 —— 这是演出模式的已知限制，
      // 真实模式下新成员会正常参与（prompt 按 state.cats 动态生成）。
      assert.ok(!studio.state.messages.some((message) => message.author === extra.id));
    } finally {
      studio.close();
    }
  });
});
