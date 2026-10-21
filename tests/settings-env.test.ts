/** 环境变量配置：允许「只给 key / 只给 headers」，其余与 settings.json 合并。 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { CATS } from "../src/agents/personas.ts";
import { readSettings } from "../src/server/settings.ts";
import { SettingsStore, SwitchableBrain } from "../src/server/settings-store.ts";
import { Studio } from "../src/server/studio.ts";
import { createMockBrain } from "../src/agents/mock-brain.ts";
import { SCENARIOS } from "../src/agents/personas.ts";

describe("LLM 环境变量可以只给一部分", () => {
  test("只给 LLM_API_KEY / LLM_HEADERS 时不会被丢掉", () => {
    const settings = readSettings({
      LLM_API_KEY: "sk-x",
      LLM_HEADERS: '{"x-opencode-session":"s1"}',
    });
    assert.ok(settings.llm, "只给 key/headers 也应该产生 llm 配置供后续合并");
    assert.equal(settings.llm?.apiKey, "sk-x");
    assert.equal(settings.llm?.headers?.["x-opencode-session"], "s1");
    assert.equal(settings.llm?.baseUrl, "");
  });

  test("完全没给 LLM_* 时 llm 为 null（不误触发）", () => {
    const settings = readSettings({});
    assert.equal(settings.llm, null);
  });

  test("设置里已有 baseUrl/model 时，env 的 key + headers 能合并进来", () => {
    const dir = mkdtempSync(join(tmpdir(), "deliverylab-env-merge-"));
    try {
      // 第一次：通过设置面板写入 baseUrl/model（不带 key）
      {
        const studio = new Studio({ cats: CATS.map((c) => ({ ...c })), mode: "mock" });
        const switchable = new SwitchableBrain(createMockBrain(SCENARIOS));
        const store = new SettingsStore({
          studio,
          mock: createMockBrain(SCENARIOS),
          switchable,
          settings: readSettings({}),
          dataDirAbs: dir,
          port: 0,
        });
        void store.update({
          llm: { baseUrl: "https://opencode.ai/zen/go/v1", model: "deepseek-v4.1-flash" },
        });
        studio.close();
      }
      // 第二次：启动时只给 key+headers（环境变量），baseUrl/model 从磁盘来
      const studio = new Studio({ cats: CATS.map((c) => ({ ...c })), mode: "mock" });
      const switchable = new SwitchableBrain(createMockBrain(SCENARIOS));
      const store = new SettingsStore({
        studio,
        mock: createMockBrain(SCENARIOS),
        switchable,
        settings: readSettings({
          LLM_API_KEY: "sk-from-env",
          LLM_HEADERS: '{"x-opencode-session":"s2"}',
        }),
        dataDirAbs: dir,
        port: 0,
      });
      const pub = store.getPublic();
      try {
        assert.equal(pub.configured, true);
        assert.equal(pub.llm.baseUrl, "https://opencode.ai/zen/go/v1");
        assert.equal(pub.llm.model, "deepseek-v4.1-flash");
        assert.equal(pub.llm.hasKey, true, "env 的 key 不能被丢掉");
        assert.equal(pub.llm.keySource, "env");
        assert.deepEqual(pub.llm.headerNames, ["x-opencode-session"]);
      } finally {
        studio.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
