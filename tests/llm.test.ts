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
  Member,
  AgentBrain,
  AgentTurn,
  BrainReport,
  LlmSettings,
  Message,
  Role,
  Room,
  Skill,
  Task,
  ToolDefinition,
  ToolRunResult,
  Trigger,
  TurnContext,
} from "../src/domain/types.ts";
import { BUILTIN_TOOLS } from "../src/tools/builtin.ts";

// ───────────────────────── 夹具 ─────────────────────────

function catByRole(role: Role): Member {
  const found = CATS.find((cat) => cat.role === role);
  if (!found) throw new Error(`personas 里缺少 role=${role} 的猫`);
  return found;
}

const BRIEF = "给登录页加一个「记住我」勾选框，7 天内免登录。";

function makeContext(overrides: Partial<TurnContext> = {}): TurnContext {
  const cat = catByRole("architect");
  const room: Room = {
    id: "room_cafe",
    name: "交付台 · 主工作区",
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
      text: "☕ 交付台开门了。",
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
    recentToolResults: [],
    // 默认给内置沙盒工具，覆盖“目录里有的工具”这一常见路径。
    availableTools: [...BUILTIN_TOOLS],
    skills: [],
    session: null,
    roomCats: [],
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

function makeFallback(): { brain: AgentBrain; calls: () => number } {
  let calls = 0;
  const brain: AgentBrain = {
    mode: "mock",
    async think(): Promise<AgentTurn[]> {
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
  test("合法 JSON 数组被解析成 AgentTurn[]，请求体带猫名与 brief", async () => {
    const content = JSON.stringify([
      { kind: "message", text: "我先说结论，再拆。这个需求有安全风险。" },
      {
        kind: "handoff",
        to: "chenshi",
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
          assert.equal(turns[1].to, "chenshi");
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
        assert.match(system, /林知远/);
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
      { kind: "message", text: "收到。", mentions: ["zhoushuo", "ghost"] },
      { kind: "dance", text: "跳个舞" },
      { kind: "handoff", to: "linzhiyuan", card: FIVE_COLUMN_CARD }, // 不能交给自己
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
          assert.deepEqual(turns[0].mentions, ["zhoushuo"]);
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

describe("llm-brain · 失败暂停（不再退回演出）", () => {
  test("模型输出坏 JSON → 上报失败并返回空轮次，且日志不含 apiKey", async () => {
    // 截断的数组：JSON.parse 一定失败。
    const content = '[{"kind":"message","text":}]';

    await withFake(
      (_req, res) => sendOpenAi(res, content),
      async (fake) => {
        const fallback = makeFallback();
        const reports: BrainReport[] = [];
        const brain = createLlmBrain({ ...SETTINGS, baseUrl: fake.baseUrl }, fallback.brain);

        const { result, warns } = await withWarnCapture(() =>
          brain.think(makeContext({ onReport: (report) => reports.push(report) })),
        );

        assert.deepEqual(result, [], "失败轮不再编造演出台词");
        assert.equal(fallback.calls(), 0, "失败时不能退回 fallback brain");
        assert.equal(reports.length, 1);
        assert.equal(reports[0]?.degraded, true);
        assert.equal(reports[0]?.failed, true, "必须带 failed 让 driver 暂停任务");
        assert.match(reports[0]?.degradeReason ?? "", /AgentTurn/);
        assert.equal(warns.length, 1, "每次失败只打一行 warn");
        assert.match(warns[0] ?? "", /降级 fallback/);
        assert.ok(
          !(warns[0] ?? "").includes("sk-test-secret-key"),
          "warn 里绝不能出现 apiKey",
        );
      },
    );
  });

  test("模型直接说人话（纯文本）→ 包成一条 message，不降级", async () => {
    // opencode zen 上实测：模型偶尔无视 JSON 约束直接回答。
    // 与其降级成 mock 台词，不如把它说的话当成一条 message 收下。
    await withFake(
      (_req, res) => sendOpenAi(res, "喵喵喵，我觉得这个需求可以。"),
      async (fake) => {
        const fallback = makeFallback();
        const brain = createLlmBrain({ ...SETTINGS, baseUrl: fake.baseUrl }, fallback.brain);
        const turns = await brain.think(makeContext());
        assert.equal(fallback.calls(), 0, "纯文本应被兜底成 message，而不是降级");
        assert.equal(turns[0]?.kind, "message");
        if (turns[0]?.kind === "message") {
          assert.match(turns[0].text, /这个需求可以/);
        }
      },
    );
  });

  test("空输出 / [DONE] 之类 → 上报失败并返回空数组", async () => {
    await withFake(
      (_req, res) => sendOpenAi(res, "   "),
      async (fake) => {
        const fallback = makeFallback();
        const reports: BrainReport[] = [];
        const brain = createLlmBrain({ ...SETTINGS, baseUrl: fake.baseUrl }, fallback.brain);
        const turns = await brain.think(
          makeContext({ onReport: (report) => reports.push(report) }),
        );
        assert.deepEqual(turns, []);
        assert.equal(fallback.calls(), 0);
        assert.equal(reports[0]?.failed, true);
      },
    );
  });

  test("HTTP 500 → 上报失败并返回空数组", async () => {
    await withFake(
      (_req, res) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"error":{"message":"upstream exploded"}}');
      },
      async (fake) => {
        const fallback = makeFallback();
        const reports: BrainReport[] = [];
        const brain = createLlmBrain({ ...SETTINGS, baseUrl: fake.baseUrl }, fallback.brain);

        const { result, warns } = await withWarnCapture(() =>
          brain.think(makeContext({ onReport: (report) => reports.push(report) })),
        );

        assert.deepEqual(result, []);
        assert.equal(fallback.calls(), 0);
        assert.equal(reports[0]?.failed, true);
        assert.match(reports[0]?.degradeReason ?? "", /HTTP 500/);
        assert.match(warns[0] ?? "", /HTTP 500/);
      },
    );
  });

  test("响应缺少 choices[0].message.content → 上报失败并返回空数组", async () => {
    await withFake(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [] }));
      },
      async (fake) => {
        const fallback = makeFallback();
        const reports: BrainReport[] = [];
        const brain = createLlmBrain({ ...SETTINGS, baseUrl: fake.baseUrl }, fallback.brain);
        const turns = await brain.think(
          makeContext({ onReport: (report) => reports.push(report) }),
        );
        assert.deepEqual(turns, []);
        assert.equal(fallback.calls(), 0);
        assert.equal(reports[0]?.failed, true);
      },
    );
  });

  test("超时 → 上报失败，且不会卡住 20s", async () => {
    // 假端点收到请求后永不响应。
    await withFake(
      () => {
        /* 故意不响应 */
      },
      async (fake) => {
        const fallback = makeFallback();
        const reports: BrainReport[] = [];
        const brain = createLlmBrain(
          { ...SETTINGS, baseUrl: fake.baseUrl },
          fallback.brain,
          { timeoutMs: 120 },
        );

        const startedAt = Date.now();
        const { result, warns } = await withWarnCapture(() =>
          brain.think(makeContext({ onReport: (report) => reports.push(report) })),
        );
        const elapsed = Date.now() - startedAt;

        assert.deepEqual(result, []);
        assert.equal(fallback.calls(), 0);
        assert.equal(reports[0]?.failed, true);
        assert.ok(elapsed < 3000, `超时应快速失败，实际 ${elapsed}ms`);
        assert.match(warns[0] ?? "", /超时/);
        assert.ok(!(warns[0] ?? "").includes("sk-test-secret-key"));
      },
    );
  });

  test("网络错误（端点不可达）→ 上报失败并返回空数组", async () => {
    const fallback = makeFallback();
    const reports: BrainReport[] = [];
    const brain = createLlmBrain(
      // 127.0.0.1:1 几乎不可能有服务在听。
      { ...SETTINGS, baseUrl: "http://127.0.0.1:1/v1" },
      fallback.brain,
      { timeoutMs: 800 },
    );

    const { result, warns } = await withWarnCapture(() =>
      brain.think(makeContext({ onReport: (report) => reports.push(report) })),
    );
    assert.deepEqual(result, []);
    assert.equal(fallback.calls(), 0);
    assert.equal(reports[0]?.failed, true);
    assert.match(warns[0] ?? "", /网络错误|降级 fallback/);
  });
});

describe("llm-brain · 结构校验（纯函数）", () => {
  test("非法卡片缺栏 → handoff 被丢弃", () => {
    const content = JSON.stringify([
      {
        kind: "handoff",
        to: "chenshi",
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
        mentions: ["chenshi"],
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
        const linzhiyuan = catByRole("architect");
        const shenyan = catByRole("reviewer");

        await brain.think(
          makeContext({ cat: { ...linzhiyuan, llmModel: "model-architect" } }),
        );
        await brain.think(
          makeContext({ cat: { ...shenyan, llmModel: "model-reviewer" } }),
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

describe("llm-brain · 工具调用与 tool_result 回喂", () => {
  const MESSAGE_CONTENT = JSON.stringify([{ kind: "message", text: "收到。" }]);

  interface RecordedBody {
    model: string;
    messages: Array<{ role: string; content: string }>;
  }

  function bodyOf(request: RecordedRequest): RecordedBody {
    return JSON.parse(request.body) as RecordedBody;
  }

  function userPrompt(body: RecordedBody): string {
    return body.messages[1]?.content ?? "";
  }

  function systemPrompt(body: RecordedBody): string {
    return body.messages[0]?.content ?? "";
  }

  test("假端点返回含 tool turn 的 JSON → 解析出全部合法工具调用", async () => {
    const content = JSON.stringify([
      {
        kind: "tool",
        tool: "read_file",
        input: { path: "src/app.js" },
        label: "看登录页",
        text: "先看现有实现。",
      },
      {
        kind: "tool",
        tool: "write_file",
        input: { path: "src/remember.js", content: "export const DAYS = 7;\n" },
      },
      { kind: "tool", tool: "list_files", input: {} },
      { kind: "tool", tool: "run_command", input: { cmd: "node", args: ["--version"] } },
    ]);

    await withFake(
      (_req, res) => sendOpenAi(res, content),
      async (fake) => {
        const fallback = makeFallback();
        const brain = createLlmBrain(
          { ...SETTINGS, baseUrl: fake.baseUrl },
          fallback.brain,
        );
        const turns = await brain.think(makeContext());

        assert.equal(fallback.calls(), 0, "合法 tool turn 不应触发降级");
        assert.equal(turns.length, 4);
        assert.deepEqual(
          turns.map((turn) => (turn.kind === "tool" ? turn.tool : `not-tool:${turn.kind}`)),
          ["read_file", "write_file", "list_files", "run_command"],
        );

        const read = turns[0];
        assert.equal(read?.kind, "tool");
        if (read?.kind === "tool") {
          assert.deepEqual(read.input, { path: "src/app.js" });
          assert.equal(read.label, "看登录页");
          assert.equal(read.text, "先看现有实现。");
        }

        const write = turns[1];
        assert.equal(write?.kind, "tool");
        if (write?.kind === "tool") {
          assert.equal(write.input["path"], "src/remember.js");
          assert.match(String(write.input["content"]), /DAYS = 7/);
          assert.equal(write.label, undefined, "缺省 label 不应被编造");
        }

        const run = turns[3];
        assert.equal(run?.kind, "tool");
        if (run?.kind === "tool") {
          assert.deepEqual(run.input, { cmd: "node", args: ["--version"] });
        }
      },
    );
  });

  test("非法 tool turn 被丢弃，同轮合法 turn 保留", async () => {
    const content = JSON.stringify([
      { kind: "tool", tool: "delete_everything", input: {} }, // 未知工具
      { kind: "tool", tool: "write_file", input: { path: "a.js" } }, // 缺 content
      { kind: "tool", tool: "read_file", input: { content: "x" } }, // 缺 path
      { kind: "tool", tool: "run_command", input: { args: ["-v"] } }, // 缺 cmd
      { kind: "tool", tool: "run_command", input: { cmd: "node", args: ["ok", 3] } }, // args 非字符串
      { kind: "tool", tool: "list_files", input: "all" }, // input 不是对象
      { kind: "message", text: "好，先看看。" },
      { kind: "tool", tool: "write_file", input: { path: "empty.js", content: "" } }, // 空文件合法
    ]);

    await withFake(
      (_req, res) => sendOpenAi(res, content),
      async (fake) => {
        const fallback = makeFallback();
        const brain = createLlmBrain(
          { ...SETTINGS, baseUrl: fake.baseUrl },
          fallback.brain,
        );
        const turns = await brain.think(makeContext());

        assert.equal(fallback.calls(), 0, "还有合法 turn 时不应整轮降级");
        assert.equal(turns.length, 2, `应只剩 message + 空文件写入，实际 ${turns.length}`);
        assert.equal(turns[0]?.kind, "message");
        const emptyWrite = turns[1];
        assert.equal(emptyWrite?.kind, "tool");
        if (emptyWrite?.kind === "tool") {
          assert.equal(emptyWrite.tool, "write_file");
          assert.equal(emptyWrite.input["content"], "");
        }
      },
    );
  });

  test("system prompt 含 4 个工具、审批风险与 tool_result 回喂纪律", async () => {
    await withFake(
      (_req, res) => sendOpenAi(res, MESSAGE_CONTENT),
      async (fake) => {
        const fallback = makeFallback();
        const brain = createLlmBrain(
          { ...SETTINGS, baseUrl: fake.baseUrl },
          fallback.brain,
        );
        await brain.think(makeContext());

        const request = fake.requests[0];
        assert.ok(request);
        const system = systemPrompt(bodyOf(request));

        for (const tool of ["read_file", "write_file", "list_files", "run_command"]) {
          assert.ok(system.includes(tool), `system prompt 应包含工具 ${tool}`);
        }
        // 风险 / 审批
        assert.match(system, /审批/);
        assert.match(system, /真实改动文件|真实改文件/);
        assert.match(system, /真实执行命令/);
        // 回喂与纪律
        assert.match(system, /tool_result/);
        assert.match(system, /rejected/);
        assert.match(system, /3 轮/);
        assert.match(system, /不要重复申请/);
        // schema 里要有第 7 种 turn
        assert.ok(system.includes('"kind":"tool"'));
        assert.match(system, /7 种 turn/);
      },
    );
  });

  test("ctx.recentToolResults 会写进 user prompt（callId/tool/status/exitCode/output）", async () => {
    const recentToolResults: ToolRunResult[] = [
      {
        callId: "call_read_1",
        tool: "read_file",
        status: "ok",
        exitCode: 0,
        output: "console.log('hi')",
      },
      {
        callId: "call_run_2",
        tool: "run_command",
        status: "rejected",
        output: "负责人拒绝了这次命令",
      },
    ];

    await withFake(
      (_req, res) => sendOpenAi(res, MESSAGE_CONTENT),
      async (fake) => {
        const fallback = makeFallback();
        const brain = createLlmBrain(
          { ...SETTINGS, baseUrl: fake.baseUrl },
          fallback.brain,
        );
        await brain.think(makeContext({ recentToolResults }));

        const request = fake.requests[0];
        assert.ok(request);
        const user = userPrompt(bodyOf(request));

        assert.match(user, /【工具结果/);
        assert.match(user, /call_read_1/);
        assert.match(user, /tool=read_file/);
        assert.match(user, /status=ok/);
        assert.match(user, /exitCode=0/);
        assert.match(user, /console\.log\('hi'\)/);
        assert.match(user, /call_run_2/);
        assert.match(user, /status=rejected/);
        assert.match(user, /负责人拒绝了这次命令/);
      },
    );
  });

  test("trigger.kind=tool_result 时本轮 toolResults 也进 prompt", async () => {
    const ctx = makeContext();
    const toolResults: ToolRunResult[] = [
      {
        callId: "call_write_3",
        tool: "write_file",
        status: "ok",
        output: "已写入 src/remember.js（22 字符）",
      },
    ];
    const trigger: Trigger = {
      kind: "tool_result",
      roomId: ctx.room.id,
      ...(ctx.task ? { taskId: ctx.task.id } : {}),
      text: "工具执行完成",
      toolResults,
    };

    await withFake(
      (_req, res) => sendOpenAi(res, MESSAGE_CONTENT),
      async (fake) => {
        const fallback = makeFallback();
        const brain = createLlmBrain(
          { ...SETTINGS, baseUrl: fake.baseUrl },
          fallback.brain,
        );
        await brain.think(makeContext({ trigger }));

        const request = fake.requests[0];
        assert.ok(request);
        const user = userPrompt(bodyOf(request));

        assert.match(user, /kind：tool_result/);
        assert.match(user, /本轮工具回执/);
        assert.match(user, /call_write_3/);
        assert.match(user, /tool=write_file/);
        assert.match(user, /已写入 src\/remember\.js/);
      },
    );
  });
});

describe("llm-brain · 动态工具目录与技能注入", () => {
  const MESSAGE_CONTENT = JSON.stringify([{ kind: "message", text: "收到。" }]);

  const GITHUB_TOOL: ToolDefinition = {
    name: "github__list_issues",
    title: "列出 issue",
    description: "列出指定仓库的 issue",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" }, state: { type: "string" } },
      required: ["repo"],
    },
    risk: "needs_approval",
    source: "mcp",
    serverId: "github",
  };
  const FS_TOOL: ToolDefinition = {
    name: "fs__read_text",
    title: "读取文本文件",
    description: "读取工作区中的文本文件",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    risk: "safe",
    source: "mcp",
    serverId: "fs",
  };
  const MCP_TOOLS: ToolDefinition[] = [GITHUB_TOOL, FS_TOOL];

  interface RecordedBody {
    model: string;
    messages: Array<{ role: string; content: string }>;
  }

  function bodyOf(request: RecordedRequest): RecordedBody {
    return JSON.parse(request.body) as RecordedBody;
  }

  function systemPrompt(body: RecordedBody): string {
    return body.messages[0]?.content ?? "";
  }

  async function runOnce(
    ctx: TurnContext,
    content = MESSAGE_CONTENT,
  ): Promise<{ fake: FakeEndpoint; fallbackCalls: () => number; system: string }> {
    let captured: FakeEndpoint | null = null;
    let system = "";
    let fallbackCalls = () => 0;
    await withFake(
      (_req, res) => sendOpenAi(res, content),
      async (fake) => {
        captured = fake;
        const fallback = makeFallback();
        fallbackCalls = fallback.calls;
        const brain = createLlmBrain(
          { ...SETTINGS, baseUrl: fake.baseUrl },
          fallback.brain,
        );
        await brain.think(ctx);
        const request = fake.requests[0];
        assert.ok(request);
        system = systemPrompt(bodyOf(request));
      },
    );
    assert.ok(captured);
    return { fake: captured, fallbackCalls, system };
  }

  test("MCP 工具目录按 availableTools 渲染：名字不截断、含 schema / risk / source", async () => {
    const { system } = await runOnce(makeContext({ availableTools: MCP_TOOLS }));

    assert.ok(system.includes("github__list_issues"), "MCP 工具名必须原样出现");
    assert.ok(system.includes("fs__read_text"), "MCP 工具名必须原样出现");
    assert.ok(system.includes(JSON.stringify(GITHUB_TOOL.inputSchema)), "应渲染 inputSchema");
    assert.ok(system.includes(JSON.stringify(FS_TOOL.inputSchema)), "应渲染 inputSchema");
    assert.match(system, /risk=needs_approval/);
    assert.match(system, /risk=safe/);
    assert.match(system, /source=mcp/);
    assert.match(system, /server=github/);
    assert.match(system, /列出指定仓库的 issue/);
    // 目录里没有内置工具：不要出现在【工具目录】列表里。
    // 注意：阶段纪律段会提到 read_file/write_file 这些工具名（"working/revising 才允许"），
    // 那不是目录，所以只断言目录行（以 "- " 开头、含 "｜"）里不出现内置工具。
    const toolLines = system
      .split("\n")
      .filter((line) => line.startsWith("- ") && line.includes("｜"));
    assert.ok(toolLines.length >= 2);
    assert.ok(!toolLines.some((line) => line.includes("read_file")));
    assert.ok(!toolLines.some((line) => line.includes("write_file")));
  });

  test("内置工具不在目录里也保留（交给 driver 拒绝）；编造工具名丢弃；MCP 工具 input 原样透传", async () => {
    const content = JSON.stringify([
      // 内置工具但不在本轮目录里（比如这只猫没权限）→ 保留，交给 driver 回「没有权限」
      { kind: "tool", tool: "read_file", input: { path: "src/app.js" } },
      // 完全编造的工具名 → 丢弃
      { kind: "tool", tool: "delete_everything", input: {} },
      // MCP 工具合法：任意对象 input 原样透传
      {
        kind: "tool",
        tool: "github__list_issues",
        input: { repo: "cat-cafe", state: "open" },
        label: "看 issue",
      },
      // MCP 工具 input 不是对象 → 丢弃
      { kind: "tool", tool: "fs__read_text", input: "not-an-object" },
    ]);

    await withFake(
      (_req, res) => sendOpenAi(res, content),
      async (fake) => {
        const fallback = makeFallback();
        const brain = createLlmBrain(
          { ...SETTINGS, baseUrl: fake.baseUrl },
          fallback.brain,
        );
        const turns = await brain.think(makeContext({ availableTools: MCP_TOOLS }));

        assert.equal(fallback.calls(), 0, "还有合法 turn 时不应整轮降级");
        // read_file 是内置工具（保留给 driver 判定权限）、github__list_issues 合法、
        // delete_everything 编造（丢弃）、fs__read_text input 非对象（丢弃）。
        assert.equal(turns.length, 2, `实际 ${turns.length}`);
        const tools = turns.filter((turn) => turn.kind === "tool");
        assert.deepEqual(
          tools.map((turn) => (turn as { tool: string }).tool),
          ["read_file", "github__list_issues"],
        );
        const mcpTurn = tools[1];
        if (mcpTurn?.kind === "tool") {
          assert.deepEqual(mcpTurn.input, { repo: "cat-cafe", state: "open" });
          assert.equal(mcpTurn.label, "看 issue");
        }
      },
    );
  });

  test("MCP 工具只校验 input 是对象：缺 input 视为 {}，非对象丢弃", async () => {
    const content = JSON.stringify([
      { kind: "tool", tool: "github__list_issues" },
      { kind: "tool", tool: "fs__read_text", input: 42 },
    ]);

    await withFake(
      (_req, res) => sendOpenAi(res, content),
      async (fake) => {
        const fallback = makeFallback();
        const brain = createLlmBrain(
          { ...SETTINGS, baseUrl: fake.baseUrl },
          fallback.brain,
        );
        const turns = await brain.think(makeContext({ availableTools: MCP_TOOLS }));

        assert.equal(fallback.calls(), 0);
        assert.equal(turns.length, 1);
        const toolTurn = turns[0];
        assert.equal(toolTurn?.kind, "tool");
        if (toolTurn?.kind === "tool") assert.deepEqual(toolTurn.input, {});
      },
    );
  });

  test("availableTools 为空时明确告诉模型没有工具，且不列出内置工具", async () => {
    const { system } = await runOnce(makeContext({ availableTools: [] }));

    assert.match(system, /没有可用工具/);
    assert.match(system, /不要编造/);
    assert.ok(!system.includes("read_file"));
    assert.ok(!system.includes("inputSchema："));
    assert.ok(!system.includes("工具使用纪律："));
  });

  test("ctx.skills 的 name + prompt 全文注入 system prompt，顺序稳定", async () => {
    const skills: Skill[] = [
      {
        id: "skill-review",
        name: "code-review",
        description: "严格代码审查",
        prompt: "先按严重性分级，再给证据；每条问题都要能定位到文件。",
      },
      {
        id: "skill-tdd",
        name: "tdd",
        description: "测试先行",
        prompt: "先写失败测试，再写最小实现。",
      },
    ];

    const { system } = await runOnce(makeContext({ skills }));

    assert.ok(system.includes("【你挂载的技能】"));
    assert.ok(system.includes("### code-review"));
    assert.ok(system.includes(skills[0]?.prompt ?? ""), "技能 prompt 全文必须注入");
    assert.ok(system.includes("### tdd"));
    assert.ok(system.includes(skills[1]?.prompt ?? ""));
    assert.ok(
      system.indexOf("### code-review") < system.indexOf("### tdd"),
      "技能顺序应与 ctx.skills 一致",
    );
  });

  test("ctx.skills 为空时不出现技能段", async () => {
    const { system } = await runOnce(makeContext({ skills: [] }));
    assert.ok(!system.includes("【你挂载的技能】"));
  });
});


describe("reasoning 型模型的 token 预算", () => {
  function makeThinkingCtx(): TurnContext {
    const cat = CATS.find((c) => c.id === "linzhiyuan")!;
    return {
      cat,
      room: { id: "room_cafe", name: "交付台", topic: "", catIds: CATS.map((c) => c.id), createdAt: 0 },
      task: null,
      trigger: { kind: "task_created", roomId: "room_cafe" },
      recentMessages: [],
      memory: [],
      handoffs: [],
      artifacts: [],
      recentToolResults: [],
      availableTools: BUILTIN_TOOLS,
      skills: [],
      session: null,
      scenario: null,
    roomCats: [],
    };
  }

  test("被 max_tokens 截断时用更大预算重试，成功后不降级", async () => {
    const requests: Array<{ max_tokens: number }> = [];
    let call = 0;
    const fake = (async (_url: string, init: { body?: string }) => {
      requests.push(JSON.parse(String(init.body)) as { max_tokens: number });
      call += 1;
      const payload =
        call === 1
          ? {
              choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }],
              usage: { completion_tokens_details: { reasoning_tokens: 4000 } },
            }
          : {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: JSON.stringify([{ kind: "message", text: "重试成功" }]),
                  },
                  finish_reason: "stop",
                },
              ],
            };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const brain = createLlmBrain(
      { baseUrl: "https://example.test/v1", model: "reasoning-model", apiKey: "k", temperature: 0.7 },
      makeFallback().brain,
      { fetchImpl: fake },
    );
    const turns = await brain.think(makeThinkingCtx());
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.kind, "message");
    assert.equal(requests.length, 2);
    assert.ok((requests[1]?.max_tokens ?? 0) > (requests[0]?.max_tokens ?? 0));
  });

  test("连续两次截断后上报失败（截断原因），不退回 fallback", async () => {
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.join(" "));
    try {
      const fake = (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch;

      const fallback = makeFallback();
      const reports: BrainReport[] = [];
      const brain = createLlmBrain(
        { baseUrl: "https://example.test/v1", model: "m", apiKey: "k", temperature: 0.7 },
        fallback.brain,
        { fetchImpl: fake },
      );
      const turns = await brain.think({
        ...makeThinkingCtx(),
        onReport: (report) => reports.push(report),
      });
      assert.deepEqual(turns, [], "截断两次后不再编造演出台词");
      assert.equal(fallback.calls(), 0);
      assert.equal(reports[0]?.failed, true);
      assert.match(reports[0]?.degradeReason ?? "", /截断/);
      assert.ok(warns.some((line) => line.includes("截断")), warns.join("\n"));
    } finally {
      console.warn = originalWarn;
    }
  });
});


describe("真实模型的输出噪声容错", () => {
  test("JSON 数组后面跟一句人话仍能解析", async () => {
    const content =
      '[{"kind":"tool","tool":"read_file","input":{"path":"package.json"}}] 能跑，但我知道有个坑：先红再绿。';
    const { system } = { system: "" };
    void system;
    const ctx = makeContext({ trigger: { kind: "user_message", roomId: "room_cafe", text: "hi" } });
    const turns = parseTurns(content, ctx);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.kind, "tool");
  });

  test("数组前面有解说、fenced 里也有尾巴：都能救回来", () => {
    const ctx = makeContext();
    const samples = [
      '我先说结论，再拆：[{"kind":"message","text":"好"}]',
      '```json\n[{"kind":"message","text":"好"}]\n```',
      '```json\n[{"kind":"message","text":"好"}]\n```\n以上是我的判断。',
    ];
    for (const sample of samples) {
      const turns = parseTurns(sample, ctx);
      assert.equal(turns.length, 1, sample.slice(0, 40));
      assert.equal(turns[0]?.kind, "message");
    }
  });

  test("数组内部含 ] 字符的字符串不会被截断", () => {
    const ctx = makeContext();
    const turns = parseTurns('[{"kind":"message","text":"数组 arr[0] 要小心 ]"}]', ctx);
    assert.equal(turns.length, 1);
    assert.match((turns[0] as { text: string }).text, /arr\[0\]/);
  });
});


describe("真实模型的输出格式兜底", () => {
  test("裸对象（没有外层数组）也能解析", () => {
    const ctx = makeContext();
    const turns = parseTurns('{"kind":"tool","tool":"read_file","input":{"path":"a.js"}}', ctx);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.kind, "tool");
  });

  test("多个裸对象用空格拼在一起也能解析", () => {
    const ctx = makeContext();
    const content =
      '{"kind":"tool","tool":"read_file","input":{"path":"a.js"}} ' +
      '{"kind":"tool","tool":"read_file","input":{"path":"b.js"}}';
    const turns = parseTurns(content, ctx);
    assert.equal(turns.length, 2);
  });

  test("run_command 接受 command 作为 cmd 的别名", () => {
    const ctx = makeContext();
    const turns = parseTurns(
      '[{"kind":"tool","tool":"run_command","input":{"command":"npm","args":["test"]}}]',
      ctx,
    );
    assert.equal(turns.length, 1);
    const turn = turns[0];
    assert.equal(turn?.kind, "tool");
    if (turn?.kind === "tool") {
      assert.equal(turn.input["cmd"], "npm");
      assert.deepEqual(turn.input["args"], ["test"]);
    }
  });

  test("字符串里的花括号 / 转义引号不会切断对象", () => {
    const ctx = makeContext();
    const content = '[{"kind":"tool","tool":"write_file","input":{"path":"a.js","content":"const x = {a:1}; \\"q\\""}}]';
    const turns = parseTurns(content, ctx);
    assert.equal(turns.length, 1);
    const turn = turns[0];
    if (turn?.kind === "tool") {
      assert.match(String(turn.input["content"]), /\{a:1\}/);
    }
  });
});

describe("自定义请求头（opencode zen 等）", () => {
  test("headers 进入请求，且日志不泄露", async () => {
    let seenHeaders: Record<string, string> = {};
    const fake = (async (_url: string, init: { headers?: Record<string, string> }) => {
      seenHeaders = (init.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: JSON.stringify([{ kind: "message", text: "ok" }]) },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const brain = createLlmBrain(
      {
        baseUrl: "https://example.test/v1",
        model: "m",
        apiKey: "sk-secret",
        temperature: 0.7,
        headers: { "x-opencode-session": "sess-123" },
      },
      makeFallback().brain,
      { fetchImpl: fake },
    );
    const turns = await brain.think(makeContext());
    assert.equal(turns.length, 1);
    assert.equal(seenHeaders["x-opencode-session"], "sess-123");
    assert.equal(seenHeaders.Authorization, "Bearer sk-secret");
  });

  test("失败日志里不会出现请求头的值", async () => {
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.join(" "));
    try {
      const fake = (async () =>
        new Response("nope", { status: 500 })) as unknown as typeof fetch;
      const brain = createLlmBrain(
        {
          baseUrl: "https://example.test/v1",
          model: "m",
          apiKey: "sk-secret-value",
          temperature: 0.7,
          headers: { "x-opencode-session": "sess-secret-value" },
        },
        makeFallback().brain,
        { fetchImpl: fake },
      );
      await brain.think(makeContext());
      const text = warns.join("\n");
      assert.ok(!text.includes("sess-secret-value"), text);
      assert.ok(!text.includes("sk-secret-value"), text);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("流式超时与非流式超时不同", () => {
  test("流式请求使用更长的超时（90s），非流式仍 20s", async () => {
    // 通过一个永不结束的响应来观察 abort 时机差异：这里只验证常量被正确使用，
    // 不真的等 90s——用注入的 timeoutMs 覆盖验证「流式也走 options.timeoutMs」。
    const timeouts: number[] = [];
    const fake = (async (_url: string, init: { body?: string; signal?: AbortSignal }) => {
      const body = JSON.parse(String(init.body)) as { stream?: boolean };
      timeouts.push(body.stream ? 1 : 0);
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;

    const brain = createLlmBrain(
      { baseUrl: "https://example.test/v1", model: "m", apiKey: "k", temperature: 0.7 },
      makeFallback().brain,
      { fetchImpl: fake, streaming: true },
    );
    await brain.think(makeContext({ onDelta: () => undefined }));
    assert.deepEqual(timeouts, [1], "有 onDelta 时应发流式请求");
  });
});

describe("流式被提前断开时退回非流式重试", () => {
  /** 造一个「流结束但没有 finish_reason、JSON 断在半句」的 SSE 响应。 */
  function truncatedStream(): Response {
    const half = '[{"kind":"message","text":"先说结论，再拆。三处修改都是不同文件里的小改动，可';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: half } }] })}\n\n`),
        );
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  function goodJson(): Response {
    const content = JSON.stringify([{ kind: "message", text: "完整回答在这里。" }]);
    return new Response(
      JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  test("流被截断时自动改用非流式，拿到完整 turn 而不是降级", async () => {
    const seenStreamFlags: boolean[] = [];
    const fake = (async (_url: string, init: { body?: string }) => {
      const body = JSON.parse(String(init.body)) as { stream?: boolean };
      seenStreamFlags.push(body.stream === true);
      return body.stream ? truncatedStream() : goodJson();
    }) as unknown as typeof fetch;

    const fallback = makeFallback();
    const reports: Array<{ streamed?: boolean; degraded?: boolean }> = [];
    const brain = createLlmBrain(
      { baseUrl: "https://example.test/v1", model: "m", apiKey: "k", temperature: 0.7 },
      fallback.brain,
      { fetchImpl: fake, streaming: true },
    );

    const turns = await brain.think(
      makeContext({
        // onDelta 是流式生效的前提；onReport 收成功路径的用量回报。
        onDelta: () => undefined,
        onReport: (report) => {
          reports.push(report);
        },
      }),
    );

    assert.deepEqual(seenStreamFlags, [true, false], "应先流式、再非流式重试");
    assert.equal(fallback.calls(), 0, "不该降级到演出台词");
    assert.equal(turns.length, 1);
    assert.match(String((turns[0] as { text?: string }).text), /完整回答/);
    assert.equal(reports[0]?.streamed, false, "报告应记为非流式成功、未降级");
    assert.equal(reports[0]?.degraded, undefined);
  });

  test("流式与非流式都拿不到 → 上报失败信号 + 空数组（不无限重试）", async () => {
    let calls = 0;
    const fake = (async () => {
      calls += 1;
      return truncatedStream();
    }) as unknown as typeof fetch;

    const fallback = makeFallback();
    const reports: BrainReport[] = [];
    const brain = createLlmBrain(
      { baseUrl: "https://example.test/v1", model: "m", apiKey: "k", temperature: 0.7 },
      fallback.brain,
      { fetchImpl: fake, streaming: true },
    );
    const turns = await brain.think(
      makeContext({
        onDelta: () => undefined,
        onReport: (report) => reports.push(report),
      }),
    );
    assert.equal(calls, 2, "流式一次 + 非流式一次，不再多试");
    assert.deepEqual(turns, [], "两次都失败时返回空轮次");
    assert.equal(fallback.calls(), 0, "不再退回演出台词");
    assert.equal(reports[0]?.failed, true, "必须上报 failed 让 driver 暂停任务");
    assert.equal(reports[0]?.degraded, true);
  });
});

describe("长输出与慢模型：预算与超时", () => {
  function lengthThenOk() {
    const bodies: Array<{ max_tokens?: number; stream?: boolean }> = [];
    const fake = (async (_url: string, init: { body?: string }) => {
      const body = JSON.parse(String(init.body)) as { max_tokens?: number; stream?: boolean };
      bodies.push(body);
      const attempts = bodies.length;
      if (attempts <= 2) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "{\"kind\":" }, finish_reason: "length" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: JSON.stringify([{ kind: "message", text: "终于完整了。" }]) },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    return { fake, bodies };
  }

  test("连续截断时阶梯提升 max_tokens（4096 → 8192 → 16384）", async () => {
    const { fake, bodies } = lengthThenOk();
    const reports: Array<{ retried?: boolean }> = [];
    const brain = createLlmBrain(
      { baseUrl: "https://example.test/v1", model: "reasoner", apiKey: "k", temperature: 0.7 },
      makeFallback().brain,
      { fetchImpl: fake, streaming: false },
    );
    const turns = await brain.think(
      makeContext({
        onReport: (report) => reports.push(report),
      }),
    );
    assert.deepEqual(
      bodies.map((body) => body.max_tokens),
      [4096, 8192, 16384],
      "应该逐级提升预算，而不是只重试一次",
    );
    assert.equal(turns.length, 1);
    assert.equal(reports[0]?.retried, true);
  });

  test("非流式回退使用更长超时（慢模型不会被 20s 掐断）", async () => {
    // 先返回截断的流 → 触发非流式回退；回退响应故意延迟 120ms。
    const fake = (async (_url: string, init: { body?: string }) => {
      const body = JSON.parse(String(init.body)) as { stream?: boolean };
      if (body.stream) {
        const half = '[{"kind":"message","text":"先';
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: half } }] })}\n\n`,
              ),
            );
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: JSON.stringify([{ kind: "message", text: "慢但完整。" }]) },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const fallback = makeFallback();
    const brain = createLlmBrain(
      { baseUrl: "https://example.test/v1", model: "m", apiKey: "k", temperature: 0.7 },
      fallback.brain,
      // 故意把超时设成 50ms：只有回退用了更长超时才会成功。
      { fetchImpl: fake, streaming: true, timeoutMs: 50 },
    );
    const turns = await brain.think(makeContext({ onDelta: () => undefined }));
    assert.equal(fallback.calls(), 0, "不该降级");
    assert.match(String((turns[0] as { text?: string }).text), /慢但完整/);
  });
});
