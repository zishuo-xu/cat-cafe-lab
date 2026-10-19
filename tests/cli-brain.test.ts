/** CLI brain：子进程调用、envelope 解析、超时与降级。 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { createCliBrain } from "../src/agents/cli-brain.ts";
import { CATS } from "../src/agents/personas.ts";
import type { CatBrain, LlmSettings, TurnContext } from "../src/domain/types.ts";
import { BUILTIN_TOOLS } from "../src/tools/builtin.ts";

const SETTINGS: LlmSettings = {
  baseUrl: "http://unused",
  model: "test-model",
  apiKey: "sk-secret-key",
  temperature: 0.7,
};

function makeFallback(): { brain: CatBrain; calls: () => number } {
  let calls = 0;
  return {
    brain: {
      mode: "mock",
      async think() {
        calls += 1;
        return [{ kind: "message", text: "（fallback）" }];
      },
    },
    calls: () => calls,
  };
}

function makeContext(): TurnContext {
  const cat = CATS.find((item) => item.role === "architect")!;
  const room = {
    id: "room_cafe",
    name: "猫咖",
    topic: "",
    catIds: CATS.map((item) => item.id),
    createdAt: 0,
  };
  return {
    cat,
    room,
    task: null,
    trigger: { kind: "task_created", roomId: room.id },
    recentMessages: [],
    memory: [],
    handoffs: [],
    artifacts: [],
    recentToolResults: [],
    availableTools: BUILTIN_TOOLS,
    skills: [],
    scenario: null,
  };
}

/** 造一个假 CLI：按 FAKE_MODE 输出不同的 envelope。 */
function makeFakeCli(dir: string, mode: "ok" | "error" | "garbage" | "sleep" | "plain"): string {
  const path = join(dir, `fake-claude-${mode}.sh`);
  const bodies: Record<string, string> = {
    ok: `cat <<'JSON'
{"is_error":false,"result":"[{\\"kind\\":\\"message\\",\\"text\\":\\"CLI 说你好\\"}]","num_turns":1}
JSON`,
    error: `cat <<'JSON'
{"is_error":true,"result":"boom","subtype":"error_during_execution"}
JSON`,
    garbage: `cat <<'JSON'
{"is_error":false,"result":"这是一段纯文本，不是 JSON"}
JSON`,
    plain: `cat <<'JSON'
{"is_error":false,"result":""}
JSON`,
    sleep: `sleep 30; echo '{"is_error":false,"result":"[]"}'`,
  };
  writeFileSync(path, `#!/bin/sh\n${bodies[mode]}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

describe("CLI brain", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "catcafe-cli-brain-"));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("正常输出：解析成 CatTurn[]", async () => {
    const brain = createCliBrain(SETTINGS, makeFallback().brain, {
      command: makeFakeCli(dir, "ok"),
      cwd: dir,
    });
    const turns = await brain.think(makeContext());
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.kind, "message");
    if (turns[0]?.kind === "message") assert.match(turns[0].text, /CLI 说你好/);
  });

  test("is_error=true → 降级 fallback", async () => {
    const fallback = makeFallback();
    const brain = createCliBrain(SETTINGS, fallback.brain, {
      command: makeFakeCli(dir, "error"),
      cwd: dir,
    });
    await brain.think(makeContext());
    assert.equal(fallback.calls(), 1);
  });

  test("纯文本输出 → 包成一条 message，不降级", async () => {
    const fallback = makeFallback();
    const brain = createCliBrain(SETTINGS, fallback.brain, {
      command: makeFakeCli(dir, "garbage"),
      cwd: dir,
    });
    const turns = await brain.think(makeContext());
    assert.equal(fallback.calls(), 0);
    assert.equal(turns[0]?.kind, "message");
    if (turns[0]?.kind === "message") assert.match(turns[0].text, /纯文本/);
  });

  test("空 result → 降级", async () => {
    const fallback = makeFallback();
    const brain = createCliBrain(SETTINGS, fallback.brain, {
      command: makeFakeCli(dir, "plain"),
      cwd: dir,
    });
    await brain.think(makeContext());
    assert.equal(fallback.calls(), 1);
  });

  test("超时 → kill 并降级", async () => {
    const fallback = makeFallback();
    const brain = createCliBrain(SETTINGS, fallback.brain, {
      command: makeFakeCli(dir, "sleep"),
      cwd: dir,
      timeoutMs: 800,
    });
    const started = Date.now();
    await brain.think(makeContext());
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `应在超时后很快返回，实际 ${elapsed}ms`);
    assert.equal(fallback.calls(), 1);
  });

  test("命令不存在 → 降级而不是抛错", async () => {
    const fallback = makeFallback();
    const brain = createCliBrain(SETTINGS, fallback.brain, {
      command: "/nonexistent/claude-xyz",
      cwd: dir,
    });
    await brain.think(makeContext());
    assert.equal(fallback.calls(), 1);
  });

  test("onDelta 会收到一次草稿", async () => {
    const brain = createCliBrain(SETTINGS, makeFallback().brain, {
      command: makeFakeCli(dir, "ok"),
      cwd: dir,
    });
    const deltas: string[] = [];
    await brain.think({
      ...makeContext(),
      onDelta: (update) => deltas.push(update.text),
    });
    assert.equal(deltas.length, 1);
    assert.match(deltas[0] ?? "", /CLI 说你好/);
  });
});
