/**
 * 引擎测试（T1）：用**脚本化假 brain**验证状态机、@路由、延迟调度、
 * 漏 @ 故障恢复与落库格式——不依赖 T2 的 mock-brain 进度。
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import type {
  ApprovalGate,
  BrainMode,
  AgentBrain,
  MemberId,
  AgentTurn,
  HandoffCard,
  SandboxRunner,
  Skill,
  Task,
  TaskStage,
  ToolApprovalDecision,
  ToolApprovalMode,
  ToolDefinition,
  ToolName,
  ToolRegistry,
  ToolResult,
  ToolRunResult,
  TurnContext,
} from "../src/domain/types.ts";
import { createMockBrain } from "../src/agents/mock-brain.ts";
import { createDriver } from "../src/engine/driver.ts";
import {
  handoffMentions,
  normalizeMentions,
  parseMentions,
  routeUserMessage,
} from "../src/engine/mentions.ts";
import { Studio } from "../src/server/studio.ts";

const ROOM_ID = "room_cafe";
const SCENARIO_ID = "remember_me";

// ───────────────────────── 测试工具 ─────────────────────────

/**
 * think 时的快照记录。注意 TurnContext.task 是活引用（引擎会继续推进它），
 * 所以测试必须在调用当时记录 stage，不能用 call.task.stage 事后判断。
 */
interface CallRecord extends TurnContext {
  stageAtCall: TaskStage | null;
}

interface ScriptedBrain extends AgentBrain {
  calls: CallRecord[];
  callsFor(catId: MemberId, stage?: TaskStage): CallRecord[];
}

function scriptedBrain(
  handler: (ctx: TurnContext) => AgentTurn[],
  mode: BrainMode = "mock",
): ScriptedBrain {
  const calls: CallRecord[] = [];
  return {
    mode,
    calls,
    callsFor(catId, stage) {
      return calls.filter(
        (call) => call.cat.id === catId && (stage === undefined || call.stageAtCall === stage),
      );
    },
    async think(ctx) {
      calls.push({ ...ctx, stageAtCall: ctx.task?.stage ?? null });
      return handler(ctx);
    },
  };
}

function makeStudio(): Studio {
  return new Studio({ cats: CATS.map((cat) => ({ ...cat })), mode: "mock" });
}

/** 构造带猫档案覆盖（tools / skills）的 Studio，覆盖 tools: undefined 表示「全部允许」。 */
function makeStudioWith(
  overrides: Record<MemberId, { tools?: string[]; skills?: string[] }>,
): Studio {
  return new Studio({
    cats: CATS.map((cat) => ({ ...cat, ...(overrides[cat.id] ?? {}) })),
    mode: "mock",
  });
}

function makeDriver(
  studio: Studio,
  brain: AgentBrain,
  extra: {
    sandbox?: SandboxRunner;
    toolsEnabled?: () => boolean;
    approvals?: ApprovalGate;
    approvalMode?: () => ToolApprovalMode;
    tools?: ToolRegistry;
    resolveSkill?: (id: string) => Skill | undefined;
  } = {},
) {
  return createDriver({
    studio,
    brain,
    wait: async () => {},
    stallMs: 60_000,
    ...extra,
  });
}

interface FakeSandbox extends SandboxRunner {
  calls: Array<{ tool: ToolName; input: Record<string, unknown> }>;
}

function fakeSandbox(
  handler: (tool: ToolName, input: Record<string, unknown>) => ToolResult = () => ({
    status: "ok",
    exitCode: 0,
    output: "ok",
  }),
): FakeSandbox {
  const calls: FakeSandbox["calls"] = [];
  return {
    calls,
    async execute(tool, input) {
      calls.push({ tool, input });
      return handler(tool, input);
    },
  };
}

interface FakeRegistry extends ToolRegistry {
  executed: Array<{ name: ToolName; input: Record<string, unknown> }>;
}

function fakeRegistry(
  defs: ToolDefinition[],
  handler: (name: ToolName, input: Record<string, unknown>) => ToolResult = () => ({
    status: "ok",
    output: "ok",
  }),
): FakeRegistry {
  const executed: FakeRegistry["executed"] = [];
  return {
    executed,
    list: () => [...defs],
    get: (name) => defs.find((definition) => definition.name === name),
    async execute(name, input) {
      executed.push({ name, input });
      return handler(name, input);
    },
  };
}

const READ_FILE_DEF: ToolDefinition = {
  name: "read_file",
  title: "读取文件",
  description: "读取沙盒文件",
  inputSchema: { type: "object" },
  risk: "safe",
  source: "sandbox",
};

const MCP_WEATHER_DEF: ToolDefinition = {
  name: "mcp.weather",
  title: "查天气",
  description: "通过 MCP 查城市天气",
  inputSchema: { type: "object", properties: { city: { type: "string" } } },
  risk: "needs_approval",
  source: "mcp",
  serverId: "weather-1",
};

interface FakeApprovalRequest {
  callId: string;
  mode: ToolApprovalMode;
  tool: ToolName;
  label: string;
  catId: MemberId;
}

interface FakeApprovals extends ApprovalGate {
  requests: FakeApprovalRequest[];
}

function fakeApprovals(
  decide:
    | ToolApprovalDecision
    | ((input: FakeApprovalRequest) => ToolApprovalDecision | Promise<ToolApprovalDecision>) = "approved",
): FakeApprovals {
  const requests: FakeApprovalRequest[] = [];
  return {
    requests,
    async request(input) {
      requests.push(input);
      return typeof decide === "function" ? await decide(input) : decide;
    },
    resolve() {
      return false;
    },
  };
}

function newTask(studio: Studio): Task {
  return studio.createTask({
    roomId: ROOM_ID,
    brief: "给登录页加一个「记住我」勾选框，7 天内免登录。",
    scenarioId: SCENARIO_ID,
  });
}

function card(what: string): HandoffCard {
  return {
    what,
    why: "为了让登录链路一次做对",
    tradeoff: "多一个持久化字段换安全性",
    openQuestions: ["token 放 cookie 还是 header？"],
    nextAction: "跑完这步交给下一只猫",
  };
}

const message = (text: string, mentions?: MemberId[]): AgentTurn => ({
  kind: "message",
  text,
  ...(mentions ? { mentions } : {}),
});

function taskMessages(studio: Studio, taskId: string) {
  return studio.state.messages.filter((m) => m.taskId === taskId);
}

/** 完整六阶段剧本：intake → planning(2 handoff) → working → review 打回 → revise v2 → approve → decision。 */
function demoBrain(options: { fault?: boolean } = {}): ScriptedBrain {
  let reviewCalls = 0;
  return scriptedBrain((ctx) => {
    const stage = ctx.task?.stage ?? null;
    const cat = ctx.cat.id;

    if (cat === "linzhiyuan") {
      if (ctx.trigger.kind === "nudge") {
        return [message("我查一下——刚才那次交接没递到，我补一下。")];
      }
      if (stage === "intake") {
        return [message("我先接住：登录页加「记住我」，7 天免登录。风险是安全和过期策略。")];
      }
      if (stage === "planning") {
        return [
          {
            kind: "handoff",
            to: "zhoushuo",
            card: card("设计勾选框状态与文案"),
            text: "@周烁 交互交给你。",
          },
          {
            kind: "handoff",
            to: "chenshi",
            card: card("实现后端 remember-me token"),
            text: "@陈实 后端交给你。",
          },
        ];
      }
      if (stage === "done") {
        return [
          {
            kind: "decision",
            artifact: {
              title: "记住我方案定稿",
              body: "remember-me token 7 天过期，HttpOnly cookie。",
            },
            text: "决定落一下：token 7 天过期，HttpOnly cookie。",
            memory: [
              {
                kind: "decision",
                title: "remember-me token 7 天过期",
                body: "过期时间由服务端控制。",
                tags: ["auth", "remember-me"],
              },
              {
                kind: "lesson",
                title: "token 必须带过期时间",
                body: "review 抓到的 blocker。",
                tags: ["security"],
              },
            ],
          },
        ];
      }
      return [];
    }

    if (cat === "zhoushuo" && stage === "working") {
      return [
        {
          kind: "artifact",
          artifact: {
            kind: "design",
            title: "勾选框交互稿",
            body: "三态：未勾选 / 勾选 / 禁用。",
          },
          text: "交互稿在这，勾选框得会呼吸。",
          mentions: ["linzhiyuan"],
        },
      ];
    }

    if (cat === "chenshi" && stage === "working") {
      const turns: AgentTurn[] = [
        {
          kind: "artifact",
          artifact: { kind: "patch", title: "remember-me token v1", body: "新增 token 字段与校验。" },
          text: "能跑，v1 在这里。",
        },
        {
          kind: "handoff",
          to: "shenyan",
          card: card("review v1 实现"),
          text: "@沈砚 麻烦看下 v1。",
          ...(options.fault ? { fault: "missed_mention" as const } : {}),
        },
      ];
      return turns;
    }

    if (cat === "chenshi" && stage === "revising") {
      return [
        {
          kind: "artifact",
          artifact: {
            kind: "patch",
            title: "remember-me token v2",
            body: "补上 7 天过期与 HttpOnly。",
          },
          text: "补上了过期时间，v2。",
        },
        {
          kind: "handoff",
          to: "shenyan",
          card: card("review v2 实现"),
          text: "@沈砚 再过一遍。",
        },
      ];
    }

    if (cat === "shenyan" && stage === "reviewing") {
      if (reviewCalls === 0) {
        reviewCalls += 1;
        return [
          {
            kind: "review",
            verdict: "request_changes",
            title: "v1 review",
            findings: [
              { severity: "blocker", title: "token 没有过期时间", detail: "必须设置 7 天过期。" },
              {
                severity: "minor",
                title: "勾选框默认可访问性",
                detail: "默认值需要读屏可用。",
              },
            ],
            text: "第 1 条是 blocker：token 没设置过期时间；第 2 条 minor。",
            mentions: ["chenshi"],
          },
          {
            kind: "memory",
            memory: {
              kind: "lesson",
              title: "review 先盯过期时间",
              body: "token 类实现先看过期与失效。",
              tags: ["review", "security"],
            },
            text: "顺手记一条教训。",
          },
        ];
      }
      reviewCalls += 1;
      return [
        {
          kind: "review",
          verdict: "approve",
          title: "v2 review",
          findings: [],
          text: "v2 通过。",
          mentions: ["chenshi"],
        },
      ];
    }

    return [];
  });
}

// ───────────────────────── 1. task_created 分发 ─────────────────────────

test("task_created：architect 先说话，planning 把交接分发给周烁与陈实", async () => {
  const studio = makeStudio();
  const brain = scriptedBrain((ctx) => {
    const stage = ctx.task?.stage ?? null;
    if (ctx.cat.id === "linzhiyuan" && stage === "intake") return [message("我先接住这个需求。")];
    if (ctx.cat.id === "linzhiyuan" && stage === "planning") {
      return [
        { kind: "handoff", to: "zhoushuo", card: card("设计勾选框"), text: "@周烁 设计交给你。" },
        { kind: "handoff", to: "chenshi", card: card("实现 token"), text: "@陈实 实现交给你。" },
      ];
    }
    return [];
  });
  const driver = makeDriver(studio, brain);
  const task = newTask(studio);

  driver.submit({ type: "task_created", roomId: ROOM_ID, taskId: task.id });
  await driver.whenIdle();

  const intakeCall = brain.calls[0];
  assert.ok(intakeCall);
  assert.equal(intakeCall.cat.id, "linzhiyuan");
  assert.equal(intakeCall.stageAtCall, "intake");
  assert.equal(intakeCall.trigger.kind, "task_created");
  assert.equal(intakeCall.scenario?.id, SCENARIO_ID);

  const messages = taskMessages(studio, task.id);
  const first = messages[0];
  assert.ok(first);
  assert.equal(first.author, "linzhiyuan");
  assert.equal(first.kind, "chat");

  const handoffs = studio.state.handoffs.filter((h) => h.taskId === task.id);
  assert.deepEqual(handoffs.map((h) => h.from), ["linzhiyuan", "linzhiyuan"]);
  assert.deepEqual(handoffs.map((h) => h.to), ["zhoushuo", "chenshi"]);
  for (const handoff of handoffs) {
    assert.ok(handoff.card.what.length > 0);
    assert.ok(handoff.card.why.length > 0);
    assert.ok(handoff.card.tradeoff.length > 0);
    assert.ok(handoff.card.nextAction.length > 0);
    assert.ok(Array.isArray(handoff.card.openQuestions));
  }

  const handoffMessages = messages.filter((m) => m.kind === "handoff");
  assert.equal(handoffMessages.length, 2);
  assert.deepEqual(
    handoffMessages.map((m) => m.mentions),
    [["zhoushuo"], ["chenshi"]],
  );
  for (const m of handoffMessages) assert.ok(m.handoffId);

  // 交接只唤醒接收者。
  assert.equal(brain.callsFor("zhoushuo", "working").length, 1);
  assert.equal(brain.callsFor("chenshi", "working").length, 1);
  assert.equal(brain.callsFor("zhoushuo", "working")[0]?.trigger.kind, "handoff");
  assert.equal(brain.callsFor("chenshi", "working")[0]?.trigger.kind, "handoff");

  // working 全部跑完后自动进入 reviewing，只有沈砚被唤醒。
  const reviewerCalls = brain.callsFor("shenyan");
  assert.equal(reviewerCalls.length, 1);
  assert.equal(reviewerCalls[0]?.stageAtCall, "reviewing");
  assert.equal(reviewerCalls[0]?.trigger.kind, "artifact");

  assert.equal(task.stage, "reviewing");
  assert.equal(task.owner, "shenyan");
  assert.deepEqual(
    task.steps.map((step) => `${step.stage}:${step.status}`),
    ["intake:done", "planning:done", "working:done", "reviewing:active"],
  );
  assert.equal(studio.state.typing[ROOM_ID], null);
});

// ───────────────────────── 2. @mention 路由 ─────────────────────────

test("@mention：只唤醒被点名的猫；无 @ 时回落到 task owner / architect", async () => {
  const studio = makeStudio();
  const brain = scriptedBrain((ctx) => [message(`${ctx.cat.name}在。`, ctx.trigger.mentions)]);
  const driver = makeDriver(studio, brain);

  // 没有任务 + 显式 @：只有周烁醒。
  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "@周烁 顺便看看移动端",
    mentions: ["zhoushuo"],
  });
  await driver.whenIdle();
  assert.deepEqual(
    brain.calls.map((call) => call.cat.id),
    ["zhoushuo"],
  );
  assert.equal(studio.state.messages.at(-1)?.author, "zhoushuo");

  // 没有任务 + 没有 @：林知远作为主理猫接话。
  driver.submit({ type: "user_message", roomId: ROOM_ID, text: "大家看看", mentions: [] });
  await driver.whenIdle();
  assert.deepEqual(
    brain.calls.map((call) => call.cat.id),
    ["zhoushuo", "linzhiyuan"],
  );

  // 有任务 + 没有 @：唤醒 task.owner。
  const task = newTask(studio);
  studio.updateTaskStage(task.id, "working", "chenshi");
  driver.submit({ type: "user_message", roomId: ROOM_ID, text: "进度怎么样", mentions: [] });
  await driver.whenIdle();
  assert.equal(brain.calls.at(-1)?.cat.id, "chenshi");
  assert.equal(brain.calls.at(-1)?.task?.id, task.id);

  // @ 优先于 owner：owner 是陈实，但 @ 的是沈砚。
  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "@沈砚 看下这个",
    mentions: ["shenyan"],
  });
  await driver.whenIdle();
  assert.equal(brain.calls.at(-1)?.cat.id, "shenyan");
  assert.equal(brain.calls.filter((call) => call.cat.id === "chenshi").length, 1);
  assert.equal(studio.state.typing[ROOM_ID], null);
});

// ───────────────────────── 3. 漏 @ → stalled → nudge 恢复 ─────────────────────────

test("missed_mention：写卡不唤醒、任务 stalled；nudge 补投递并恢复 active", async () => {
  const studio = makeStudio();
  const brain = demoBrain({ fault: true });
  const driver = makeDriver(studio, brain);
  const task = newTask(studio);

  driver.submit({ type: "task_created", roomId: ROOM_ID, taskId: task.id });
  await driver.whenIdle();

  // 被漏 @ 卡住：停在 planning，没人自动推进到 reviewing。
  assert.equal(task.status, "stalled");
  assert.equal(task.stage, "working");
  assert.equal(task.owner, "zhoushuo");

  const faulted = studio.state.handoffs
    .filter((handoff) => handoff.taskId === task.id)
    .find((handoff) => handoff.to === "shenyan");
  assert.ok(faulted);
  const faultedMessage = studio.state.messages.find((m) => m.handoffId === faulted.id);
  assert.ok(faultedMessage);
  assert.equal(faultedMessage.kind, "handoff");
  // 本意是给它：mentions 仍写 [shenyan]，但没唤醒。
  assert.deepEqual(faultedMessage.mentions, ["shenyan"]);

  assert.equal(brain.callsFor("shenyan").length, 0);
  assert.equal(
    task.steps.some((step) => step.stage === "reviewing"),
    false,
  );
  assert.equal(brain.callsFor("chenshi", "working").length, 1);

  // 催一下：architect 先恢复，再补投递。
  driver.submit({ type: "nudge", taskId: task.id });
  await driver.whenIdle();

  assert.equal(task.status, "done");
  assert.equal(task.stage, "done");
  assert.equal(task.owner, "linzhiyuan");
  assert.equal(typeof task.doneAt, "number");

  const nudgeCall = brain.calls.find((call) => call.trigger.kind === "nudge");
  assert.ok(nudgeCall);
  assert.equal(nudgeCall.cat.id, "linzhiyuan");

  // 补投递：沈砚拿着原来那张卡进来，然后正常 review → revise → approve。
  const firstReview = brain.callsFor("shenyan")[0];
  assert.ok(firstReview);
  assert.equal(firstReview.trigger.kind, "handoff");
  assert.equal(firstReview.trigger.handoff?.what, "review v1 实现");
  assert.equal(brain.callsFor("shenyan").length, 2);
  assert.equal(brain.callsFor("chenshi", "revising").length, 1);

  assert.equal(task.steps.filter((step) => step.stage === "revising").length, 1);
  assert.equal(task.steps.filter((step) => step.stage === "reviewing").length, 2);
  assert.ok(task.steps.every((step) => step.status === "done"));
});

// ───────────────────────── 4. request_changes → revising → reviewing ─────────────────────────

test("review request_changes 触发 revising 并回到 implementer，v2 之后再次 reviewing 通过", async () => {
  const studio = makeStudio();
  const brain = demoBrain();
  const driver = makeDriver(studio, brain);
  const task = newTask(studio);

  driver.submit({ type: "task_created", roomId: ROOM_ID, taskId: task.id });
  await driver.whenIdle();

  assert.deepEqual(
    task.steps.map((step) => `${step.stage}:${step.owner}:${step.status}`),
    [
      "intake:linzhiyuan:done",
      "planning:linzhiyuan:done",
      "working:zhoushuo:done",
      "reviewing:shenyan:done",
      "revising:chenshi:done",
      "reviewing:shenyan:done",
      "done:linzhiyuan:done",
    ],
  );

  const reviseCall = brain.callsFor("chenshi", "revising")[0];
  assert.ok(reviseCall);
  assert.equal(reviseCall.trigger.kind, "review_result");
  assert.equal(reviseCall.trigger.review?.verdict, "request_changes");
  assert.deepEqual(
    reviseCall.trigger.review?.findings.map((finding) => finding.severity),
    ["blocker", "minor"],
  );

  const reviewCalls = brain.callsFor("shenyan", "reviewing");
  assert.equal(reviewCalls.length, 2);
  assert.equal(reviewCalls[0]?.trigger.kind, "handoff");
  assert.equal(reviewCalls[0]?.trigger.handoff?.what, "review v1 实现");
  assert.equal(reviewCalls[1]?.trigger.kind, "handoff");
  assert.equal(reviewCalls[1]?.trigger.handoff?.what, "review v2 实现");

  assert.equal(task.status, "done");
  assert.equal(task.stage, "done");
});

// ───────────────────────── 5. approve → decision → done ─────────────────────────

test("approve 后由 architect 在 done 阶段落 decision，任务完成", async () => {
  const studio = makeStudio();
  const brain = demoBrain();
  const driver = makeDriver(studio, brain);
  const task = newTask(studio);

  driver.submit({ type: "task_created", roomId: ROOM_ID, taskId: task.id });
  await driver.whenIdle();

  const doneCall = brain.calls.find((call) => call.stageAtCall === "done");
  assert.ok(doneCall);
  assert.equal(doneCall.cat.id, "linzhiyuan");
  assert.equal(doneCall.trigger.kind, "review_result");
  assert.equal(doneCall.trigger.review?.verdict, "approve");

  assert.equal(task.status, "done");
  assert.equal(task.stage, "done");
  assert.equal(task.owner, "linzhiyuan");
  assert.equal(typeof task.doneAt, "number");

  const decisionArtifact = studio.state.artifacts.find(
    (artifact) => artifact.taskId === task.id && artifact.kind === "decision",
  );
  assert.ok(decisionArtifact);
  assert.equal(decisionArtifact.author, "linzhiyuan");

  const decisionMessage = taskMessages(studio, task.id).find((m) => m.kind === "decision");
  assert.ok(decisionMessage);
  assert.equal(decisionMessage.author, "linzhiyuan");
  assert.equal(decisionMessage.artifactId, decisionArtifact.id);
});

// ───────────────────────── 6. 落库格式 ─────────────────────────

test("落库：review/decision/artifact/memory 与五栏交接卡格式正确", async () => {
  const studio = makeStudio();
  const brain = demoBrain();
  const driver = makeDriver(studio, brain);
  const task = newTask(studio);

  driver.submit({ type: "task_created", roomId: ROOM_ID, taskId: task.id });
  await driver.whenIdle();

  const messages = taskMessages(studio, task.id);
  const kinds = new Set(messages.map((m) => m.kind));
  for (const kind of ["chat", "handoff", "artifact", "review", "decision"]) {
    assert.ok(kinds.has(kind as never), `缺少 kind=${kind} 的消息`);
  }

  // 交接卡：五栏齐全（openQuestions 空数组也算齐全）。
  const handoffs = studio.state.handoffs.filter((handoff) => handoff.taskId === task.id);
  assert.equal(handoffs.length, 4); // planning 2 张 + v1 review 1 张 + v2 review 1 张
  for (const handoff of handoffs) {
    assert.ok(handoff.card.what.length > 0);
    assert.ok(handoff.card.why.length > 0);
    assert.ok(handoff.card.tradeoff.length > 0);
    assert.ok(handoff.card.nextAction.length > 0);
    assert.ok(Array.isArray(handoff.card.openQuestions));
  }

  // review artifact 正文是前端约定的固定格式。
  const reviewArtifacts = studio.state.artifacts.filter(
    (artifact) => artifact.taskId === task.id && artifact.kind === "review",
  );
  assert.equal(reviewArtifacts.length, 2);
  const rejected = reviewArtifacts[0];
  assert.ok(rejected);
  assert.equal(rejected.body.split("\n")[0], "verdict: request_changes");
  assert.match(rejected.body, /- \[blocker\] token 没有过期时间 — 必须设置 7 天过期。/);
  assert.match(rejected.body, /- \[minor\] 勾选框默认可访问性 — 默认值需要读屏可用。/);
  const approved = reviewArtifacts[1];
  assert.ok(approved);
  assert.equal(approved.body.split("\n")[0], "verdict: approve");

  // review message 绑定 artifact，并保留 mentions。
  const reviewMessages = messages.filter((m) => m.kind === "review");
  assert.equal(reviewMessages.length, 2);
  for (const m of reviewMessages) {
    assert.ok(m.artifactId);
    assert.deepEqual(m.mentions, ["chenshi"]);
    assert.ok(
      studio.state.artifacts.some(
        (artifact) => artifact.id === m.artifactId && artifact.kind === "review",
      ),
    );
  }

  // patch 版本自增（v1 → v2）与 artifact message 绑定。
  const patches = studio.state.artifacts.filter(
    (artifact) => artifact.taskId === task.id && artifact.kind === "patch",
  );
  assert.deepEqual(
    patches.map((artifact) => `${artifact.title}@v${artifact.version}`),
    ["remember-me token v1@v1", "remember-me token v2@v2"],
  );
  const artifactMessages = messages.filter((m) => m.kind === "artifact");
  assert.ok(artifactMessages.length >= 3);
  for (const m of artifactMessages) assert.ok(m.artifactId);

  // memory：review 里的 memory turn + decision turn 里的 decision/lesson。
  const memory = studio.state.memory.filter((entry) => entry.sourceTaskId === task.id);
  assert.deepEqual(
    memory.map((entry) => entry.kind),
    ["lesson", "decision", "lesson"],
  );
  assert.deepEqual(
    memory.map((entry) => entry.title),
    ["review 先盯过期时间", "remember-me token 7 天过期", "token 必须带过期时间"],
  );
  assert.deepEqual(memory[1]?.tags, ["auth", "remember-me"]);

  // 六个阶段都有记录；scenario 每轮都注入了 context。
  for (const stage of ["intake", "planning", "working", "reviewing", "revising", "done"]) {
    assert.ok(
      task.steps.some((step) => step.stage === (stage as TaskStage)),
      `缺少阶段 ${stage}`,
    );
  }
  for (const call of brain.calls) assert.equal(call.scenario?.id, SCENARIO_ID);

  assert.equal(studio.state.typing[ROOM_ID], null);
});

// ───────────────────────── 7. 一次 think 多个 review turn ─────────────────────────

test("同一轮返回多个 review turn 时只取第一个，不会跳过 revise", async () => {
  const studio = makeStudio();
  let reviewRound = 0;
  const brain = scriptedBrain((ctx) => {
    const stage = ctx.task?.stage ?? null;
    const cat = ctx.cat.id;

    if (cat === "linzhiyuan" && stage === "intake") return [message("接住。")];
    if (cat === "linzhiyuan" && stage === "planning") {
      return [{ kind: "handoff", to: "chenshi", card: card("实现"), text: "交给实现。" }];
    }
    if (cat === "linzhiyuan" && stage === "done") {
      return [
        {
          kind: "decision",
          artifact: { title: "决定", body: "定稿。" },
          text: "决定。",
          memory: [],
        },
      ];
    }
    if (cat === "chenshi" && stage === "working") {
      return [
        {
          kind: "artifact",
          artifact: { kind: "patch", title: "v1", body: "第一版" },
          text: "v1",
        },
      ];
    }
    if (cat === "chenshi" && stage === "revising") {
      return [
        {
          kind: "artifact",
          artifact: { kind: "patch", title: "v2", body: "第二版" },
          text: "v2",
        },
        { kind: "handoff", to: "shenyan", card: card("review v2"), text: "再过一遍。" },
      ];
    }
    if (cat === "shenyan" && stage === "reviewing") {
      reviewRound += 1;
      if (reviewRound === 1) {
        return [
          {
            kind: "review",
            verdict: "request_changes",
            title: "r1",
            findings: [{ severity: "blocker", title: "问题", detail: "细节" }],
            text: "打回。",
            mentions: ["chenshi"],
          },
          { kind: "review", verdict: "approve", title: "r2", findings: [], text: "通过。" },
        ];
      }
      return [{ kind: "review", verdict: "approve", title: "r3", findings: [], text: "通过。" }];
    }
    return [];
  });
  const driver = makeDriver(studio, brain);
  const task = newTask(studio);

  driver.submit({ type: "task_created", roomId: ROOM_ID, taskId: task.id });
  await driver.whenIdle();

  const reviewArtifacts = studio.state.artifacts.filter(
    (artifact) => artifact.taskId === task.id && artifact.kind === "review",
  );
  assert.deepEqual(
    reviewArtifacts.map((artifact) => artifact.body.split("\n")[0]),
    ["verdict: request_changes", "verdict: approve"],
  );
  assert.equal(task.steps.filter((step) => step.stage === "revising").length, 1);
  assert.equal(task.status, "done");
});

// ───────────────────────── 8. 每房间串行 + submit 不阻塞 ─────────────────────────

test("每房间串行队列：submit 立即返回，多事件也不会让两只猫同时 think", async () => {
  const studio = makeStudio();
  const calls: MemberId[] = [];
  let active = 0;
  let maxActive = 0;
  const brain: AgentBrain = {
    mode: "mock",
    async think(ctx) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(ctx.cat.id);
      await Promise.resolve();
      active -= 1;
      return [];
    },
  };
  const driver = createDriver({
    studio,
    brain,
    wait: async () => {
      await Promise.resolve();
    },
    stallMs: 60_000,
  });

  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "@周烁 看下",
    mentions: ["zhoushuo"],
  });
  // submit 不阻塞：同步返回，此时队列还没开跑。
  assert.deepEqual(calls, []);
  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "@沈砚 看下",
    mentions: ["shenyan"],
  });
  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "@陈实 看下",
    mentions: ["chenshi"],
  });

  await driver.whenIdle();
  assert.equal(maxActive, 1);
  // 同房间严格按提交顺序串行。
  assert.deepEqual(calls, ["zhoushuo", "shenyan", "chenshi"]);
});

// ───────────────────────── 9. 场景数据 ─────────────────────────

test("TurnContext.scenario 来自 SCENARIOS，按 task.scenarioId 注入", async () => {
  const studio = makeStudio();
  const brain = scriptedBrain(() => []);
  const driver = makeDriver(studio, brain);
  const task = newTask(studio);

  driver.submit({ type: "task_created", roomId: ROOM_ID, taskId: task.id });
  await driver.whenIdle();

  assert.ok(brain.calls.length > 0);
  const expected = SCENARIOS.find((scenario) => scenario.id === SCENARIO_ID);
  assert.ok(expected);
  for (const call of brain.calls) {
    assert.equal(call.scenario?.id, expected.id);
    assert.equal(call.room.id, ROOM_ID);
    assert.ok(call.recentMessages.length > 0);
  }
});

// ───────────────────────── 10. mentions 纯函数 ─────────────────────────

test("mentions：@名字 / @id 解析、去重与投递规则", () => {
  assert.deepEqual(parseMentions("@周烁 顺便看看移动端，@chenshi 也来", CATS), [
    "zhoushuo",
    "chenshi",
  ]);
  assert.deepEqual(parseMentions("@林知远 @林知远 重复点名", CATS), ["linzhiyuan"]);
  assert.deepEqual(parseMentions("这里没有 at，只有 email@example", CATS), []);
  assert.deepEqual(parseMentions("@不存在的猫", CATS), []);

  assert.deepEqual(normalizeMentions([], CATS), []);
  assert.deepEqual(normalizeMentions(["zhoushuo", "unknown", "zhoushuo"], CATS), [
    "zhoushuo",
  ]);
  assert.deepEqual(handoffMentions("shenyan"), ["shenyan"]);

  const studio = makeStudio();
  // 无任务、无 @ → architect。
  assert.deepEqual(routeUserMessage(CATS, null, []), ["linzhiyuan"]);
  // 无任务但有 @ → 只投给被 @ 的猫。
  assert.deepEqual(routeUserMessage(CATS, null, ["zhoushuo", "shenyan"]), [
    "zhoushuo",
    "shenyan",
  ]);
  // 有任务、无 @ → task.owner。
  const task = newTask(studio);
  studio.updateTaskStage(task.id, "reviewing", "shenyan");
  assert.deepEqual(routeUserMessage(CATS, task, []), ["shenyan"]);
  // @ 优先于 owner。
  assert.deepEqual(routeUserMessage(CATS, task, ["zhoushuo"]), ["zhoushuo"]);
});

// ───────────────────────── 11. nudge 恢复 watchdog 卡住 ─────────────────────────

test("nudge：watchdog 标 stalled 的任务在 architect 恢复后回到 active", async () => {
  const studio = makeStudio();
  const brain = scriptedBrain((ctx) =>
    ctx.trigger.kind === "nudge" ? [message("我跟一下，别急。")] : [],
  );
  const driver = makeDriver(studio, brain);
  const task = newTask(studio);

  // 模拟 watchdog 判定的「卡住」。
  studio.setTaskStatus(task.id, "stalled");
  driver.submit({ type: "nudge", taskId: task.id });
  await driver.whenIdle();

  assert.equal(task.status, "active");
  assert.ok(brain.calls.some((call) => call.trigger.kind === "nudge"));
  assert.equal(studio.state.typing[ROOM_ID], null);
});

// ───────────────────────── 12. tool turn：沙盒执行 ─────────────────────────

function toolTurn(
  tool: ToolName,
  input: Record<string, unknown>,
  extra: { label?: string; text?: string; mentions?: MemberId[] } = {},
): AgentTurn {
  return { kind: "tool", tool, input, ...extra };
}

test("tool turn：ToolCall running → ok，落 kind=tool 消息，stage 不变", async () => {
  const studio = makeStudio();
  let statusDuringExecute: string | undefined;
  const sandbox = fakeSandbox((tool) => {
    statusDuringExecute = studio.state.toolCalls.at(-1)?.status;
    return { status: "ok", exitCode: 0, output: `executed ${tool}` };
  });
  const brain = scriptedBrain((ctx) => {
    if (ctx.cat.id === "chenshi" && ctx.trigger.kind === "user_message") {
      return [toolTurn("run_command", { cmd: "node", args: ["--test", "test/remember.test.js"] })];
    }
    return [];
  });
  const driver = makeDriver(studio, brain, { sandbox });
  const task = newTask(studio);
  studio.updateTaskStage(task.id, "working", "chenshi");

  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "跑一下测试",
    mentions: ["chenshi"],
  });
  await driver.whenIdle();

  // 执行时 ToolCall 已经是 running（先记账，再执行）。
  assert.equal(statusDuringExecute, "running");

  assert.equal(sandbox.calls.length, 1);
  assert.equal(sandbox.calls[0]?.tool, "run_command");
  assert.deepEqual(sandbox.calls[0]?.input, {
    cmd: "node",
    args: ["--test", "test/remember.test.js"],
  });

  const call = studio.state.toolCalls.at(-1);
  assert.ok(call);
  assert.equal(call.catId, "chenshi");
  assert.equal(call.taskId, task.id);
  assert.equal(call.status, "ok");
  assert.equal(call.exitCode, 0);
  assert.equal(call.output, "executed run_command");
  assert.equal(typeof call.finishedAt, "number");

  const toolMessage = studio.state.messages.find((m) => m.kind === "tool");
  assert.ok(toolMessage);
  assert.equal(toolMessage.author, "chenshi");
  assert.equal(toolMessage.toolCallId, call.id);
  assert.equal(toolMessage.taskId, task.id);
  assert.equal(toolMessage.text, "跑了 node，退出码 0");

  // 工具不改变阶段 / owner。
  assert.equal(task.stage, "working");
  assert.equal(task.owner, "chenshi");
  assert.equal(studio.state.typing[ROOM_ID], null);
});

// ───────────────────────── 13. toolsEnabled=false ─────────────────────────

test("toolsEnabled() === false：不执行工具、不产生 ToolCall，只发说明消息", async () => {
  const studio = makeStudio();
  const sandbox = fakeSandbox();
  const brain = scriptedBrain((ctx) =>
    ctx.trigger.kind === "user_message"
      ? [
          toolTurn("write_file", { path: "src/remember.js", content: "// fix" }),
          message("先写方案。"),
        ]
      : [],
  );
  const driver = makeDriver(studio, brain, { sandbox, toolsEnabled: () => false });
  const task = newTask(studio);
  studio.updateTaskStage(task.id, "working", "chenshi");

  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "改一下 remember.js",
    mentions: ["chenshi"],
  });
  await driver.whenIdle();

  assert.equal(sandbox.calls.length, 0);
  assert.equal(studio.state.toolCalls.length, 0);

  const messages = studio.state.messages.filter((m) => m.taskId === task.id);
  const explain = messages.find((m) => m.kind === "chat" && m.text.includes("工具执行被关掉了"));
  assert.ok(explain);
  assert.equal(explain.author, "chenshi");
  // 后续 turn 仍然照常执行。
  assert.ok(messages.some((m) => m.text === "先写方案。"));
  assert.equal(task.stage, "working");
});

// ───────────────────────── 14. 工具失败不中断流程 ─────────────────────────

test("sandbox 返回 error：ToolCall 标 error，后续 artifact/review/decision 仍执行", async () => {
  const studio = makeStudio();
  const sandbox = fakeSandbox(() => ({
    status: "error",
    exitCode: 1,
    output: "boom: 2 tests failed",
  }));
  const brain = scriptedBrain((ctx) => {
    const stage = ctx.task?.stage ?? null;
    if (ctx.cat.id === "linzhiyuan" && stage === "intake") return [message("接住。")];
    if (ctx.cat.id === "linzhiyuan" && stage === "planning") {
      return [{ kind: "handoff", to: "chenshi", card: card("实现 token"), text: "交给实现。" }];
    }
    if (ctx.cat.id === "chenshi" && stage === "working") {
      return [
        toolTurn("run_command", { cmd: "node", args: ["--test"] }),
        {
          kind: "artifact",
          artifact: { kind: "patch", title: "v1", body: "先交一版" },
          text: "测试挂了，但我先把改动交出来。",
        },
        { kind: "handoff", to: "shenyan", card: card("review v1"), text: "@沈砚 看下。" },
      ];
    }
    if (ctx.cat.id === "shenyan" && stage === "reviewing") {
      return [
        {
          kind: "review",
          verdict: "approve",
          title: "review v1",
          findings: [],
          text: "先过，测试的事后面再说。",
          mentions: ["chenshi"],
        },
      ];
    }
    if (ctx.cat.id === "linzhiyuan" && stage === "done") {
      return [
        {
          kind: "decision",
          artifact: { title: "定稿", body: "先接受这一版。" },
          text: "决定。",
          memory: [],
        },
      ];
    }
    return [];
  });
  const driver = makeDriver(studio, brain, { sandbox });
  const task = newTask(studio);

  driver.submit({ type: "task_created", roomId: ROOM_ID, taskId: task.id });
  await driver.whenIdle();

  const failed = studio.state.toolCalls.find((call) => call.taskId === task.id);
  assert.ok(failed);
  assert.equal(failed.status, "error");
  assert.equal(failed.exitCode, 1);
  assert.match(failed.output ?? "", /boom/);

  const toolMessage = studio.state.messages.find(
    (m) => m.kind === "tool" && m.toolCallId === failed.id,
  );
  assert.ok(toolMessage);
  assert.equal(toolMessage.text, "跑了 node，退出码 1");

  // 失败只记录，不抛异常：流程继续到 done。
  assert.equal(task.status, "done");
  assert.equal(task.stage, "done");
  assert.ok(
    studio.state.artifacts.some((a) => a.taskId === task.id && a.kind === "patch"),
  );
  assert.ok(
    studio.state.artifacts.some((a) => a.taskId === task.id && a.kind === "review"),
  );
  assert.ok(
    studio.state.artifacts.some((a) => a.taskId === task.id && a.kind === "decision"),
  );
});

// ───────────────────────── 15. 默认 label ─────────────────────────

test("tool 默认 label：write_file / read_file / list_files / run_command", async () => {
  const studio = makeStudio();
  const sandbox = fakeSandbox();
  const brain = scriptedBrain((ctx) =>
    ctx.trigger.kind === "user_message"
      ? [
          toolTurn("write_file", { path: "src/remember.js", content: "// v2" }),
          toolTurn("read_file", { path: "src/remember.js" }),
          toolTurn("list_files", {}),
          toolTurn("run_command", { cmd: "node", args: ["--test", "test/remember.test.js"] }),
          toolTurn("read_file", { path: "src/export.js" }, { label: "瞄一眼导出实现" }),
        ]
      : [],
  );
  const driver = makeDriver(studio, brain, { sandbox });

  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "@陈实 去沙盒里看看",
    mentions: ["chenshi"],
  });
  await driver.whenIdle();

  assert.deepEqual(
    studio.state.toolCalls.map((call) => call.label),
    [
      "写入 src/remember.js",
      "读取 src/remember.js",
      "列出沙盒文件",
      "运行 node --test test/remember.test.js",
      "瞄一眼导出实现", // 显式 label 优先
    ],
  );
  assert.equal(sandbox.calls.length, 5);
  assert.equal(studio.state.messages.filter((m) => m.kind === "tool").length, 5);
  for (const m of studio.state.messages.filter((m) => m.kind === "tool")) {
    assert.ok(m.toolCallId);
    assert.ok(studio.state.toolCalls.some((call) => call.id === m.toolCallId));
  }
});

// ───────────────────────── 16. 无 sandbox 降级 ─────────────────────────

test("没有 sandbox：不执行工具、不发 ToolCall，只发说明消息并继续后续 turn", async () => {
  const studio = makeStudio();
  const brain = scriptedBrain((ctx) =>
    ctx.trigger.kind === "user_message"
      ? [
          toolTurn("run_command", { cmd: "node", args: ["--test"] }),
          message("沙盒没接上，我先把方案写出来。"),
        ]
      : [],
  );
  const driver = makeDriver(studio, brain); // 不传 sandbox

  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "@陈实 跑个测试",
    mentions: ["chenshi"],
  });
  await driver.whenIdle();

  assert.equal(studio.state.toolCalls.length, 0);
  const messages = studio.state.messages.filter((m) => m.author === "chenshi");
  assert.ok(messages.some((m) => m.kind === "chat" && m.text.includes("没接沙盒")));
  assert.ok(messages.some((m) => m.text === "沙盒没接上，我先把方案写出来。"));
});

// ───────────────────────── 17. 审批：批准 ─────────────────────────

test("审批：llm + commands 下 run_command 先 pending，批准后执行变 ok", async () => {
  const studio = makeStudio();
  let pendingStatus: string | undefined;
  let runningStatus: string | undefined;
  const sandbox = fakeSandbox(() => {
    runningStatus = studio.state.toolCalls.at(-1)?.status;
    return { status: "ok", exitCode: 0, output: "all pass" };
  });
  const approvals = fakeApprovals(() => {
    pendingStatus = studio.state.toolCalls.at(-1)?.status;
    return "approved";
  });
  const brain = scriptedBrain((ctx) => {
    if (ctx.trigger.kind === "user_message") {
      return [toolTurn("run_command", { cmd: "node", args: ["--test"] })];
    }
    if (ctx.trigger.kind === "tool_result") return [message("测试全过。")];
    return [];
  }, "llm");
  const driver = makeDriver(studio, brain, {
    sandbox,
    approvals,
    approvalMode: () => "commands",
  });
  const task = newTask(studio);
  studio.updateTaskStage(task.id, "working", "chenshi");

  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "跑个测试",
    mentions: ["chenshi"],
  });
  await driver.whenIdle();

  // 审批阶段：先 pending；通过后 startToolCall 才执行。
  assert.equal(pendingStatus, "pending");
  assert.equal(runningStatus, "running");
  assert.equal(approvals.requests.length, 1);

  const call = studio.state.toolCalls.at(-1);
  assert.ok(call);
  assert.equal(approvals.requests[0]?.callId, call.id);
  assert.equal(approvals.requests[0]?.mode, "commands");
  assert.equal(approvals.requests[0]?.tool, "run_command");
  assert.equal(approvals.requests[0]?.catId, "chenshi");
  assert.equal(approvals.requests[0]?.label, "运行 node --test");
  assert.equal(sandbox.calls.length, 1);
  assert.equal(call.status, "ok");
  assert.equal(call.exitCode, 0);
  assert.equal(call.output, "all pass");

  const toolMessages = studio.state.messages.filter((m) => m.kind === "tool");
  assert.equal(toolMessages.length, 2);
  assert.equal(toolMessages[0]?.text, "等你批准：运行 node --test");
  assert.equal(toolMessages[1]?.toolCallId, call.id);

  // 回喂：第二次 think 收到 tool_result。
  assert.equal(brain.calls.length, 2);
  const second = brain.calls[1];
  assert.ok(second);
  assert.equal(second.trigger.kind, "tool_result");
  assert.deepEqual(second.trigger.toolResults, [
    {
      callId: call.id,
      tool: "run_command",
      status: "ok",
      output: "all pass",
      exitCode: 0,
    },
  ]);
  assert.ok(studio.state.messages.some((m) => m.text === "测试全过。"));
  assert.equal(task.stage, "working");
  assert.equal(studio.state.typing[ROOM_ID], null);
});

// ───────────────────────── 18. 审批：拒绝 ─────────────────────────

test("审批：拒绝时不执行 sandbox，ToolCall=rejected 且 rejected 计入回喂", async () => {
  const studio = makeStudio();
  const sandbox = fakeSandbox();
  const approvals = fakeApprovals("rejected");
  const brain = scriptedBrain((ctx) => {
    if (ctx.trigger.kind === "user_message") {
      return [toolTurn("run_command", { cmd: "node", args: ["--test"] })];
    }
    if (ctx.trigger.kind === "tool_result") return [message("那我先写方案。")];
    return [];
  }, "llm");
  const driver = makeDriver(studio, brain, {
    sandbox,
    approvals,
    approvalMode: () => "commands",
  });
  const task = newTask(studio);
  studio.updateTaskStage(task.id, "working", "chenshi");

  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "跑个测试",
    mentions: ["chenshi"],
  });
  await driver.whenIdle();

  assert.equal(approvals.requests.length, 1);
  assert.equal(sandbox.calls.length, 0, "被拒绝时绝不能执行 sandbox");

  const call = studio.state.toolCalls.at(-1);
  assert.ok(call);
  assert.equal(call.status, "rejected");
  assert.equal(call.exitCode, undefined);
  assert.equal(call.output, "负责人拒绝了这次执行");

  const toolMessages = studio.state.messages.filter((m) => m.kind === "tool");
  assert.equal(toolMessages.length, 2);
  assert.equal(toolMessages[0]?.text, "等你批准：运行 node --test");
  assert.equal(toolMessages[1]?.toolCallId, call.id);
  assert.equal(toolMessages[1]?.text, "负责人拒绝了这次执行，我换个办法。");

  assert.equal(brain.calls.length, 2);
  const second = brain.calls[1];
  assert.ok(second);
  assert.equal(second.trigger.kind, "tool_result");
  assert.equal(second.trigger.toolResults?.[0]?.callId, call.id);
  assert.equal(second.trigger.toolResults?.[0]?.status, "rejected");
  assert.equal(second.trigger.toolResults?.[0]?.output, "负责人拒绝了这次执行");
  assert.ok(studio.state.messages.some((m) => m.text === "那我先写方案。"));
  assert.equal(task.stage, "working");
});

// ───────────────────────── 19. 审批只对 llm 生效 ─────────────────────────

test("审批只对 llm 生效：mode=auto 与 mock 剧本都不进审批、直接执行", async () => {
  // case 1: llm + auto（即使注入了 approvals）→ 直接执行。
  {
    const studio = makeStudio();
    const sandbox = fakeSandbox();
    const approvals = fakeApprovals("rejected");
    const brain = scriptedBrain(
      (ctx) =>
        ctx.trigger.kind === "user_message"
          ? [toolTurn("run_command", { cmd: "node", args: ["--test"] })]
          : [],
      "llm",
    );
    const driver = makeDriver(studio, brain, {
      sandbox,
      approvals,
      approvalMode: () => "auto",
    });
    driver.submit({
      type: "user_message",
      roomId: ROOM_ID,
      text: "@陈实 跑一下",
      mentions: ["chenshi"],
    });
    await driver.whenIdle();
    assert.equal(approvals.requests.length, 0);
    assert.equal(sandbox.calls.length, 1);
    assert.equal(studio.state.toolCalls.at(-1)?.status, "ok");
  }

  // case 2: mock 剧本 + mode=commands（approvals 也在）→ 永远自动放行。
  {
    const studio = makeStudio();
    const sandbox = fakeSandbox();
    const approvals = fakeApprovals("rejected");
    const brain = scriptedBrain((ctx) =>
      ctx.trigger.kind === "user_message"
        ? [toolTurn("run_command", { cmd: "node", args: ["--test"] })]
        : [],
    );
    const driver = makeDriver(studio, brain, {
      sandbox,
      approvals,
      approvalMode: () => "commands",
    });
    driver.submit({
      type: "user_message",
      roomId: ROOM_ID,
      text: "@陈实 跑一下",
      mentions: ["chenshi"],
    });
    await driver.whenIdle();
    assert.equal(approvals.requests.length, 0);
    assert.equal(sandbox.calls.length, 1);
    assert.equal(studio.state.toolCalls.at(-1)?.status, "ok");
  }
});

// ───────────────────────── 20. ReAct 回喂：handoff 正常处理 ─────────────────────────

test("回喂循环：tool_result 轮的 message + handoff 按正常 turn 处理，工具轮不推进 stage", async () => {
  const studio = makeStudio();
  const sandbox = fakeSandbox();
  const brain = scriptedBrain((ctx) => {
    if (ctx.cat.id !== "linzhiyuan") return [];
    if (ctx.trigger.kind === "user_message") return [toolTurn("list_files", {})];
    if (ctx.trigger.kind === "tool_result") {
      return [
        message("看完了，交给陈实。"),
        {
          kind: "handoff",
          to: "chenshi",
          card: card("实现 remember-me"),
          text: "@陈实 交给你。",
        },
      ];
    }
    return [];
  }, "llm");
  const driver = makeDriver(studio, brain, { sandbox });
  const task = newTask(studio); // stage=intake

  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "@林知远 先看看沙盒里有什么",
    mentions: ["linzhiyuan"],
  });
  await driver.whenIdle();

  const xianCalls = brain.callsFor("linzhiyuan");
  assert.equal(xianCalls.length, 2);
  assert.equal(xianCalls[0]?.trigger.kind, "user_message");
  assert.equal(xianCalls[1]?.trigger.kind, "tool_result");
  // 两次 think 时 stage 都还是 intake：工具轮本身没有推进阶段。
  assert.equal(xianCalls[0]?.stageAtCall, "intake");
  assert.equal(xianCalls[1]?.stageAtCall, "intake");

  const handoffs = studio.state.handoffs.filter((handoff) => handoff.taskId === task.id);
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0]?.from, "linzhiyuan");
  assert.equal(handoffs[0]?.to, "chenshi");
  assert.ok(studio.state.messages.some((m) => m.text === "看完了，交给陈实。"));
  assert.ok(
    studio.state.messages.some(
      (m) => m.kind === "handoff" && m.handoffId === handoffs[0]?.id,
    ),
  );
  assert.ok(studio.state.toolCalls.every((call) => call.status === "ok"));
  // handoff 正常驱动阶段（说明 afterTurns 只在回喂循环结束后跑了一次）。
  assert.notEqual(task.stage, "intake");
});

// ───────────────────────── 21. ReAct 回喂上限 ─────────────────────────

test("回喂循环上限 3：brain 每轮都给工具时最多 4 次 think / 4 次工具", async () => {
  const studio = makeStudio();
  const sandbox = fakeSandbox();
  const brain = scriptedBrain(
    (ctx) =>
      ctx.trigger.kind === "user_message" || ctx.trigger.kind === "tool_result"
        ? [toolTurn("list_files", {})]
        : [],
    "llm",
  );
  const driver = makeDriver(studio, brain, { sandbox });

  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "@周烁 一直看",
    mentions: ["zhoushuo"],
  });
  await driver.whenIdle();

  const shuoCalls = brain.callsFor("zhoushuo");
  assert.equal(shuoCalls.length, 4, "首轮 + 3 次回喂");
  assert.equal(shuoCalls[0]?.trigger.kind, "user_message");
  assert.deepEqual(
    shuoCalls.slice(1).map((call) => call.trigger.kind),
    ["tool_result", "tool_result", "tool_result"],
  );
  assert.equal(studio.state.toolCalls.length, 4);
  assert.ok(studio.state.toolCalls.every((call) => call.status === "ok"));
});

// ───────────────────────── 22. recentToolResults ─────────────────────────

test("recentToolResults：最近已结束回执按时间正序、字段完整且不含 pending/running", async () => {
  const studio = makeStudio();
  let captured: ToolRunResult[] | undefined;
  const sandbox = fakeSandbox((tool) =>
    tool === "read_file"
      ? { status: "ok", output: "hello" }
      : { status: "ok", output: "a.js" },
  );
  const brain = scriptedBrain((ctx) => {
    if (ctx.trigger.kind === "user_message") {
      return [toolTurn("read_file", { path: "src/remember.js" }), toolTurn("list_files", {})];
    }
    if (ctx.trigger.kind === "tool_result") {
      captured = ctx.recentToolResults;
      return [message("知道了。")];
    }
    return [];
  }, "llm");
  const driver = makeDriver(studio, brain, { sandbox });

  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "@周烁 看看沙盒",
    mentions: ["zhoushuo"],
  });
  await driver.whenIdle();

  assert.ok(captured);
  const calls = studio.state.toolCalls;
  assert.equal(calls.length, 2);
  assert.deepEqual(captured, [
    { callId: calls[0]?.id, tool: "read_file", status: "ok", output: "hello" },
    { callId: calls[1]?.id, tool: "list_files", status: "ok", output: "a.js" },
  ]);
  // 结果里没有 exitCode 时，回执对象也不带该字段。
  assert.equal(captured[0]?.exitCode, undefined);
  assert.equal(captured[0]?.callId, calls[0]?.id);
  assert.equal(captured[1]?.callId, calls[1]?.id);
});

// ───────────────────────── 23. 审批策略矩阵 ─────────────────────────

test("审批策略：commands 只批 run_command，all 连 write_file 也批", async () => {
  async function run(mode: ToolApprovalMode) {
    const studio = makeStudio();
    const sandbox = fakeSandbox();
    const approvals = fakeApprovals("approved");
    const brain = scriptedBrain(
      (ctx) =>
        ctx.trigger.kind === "user_message"
          ? [toolTurn("write_file", { path: "src/remember.js", content: "// v2" })]
          : [],
      "llm",
    );
    const driver = makeDriver(studio, brain, {
      sandbox,
      approvals,
      approvalMode: () => mode,
    });
    driver.submit({
      type: "user_message",
      roomId: ROOM_ID,
      text: "@陈实 改文件",
      mentions: ["chenshi"],
    });
    await driver.whenIdle();
    return { approvals, sandbox, studio };
  }

  // commands：write_file 不在审批范围 → 直接执行。
  const commands = await run("commands");
  assert.equal(commands.approvals.requests.length, 0);
  assert.equal(commands.sandbox.calls.length, 1);
  assert.equal(commands.studio.state.toolCalls.at(-1)?.status, "ok");

  // all：write_file 也要审批 → 批准后执行。
  const all = await run("all");
  assert.equal(all.approvals.requests.length, 1);
  assert.equal(all.approvals.requests[0]?.tool, "write_file");
  assert.equal(all.approvals.requests[0]?.mode, "all");
  assert.equal(all.sandbox.calls.length, 1);
  assert.equal(all.studio.state.toolCalls.at(-1)?.status, "ok");
});

// ───────────────────────── 24. 工具注册表 + MCP 风险审批 ─────────────────────────

test("工具注册表：MCP needs_approval 工具在 commands 下审批，批准后走 registry.execute", async () => {
  const studio = makeStudioWith({
    chenshi: {
      tools: ["read_file", "write_file", "list_files", "run_command", "mcp.weather"],
    },
  });
  const registry = fakeRegistry([READ_FILE_DEF, MCP_WEATHER_DEF], (_name, input) => ({
    status: "ok",
    output: `${String(input.city)} 晴`,
  }));
  const approvals = fakeApprovals("approved");
  const brain = scriptedBrain((ctx) => {
    if (ctx.trigger.kind === "user_message") {
      return [toolTurn("mcp.weather", { city: "上海" })];
    }
    if (ctx.trigger.kind === "tool_result") return [message("天气拿到了。")];
    return [];
  }, "llm");
  const driver = makeDriver(studio, brain, {
    tools: registry,
    approvals,
    approvalMode: () => "commands",
  });

  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "@陈实 查下天气",
    mentions: ["chenshi"],
  });
  await driver.whenIdle();

  // 风险来自 ToolDefinition.risk=needs_approval（不是 run_command 特判）。
  assert.equal(approvals.requests.length, 1);
  assert.equal(approvals.requests[0]?.tool, "mcp.weather");
  assert.equal(approvals.requests[0]?.mode, "commands");
  assert.equal(approvals.requests[0]?.label, `查天气 · {"city":"上海"}`);

  // 执行走 registry，而不是 sandbox。
  assert.equal(registry.executed.length, 1);
  assert.equal(registry.executed[0]?.name, "mcp.weather");
  assert.deepEqual(registry.executed[0]?.input, { city: "上海" });

  const call = studio.state.toolCalls.at(-1);
  assert.ok(call);
  assert.equal(call.status, "ok");
  assert.equal(call.output, "上海 晴");
  assert.equal(call.label, `查天气 · {"city":"上海"}`);

  assert.equal(brain.calls.length, 2);
  assert.equal(brain.calls[1]?.trigger.kind, "tool_result");
  assert.equal(brain.calls[1]?.trigger.toolResults?.[0]?.status, "ok");
  assert.ok(studio.state.messages.some((m) => m.text === "天气拿到了。"));
  // 非内置工具的默认结果文案是「标题 + 完成」。
  assert.ok(
    studio.state.messages.some((m) => m.kind === "tool" && m.text === "查天气 完成"),
  );
});

test("执行优先走工具注册表：同时传 tools 与 sandbox 时内置工具也走 registry", async () => {
  const studio = makeStudioWith({ chenshi: { tools: ["read_file"] } });
  const registry = fakeRegistry([READ_FILE_DEF], () => ({
    status: "ok",
    output: "from registry",
  }));
  const sandbox = fakeSandbox(() => ({ status: "ok", output: "from sandbox" }));
  const brain = scriptedBrain((ctx) =>
    ctx.trigger.kind === "user_message"
      ? [toolTurn("read_file", { path: "a.js" })]
      : [],
  );
  const driver = makeDriver(studio, brain, { tools: registry, sandbox });

  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "@陈实 读一下",
    mentions: ["chenshi"],
  });
  await driver.whenIdle();

  assert.equal(registry.executed.length, 1);
  assert.equal(registry.executed[0]?.name, "read_file");
  assert.equal(sandbox.calls.length, 0, "有注册表时不应再碰 sandbox");
  assert.equal(studio.state.toolCalls.at(-1)?.output, "from registry");
});

// ───────────────────────── 25. 每猫工具权限 ─────────────────────────

test("cat.tools 权限：允许的工具执行，未授权的不执行、error 记账并回喂", async () => {
  const studio = makeStudioWith({ chenshi: { tools: ["read_file"] } });
  const sandbox = fakeSandbox((tool) => ({ status: "ok", output: `ran ${String(tool)}` }));
  const brain = scriptedBrain((ctx) => {
    if (ctx.trigger.kind === "user_message") {
      return [
        toolTurn("run_command", { cmd: "node", args: ["--test"] }),
        toolTurn("read_file", { path: "src/remember.js" }),
        message("先读一下。"),
      ];
    }
    if (ctx.trigger.kind === "tool_result") return [message("看到了。")];
    return [];
  }, "llm");
  const driver = makeDriver(studio, brain, { sandbox });

  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "@陈实 跑测试然后读代码",
    mentions: ["chenshi"],
  });
  await driver.whenIdle();

  // 未授权的 run_command 没被真正执行，allowed 的 read_file 执行了。
  assert.equal(sandbox.calls.length, 1);
  assert.equal(sandbox.calls[0]?.tool, "read_file");

  const calls = studio.state.toolCalls;
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.tool, "run_command");
  assert.equal(calls[0]?.status, "error");
  assert.equal(calls[0]?.output, "陈实 没有权限使用 run_command");
  assert.equal(calls[1]?.status, "ok");

  const deniedMessage = studio.state.messages.find((m) => m.toolCallId === calls[0]?.id);
  assert.ok(deniedMessage);
  assert.equal(deniedMessage.text, "陈实 没有权限使用 run_command");

  // 回喂给模型的 toolResults 里也带这条 error。
  assert.equal(brain.calls.length, 2);
  const fedBack = brain.calls[1]?.trigger.toolResults ?? [];
  assert.equal(fedBack.length, 2);
  assert.equal(fedBack[0]?.status, "error");
  assert.equal(fedBack[0]?.output, "陈实 没有权限使用 run_command");
  assert.ok(studio.state.messages.some((m) => m.text === "看到了。"));
});

test("cat.tools 空数组：没有任何工具权限（mock 剧本同样受限）", async () => {
  const studio = makeStudioWith({ chenshi: { tools: [] } });
  const sandbox = fakeSandbox();
  const brain = scriptedBrain((ctx) =>
    ctx.trigger.kind === "user_message"
      ? [toolTurn("read_file", { path: "src/remember.js" }), message("先写方案。")]
      : [],
  );
  const driver = makeDriver(studio, brain, { sandbox });

  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "@陈实 读一下",
    mentions: ["chenshi"],
  });
  await driver.whenIdle();

  assert.equal(sandbox.calls.length, 0);
  const call = studio.state.toolCalls.at(-1);
  assert.ok(call);
  assert.equal(call.status, "error");
  assert.equal(call.output, "陈实 没有权限使用 read_file");
  assert.ok(
    studio.state.messages.some((m) => m.text === "陈实 没有权限使用 read_file"),
  );
  assert.ok(studio.state.messages.some((m) => m.text === "先写方案。"));
});

// ───────────────────────── 26. availableTools / skills 上下文 ─────────────────────────

test("TurnContext.availableTools / skills：按每猫权限与技能配置注入", async () => {
  const studio = makeStudioWith({
    chenshi: { tools: ["read_file", "mcp.weather"], skills: ["tdd", "architecture"] },
    shenyan: { tools: [] },
    zhoushuo: { tools: undefined, skills: undefined },
  });
  const registry = fakeRegistry([READ_FILE_DEF, MCP_WEATHER_DEF]);
  const brain = scriptedBrain(() => []);
  const driver = makeDriver(studio, brain, { tools: registry });

  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "@陈实 @林知远 @周烁 @沈砚 集合",
    mentions: ["chenshi", "linzhiyuan", "zhoushuo", "shenyan"],
  });
  await driver.whenIdle();

  const byCat = new Map(brain.calls.map((call) => [call.cat.id, call]));
  assert.equal(byCat.size, 4);

  const implementer = byCat.get("chenshi");
  assert.deepEqual(
    implementer?.availableTools.map((definition) => definition.name),
    ["read_file", "mcp.weather"],
  );
  assert.deepEqual(
    implementer?.skills.map((skill) => skill.id),
    ["tdd", "architecture"],
  );
  assert.ok((implementer?.skills[0]?.prompt.length ?? 0) > 0);

  // 林知远在 CATS 里是 read_file/list_files 白名单；假注册表里只有 read_file。
  const architect = byCat.get("linzhiyuan");
  assert.deepEqual(
    architect?.availableTools.map((definition) => definition.name),
    ["read_file"],
  );
  assert.deepEqual(
    architect?.skills.map((skill) => skill.id),
    ["architecture"],
  );

  // skills undefined → skillsForCat 用角色默认。
  const designer = byCat.get("zhoushuo");
  assert.deepEqual(
    designer?.availableTools.map((definition) => definition.name),
    ["read_file", "mcp.weather"],
  );
  assert.deepEqual(
    designer?.skills.map((skill) => skill.id),
    ["design-system"],
  );

  // tools: [] → 一个可用工具都没有。
  const reviewer = byCat.get("shenyan");
  assert.deepEqual(reviewer?.availableTools, []);
  assert.deepEqual(
    reviewer?.skills.map((skill) => skill.id),
    ["review-checklist"],
  );

  assert.equal(registry.executed.length, 0);
});

test("resolveSkill：cat.skills 里的自定义技能会被解析进 TurnContext.skills", async () => {
  const studio = makeStudioWith({
    chenshi: { tools: ["read_file"], skills: ["custom-deploy"] },
  });
  const registry = fakeRegistry([READ_FILE_DEF]);
  const brain = scriptedBrain(() => []);
  const customSkill: Skill = {
    id: "custom-deploy",
    name: "部署纪律",
    description: "自定义技能",
    prompt: "【技能：部署纪律】先备份再发布。",
  };
  const driver = makeDriver(studio, brain, {
    tools: registry,
    resolveSkill: (id) => (id === customSkill.id ? customSkill : undefined),
  });

  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "@陈实 看看技能",
    mentions: ["chenshi"],
  });
  await driver.whenIdle();

  const call = brain.calls[0];
  assert.ok(call);
  assert.deepEqual(
    call.skills.map((skill) => skill.id),
    ["custom-deploy"],
  );
  assert.equal(call.skills[0]?.prompt, customSkill.prompt);
});


describe("同房间并发任务的 stall 判定", () => {
  test("后一个任务排队等待时不该被误标 stalled", async () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    const brain = createMockBrain(SCENARIOS);
    const driver = createDriver({
      studio,
      brain,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))),
      stallMs: 120,
    });
    try {
      const first = studio.createTask({
        roomId: "room_cafe",
        brief: "第一个任务：写 add 函数",
        // export_csv 没有埋 missed_mention 故障，适合验证「排队不应被判卡住」。
        scenarioId: "export_csv",
      });
      const second = studio.createTask({
        roomId: "room_cafe",
        brief: "第二个任务：写 sub 函数",
        scenarioId: "export_csv",
      });
      driver.submit({ type: "task_created", roomId: "room_cafe", taskId: first.id });
      driver.submit({ type: "task_created", roomId: "room_cafe", taskId: second.id });

      // 等到超过 stallMs 若干倍，两个任务都应该在推进，而不是被判 stalled。
      await new Promise((resolve) => setTimeout(resolve, 700));
      const tasks = studio.snapshot().tasks;
      const stalled = tasks.filter((task) => task.status === "stalled");
      assert.equal(stalled.length, 0, `不该有任务被误标 stalled，实际 ${JSON.stringify(tasks.map((t) => [t.stage, t.status]))}`);
      // 至少有一个任务已经推进出 intake。
      assert.ok(tasks.some((task) => task.stage !== "intake"), JSON.stringify(tasks.map((t) => t.stage)));
    } finally {
      studio.close();
    }
  });
});


describe("评审拉锯保护", () => {
  test("反复 request_changes 超过上限后强制收尾，并记一条 lesson", async () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    let reviewCount = 0;
    const brain = {
      mode: "mock" as const,
      async think(ctx: { task: { stage: string } | null; cat: { id: string; role: string } }) {
        const stage = ctx.task?.stage;
        if (stage === "intake") {
          return [{ kind: "message" as const, text: "接需求" }];
        }
        if (stage === "planning") {
          return [
            {
              kind: "handoff" as const,
              to: "chenshi",
              card: {
                what: "实现",
                why: "拆活",
                tradeoff: "先做最小实现",
                openQuestions: [],
                nextAction: "交实现",
              },
            },
          ];
        }
        if (stage === "working" || stage === "revising") {
          return [
            {
              kind: "artifact" as const,
              artifact: { kind: "patch" as const, title: "实现稿", body: "diff" },
              mentions: ["shenyan"],
            },
            {
              kind: "handoff" as const,
              to: "shenyan",
              card: {
                what: "评审",
                why: "交叉评审",
                tradeoff: "先看最小实现",
                openQuestions: [],
                nextAction: "给结论",
              },
            },
          ];
        }
        if (stage === "reviewing") {
          reviewCount += 1;
          return [
            {
              kind: "review" as const,
              verdict: "request_changes" as const,
              title: "还要改",
              findings: [{ severity: "blocker" as const, title: "问题", detail: "细节" }],
              text: "继续改",
              mentions: ["chenshi"],
            },
          ];
        }
        if (stage === "done") {
          return [{ kind: "message" as const, text: "收尾" }];
        }
        return [{ kind: "message" as const, text: "..." }];
      },
    };

    const driver = createDriver({
      studio,
      brain: brain as never,
      wait: () => Promise.resolve(),
      stallMs: 5000,
    });
    try {
      const task = studio.createTask({
        roomId: "room_cafe",
        brief: "反复打回的任务",
        scenarioId: "export_csv",
      });
      driver.submit({ type: "task_created", roomId: "room_cafe", taskId: task.id });
      await driver.whenIdle();
      // 再跑几轮，让拉锯触发上限。
      for (let i = 0; i < 12; i += 1) {
        await driver.whenIdle();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const final = studio.getTask(task.id);
      assert.ok(final);
      assert.equal(final?.status, "done", `应强制收尾，实际 ${final?.stage}/${final?.status}，评审 ${reviewCount} 次`);
      assert.ok(
        studio.snapshot().memory.some((entry) => entry.tags.includes("review-loop")),
        "应记录 review-loop 教训",
      );
    } finally {
      studio.close();
    }
  });
});


describe("工具并行执行", () => {
  test("同一轮的多个 read_file 并行执行（总耗时接近单个）", async () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    const order: string[] = [];
    const sandbox = {
      async execute(tool: unknown, input: Record<string, unknown>) {
        const path = String(input["path"] ?? "");
        order.push(`start:${path}`);
        await new Promise((resolve) => setTimeout(resolve, 120));
        order.push(`end:${path}`);
        return { status: "ok" as const, output: `content:${path}` };
      },
    };
    let calls = 0;
    const brain = {
      mode: "mock" as const,
      async think() {
        calls += 1;
        if (calls > 1) return [{ kind: "message" as const, text: "（后续轮次略）" }];
        return [
          { kind: "tool" as const, tool: "read_file", input: { path: "a.js" } },
          { kind: "tool" as const, tool: "read_file", input: { path: "b.js" } },
          { kind: "tool" as const, tool: "read_file", input: { path: "c.js" } },
          { kind: "message" as const, text: "读完了" },
        ];
      },
    };
    const driver = createDriver({
      studio,
      brain: brain as never,
      wait: () => Promise.resolve(),
      sandbox,
      stallMs: 5000,
    });
    try {
      const task = studio.createTask({
        roomId: "room_cafe",
        brief: "并行读三个文件",
        scenarioId: "export_csv",
      });
      const started = Date.now();
      driver.submit({ type: "task_created", roomId: "room_cafe", taskId: task.id });
      await driver.whenIdle();
      const elapsed = Date.now() - started;

      // 三个串行要 360ms+；并行应该接近 120ms。
      assert.ok(elapsed < 320, `并行执行应更快，实际 ${elapsed}ms`);
      const calls = studio.snapshot().toolCalls;
      assert.equal(calls.length, 3);
      assert.ok(calls.every((call) => call.status === "ok"));
      // 三个 start 都应在任何 end 之前发生（证明真的并发）。
      const firstEnd = order.indexOf("end:a.js");
      const startsBeforeEnd = order.slice(0, firstEnd).filter((item) => item.startsWith("start:")).length;
      assert.equal(startsBeforeEnd, 3, JSON.stringify(order));
    } finally {
      studio.close();
    }
  });

  test("write_file 与 read_file 不并行（保持因果顺序）", async () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    const order: string[] = [];
    const sandbox = {
      async execute(tool: unknown, input: Record<string, unknown>) {
        order.push(`${String(tool)}:${String(input["path"] ?? "")}`);
        return { status: "ok" as const, output: "ok" };
      },
    };
    // 陈实有 write_file 权限；林知远没有，用陈实验证顺序。
    const implementer = CATS.find((cat) => cat.id === "chenshi")!;
    let calls = 0;
    const brain = {
      mode: "mock" as const,
      async think() {
        calls += 1;
        if (calls > 1) return [{ kind: "message" as const, text: "（后续轮次略）" }];
        return [
          { kind: "tool" as const, tool: "read_file", input: { path: "a.js" } },
          { kind: "tool" as const, tool: "write_file", input: { path: "a.js", content: "new" } },
          { kind: "tool" as const, tool: "read_file", input: { path: "a.js" } },
          { kind: "message" as const, text: "完成" },
        ];
      },
    };
    const driver = createDriver({
      studio,
      brain: brain as never,
      wait: () => Promise.resolve(),
      sandbox,
      stallMs: 5000,
    });
    try {
      const task = studio.createTask({
        roomId: "room_cafe",
        brief: "读写交错",
        scenarioId: "export_csv",
      });
      // 直接把 owner 换成陈实，让第一轮由它执行。
      studio.updateTaskStage(task.id, "working", implementer.id);
      studio.setTyping("room_cafe", null);
      // 直接驱动一次 worker wake：用 nudge 会走 architect，这里改成用 user_message @ 陈实。
      driver.submit({
        type: "user_message",
        roomId: "room_cafe",
        text: "@陈实 动手",
        mentions: [implementer.id],
      });
      await driver.whenIdle();
      assert.deepEqual(order.slice(0, 3), ["read_file:a.js", "write_file:a.js", "read_file:a.js"]);
    } finally {
      studio.close();
    }
  });
});

describe("任务收尾后的防护", () => {
  test("done 任务不再接受交接派活（防止 stage 回退）", async () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    // 这个 brain 在 done 之后仍会发交接卡（模拟真实模型的越界行为）
    let calls = 0;
    const brain = {
      mode: "mock" as const,
      async think(): Promise<AgentTurn[]> {
        calls += 1;
        if (calls === 1) {
          return [
            { kind: "message", text: "开工" },
            {
              kind: "handoff",
              to: "chenshi",
              card: { what: "实现", why: "拆活", tradeoff: "x", openQuestions: [], nextAction: "做" },
            },
          ];
        }
        if (calls === 2) {
          return [
            { kind: "message", text: "再派一次" },
            {
              kind: "handoff",
              to: "zhoushuo",
              card: { what: "越界", why: "x", tradeoff: "x", openQuestions: [], nextAction: "x" },
            },
          ];
        }
        // 之后不再说话，避免测试无限循环
        return [];
      },
    };
    const driver = createDriver({
      studio,
      brain: brain as never,
      wait: () => Promise.resolve(),
      stallMs: 60_000,
    });
    try {
      const task = studio.createTask({
        roomId: "room_cafe",
        brief: "收尾后防护测试",
        scenarioId: "export_csv",
      });
      driver.submit({ type: "task_created", roomId: "room_cafe", taskId: task.id });
      await driver.whenIdle();
      studio.setTaskStatus(task.id, "done");
      studio.updateTaskStage(task.id, "done", "linzhiyuan");

      const stageBefore = studio.getTask(task.id)?.stage;
      const stepsBefore = studio.getTask(task.id)?.steps.length ?? 0;

      driver.submit({
        type: "user_message",
        roomId: "room_cafe",
        text: "@林知远 再说两句",
        mentions: ["linzhiyuan"],
      });
      await driver.whenIdle();

      const after = studio.getTask(task.id);
      assert.equal(after?.stage, stageBefore, "done 后 stage 不应变化");
      assert.equal(after?.status, "done", "done 后状态不应变化");
      assert.equal(after?.steps.length, stepsBefore, "done 后不应新增步骤");
    } finally {
      studio.close();
    }
  });
});

describe("worker 轮崩溃时的兜底", () => {
  /**
   * 回归：worker 的 brain 抛错时，不能把整轮吞成「什么都没发生」——
   * 否则这只 worker 既没产出、也不会触发评审，任务就停在 working 直到 stall 超时。
   * 现在 processWake 把 brain 异常兜成空轮次，afterTurns 仍会走 worker 分支，
   * 计数和评审照常推进。
   */
  test("worker 的 brain 抛错后，任务仍能进入 reviewing 而不是卡在 working", async () => {
    const studio = makeStudio();
    const task = studio.createTask({
      roomId: ROOM_ID,
      brief: "给登录页加一个记住我勾选框，7天内免登录",
      scenarioId: SCENARIO_ID,
    });

    // 周烁（designer）作为 worker 接活时 brain 抛错；其他成员正常。
    const brain = scriptedBrain((ctx) => {
      const stage = ctx.task?.stage ?? null;
      if (ctx.cat.id === "zhoushuo" && stage === "working") {
        throw new Error("模拟 brain 崩溃");
      }
      if (ctx.trigger.kind === "nudge") {
        return [message("我补一下。")];
      }
      if (stage === "intake") {
        return [message("我接住这个需求。")];
      }
      if (stage === "planning") {
        return [
          {
            kind: "handoff",
            to: "zhoushuo",
            card: card("设计勾选框状态与文案"),
            text: "@周烁 交互交给你。",
          },
        ];
      }
      if (ctx.cat.id === "shenyan") {
        return [
          {
            kind: "review",
            title: "评审通过",
            verdict: "approve",
            findings: [],
            text: "通过。",
          },
        ];
      }
      return [message("收到。")];
    });

    const driver = makeDriver(studio, brain);
    try {
      driver.submit({ type: "task_created", roomId: ROOM_ID, taskId: task.id });
      await driver.whenIdle();

      const after = studio.getTask(task.id);
      assert.ok(after, "任务应存在");
      assert.notEqual(
        after.stage,
        "working",
        `worker 崩溃后任务不该永久停在 working，实际 stage=${after.stage} status=${after.status}`,
      );
    } finally {
      studio.close();
    }
  });
});
