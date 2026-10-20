/** 下一层：猫猫档案 / 每猫模型字段 / 剧本库与导入校验。 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import {
  addScenario,
  initScenarios,
  listScenarios,
  removeScenario,
} from "../src/agents/scenario-registry.ts";
import { validateScenario } from "../src/agents/scenario-validation.ts";
import type { Driver, Scenario } from "../src/domain/types.ts";
import { createHttpServer } from "../src/server/http.ts";
import { Studio } from "../src/server/studio.ts";
import { fakeDriver } from "./helpers/fake-driver.ts";

function cloneBuiltin(id: string): Scenario {
  const source = SCENARIOS.find((scenario) => scenario.id === id);
  if (!source) throw new Error(`missing builtin ${id}`);
  const copy = structuredClone(source);
  copy.id = `${id}_copy`;
  copy.name = `${source.name}（副本）`;
  return copy;
}


async function listen(server: ReturnType<typeof createHttpServer>): Promise<number> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("no port");
  return address.port;
}

describe("猫猫档案 updateCat", () => {
  let dir: string;
  let studio: Studio;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "catcafe-cats-"));
    studio = new Studio({ cats: CATS, mode: "mock", dataDir: dir });
  });

  after(() => {
    studio.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("改名、改主题色、每猫模型与温度", () => {
    const cat = studio.updateCat("yanyan", {
      name: "砚台",
      accent: "#123456",
      llmModel: "gpt-4.1-mini",
      llmTemperature: 0,
    });
    assert.equal(cat.name, "砚台");
    assert.equal(cat.accent, "#123456");
    assert.equal(cat.llmModel, "gpt-4.1-mini");
    assert.equal(cat.llmTemperature, 0);
    assert.equal(studio.getCat("yanyan")?.name, "砚台");
  });

  test("重名 / 非法颜色 / 温度越界都被拒绝", () => {
    assert.throws(
      () => studio.updateCat("shuoshuo", { name: "砚台" }),
      /已经被其他猫用了/,
    );
    assert.throws(() => studio.updateCat("shuoshuo", { accent: "gold" }), /#RRGGBB/);
    assert.throws(
      () => studio.updateCat("shuoshuo", { llmTemperature: 2.5 }),
      /0–2/,
    );
    assert.throws(() => studio.updateCat("ghost", { name: "x" }), /not found/);
  });

  test("改成名字后 @ 新名字能解析到同一只猫", async () => {
    const { parseMentions } = await import("../src/server/http.ts");
    const mentions = parseMentions("@砚台 帮忙看下", studio, "room_cafe");
    assert.deepEqual(mentions, ["yanyan"]);
  });

  test("清空每猫模型 / 温度", () => {
    const cat = studio.updateCat("yanyan", { llmModel: null, llmTemperature: null });
    assert.equal(cat.llmModel, undefined);
    assert.equal(cat.llmTemperature, undefined);
  });

  test("重启后档案与每猫模型都能恢复", () => {
    studio.updateCat("yanyan", { name: "砚台", llmModel: "gpt-4.1-mini" });
    studio.persistNow();
    studio.close();

    const reopened = new Studio({ cats: CATS, mode: "mock", dataDir: dir });
    try {
      const cat = reopened.getCat("yanyan");
      assert.equal(cat?.name, "砚台");
      assert.equal(cat?.llmModel, "gpt-4.1-mini");
      // 其他猫不受影响。
      assert.equal(reopened.getCat("xianxian")?.name, "宪宪");
    } finally {
      reopened.close();
    }
  });
});

describe("剧本校验 validateScenario", () => {
  const catIds = CATS.map((cat) => cat.id);

  test("内置剧本的副本是合法自定义剧本", () => {
    const result = validateScenario(cloneBuiltin("remember_me"), { catIds });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.scenario.id, "remember_me_copy");
  });

  test("未知猫 id / 未知 turn / 缺卡栏都会被逐条报错", () => {
    const broken = cloneBuiltin("remember_me");
    const first = broken.beats[0];
    if (!first) throw new Error("scenario has no beats");
    first.cat = "ghost";
    const missingCard = broken.beats.find((beat) => beat.turn.kind === "handoff");
    if (missingCard && missingCard.turn.kind === "handoff") {
      delete (missingCard.turn.card as unknown as Record<string, unknown>)["why"];
    }
    broken.beats.push({
      stage: "intake",
      cat: "xianxian",
      turn: { kind: "dance" } as unknown as Scenario["beats"][number]["turn"],
    });

    const result = validateScenario(broken, { catIds });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((error) => error.includes("beats[0].cat")));
      assert.ok(result.errors.some((error) => error.includes("card.why")));
      assert.ok(result.errors.some((error) => error.includes("kind 未知")));
    }
  });

  test("顶层字段缺失会被拒绝", () => {
    const result = validateScenario({ id: "x", name: "", sampleBrief: "hi", tags: [], beats: [] }, { catIds });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.length >= 3);
  });
});

describe("剧本库 registry", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "catcafe-scenarios-"));
    initScenarios(dir, CATS.map((cat) => cat.id));
  });

  after(() => {
    // 清掉本组导入的东西，避免影响同进程后续测试。
    for (const item of listScenarios()) {
      if (item.source === "custom") removeScenario(item.scenario.id);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("内置剧本只读，不能删除", () => {
    assert.equal(removeScenario("remember_me"), "builtin");
    assert.ok(listScenarios().some((item) => item.scenario.id === "remember_me"));
  });

  test("导入、列出、落盘、重启恢复、删除", () => {
    const result = addScenario(cloneBuiltin("remember_me"));
    assert.equal(result.ok, true);

    const listed = listScenarios();
    assert.ok(listed.some((item) => item.scenario.id === "remember_me_copy" && item.source === "custom"));

    const persisted = JSON.parse(readFileSync(join(dir, "scenarios.json"), "utf8")) as Scenario[];
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.id, "remember_me_copy");

    // 重新 init（模拟重启）后自定义剧本仍在。
    initScenarios(dir, CATS.map((cat) => cat.id));
    assert.ok(SCENARIOS.some((scenario) => scenario.id === "remember_me_copy"));

    assert.equal(removeScenario("remember_me_copy"), "removed");
    assert.equal(removeScenario("remember_me_copy"), "not_found");
    initScenarios(dir, CATS.map((cat) => cat.id));
    assert.ok(!SCENARIOS.some((scenario) => scenario.id === "remember_me_copy"));
  });

  test("重复 id 与非法剧本被拒绝", () => {
    const duplicate = addScenario(cloneBuiltin("remember_me"));
    assert.equal(duplicate.ok, true);
    const again = addScenario(cloneBuiltin("remember_me"));
    assert.equal(again.ok, false);
    if (!again.ok) assert.match(again.errors[0] ?? "", /已存在/);

    const invalid = addScenario({ id: "bad", name: "x", sampleBrief: "嘿嘿", tags: [], beats: [] });
    assert.equal(invalid.ok, false);
  });
});

describe("HTTP /api/cats 与 /api/scenarios", () => {
  let dir: string;
  let studio: Studio;
  let server: ReturnType<typeof createHttpServer>;
  let driver: ReturnType<typeof fakeDriver>;
  let base: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "catcafe-layer2-"));
    initScenarios(dir, CATS.map((cat) => cat.id));
    studio = new Studio({ cats: CATS, mode: "mock" });
    driver = fakeDriver();
    server = createHttpServer({
      studio,
      driver,
      publicDir: resolve(import.meta.dirname, "../public"),
      scenarios: SCENARIOS,
      mode: "mock",
    });
    base = `http://127.0.0.1:${await listen(server)}`;
  });

  after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    studio.close();
    for (const item of listScenarios()) {
      if (item.source === "custom") removeScenario(item.scenario.id);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("PUT /api/cats/:id 更新档案，400 校验，404 未知猫", async () => {
    const ok = await fetch(`${base}/api/cats/shuoshuo`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "烁烁猫", llmModel: "gemini-2.0-flash" }),
    });
    assert.equal(ok.status, 200);
    const cat = (await ok.json()) as { name: string; llmModel: string };
    assert.equal(cat.name, "烁烁猫");
    assert.equal(cat.llmModel, "gemini-2.0-flash");

    const dup = await fetch(`${base}/api/cats/jinjianceng`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "烁烁猫" }),
    });
    assert.equal(dup.status, 400);

    const missing = await fetch(`${base}/api/cats/ghost`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    assert.equal(missing.status, 404);
  });

  test("GET /api/cats 返回更新后的档案", async () => {
    const res = await fetch(`${base}/api/cats`);
    const body = (await res.json()) as { cats: Array<{ id: string; name: string }> };
    assert.equal(body.cats.find((cat) => cat.id === "shuoshuo")?.name, "烁烁猫");
  });

  test("剧本列表 / 导入 / 删除 / 内置保护", async () => {
    const list = await fetch(`${base}/api/scenarios`);
    const listed = (await list.json()) as {
      scenarios: Array<{ scenario: Scenario; source: string }>;
    };
    assert.ok(listed.scenarios.some((item) => item.scenario.id === "remember_me" && item.source === "builtin"));

    const imported = await fetch(`${base}/api/scenarios`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: cloneBuiltin("export_csv") }),
    });
    assert.equal(imported.status, 201);

    const duplicate = await fetch(`${base}/api/scenarios`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: cloneBuiltin("export_csv") }),
    });
    assert.equal(duplicate.status, 409);

    const invalid = await fetch(`${base}/api/scenarios`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: { id: "bad", name: "坏剧本", sampleBrief: "这是坏剧本", tags: [], beats: [{ stage: "intake", cat: "ghost", turn: { kind: "message", text: "hi" } }] } }),
    });
    assert.equal(invalid.status, 400);
    const invalidBody = (await invalid.json()) as { errors?: string[] };
    assert.ok(invalidBody.errors?.some((message) => message.includes("cat")));

    const removeBuiltin = await fetch(`${base}/api/scenarios/remember_me`, { method: "DELETE" });
    assert.equal(removeBuiltin.status, 400);

    const removeCustom = await fetch(`${base}/api/scenarios/export_csv_copy`, { method: "DELETE" });
    assert.equal(removeCustom.status, 200);
  });

  test("自定义剧本可以作为新任务的 scenarioId", async () => {
    const imported = await fetch(`${base}/api/scenarios`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: cloneBuiltin("remember_me") }),
    });
    assert.equal(imported.status, 201);

    const taskRes = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "room_cafe", brief: "用自定义剧本跑一遍", scenarioId: "remember_me_copy" }),
    });
    assert.equal(taskRes.status, 201);
    const task = (await taskRes.json()) as { scenarioId: string };
    assert.equal(task.scenarioId, "remember_me_copy");
    assert.equal((driver.events.at(-1) as { type?: string } | undefined)?.type, "task_created");
  });
});
