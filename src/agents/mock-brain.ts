/**
 * 确定性 mock brain：不调用任何模型，按场景 beats 播放猫猫的台词与动作。
 * T2 拥有此文件。
 *
 * 与 T1 driver 的调用契约：
 *   - intake（宪宪，task_created）：只回一条消息，不带 handoff，driver 会自动进 planning；
 *   - planning（宪宪）：一次返回「接住需求的消息 + 2 张 handoff（烁烁 / 金渐层）」；
 *   - working（烁烁 / 金渐层）：一次返回该猫的 artifact（金渐层是 patch + 给砚砚的 handoff）；
 *   - reviewing（砚砚）：按 ctx.artifacts 里的 patch 版本区分——只有 v1 时 request_changes，
 *     v2 出现后 approve，绝不一次返回两个结论；
 *   - revising（金渐层）：patch v2 + 重新交接；
 *   - done（宪宪）：decision + memory[]；
 *   - nudge（宪宪，stage 不变）：说明卡点 + 补投漏 @ 的交接卡。
 *
 * 其他规则：
 *   - 用户 @ 某猫时按该猫口吻接话，引用用户原话；没任务时自然闲聊；
 *   - `ScenarioBeat.fault` 会透传到返回的 handoff turn（driver 只认 turn.fault）；
 *   - 模板占位符：{{brief}} / {{title}} / {{quote}} / {{memory}} /
 *     {{memoryDetail}} / {{catName}}。
 */

import type {
  Artifact,
  CatBrain,
  CatId,
  CatTurn,
  MemoryEntry,
  Role,
  Scenario,
  ScenarioBeat,
  TurnContext,
} from "../domain/types.ts";

/** 主理猫：负责在卡住时补投交接卡。 */
const ARCHITECT_ID: CatId = "xianxian";

const CAT_NAMES: Record<string, string> = {
  xianxian: "宪宪",
  yanyan: "砚砚",
  shuoshuo: "烁烁",
  jinjianceng: "金渐层",
};

interface ChatLines {
  /** 被 @ 且有任务在跑。 */
  mentionTask: string;
  /** 被 @ 但房间里没任务。 */
  mentionIdle: string;
  /** 有任务、没被点名（当前 owner 接话）。 */
  hereTask: string;
  /** 没任务、没被点名。 */
  idle: string;
}

const CHAT_LINES: Record<string, ChatLines> = {
  xianxian: {
    mentionTask: "你刚说「{{quote}}」。我先说结论：这条先挂在「{{title}}」下面，不改现在的主线，收尾我一起看。",
    mentionIdle: "「{{quote}}」收到。现在桌上没活，你要想让我正式接，就把需求丢进来。",
    hereTask: "我在。「{{title}}」还在走，你有话直接说，我先记着。",
    idle: "桌上现在没活。丢个需求进来，我先说结论再拆。",
  },
  yanyan: {
    mentionTask: "「{{quote}}」——先给证据：第 1 条，改哪一段；第 2 条，怎么验证。两条齐了我才看「{{title}}」。",
    mentionIdle: "「{{quote}}」先放这儿。没任务我不空口判断，有证据再 @ 我。",
    hereTask: "「{{title}}」还在我手上过。没编号的事别催，我一条条来。",
    idle: "没活我就先睡。有要 review 的再 @ 我，别让我猜。",
  },
  shuoshuo: {
    mentionTask: "你一说「{{quote}}」，我脑子里「{{title}}」那个画面就活了。给我半天，我画个小状态图。",
    mentionIdle: "「{{quote}}」——好，我有画面了。等有任务，我就把这个感觉画出来。",
    hereTask: "「{{title}}」的界面我盯着呢，别担心它不好看。",
    idle: "空房间最适合发呆。你要是想改登录页，那个勾选框我已经有画面了。",
  },
  jinjianceng: {
    mentionTask: "「{{quote}}」收到。能跑，但我知道有个坑——在「{{title}}」里我先按能跑的做，坑回头说。",
    mentionIdle: "「{{quote}}」收到。没活我先眯一会儿，有活直接派。",
    hereTask: "「{{title}}」在我手上，快完了。别催，催了容易省步骤。",
    idle: "没活？那我眯一会儿。有活直接派，别铺垫。",
  },
};

const FALLBACK_BY_ROLE: Record<Role, string> = {
  architect: "我在。这条我先接着，需要我拆的时候喊一声。",
  reviewer: "我在。要 review 的把材料发我，我按编号看。",
  designer: "我在，画面我先留着。需要我出图就喊。",
  implementer: "收到，我手上这条快完了，下一条直接派。",
};

// ───────────────────────── 模板占位符 ─────────────────────────

function trimEndPunct(text: string): string {
  return text.replace(/[\s。！？!?；;，,、.]+$/u, "");
}

function quoteOf(text: string | undefined): string {
  const raw = (text ?? "").replace(/@[^\s@]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!raw) return "刚才那句";
  return raw.length > 48 ? `${raw.slice(0, 48)}…` : raw;
}

function pickMemory(memory: MemoryEntry[], scenario: Scenario | null): MemoryEntry | null {
  if (memory.length === 0) return null;
  const scenarioTags = new Set((scenario?.tags ?? []).map((tag) => tag.toLowerCase()));
  const scored = memory.map((entry, index) => {
    let score = entry.kind === "decision" ? 3 : entry.kind === "lesson" ? 2 : 1;
    for (const tag of entry.tags) {
      const lower = tag.toLowerCase();
      if (scenarioTags.has(lower)) score += 2;
      else if ([...scenarioTags].some((item) => item.includes(lower) || lower.includes(item))) score += 1;
    }
    return { entry, score, index };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored[0]?.entry ?? null;
}

function fallbackMemory(scenario: Scenario | null): string {
  return scenario?.id === "export_csv"
    ? "上次 remember-me 的决策（HttpOnly cookie，固定 7 天过期，默认不勾选）"
    : "上次的决策记录";
}

function buildVars(ctx: TurnContext, scenario: Scenario | null): Record<string, string> {
  const task = ctx.task;
  const memory = pickMemory(ctx.memory, scenario);
  const quote = quoteOf(ctx.trigger.text);
  return {
    brief: trimEndPunct(task?.brief ?? ""),
    title: task?.title ?? "",
    quote,
    userText: quote,
    memory: memory?.title ?? fallbackMemory(scenario),
    memoryDetail: memory?.body ?? "",
    catName: ctx.cat.name,
  };
}

function substitute(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/gu, (raw, key: string) => vars[key] ?? raw);
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = substitute(item, vars);
    }
    return out;
  }
  return value;
}

// ───────────────────────── beats 选择 ─────────────────────────

/**
 * 区分「review 第一轮 / 第二轮」：driver 把已产出的 artifact 放进 ctx.artifacts，
 * 见到 v2 patch（version>=2 或已有两张 patch）就说明 revise 完回来了。
 */
function hasRevisedPatch(artifacts: Artifact[]): boolean {
  const patches = artifacts.filter((artifact) => artifact.kind === "patch");
  return patches.some((artifact) => artifact.version >= 2) || patches.length >= 2;
}

/**
 * 按 (stage, cat) 取本轮的 beats：
 * - 普通阶段一次交付全部匹配的 beats（planning 消息 + 两张卡、working 实现稿 + 交接卡）；
 * - reviewing 有多条结论时，按 artifacts 证据只选一条，避免一次 think 同时打回又通过。
 */
function selectBeats(ctx: TurnContext, scenario: Scenario): ScenarioBeat[] {
  const task = ctx.task;
  if (!task) return [];
  const beats = scenario.beats.filter((beat) => beat.stage === task.stage && beat.cat === ctx.cat.id);
  if (beats.length === 0) return [];

  const reviews = beats.filter((beat) => beat.turn.kind === "review");
  if (reviews.length > 1) {
    const verdict = hasRevisedPatch(ctx.artifacts) ? "approve" : "request_changes";
    const target = reviews.find((beat) => beat.turn.kind === "review" && beat.turn.verdict === verdict);
    if (target) return [target];
    const last = reviews[reviews.length - 1];
    return last ? [last] : [];
  }
  return beats;
}

function materialize(beat: ScenarioBeat, vars: Record<string, string>): CatTurn {
  const turn = substitute(beat.turn, vars) as CatTurn;
  // beats 上的 fault 透传到 turn.handoff.fault：driver 只认这个字段。
  if (turn.kind === "handoff" && beat.fault === "missed_mention" && turn.fault === undefined) {
    return { ...turn, fault: "missed_mention" };
  }
  return turn;
}

function findFaultBeat(scenario: Scenario | null): ScenarioBeat | null {
  if (!scenario) return null;
  return (
    scenario.beats.find(
      (beat) =>
        beat.fault === "missed_mention" ||
        (beat.turn.kind === "handoff" && beat.turn.fault === "missed_mention"),
    ) ?? null
  );
}

// ───────────────────────── nudge（催一下） ─────────────────────────

/**
 * nudge：driver 负责把漏掉的交接「补投递」给接收猫，mock brain 只负责说明卡点。
 * 因此这里只回 message，绝不能再返回 handoff，否则会和 driver 的 deliverMissed 重复唤醒。
 */
function nudgeTurns(
  ctx: TurnContext,
  scenario: Scenario | null,
  recovered: Set<string>,
  nameOf: (id: CatId) => string,
): CatTurn[] {
  const task = ctx.task;
  if (!task) {
    const text =
      ctx.cat.role === "architect"
        ? "没任务可催。先丢个需求进来，我好有事干。"
        : "没任务，我继续睡。有活再叫我。";
    return [{ kind: "message", text, delayMs: 360 }];
  }

  // 只有「确实卡住」时才认领漏 @ 的锅；正常推进中的催一下不要乱背。
  const faultBeat = task.status === "stalled" ? findFaultBeat(scenario) : null;

  if (faultBeat && ctx.cat.id === ARCHITECT_ID) {
    if (recovered.has(task.id)) {
      return [
        {
          kind: "message",
          text: "已经补过一次了，@砚砚 那边应该接住了，再等等。别连着催，催急了容易漏看。",
          delayMs: 360,
        },
      ];
    }
    recovered.add(task.id);

    const handoff = faultBeat.turn.kind === "handoff" ? faultBeat.turn : null;
    const authorName = nameOf(faultBeat.cat);
    const recipientName = handoff ? nameOf(handoff.to) : "接收猫";
    return [
      {
        kind: "message",
        text: `我看了，${authorName}那张交接卡写了给${recipientName}，但没带 @，消息根本没投出去，所以一直没人接。我这就把 @ 补上，让${recipientName}接着看。`,
        mentions: handoff ? [handoff.to] : [],
        delayMs: 420,
      },
    ];
  }

  if (faultBeat) {
    return [
      {
        kind: "message",
        text: "催到我这儿了，但卡住的不是我这一步。宪宪应该会去补那张没 @ 到的卡。",
        delayMs: 360,
      },
    ];
  }

  if (ctx.cat.role === "architect") {
    return [{ kind: "message", text: "我看过了，没卡，流程正常。你要加需求直接说。", delayMs: 360 }];
  }
  return [{ kind: "message", text: "我还在，别催，这条马上交。", delayMs: 360 }];
}

// ───────────────────────── 闲聊 / @ 接话 ─────────────────────────

function chatTurns(ctx: TurnContext, vars: Record<string, string>): CatTurn[] {
  const lines = CHAT_LINES[ctx.cat.id] ?? CHAT_LINES.xianxian;
  const mentioned = (ctx.trigger.mentions ?? []).includes(ctx.cat.id);
  const hasTask = ctx.task !== null;
  const template = mentioned
    ? hasTask
      ? lines?.mentionTask
      : lines?.mentionIdle
    : hasTask
      ? lines?.hereTask
      : lines?.idle;
  const text = (substitute(template ?? FALLBACK_BY_ROLE[ctx.cat.role], vars) as string) ?? "";
  return [{ kind: "message", text, delayMs: 420 }];
}

// ───────────────────────── 工厂 ─────────────────────────

export interface MockBrainDeps {
  /** 取当前猫名的访问器；改名后 nudge 台词也能跟着变。 */
  catName?: (id: CatId) => string;
}

export function createMockBrain(scenarios: Scenario[], deps: MockBrainDeps = {}): CatBrain {
  const nameOf = (id: CatId): string => deps.catName?.(id) ?? CAT_NAMES[id] ?? id;
  /** 已经补投过漏 @ 交接卡的任务。 */
  const recovered = new Set<string>();

  function resolveScenario(ctx: TurnContext): Scenario | null {
    if (ctx.scenario) return ctx.scenario;
    if (!ctx.task) return null;
    // 每次现查：自定义剧本导入后无需重建 brain。
    return scenarios.find((scenario) => scenario.id === ctx.task?.scenarioId) ?? null;
  }

  return {
    mode: "mock",
    async think(ctx: TurnContext): Promise<CatTurn[]> {
      const scenario = resolveScenario(ctx);
      const vars = buildVars(ctx, scenario);

      if (ctx.trigger.kind === "nudge") {
        return nudgeTurns(ctx, scenario, recovered, nameOf);
      }
      if (ctx.trigger.kind === "user_message") {
        return chatTurns(ctx, vars);
      }

      if (ctx.task && scenario) {
        const beats = selectBeats(ctx, scenario);
        if (beats.length > 0) return beats.map((beat) => materialize(beat, vars));
      }

      return [{ kind: "message", text: FALLBACK_BY_ROLE[ctx.cat.role], delayMs: 400 }];
    },
  };
}
