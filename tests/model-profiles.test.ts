/** 模型档案：列表、建议、一键应用、还原统一模型。 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import type { Driver } from "../src/domain/types.ts";
import { createHttpServer } from "../src/server/http.ts";
import { MODEL_PROFILES, suggestedProfile } from "../src/server/model-profiles.ts";
import { Studio } from "../src/server/studio.ts";

function fakeDriver(): Driver {
  return { submit() {}, async whenIdle() {}, stallMs: 12000 };
}

async function listen(server: ReturnType<typeof createHttpServer>): Promise<string> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

describe("model profiles", () => {
  let dir: string;
  let studio: Studio;
  let server: ReturnType<typeof createHttpServer>;
  let base: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "catcafe-profiles-"));
    studio = new Studio({ cats: CATS, mode: "mock" });
    server = createHttpServer({
      studio,
      driver: fakeDriver(),
      publicDir: resolve(import.meta.dirname, "../public"),
      scenarios: SCENARIOS,
      mode: "mock",
    });
    base = await listen(server);
  });

  after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    studio.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("档案定义完整：每套都有 id/name/assignments，混搭覆盖四只猫", () => {
    assert.ok(MODEL_PROFILES.length >= 2);
    for (const profile of MODEL_PROFILES) {
      assert.ok(profile.id.length > 0);
      assert.ok(profile.name.length > 0);
      for (const assignment of profile.assignments) {
        assert.ok(CATS.some((cat) => cat.id === assignment.catId), assignment.catId);
        assert.ok(assignment.model.length > 0);
        assert.ok(assignment.temperature >= 0 && assignment.temperature <= 2);
      }
    }
    const mixed = MODEL_PROFILES.find((profile) => profile.id === "opencode-mixed");
    assert.ok(mixed);
    assert.equal(mixed?.assignments.length, 4);
  });

  test("按 endpoint 建议档案", () => {
    assert.equal(suggestedProfile("https://opencode.ai/zen/go/v1").id, "opencode-mixed");
    assert.equal(suggestedProfile("https://api.deepseek.com/v1").id, "single-model");
  });

  test("GET /api/model-profiles 返回列表与建议", async () => {
    const res = await fetch(`${base}/api/model-profiles`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      profiles: Array<{ id: string }>;
      suggested: string;
    };
    assert.ok(body.profiles.length >= 2);
    assert.ok(body.profiles.some((profile) => profile.id === "opencode-mixed"));
    assert.ok(body.suggested.length > 0);
  });

  test("应用混搭档案：四只猫拿到不同模型", async () => {
    const res = await fetch(`${base}/api/model-profiles/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "opencode-mixed" }),
    });
    assert.equal(res.status, 200);
    const cats = studio.snapshot().cats;
    const xianxian = cats.find((cat) => cat.id === "xianxian");
    const jinjianceng = cats.find((cat) => cat.id === "jinjianceng");
    assert.ok(xianxian?.llmModel);
    assert.ok(jinjianceng?.llmModel);
    assert.notEqual(xianxian?.llmModel, jinjianceng?.llmModel, "混搭应产生不同模型");
    assert.equal(jinjianceng?.llmTemperature, 0.5);
  });

  test("应用统一模型：清空所有覆盖", async () => {
    const res = await fetch(`${base}/api/model-profiles/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "single-model" }),
    });
    assert.equal(res.status, 200);
    for (const cat of studio.snapshot().cats) {
      assert.equal(cat.llmModel, undefined, `${cat.id} 应跟随全局`);
    }
  });

  test("未知档案 400", async () => {
    const res = await fetch(`${base}/api/model-profiles/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "nope" }),
    });
    assert.equal(res.status, 400);
  });
});
