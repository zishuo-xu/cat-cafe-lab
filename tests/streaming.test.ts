/** 流式输出：SSE 解析、草稿回调、状态清理。 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, test } from "node:test";

import { createLlmBrain } from "../src/agents/llm-brain.ts";
import { CATS } from "../src/agents/personas.ts";
import { createDriver } from "../src/engine/driver.ts";
import type {
  AgentBrain,
  AgentTurn,
  DeltaUpdate,
  LlmSettings,
  StudioState,
  TurnContext,
} from "../src/domain/types.ts";
import { Studio } from "../src/server/studio.ts";
import { BUILTIN_TOOLS } from "../src/tools/builtin.ts";

const SETTINGS: LlmSettings = {
  baseUrl: "https://example.test/v1",
  model: "m",
  apiKey: "k",
  temperature: 0.7,
};

function makeFallback(): AgentBrain {
  return {
    mode: "mock",
    async think(): Promise<AgentTurn[]> {
      return [{ kind: "message", text: "（fallback）" }];
    },
  };
}

function makeContext(onDelta?: (update: DeltaUpdate) => void): TurnContext {
  const cat = CATS.find((item) => item.role === "architect")!;
  const room = {
    id: "room_cafe",
    name: "交付台",
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
    session: null,
    roomCats: [],
    scenario: null,
    ...(onDelta ? { onDelta } : {}),
  };
}

describe("流式输出", () => {
  let server: Server;
  let baseUrl: string;
  let received: string[] = [];
  let sseChunks: string[] = [];

  before(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        received.push(raw);
        const body = JSON.parse(raw) as { stream?: boolean };
        if (!body.stream) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: { role: "assistant", content: JSON.stringify([{ kind: "message", text: "非流式" }]) },
                  finish_reason: "stop",
                },
              ],
            }),
          );
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of sseChunks) res.write(chunk);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("no port");
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  });

  after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  function sse(delta: Record<string, unknown>, finish?: string): string {
    return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })}\n\n`;
  }

  test("流式：累积 content、推送草稿、返回完整 turn", async () => {
    sseChunks = [
      sse({ content: '[{"kind":"message",' }),
      sse({ content: '"text":"我先说结论' }),
      sse({ content: '，再拆。"}' }),
      sse({ content: "" }, "stop"),
    ];
    const deltas: string[] = [];
    const brain = createLlmBrain({ ...SETTINGS, baseUrl }, makeFallback(), { streaming: true });

    const turns = await brain.think(makeContext((update) => deltas.push(update.text)));
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.kind, "message");
    assert.match((turns[0] as { text: string }).text, /我先说结论/);
    assert.ok(deltas.length >= 2, `应收到至少两次增量，实际 ${JSON.stringify(deltas)}`);
    assert.ok(deltas.some((text) => text.includes("我先说结论")), JSON.stringify(deltas));
    // 请求体里确实带上了 stream: true
    assert.match(received.at(-1) ?? "", /"stream":true/);
  });

  test("没有 onDelta 时不发流式请求", async () => {
    sseChunks = [sse({ content: "x" }, "stop")];
    const brain = createLlmBrain({ ...SETTINGS, baseUrl }, makeFallback(), { streaming: true });
    await brain.think(makeContext());
    const last = received.at(-1) ?? "";
    assert.match(last, /"stream":false/);
  });

  test("流式响应损坏时改用非流式重试（不直接降级）", async () => {
    sseChunks = ["data: not-json\n\n"];
    const before = received.length;
    const brain = createLlmBrain({ ...SETTINGS, baseUrl }, makeFallback(), { streaming: true });
    const turns = await brain.think(makeContext(() => undefined));

    // 先流式（损坏）→ 再非流式重试，拿到完整回复；不该退化成演出台词。
    assert.equal(received.length, before + 2, "应有流式 + 非流式两次请求");
    assert.match(received.at(-1) ?? "", /"stream":false/);
    assert.equal(turns[0]?.kind, "message");
    assert.match((turns[0] as { text: string }).text, /非流式/);
  });
});

describe("草稿状态（Studio）", () => {
  test("setDraft 写入 / 文本不变不重复推送 / 清空", () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    try {
      let seq = studio.snapshot().seq;
      studio.setDraft("room_cafe", { catId: "linzhiyuan", text: "我先说" });
      const afterFirst = studio.snapshot();
      assert.equal(afterFirst.drafts["room_cafe"]?.text, "我先说");
      assert.ok(afterFirst.seq > seq);

      seq = afterFirst.seq;
      studio.setDraft("room_cafe", { catId: "linzhiyuan", text: "我先说" });
      assert.equal(studio.snapshot().seq, seq, "文本没变不应触发推送");

      studio.setDraft("room_cafe", null);
      assert.equal(studio.snapshot().drafts["room_cafe"], undefined);
    } finally {
      studio.close();
    }
  });

  test("driver 每轮结束后清空草稿", async () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    let sawDraft = false;
    const brain: AgentBrain = {
      mode: "llm",
      async think(ctx): Promise<AgentTurn[]> {
        ctx.onDelta?.({ catId: ctx.cat.id, roomId: ctx.room.id, text: "正在打字…" });
        assert.ok(studio.snapshot().drafts[ctx.room.id], "回调期间应有草稿");
        sawDraft = true;
        return [{ kind: "message", text: "说完了" }];
      },
    };
    const driver = createDriver({ studio, brain, wait: () => Promise.resolve(), stallMs: 5000 });
    try {
      const task = studio.createTask({
        roomId: "room_cafe",
        brief: "流式草稿测试",
        scenarioId: "export_csv",
      });
      assert.ok(task);
      driver.submit({ type: "task_created", roomId: "room_cafe", taskId: task.id });
      await driver.whenIdle();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await driver.whenIdle();
      assert.equal(sawDraft, true);
      const state: StudioState = studio.snapshot();
      assert.equal(state.drafts["room_cafe"], undefined, "轮次结束后草稿应被清空");
      assert.ok(state.messages.some((message) => message.text === "说完了"));
    } finally {
      studio.close();
    }
  });
});


describe("artifact 正文流式", () => {
  let server: Server;
  let baseUrl: string;
  let chunks: string[] = [];

  before(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of chunks) res.write(chunk);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("no port");
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  });

  after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  function sse(content: string, finish?: string): string {
    return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish ?? null }] })}\n\n`;
  }

  test("spec 的 body 会作为草稿逐段推送", async () => {
    chunks = [
      sse('[{"kind":"artifact","artifact":{"kind":"spec",'),
      sse('"title":"记住我规格","body":"结论：这不是加个勾选框。\\n'),
      sse('现状：remember.js 没有 expiresAt。\\n'),
      sse('本次做：签发时写过期时间。"},'),
      sse('"text":"规格给了我。"}]'),
      sse("", "stop"),
    ];
    const deltas: string[] = [];
    const brain = createLlmBrain({ ...SETTINGS, baseUrl }, makeFallback(), { streaming: true });
    const turns = await brain.think(makeContext((update) => deltas.push(update.text)));

    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.kind, "artifact");
    if (turns[0]?.kind === "artifact") {
      assert.match(turns[0].artifact.body, /expiresAt/);
    }
    assert.ok(deltas.length >= 2, JSON.stringify(deltas));
    assert.ok(
      deltas.some((text) => text.includes("结论：这不是加个勾选框")),
      "应推送 artifact body 的内容",
    );
    // body 阶段用开头；text 阶段出现在 body 之后，应切换到 text。
    assert.ok(deltas.some((text) => text.includes("规格给了我")), JSON.stringify(deltas));
  });

  test("body 未闭合时去掉尾部不完整转义", async () => {
    // 模拟真实 JSON 流在 " 中间被切断：末尾是一个孤立的反斜杠。
    const raw =
      '[{"kind":"artifact","artifact":{"kind":"design","title":"t","body":"第一行\\\\n第二行"}]'.replace(
        '第二行"',
        "第二行\\",
      );
    chunks = [sse(raw)];
    const deltas: string[] = [];
    const brain = createLlmBrain({ ...SETTINGS, baseUrl }, makeFallback(), { streaming: true });
    await brain.think(makeContext((update) => deltas.push(update.text)));
    assert.ok(deltas.length >= 1, JSON.stringify(deltas));
    const last = deltas.at(-1) ?? "";
    // 尾部不应残留孤立反斜杠
    assert.ok(!last.endsWith("\\"), JSON.stringify(deltas));
    assert.match(last, /第一行/);
  });
});
