/**
 * 真实 LLM brain：OpenAI 兼容 `POST {baseUrl}/chat/completions`。
 *
 * 设计原则：
 * 1. **界面永远不空**：模型输出不可信。超时、HTTP 非 2xx、坏 JSON、结构校验失败、
 *    网络错误 —— 任何一条失败都降级到 fallback（mock brain），并 console.warn 一行。
 * 2. **绝不泄露 key**：apiKey 只出现在请求头里；日志、错误信息、持久化都不带。
 * 3. **零依赖**：只用 Node 原生 fetch + AbortController。
 *
 * 模型被要求只输出一个 CatTurn[] JSON 数组。解析后逐条做结构校验：
 * kind 必须在白名单内，字段类型必须正确，未知 kind 直接丢弃；无法产出任何合法
 * turn 时视为失败并降级。
 */

import type {
  ArtifactKind,
  CatBrain,
  CatId,
  CatTurn,
  HandoffCard,
  LlmSettings,
  MemoryKind,
  Message,
  ReviewFinding,
  ReviewVerdict,
  Role,
  TaskStage,
  Trigger,
  TurnContext,
} from "../domain/types.ts";

/** 默认请求超时：20s。真实模型偶尔慢，再久就不如先让猫猫动起来。 */
export const DEFAULT_TIMEOUT_MS = 20_000;
/** 默认 max_tokens：一轮最多 3 个 turn，1600 足够。 */
export const DEFAULT_MAX_TOKENS = 1600;
/** 一次最多接受的 turn 数，防止模型刷屏。 */
export const MAX_TURNS = 6;
/** delayMs 上限，防止模型给出离谱的停顿把演出拖死。 */
const MAX_DELAY_MS = 8_000;

const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "spec",
  "design",
  "patch",
  "review",
  "decision",
];
const MEMORY_KINDS: readonly MemoryKind[] = ["decision", "lesson", "preference"];
const REVIEW_VERDICTS: readonly ReviewVerdict[] = ["approve", "request_changes"];

const ROLE_LABEL: Record<Role, string> = {
  architect: "主架构师 / 主理猫",
  reviewer: "Reviewer / 安全与细节",
  designer: "设计 / 创意",
  implementer: "实现 / 多面手",
};

const STAGE_LABEL: Record<TaskStage, string> = {
  intake: "intake · 接需求",
  planning: "planning · 拆解规划",
  working: "working · 执行产出",
  reviewing: "reviewing · 评审",
  revising: "revising · 按意见修改",
  done: "done · 已完成",
};

export interface LlmBrainOptions {
  /** 请求超时毫秒数，默认 20s；测试里可以调小。 */
  timeoutMs?: number;
  /** 覆盖默认 max_tokens。 */
  maxTokens?: number;
  /** 可注入的 fetch 实现（测试用），默认 globalThis.fetch。 */
  fetchImpl?: typeof fetch;
}

// ───────────────────────── 工厂 ─────────────────────────

export function createLlmBrain(
  settings: LlmSettings,
  fallback: CatBrain,
  options: LlmBrainOptions = {},
): CatBrain {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxTokens = positiveInt(options.maxTokens, DEFAULT_MAX_TOKENS);
  const endpoint = `${settings.baseUrl.trim().replace(/\/+$/, "")}/chat/completions`;
  const model = settings.model.trim();
  const temperature = clamp(
    Number.isFinite(settings.temperature) ? settings.temperature : 0.8,
    0,
    2,
  );

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  // apiKey 只放请求头；下面所有日志都经过 scrub()，确保不会出现。
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

  const warn = (line: string): void => {
    console.warn(scrub(line, settings.apiKey));
  };

  return {
    mode: "llm",
    async think(ctx: TurnContext): Promise<CatTurn[]> {
      const downgrade = (reason: string): Promise<CatTurn[]> => {
        warn(
          `[llm-brain] ${reason}，降级 fallback（猫=${ctx.cat.name}，stage=${ctx.task?.stage ?? "-"}）`,
        );
        return fallback.think(ctx);
      };

      if (!endpoint.startsWith("http")) return downgrade("LLM_BASE_URL 缺失或非法");
      if (!model) return downgrade("LLM_MODEL 缺失");

      const body = JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        stream: false,
        messages: [
          { role: "system", content: buildSystemPrompt(ctx) },
          { role: "user", content: buildUserPrompt(ctx) },
        ],
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();

      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });

        if (!response.ok) {
          // 不读 body（可能很大，也可能回显敏感内容），直接释放连接。
          void response.body?.cancel().catch(() => {});
          return await downgrade(`HTTP ${response.status}`);
        }

        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          return await downgrade("响应不是合法 JSON envelope");
        }

        const content = extractContent(payload);
        if (content === null) {
          return await downgrade("响应缺少 choices[0].message.content");
        }

        const turns = parseTurns(content, ctx);
        if (turns.length === 0) {
          return await downgrade("模型输出不是可用的 CatTurn[]");
        }
        return turns;
      } catch (err) {
        const reason = controller.signal.aborted
          ? `请求超时 ${timeoutMs}ms`
          : `网络错误：${errorMessage(err)}`;
        return await downgrade(reason);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ───────────────────────── 响应解析 ─────────────────────────

/** 从 OpenAI 兼容响应里取出模型文本；无法取出时返回 null。 */
function extractContent(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isRecord(first)) return null;
  const message = first.message;
  if (!isRecord(message)) return null;
  const content = message.content;
  if (typeof content === "string") return content;
  // 少数兼容端点返回 [{ type: "text", text }] 片段数组。
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (isRecord(part) && typeof part.text === "string") parts.push(part.text);
    }
    return parts.length > 0 ? parts.join("") : null;
  }
  return null;
}

/**
 * 把模型文本收敛成 JSON 数组字符串：容忍 ```json 围栏和前后多余解说，
 * 但数组内部仍然是严格 JSON.parse。解析失败由调用方降级。
 */
function extractJsonArray(content: string): string | null {
  let text = content.trim();
  if (!text) return null;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();
  if (!text.startsWith("[")) {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start < 0 || end <= start) return null;
    text = text.slice(start, end + 1);
  }
  return text;
}

/**
 * 解析模型输出为 CatTurn[]。导出以便单测直接覆盖结构校验。
 * - 顶层必须是数组，否则返回 []
 * - 未知 kind 丢弃
 * - 字段类型错误 / 必填缺失的 turn 丢弃
 * - mentions / to 只保留本房间内的猫 id，且 handoff 不能交给自己
 */
export function parseTurns(content: string, ctx: TurnContext): CatTurn[] {
  const jsonText = extractJsonArray(content);
  if (jsonText === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const turns: CatTurn[] = [];
  for (const item of parsed) {
    if (turns.length >= MAX_TURNS) break;
    const turn = parseTurn(item, ctx);
    if (turn) turns.push(turn);
  }
  return turns;
}

function parseTurn(item: unknown, ctx: TurnContext): CatTurn | null {
  if (!isRecord(item)) return null;
  switch (item.kind) {
    case "message":
      return parseMessageTurn(item, ctx);
    case "handoff":
      return parseHandoffTurn(item, ctx);
    case "artifact":
      return parseArtifactTurn(item, ctx);
    case "review":
      return parseReviewTurn(item, ctx);
    case "decision":
      return parseDecisionTurn(item);
    case "memory":
      return parseMemoryTurn(item);
    default:
      // 未知 kind：丢弃（可能是模型自由发挥）。
      return null;
  }
}

function parseMessageTurn(
  item: Record<string, unknown>,
  ctx: TurnContext,
): CatTurn | null {
  const text = requiredText(item.text);
  if (!text) return null;
  const turn: CatTurn = { kind: "message", text };
  const mentions = parseMentions(item.mentions, ctx);
  if (mentions) turn.mentions = mentions;
  const delay = parseDelay(item.delayMs);
  if (delay !== undefined) turn.delayMs = delay;
  return turn;
}

function parseHandoffTurn(
  item: Record<string, unknown>,
  ctx: TurnContext,
): CatTurn | null {
  const to = requiredText(item.to);
  if (!to) return null;
  // handoff 只能交给房间里、且不是自己的猫。
  if (to === ctx.cat.id) return null;
  if (!ctx.room.catIds.includes(to)) return null;

  const card = parseCard(item.card);
  if (!card) return null;

  const turn: CatTurn = { kind: "handoff", to, card };
  const text = requiredText(item.text);
  if (text) turn.text = text;
  if (item.fault === "missed_mention") turn.fault = "missed_mention";
  const delay = parseDelay(item.delayMs);
  if (delay !== undefined) turn.delayMs = delay;
  return turn;
}

function parseArtifactTurn(
  item: Record<string, unknown>,
  ctx: TurnContext,
): CatTurn | null {
  const artifact = parseArtifactBody(item.artifact);
  if (!artifact) return null;
  const turn: CatTurn = { kind: "artifact", artifact };
  const text = requiredText(item.text);
  if (text) turn.text = text;
  const mentions = parseMentions(item.mentions, ctx);
  if (mentions) turn.mentions = mentions;
  const delay = parseDelay(item.delayMs);
  if (delay !== undefined) turn.delayMs = delay;
  return turn;
}

function parseReviewTurn(
  item: Record<string, unknown>,
  ctx: TurnContext,
): CatTurn | null {
  const verdict = item.verdict;
  if (typeof verdict !== "string" || !REVIEW_VERDICTS.includes(verdict as ReviewVerdict)) {
    return null;
  }
  const title = requiredText(item.title);
  const text = requiredText(item.text);
  if (!title || !text) return null;

  const findings = parseFindings(item.findings);
  if (findings === null) return null;

  const turn: CatTurn = {
    kind: "review",
    verdict: verdict as ReviewVerdict,
    title,
    findings,
    text,
  };
  const mentions = parseMentions(item.mentions, ctx);
  if (mentions) turn.mentions = mentions;
  const delay = parseDelay(item.delayMs);
  if (delay !== undefined) turn.delayMs = delay;
  return turn;
}

function parseDecisionTurn(item: Record<string, unknown>): CatTurn | null {
  const text = requiredText(item.text);
  const artifact = parseArtifactBody(item.artifact);
  if (!text || !artifact) return null;

  let memory: Array<{ kind: MemoryKind; title: string; body: string; tags: string[] }> = [];
  if (item.memory !== undefined) {
    if (!Array.isArray(item.memory)) return null;
    for (const entry of item.memory) {
      const parsed = parseMemoryEntry(entry);
      if (parsed) memory.push(parsed);
    }
  }

  const turn: CatTurn = { kind: "decision", artifact, text, memory };
  const delay = parseDelay(item.delayMs);
  if (delay !== undefined) turn.delayMs = delay;
  return turn;
}

function parseMemoryTurn(item: Record<string, unknown>): CatTurn | null {
  const text = requiredText(item.text);
  const memory = parseMemoryEntry(item.memory);
  if (!text || !memory) return null;
  const turn: CatTurn = { kind: "memory", memory, text };
  const delay = parseDelay(item.delayMs);
  if (delay !== undefined) turn.delayMs = delay;
  return turn;
}

// ───────────────────────── 字段校验 ─────────────────────────

function parseCard(value: unknown): HandoffCard | null {
  if (!isRecord(value)) return null;
  const what = requiredText(value.what);
  const why = requiredText(value.why);
  const tradeoff = requiredText(value.tradeoff);
  const nextAction = requiredText(value.nextAction);
  if (!what || !why || !tradeoff || !nextAction) return null;

  // 五栏里的 openQuestions 必须是数组；模型偶尔给单个字符串，宽容转成数组。
  let openQuestions: string[];
  if (typeof value.openQuestions === "string") {
    const single = requiredText(value.openQuestions);
    openQuestions = single ? [single] : [];
  } else {
    const list = stringList(value.openQuestions);
    if (list === null) return null;
    openQuestions = list;
  }

  return { what, why, tradeoff, openQuestions, nextAction };
}

function parseArtifactBody(
  value: unknown,
): { kind: ArtifactKind; title: string; body: string } | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  if (
    typeof kind !== "string" ||
    !ARTIFACT_KINDS.includes(kind as ArtifactKind)
  ) {
    return null;
  }
  const title = requiredText(value.title);
  const body = requiredText(value.body);
  if (!title || !body) return null;
  return { kind: kind as ArtifactKind, title, body };
}

function parseFindings(value: unknown): ReviewFinding[] | null {
  // findings 可省略（approve 时常见），省略按空数组处理。
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const findings: ReviewFinding[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const severity = item.severity;
    if (severity !== "blocker" && severity !== "minor") continue;
    const title = requiredText(item.title);
    const detail = requiredText(item.detail);
    if (!title || !detail) continue;
    findings.push({ severity, title, detail });
  }
  return findings;
}

function parseMemoryEntry(
  value: unknown,
): { kind: MemoryKind; title: string; body: string; tags: string[] } | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  if (typeof kind !== "string" || !MEMORY_KINDS.includes(kind as MemoryKind)) {
    return null;
  }
  const title = requiredText(value.title);
  const body = requiredText(value.body);
  if (!title || !body) return null;
  return {
    kind: kind as MemoryKind,
    title,
    body,
    tags: stringList(value.tags) ?? [],
  };
}

/** mentions 只接受本房间猫 id；去重；空数组返回 undefined。 */
function parseMentions(value: unknown, ctx: TurnContext): CatId[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const out: CatId[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (ctx.room.catIds.includes(id) && !out.includes(id)) out.push(id);
  }
  return out.length > 0 ? out : undefined;
}

function parseDelay(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(MAX_DELAY_MS, Math.round(value));
}

function requiredText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

// ───────────────────────── Prompt 组装 ─────────────────────────

function buildSystemPrompt(ctx: TurnContext): string {
  const { cat, room, task } = ctx;
  const selfId = cat.id;
  const others = room.catIds.filter((id) => id !== selfId);

  const taskBlock = task
    ? [
        `【当前任务】`,
        `标题：${clip(task.title, 120)}`,
        `需求原文：${clip(task.brief, 400)}`,
        `当前阶段：${STAGE_LABEL[task.stage] ?? task.stage}`,
        `阶段负责人：${task.owner === selfId ? `你（${cat.name}）` : task.owner}`,
        `任务状态：${task.status}`,
        `场景 id：${task.scenarioId}`,
      ].join("\n")
    : "【当前任务】没有进行中的任务，你只是在房间里聊天。";

  return [
    `你是「${cat.name}」（${cat.species}），猫咖里的${ROLE_LABEL[cat.role] ?? cat.title}。`,
    `性格：${cat.persona}`,
    `口头禅：${cat.catchphrase}`,
    `房间：${room.name} —— ${room.topic}`,
    `你自己的 catId 是 ${selfId}。房间里其他猫的 catId：${others.join("、") || "（无）"}。`,
    "",
    taskBlock,
    "",
    "【输出格式 · 必须严格遵守】",
    "只输出一个 JSON 数组，不要 markdown 代码围栏，不要任何解释文字。",
    "数组元素是下面 6 种 turn 之一，只能输出 1~3 个 turn：",
    '1. {"kind":"message","text":"要说的话","mentions":["catId"]}',
    '2. {"kind":"handoff","to":"catId","card":{"what":"做什么","why":"为什么","tradeoff":"取舍","openQuestions":["未决问题"],"nextAction":"下一步"},"text":"伴随说明"}',
    '3. {"kind":"artifact","artifact":{"kind":"spec|design|patch|review|decision","title":"标题","body":"正文"},"text":"说明","mentions":["catId"]}',
    '4. {"kind":"review","verdict":"approve|request_changes","title":"结论标题","findings":[{"severity":"blocker|minor","title":"问题","detail":"细节"}],"text":"说明","mentions":["catId"]}',
    '5. {"kind":"decision","artifact":{"title":"标题","body":"正文"},"text":"说明","memory":[{"kind":"decision|lesson|preference","title":"标题","body":"正文","tags":["标签"]}]}',
    '6. {"kind":"memory","memory":{"kind":"decision|lesson|preference","title":"标题","body":"正文","tags":["标签"]},"text":"说明"}',
    "",
    "【规则】",
    "- kind 只能是 message / handoff / artifact / review / decision / memory；其他一律不要输出。",
    "- mentions、handoff.to 只能用上面列出的 catId，不要用猫的名字；handoff 不能交给自己。",
    "- handoff 卡片的 what / why / tradeoff / openQuestions / nextAction 五栏必须齐全，openQuestions 必须是字符串数组。",
    "- 全部用中文，保持角色人格和口头禅，不要出戏；每条 text 控制在 120 字以内。",
    "- 需要别人做事就用 handoff；别人给了你产物、轮到你评审就用 review；任务收尾用 decision 把结论记进共享记忆。",
    "- 信息不足时先用 message 追问，不要编造事实。",
    "- delayMs 可选，单位毫秒，范围 0~8000，表示开口前的停顿。",
  ].join("\n");
}

function buildUserPrompt(ctx: TurnContext): string {
  const { task, recentMessages, memory, handoffs, artifacts, trigger } = ctx;

  const messageLines = recentMessages.map((message: Message) => {
    const who = authorLabel(message.author, ctx);
    const tag = message.kind === "chat" ? "" : `[${message.kind}] `;
    return `- ${who}：${tag}${clip(message.text, 220)}`;
  });

  const handoffLines = handoffs.map((handoff) => {
    const card = handoff.card;
    return `- ${handoff.from} → ${handoff.to}：做什么=${clip(card.what, 120)}；为什么=${clip(card.why, 100)}；取舍=${clip(card.tradeoff, 100)}；未决问题=${card.openQuestions.map((q) => clip(q, 60)).join(" / ") || "（无）"}；下一步=${clip(card.nextAction, 100)}`;
  });

  const artifactLines = artifacts.map(
    (artifact) =>
      `- [${artifact.kind} v${artifact.version}] ${clip(artifact.title, 100)}：${clip(artifact.body, 320)}`,
  );

  const memoryLines = memory.map(
    (entry) => `- [${entry.kind}] ${clip(entry.title, 100)}：${clip(entry.body, 220)}`,
  );

  const sections = [
    "【本任务已有的交接卡】",
    handoffLines.length > 0 ? handoffLines.join("\n") : "（还没有交接卡）",
    "",
    "【本任务已有的产物】",
    artifactLines.length > 0 ? artifactLines.join("\n") : "（还没有产物）",
    "",
    "【相关共享记忆】",
    memoryLines.length > 0 ? memoryLines.join("\n") : "（没有相关记忆）",
    "",
    "【触发这次回复的事件】",
    describeTrigger(trigger, ctx),
    "",
    `【最近的房间消息（旧 → 新，最多 ${recentMessages.length} 条）】`,
    messageLines.length > 0 ? messageLines.join("\n") : "（房间里还没有消息）",
    "",
    `现在轮到你（${ctx.cat.name}）行动。结合${task ? `当前阶段「${STAGE_LABEL[task.stage] ?? task.stage}」` : "房间现状"}，只输出 JSON 数组。`,
  ];

  return sections.join("\n");
}

function describeTrigger(trigger: Trigger, ctx: TurnContext): string {
  const lines: string[] = [`- kind：${trigger.kind}`];
  if (trigger.fromCatId) lines.push(`- 来自：${trigger.fromCatId}`);
  if (trigger.text) lines.push(`- 内容：${clip(trigger.text, 320)}`);
  if (trigger.mentions && trigger.mentions.length > 0) {
    lines.push(
      `- 被 @：${trigger.mentions.map((id) => (id === ctx.cat.id ? `${id}（你）` : id)).join("、")}`,
    );
  }
  if (trigger.handoff) lines.push(`- 交接卡：${renderCard(trigger.handoff)}`);
  if (trigger.artifact) {
    lines.push(
      `- 产物：[${trigger.artifact.kind} v${trigger.artifact.version}] ${clip(trigger.artifact.title, 100)}：${clip(trigger.artifact.body, 280)}`,
    );
  }
  if (trigger.review) {
    lines.push(`- review 结论：${trigger.review.verdict}`);
    for (const finding of trigger.review.findings.slice(0, 6)) {
      lines.push(
        `  · [${finding.severity}] ${clip(finding.title, 80)}：${clip(finding.detail, 160)}`,
      );
    }
  }
  return lines.join("\n");
}

function renderCard(card: HandoffCard): string {
  const open = card.openQuestions.map((q) => clip(q, 60)).join(" / ") || "（无）";
  return `做什么=${clip(card.what, 120)}；为什么=${clip(card.why, 100)}；取舍=${clip(card.tradeoff, 100)}；未决问题=${open}；下一步=${clip(card.nextAction, 100)}`;
}

function authorLabel(author: string, ctx: TurnContext): string {
  if (author === "user") return "铲屎官";
  if (author === "system") return "系统";
  if (author === ctx.cat.id) return `${ctx.cat.name}（你）`;
  return author;
}

// ───────────────────────── 小工具 ─────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(input: string, max: number): string {
  const flat = input.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 把日志里的 apiKey（如果因某种原因出现）替换掉，双保险。 */
function scrub(line: string, apiKey: string): string {
  if (!apiKey) return line;
  return line.split(apiKey).join("***");
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
