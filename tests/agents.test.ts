/**
 * T2 内容测试：四猫人格、场景剧本、确定性 mock brain。
 * 运行：node --test tests/agents.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMockBrain } from "../src/agents/mock-brain.ts";
import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import type {
  Artifact,
  Cat,
  CatTurn,
  HandoffCard,
  MemoryEntry,
  Room,
  Scenario,
  Task,
  TaskStage,
  Trigger,
  TurnContext,
} from "../src/domain/types.ts";
import { Sandbox } from "../src/tools/sandbox.ts";
import { getSkill, listSkills, skillsForCat } from "../src/skills/registry.ts";

const ROOM: Room = {
  id: "room_test",
  name: "猫咖 · 测试桌",
  topic: "测试用房间",
  catIds: CATS.map((cat) => cat.id),
  createdAt: 0,
};

const ALL_STAGES: TaskStage[] = ["intake", "planning", "working", "reviewing", "revising", "done"];

// ───────────────────────── 构造辅助 ─────────────────────────

function catOf(id: string): Cat {
  const cat = CATS.find((item) => item.id === id);
  if (!cat) throw new Error(`missing cat: ${id}`);
  return cat;
}

function scenarioOf(id: string): Scenario {
  const scenario = SCENARIOS.find((item) => item.id === id);
  if (!scenario) throw new Error(`missing scenario: ${id}`);
  return scenario;
}

function makeTask(scenarioId: string, stage: TaskStage, overrides: Partial<Task> = {}): Task {
  return {
    id: `task_${scenarioId}_${stage}`,
    roomId: ROOM.id,
    title: "记住我",
    brief: "给登录页加一个「记住我」勾选框，7 天内免登录。",
    scenarioId,
    status: "active",
    stage,
    owner: "xianxian",
    steps: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function patchArtifact(taskId: string, version: number): Artifact {
  return {
    id: `art_patch_v${version}`,
    taskId,
    kind: "patch",
    title: `后端实现 v${version}`,
    body: "diff 摘要",
    author: "jinjianceng",
    version,
    createdAt: version,
  };
}

function makeCtx(input: {
  catId: string;
  task?: Task | null;
  trigger: Trigger;
  memory?: MemoryEntry[];
  artifacts?: Artifact[];
  scenario?: Scenario | null;
}): TurnContext {
  return {
    cat: catOf(input.catId),
    room: ROOM,
    task: input.task ?? null,
    trigger: input.trigger,
    recentMessages: [],
    memory: input.memory ?? [],
    handoffs: [],
    recentToolResults: [],
    availableTools: [],
    skills: [],
    artifacts: input.artifacts ?? [],
    scenario: input.scenario ?? null,
  };
}

function userTrigger(text: string, mentions: string[] = []): Trigger {
  return { kind: "user_message", roomId: ROOM.id, text, mentions };
}

function taskTrigger(
  kind: "task_created" | "handoff" | "artifact" | "review_result",
  taskId: string,
): Trigger {
  return { kind, roomId: ROOM.id, taskId };
}

function nudgeTrigger(taskId: string): Trigger {
  return { kind: "nudge", roomId: ROOM.id, taskId };
}

// ───────────────────────── 断言辅助 ─────────────────────────

function serialized(turns: CatTurn[]): string {
  return JSON.stringify(turns);
}

function assertNoPlaceholders(turns: CatTurn[]): void {
  const leftover = serialized(turns).match(/\{\{[^}]*\}\}/u);
  assert.equal(leftover, null, `未替换的占位符：${leftover?.[0] ?? ""}`);
}

function assertCardComplete(card: HandoffCard, label: string): void {
  for (const key of ["what", "why", "tradeoff", "nextAction"] as const) {
    assert.ok(card[key].trim().length >= 8, `${label} 的 ${key} 太短或为空`);
  }
  assert.ok(card.openQuestions.length >= 1, `${label} 的 openQuestions 为空`);
  for (const question of card.openQuestions) {
    assert.ok(question.trim().length > 0, `${label} 的 openQuestions 有空项`);
  }
}

function messageTurns(turns: CatTurn[]): Array<Extract<CatTurn, { kind: "message" }>> {
  return turns.filter((turn): turn is Extract<CatTurn, { kind: "message" }> => turn.kind === "message");
}

function handoffTurns(turns: CatTurn[]): Array<Extract<CatTurn, { kind: "handoff" }>> {
  return turns.filter((turn): turn is Extract<CatTurn, { kind: "handoff" }> => turn.kind === "handoff");
}

function reviewTurns(turns: CatTurn[]): Array<Extract<CatTurn, { kind: "review" }>> {
  return turns.filter((turn): turn is Extract<CatTurn, { kind: "review" }> => turn.kind === "review");
}

function toolTurns(turns: CatTurn[]): Array<Extract<CatTurn, { kind: "tool" }>> {
  return turns.filter((turn): turn is Extract<CatTurn, { kind: "tool" }> => turn.kind === "tool");
}

function beatTurns(scenario: Scenario, stage: TaskStage, cat: string): CatTurn[] {
  return scenario.beats
    .filter((beat) => beat.stage === stage && beat.cat === cat)
    .map((beat) => beat.turn);
}

function toolBeatTurns(
  scenario: Scenario,
  stage: TaskStage,
  cat: string,
): Array<Extract<CatTurn, { kind: "tool" }>> {
  return toolTurns(beatTurns(scenario, stage, cat));
}

function isRunOf(
  turn: Extract<CatTurn, { kind: "tool" }>,
  testFile: string,
): boolean {
  if (turn.tool !== "run_command") return false;
  const args = turn.input["args"];
  return (
    turn.input["cmd"] === "node" &&
    Array.isArray(args) &&
    args[0] === "--test" &&
    args[1] === testFile
  );
}

function sentenceCount(text: string): number {
  return text
    .split(/[。！？!?]+/u)
    .map((part) => part.trim())
    .filter(Boolean).length;
}

// ───────────────────────── 猫猫人格 ─────────────────────────

test("四只猫：id 固定、字段齐全、人格互不重复", () => {
  assert.deepEqual(
    CATS.map((cat) => cat.id).sort(),
    ["jinjianceng", "shuoshuo", "xianxian", "yanyan"],
  );
  assert.deepEqual(
    [...new Set(CATS.map((cat) => cat.role))].sort(),
    ["architect", "designer", "implementer", "reviewer"],
  );

  for (const cat of CATS) {
    for (const key of ["name", "species", "title", "persona", "catchphrase", "greeting"] as const) {
      assert.ok(cat[key].trim().length > 0, `${cat.id}.${key} 不能为空`);
    }
    assert.match(cat.accent, /^#[0-9a-fA-F]{6}$/u, `${cat.id} 主题色必须是 hex`);
    assert.ok(
      ["ragdoll", "mainecoon", "siamese", "golden"].includes(cat.avatar),
      `${cat.id} 的头像 key 非法`,
    );
  }

  assert.equal(new Set(CATS.map((cat) => cat.catchphrase)).size, CATS.length);
});

// ───────────────────────── 工具 / 技能默认值 ─────────────────────────

const EXPECTED_CAT_DEFAULTS: Record<string, { tools: string[]; skills: string[] }> = {
  xianxian: { tools: ["read_file", "list_files"], skills: ["architecture"] },
  yanyan: { tools: ["read_file", "list_files", "run_command"], skills: ["review-checklist"] },
  shuoshuo: { tools: ["read_file", "list_files"], skills: ["design-system"] },
  jinjianceng: {
    tools: ["read_file", "write_file", "list_files", "run_command"],
    skills: ["tdd"],
  },
};

test("四猫工具/技能默认值：存在、合法、能被技能包解析", () => {
  const validTools = new Set(["read_file", "write_file", "list_files", "run_command"]);

  for (const cat of CATS) {
    const expected = EXPECTED_CAT_DEFAULTS[cat.id];
    assert.ok(expected, `${cat.id} 缺少期望的默认工具/技能`);
    if (!expected) continue;

    assert.ok(cat.tools, `${cat.id} 缺少 tools 默认值`);
    assert.ok(cat.skills, `${cat.id} 缺少 skills 默认值`);
    assert.deepEqual(cat.tools, expected.tools, `${cat.id} 的 tools 默认值不符合契约`);
    assert.deepEqual(cat.skills, expected.skills, `${cat.id} 的 skills 默认值不符合契约`);

    for (const tool of cat.tools ?? []) {
      assert.ok(validTools.has(tool), `${cat.id} 配置了未知工具：${tool}`);
    }
    for (const id of cat.skills ?? []) {
      assert.ok(getSkill(id), `${cat.id} 的技能包 id 解析不到：${id}`);
    }

    // cat.skills 优先：解析结果就是四猫的默认技能包
    assert.deepEqual(
      skillsForCat(cat).map((skill) => skill.id),
      expected.skills,
      `${cat.id} 的 skillsForCat 结果与默认值不一致`,
    );
  }

  // 四猫默认技能包互不重复（各司其职）
  const allSkillIds = CATS.flatMap((cat) => cat.skills ?? []);
  assert.equal(new Set(allSkillIds).size, allSkillIds.length);
  assert.equal(allSkillIds.length, 4);
});

test("skillsForCat：cat.skills 优先、角色默认兜底、未知 id 忽略", () => {
  const implementer = catOf("jinjianceng");

  // 1) 自定义 skills 优先于角色默认
  const custom: Cat = { ...implementer, skills: ["design-system", "architecture"] };
  assert.deepEqual(
    skillsForCat(custom).map((skill) => skill.id),
    ["design-system", "architecture"],
  );

  // 2) skills 为空数组 → 回落到角色默认
  assert.deepEqual(
    skillsForCat({ ...implementer, skills: [] }).map((skill) => skill.id),
    ["tdd"],
  );

  // 3) 没配置 skills → 同样回落到角色默认
  assert.deepEqual(
    skillsForCat({ ...implementer, skills: undefined }).map((skill) => skill.id),
    ["tdd"],
  );

  // 4) 未知 id 被忽略，重复 id 去重
  assert.deepEqual(
    skillsForCat({ ...implementer, skills: ["tdd", "ghost", "tdd"] }).map((skill) => skill.id),
    ["tdd"],
  );

  // 5) 每个角色的兜底映射与四猫默认一致
  for (const cat of CATS) {
    const expected = EXPECTED_CAT_DEFAULTS[cat.id];
    if (!expected) continue;
    assert.deepEqual(
      skillsForCat({ ...cat, skills: undefined }).map((skill) => skill.id),
      expected.skills,
      `${cat.id} 的角色默认技能不对`,
    );
  }
});

test("四个技能包：结构完整、prompt 是可照做的规则（60–160 字）", () => {
  const skills = listSkills();
  assert.deepEqual(
    skills.map((skill) => skill.id).sort(),
    ["architecture", "design-system", "review-checklist", "tdd"],
  );

  for (const skill of skills) {
    assert.ok(skill.name.trim().length > 0, `${skill.id} 缺少 name`);
    assert.ok(skill.description.trim().length > 0, `${skill.id} 缺少 description`);

    const length = [...skill.prompt].length;
    assert.ok(length >= 60 && length <= 160, `${skill.id} 的 prompt 长度 ${length} 不在 60–160`);
    assert.ok(skill.prompt.includes("【技能："), `${skill.id} 的 prompt 缺少技能标题`);
    const rules = skill.prompt.match(/^- /gmu) ?? [];
    assert.ok(rules.length >= 3, `${skill.id} 至少要有 3 条可照做的规则`);
    assert.equal(getSkill(skill.id), skill);
  }
});

// ───────────────────────── 场景结构 ─────────────────────────

test("场景：至少两个，且每个都覆盖完整六阶段", () => {
  assert.ok(SCENARIOS.length >= 2);
  assert.deepEqual(SCENARIOS.map((scenario) => scenario.id).sort(), ["export_csv", "remember_me"]);
  assert.equal(new Set(SCENARIOS.map((scenario) => scenario.id)).size, SCENARIOS.length);

  for (const scenario of SCENARIOS) {
    assert.ok(scenario.name.trim().length > 0, `${scenario.id} 缺少 name`);
    assert.ok(scenario.sampleBrief.trim().length > 0, `${scenario.id} 缺少 sampleBrief`);
    assert.ok(scenario.tags.length > 0, `${scenario.id} 缺少 tags`);
    assert.ok(scenario.beats.length >= 8, `${scenario.id} 的 beats 太少`);

    const stages = new Set(scenario.beats.map((beat) => beat.stage));
    for (const stage of ALL_STAGES) {
      assert.ok(stages.has(stage), `${scenario.id} 缺少 ${stage} 阶段的 beat`);
    }

    for (const beat of scenario.beats) {
      assert.ok(
        CATS.some((cat) => cat.id === beat.cat),
        `${scenario.id} 有未知的猫：${beat.cat}`,
      );
      assert.ok(beat.turn.kind.length > 0);
    }
  }
});

test("每个场景每个阶段都能从 mock brain 取到内容，且没有残留占位符", async () => {
  for (const scenario of SCENARIOS) {
    for (const stage of ALL_STAGES) {
      const first = scenario.beats.find((beat) => beat.stage === stage);
      if (!first) throw new Error(`${scenario.id} 的 ${stage} 阶段没有 beat`);

      const brain = createMockBrain(SCENARIOS);
      const task = makeTask(scenario.id, stage, {
        id: `task_sample_${scenario.id}_${stage}`,
        brief: scenario.sampleBrief,
      });
      const trigger =
        stage === "intake" ? taskTrigger("task_created", task.id) : taskTrigger("handoff", task.id);
      const turns = await brain.think(makeCtx({ catId: first.cat, task, trigger }));

      assert.ok(turns.length > 0, `${scenario.id}/${stage}/${first.cat} 没有台词`);
      assertNoPlaceholders(turns);
      assert.ok(serialized(turns).includes('"text"'), `${scenario.id}/${stage} 缺少文本`);
    }
  }
});

test("所有交接卡五栏完整，接收方都是四猫之一", () => {
  let handoffCount = 0;
  for (const scenario of SCENARIOS) {
    for (const beat of scenario.beats) {
      if (beat.turn.kind !== "handoff") continue;
      handoffCount += 1;
      const handoff = beat.turn;
      assert.ok(
        CATS.some((cat) => cat.id === handoff.to),
        `${scenario.id} 的交接卡收件人未知：${handoff.to}`,
      );
      assertCardComplete(handoff.card, `${scenario.id}/${beat.cat}→${handoff.to}`);
    }
  }
  assert.ok(handoffCount >= 6, `交接卡数量偏少：${handoffCount}`);
});

// ───────────────────────── 工具节拍 ─────────────────────────

const TOOL_CASES = [
  { id: "remember_me", source: "src/remember.js", testFile: "test/remember.test.js", failed: /过期后校验失败/u },
  { id: "export_csv", source: "src/export.js", testFile: "test/export.test.js", failed: /逗号字段要加引号|引号要 doubling/u },
] as const;

test("剧本工具节拍：金渐层先写文件再跑测试，砚砚先跑测试再 review", () => {
  for (const item of TOOL_CASES) {
    const scenario = scenarioOf(item.id);

    // working：写文件 → 跑测试 → 承认失败 → patch → 交接
    const working = beatTurns(scenario, "working", "jinjianceng");
    const workingTools = toolTurns(working);
    assert.deepEqual(
      workingTools.map((turn) => turn.tool),
      ["write_file", "run_command"],
      `${item.id} working 应先写文件再跑测试`,
    );
    assert.equal(workingTools[0]?.input["path"], item.source);
    const workingRun = workingTools[1];
    if (!workingRun) throw new Error(`${item.id} working 缺少跑测试`);
    assert.equal(isRunOf(workingRun, item.testFile), true);

    const workingRunIndex = working.indexOf(workingRun);
    const patchIndex = working.findIndex(
      (turn) => turn.kind === "artifact" && turn.artifact.kind === "patch",
    );
    assert.ok(patchIndex > workingRunIndex, "先跑测试，再交 patch");
    const handoffIndex = working.findIndex((turn) => turn.kind === "handoff");
    assert.ok(handoffIndex > patchIndex, "交接卡在 patch 之后");
    assert.ok(
      working
        .slice(workingRunIndex + 1)
        .some((turn) => turn.kind === "message" && /失败|没全过|挂了|没过/u.test(turn.text)),
      "跑完失败的测试后，金渐层应该有台词承认问题",
    );

    // revising：写 v2 → 再跑测试 → v2 patch → 交接
    const revising = beatTurns(scenario, "revising", "jinjianceng");
    const revisingTools = toolTurns(revising);
    assert.deepEqual(
      revisingTools.map((turn) => turn.tool),
      ["write_file", "run_command"],
      `${item.id} revising 应先写 v2 再跑测试`,
    );
    assert.equal(revisingTools[0]?.input["path"], item.source);
    const revisingRun = revisingTools[1];
    if (!revisingRun) throw new Error(`${item.id} revising 缺少跑测试`);
    assert.equal(isRunOf(revisingRun, item.testFile), true);
    const revisingRunIndex = revising.indexOf(revisingRun);
    const v2PatchIndex = revising.findIndex(
      (turn) => turn.kind === "artifact" && turn.artifact.title.includes("v2"),
    );
    assert.ok(v2PatchIndex > revisingRunIndex, "v2 patch 在跑测试之后");

    // reviewing：两轮都先跑测试，紧挨着 review
    const reviewing = beatTurns(scenario, "reviewing", "yanyan");
    const reviewingTools = toolTurns(reviewing);
    assert.equal(reviewingTools.length, 2, `${item.id} 两轮 review 都应先跑测试`);
    for (const runTurn of reviewingTools) assert.equal(isRunOf(runTurn, item.testFile), true);
    const reviewIndexes = reviewing.flatMap((turn, index) =>
      turn.kind === "review" ? [index] : [],
    );
    assert.equal(reviewIndexes.length, 2);
    for (const index of reviewIndexes) {
      const before = reviewing[index - 1];
      assert.equal(before?.kind, "tool", "review 前面应该紧挨着一次跑测试");
      if (before?.kind === "tool") assert.equal(isRunOf(before, item.testFile), true);
    }
  }
});

test("所有工具节拍结构合法：路径相对、命令只有 node、参数安全", () => {
  const allowedTools = new Set(["read_file", "write_file", "list_files", "run_command"]);
  let toolCount = 0;
  for (const scenario of SCENARIOS) {
    for (const beat of scenario.beats) {
      if (beat.turn.kind !== "tool") continue;
      toolCount += 1;
      const turn = beat.turn;
      assert.ok(allowedTools.has(turn.tool), `${scenario.id} 出现未知工具：${turn.tool}`);
      assert.ok(
        typeof turn.label === "string" && turn.label.trim().length > 0,
        `${scenario.id} 的 tool turn 缺少可读 label`,
      );
      assert.ok(turn.input !== null && typeof turn.input === "object");

      if (turn.tool === "write_file") {
        const path = turn.input["path"];
        const content = turn.input["content"];
        assert.equal(typeof path, "string");
        assert.ok(
          typeof path === "string" && !path.startsWith("/") && !path.includes(".."),
          "write_file 的 path 必须是相对沙盒的路径",
        );
        assert.equal(typeof content, "string");
        assert.ok(typeof content === "string" && content.trim().length > 50, "写入内容不能太短");
      } else if (turn.tool === "run_command") {
        assert.equal(turn.input["cmd"], "node", "命令只允许 node");
        const args = turn.input["args"];
        assert.ok(Array.isArray(args) && args.length > 0);
        for (const arg of args as unknown[]) {
          assert.equal(typeof arg, "string");
          assert.ok(
            typeof arg === "string" && !arg.startsWith("/") && !arg.includes(".."),
            "命令参数必须安全",
          );
        }
      }
    }
  }
  assert.equal(toolCount, 12, `工具节拍数量应为 12（2 场景 × 6），实际 ${toolCount}`);
});

test("剧本里的 v1/v2 在真实沙盒里：测试失败 → 修复后通过", async () => {
  for (const item of TOOL_CASES) {
    const scenario = scenarioOf(item.id);
    const dir = mkdtempSync(join(tmpdir(), "catcafe-agents-"));
    const sandbox = new Sandbox(dir);
    try {
      sandbox.ensureSeed();

      // working v1：写文件 → 跑测试 → 必须失败（台词说的问题要真的出现）
      const workingTools = toolBeatTurns(scenario, "working", "jinjianceng");
      assert.equal(workingTools.length, 2);
      for (const turn of workingTools) {
        const result = await sandbox.execute(turn.tool, turn.input);
        if (turn.tool === "write_file") {
          assert.equal(result.status, "ok", `${item.id} v1 写文件失败：${result.output}`);
        } else {
          assert.equal(result.status, "error", `${item.id} 的 v1 测试应该失败`);
          assert.notEqual(result.exitCode, 0);
          assert.match(result.output, item.failed);
        }
      }

      // revising v2：写文件 → 再跑测试 → 必须通过
      const revisingTools = toolBeatTurns(scenario, "revising", "jinjianceng");
      assert.equal(revisingTools.length, 2);
      for (const turn of revisingTools) {
        const result = await sandbox.execute(turn.tool, turn.input);
        if (turn.tool === "write_file") {
          assert.equal(result.status, "ok", `${item.id} v2 写文件失败：${result.output}`);
        } else {
          assert.equal(result.status, "ok", `${item.id} 的 v2 测试应该通过：${result.output}`);
          assert.equal(result.exitCode, 0);
          assert.match(result.output, /pass 3/u);
        }
      }

      // 沙盒里确实落下了真实文件
      const read = await sandbox.execute("read_file", { path: item.source });
      assert.equal(read.status, "ok");
      assert.ok(read.output.trim().length > 20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("remember_me：埋了 金渐层 → 砚砚 的 missed_mention 漏 @", async () => {
  const scenario = scenarioOf("remember_me");
  const faultBeats = scenario.beats.filter((beat) => beat.fault === "missed_mention");
  assert.equal(faultBeats.length, 1, "漏 @ 的埋点应该只有一张卡");

  const faultBeat = faultBeats[0];
  if (!faultBeat) throw new Error("missing fault beat");
  assert.equal(faultBeat.cat, "jinjianceng");
  assert.equal(faultBeat.stage, "working");
  if (faultBeat.turn.kind !== "handoff") throw new Error("fault beat 必须是 handoff");
  assert.equal(faultBeat.turn.to, "yanyan");
  assert.equal(
    (faultBeat.turn.text ?? "").includes("@"),
    false,
    "漏 @ 的交接台词里不该出现 @",
  );

  // driver 只认 turn.handoff.fault：beats 上的 fault 必须透传进 turn
  const brain = createMockBrain(SCENARIOS);
  const task = makeTask("remember_me", "working");
  const turns = await brain.think(
    makeCtx({ catId: "jinjianceng", task, trigger: taskTrigger("handoff", task.id) }),
  );
  const handoff = handoffTurns(turns).find((turn) => turn.to === "yanyan");
  if (!handoff) throw new Error("working 阶段应该产出交接卡");
  assert.equal(handoff.fault, "missed_mention");
});

// ───────────────────────── driver 调用契约 ─────────────────────────

test("driver 契约：intake 只回消息、planning 一次给「消息 + 2 张卡」", async () => {
  for (const scenario of SCENARIOS) {
    const brain = createMockBrain(SCENARIOS);
    const task = makeTask(scenario.id, "intake", {
      id: `task_contract_${scenario.id}`,
      brief: scenario.sampleBrief,
    });

    // 1) task_created → intake：只有消息，不带 handoff，driver 才会自动进 planning
    const intake = await brain.think(
      makeCtx({ catId: "xianxian", task, trigger: taskTrigger("task_created", task.id) }),
    );
    assert.equal(intake.length, 1, `${scenario.id} 的 intake 应该只有一条消息`);
    assert.equal(intake[0]?.kind, "message");
    assert.equal(handoffTurns(intake).length, 0);
    assertNoPlaceholders(intake);

    // 2) planning：一条接住需求的消息 + 烁烁 / 金渐层两张 handoff
    task.stage = "planning";
    const planning = await brain.think(
      makeCtx({ catId: "xianxian", task, trigger: taskTrigger("handoff", task.id) }),
    );
    const planningMessages = messageTurns(planning);
    const planningHandoffs = handoffTurns(planning);
    assert.equal(planningMessages.length, 1, `${scenario.id} 的 planning 应该有一条消息`);
    assert.equal(planningHandoffs.length, 2, `${scenario.id} 的 planning 应该发两张交接卡`);
    assert.deepEqual(
      planningHandoffs.map((handoff) => handoff.to),
      ["shuoshuo", "jinjianceng"],
    );
    for (const handoff of planningHandoffs) assertCardComplete(handoff.card, `${scenario.id} planning`);
    assertNoPlaceholders(planning);
  }
});

test("driver 契约：working 一次给「写文件 + 跑测试 + patch + 交接卡」", async () => {
  const brain = createMockBrain(SCENARIOS);
  const task = makeTask("remember_me", "working", { id: "task_working_contract" });

  const design = await brain.think(
    makeCtx({ catId: "shuoshuo", task, trigger: taskTrigger("handoff", task.id) }),
  );
  assert.equal(design.length, 1);
  assert.equal(design[0]?.kind, "artifact");

  const implementation = await brain.think(
    makeCtx({ catId: "jinjianceng", task, trigger: taskTrigger("handoff", task.id) }),
  );
  assert.deepEqual(
    implementation.map((turn) => turn.kind),
    ["message", "tool", "tool", "message", "artifact", "handoff"],
    "金渐层应该：说一句 → 写文件 → 跑测试 → 承认失败 → 交 patch → 交接",
  );

  const tools = toolTurns(implementation);
  assert.deepEqual(tools.map((turn) => turn.tool), ["write_file", "run_command"]);
  assert.equal(tools[0]?.input["path"], "src/remember.js");
  const run = tools[1];
  if (!run) throw new Error("缺少跑测试的 tool turn");
  assert.equal(isRunOf(run, "test/remember.test.js"), true);

  const patch = implementation.find((turn) => turn.kind === "artifact");
  if (patch?.kind !== "artifact") throw new Error("应该产出 patch artifact");
  assert.equal(patch.artifact.kind, "patch");
  const runIndex = implementation.indexOf(run);
  assert.ok(implementation.indexOf(patch) > runIndex, "先跑测试，再交 artifact");

  const handoffs = handoffTurns(implementation);
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0]?.to, "yanyan");
  assert.equal(handoffs[0]?.fault, "missed_mention");
});

test("driver 契约：reviewing 先跑测试，再按 artifacts 版本只返回一个结论", async () => {
  const brain = createMockBrain(SCENARIOS);
  const task = makeTask("remember_me", "reviewing", { id: "task_review_contract" });

  // 只有 v1 patch → 先跑测试，再 request_changes
  const v1Only = await brain.think(
    makeCtx({
      catId: "yanyan",
      task,
      trigger: taskTrigger("handoff", task.id),
      artifacts: [patchArtifact(task.id, 1)],
    }),
  );
  assert.deepEqual(v1Only.map((turn) => turn.kind), ["tool", "review"]);
  const v1Run = toolTurns(v1Only)[0];
  if (!v1Run) throw new Error("review 之前应该先跑测试");
  assert.equal(isRunOf(v1Run, "test/remember.test.js"), true);
  const first = reviewTurns(v1Only)[0];
  if (!first) throw new Error("第一次 review 应该有结论");
  assert.equal(first.verdict, "request_changes");

  // v2 出现 → 再跑测试，然后 approve
  const revised = await brain.think(
    makeCtx({
      catId: "yanyan",
      task,
      trigger: taskTrigger("artifact", task.id),
      artifacts: [patchArtifact(task.id, 1), patchArtifact(task.id, 2)],
    }),
  );
  assert.deepEqual(revised.map((turn) => turn.kind), ["tool", "review"]);
  const v2Run = toolTurns(revised)[0];
  if (!v2Run) throw new Error("第二轮 review 之前也应该跑测试");
  assert.equal(isRunOf(v2Run, "test/remember.test.js"), true);
  const second = reviewTurns(revised)[0];
  if (!second) throw new Error("第二次 review 应该有结论");
  assert.equal(second.verdict, "approve");

  // 没有 version 字段信息时，用 patch 数量也能判断（两张 patch = 已 revise）
  const byCount = await brain.think(
    makeCtx({
      catId: "yanyan",
      task,
      trigger: taskTrigger("artifact", task.id),
      artifacts: [patchArtifact(task.id, 1), { ...patchArtifact(task.id, 2), version: 1 }],
    }),
  );
  assert.equal(reviewTurns(byCount)[0]?.verdict, "approve");
});

// ───────────────────────── 全流程 ─────────────────────────

test("mock brain：remember_me 六阶段全流程（含打回 → 修改 → 通过）", async () => {
  const brain = createMockBrain(SCENARIOS);
  const task = makeTask("remember_me", "intake", {
    id: "task_remember_flow",
    title: "给登录页加「记住我」",
    brief: "给登录页加一个「记住我」勾选框，7 天内免登录。",
  });
  const artifacts: Artifact[] = [];

  // intake：宪宪接需求
  const intake = await brain.think(
    makeCtx({ catId: "xianxian", task, trigger: taskTrigger("task_created", task.id) }),
  );
  const intakeMessage = messageTurns(intake)[0];
  if (!intakeMessage) throw new Error("intake 应该是 message");
  assert.ok(intakeMessage.text.includes("勾选框"), "intake 应该复述需求 brief");

  // planning：消息 + 两张交接卡
  task.stage = "planning";
  const planning = await brain.think(
    makeCtx({ catId: "xianxian", task, trigger: taskTrigger("handoff", task.id) }),
  );
  assert.equal(planning.length, 3, "planning 应该是 1 条消息 + 2 张卡");
  assert.deepEqual(handoffTurns(planning).map((handoff) => handoff.to), ["shuoshuo", "jinjianceng"]);

  // working：烁烁设计稿
  task.stage = "working";
  const design = await brain.think(
    makeCtx({ catId: "shuoshuo", task, trigger: taskTrigger("handoff", task.id) }),
  );
  const designTurn = design[0];
  if (designTurn?.kind !== "artifact") throw new Error("烁烁应该交 artifact");
  assert.equal(designTurn.artifact.kind, "design");
  assert.ok((designTurn.mentions ?? []).includes("xianxian"));

  // working：金渐层写文件 → 跑测试（失败）→ 实现稿 + 漏 @ 的交接卡
  const implementation = await brain.think(
    makeCtx({ catId: "jinjianceng", task, trigger: taskTrigger("handoff", task.id) }),
  );
  assert.deepEqual(
    implementation.map((turn) => turn.kind),
    ["message", "tool", "tool", "message", "artifact", "handoff"],
  );
  const implTools = toolTurns(implementation);
  assert.deepEqual(implTools.map((turn) => turn.tool), ["write_file", "run_command"]);
  const patchTurn = implementation.find((turn) => turn.kind === "artifact");
  if (patchTurn?.kind !== "artifact") throw new Error("金渐层应该交 patch artifact");
  assert.equal(patchTurn.artifact.kind, "patch");
  const reviewHandoff = handoffTurns(implementation)[0];
  if (!reviewHandoff) throw new Error("金渐层应该发出 review 交接卡");
  assert.equal(reviewHandoff.to, "yanyan");
  assert.equal(reviewHandoff.fault, "missed_mention");
  artifacts.push(patchArtifact(task.id, 1));

  // reviewing：砚砚先跑测试，再抓 1 blocker + 1 minor，request_changes
  task.stage = "reviewing";
  const review1 = await brain.think(
    makeCtx({
      catId: "yanyan",
      task,
      trigger: taskTrigger("handoff", reviewHandoff.to),
      artifacts,
    }),
  );
  assert.deepEqual(review1.map((turn) => turn.kind), ["tool", "review"]);
  assert.equal(toolTurns(review1)[0]?.input["cmd"], "node");
  const review1Turn = reviewTurns(review1)[0];
  if (!review1Turn) throw new Error("砚砚应该产出 review");
  assert.equal(review1Turn.verdict, "request_changes");
  assert.ok((review1Turn.mentions ?? []).includes("jinjianceng"));
  assert.deepEqual(
    review1Turn.findings.map((finding) => finding.severity).sort(),
    ["blocker", "minor"],
  );

  // revising：金渐层写 v2 → 跑测试 → v2 patch + 干净交接
  task.stage = "revising";
  const revise = await brain.think(
    makeCtx({ catId: "jinjianceng", task, trigger: taskTrigger("review_result", task.id), artifacts }),
  );
  assert.deepEqual(
    revise.map((turn) => turn.kind),
    ["tool", "tool", "artifact", "handoff"],
  );
  const reviseTools = toolTurns(revise);
  assert.deepEqual(reviseTools.map((turn) => turn.tool), ["write_file", "run_command"]);
  assert.equal(reviseTools[0]?.input["path"], "src/remember.js");
  const revisePatch = revise.find((turn) => turn.kind === "artifact");
  if (revisePatch?.kind !== "artifact") throw new Error("revising 应该交 patch");
  assert.equal(revisePatch.artifact.title.includes("v2"), true);
  const reviseHandoff = handoffTurns(revise)[0];
  if (!reviseHandoff) throw new Error("revising 应该有重新交接");
  assert.equal(reviseHandoff.to, "yanyan");
  assert.equal(reviseHandoff.fault, undefined);
  artifacts.push(patchArtifact(task.id, 2));

  // reviewing 第二次：v2 已在 artifacts 里 → 再跑测试后 approve（不能重播打回）
  task.stage = "reviewing";
  const review2 = await brain.think(
    makeCtx({ catId: "yanyan", task, trigger: taskTrigger("artifact", task.id), artifacts }),
  );
  assert.deepEqual(review2.map((turn) => turn.kind), ["tool", "review"]);
  const review2Turn = reviewTurns(review2)[0];
  if (!review2Turn) throw new Error("第二次 review 应该还是 review");
  assert.equal(review2Turn.verdict, "approve");

  // done：宪宪落决策 + 决策 / 教训记忆
  task.stage = "done";
  const done = await brain.think(
    makeCtx({ catId: "xianxian", task, trigger: taskTrigger("review_result", task.id), artifacts }),
  );
  const decision = done[0];
  if (decision?.kind !== "decision") throw new Error("done 阶段应该产出 decision");
  assert.ok(decision.artifact.title.trim().length > 0);
  assert.deepEqual(
    decision.memory.map((entry) => entry.kind).sort(),
    ["decision", "lesson"],
  );

  assertNoPlaceholders([
    ...intake,
    ...planning,
    ...design,
    ...implementation,
    ...review1,
    ...revise,
    ...review2,
    ...done,
  ]);
});

// ───────────────────────── 记忆复用 ─────────────────────────

test("export_csv：宪宪 planning 台词引用上次 remember-me 的决策记忆", async () => {
  const brain = createMockBrain(SCENARIOS);
  const task = makeTask("export_csv", "intake", {
    id: "task_export_flow",
    title: "后台导出 CSV",
    brief: "后台加一个导出 CSV 的按钮，只有管理员能下载全量数据。",
  });
  const memory: MemoryEntry[] = [
    {
      id: "mem_remember_me",
      kind: "decision",
      title: "REMEMBER_ME_DECISION_V1",
      body: "remember-me 用 HttpOnly cookie，固定 7 天过期，默认不勾选。",
      tags: ["remember_me", "auth", "token"],
      createdAt: 0,
    },
  ];

  const intake = await brain.think(
    makeCtx({ catId: "xianxian", task, trigger: taskTrigger("task_created", task.id), memory }),
  );
  assert.equal(intake.length, 1);
  assertNoPlaceholders(intake);

  task.stage = "planning";
  const planning = await brain.think(
    makeCtx({ catId: "xianxian", task, trigger: taskTrigger("handoff", task.id), memory }),
  );
  const planningText = messageTurns(planning)[0]?.text ?? "";
  assert.ok(planningText.includes("REMEMBER_ME_DECISION_V1"), `台词没有引用记忆：${planningText}`);
  assert.deepEqual(handoffTurns(planning).map((handoff) => handoff.to), ["shuoshuo", "jinjianceng"]);
  assert.equal(handoffTurns(planning).some((handoff) => handoff.fault !== undefined), false);
  assertNoPlaceholders(planning);

  // 后续流程无故障，review 闭环与 remember_me 一致
  const artifacts: Artifact[] = [];
  task.stage = "working";
  await brain.think(makeCtx({ catId: "shuoshuo", task, trigger: taskTrigger("handoff", task.id), memory }));
  const workImpl = await brain.think(
    makeCtx({ catId: "jinjianceng", task, trigger: taskTrigger("handoff", task.id), memory }),
  );
  const implHandoff = handoffTurns(workImpl)[0];
  if (!implHandoff) throw new Error("export_csv working 应有交接卡");
  assert.equal(implHandoff.to, "yanyan");
  assert.equal(implHandoff.fault, undefined, "export_csv 不应有故障");
  artifacts.push(patchArtifact(task.id, 1));

  task.stage = "reviewing";
  const review1 = reviewTurns(
    await brain.think(
      makeCtx({ catId: "yanyan", task, trigger: taskTrigger("handoff", task.id), memory, artifacts }),
    ),
  )[0];
  if (!review1) throw new Error("reviewing 应有 review");
  assert.equal(review1.verdict, "request_changes");

  task.stage = "revising";
  await brain.think(
    makeCtx({ catId: "jinjianceng", task, trigger: taskTrigger("review_result", task.id), memory, artifacts }),
  );
  artifacts.push(patchArtifact(task.id, 2));
  task.stage = "reviewing";
  const review2 = reviewTurns(
    await brain.think(
      makeCtx({ catId: "yanyan", task, trigger: taskTrigger("artifact", task.id), memory, artifacts }),
    ),
  )[0];
  if (!review2) throw new Error("第二次 review 应有 review");
  assert.equal(review2.verdict, "approve");

  task.stage = "done";
  const done = await brain.think(
    makeCtx({ catId: "xianxian", task, trigger: taskTrigger("review_result", task.id), memory, artifacts }),
  );
  assert.equal(done[0]?.kind, "decision");
});

test("export_csv：没有记忆时用 remember-me 兜底引用，不出现空占位", async () => {
  const brain = createMockBrain(SCENARIOS);
  const task = makeTask("export_csv", "planning", { id: "task_export_no_memory" });
  const turns = await brain.think(
    makeCtx({ catId: "xianxian", task, trigger: taskTrigger("handoff", task.id) }),
  );
  const text = messageTurns(turns)[0]?.text ?? "";
  assert.match(text, /remember-me/u);
  assertNoPlaceholders(turns);
});

// ───────────────────────── @ 与闲聊 ─────────────────────────

test("mock brain：@ 到谁，谁按自己的口吻接话并引用用户原话", async () => {
  const texts = new Set<string>();
  for (const cat of CATS) {
    const brain = createMockBrain(SCENARIOS);
    const turns = await brain.think(
      makeCtx({
        catId: cat.id,
        task: null,
        trigger: userTrigger(`@${cat.name} 顺便看看移动端`, [cat.id]),
      }),
    );
    assert.equal(turns.length, 1);
    const message = messageTurns(turns)[0];
    if (!message) throw new Error(`${cat.id} 应该用 message 接话`);
    assert.ok(message.text.includes("顺便看看移动端"), `${cat.id} 没有引用用户原话`);
    assert.ok(sentenceCount(message.text) <= 5, `${cat.id} 的回复太长：${message.text}`);
    assertNoPlaceholders(turns);
    texts.add(message.text);
  }
  assert.equal(texts.size, CATS.length, "四只猫的回复应该各有口吻");

  // 有任务时，回复引用任务标题
  const task = makeTask("export_csv", "planning", { title: "后台导出 CSV" });
  const brain = createMockBrain(SCENARIOS);
  const turns = await brain.think(
    makeCtx({
      catId: "shuoshuo",
      task,
      trigger: userTrigger("@烁烁 导出按钮能加个进度吗", ["shuoshuo"]),
    }),
  );
  const message = messageTurns(turns)[0];
  if (!message) throw new Error("烁烁应该接话");
  assert.ok(message.text.includes("导出按钮能加个进度吗"));
  assert.ok(message.text.includes("后台导出 CSV"));
});

test("mock brain：没有任务时的闲聊自然接话", async () => {
  for (const cat of CATS) {
    const brain = createMockBrain(SCENARIOS);
    const turns = await brain.think(
      makeCtx({ catId: cat.id, task: null, trigger: userTrigger("现在忙吗") }),
    );
    const message = messageTurns(turns)[0];
    if (!message) throw new Error(`${cat.id} 应该接话`);
    assert.ok(message.text.trim().length > 0);
    assertNoPlaceholders(turns);
  }
});

// ───────────────────────── nudge 恢复 ─────────────────────────

test("mock brain：催一下 → 宪宪说明漏 @ 卡点，补投交给 driver（不重复发 handoff）", async () => {
  const brain = createMockBrain(SCENARIOS);
  const task = makeTask("remember_me", "working", { id: "task_stalled", status: "stalled" });

  // driver 在 nudge 之后会自己 deliverMissed 补投；brain 只给恢复台词，不能再发 handoff
  const turns = await brain.think(
    makeCtx({ catId: "xianxian", task, trigger: nudgeTrigger(task.id) }),
  );
  assert.equal(turns.length, 1, "nudge 只应该返回一条恢复消息");
  assert.equal(handoffTurns(turns).length, 0, "nudge 不能重复发交接卡，否则会重复唤醒砚砚");
  const message = messageTurns(turns)[0];
  if (!message) throw new Error("催一下应该先有说明");
  assert.ok(message.text.includes("没带 @") || message.text.includes("没 @"));
  assert.ok((message.mentions ?? []).includes("yanyan"));

  // 再催一次：不重复认领
  const again = await brain.think(
    makeCtx({ catId: "xianxian", task, trigger: nudgeTrigger(task.id) }),
  );
  assert.equal(again.length, 1);
  assert.ok((messageTurns(again)[0]?.text ?? "").includes("已经补过"));

  // 非主理猫被催：只说明情况
  const other = await brain.think(
    makeCtx({ catId: "jinjianceng", task, trigger: nudgeTrigger(task.id) }),
  );
  assert.equal(other.length, 1);
  assert.equal(other[0]?.kind, "message");

  // 任务正常推进时的「催一下」不该乱认漏 @ 的锅
  const healthy = makeTask("remember_me", "working", { id: "task_healthy", status: "active" });
  const healthyTurns = await brain.think(
    makeCtx({ catId: "xianxian", task: healthy, trigger: nudgeTrigger(healthy.id) }),
  );
  assert.equal(healthyTurns.length, 1);
  assert.ok(!(messageTurns(healthyTurns)[0]?.text ?? "").includes("没带 @"));
});

// ───────────────────────── 占位符与兜底 ─────────────────────────

test("{{brief}} / {{title}} 会被任务内容替换", async () => {
  const brain = createMockBrain(SCENARIOS);
  const brief = "把登录页的记住我改成 30 天，不要默认勾选";
  const title = "记住我改 30 天";
  const task = makeTask("remember_me", "intake", { id: "task_placeholders", brief, title });

  const intake = await brain.think(
    makeCtx({ catId: "xianxian", task, trigger: taskTrigger("task_created", task.id) }),
  );
  const intakeText = messageTurns(intake)[0]?.text ?? "";
  assert.ok(intakeText.includes(brief), "{{brief}} 没有被替换成需求原文");
  assertNoPlaceholders(intake);

  // {{title}} 出现在有任务的对话里
  const chat = await brain.think(
    makeCtx({ catId: "xianxian", task, trigger: userTrigger("这个还要改吗") }),
  );
  const chatText = messageTurns(chat)[0]?.text ?? "";
  assert.ok(chatText.includes(title), "{{title}} 没有被替换成任务标题");
  assertNoPlaceholders(chat);
});

test("mock brain：未知场景 / 词穷时按角色兜一句", async () => {
  const brain = createMockBrain(SCENARIOS);
  const task = makeTask("no_such_scenario", "working", { id: "task_unknown" });
  const turns = await brain.think(
    makeCtx({ catId: "jinjianceng", task, trigger: taskTrigger("handoff", task.id) }),
  );
  assert.equal(turns.length, 1);
  const message = messageTurns(turns)[0];
  if (!message) throw new Error("兜底也应该是 message");
  assert.ok(message.text.trim().length > 0);
});
