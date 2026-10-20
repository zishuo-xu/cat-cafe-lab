/**
 * 协作引擎（T1）：每房间串行队列 + 阶段状态机 + @路由 + 延迟调度 + 故障恢复。
 *
 * 职责边界：
 *   - driver 只负责调度、路由、状态推进、落库；
 *   - 台词全部来自注入的 AgentBrain（mock / llm），driver 不写死任何剧情文本。
 *
 * 关键约定：
 *   - 外部事件 submit() 不阻塞，进房间串行队列；whenIdle() 等整条链跑完。
 *   - 所有状态改动都走 Studio 的 mutator，不直接改字段。
 *   - 交接 turn 只路由给 handoff.to；用户消息只唤醒 mentions（无 @ 时 owner）。
 *   - handoff.fault === "missed_mention"：卡片 / 消息照写（mentions 仍写 [to]），
 *     但不唤醒接收方、任务标 stalled；等 nudge 补投递后才进下一阶段。
 *   - tool turn：走 studio.addToolCall → sandbox.execute → finishToolCall →
 *     appendMessage(kind:"tool")；不改阶段、不触发 handoff，失败也不抛异常。
 *   - 审批：仅 brain.mode === "llm" 且注入 approvals 时生效；pending → request →
 *     拒绝则不执行（rejected 也回喂），批准后 startToolCall 再执行。
 *   - ReAct：llm 模式下本轮有工具回执时，用 Trigger{kind:"tool_result"} 再问同一个成员，
 *     最多 MAX_TOOL_ROUNDS 轮；回喂轮不改 stage。
 */

import { SCENARIOS } from "../agents/personas.ts";
import { STAGE_TEXT } from "../domain/types.ts";
import type {
  ApprovalGate,
  Artifact,
  BrainReport,
  Member,
  AgentBrain,
  MemberId,
  AgentTurn,
  Driver,
  EngineEvent,
  Handoff,
  HandoffCard,
  ReviewFinding,
  ReviewVerdict,
  Room,
  RoomId,
  SandboxRunner,
  Skill,
  Task,
  TaskId,
  TaskStage,
  ToolApprovalMode,
  ToolDefinition,
  ToolName,
  ToolRegistry,
  ToolResult,
  ToolRunResult,
  Trigger,
  TriggerKind,
  TurnContext,
} from "../domain/types.ts";
import type { Studio } from "../server/studio.ts";
import { skillsForCat } from "../skills/registry.ts";
import { handoffMentions, normalizeMentions, routeUserMessage } from "./mentions.ts";
import {
  architectOf,
  findByRole,
  formatReviewBody,
  handoffMove,
  reviewMove,
} from "./stages.ts";

const DEFAULT_STALL_MS = 12_000;
/** 「开始思考 → 出声」的基础延迟。 */
const THINK_DELAY_MS = 600;
/** 一个 turn 与下一个 turn 之间的默认间隔。 */
const TURN_DELAY_MS = 220;
/** 真实模式下工具回执 → 再推理的最大回喂轮数（不含首轮）。 */
const MAX_TOOL_ROUNDS = 3;
/**
 * intake / planning 阶段的工具回喂上限。
 *
 * 这两个阶段的职责是「复述需求 + 拆活 + 发交接卡」，不是读代码。真实模型（推理型）
 * 容易在 intake 里连续 list_files / read_file 探索，把 3 轮回喂全部用光，最后因
 * max_tokens 截断降级，任务卡在 intake。这里给这两个阶段留 1 轮回喂：够它确认
 * 项目结构，不够它把任务变成「读代码」。
 */
const MAX_EXPLORE_ROUNDS = 1;
/** TurnContext.recentToolResults 保留的最近条数。 */
const RECENT_TOOL_RESULTS = 8;
/**
 * 同一轮 wake 里连续工具失败（error / rejected）的容忍次数。
 *
 * 真实模型遇到沙盒限制（参数过长、路径非法）会反复换写法重试：实测一个任务里
 * 出现 40 次工具调用、10 次 pending 审批。连续失败到阈值就停止回喂，让模型
 * 基于已有信息收尾，而不是继续消耗预算。
 */
const MAX_CONSECUTIVE_TOOL_FAILURES = 3;
/**
 * 同一任务允许的「打回 → 修订」轮数上限。
 *
 * 真实模型下 reviewer 可能持续要求修改（实测一条任务打回 4 次以上，
 * 任务永远在 reviewing ↔ revising 之间打转）。到上限后强制收尾：
 * 记录一条 lesson，任务转 done，避免无限循环消耗预算。
 */
const MAX_REVISION_ROUNDS = 3;

type TurnOf<K extends AgentTurn["kind"]> = Extract<AgentTurn, { kind: K }>;
type HandoffTurn = TurnOf<"handoff">;
type ToolTurn = TurnOf<"tool">;

/**
 * 能否与其他工具并行执行。
 *
 * 只读、不需要审批、走沙盒/ MCP 读接口的工具可以并行：
 * 模型一轮发 4~6 个 read_file 是最常见的形态，串行执行要等 4~6 次 IO。
 * write_file 会改变后续读的结果，run_command 可能有副作用，都必须串行。
 */
function isParallelizableTool(turn: ToolTurn): boolean {
  return turn.tool === "read_file" || turn.tool === "list_files";
}

/** 工具没给 label 时的默认人话摘要（前端时间线展示用）。 */
function defaultToolLabel(tool: ToolTurn["tool"], input: Record<string, unknown>): string {
  switch (tool) {
    case "write_file":
      return `写入 ${inputText(input, "path") || "文件"}`;
    case "read_file":
      return `读取 ${inputText(input, "path") || "文件"}`;
    case "list_files":
      return "列出沙盒文件";
    case "run_command": {
      const cmd = inputText(input, "cmd") || "命令";
      const args = inputList(input, "args");
      return args.length > 0 ? `运行 ${cmd} ${args.join(" ")}` : `运行 ${cmd}`;
    }
    default:
      return `调用 ${String(tool)}`;
  }
}

/** 工具没给 text 时的默认结果摘要。 */
function defaultToolText(
  tool: ToolTurn["tool"],
  input: Record<string, unknown>,
  result: ToolResult,
): string {
  switch (tool) {
    case "run_command": {
      const cmd = inputText(input, "cmd") || "命令";
      if (result.exitCode !== undefined) return `跑了 ${cmd}，退出码 ${result.exitCode}`;
      return result.status === "ok" ? `跑了 ${cmd}，完成` : `跑了 ${cmd}，没跑起来`;
    }
    case "write_file":
      return `写好了 ${inputText(input, "path") || "文件"}`;
    case "read_file":
      return `读了 ${inputText(input, "path") || "文件"}`;
    case "list_files":
      return "看了一眼沙盒目录";
    default:
      return result.status === "ok"
        ? `${String(tool)} 完成`
        : `${String(tool)} 失败：${result.output.slice(0, 80)}`;
  }
}

function inputText(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

function inputList(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** 内置沙盒工具：它们的 label / text 有专有措辞；其他（MCP）走通用摘要。 */
const BUILTIN_TOOL_NAMES = new Set<ToolName>([
  "read_file",
  "write_file",
  "list_files",
  "run_command",
]);

function isBuiltinTool(tool: ToolName): boolean {
  return BUILTIN_TOOL_NAMES.has(tool);
}

/** 把工具入参压成一段可读摘要（非内置工具 label 用）。 */
function summarizeInput(input: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(input);
    if (!json || json === "{}") return "";
    return json.length > 60 ? `${json.slice(0, 60)}…` : json;
  } catch {
    return "";
  }
}

/** tool turn 的 label：显式 > 内置专有措辞 > 注册表标题 + 入参摘要。 */
function toolLabelFor(turn: ToolTurn, definition: ToolDefinition | undefined): string {
  const explicit = turn.label?.trim();
  if (explicit) return explicit;
  if (isBuiltinTool(turn.tool) || !definition) {
    return defaultToolLabel(turn.tool, turn.input);
  }
  const title = definition.title || String(turn.tool);
  const summary = summarizeInput(turn.input);
  return summary ? `${title} · ${summary}` : title;
}

/** tool 消息的默认文案：内置专有措辞；非内置用注册表标题 + 结果。 */
function toolTextFor(
  turn: ToolTurn,
  definition: ToolDefinition | undefined,
  result: ToolResult,
): string {
  if (isBuiltinTool(turn.tool) || !definition) {
    return defaultToolText(turn.tool, turn.input, result);
  }
  const title = definition.title || String(turn.tool);
  return result.status === "ok" ? `${title} 完成` : `${title} 失败：${result.output.slice(0, 80)}`;
}

/** driver 只依赖 execute 这一件事；registry 与 sandbox 都能满足。 */
interface ToolExecutor {
  execute(tool: ToolName, input: Record<string, unknown>): Promise<ToolResult>;
}

/** ToolCall / ToolResult → 回喂给 brain 的 ToolRunResult。 */
function toRunResult(callId: string, tool: ToolName, result: ToolResult): ToolRunResult {
  const runResult: ToolRunResult = {
    callId,
    tool,
    status: result.status,
    output: result.output,
  };
  if (result.exitCode !== undefined) runResult.exitCode = result.exitCode;
  return runResult;
}

/** 更新连续失败计数：本轮有成功就归零，否则累加失败数。 */
function updateFailureStreak(
  current: number,
  results: Array<{ status: string }>,
): number {
  if (results.length === 0) return current;
  const succeeded = results.some((result) => result.status === "ok");
  if (succeeded) return 0;
  return current + results.length;
}

/** 执行工具；SandboxRunner / ToolRegistry 约定不抛，注入实现万一抛了也记成 error。 */
async function executeSafely(runner: ToolExecutor, turn: ToolTurn): Promise<ToolResult> {
  try {
    return await runner.execute(turn.tool, turn.input);
  } catch (err) {
    return {
      status: "error",
      output: err instanceof Error ? err.message : String(err),
    };
  }
}

type WakePurpose =
  | "kickoff"
  | "planning"
  | "patrol"
  | "worker"
  | "reviewer"
  | "decision"
  | "nudge"
  | "chat";

/** 一次待执行的「让某个成员想一轮」。 */
interface Wake {
  roomId: RoomId;
  catId: MemberId;
  taskId?: TaskId;
  purpose: WakePurpose;
  trigger: Trigger;
}

/** 被漏 @ 卡住、等待 nudge 补投递的交接。 */
interface MissedDelivery {
  handoffId: string;
  from: MemberId;
  to: MemberId;
  card: HandoffCard;
  targetStage: TaskStage;
  text?: string;
}

interface TaskRuntime {
  /** working / revising 阶段还没跑完的目标数。 */
  workers: number;
  /** 已声明要交给 reviewer、但需等所有 worker 跑完才投递的唤醒。 */
  deferredReviewer: Wake | null;
  /** 漏 @ 卡住的交接；只有 nudge 能救。 */
  missed: MissedDelivery | null;
  stallTimer: ReturnType<typeof setTimeout> | null;
  /** 已发生的「打回 → 修订」轮数。 */
  revisions: number;
  /**
   * 上一次 stall 判定时任务为什么在忙（排查用）。
   * 没有它的话，"任务一直不判卡住"会变成一个无法解释的现象。
   */
  lastBusyReason: string | null;
}

interface ReviewApplied {
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  mentions: MemberId[];
  text: string;
  title: string;
}

interface AppliedTurns {
  handoffs: Array<{ turn: HandoffTurn; handoff: Handoff }>;
  review: ReviewApplied | null;
  lastArtifact: Artifact | null;
  /** 本轮实际执行 / 被拒绝的工具回执（用于 ReAct 回喂）。 */
  toolResults: ToolRunResult[];
}

export function createDriver(deps: {
  studio: Studio;
  brain: AgentBrain;
  wait?: (ms: number) => Promise<void>;
  stallMs?: number;
  /** 沙盒工具执行器；不传则 tool turn 只留说明消息（降级）。 */
  sandbox?: SandboxRunner;
  /** 运行时开关：设置面板可以随时关掉工具执行。 */
  toolsEnabled?: () => boolean;
  /** 审批策略：auto / commands / all。 */
  approvalMode?: () => ToolApprovalMode;
  /** 审批闸门；不传则不审批。仅 brain.mode === "llm" 时生效。 */
  approvals?: ApprovalGate;
  /** 工具注册表（内置 + MCP）；优先于 sandbox 执行。 */
  tools?: ToolRegistry;
  /** 按房间取工作区沙盒（C 阶段多工作区）；不传则回落到 sandbox。 */
  sandboxFor?: (roomId: RoomId) => SandboxRunner | undefined;
  /** 按 id 解析技能包（自定义技能）；缺省回落到内置技能表。 */
  resolveSkill?: (id: string) => Skill | undefined;
}): Driver {
  const { studio, brain, sandbox, approvals, tools } = deps;
  const toolsEnabled = deps.toolsEnabled;
  const approvalMode = deps.approvalMode;
  const resolveSkill = deps.resolveSkill;
  /** 兜底执行器：注册表优先，其次 sandbox。 */
  const executor: ToolExecutor | undefined = tools ?? sandbox;

  /**
   * 按「房间 + 工具来源」选执行器：
   * - MCP 工具走注册表；
   * - 内置沙盒工具优先用房间绑定的工作区沙盒（C 阶段）；
   * - 没有房间沙盒时回落到全局 executor。
   */
  function executorFor(roomId: RoomId, tool: ToolName): ToolExecutor | undefined {
    const definition = tools?.get(tool);
    if (definition?.source === "mcp") return tools ?? undefined;
    const roomSandbox = deps.sandboxFor?.(roomId);
    if (roomSandbox) {
      return { execute: (name, input) => roomSandbox.execute(name, input) };
    }
    return executor;
  }
  const wait =
    deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stallMs = deps.stallMs ?? DEFAULT_STALL_MS;

  /** roomId → 该房间队列尾部。 */
  const queues = new Map<RoomId, Promise<void>>();
  const runtimes = new Map<TaskId, TaskRuntime>();
  const idleWaiters: Array<() => void> = [];
  /** 未完成的队列任务数（含正在跑的和已排队但还没跑的）。 */
  let pending = 0;
  /**
   * roomId → 该房间还有多少个 wake 在跑或排队。
   *
   * stall watchdog 需要它：同房间两个任务排队时，后一个任务只是在等前一个跑完，
   * 不是真的卡住。没有这个判断会把「排队等待」误标成 stalled（实测并发任务全被误伤）。
   */
  const roomPending = new Map<RoomId, number>();

  // ── 串行队列 ──────────────────────────────────────────

  function enqueue(roomId: RoomId, job: () => Promise<void>): void {
    pending += 1;
    roomPending.set(roomId, (roomPending.get(roomId) ?? 0) + 1);
    const previous = queues.get(roomId) ?? Promise.resolve();
    const next = previous
      .then(job)
      .catch((err: unknown) => {
        console.error("[engine] 轮次处理失败：", err);
      })
      .finally(() => {
        pending -= 1;
        const left = (roomPending.get(roomId) ?? 1) - 1;
        if (left <= 0) roomPending.delete(roomId);
        else roomPending.set(roomId, left);
        if (pending > 0) return;
        pending = 0;
        const waiters = idleWaiters.splice(0, idleWaiters.length);
        for (const resolve of waiters) resolve();
      });
    queues.set(roomId, next);
  }

  function enqueueWake(wake: Wake): void {
    enqueue(wake.roomId, () => processWake(wake));
  }

  // ── 外部事件 ──────────────────────────────────────────

  function submit(event: EngineEvent): void {
    switch (event.type) {
      case "task_created": {
        const task = studio.getTask(event.taskId);
        if (!task) return;
        ensureStep(task);
        const architect = studio.getCat(task.owner) ?? architectOf(studio.state.cats);
        if (!architect) return;
        enqueueWake({
          roomId: task.roomId,
          catId: architect.id,
          taskId: task.id,
          purpose: "kickoff",
          trigger: {
            kind: "task_created",
            roomId: task.roomId,
            taskId: task.id,
            text: task.brief,
          },
        });
        return;
      }

      case "user_message": {
        const room = studio.getRoom(event.roomId);
        if (!room) return;

        // 房间里有活跃任务时，用户直接说话会被当成"对当前任务的补充"，
        // 但实测这会让两条需求的内容混在一起，成员分不清在做什么。
        // 所以：先明确告知，再决定是否照常放行（用户坚持要说话时不拦）。
        const activeTask = activeTaskIn(event.roomId);
        if (activeTask && !event.force) {
          studio.appendMessage({
            roomId: event.roomId,
            author: "system",
            kind: "system",
            text:
              `「${activeTask.title}」还在进行中（${STAGE_TEXT[activeTask.stage] ?? activeTask.stage} 阶段）。` +
              `同一个房间一次只做一件事，新需求会被当成对这个任务的补充。` +
              `如果是一件新的事，请点「＋ 新任务」并新建一个房间，或等这个任务结束。`,
            mentions: [],
          });
        }

        const task = activeTask ?? latestTask(event.roomId);
        const targets = routeUserMessage(roomCats(room), task, event.mentions);
        for (const catId of targets) {
          enqueueWake({
            roomId: event.roomId,
            catId,
            ...(task ? { taskId: task.id } : {}),
            purpose: "chat",
            trigger: {
              kind: "user_message",
              roomId: event.roomId,
              ...(task ? { taskId: task.id } : {}),
              text: event.text,
              mentions: event.mentions,
            },
          });
        }
        return;
      }

      case "task_action": {
        const task = studio.getTask(event.taskId);
        if (!task) return;
        const architect = architectOf(studio.state.cats);

        // 已经 done 的任务：只有「被强制收尾」（review-loop 记忆）的才允许继续/换方案复活，
        // 正常完成的任务不能重开，避免误操作把收尾的任务又拉起来。
        if (task.status === "done") {
          if (event.action === "close") return;
          const forcedClose = studio
            .snapshot()
            .memory.some(
              (entry) =>
                entry.sourceTaskId === task.id && entry.tags.includes("review-loop"),
            );
          if (!forcedClose) return;
          studio.setTaskStatus(task.id, "active");
        }

        if (event.action === "close") {
          studio.closeTaskWithReason(task.id, event.note?.trim() || "负责人选择收尾");
          clearStall(task.id);
          return;
        }

        if (event.action === "pivot") {
          // 换方案：解除卡住，把「换方案」作为一次明确的新指令交给架构师，
          // 由它重新拆活（必要时换一个成员 / 换一种工具策略）。
          if (task.status === "stalled") studio.setTaskStatus(task.id, "active");
          clearStall(task.id);
          const note = event.note?.trim();
          studio.appendMessage({
            roomId: task.roomId,
            author: "user",
            kind: "chat",
            text: note ? `换个方案：${note}` : "换个方案，别再走原来的路子。",
            mentions: architect ? [architect.id] : [],
            taskId: task.id,
          });
          if (architect) {
            enqueueWake({
              roomId: task.roomId,
              catId: architect.id,
              taskId: task.id,
              purpose: "nudge",
              trigger: {
                kind: "nudge",
                roomId: task.roomId,
                taskId: task.id,
                text: note ?? "换个方案，别再走原来的路子。",
              },
            });
          }
          return;
        }

        // continue：按「催一下」处理，恢复正常推进。
        if (task.status === "stalled") studio.setTaskStatus(task.id, "active");
        clearStall(task.id);
        if (architect) {
          enqueueWake({
            roomId: task.roomId,
            catId: architect.id,
            taskId: task.id,
            purpose: "nudge",
            trigger: {
              kind: "nudge",
              roomId: task.roomId,
              taskId: task.id,
              text: task.brief,
            },
          });
        }
        return;
      }

      case "nudge": {
        const task = studio.getTask(event.taskId);
        if (!task) return;
        clearStall(task.id);
        const architect = architectOf(studio.state.cats);
        if (!architect) return;
        enqueueWake({
          roomId: task.roomId,
          catId: architect.id,
          taskId: task.id,
          purpose: "nudge",
          trigger: {
            kind: "nudge",
            roomId: task.roomId,
            taskId: task.id,
            text: task.brief,
          },
        });
        return;
      }
    }
  }

  // ── 处理一个成员的一轮 ──────────────────────────────────

  async function processWake(wake: Wake): Promise<void> {
    const room = studio.getRoom(wake.roomId);
    const cat = studio.getCat(wake.catId);
    if (!room || !cat) return;

    const task = wake.taskId ? studio.getTask(wake.taskId) ?? null : null;
    const runtime = task ? runtimeFor(task.id) : null;
    if (task && task.status === "done" && wake.purpose !== "chat") return;
    if (task) clearStall(task.id);

    studio.setTyping(room.id, cat.id);
    try {
      const merged: AppliedTurns = {
        handoffs: [],
        review: null,
        lastArtifact: null,
        toolResults: [],
      };
      let trigger = wake.trigger;
      let rounds = 0;
      let consecutiveFailures = 0;

      // 首轮 + 最多 MAX_TOOL_ROUNDS 次「工具回执 → 再推理」的 ReAct 循环。
      // 工具轮本身不推进 stage；回喂轮里的 handoff/review/decision 会在循环结束后
      // 由 afterTurns 统一按正常 turn 处理。
      for (;;) {
        let turns: AgentTurn[] = [];
        // 本轮模型调用 id：产物要记「我是哪次调用写出来的」，用于任务轨迹里的溯源。
        let roundLlmCallId: string | undefined;
        try {
          await wait(THINK_DELAY_MS);
          const call = studio.startLlmCall({
            catId: cat.id,
            model: cat.llmModel?.trim() || "" ,
            engine: "api",
            ...(task ? { taskId: task.id } : {}),
            ...(task ? { stage: task.stage } : {}),
            trigger: trigger.kind,
          });
          roundLlmCallId = call.id;
          let report: BrainReport = {};
          const context = buildContext(cat, room, task, trigger, (update) => {
            // 只接受本房间的草稿，避免串台。
            if (update.roomId !== room.id) return;
            studio.setDraft(room.id, { catId: update.catId, text: update.text });
          });
          context.onReport = (next) => {
            report = { ...report, ...next };
          };
          try {
            turns = await brain.think(context);
          } finally {
            studio.finishLlmCall(call.id, {
              ...report,
              ...(report.model ? { model: report.model } : {}),
              ...(report.engine ? { engine: report.engine } : {}),
              turnKinds: turns.map((turn) => turn.kind),
            });
          }
        } catch (err) {
          console.error(`[engine] ${cat.id} 的 brain 调用失败，按空轮次继续：`, err);
        } finally {
          // 无论成功失败，这一轮结束后草稿都要清掉（正式消息已落库）。
          studio.setDraft(room.id, null);
        }

        // 巡查轮：只允许「说话」和「沉默」，交接/评审/决策/产物都属于 owner 的职责，
        // 这里在执行前就过滤掉，否则它们会真的落库并影响后续阶段。
        const effectiveTurns =
          wake.purpose === "patrol"
            ? turns.filter(
                (turn) =>
                  turn.kind === "message" || turn.kind === "silence" || turn.kind === "tool",
              )
            : turns;
        const applied = await applyTurns(room, cat, task, effectiveTurns, {
          ...(roundLlmCallId ? { llmCallId: roundLlmCallId } : {}),
          trigger: trigger.kind,
        });
        mergeApplied(merged, applied);

        const roundCap =
          task && (task.stage === "intake" || task.stage === "planning")
            ? MAX_EXPLORE_ROUNDS
            : MAX_TOOL_ROUNDS;
        consecutiveFailures = updateFailureStreak(consecutiveFailures, applied.toolResults);
        const canReact =
          brain.mode === "llm" &&
          applied.toolResults.length > 0 &&
          rounds < roundCap &&
          consecutiveFailures < MAX_CONSECUTIVE_TOOL_FAILURES;
        if (
          brain.mode === "llm" &&
          applied.toolResults.length > 0 &&
          consecutiveFailures >= MAX_CONSECUTIVE_TOOL_FAILURES
        ) {
          console.warn(
            `[engine] 工具连续失败 ${consecutiveFailures} 次（成员=${cat.id}），停止回喂，让模型基于已有信息收尾`,
          );
        }
        if (!canReact) break;

        rounds += 1;
        trigger = {
          kind: "tool_result",
          roomId: room.id,
          ...(task ? { taskId: task.id } : {}),
          toolResults: applied.toolResults,
        };
      }

      if (task && runtime) afterTurns(wake, room, cat, task, runtime, merged);
    } finally {
      studio.setTyping(room.id, null);
      if (task && task.status === "active") scheduleStall(task.id);
    }
  }

  // ── 把 AgentTurn[] 落库 ─────────────────────────────────

  async function applyTurns(
    room: Room,
    cat: Member,
    task: Task | null,
    turns: readonly AgentTurn[],
    /** 本轮来源：产物溯源用它记「哪次模型调用写的」。 */
    source?: { llmCallId?: string; trigger?: TriggerKind },
  ): Promise<AppliedTurns> {
    const applied: AppliedTurns = {
      handoffs: [],
      review: null,
      lastArtifact: null,
      toolResults: [],
    };

    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index]!;
      // silence 是"我不说话"的显式信号：不落消息、不加延迟。
      if (turn.kind === "silence") continue;
      await wait(turn.delayMs ?? TURN_DELAY_MS);

      // 提速：连续只读工具并行跑（模型常一轮发 4~6 个 read_file）。
      // 写文件 / 跑命令 / 需要审批的仍然串行，保证因果顺序与审批不打架。
      if (turn.kind === "tool" && isParallelizableTool(turn)) {
        const batch: ToolTurn[] = [turn];
        let next = index + 1;
        while (next < turns.length) {
          const candidate = turns[next];
          if (!candidate || candidate.kind !== "tool" || !isParallelizableTool(candidate)) break;
          batch.push(candidate);
          next += 1;
        }
        if (batch.length > 1) {
          const results = await Promise.all(
            batch.map((item) => runToolTurn(room, cat, task, item)),
          );
          for (const result of results) {
            if (result) applied.toolResults.push(result);
          }
          index = next - 1;
          continue;
        }
      }

      switch (turn.kind) {
        case "message": {
          studio.appendMessage({
            roomId: room.id,
            author: cat.id,
            kind: "chat",
            text: turn.text,
            mentions: normalizeMentions(turn.mentions, studio.state.cats),
            ...(task ? { taskId: task.id } : {}),
          });
          break;
        }

        case "tool": {
          const runResult = await runToolTurn(room, cat, task, turn);
          if (runResult) applied.toolResults.push(runResult);
          break;
        }

        case "handoff": {
          if (!task) {
            // 没有任务上下文时，交接降级成普通消息，避免脏数据。
            studio.appendMessage({
              roomId: room.id,
              author: cat.id,
              kind: "chat",
              text: turn.text ?? turn.card.what,
              mentions: handoffMentions(turn.to),
            });
            break;
          }
          const handoff = studio.addHandoff({
            taskId: task.id,
            from: cat.id,
            to: turn.to,
            card: turn.card,
          });
          studio.appendMessage({
            roomId: room.id,
            author: cat.id,
            kind: "handoff",
            // 漏 @ 时 mentions 仍写 [to]（本意是给它的），但下面不会唤醒它。
            text: turn.text ?? "交接",
            mentions: handoffMentions(turn.to),
            taskId: task.id,
            handoffId: handoff.id,
          });
          applied.handoffs.push({ turn, handoff });
          break;
        }

        case "artifact": {
          if (!task) {
            studio.appendMessage({
              roomId: room.id,
              author: cat.id,
              kind: "chat",
              text: turn.text ?? turn.artifact.title,
              mentions: normalizeMentions(turn.mentions, studio.state.cats),
            });
            break;
          }
          const artifact = studio.addArtifact({
            taskId: task.id,
            kind: turn.artifact.kind,
            title: turn.artifact.title,
            body: turn.artifact.body,
            author: cat.id,
            ...(source
              ? {
                  trace: {
                    stage: task.stage,
                    ...(source.llmCallId ? { llmCallId: source.llmCallId } : {}),
                    ...(source.trigger ? { trigger: source.trigger } : {}),
                  },
                }
              : {}),
          });
          studio.appendMessage({
            roomId: room.id,
            author: cat.id,
            kind: "artifact",
            text: turn.text ?? artifact.title,
            mentions: normalizeMentions(turn.mentions, studio.state.cats),
            taskId: task.id,
            artifactId: artifact.id,
          });
          applied.lastArtifact = artifact;
          break;
        }

        case "review": {
          if (!task) {
            studio.appendMessage({
              roomId: room.id,
              author: cat.id,
              kind: "chat",
              text: turn.text,
              mentions: normalizeMentions(turn.mentions, studio.state.cats),
            });
            break;
          }
          // 一次 think 只认第一个 review turn：否则「打回 + 通过」会在同一轮
          // 里互相覆盖，直接跳过 revise。
          if (applied.review) {
            console.warn(
              `[engine] ${cat.id} 同一轮返回了多个 review turn，只取第一个（${applied.review.verdict}），忽略 ${turn.verdict}。`,
            );
            break;
          }
          const artifact = studio.addArtifact({
            taskId: task.id,
            kind: "review",
            title: turn.title,
            body: formatReviewBody(turn.verdict, turn.findings),
            author: cat.id,
            ...(source
              ? {
                  trace: {
                    stage: task.stage,
                    ...(source.llmCallId ? { llmCallId: source.llmCallId } : {}),
                    ...(source.trigger ? { trigger: source.trigger } : {}),
                  },
                }
              : {}),
          });
          const mentions = normalizeMentions(turn.mentions, studio.state.cats);
          studio.appendMessage({
            roomId: room.id,
            author: cat.id,
            kind: "review",
            text: turn.text,
            mentions,
            taskId: task.id,
            artifactId: artifact.id,
          });
          applied.lastArtifact = artifact;
          applied.review = {
            verdict: turn.verdict,
            findings: turn.findings,
            mentions,
            text: turn.text,
            title: turn.title,
          };
          break;
        }

        case "decision": {
          if (!task) {
            studio.appendMessage({
              roomId: room.id,
              author: cat.id,
              kind: "chat",
              text: turn.text,
            });
            break;
          }
          const artifact = studio.addArtifact({
            taskId: task.id,
            kind: "decision",
            title: turn.artifact.title,
            body: turn.artifact.body,
            author: cat.id,
            ...(source
              ? {
                  trace: {
                    stage: task.stage,
                    ...(source.llmCallId ? { llmCallId: source.llmCallId } : {}),
                    ...(source.trigger ? { trigger: source.trigger } : {}),
                  },
                }
              : {}),
          });
          studio.appendMessage({
            roomId: room.id,
            author: cat.id,
            kind: "decision",
            text: turn.text,
            mentions: [],
            taskId: task.id,
            artifactId: artifact.id,
          });
          // 近似剧本：产物和消息照常落（演出要看得见），但**不写共享记忆**。
          // 剧本自带的决策/教训是给那个剧本写的，套到不相干的需求上会污染后续任务
          // 的上下文（实测：拿「记住我」剧本演「优化首页速度」，共享记忆里多出
          // 两条 token 过期策略，且 sourceTaskId 指向那条无关需求）。
          if (!task.scenarioFallback) {
            for (const entry of turn.memory) {
              studio.addMemory({
                kind: entry.kind,
                title: entry.title,
                body: entry.body,
                tags: entry.tags,
                sourceTaskId: task.id,
              });
            }
          }
          applied.lastArtifact = artifact;
          break;
        }

        case "memory": {
          // 近似剧本里写的记忆同样不可信：只保留对话，不落共享记忆。
          if (!task?.scenarioFallback) {
            studio.addMemory({
              kind: turn.memory.kind,
              title: turn.memory.title,
              body: turn.memory.body,
              tags: turn.memory.tags,
              ...(task ? { sourceTaskId: task.id } : {}),
            });
          }
          studio.appendMessage({
            roomId: room.id,
            author: cat.id,
            kind: turn.memory.kind === "decision" ? "decision" : "chat",
            text: turn.text,
            mentions: [],
            ...(task ? { taskId: task.id } : {}),
          });
          break;
        }
      }
    }

    return applied;
  }

  /** 把回喂轮次的产出合并到整轮结果里（handoff 全留，review 取第一个）。 */
  function mergeApplied(target: AppliedTurns, source: AppliedTurns): void {
    target.handoffs.push(...source.handoffs);
    target.toolResults.push(...source.toolResults);
    if (!target.review && source.review) target.review = source.review;
    if (source.lastArtifact) target.lastArtifact = source.lastArtifact;
  }

  // ── tool turn：真在沙盒里执行 ─────────────────────────

  async function runToolTurn(
    room: Room,
    cat: Member,
    task: Task | null,
    turn: ToolTurn,
  ): Promise<ToolRunResult | null> {
    const taskField = task ? { taskId: task.id } : {};

    // 1) 设置面板关掉工具：不执行，只留一句说明。
    if (!toolsAllowed()) {
      studio.appendMessage({
        roomId: room.id,
        author: cat.id,
        kind: "chat",
        text: "工具执行被关掉了，我先把方案写在产物里。",
        mentions: [],
        ...taskField,
      });
      return null;
    }

    const runner = executorFor(room.id, turn.tool);

    // 2) 没接注册表 / 沙盒（测试 / 降级模式）：同样只说明，不报错。
    if (!runner) {
      studio.appendMessage({
        roomId: room.id,
        author: cat.id,
        kind: "chat",
        text: "这边没接沙盒，我先把要做的写清楚。",
        mentions: [],
        ...taskField,
      });
      return null;
    }

    const definition = tools?.get(turn.tool);
    const label = toolLabelFor(turn, definition);

    // 3) 按成员权限：未授权工具不执行，error 记账并回喂给模型，流程继续。
    if (!toolAllowed(cat, turn.tool)) {
      const denied: ToolResult = {
        status: "error",
        output: `${cat.name} 没有权限使用 ${turn.tool}`,
      };
      const call = studio.addToolCall({
        catId: cat.id,
        tool: turn.tool,
        args: turn.input,
        label,
        ...taskField,
      });
      studio.finishToolCall(call.id, denied);
      appendToolMessage(room, cat, task, turn, call.id, denied, definition, denied.output);
      return toRunResult(call.id, turn.tool, denied);
    }

    const approval = approvalFor(turn.tool);

    // 4a) 模型发起 + 命中审批策略：先挂 pending，等负责人决定。
    if (approval) {
      const call = studio.addToolCall({
        catId: cat.id,
        tool: turn.tool,
        args: turn.input,
        label,
        status: "pending",
        ...taskField,
      });
      studio.appendMessage({
        roomId: room.id,
        author: cat.id,
        kind: "tool",
        text: `等你批准：${label}`,
        mentions: [],
        toolCallId: call.id,
        ...taskField,
      });

      let approved = false;
      try {
        const decision = await approvals!.request({
          callId: call.id,
          mode: approval,
          tool: turn.tool,
          label,
          catId: cat.id,
        });
        approved = decision === "approved";
      } catch (err) {
        // 审批流程异常也按拒绝处理（不放行），流程不断。
        console.warn("[engine] 审批请求失败，按拒绝处理：", err);
      }

      if (!approved) {
        const rejected: ToolResult = {
          status: "rejected",
          output: "负责人拒绝了这次执行",
        };
        studio.finishToolCall(call.id, rejected);
        appendToolMessage(
          room,
          cat,
          task,
          turn,
          call.id,
          rejected,
          definition,
          "负责人拒绝了这次执行，我换个办法。",
        );
        return toRunResult(call.id, turn.tool, rejected);
      }

      studio.startToolCall(call.id);
      const result = await executeSafely(runner, turn);
      studio.finishToolCall(call.id, result);
      appendToolMessage(room, cat, task, turn, call.id, result, definition);
      return toRunResult(call.id, turn.tool, result);
    }

    // 4b) 自动放行（mock 剧本 / mode=auto / risk=safe 的工具）。
    const call = studio.addToolCall({
      catId: cat.id,
      tool: turn.tool,
      args: turn.input,
      label,
      ...taskField,
    });

    const result = await executeSafely(runner, turn);
    studio.finishToolCall(call.id, result);
    appendToolMessage(room, cat, task, turn, call.id, result, definition);
    return toRunResult(call.id, turn.tool, result);
  }

  function appendToolMessage(
    room: Room,
    cat: Member,
    task: Task | null,
    turn: ToolTurn,
    callId: string,
    result: ToolResult,
    definition?: ToolDefinition,
    fallbackText?: string,
  ): void {
    studio.appendMessage({
      roomId: room.id,
      author: cat.id,
      kind: "tool",
      text: turn.text ?? fallbackText ?? toolTextFor(turn, definition, result),
      mentions: normalizeMentions(turn.mentions, studio.state.cats),
      toolCallId: callId,
      ...(task ? { taskId: task.id } : {}),
    });
  }

  // ── 一轮结束后的路由 / 状态推进 ───────────────────────

  /**
   * 任务收尾时，给「参与过的每个成员」各记一条经历。
   *
   * 参与判定：在该任务里发过消息 / 产物 / 交接 / 评审的成员。
   * 摘要是从这个成员自己的产出里提取，不编造。
   */
  function recordTaskEpisodes(task: Task, outcome: "done" | "abandoned"): void {
    const involved = new Set<MemberId>();
    for (const message of studio.state.messages) {
      if (message.taskId === task.id && message.author !== "user" && message.author !== "system") {
        involved.add(message.author);
      }
    }
    for (const artifact of studio.state.artifacts) {
      if (artifact.taskId === task.id) involved.add(artifact.author);
    }
    for (const handoff of studio.state.handoffs) {
      if (handoff.taskId === task.id) {
        involved.add(handoff.from);
        involved.add(handoff.to);
      }
    }

    for (const catId of involved) {
      const mine = studio.state.messages
        .filter((m) => m.taskId === task.id && m.author === catId && m.kind !== "tool")
        .slice(-2)
        .map((m) => m.text.replace(/\s+/g, " ").slice(0, 90));
      const produced = studio.state.artifacts
        .filter((a) => a.taskId === task.id && a.author === catId)
        .map((a) => `${a.kind}「${a.title}」`);
      const pieces = [...produced.slice(0, 2), ...mine].filter(Boolean);
      studio.recordEpisode({
        catId,
        taskId: task.id,
        title: task.title,
        summary: pieces.join("；") || "（参与了该任务）",
        outcome,
      });
    }
  }

  function afterTurns(
    wake: Wake,
    room: Room,
    cat: Member,
    task: Task,
    runtime: TaskRuntime,
    applied: AppliedTurns,
  ): void {
    routeHandoffs(task, runtime, applied.handoffs);

    switch (wake.purpose) {
      case "kickoff": {
        studio.finishStep(task.id, "intake");
        const emittedHandoff = applied.handoffs.length > 0;
        if (!emittedHandoff && task.stage === "intake" && task.status !== "stalled") {
          beginStage(task, "planning", cat.id);
          enqueueWake({
            roomId: room.id,
            catId: cat.id,
            taskId: task.id,
            purpose: "planning",
            trigger: {
              kind: "task_created",
              roomId: room.id,
              taskId: task.id,
              text: task.brief,
            },
          });
        }
        return;
      }

      case "planning": {
        // 交接已在 routeHandoffs 里投递；没交接就停在 planning，
        // 由 stall watchdog 标「卡住了」，等负责人介入。
        return;
      }

      case "patrol": {
        // 巡查只允许「说话」，不允许推进阶段或发交接卡（那是 owner 的职责）。
        // 如果模型在巡查轮里给了 handoff/review/decision，忽略掉，只保留消息。
        return;
      }

      case "worker": {
        runtime.workers = Math.max(0, runtime.workers - 1);
        if (runtime.workers === 0 && task.status === "active") {
          requestReview(task, runtime, applied.lastArtifact);
        }
        return;
      }

      case "reviewer": {
        if (!applied.review) return;
        const move = reviewMove(
          studio.state.cats,
          applied.review.verdict,
          applied.review.mentions,
          taskArtifacts(task.id),
        );
        if (!move) return;
        beginStage(task, move.stage, move.cat.id);

        const reviewTrigger: Trigger = {
          kind: "review_result",
          roomId: room.id,
          taskId: task.id,
          text: applied.review.text,
          fromMemberId: cat.id,
          review: {
            verdict: applied.review.verdict,
            findings: applied.review.findings,
          },
        };

        if (move.stage === "revising") {
          runtime.revisions += 1;
          if (runtime.revisions > MAX_REVISION_ROUNDS) {
            // 到轮数上限：强制收尾，把「没改完」记成教训，而不是无限拉锯。
            studio.addMemory({
              kind: "lesson",
              title: "评审反复打回时先收敛，不要无限修订",
              body:
                `任务「${task.title}」在 ${MAX_REVISION_ROUNDS} 轮修订后仍未通过评审，` +
                `最后一轮意见：${applied.review.text.slice(0, 200)}`,
              tags: ["review-loop", "process"],
              sourceTaskId: task.id,
            });
            // 收尾不是"结束"，是"交货"。告诉负责人：拿到了什么、还差什么。
            const delivery = studio.deliverySummary(task.id);
            const artifactLine =
              delivery.artifacts.length > 0
                ? `已交付 ${delivery.artifacts.length} 个产物：${delivery.artifacts
                    .slice(-4)
                    .map((item) => `${item.kind}「${item.title}」`)
                    .join("、")}`
                : "这次没有产出可用产物。";
            const blockerLine =
              delivery.blockers.length > 0
                ? `仍有 ${delivery.blockers.length} 条 blocker 未清：\n` +
                  delivery.blockers.map((item, index) => `  ${index + 1}. ${item}`).join("\n")
                : "评审没有留下 blocker。";
            studio.appendMessage({
              roomId: room.id,
              author: cat.id,
              kind: "system",
              text:
                `已经修订 ${MAX_REVISION_ROUNDS} 轮仍未通过，我先收口。\n\n` +
                `${artifactLine}\n\n${blockerLine}\n\n` +
                `要继续的话，点「继续试试」；想换方向，点「换个方案」。`,
              mentions: [],
              taskId: task.id,
            });
            beginStage(task, "done", architectOf(studio.state.cats)?.id ?? cat.id);
            studio.finishStep(task.id, "done");
            studio.setTaskStatus(task.id, "done");
            clearStall(task.id);
            studio.ensureTaskMemory(task.id);
            recordTaskEpisodes(task, "abandoned");
            return;
          }
          runtime.workers += 1;
          enqueueWake({
            roomId: room.id,
            catId: move.cat.id,
            taskId: task.id,
            purpose: "worker",
            trigger: reviewTrigger,
          });
        } else {
          enqueueWake({
            roomId: room.id,
            catId: move.cat.id,
            taskId: task.id,
            purpose: "decision",
            trigger: reviewTrigger,
          });
        }
        return;
      }

      case "decision": {
        if (!studio.getTask(task.id)) return;
        studio.finishStep(task.id, "done");
        studio.setTaskStatus(task.id, "done");
        clearStall(task.id);
        // 记忆不依赖模型自觉：模型没给 memory 时，系统兜底写一条任务摘要。
        studio.ensureTaskMemory(task.id);
        recordTaskEpisodes(task, "done");
        return;
      }

      case "nudge": {
        // 催一下 = 恢复：先解除 stalled，architect 已说过恢复台词；
        // 若有漏 @ 的交接，再补投递给接收方。
        if (task.status === "stalled") studio.setTaskStatus(task.id, "active");
        if (!runtime.missed) return;
        const missed = runtime.missed;
        runtime.missed = null;
        deliverMissed(task, runtime, missed);
        return;
      }

      case "chat": {
        return;
      }
    }
  }

  // ── 路由：交接 → 唤醒谁 / 进哪个阶段 ──────────────────

  function routeHandoffs(
    task: Task,
    runtime: TaskRuntime,
    deliveries: readonly { turn: HandoffTurn; handoff: Handoff }[],
  ): void {
    // 任务已经收尾就不要再派活：实测真实模型在 done 之后仍会发交接卡，
    // 那些交接会把步骤重新打开（stage 回退到 working），任务状态却还是 done，
    // 留下"stage=working / status=done"的不一致状态。
    if (task.status === "done") return;
    for (const { turn, handoff } of deliveries) {
      const target = studio.getCat(turn.to);
      if (!target) continue;

      // 埋点：漏 @。写卡片/消息已在 applyTurns 完成；这里只标 stalled + 记账。
      if (turn.fault === "missed_mention") {
        studio.setTaskStatus(task.id, "stalled");
        runtime.missed = {
          handoffId: handoff.id,
          from: handoff.from,
          to: handoff.to,
          card: handoff.card,
          targetStage: handoffMove(task.stage, target).stage,
          ...(turn.text ? { text: turn.text } : {}),
        };
        continue;
      }

      const move = handoffMove(task.stage, target);

      if (move.stage === "reviewing") {
        const reviewerWake: Wake = {
          roomId: task.roomId,
          catId: target.id,
          taskId: task.id,
          purpose: "reviewer",
          trigger: {
            kind: "handoff",
            roomId: task.roomId,
            taskId: task.id,
            fromMemberId: handoff.from,
            handoff: turn.card,
            ...(turn.text ? { text: turn.text } : {}),
          },
        };
        // 还有 worker 没跑完时先存着，等最后一个 worker 结束再进 reviewing。
        if (runtime.workers > 0) {
          runtime.deferredReviewer ??= reviewerWake;
          continue;
        }
        beginStage(task, "reviewing", target.id);
        enqueueWake(reviewerWake);
        continue;
      }

      beginStage(task, move.stage, target.id);
      runtime.workers += 1;
      enqueueWake({
        roomId: task.roomId,
        catId: target.id,
        taskId: task.id,
        purpose: "worker",
        trigger: {
          kind: "handoff",
          roomId: task.roomId,
          taskId: task.id,
          fromMemberId: handoff.from,
          handoff: turn.card,
          ...(turn.text ? { text: turn.text } : {}),
        },
      });
    }
  }

  /**
   * 所有 worker 都跑完后进入 reviewing。
   * **漏 @ 卡住时不自动推进**：必须等 nudge 补投递。
   */
  function requestReview(
    task: Task,
    runtime: TaskRuntime,
    lastArtifact: Artifact | null,
  ): void {
    if (task.status !== "active") return;
    if (runtime.missed) return;
    if (task.stage === "reviewing" || task.stage === "done") return;

    const reviewer = runtime.deferredReviewer
      ? studio.getCat(runtime.deferredReviewer.catId)
      : findByRole(studio.state.cats, "reviewer");
    if (!reviewer) return;

    beginStage(task, "reviewing", reviewer.id);

    const deferred = runtime.deferredReviewer;
    runtime.deferredReviewer = null;
    if (deferred) {
      enqueueWake({ ...deferred, purpose: "reviewer" });
      return;
    }
    enqueueWake({
      roomId: task.roomId,
      catId: reviewer.id,
      taskId: task.id,
      purpose: "reviewer",
      trigger: artifactTrigger(task, lastArtifact),
    });
  }

  function deliverMissed(
    task: Task,
    runtime: TaskRuntime,
    missed: MissedDelivery,
  ): void {
    const target = studio.getCat(missed.to);
    if (!target) return;

    beginStage(task, missed.targetStage, target.id);
    const trigger: Trigger = {
      kind: "handoff",
      roomId: task.roomId,
      taskId: task.id,
      fromMemberId: missed.from,
      handoff: missed.card,
      ...(missed.text ? { text: missed.text } : {}),
    };

    if (missed.targetStage === "reviewing") {
      runtime.deferredReviewer = null;
      enqueueWake({
        roomId: task.roomId,
        catId: target.id,
        taskId: task.id,
        purpose: "reviewer",
        trigger,
      });
      return;
    }

    runtime.workers += 1;
    enqueueWake({
      roomId: task.roomId,
      catId: target.id,
      taskId: task.id,
      purpose: "worker",
      trigger,
    });
  }

  function artifactTrigger(task: Task, artifact: Artifact | null): Trigger {
    const trigger: Trigger = {
      kind: "artifact",
      roomId: task.roomId,
      taskId: task.id,
    };
    if (artifact) {
      trigger.text = artifact.title;
      trigger.artifact = artifact;
      trigger.fromMemberId = artifact.author;
    }
    return trigger;
  }

  // ── 阶段 / step / owner ───────────────────────────────

  function beginStage(task: Task, stage: TaskStage, owner: MemberId): void {
    // 任务可能已经被「重置交付台」删掉，而队列里还残留着旧 wake：
    // 这种情况安静跳过，不要让一个已删除的任务把整条队列打断。
    if (!studio.getTask(task.id)) return;
    if (task.stage === stage) return;
    studio.finishStep(task.id, task.stage);
    studio.updateTaskStage(task.id, stage, owner);
    studio.addStep(task.id, { stage, owner });
  }

  function ensureStep(task: Task): void {
    const hasActive = task.steps.some(
      (step) => step.stage === task.stage && step.status === "active",
    );
    if (!hasActive) studio.addStep(task.id, { stage: task.stage, owner: task.owner });
  }

  // ── 主动巡查 ──────────────────────────────────────────

  /**
   * 主动协作：让「没被 @ 的成员」也有机会说话。
   *
   * 设计要点（为什么不是简单的定时器）：
   * 1. 只在有活跃任务的房间里巡查——房间里没活时让成员说话等于噪音；
   * 2. 每轮只挑一个成员，且**不是当前 owner**（owner 本来就在动）；
   * 3. 给成员一个明确的「你可以不说话」的出口（silence turn），
   *    这样"沉默"也是可审计的决策，而不是模型随口附和；
   * 4. 巡查产生的消息必须带 trigger.kind = "proactive"，便于前端和 trace 区分。
   */
  let patrolTimer: ReturnType<typeof setInterval> | null = null;
  let patrolIntervalMs = 60_000;
  let patrolling = false;
  /** 每个成员上次巡查的时间，避免同一个成员连续被点名。 */
  const lastPatrolAt = new Map<MemberId, number>();

  function setProactive(enabled: boolean, intervalMs?: number): void {
    if (intervalMs && intervalMs > 0) patrolIntervalMs = intervalMs;
    if (patrolTimer) {
      clearInterval(patrolTimer);
      patrolTimer = null;
    }
    if (!enabled) return;
    patrolTimer = setInterval(() => {
      void patrolOnce();
    }, patrolIntervalMs);
    patrolTimer.unref?.();
  }

  /** 手动触发一次巡查（测试 / 调试 / 「让团队看看现在有什么事」按钮）。 */
  async function patrol(): Promise<void> {
    // 只负责把巡查任务排进队列，不等待执行完成：
    // 任务还在跑时，巡查本来就该排在它后面，等它跑完 API 才返回会让前端以为卡死。
    await patrolOnce();
  }

  /** 挑一个「有活跃任务的房间 + 一个最该说话的成员」，让它判断要不要插话。 */
  async function patrolOnce(): Promise<void> {
    if (patrolling) return;
    patrolling = true;
    try {
      const activeTasks = studio.state.tasks.filter((task) => task.status === "active");
      if (activeTasks.length === 0) return;

      for (const task of activeTasks) {
        const room = studio.getRoom(task.roomId);
        if (!room) continue;
        const candidate = pickPatrolCat(task, room);
        if (!candidate) continue;

        lastPatrolAt.set(candidate.id, Date.now());
        // 排进房间队列即可，不阻塞调用方。
        void enqueue(task.roomId, async () => {
          const watcher = candidate;
          await processWake({
            roomId: task.roomId,
            catId: watcher.id,
            taskId: task.id,
            purpose: "patrol",
            trigger: {
              kind: "proactive",
              roomId: task.roomId,
              taskId: task.id,
              text: `当前任务进行到「${task.stage}」阶段，你在旁边观察。如果你有要补充的、要质疑的，或者发现别人漏了东西，现在说；不需要就保持安静。`,
            },
          });
        });
      }
    } finally {
      patrolling = false;
    }
  }

  /** 挑巡查成员：非 owner、最近没巡查过、优先 reviewer（它有质疑职责）。 */
  function pickPatrolCat(task: Task, room: Room): Member | null {
    const now = Date.now();
    const candidates = studio.state.cats
      .filter((cat) => room.catIds.includes(cat.id))
      .filter((cat) => cat.id !== task.owner)
      .filter((cat) => now - (lastPatrolAt.get(cat.id) ?? 0) >= patrolIntervalMs)
      // reviewer 优先：它的职责就是挑问题
      .sort((a, b) => {
        const rank = (cat: Member): number => (cat.role === "reviewer" ? 0 : cat.role === "architect" ? 1 : 2);
        return rank(a) - rank(b);
      });
    return candidates[0] ?? null;
  }

  // ── stall watchdog ────────────────────────────────────

  /**
   * 判断任务是否「正在进行中」（只是慢，不是卡住）。
   *
   * 返回忙碌原因；返回 null 表示确实没有任何进展 → 可以判卡住。
   *
   * 为什么需要这么多条件：真实用户场景里，"慢"的形态很多——
   * 模型在想、工具在跑、等负责人批、巡查在排队、别的任务占着房间队列。
   * 少排除任何一条，用户都会看到假的"卡住了"并去干预正常流程。
   */
  function busyReason(taskId: TaskId, roomId: RoomId): string | null {
    // 1) 房间队列里还有活（要么是这个任务自己的 wake 在排队，要么别的任务占着）。
    if ((roomPending.get(roomId) ?? 0) > 0) return "排队中";

    // 2) 有一次模型调用还在进行（推理模型单轮可能 20~60 秒）。
    const llmInFlight = studio.state.llmCalls.some(
      (call) => call.taskId === taskId && !call.finishedAt,
    );
    if (llmInFlight) return "模型思考中";

    // 3) 有工具正在执行（跑测试可能几十秒）。
    const toolRunning = studio.state.toolCalls.some(
      (call) => call.taskId === taskId && call.status === "running",
    );
    if (toolRunning) return "工具执行中";

    // 4) 有工具在等负责人批准（人可能在开会，不该算成员卡住）。
    const toolPending = studio.state.toolCalls.some(
      (call) =>
        call.taskId === taskId &&
        call.status === "pending" &&
        call.approvalRequestedAt !== undefined &&
        call.approvalDecidedAt === undefined,
    );
    if (toolPending) return "等待审批";

    return null;
  }

  function scheduleStall(taskId: TaskId): void {
    const task = studio.getTask(taskId);
    if (!task || task.status !== "active") return;
    const runtime = runtimeFor(taskId);
    clearStall(taskId);
    runtime.stallTimer = setTimeout(() => {
      runtime.stallTimer = null;
      const current = studio.getTask(taskId);
      if (!current || current.status !== "active") return;

      // 判定「卡住」的唯一依据：这个任务确实没有任何事情在进行中。
      // 任何一条 busyReason 成立都说明它在动，只是慢——重新计时而不是报卡住。
      const busy = busyReason(taskId, current.roomId);
      if (busy) {
        runtime.lastBusyReason = busy;
        // 排队中/正在思考/工具在跑都不算卡住，静默重新计时。
        scheduleStall(taskId);
        return;
      }
      studio.setTaskStatus(taskId, "stalled");
      // 同一个任务只打一次"暂停推进"系统消息，避免反复计时导致刷屏。
      const alreadyNotified = studio.state.messages.some(
        (m) => m.taskId === taskId && m.kind === "system" && m.text.startsWith("任务暂停推进"),
      );
      if (alreadyNotified) return;
      const last = runtime.lastBusyReason;
      studio.appendMessage({
        roomId: current.roomId,
        author: "system",
        kind: "system",
        text: last
          ? `任务暂停推进（${stallMs}ms 没有任何动作）。最后观察到的活动：${last}。`
          : `任务暂停推进（${stallMs}ms 没有任何动作，也没有排队/思考/工具在执行）。`,
        mentions: [],
        taskId,
      });
    }, stallMs);
    runtime.stallTimer.unref?.();
  }

  function clearStall(taskId: TaskId): void {
    const runtime = runtimes.get(taskId);
    if (!runtime?.stallTimer) return;
    clearTimeout(runtime.stallTimer);
    runtime.stallTimer = null;
  }

  // ── 小工具 ────────────────────────────────────────────

  function runtimeFor(taskId: TaskId): TaskRuntime {
    let runtime = runtimes.get(taskId);
    if (!runtime) {
      runtime = {
        workers: 0,
        deferredReviewer: null,
        missed: null,
        stallTimer: null,
        revisions: 0,
        lastBusyReason: null,
      };
      runtimes.set(taskId, runtime);
    }
    return runtime;
  }

  function buildContext(
    cat: Member,
    room: Room,
    task: Task | null,
    trigger: Trigger,
    onDelta?: (update: { catId: MemberId; roomId: RoomId; text: string }) => void,
  ): TurnContext {
    return {
      cat,
      room,
      task,
      trigger,
      recentMessages: studio.recentMessages(room.id, 24),
      memory: studio.memoryForTask(task),
      handoffs: task ? studio.state.handoffs.filter((h) => h.taskId === task.id) : [],
      artifacts: task ? studio.state.artifacts.filter((a) => a.taskId === task.id) : [],
      recentToolResults: recentToolResults(task),
      availableTools: availableToolsFor(cat),
      skills: resolveSkillsForCat(cat),
      session: studio.sessionFor(cat.id),
      roomCats: studio.state.cats
        .filter((peer) => room.catIds.includes(peer.id))
        .map((peer) => ({ id: peer.id, name: peer.name, role: peer.role })),
      ...(onDelta ? { onDelta } : {}),
      scenario: task
        ? SCENARIOS.find((scenario) => scenario.id === task.scenarioId) ?? null
        : null,
    };
  }

  /** 可用工具：注册表全集按 cat.tools 过滤（undefined = 全部，[] = 一个都没有）。 */
  function availableToolsFor(cat: Member): ToolDefinition[] {
    const all = tools?.list() ?? [];
    if (!cat.tools) return all;
    const allowed = new Set(cat.tools);
    return all.filter((definition) => allowed.has(definition.name));
  }

  /** 按成员工具权限：undefined = 全部允许；数组（含空数组）= 白名单。 */
  function toolAllowed(cat: Member, tool: ToolName): boolean {
    if (!cat.tools) return true;
    return cat.tools.includes(tool);
  }

  /**
   * 按成员技能包：内置技能表 skillsForCat() 为主；
   * 注入了 resolveSkill 时，再用它补 cat.skills 里的自定义技能。
   */
  function resolveSkillsForCat(cat: Member): Skill[] {
    const builtin = skillsForCat(cat);
    if (!resolveSkill) return builtin;
    const skills = [...builtin];
    const seen = new Set(skills.map((skill) => skill.id));
    for (const id of cat.skills ?? []) {
      if (seen.has(id)) continue;
      const skill = resolveSkill(id);
      if (!skill) continue;
      seen.add(id);
      skills.push(skill);
    }
    return skills;
  }

  function taskArtifacts(taskId: TaskId): Artifact[] {
    return studio.state.artifacts.filter((artifact) => artifact.taskId === taskId);
  }

  /** 房间里正在跑的任务（active 或 stalled 都算"占着房间"）。 */
  function activeTaskIn(roomId: RoomId): Task | null {
    const tasks = studio.state.tasks;
    for (let i = tasks.length - 1; i >= 0; i -= 1) {
      const task = tasks[i];
      if (task && task.roomId === roomId && task.status !== "done") return task;
    }
    return null;
  }

  function latestTask(roomId: RoomId): Task | null {
    const tasks = studio.state.tasks;
    for (let i = tasks.length - 1; i >= 0; i -= 1) {
      const task = tasks[i];
      if (task && task.roomId === roomId) return task;
    }
    return null;
  }

  function roomCats(room: Room): Member[] {
    const cats: Member[] = [];
    for (const id of room.catIds) {
      const cat = studio.getCat(id);
      if (cat) cats.push(cat);
    }
    return cats;
  }

  /** 工具总开关：未注入视为开启；getter 异常时保守关闭。 */
  function toolsAllowed(): boolean {
    if (!toolsEnabled) return true;
    try {
      return toolsEnabled() !== false;
    } catch (err) {
      console.warn("[engine] toolsEnabled() 读取失败，按关闭处理：", err);
      return false;
    }
  }

  /**
   * 这次工具调用要不要审批？
   * 只对模型驱动的调用生效（brain.mode === "llm" 且有 ApprovalGate）；
   * mock 剧本里的工具永远自动放行。
   */
  function approvalFor(tool: ToolName): ToolApprovalMode | null {
    if (brain.mode !== "llm" || !approvals) return null;
    const mode = readApprovalMode();
    if (mode === "auto") return null;
    if (mode === "all") return "all";
    // commands：风险优先看注册表 ToolDefinition.risk；没有注册表时按
    // run_command 需审批（保持旧行为）、其他工具 safe 兜底。
    const definition = tools?.get(tool);
    const risk =
      definition?.risk ?? (tool === "run_command" ? "needs_approval" : "safe");
    return risk === "needs_approval" ? "commands" : null;
  }

  function readApprovalMode(): ToolApprovalMode {
    if (!approvalMode) return "auto";
    try {
      return approvalMode();
    } catch (err) {
      console.warn("[engine] approvalMode() 读取失败，按 auto 处理：", err);
      return "auto";
    }
  }

  /** recentToolResults：本任务最近 8 条已结束（ok/error/rejected）的工具回执，时间正序。 */
  function recentToolResults(task: Task | null): ToolRunResult[] {
    const calls = studio.state.toolCalls;
    const picked: ToolRunResult[] = [];
    for (let i = calls.length - 1; i >= 0 && picked.length < RECENT_TOOL_RESULTS; i -= 1) {
      const call = calls[i];
      if (!call) continue;
      if (task && call.taskId !== task.id) continue;
      if (call.status === "pending" || call.status === "running") continue;
      picked.push(
        toRunResult(call.id, call.tool, {
          status: call.status,
          output: call.output ?? "",
          ...(call.exitCode !== undefined ? { exitCode: call.exitCode } : {}),
        }),
      );
    }
    picked.reverse();
    return picked;
  }

  return {
    setProactive,
    patrol,
    submit,
    whenIdle(): Promise<void> {
      if (pending === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
    stallMs,
  };
}
