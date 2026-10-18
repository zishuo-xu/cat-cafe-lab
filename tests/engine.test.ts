/**
 * 引擎测试（T1）：用**脚本化假 brain**验证状态机、@路由、延迟调度、
 * 漏 @ 故障恢复与落库格式——不依赖 T2 的 mock-brain 进度。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import type {
  ApprovalGate,
  BrainMode,
  CatBrain,
  CatId,
  CatTurn,
  HandoffCard,
  SandboxRunner,
  Task,
  TaskStage,
  ToolApprovalDecision,
  ToolApprovalMode,
  ToolName,
  ToolResult,
  ToolRunResult,
  TurnContext,
} from "../src/domain/types.ts";
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

interface ScriptedBrain extends CatBrain {
  calls: CallRecord[];
  callsFor(catId: CatId, stage?: TaskStage): CallRecord[];
}

function scriptedBrain(
  handler: (ctx: TurnContext) => CatTurn[],
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

function makeDriver(
  studio: Studio,
  brain: CatBrain,
  extra: {
    sandbox?: SandboxRunner;
    toolsEnabled?: () => boolean;
    approvals?: ApprovalGate;
    approvalMode?: () => ToolApprovalMode;
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

interface FakeApprovalRequest {
  callId: string;
  mode: ToolApprovalMode;
  tool: ToolName;
  label: string;
  catId: CatId;
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

const message = (text: string, mentions?: CatId[]): CatTurn => ({
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

    if (cat === "xianxian") {
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
            to: "shuoshuo",
            card: card("设计勾选框状态与文案"),
            text: "@烁烁 交互交给你。",
          },
          {
            kind: "handoff",
            to: "jinjianceng",
            card: card("实现后端 remember-me token"),
            text: "@金渐层 后端交给你。",
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

    if (cat === "shuoshuo" && stage === "working") {
      return [
        {
          kind: "artifact",
          artifact: {
            kind: "design",
            title: "勾选框交互稿",
            body: "三态：未勾选 / 勾选 / 禁用。",
          },
          text: "交互稿在这，勾选框得会呼吸。",
          mentions: ["xianxian"],
        },
      ];
    }

    if (cat === "jinjianceng" && stage === "working") {
      const turns: CatTurn[] = [
        {
          kind: "artifact",
          artifact: { kind: "patch", title: "remember-me token v1", body: "新增 token 字段与校验。" },
          text: "能跑，v1 在这里。",
        },
        {
          kind: "handoff",
          to: "yanyan",
          card: card("review v1 实现"),
          text: "@砚砚 麻烦看下 v1。",
          ...(options.fault ? { fault: "missed_mention" as const } : {}),
        },
      ];
      return turns;
    }

    if (cat === "jinjianceng" && stage === "revising") {
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
          to: "yanyan",
          card: card("review v2 实现"),
          text: "@砚砚 再过一遍。",
        },
      ];
    }

    if (cat === "yanyan" && stage === "reviewing") {
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
            mentions: ["jinjianceng"],
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
          mentions: ["jinjianceng"],
        },
      ];
    }

    return [];
  });
}

// ───────────────────────── 1. task_created 分发 ─────────────────────────

test("task_created：architect 先说话，planning 把交接分发给烁烁与金渐层", async () => {
  const studio = makeStudio();
  const brain = scriptedBrain((ctx) => {
    const stage = ctx.task?.stage ?? null;
    if (ctx.cat.id === "xianxian" && stage === "intake") return [message("我先接住这个需求。")];
    if (ctx.cat.id === "xianxian" && stage === "planning") {
      return [
        { kind: "handoff", to: "shuoshuo", card: card("设计勾选框"), text: "@烁烁 设计交给你。" },
        { kind: "handoff", to: "jinjianceng", card: card("实现 token"), text: "@金渐层 实现交给你。" },
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
  assert.equal(intakeCall.cat.id, "xianxian");
  assert.equal(intakeCall.stageAtCall, "intake");
  assert.equal(intakeCall.trigger.kind, "task_created");
  assert.equal(intakeCall.scenario?.id, SCENARIO_ID);

  const messages = taskMessages(studio, task.id);
  const first = messages[0];
  assert.ok(first);
  assert.equal(first.author, "xianxian");
  assert.equal(first.kind, "chat");

  const handoffs = studio.state.handoffs.filter((h) => h.taskId === task.id);
  assert.deepEqual(handoffs.map((h) => h.from), ["xianxian", "xianxian"]);
  assert.deepEqual(handoffs.map((h) => h.to), ["shuoshuo", "jinjianceng"]);
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
    [["shuoshuo"], ["jinjianceng"]],
  );
  for (const m of handoffMessages) assert.ok(m.handoffId);

  // 交接只唤醒接收者。
  assert.equal(brain.callsFor("shuoshuo", "working").length, 1);
  assert.equal(brain.callsFor("jinjianceng", "working").length, 1);
  assert.equal(brain.callsFor("shuoshuo", "working")[0]?.trigger.kind, "handoff");
  assert.equal(brain.callsFor("jinjianceng", "working")[0]?.trigger.kind, "handoff");

  // working 全部跑完后自动进入 reviewing，只有砚砚被唤醒。
  const reviewerCalls = brain.callsFor("yanyan");
  assert.equal(reviewerCalls.length, 1);
  assert.equal(reviewerCalls[0]?.stageAtCall, "reviewing");
  assert.equal(reviewerCalls[0]?.trigger.kind, "artifact");

  assert.equal(task.stage, "reviewing");
  assert.equal(task.owner, "yanyan");
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

  // 没有任务 + 显式 @：只有烁烁醒。
  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "@烁烁 顺便看看移动端",
    mentions: ["shuoshuo"],
  });
  await driver.whenIdle();
  assert.deepEqual(
    brain.calls.map((call) => call.cat.id),
    ["shuoshuo"],
  );
  assert.equal(studio.state.messages.at(-1)?.author, "shuoshuo");

  // 没有任务 + 没有 @：宪宪作为主理猫接话。
  driver.submit({ type: "user_message", roomId: ROOM_ID, text: "大家看看", mentions: [] });
  await driver.whenIdle();
  assert.deepEqual(
    brain.calls.map((call) => call.cat.id),
    ["shuoshuo", "xianxian"],
  );

  // 有任务 + 没有 @：唤醒 task.owner。
  const task = newTask(studio);
  studio.updateTaskStage(task.id, "working", "jinjianceng");
  driver.submit({ type: "user_message", roomId: ROOM_ID, text: "进度怎么样", mentions: [] });
  await driver.whenIdle();
  assert.equal(brain.calls.at(-1)?.cat.id, "jinjianceng");
  assert.equal(brain.calls.at(-1)?.task?.id, task.id);

  // @ 优先于 owner：owner 是金渐层，但 @ 的是砚砚。
  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "@砚砚 看下这个",
    mentions: ["yanyan"],
  });
  await driver.whenIdle();
  assert.equal(brain.calls.at(-1)?.cat.id, "yanyan");
  assert.equal(brain.calls.filter((call) => call.cat.id === "jinjianceng").length, 1);
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
  assert.equal(task.owner, "shuoshuo");

  const faulted = studio.state.handoffs
    .filter((handoff) => handoff.taskId === task.id)
    .find((handoff) => handoff.to === "yanyan");
  assert.ok(faulted);
  const faultedMessage = studio.state.messages.find((m) => m.handoffId === faulted.id);
  assert.ok(faultedMessage);
  assert.equal(faultedMessage.kind, "handoff");
  // 本意是给它：mentions 仍写 [yanyan]，但没唤醒。
  assert.deepEqual(faultedMessage.mentions, ["yanyan"]);

  assert.equal(brain.callsFor("yanyan").length, 0);
  assert.equal(
    task.steps.some((step) => step.stage === "reviewing"),
    false,
  );
  assert.equal(brain.callsFor("jinjianceng", "working").length, 1);

  // 催一下：architect 先恢复，再补投递。
  driver.submit({ type: "nudge", taskId: task.id });
  await driver.whenIdle();

  assert.equal(task.status, "done");
  assert.equal(task.stage, "done");
  assert.equal(task.owner, "xianxian");
  assert.equal(typeof task.doneAt, "number");

  const nudgeCall = brain.calls.find((call) => call.trigger.kind === "nudge");
  assert.ok(nudgeCall);
  assert.equal(nudgeCall.cat.id, "xianxian");

  // 补投递：砚砚拿着原来那张卡进来，然后正常 review → revise → approve。
  const firstReview = brain.callsFor("yanyan")[0];
  assert.ok(firstReview);
  assert.equal(firstReview.trigger.kind, "handoff");
  assert.equal(firstReview.trigger.handoff?.what, "review v1 实现");
  assert.equal(brain.callsFor("yanyan").length, 2);
  assert.equal(brain.callsFor("jinjianceng", "revising").length, 1);

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
      "intake:xianxian:done",
      "planning:xianxian:done",
      "working:shuoshuo:done",
      "reviewing:yanyan:done",
      "revising:jinjianceng:done",
      "reviewing:yanyan:done",
      "done:xianxian:done",
    ],
  );

  const reviseCall = brain.callsFor("jinjianceng", "revising")[0];
  assert.ok(reviseCall);
  assert.equal(reviseCall.trigger.kind, "review_result");
  assert.equal(reviseCall.trigger.review?.verdict, "request_changes");
  assert.deepEqual(
    reviseCall.trigger.review?.findings.map((finding) => finding.severity),
    ["blocker", "minor"],
  );

  const reviewCalls = brain.callsFor("yanyan", "reviewing");
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
  assert.equal(doneCall.cat.id, "xianxian");
  assert.equal(doneCall.trigger.kind, "review_result");
  assert.equal(doneCall.trigger.review?.verdict, "approve");

  assert.equal(task.status, "done");
  assert.equal(task.stage, "done");
  assert.equal(task.owner, "xianxian");
  assert.equal(typeof task.doneAt, "number");

  const decisionArtifact = studio.state.artifacts.find(
    (artifact) => artifact.taskId === task.id && artifact.kind === "decision",
  );
  assert.ok(decisionArtifact);
  assert.equal(decisionArtifact.author, "xianxian");

  const decisionMessage = taskMessages(studio, task.id).find((m) => m.kind === "decision");
  assert.ok(decisionMessage);
  assert.equal(decisionMessage.author, "xianxian");
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
    assert.deepEqual(m.mentions, ["jinjianceng"]);
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

    if (cat === "xianxian" && stage === "intake") return [message("接住。")];
    if (cat === "xianxian" && stage === "planning") {
      return [{ kind: "handoff", to: "jinjianceng", card: card("实现"), text: "交给实现。" }];
    }
    if (cat === "xianxian" && stage === "done") {
      return [
        {
          kind: "decision",
          artifact: { title: "决定", body: "定稿。" },
          text: "决定。",
          memory: [],
        },
      ];
    }
    if (cat === "jinjianceng" && stage === "working") {
      return [
        {
          kind: "artifact",
          artifact: { kind: "patch", title: "v1", body: "第一版" },
          text: "v1",
        },
      ];
    }
    if (cat === "jinjianceng" && stage === "revising") {
      return [
        {
          kind: "artifact",
          artifact: { kind: "patch", title: "v2", body: "第二版" },
          text: "v2",
        },
        { kind: "handoff", to: "yanyan", card: card("review v2"), text: "再过一遍。" },
      ];
    }
    if (cat === "yanyan" && stage === "reviewing") {
      reviewRound += 1;
      if (reviewRound === 1) {
        return [
          {
            kind: "review",
            verdict: "request_changes",
            title: "r1",
            findings: [{ severity: "blocker", title: "问题", detail: "细节" }],
            text: "打回。",
            mentions: ["jinjianceng"],
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
  const calls: CatId[] = [];
  let active = 0;
  let maxActive = 0;
  const brain: CatBrain = {
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
    text: "@烁烁 看下",
    mentions: ["shuoshuo"],
  });
  // submit 不阻塞：同步返回，此时队列还没开跑。
  assert.deepEqual(calls, []);
  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "@砚砚 看下",
    mentions: ["yanyan"],
  });
  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "@金渐层 看下",
    mentions: ["jinjianceng"],
  });

  await driver.whenIdle();
  assert.equal(maxActive, 1);
  // 同房间严格按提交顺序串行。
  assert.deepEqual(calls, ["shuoshuo", "yanyan", "jinjianceng"]);
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
  assert.deepEqual(parseMentions("@烁烁 顺便看看移动端，@jinjianceng 也来", CATS), [
    "shuoshuo",
    "jinjianceng",
  ]);
  assert.deepEqual(parseMentions("@宪宪 @宪宪 重复点名", CATS), ["xianxian"]);
  assert.deepEqual(parseMentions("这里没有 at，只有 email@example", CATS), []);
  assert.deepEqual(parseMentions("@不存在的猫", CATS), []);

  assert.deepEqual(normalizeMentions([], CATS), []);
  assert.deepEqual(normalizeMentions(["shuoshuo", "unknown", "shuoshuo"], CATS), [
    "shuoshuo",
  ]);
  assert.deepEqual(handoffMentions("yanyan"), ["yanyan"]);

  const studio = makeStudio();
  // 无任务、无 @ → architect。
  assert.deepEqual(routeUserMessage(CATS, null, []), ["xianxian"]);
  // 无任务但有 @ → 只投给被 @ 的猫。
  assert.deepEqual(routeUserMessage(CATS, null, ["shuoshuo", "yanyan"]), [
    "shuoshuo",
    "yanyan",
  ]);
  // 有任务、无 @ → task.owner。
  const task = newTask(studio);
  studio.updateTaskStage(task.id, "reviewing", "yanyan");
  assert.deepEqual(routeUserMessage(CATS, task, []), ["yanyan"]);
  // @ 优先于 owner。
  assert.deepEqual(routeUserMessage(CATS, task, ["shuoshuo"]), ["shuoshuo"]);
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
  extra: { label?: string; text?: string; mentions?: CatId[] } = {},
): CatTurn {
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
    if (ctx.cat.id === "jinjianceng" && ctx.trigger.kind === "user_message") {
      return [toolTurn("run_command", { cmd: "node", args: ["--test", "test/remember.test.js"] })];
    }
    return [];
  });
  const driver = makeDriver(studio, brain, { sandbox });
  const task = newTask(studio);
  studio.updateTaskStage(task.id, "working", "jinjianceng");

  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "跑一下测试",
    mentions: ["jinjianceng"],
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
  assert.equal(call.catId, "jinjianceng");
  assert.equal(call.taskId, task.id);
  assert.equal(call.status, "ok");
  assert.equal(call.exitCode, 0);
  assert.equal(call.output, "executed run_command");
  assert.equal(typeof call.finishedAt, "number");

  const toolMessage = studio.state.messages.find((m) => m.kind === "tool");
  assert.ok(toolMessage);
  assert.equal(toolMessage.author, "jinjianceng");
  assert.equal(toolMessage.toolCallId, call.id);
  assert.equal(toolMessage.taskId, task.id);
  assert.equal(toolMessage.text, "跑了 node，退出码 0");

  // 工具不改变阶段 / owner。
  assert.equal(task.stage, "working");
  assert.equal(task.owner, "jinjianceng");
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
  studio.updateTaskStage(task.id, "working", "jinjianceng");

  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "改一下 remember.js",
    mentions: ["jinjianceng"],
  });
  await driver.whenIdle();

  assert.equal(sandbox.calls.length, 0);
  assert.equal(studio.state.toolCalls.length, 0);

  const messages = studio.state.messages.filter((m) => m.taskId === task.id);
  const explain = messages.find((m) => m.kind === "chat" && m.text.includes("工具执行被关掉了"));
  assert.ok(explain);
  assert.equal(explain.author, "jinjianceng");
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
    if (ctx.cat.id === "xianxian" && stage === "intake") return [message("接住。")];
    if (ctx.cat.id === "xianxian" && stage === "planning") {
      return [{ kind: "handoff", to: "jinjianceng", card: card("实现 token"), text: "交给实现。" }];
    }
    if (ctx.cat.id === "jinjianceng" && stage === "working") {
      return [
        toolTurn("run_command", { cmd: "node", args: ["--test"] }),
        {
          kind: "artifact",
          artifact: { kind: "patch", title: "v1", body: "先交一版" },
          text: "测试挂了，但我先把改动交出来。",
        },
        { kind: "handoff", to: "yanyan", card: card("review v1"), text: "@砚砚 看下。" },
      ];
    }
    if (ctx.cat.id === "yanyan" && stage === "reviewing") {
      return [
        {
          kind: "review",
          verdict: "approve",
          title: "review v1",
          findings: [],
          text: "先过，测试的事后面再说。",
          mentions: ["jinjianceng"],
        },
      ];
    }
    if (ctx.cat.id === "xianxian" && stage === "done") {
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
    text: "@烁烁 去沙盒里看看",
    mentions: ["shuoshuo"],
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
    text: "@金渐层 跑个测试",
    mentions: ["jinjianceng"],
  });
  await driver.whenIdle();

  assert.equal(studio.state.toolCalls.length, 0);
  const messages = studio.state.messages.filter((m) => m.author === "jinjianceng");
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
  studio.updateTaskStage(task.id, "working", "jinjianceng");

  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "跑个测试",
    mentions: ["jinjianceng"],
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
  assert.equal(approvals.requests[0]?.catId, "jinjianceng");
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
  studio.updateTaskStage(task.id, "working", "jinjianceng");

  driver.submit({
    type: "user_message",
    roomId: ROOM_ID,
    text: "跑个测试",
    mentions: ["jinjianceng"],
  });
  await driver.whenIdle();

  assert.equal(approvals.requests.length, 1);
  assert.equal(sandbox.calls.length, 0, "被拒绝时绝不能执行 sandbox");

  const call = studio.state.toolCalls.at(-1);
  assert.ok(call);
  assert.equal(call.status, "rejected");
  assert.equal(call.exitCode, undefined);
  assert.equal(call.output, "铲屎官拒绝了这次执行");

  const toolMessages = studio.state.messages.filter((m) => m.kind === "tool");
  assert.equal(toolMessages.length, 2);
  assert.equal(toolMessages[0]?.text, "等你批准：运行 node --test");
  assert.equal(toolMessages[1]?.toolCallId, call.id);
  assert.equal(toolMessages[1]?.text, "铲屎官拒绝了这次执行，我换个办法。");

  assert.equal(brain.calls.length, 2);
  const second = brain.calls[1];
  assert.ok(second);
  assert.equal(second.trigger.kind, "tool_result");
  assert.equal(second.trigger.toolResults?.[0]?.callId, call.id);
  assert.equal(second.trigger.toolResults?.[0]?.status, "rejected");
  assert.equal(second.trigger.toolResults?.[0]?.output, "铲屎官拒绝了这次执行");
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
      text: "@烁烁 跑一下",
      mentions: ["shuoshuo"],
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
      text: "@烁烁 跑一下",
      mentions: ["shuoshuo"],
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
    if (ctx.cat.id !== "xianxian") return [];
    if (ctx.trigger.kind === "user_message") return [toolTurn("list_files", {})];
    if (ctx.trigger.kind === "tool_result") {
      return [
        message("看完了，交给金渐层。"),
        {
          kind: "handoff",
          to: "jinjianceng",
          card: card("实现 remember-me"),
          text: "@金渐层 交给你。",
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
    text: "@宪宪 先看看沙盒里有什么",
    mentions: ["xianxian"],
  });
  await driver.whenIdle();

  const xianCalls = brain.callsFor("xianxian");
  assert.equal(xianCalls.length, 2);
  assert.equal(xianCalls[0]?.trigger.kind, "user_message");
  assert.equal(xianCalls[1]?.trigger.kind, "tool_result");
  // 两次 think 时 stage 都还是 intake：工具轮本身没有推进阶段。
  assert.equal(xianCalls[0]?.stageAtCall, "intake");
  assert.equal(xianCalls[1]?.stageAtCall, "intake");

  const handoffs = studio.state.handoffs.filter((handoff) => handoff.taskId === task.id);
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0]?.from, "xianxian");
  assert.equal(handoffs[0]?.to, "jinjianceng");
  assert.ok(studio.state.messages.some((m) => m.text === "看完了，交给金渐层。"));
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
    text: "@烁烁 一直看",
    mentions: ["shuoshuo"],
  });
  await driver.whenIdle();

  const shuoCalls = brain.callsFor("shuoshuo");
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
    text: "@烁烁 看看沙盒",
    mentions: ["shuoshuo"],
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
      text: "@烁烁 改文件",
      mentions: ["shuoshuo"],
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
