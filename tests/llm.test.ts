/**
 * LLM brain 测试：用 node:http 起本地假 OpenAI 兼容端点，覆盖
 * 合法 JSON / 坏 JSON / HTTP 500 / 超时四种情况，以及结构校验与隐私约束。
 *
 * 不依赖外网：全部请求都打在 127.0.0.1 的临时端口上。
 */

import assert from "node:assert/strict";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";

import { CATS } from "../src/agents/personas.ts";
import { createLlmBrain, parseTurns } from "../src/agents/llm-brain.ts";
import type {
  Cat,
  CatBrain,
  CatTurn,
  LlmSettings,
  Message,
  Role,
  Room,
  Task,
  Trigger,
  TurnContext,
} from "../src/domain/types.ts";

// ───────────────────────── 夹具 ─────────────────────────

function catByRole(role: Role): Cat {
  const found = CATS.find((cat) => cat.role === role);
  if (!found) throw new Error(`personas 里缺少 role=${role} 的猫`);
  return found;
}

const BRIEF = "给登录页加一个「记住我」勾选框，7 天内免登录。";

function makeContext(overrides: Partial<TurnContext> = {}): TurnContext {
  const cat = catByRole("architect");
  const room: Room = {
    id: "room_cafe",
    name: "猫咖 · 客厅",
    topic: "把需求丢进来，猫猫们会在同一张桌子上把它做出来。",
    catIds: CATS.map((c) => c.id),
    createdAt: Date.now(),
  };
  const task: Task = {
    id: "task_test",
    roomId: room.id,
    title: "给登录页加记住我",
    brief: BRIEF,
    scenarioId: "remember_me",
    status: "active",
    stage: "intake",
    owner: cat.id,
    steps: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const trigger: Trigger = {
    kind: "task_created",
    roomId: room.id,
    taskId: task.id,
    text: BRIEF,
  };
  const recentMessages: Message[] = [
    {
      id: "msg_system",
      roomId: room.id,
      author: "system",
      kind: "system",
      text: "☕ 猫咖开门了。",
      mentions: [],
      at: Date.now() - 2000,
    },
    {
      id: "msg_user",
      roomId: room.id,
      author: "user",
      kind: "chat",
      text: BRIEF,
      mentions: [cat.id],
      taskId: task.id,
      at: Date.now() - 1000,
    },
  ];

  return {
    cat,
    room,
    task,
    trigger,
    recentMessages,
    memory: [
      {
        id: "mem_prev",
        kind: "decision",
        title: "上次 remember-me 用 7 天 token",
        body: "滚动过期，不每次登录。",
        tags: ["auth"],
        createdAt: Date.now() - 5000,
      },
    ],
    handoffs: [],
    artifacts: [],
    scenario: null,
    ...overrides,
  };
}

const SETTINGS: LlmSettings = {
  baseUrl: "http://127.0.0.1:1/v1", // 每个测试会替换成假端点
  apiKey: "sk-test-secret-key",
  model: "cat-test-model",
  temperature: 0.7,
};

function makeFallback(): { brain: CatBrain; calls: () => number } {
  let calls = 0;
  const brain: CatBrain = {
    mode: "mock",
    async think(): Promise<CatTurn[]> {
      calls += 1;
      return [{ kind: "message", text: "（fallback）兜底台词" }];
    },
  };
  return { brain, calls: () => calls };
}

// ───────────────────────── 假 OpenAI 端点 ─────────────────────────

interface RecordedRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface FakeEndpoint {
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

type FakeHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) => void | Promise<void>;

async function startFake(handler: FakeHandler): Promise<FakeEndpoint> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ path: req.url ?? "", headers: req.headers, body });
      await handler(req, res, body);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function withFake(
  handler: FakeHandler,
  run: (fake: FakeEndpoint) => Promise<void>,
): Promise<void> {
  const fake = await startFake(handler);
  try {
    await run(fake);
  } finally {
    await fake.close();
  }
}

function sendOpenAi(res: ServerResponse, content: string, status = 200): void {
  const body = JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    model: "cat-test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function withWarnCapture<T>(
  run: () => Promise<T>,
): Promise<{ result: T; warns: string[] }> {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const result = await run();
    return { result, warns };
  } finally {
    console.warn = original;
  }
}

const FIVE_COLUMN_CARD = {
  what: "实现 remember-me 勾选框",
  why: "减少重复登录摩擦",
  tradeoff: "便利性与共享设备安全之间取平衡",
  openQuestions: ["7 天后是否需要重新验证身份？"],
  nextAction: "先出交互稿，再写后端 token",
};

// ───────────────────────── 用例 ─────────────────────────

describe("llm-brain · 正常解析", () => {
  test("合法 JSON 数组被解析成 CatTurn[]，请求体带猫名与 brief", async () => {
    const content = JSON.stringify([
      { kind: "message", text: "我先说结论，再拆。这个需求有安全风险。" },
      {
        kind: "handoff",
        to: "jinjianceng",
        card: FIVE_COLUMN_CARD,
        text: "后端 token 交给你。",
      },
    ]);

    await withFake(
      (_req, res) => sendOpenAi(res, content),
      async (fake) => {
        const fallback = makeFallback();
        const brain = createLlmBrain(
          { ...SETTINGS, baseUrl: fake.baseUrl },
          fallback.brain,
        );
        const ctx = makeContext();
        const turns = await brain.think(ctx);

        assert.equal(brain.mode, "llm");
        assert.equal(turns.length, 2);
        assert.equal(turns[0]?.kind, "message");
        assert.equal(turns[1]?.kind, "handoff");
        if (turns[1]?.kind === "handoff") {
          assert.equal(turns[1].to, "jinjianceng");
          assert.deepEqual(turns[1].card, FIVE_COLUMN_CARD);
        }
        assert.equal(fallback.calls(), 0, "正常输出不应降级");

        assert.equal(fake.requests.length, 1);
        const request = fake.requests[0];
        assert.ok(request);
        assert.equal(request.path, "/v1/chat/completions");
        assert.equal(request.headers.authorization, "Bearer sk-test-secret-key");
        assert.match(String(request.headers["content-type"]), /application\/json/);

        const body = JSON.parse(request.body) as {
          model: string;
          temperature: number;
          max_tokens: number;
          messages: Array<{ role: string; content: string }>;
        };
        assert.equal(body.model, "cat-test-model");
        assert.equal(body.temperature, 0.7);
        assert.ok(body.max_tokens >= 256, "max_tokens 要足够一轮结构化输出");
        assert.equal(body.messages[0]?.role, "system");
        assert.equal(body.messages[1]?.role, "user");

        // 请求里必须带猫的人格与任务需求。
        const system = body.messages[0]?.content ?? "";
        const user = body.messages[1]?.content ?? "";
        assert.match(system, /宪宪/);
        assert.match(user, /记住我/);
        assert.match(user, /task_created/);
        // brief 与共享记忆都要进 prompt。
        assert.match(user, /7 天内免登录/);
        assert.match(user, /7 天 token/);
        // key 只应在请求头里，绝不能出现在 body。
        assert.ok(!request.body.includes("sk-test-secret-key"));
      },
    );
  });

  test("未知 kind 与非法字段被丢弃，合法 turn 保留", async () => {
    const content = JSON.stringify([
      { kind: "message", text: "收到。", mentions: ["shuoshuo", "ghost"] },
      { kind: "dance", text: "跳个舞" },
      { kind: "handoff", to: "xianxian", card: FIVE_COLUMN_CARD }, // 不能交给自己
      { kind: "review", verdict: "maybe", title: "?", text: "?", findings: [] },
      { kind: "artifact", artifact: { kind: "patch", title: "v1", body: "diff" }, text: "给" },
    ]);

    await withFake(
      (_req, res) => sendOpenAi(res, content),
      async (fake) => {
        const fallback = makeFallback();
        const brain = createLlmBrain({ ...SETTINGS, baseUrl: fake.baseUrl }, fallback.brain);
        const turns = await brain.think(makeContext());

        assert.equal(fallback.calls(), 0);
        assert.equal(turns.length, 2);
        assert.equal(turns[0]?.kind, "message");
        if (turns[0]?.kind === "message") {
          // 不存在的猫 id 被过滤。
          assert.deepEqual(turns[0].mentions, ["shuoshuo"]);
        }
        assert.equal(turns[1]?.kind, "artifact");
      },
    );
  });

  test("```json 代码围栏会被容忍", async () => {
    const content = `\`\`\`json\n${JSON.stringify([
      { kind: "message", text: "我先说结论，再拆。" },
    ])}\n\`\`\``;

    await withFake(
      (_req, res) => sendOpenAi(res, content),
      async (fake) => {
        const fallback = makeFallback();
        const brain = createLlmBrain({ ...SETTINGS, baseUrl: fake.baseUrl }, fallback.brain);
        const turns = await brain.think(makeContext());
        assert.equal(fallback.calls(), 0);
        assert.equal(turns.length, 1);
      },
    );
  });
});

describe("llm-brain · 失败降级", () => {
  test("模型输出坏 JSON → 降级 fallback，且日志不含 apiKey", async () => {
    // 截断的数组：JSON.parse 一定失败。
    const content = '[{"kind":"message","text":}]';

    await withFake(
      (_req, res) => sendOpenAi(res, content),
      async (fake) => {
        const fallback = makeFallback();
        const brain = createLlmBrain({ ...SETTINGS, baseUrl: fake.baseUrl }, fallback.brain);

        const { result, warns } = await withWarnCapture(() => brain.think(makeContext()));

        assert.equal(fallback.calls(), 1);
        assert.deepEqual(result, [{ kind: "message", text: "（fallback）兜底台词" }]);
        assert.equal(warns.length, 1, "每次失败只打一行 warn");
        assert.match(warns[0] ?? "", /降级 fallback/);
        assert.ok(
          !(warns[0] ?? "").includes("sk-test-secret-key"),
          "warn 里绝不能出现 apiKey",
        );
      },
    );
  });

  test("模型输出不是 JSON 数组（纯文本）→ 降级", async () => {
    await withFake(
      (_req, res) => sendOpenAi(res, "喵喵喵，我觉得这个需求可以。"),
      async (fake) => {
        const fallback = makeFallback();
        const brain = createLlmBrain({ ...SETTINGS, baseUrl: fake.baseUrl }, fallback.brain);
        const turns = await brain.think(makeContext());
        assert.equal(fallback.calls(), 1);
        assert.equal(turns[0]?.kind, "message");
        if (turns[0]?.kind === "message") assert.match(turns[0].text, /fallback/);
      },
    );
  });

  test("HTTP 500 → 降级", async () => {
    await withFake(
      (_req, res) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"error":{"message":"upstream exploded"}}');
      },
      async (fake) => {
        const fallback = makeFallback();
        const brain = createLlmBrain({ ...SETTINGS, baseUrl: fake.baseUrl }, fallback.brain);

        const { result, warns } = await withWarnCapture(() => brain.think(makeContext()));

        assert.equal(fallback.calls(), 1);
        assert.equal(result[0]?.kind, "message");
        assert.match(warns[0] ?? "", /HTTP 500/);
      },
    );
  });

  test("响应缺少 choices[0].message.content → 降级", async () => {
    await withFake(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [] }));
      },
      async (fake) => {
        const fallback = makeFallback();
        const brain = createLlmBrain({ ...SETTINGS, baseUrl: fake.baseUrl }, fallback.brain);
        await brain.think(makeContext());
        assert.equal(fallback.calls(), 1);
      },
    );
  });

  test("超时 → 降级，且不会卡住 20s", async () => {
    // 假端点收到请求后永不响应。
    await withFake(
      () => {
        /* 故意不响应 */
      },
      async (fake) => {
        const fallback = makeFallback();
        const brain = createLlmBrain(
          { ...SETTINGS, baseUrl: fake.baseUrl },
          fallback.brain,
          { timeoutMs: 120 },
        );

        const startedAt = Date.now();
        const { result, warns } = await withWarnCapture(() => brain.think(makeContext()));
        const elapsed = Date.now() - startedAt;

        assert.equal(fallback.calls(), 1);
        assert.equal(result[0]?.kind, "message");
        assert.ok(elapsed < 3000, `超时应快速降级，实际 ${elapsed}ms`);
        assert.match(warns[0] ?? "", /超时/);
        assert.ok(!(warns[0] ?? "").includes("sk-test-secret-key"));
      },
    );
  });

  test("网络错误（端点不可达）→ 降级", async () => {
    const fallback = makeFallback();
    const brain = createLlmBrain(
      // 127.0.0.1:1 几乎不可能有服务在听。
      { ...SETTINGS, baseUrl: "http://127.0.0.1:1/v1" },
      fallback.brain,
      { timeoutMs: 800 },
    );

    const { warns } = await withWarnCapture(() => brain.think(makeContext()));
    assert.equal(fallback.calls(), 1);
    assert.match(warns[0] ?? "", /网络错误|降级 fallback/);
  });
});

describe("llm-brain · 结构校验（纯函数）", () => {
  test("非法卡片缺栏 → handoff 被丢弃", () => {
    const content = JSON.stringify([
      {
        kind: "handoff",
        to: "jinjianceng",
        card: { what: "做", why: "因为", tradeoff: "取舍" }, // 缺 openQuestions/nextAction
      },
    ]);
    const turns = parseTurns(content, makeContext());
    assert.equal(turns.length, 0);
  });

  test("review verdict 白名单 + findings 结构校验", () => {
    const content = JSON.stringify([
      {
        kind: "review",
        verdict: "request_changes",
        title: "打回",
        text: "有问题",
        mentions: ["jinjianceng"],
        findings: [
          { severity: "blocker", title: "token 没过期", detail: "应设 7 天" },
          { severity: "critical", title: "未知严重级别", detail: "应丢弃" },
        ],
      },
    ]);
    const turns = parseTurns(content, makeContext());
    assert.equal(turns.length, 1);
    const turn = turns[0];
    assert.equal(turn?.kind, "review");
    if (turn?.kind === "review") {
      assert.equal(turn.verdict, "request_changes");
      assert.equal(turn.findings.length, 1);
      assert.equal(turn.findings[0]?.severity, "blocker");
    }
  });

  test("delayMs 被夹到安全范围，非法类型丢弃", () => {
    const content = JSON.stringify([
      { kind: "message", text: "a", delayMs: 999999 },
      { kind: "message", text: "b", delayMs: "soon" },
    ]);
    const turns = parseTurns(content, makeContext());
    assert.equal(turns.length, 2);
    if (turns[0]?.kind === "message") assert.equal(turns[0].delayMs, 8000);
    if (turns[1]?.kind === "message") assert.equal(turns[1].delayMs, undefined);
  });
});

describe("llm-brain · 每猫模型与温度", () => {
  const OK_CONTENT = JSON.stringify([{ kind: "message", text: "我先说结论，再拆。" }]);

  interface RecordedBody {
    model: string;
    temperature: number;
    messages: Array<{ role: string; content: string }>;
  }

  function bodyOf(request: RecordedRequest): RecordedBody {
    return JSON.parse(request.body) as RecordedBody;
  }

  test("两只不同的猫，各自请求体与 prompt 都用各自的模型", async () => {
    await withFake(
      (_req, res) => sendOpenAi(res, OK_CONTENT),
      async (fake) => {
        const fallback = makeFallback();
        const brain = createLlmBrain(
          { ...SETTINGS, baseUrl: fake.baseUrl },
          fallback.brain,
        );
        const xianxian = catByRole("architect");
        const yanyan = catByRole("reviewer");

        await brain.think(
          makeContext({ cat: { ...xianxian, llmModel: "model-architect" } }),
        );
        await brain.think(
          makeContext({ cat: { ...yanyan, llmModel: "model-reviewer" } }),
        );

        assert.equal(fallback.calls(), 0);
        assert.equal(fake.requests.length, 2);
        const first = fake.requests[0];
        const second = fake.requests[1];
        assert.ok(first);
        assert.ok(second);
        assert.equal(bodyOf(first).model, "model-architect");
        assert.equal(bodyOf(second).model, "model-reviewer");
        // prompt 里也要体现这只猫实际使用的模型。
        assert.match(bodyOf(first).messages[0]?.content ?? "", /model-architect/);
        assert.match(bodyOf(second).messages[0]?.content ?? "", /model-reviewer/);
      },
    );
  });

  test("llmModel 为空串 / 纯空白时回落全局 settings.model", async () => {
    await withFake(
      (_req, res) => sendOpenAi(res, OK_CONTENT),
      async (fake) => {
        const fallback = makeFallback();
        const brain = createLlmBrain(
          { ...SETTINGS, baseUrl: fake.baseUrl },
          fallback.brain,
        );
        const cat = catByRole("architect");

        await brain.think(makeContext({ cat: { ...cat, llmModel: "" } }));
        await brain.think(makeContext({ cat: { ...cat, llmModel: "   " } }));

        assert.equal(fallback.calls(), 0);
        assert.equal(fake.requests.length, 2);
        for (const request of fake.requests) {
          assert.equal(bodyOf(request).model, SETTINGS.model);
        }
      },
    );
  });

  test("llmTemperature = 0 生效（0 是合法值，不能按 falsy 回落）", async () => {
    await withFake(
      (_req, res) => sendOpenAi(res, OK_CONTENT),
      async (fake) => {
        const fallback = makeFallback();
        const brain = createLlmBrain(
          { ...SETTINGS, baseUrl: fake.baseUrl },
          fallback.brain,
        );
        await brain.think(
          makeContext({ cat: { ...catByRole("reviewer"), llmTemperature: 0 } }),
        );

        const request = fake.requests[0];
        assert.ok(request);
        assert.equal(bodyOf(request).temperature, 0);
      },
    );
  });

  test("每猫温度生效，且越界值被夹到 0–2", async () => {
    const cases = [
      { llmTemperature: 1.5, expected: 1.5 },
      { llmTemperature: 5, expected: 2 },
      { llmTemperature: -3, expected: 0 },
    ];

    await withFake(
      (_req, res) => sendOpenAi(res, OK_CONTENT),
      async (fake) => {
        const fallback = makeFallback();
        const brain = createLlmBrain(
          { ...SETTINGS, baseUrl: fake.baseUrl },
          fallback.brain,
        );
        const cat = catByRole("designer");

        for (const item of cases) {
          await brain.think(
            makeContext({ cat: { ...cat, llmTemperature: item.llmTemperature } }),
          );
        }

        assert.equal(fake.requests.length, cases.length);
        cases.forEach((item, index) => {
          const request = fake.requests[index];
          assert.ok(request);
          assert.equal(bodyOf(request).temperature, item.expected);
        });
      },
    );
  });

  test("非法温度（NaN / 非数字）回落全局 settings.temperature", async () => {
    await withFake(
      (_req, res) => sendOpenAi(res, OK_CONTENT),
      async (fake) => {
        const fallback = makeFallback();
        const brain = createLlmBrain(
          { ...SETTINGS, baseUrl: fake.baseUrl },
          fallback.brain,
        );
        const cat = catByRole("designer");

        await brain.think(
          makeContext({ cat: { ...cat, llmTemperature: Number.NaN } }),
        );
        await brain.think(
          makeContext({
            cat: { ...cat, llmTemperature: "hot" as unknown as number },
          }),
        );

        assert.equal(fake.requests.length, 2);
        for (const request of fake.requests) {
          assert.equal(bodyOf(request).temperature, SETTINGS.temperature);
        }
      },
    );
  });
});
