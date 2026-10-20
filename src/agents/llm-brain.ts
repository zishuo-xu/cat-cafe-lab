/**
 * 真实 LLM brain：OpenAI 兼容 `POST {baseUrl}/chat/completions`。
 *
 * 设计原则：
 * 1. **界面永远不空**：模型输出不可信。超时、HTTP 非 2xx、坏 JSON、结构校验失败、
 *    网络错误 —— 任何一条失败都降级到 fallback（mock brain），并 console.warn 一行。
 * 2. **绝不泄露 key**：apiKey 只出现在请求头里；日志、错误信息、持久化都不带。
 * 3. **零依赖**：只用 Node 原生 fetch + AbortController。
 *
 * 模型被要求只输出一个 AgentTurn[] JSON 数组。解析后逐条做结构校验：
 * kind 必须在白名单内，字段类型必须正确，未知 kind 直接丢弃；无法产出任何合法
 * turn 时视为失败并降级。工具调用（tool turn）同样走白名单 + input 结构校验，
 * 执行回执会通过 ctx.recentToolResults / trigger.toolResults 喂回 prompt。
 */

import type {
  ArtifactKind,
  AgentBrain,
  MemberId,
  AgentTurn,
  HandoffCard,
  LlmSettings,
  MemoryKind,
  Message,
  ReviewFinding,
  ReviewVerdict,
  Role,
  Skill,
  TaskStage,
  ToolDefinition,
  ToolRunResult,
  Trigger,
  TurnContext,
} from "../domain/types.ts";

/**
 * 内置工具名。真实模型常请求「真实存在但不在这个成员权限里」的工具（例如林知远请求 write_file）。
 * 这类 turn 要保留，交给 driver 拒绝并回喂「没有权限」，模型才能学到边界；
 * 而完全编造的工具名（delete_everything）直接丢弃。
 */
const BUILTIN_TOOL_NAMES = new Set(["read_file", "write_file", "list_files", "run_command"]);

/** 默认请求超时：20s。真实模型偶尔慢，再久就不如先让成员动起来。 */
export const DEFAULT_TIMEOUT_MS = 20_000;
/**
 * 流式请求的超时。
 *
 * 非流式时 20s 足够（等整段返回）；流式要读完整条 SSE 流，慢模型 + 长上下文
 * 很容易超过 20s——实测 mimo-v2.6-flash 在 working 阶段就因此被 abort，
 * 整轮降级到 mock。给流式单独放宽到 90s。
 */
export const STREAM_TIMEOUT_MS = 90_000;
/**
 * 默认 max_tokens。
 *
 * 推理型模型（如 deepseek-flash）会先产生 reasoning_content，思考 token 也计入
 * completion budget：实测一轮 spec 已消耗 1268 个 reasoning token，1600 会直接截断。
 * 这里给足余量；若仍被截断，会在响应处理里自动用更大的预算重试一次。
 */
export const DEFAULT_MAX_TOKENS = 4096;
/** 被 max_tokens 截断时的重试上限。 */
const ESCALATED_MAX_TOKENS = 8192;
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
  architect: "主架构师 / 架构师",
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
  /** 是否请求流式响应（driver 传 ctx.onDelta 时才真正生效）。 */
  streaming?: boolean;
  /** 可注入的 fetch 实现（测试用），默认 globalThis.fetch。 */
  fetchImpl?: typeof fetch;
}

// ───────────────────────── 工厂 ─────────────────────────

export function createLlmBrain(
  settings: LlmSettings,
  fallback: AgentBrain,
  options: LlmBrainOptions = {},
): AgentBrain {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const streamTimeoutMs = positiveInt(options.timeoutMs, STREAM_TIMEOUT_MS);
  let maxTokens = positiveInt(options.maxTokens, DEFAULT_MAX_TOKENS);
  const endpoint = `${settings.baseUrl.trim().replace(/\/+$/, "")}/chat/completions`;
  const globalModel = settings.model.trim();
  const globalTemperature = clamp(
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
  // 端点要求的额外头（opencode zen 的 x-opencode-session 等）。
  if (settings.headers) {
    for (const [key, value] of Object.entries(settings.headers)) {
      if (!key || !value) continue;
      headers[key] = value;
    }
  }

  const secretValues = [
    settings.apiKey,
    ...Object.values(settings.headers ?? {}),
  ].filter(Boolean);
  const scrubAll = (line: string): string => {
    let result = line;
    for (const secret of secretValues) result = result.split(secret).join("***");
    return result;
  };

  const warn = (line: string): void => {
    console.warn(scrubAll(scrub(line, settings.apiKey)));
  };

  return {
    mode: "llm",
    async think(ctx: TurnContext): Promise<AgentTurn[]> {
      // 每个成员可以有自己的模型 / 温度；缺省回落全局设置。
      const model = resolveModel(ctx, globalModel);
      const temperature = resolveTemperature(ctx, globalTemperature);

      const downgrade = (reason: string): Promise<AgentTurn[]> => {
        warn(
          `[llm-brain] ${reason}，降级 fallback（成员=${ctx.cat.name}，model=${model || "-"}，stage=${ctx.task?.stage ?? "-"}）`,
        );
        ctx.onReport?.({
          model,
          engine: "api",
          degraded: true,
          degradeReason: reason.slice(0, 200),
        });
        return fallback.think(ctx);
      };

      if (!endpoint.startsWith("http")) return downgrade("LLM_BASE_URL 缺失或非法");
      if (!model) return downgrade("LLM_MODEL 缺失");

      // 推理型模型的思考链也消耗 completion budget：被截断时用更大预算重试一次，
      // 仍失败才降级到 mock。retried 是每个成员每次 think 的状态。
      const useStream = Boolean(options.streaming) && typeof ctx.onDelta === "function";
      let retried = false;
      let attemptTokens = maxTokens;
      for (;;) {
        const body = JSON.stringify({
          model,
          temperature,
          max_tokens: attemptTokens,
          stream: useStream,
          messages: [
            { role: "system", content: buildSystemPrompt(ctx, model) },
            { role: "user", content: buildUserPrompt(ctx) },
          ],
        });

        const controller = new AbortController();
        const effectiveTimeout = useStream ? streamTimeoutMs : timeoutMs;
        const timer = setTimeout(() => controller.abort(), effectiveTimeout);
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

          let content: string | null;
          let finish: string | null;
          let payload: unknown = null;
          if (useStream) {
            const streamed = await consumeStream(response, ctx, warn);
            if (streamed === null) {
              return await downgrade("流式响应无法解析");
            }
            content = streamed.content;
            finish = streamed.finishReason;
            payload = streamed.usagePayload;
          } else {
            try {
              payload = await response.json();
            } catch {
              return await downgrade("响应不是合法 JSON envelope");
            }
            content = extractContent(payload);
            finish = finishReasonOf(payload);
          }
          if (finish === "length" && !retried) {
            retried = true;
            attemptTokens = Math.max(attemptTokens, ESCALATED_MAX_TOKENS);
            warn(
              `输出被 max_tokens=${maxTokens} 截断（reasoning 型模型会先消耗思考链），用 ${attemptTokens} 重试一次`,
            );
            continue;
          }
          if (content === null) {
            if (useStream) {
              warn("[llm-brain] 流式响应里没有拿到 content（可能是空流或端点不支持流式）");
            }
            if (finish === "length") {
              return await downgrade(
                `模型输出连续两次被 max_tokens 截断（reasoning 型模型会先消耗思考链），当前 max_tokens=${attemptTokens}`,
              );
            }
            return await downgrade("响应缺少 choices[0].message.content");
          }
          if (finish === "length") {
            // 重试后仍被截断：截断的 JSON 解析不出完整 turn，直接给出明确原因。
            return await downgrade(
              `模型输出被 max_tokens=${attemptTokens} 截断（reasoning 型模型），JSON 不完整`,
            );
          }

          const turns = parseTurns(content, ctx);
          if (turns.length === 0) {
            // 兜底：模型偶尔无视 JSON 约束、直接说人话（opencode zen 上实测）。
            // 与其整轮降级成 mock 台词，不如把这段人话当成一条 message 收下。
            const plain = plainTextReply(content);
            if (plain) {
              warn("模型未按 JSON 输出，已把纯文本包成一条 message");
              return [{ kind: "message", text: plain.slice(0, 400) }];
            }
            // 排查用：把模型原文的前 300 字打出来（已 scrub），否则只知道"解析失败"。
            const preview = content.replace(/\s+/g, " ").slice(0, 300);
            return await downgrade(
              `模型输出不是可用的 AgentTurn[]（finish=${finish ?? "-"}, len=${content.length}，原文前 300 字：${preview}）`,
            );
          }
          // 成功路径：回报用量（token / 流式 / 重试），供可观测性记录。
          ctx.onReport?.({
            model,
            engine: "api",
            streamed: useStream,
            retried,
            ...usageFrom(payload),
          });
          return turns;
        } catch (err) {
          const reason = controller.signal.aborted
            ? `请求超时 ${useStream ? streamTimeoutMs : timeoutMs}ms${useStream ? "（流式）" : ""}`
            : `网络错误：${errorMessage(err)}`;
          return await downgrade(reason);
        } finally {
          clearTimeout(timer);
        }
      }
    },
  };
}

// ───────────────────────── 响应解析 ─────────────────────────

/**
 * 消费 OpenAI 兼容的 SSE 流。返回完整 content 与 finish_reason。
 *
 * 增量只在「能解析出人话」时才推给前端：模型输出的是 JSON，直接把裸 JSON 推上去
 * 会看到一堆括号。这里用简单的启发式——等出现 `"text":"..."` 时才开始推内容，
 * 并且只推已经闭合的、看起来像人话的部分。
 */
async function consumeStream(
  response: Response,
  ctx: TurnContext,
  warn?: (line: string) => void,
): Promise<{
  content: string;
  finishReason: string | null;
  usagePayload: unknown;
} | null> {
  const body = response.body;
  if (!body) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason: string | null = null;
  let usagePayload: unknown = null;
  let drafted = "";

  const pushDraft = (): void => {
    const visible = extractVisibleText(content);
    if (!visible || visible === drafted) return;
    drafted = visible;
    ctx.onDelta?.({ catId: ctx.cat.id, roomId: ctx.room.id, text: visible });
  };

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let event: unknown;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }
        if (!isRecord(event)) continue;
        // usage 可能出现在 choices 为空的收尾 chunk 里，先抓。
        if (isRecord(event.usage)) usagePayload = event;
        const choices = event.choices;
        if (!Array.isArray(choices) || choices.length === 0) continue;
        const first = choices[0];
        if (!isRecord(first)) continue;
        const delta = first.delta;
        if (isRecord(delta) && typeof delta.content === "string") {
          content += delta.content;
          pushDraft();
        }
        if (typeof first.finish_reason === "string") finishReason = first.finish_reason;
      }
    }
  } catch (streamError) {
    // 流中断：保留已经收到的内容，交给上层判断；完全没收到内容时给出原因。
    if (!content) {
      warn?.(`[llm-brain] 流式读取失败：${streamError instanceof Error ? streamError.message : String(streamError)}`);
      return null;
    }
  } finally {
    reader.releaseLock?.();
  }
  return { content, finishReason, usagePayload };
}

/**
 * 从「还没写完的 JSON」里尽量抽出一段可读文本，用于流式预览。
 *
 * 模型输出是 AgentTurn[] JSON。可能正在写两种东西：
 * 1. 说的话：`"text":"..."`（短，一两句）
 * 2. 产物正文：`"body":"..."`（长，spec / patch 的正文，往往几百字）
 *
 * 做法：找最后一个出现的 `"text":"` 或 `"body":"`，取其后到闭合引号（或流末尾）的内容，
 * 按长度选择更「正在写」的那个——body 优先（长文本更有预览价值），
 * 但如果 text 出现在 body 之后，说明模型已经写完 body 在补说明，就用 text。
 */
function extractVisibleText(raw: string): string {
  const textIndex = raw.lastIndexOf('"text":"');
  const bodyIndex = raw.lastIndexOf('"body":"');
  let marker: string;
  let index: number;
  if (bodyIndex < 0) {
    marker = '"text":"';
    index = textIndex;
  } else if (textIndex > bodyIndex) {
    marker = '"text":"';
    index = textIndex;
  } else {
    marker = '"body":"';
    index = bodyIndex;
  }
  if (index < 0) return "";

  let rest = raw.slice(index + marker.length);
  const closed = rest.indexOf('"');
  if (closed >= 0) rest = rest.slice(0, closed);
  let text = rest
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
  if (closed < 0) {
    // 还没闭合：去转义之后再修剪末尾残留的反斜杠 / 未打完的 \u 序列。
    // 顺序很重要：`\\\\` 会被还原成 `\\`，所以必须在去转义之后处理。
    text = text.replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, "");
  }
  // 说话用尾部 400 字（像打字）；正文用前 1500 字（正文开头最有用，且能滚动早期内容）。
  return marker === '"body":"' ? text.slice(0, 1500) : text.slice(-400);
}

/** 取 finish_reason（用于区分"被截断"与"真的空响应"）。 */
function finishReasonOf(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isRecord(first)) return null;
  const reason = first.finish_reason;
  return typeof reason === "string" ? reason : null;
}

/**
 * 判断一段输出是不是「模型直接说了人话」（而不是结构化 JSON）。
 * 用于兜底：不降级，改成一条普通 message。
 * - 去空白后不是以 [ 或 { 开头；
 * - 不是空串、不是 [DONE] 之类；
 * - 长度合理（避免把残缺 JSON 当成人话）。
 */
function plainTextReply(content: string): string | null {
  const text = content.trim();
  if (!text) return null;
  if (text.startsWith("[") || text.startsWith("{")) return null;
  if (text === "[DONE]" || text.length < 2) return null;
  return text;
}

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
  // 有些模型（实测 mimo-v2.6-flash）会在 JSON 前后夹带思考标记与代码围栏：
  //   </think>{"kind":...}```json [ {"kind":...} ]
  // 这些标记会让「第一个 [ 到最后一个 ]」的切片把噪声一起切进去，先洗掉。
  text = text
    .replace(/<\/?(?:think|thinking|reasoning)>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  if (!text) return null;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();

  // 情况一：正常的 JSON 数组（前后可能带解说）。
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) return text.slice(start, end + 1);

  // 情况二：模型没写外层数组，直接给了裸对象，甚至多个对象用空格拼在一起。
  //   {"kind":"tool",...} {"kind":"tool",...}
  // 这种情况按「平衡花括号」把对象一个个切出来，再包成数组。
  const objects = extractBalancedObjects(text);
  if (objects.length === 0) return null;
  return `[${objects.join(",")}]`;
}

/** 从任意文本里切出顶层 JSON 对象（考虑字符串里的花括号与转义）。 */
function extractBalancedObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

/**
 * 解析模型输出为 AgentTurn[]。导出以便单测直接覆盖结构校验。
 * - 顶层必须是数组，否则返回 []
 * - 未知 kind 丢弃
 * - 字段类型错误 / 必填缺失的 turn 丢弃
 * - mentions / to 只保留本房间内的成员 id，且 handoff 不能交给自己
 */
export function parseTurns(content: string, ctx: TurnContext): AgentTurn[] {
  const jsonText = extractJsonArray(content);
  if (jsonText === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const turns: AgentTurn[] = [];
  for (const item of parsed) {
    if (turns.length >= MAX_TURNS) break;
    const turn = parseTurn(item, ctx);
    if (turn) turns.push(turn);
  }
  return turns;
}

function parseTurn(item: unknown, ctx: TurnContext): AgentTurn | null {
  if (!isRecord(item)) return null;
  switch (item.kind) {
    case "message":
      return parseMessageTurn(item, ctx);
    case "tool":
      return parseToolTurn(item, ctx);
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
): AgentTurn | null {
  const text = requiredText(item.text);
  if (!text) return null;
  const turn: AgentTurn = { kind: "message", text };
  const mentions = parseMentions(item.mentions, ctx);
  if (mentions) turn.mentions = mentions;
  const delay = parseDelay(item.delayMs);
  if (delay !== undefined) turn.delayMs = delay;
  return turn;
}

function parseToolTurn(
  item: Record<string, unknown>,
  ctx: TurnContext,
): AgentTurn | null {
  const rawTool = item.tool;
  if (typeof rawTool !== "string") return null;
  const tool = rawTool.trim();
  if (!tool) return null;

  // 目录里有的工具按 schema 校验；目录里没有的（模型幻觉 / 没授权的工具）也保留，
  // 交给 driver 拒绝并把「工具不存在 / 没有权限」作为 tool_result 回喂给模型。
  //
  // 不能在这里静默丢弃：实测模型会输出「只有 tool turn」的数组，一旦被丢光，
  // 整轮就会降级到 mock，模型永远学不到「这个工具不能用」。
  const definition = ctx.availableTools.find((candidate) => candidate.name === tool);
  if (!definition && !BUILTIN_TOOL_NAMES.has(tool)) {
    // 完全编造的工具名：丢弃。
    return null;
  }
  // 兼容两种写法：规范写法把参数放在 input 里；
  // 有些模型（实测 mimo-v2.6-flash）把参数平铺在顶层：
  //   {"kind":"tool","tool":"write_file","path":"..." ,"content":"..."}
  // 有 input 字段就以它为准（类型不对 → 非法，交给下面判断）；
  // 完全没有 input 字段时才尝试把顶层参数扁平化。
  const hasInputField = Object.prototype.hasOwnProperty.call(item, "input");
  // list_files 不接受参数，扁平化对它没有意义；有 input 字段但类型不对时直接判非法。
  // 三种来源：
  // - 有 input 字段且是对象：直接用它；
  // - 有 input 字段但类型不对：null，表示非法（交给下面 ×）；
  // - 没有 input 字段：尝试从顶层扁平字段里取；取不到就是 undefined（= 没给参数）。
  let rawInput: Record<string, unknown> | null | undefined;
  if (hasInputField) {
    rawInput = isRecord(item.input) ? item.input : null;
  } else if (tool === "list_files") {
    rawInput = undefined;
  } else {
    rawInput = flattenToolInput(item) ?? undefined;
  }

  let input: Record<string, unknown> | null;
  if (rawInput === null) {
    input = null; // 明确给了 input 但不是对象 → 非法
  } else if (definition) {
    input = parseToolInput(definition, rawInput);
  } else {
    // 目录里没有但名字合法的内置工具：保留，交给 driver 回「没有权限」。
    input = rawInput ?? {};
  }
  if (!input) return null;
  const turn: AgentTurn = { kind: "tool", tool, input };
  const label = requiredText(item.label);
  if (label) turn.label = label;
  const text = requiredText(item.text);
  if (text) turn.text = text;
  const mentions = parseMentions(item.mentions, ctx);
  if (mentions) turn.mentions = mentions;
  const delay = parseDelay(item.delayMs);
  if (delay !== undefined) turn.delayMs = delay;
  return turn;
}

function parseHandoffTurn(
  item: Record<string, unknown>,
  ctx: TurnContext,
): AgentTurn | null {
  const to = requiredText(item.to);
  if (!to) return null;
  // handoff 只能交给房间里、且不是自己的成员。
  if (to === ctx.cat.id) return null;
  if (!ctx.room.catIds.includes(to)) return null;

  const card = parseCard(item.card);
  if (!card) return null;

  const turn: AgentTurn = { kind: "handoff", to, card };
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
): AgentTurn | null {
  const artifact = parseArtifactBody(item.artifact);
  if (!artifact) return null;
  const turn: AgentTurn = { kind: "artifact", artifact };
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
): AgentTurn | null {
  const verdict = item.verdict;
  if (typeof verdict !== "string" || !REVIEW_VERDICTS.includes(verdict as ReviewVerdict)) {
    return null;
  }
  const title = requiredText(item.title);
  const text = requiredText(item.text);
  if (!title || !text) return null;

  const findings = parseFindings(item.findings);
  if (findings === null) return null;

  const turn: AgentTurn = {
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

function parseDecisionTurn(item: Record<string, unknown>): AgentTurn | null {
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

  const turn: AgentTurn = { kind: "decision", artifact, text, memory };
  const delay = parseDelay(item.delayMs);
  if (delay !== undefined) turn.delayMs = delay;
  return turn;
}

function parseMemoryTurn(item: Record<string, unknown>): AgentTurn | null {
  const text = requiredText(item.text);
  const memory = parseMemoryEntry(item.memory);
  if (!text || !memory) return null;
  const turn: AgentTurn = { kind: "memory", memory, text };
  const delay = parseDelay(item.delayMs);
  if (delay !== undefined) turn.delayMs = delay;
  return turn;
}

// ───────────────────────── 字段校验 ─────────────────────────

/**
 * 工具 input 结构校验，与 src/tools/sandbox.ts 的契约对齐：
 * - read_file   { path }
 * - write_file  { path, content }（content 允许空字符串，表示清空文件）
 * - list_files  {}（多余参数忽略）
 * - run_command { cmd, args? }（args 必须是字符串数组，缺省 []）
 * 只做结构校验；路径越界 / 命令白名单留给沙盒，让它把错误回执喂回来。
 */
/**
 * 工具 input 校验：
 * - 内置沙盒工具按 src/tools/sandbox.ts 的契约做结构校验；
 * - MCP 工具的 schema 由对应 server 负责，这里只要求 input 是对象（原样透传）。
 * 只做结构校验；路径越界 / 命令白名单留给执行层，让它把错误回执喂回来。
 */
/** tool turn 的顶层字段（去掉 turn 自身的元字段）当作 input，兼容扁平写法。 */
function flattenToolInput(item: Record<string, unknown>): Record<string, unknown> | null {
  const skip = new Set(["kind", "tool", "label", "text", "mentions", "delayMs", "input"]);
  const flattened: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (skip.has(key)) continue;
    flattened[key] = value;
  }
  return Object.keys(flattened).length > 0 ? flattened : null;
}

function parseToolInput(
  definition: ToolDefinition,
  value: unknown,
): Record<string, unknown> | null {
  if (definition.source === "mcp") {
    if (value === undefined) return {};
    return isRecord(value) ? { ...value } : null;
  }

  if (value !== undefined && !isRecord(value)) return null;
  const input = value ?? {};

  switch (definition.name) {
    case "read_file": {
      const path = requiredText(input.path);
      return path ? { path } : null;
    }
    case "write_file": {
      const path = requiredText(input.path);
      if (!path) return null;
      // 空文件是合法写入。
      if (typeof input.content !== "string") return null;
      return { path, content: input.content };
    }
    case "list_files":
      return {};
    case "run_command": {
      // 真实模型经常把 cmd 写成 command；两个都收。
      const cmd = requiredText(input.cmd) ?? requiredText(input.command);
      if (!cmd) return null;
      const rawArgs = input.args;
      const args: string[] = [];
      if (rawArgs !== undefined) {
        if (!Array.isArray(rawArgs)) return null;
        for (const arg of rawArgs) {
          if (typeof arg !== "string") return null;
          args.push(arg);
        }
      }
      return { cmd, args };
    }
    default:
      // 未来新增的沙盒工具：只要求 input 是对象。
      return { ...input };
  }
}

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

/** mentions 只接受本房间成员 id；去重；空数组返回 undefined。 */
function parseMentions(value: unknown, ctx: TurnContext): MemberId[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const out: MemberId[] = [];
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

/** 每个成员用哪个模型：cat.llmModel 优先（空白串视为未设置），否则全局。 */
function resolveModel(ctx: TurnContext, globalModel: string): string {
  const perCat = typeof ctx.cat.llmModel === "string" ? ctx.cat.llmModel.trim() : "";
  return perCat || globalModel;
}

/** 每个成员的温度：cat.llmTemperature 优先，0 是合法值，非法/缺省回落全局。 */
function resolveTemperature(ctx: TurnContext, globalTemperature: number): number {
  const perCat = ctx.cat.llmTemperature;
  if (typeof perCat === "number" && Number.isFinite(perCat)) {
    return clamp(perCat, 0, 2);
  }
  return globalTemperature;
}

export /**
 * 「你的近期经历」：把这个成员跨任务的连续性写进 prompt。
 *
 * 对应 Member Café 的成功标准之一——「任何一个成员新开窗口，5 分钟内能进入状态」。
 * 内容克制：最近 5 个任务 + 3 条自己的教训，避免 prompt 膨胀。
 */
/**
 * 房间里的成员（名字 ↔ catId 对照）。
 *
 * 为什么要显式给对照表：实测模型会把「沈砚」写成「燕燕」、「周烁」写成「说说」，
 * 因为它只看到了一串 catId，不知道怎么念。给它名字就别猜了。
 */
function renderRoomCats(ctx: TurnContext): string {
  const lines = [
    "【房间里的成员】称呼必须严格用下面的名字和 catId，不要自创、不要音译：",
  ];
  for (const peer of ctx.roomCats) {
    const self = peer.id === ctx.cat.id;
    const roleText = ROLE_LABEL[peer.role] ?? peer.role;
    lines.push(`- ${peer.name}（${roleText}）= ${peer.id}${self ? " ← 你自己" : ""}`);
  }
  return lines.join("\n");
}

function renderSession(session: TurnContext["session"]): string | null {
  if (!session) return null;
  const episodes = session.episodes.slice(0, 5);
  const lessons = session.lessons.slice(0, 3);
  if (episodes.length === 0 && lessons.length === 0) return null;

  const lines: string[] = ["【你的近期经历】"];
  if (episodes.length > 0) {
    lines.push("你最近参与过的任务（新的在前）：");
    for (const episode of episodes) {
      const mark = episode.outcome === "done" ? "完成" : episode.outcome === "abandoned" ? "中止" : "未完成";
      lines.push(`- [${mark}] ${episode.title}：${episode.summary}`);
    }
  }
  if (lessons.length > 0) {
    lines.push("你自己总结过的教训：");
    for (const lesson of lessons) lines.push(`- ${lesson.title}：${lesson.body.slice(0, 120)}`);
  }
  lines.push("如果这次需求跟上面某个任务相关，主动提一句你再做；不相关就忽略。");
  return lines.join("\n");
}

export function buildSystemPrompt(ctx: TurnContext, model: string): string {
  const { cat, room, task, availableTools, skills } = ctx;
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
        // 刻意不透传 scenarioId：那是「内置演出剧本」的内部标识，只在 mock 模式有意义。
        // 实测真跑时它会把模型带偏——需求是修三个 bug，模型却在产物标题和评语里
        // 写「导出 CSV v2」「权限在 service 层兜住了」，因为场景叫 export_csv。
        // 真实模式下模型应该只依据需求原文和仓库事实。
      ].join("\n")
    : "【当前任务】没有进行中的任务，你只是在房间里聊天。";

  const sessionBlock = renderSession(ctx.session);

  const sections: string[] = [
    `你是「${cat.name}」（${cat.discipline}），交付台里的${ROLE_LABEL[cat.role] ?? cat.title}。`,
    `性格：${cat.persona}`,
    `口头禅：${cat.catchphrase}`,
    `房间：${room.name} —— ${room.topic}`,
    `本次使用模型：${model}。`,
    `你的 catId 是 ${selfId}，你的名字是「${cat.name}」。`,
    "",
    taskBlock,
    ...(sessionBlock ? ["", sessionBlock] : []),
    "",
    renderRoomCats(ctx),
    "",
    "【输出格式 · 必须严格遵守】",
    "只输出一个 JSON 数组，不要 markdown 代码围栏，不要任何解释文字。",
    "你的输出会被程序直接 JSON.parse。任何非 JSON 内容都会导致整轮失败。",
    "❌ 错误示例（绝对不要这样输出）：",
    "   好的，我来拆解这个需求。",
    "   可以",
    "   ```json\n[...]\n```",
    "✅ 正确示例：",
    '   [{"kind":"message","text":"收到，我先钉两件事。"}]',
    "即使是简单回答、拒绝、疑问，也**必须**包成 JSON 数组里的 message turn，不能直接说人话。",
    "数组元素是下面 7 种 turn 之一；一次输出 1~4 个 turn（工具轮可以连发多个，总共不超过 6 个）：",
    '1. {"kind":"message","text":"要说的话","mentions":["catId"]}',
    '2. {"kind":"handoff","to":"catId","card":{"what":"做什么","why":"为什么","tradeoff":"取舍","openQuestions":["未决问题"],"nextAction":"下一步"},"text":"伴随说明"}',
    '3. {"kind":"artifact","artifact":{"kind":"spec|design|patch|review|decision","title":"标题","body":"正文"},"text":"说明","mentions":["catId"]}',
    '4. {"kind":"review","verdict":"approve|request_changes","title":"结论标题","findings":[{"severity":"blocker|minor","title":"问题","detail":"细节"}],"text":"说明","mentions":["catId"]}',
    '5. {"kind":"decision","artifact":{"title":"标题","body":"正文"},"text":"说明","memory":[{"kind":"decision|lesson|preference","title":"标题","body":"正文","tags":["标签"]}]}',
    '6. {"kind":"memory","memory":{"kind":"decision|lesson|preference","title":"标题","body":"正文","tags":["标签"]},"text":"说明"}',
    '7. {"kind":"tool","tool":"工具名","input":{...},"label":"人话摘要","text":"说明"}',
    "",
    "【工具目录】",
    ...renderToolCatalog(availableTools),
    "",
    "【规则】",
    "- kind 只能是 message / tool / handoff / artifact / review / decision / memory；其他一律不要输出。",
    "- mentions、handoff.to 只能用上面列出的 catId，不要用成员的名字；handoff 不能交给自己。",
    "- handoff 卡片的 what / why / tradeoff / openQuestions / nextAction 五栏必须齐全，openQuestions 必须是字符串数组。",
    "- 全部用中文，保持角色人格和口头禅，不要出戏；每条 text 控制在 120 字以内。",
    "- 需要别人做事就用 handoff；别人给了你产物、轮到你评审就用 review；任务收尾用 decision 把结论记进共享记忆。",
    "- 信息不足时先用 message 追问，不要编造事实。",
    "- delayMs 可选，单位毫秒，范围 0~8000，表示开口前的停顿。",
  ];

  if (availableTools.length > 0) {
    sections.push(
      "",
      "阶段纪律（很重要）：",
      "- intake（接需求）/ planning（拆解规划）：不要读代码、不要跑命令；项目结构不清时最多 list_files 一次，" +
        "然后立刻交付「复述需求 + 风险 + 拆活 + 交接卡」。",
      "- working / revising：才允许 read_file / write_file / run_command，并且先跑测试拿证据。",
      "- reviewing：先跑测试或读 diff 作为证据，再给 verdict。",
      "",
      "工具使用纪律：",
      '- 一轮可以同时请求多个工具，会按数组顺序执行；执行完会用 trigger.kind="tool_result" 把回执再发给你一次。',
      "- 工具调用最多连续 3 轮，之后必须给出结论或交接，不要无限试探。",
      "- 收到 status=rejected 时不要重复申请同一个命令 / 同一个写入；换方案，或直接向负责人说明被拒原因与替代做法。",
      "- 读文件、看目录这类低风险操作尽量一轮批量做完，不要一轮一个。",
      "- run_command 的参数限制：每个 ≤80 字、不含空格/../绝对路径、最多 10 个、不支持 shell 管道与重定向。" +
        "读文件一律用 read_file；不要用 `node -e \"...\"` 之类长内联脚本去读或改文件。",
      "- 同一类操作连续失败两次就停下：说明限制或方案有问题，改用别的工具或直接向负责人说明，不要无限重试。",
    );
  }

  const skillsBlock = renderSkills(skills);
  if (skillsBlock) sections.push("", skillsBlock);

  return sections.join("\n");
}

/** 渲染【工具目录】。空目录必须明确说没有工具，防止模型编造。 */
function renderToolCatalog(tools: ToolDefinition[]): string[] {
  if (tools.length === 0) {
    return [
      '本轮没有可用工具。不要编造工具名、不要假装执行，也不要输出 kind="tool" 的 turn；只能基于已有信息回答，或直接说明你需要什么能力。',
    ];
  }

  const lines: string[] = [];
  for (const def of tools) {
    const serverTag = def.source === "mcp" ? `｜server=${def.serverId ?? "?"}` : "";
    lines.push(
      `- ${def.name}｜${def.title}｜source=${def.source}${serverTag}｜risk=${def.risk}`,
    );
    lines.push(`  用途：${def.description}`);
    lines.push(`  inputSchema：${safeJson(def.inputSchema)}`);
  }

  lines.push(
    "",
    "工具名必须与上面完全一致；MCP 工具名形如 serverId__toolName，原样使用，不要改写或截断。",
  );

  const hasSandbox = tools.some((def) => def.source === "sandbox");
  if (hasSandbox) {
    lines.push(
      "沙盒工具路径必须相对沙盒根目录，禁止绝对路径和 ..；write_file 的 content 必须是完整文件内容。",
      "风险：write_file 会真实改文件，run_command 会真实执行命令。",
    );
  }
  lines.push(
    "风险：risk=needs_approval 的工具每次执行都可能需要负责人审批，被拒绝时回执 status=rejected；risk=safe 一般直接执行。",
    "调用工具是为了拿真实信息或产生真实结果；普通讨论不需要工具。",
  );
  return lines;
}

/** 渲染【你挂载的技能】；按 ctx.skills 顺序原样注入 prompt 全文。 */
function renderSkills(skills: Skill[]): string | null {
  if (skills.length === 0) return null;
  const lines: string[] = ["【你挂载的技能】"];
  for (const skill of skills) {
    lines.push("", `### ${skill.name}`, skill.prompt);
  }
  return lines.join("\n");
}

export function buildUserPrompt(ctx: TurnContext): string {
  const {
    task,
    recentMessages,
    memory,
    handoffs,
    artifacts,
    recentToolResults,
    trigger,
  } = ctx;

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

  // 最近工具回执：喂回给模型判断下一步；单条 output 截断，最多保留 8 条。
  const toolResultLines = recentToolResults
    .slice(-8)
    .map((result) => renderToolResultLine(result));

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
    "【工具结果（最近的执行回执）】",
    toolResultLines.length > 0
      ? toolResultLines.join("\n")
      : "（还没有工具结果）",
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
  if (trigger.fromMemberId) lines.push(`- 来自：${trigger.fromMemberId}`);
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
  if (trigger.toolResults && trigger.toolResults.length > 0) {
    lines.push(`- 本轮工具回执（${trigger.toolResults.length} 条）：`);
    for (const result of trigger.toolResults.slice(0, 8)) {
      lines.push(renderToolResultLine(result, "  "));
    }
  }
  return lines.join("\n");
}

/** 一条工具回执的单行摘要：callId / 工具 / 状态 / 退出码 / 截断输出。 */
function renderToolResultLine(result: ToolRunResult, indent = ""): string {
  const meta = [
    `callId=${result.callId}`,
    `tool=${result.tool}`,
    `status=${result.status}`,
  ];
  if (result.exitCode !== undefined) meta.push(`exitCode=${result.exitCode}`);
  return `${indent}- ${meta.join(" ")}｜output: ${clip(result.output || "(无输出)", 500)}`;
}

function renderCard(card: HandoffCard): string {
  const open = card.openQuestions.map((q) => clip(q, 60)).join(" / ") || "（无）";
  return `做什么=${clip(card.what, 120)}；为什么=${clip(card.why, 100)}；取舍=${clip(card.tradeoff, 100)}；未决问题=${open}；下一步=${clip(card.nextAction, 100)}`;
}

function authorLabel(author: string, ctx: TurnContext): string {
  if (author === "user") return "负责人";
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

/** 工具 schema 序列化；异常 schema 不能把整个 prompt 搞崩。 */
function safeJson(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return "{}";
  }
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

/** 从 OpenAI / Anthropic 兼容响应里取 token 用量。 */
function usageFrom(payload: unknown): { inputTokens?: number; outputTokens?: number } {
  if (!isRecord(payload)) return {};
  const usage = payload.usage;
  if (!isRecord(usage)) return {};
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  const result: { inputTokens?: number; outputTokens?: number } = {};
  if (typeof input === "number") result.inputTokens = input;
  if (typeof output === "number") result.outputTokens = output;
  return result;
}
