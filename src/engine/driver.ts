/**
 * 协作引擎（T1）：每房间串行队列 + 阶段状态机 + @路由 + 延迟调度 + 故障恢复。
 *
 * 职责边界：
 *   - driver 只负责调度、路由、状态推进、落库；
 *   - 台词全部来自注入的 CatBrain（mock / llm），driver 不写死任何剧情文本。
 *
 * 关键约定：
 *   - 外部事件 submit() 不阻塞，进房间串行队列；whenIdle() 等整条链跑完。
 *   - 所有状态改动都走 Studio 的 mutator，不直接改字段。
 *   - 交接 turn 只路由给 handoff.to；用户消息只唤醒 mentions（无 @ 时 owner）。
 *   - handoff.fault === "missed_mention"：卡片 / 消息照写（mentions 仍写 [to]），
 *     但不唤醒接收猫、任务标 stalled；等 nudge 补投递后才进下一阶段。
 *   - tool turn：走 studio.addToolCall → sandbox.execute → finishToolCall →
 *     appendMessage(kind:"tool")；不改阶段、不触发 handoff，失败也不抛异常。
 *   - 审批：仅 brain.mode === "llm" 且注入 approvals 时生效；pending → request →
 *     拒绝则不执行（rejected 也回喂），批准后 startToolCall 再执行。
 *   - ReAct：llm 模式下本轮有工具回执时，用 Trigger{kind:"tool_result"} 再问同一只猫，
 *     最多 MAX_TOOL_ROUNDS 轮；回喂轮不改 stage。
 */

import { SCENARIOS } from "../agents/personas.ts";
import type {
  ApprovalGate,
  Artifact,
  Cat,
  CatBrain,
  CatId,
  CatTurn,
  Driver,
  EngineEvent,
  Handoff,
  HandoffCard,
  ReviewFinding,
  ReviewVerdict,
  Room,
  RoomId,
  SandboxRunner,
  Task,
  TaskId,
  TaskStage,
  ToolApprovalMode,
  ToolName,
  ToolResult,
  ToolRunResult,
  Trigger,
  TurnContext,
} from "../domain/types.ts";
import type { Studio } from "../server/studio.ts";
import { handoffMentions, normalizeMentions, routeUserMessage } from "./mentions.ts";
import {
  architectOf,
  findByRole,
  formatReviewBody,
  handoffMove,
  reviewMove,
} from "./stages.ts";

const DEFAULT_STALL_MS = 12_000;
/** 猫「开始打字 → 想好」的基础延迟。 */
const THINK_DELAY_MS = 600;
/** 一个 turn 与下一个 turn 之间的默认间隔。 */
const TURN_DELAY_MS = 220;
/** 真实模式下工具回执 → 再推理的最大回喂轮数（不含首轮）。 */
const MAX_TOOL_ROUNDS = 3;
/** TurnContext.recentToolResults 保留的最近条数。 */
const RECENT_TOOL_RESULTS = 8;

type TurnOf<K extends CatTurn["kind"]> = Extract<CatTurn, { kind: K }>;
type HandoffTurn = TurnOf<"handoff">;
type ToolTurn = TurnOf<"tool">;

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

/** 执行工具；SandboxRunner 约定不抛，注入实现万一抛了也记成 error。 */
async function executeSafely(runner: SandboxRunner, turn: ToolTurn): Promise<ToolResult> {
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
  | "worker"
  | "reviewer"
  | "decision"
  | "nudge"
  | "chat";

/** 一次待执行的「让某只猫想一轮」。 */
interface Wake {
  roomId: RoomId;
  catId: CatId;
  taskId?: TaskId;
  purpose: WakePurpose;
  trigger: Trigger;
}

/** 被漏 @ 卡住、等待 nudge 补投递的交接。 */
interface MissedDelivery {
  handoffId: string;
  from: CatId;
  to: CatId;
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
}

interface ReviewApplied {
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  mentions: CatId[];
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
  brain: CatBrain;
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
}): Driver {
  const { studio, brain, sandbox, approvals } = deps;
  const toolsEnabled = deps.toolsEnabled;
  const approvalMode = deps.approvalMode;
  const wait =
    deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stallMs = deps.stallMs ?? DEFAULT_STALL_MS;

  /** roomId → 该房间队列尾部。 */
  const queues = new Map<RoomId, Promise<void>>();
  const runtimes = new Map<TaskId, TaskRuntime>();
  const idleWaiters: Array<() => void> = [];
  /** 未完成的队列任务数（含正在跑的和已排队但还没跑的）。 */
  let pending = 0;

  // ── 串行队列 ──────────────────────────────────────────

  function enqueue(roomId: RoomId, job: () => Promise<void>): void {
    pending += 1;
    const previous = queues.get(roomId) ?? Promise.resolve();
    const next = previous
      .then(job)
      .catch((err: unknown) => {
        console.error("[engine] 轮次处理失败：", err);
      })
      .finally(() => {
        pending -= 1;
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
        const task = latestTask(event.roomId);
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

  // ── 处理一只猫的一轮 ──────────────────────────────────

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

      // 首轮 + 最多 MAX_TOOL_ROUNDS 次「工具回执 → 再推理」的 ReAct 循环。
      // 工具轮本身不推进 stage；回喂轮里的 handoff/review/decision 会在循环结束后
      // 由 afterTurns 统一按正常 turn 处理。
      for (;;) {
        let turns: CatTurn[] = [];
        try {
          await wait(THINK_DELAY_MS);
          turns = await brain.think(buildContext(cat, room, task, trigger));
        } catch (err) {
          console.error(`[engine] ${cat.id} 的 brain 调用失败，按空轮次继续：`, err);
        }

        const applied = await applyTurns(room, cat, task, turns);
        mergeApplied(merged, applied);

        const canReact =
          brain.mode === "llm" &&
          applied.toolResults.length > 0 &&
          rounds < MAX_TOOL_ROUNDS;
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

  // ── 把 CatTurn[] 落库 ─────────────────────────────────

  async function applyTurns(
    room: Room,
    cat: Cat,
    task: Task | null,
    turns: readonly CatTurn[],
  ): Promise<AppliedTurns> {
    const applied: AppliedTurns = {
      handoffs: [],
      review: null,
      lastArtifact: null,
      toolResults: [],
    };

    for (const turn of turns) {
      await wait(turn.delayMs ?? TURN_DELAY_MS);

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
          for (const entry of turn.memory) {
            studio.addMemory({
              kind: entry.kind,
              title: entry.title,
              body: entry.body,
              tags: entry.tags,
              sourceTaskId: task.id,
            });
          }
          applied.lastArtifact = artifact;
          break;
        }

        case "memory": {
          studio.addMemory({
            kind: turn.memory.kind,
            title: turn.memory.title,
            body: turn.memory.body,
            tags: turn.memory.tags,
            ...(task ? { sourceTaskId: task.id } : {}),
          });
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
    cat: Cat,
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

    // 2) 没接沙盒（测试 / 降级模式）：同样只说明，不报错。
    if (!sandbox) {
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

    const label = turn.label?.trim() || defaultToolLabel(turn.tool, turn.input);
    const approval = approvalFor(turn.tool);

    // 3a) 模型发起 + 命中审批策略：先挂 pending，等铲屎官决定。
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
          output: "铲屎官拒绝了这次执行",
        };
        studio.finishToolCall(call.id, rejected);
        appendToolMessage(
          room,
          cat,
          task,
          turn,
          call.id,
          rejected,
          "铲屎官拒绝了这次执行，我换个办法。",
        );
        return toRunResult(call.id, turn.tool, rejected);
      }

      studio.startToolCall(call.id);
      const result = await executeSafely(sandbox, turn);
      studio.finishToolCall(call.id, result);
      appendToolMessage(room, cat, task, turn, call.id, result);
      return toRunResult(call.id, turn.tool, result);
    }

    // 3b) 自动放行（mock 剧本 / mode=auto / 非 commands 工具）。
    const call = studio.addToolCall({
      catId: cat.id,
      tool: turn.tool,
      args: turn.input,
      label,
      ...taskField,
    });

    const result = await executeSafely(sandbox, turn);
    studio.finishToolCall(call.id, result);
    appendToolMessage(room, cat, task, turn, call.id, result);
    return toRunResult(call.id, turn.tool, result);
  }

  function appendToolMessage(
    room: Room,
    cat: Cat,
    task: Task | null,
    turn: ToolTurn,
    callId: string,
    result: ToolResult,
    fallbackText?: string,
  ): void {
    studio.appendMessage({
      roomId: room.id,
      author: cat.id,
      kind: "tool",
      text: turn.text ?? fallbackText ?? defaultToolText(turn.tool, turn.input, result),
      mentions: normalizeMentions(turn.mentions, studio.state.cats),
      toolCallId: callId,
      ...(task ? { taskId: task.id } : {}),
    });
  }

  // ── 一轮结束后的路由 / 状态推进 ───────────────────────

  function afterTurns(
    wake: Wake,
    room: Room,
    cat: Cat,
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
        // 由 stall watchdog 标「卡住了」，等铲屎官介入。
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
          fromCatId: cat.id,
          review: {
            verdict: applied.review.verdict,
            findings: applied.review.findings,
          },
        };

        if (move.stage === "revising") {
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
        studio.finishStep(task.id, "done");
        studio.setTaskStatus(task.id, "done");
        clearStall(task.id);
        return;
      }

      case "nudge": {
        // 催一下 = 恢复：先解除 stalled，architect 已说过恢复台词；
        // 若有漏 @ 的交接，再补投递给接收猫。
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
            fromCatId: handoff.from,
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
          fromCatId: handoff.from,
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
      fromCatId: missed.from,
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
      trigger.fromCatId = artifact.author;
    }
    return trigger;
  }

  // ── 阶段 / step / owner ───────────────────────────────

  function beginStage(task: Task, stage: TaskStage, owner: CatId): void {
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

  // ── stall watchdog ────────────────────────────────────

  function scheduleStall(taskId: TaskId): void {
    const task = studio.getTask(taskId);
    if (!task || task.status !== "active") return;
    const runtime = runtimeFor(taskId);
    clearStall(taskId);
    runtime.stallTimer = setTimeout(() => {
      runtime.stallTimer = null;
      const current = studio.getTask(taskId);
      if (current?.status === "active") studio.setTaskStatus(taskId, "stalled");
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
      runtime = { workers: 0, deferredReviewer: null, missed: null, stallTimer: null };
      runtimes.set(taskId, runtime);
    }
    return runtime;
  }

  function buildContext(
    cat: Cat,
    room: Room,
    task: Task | null,
    trigger: Trigger,
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
      scenario: task
        ? SCENARIOS.find((scenario) => scenario.id === task.scenarioId) ?? null
        : null,
    };
  }

  function taskArtifacts(taskId: TaskId): Artifact[] {
    return studio.state.artifacts.filter((artifact) => artifact.taskId === taskId);
  }

  function latestTask(roomId: RoomId): Task | null {
    const tasks = studio.state.tasks;
    for (let i = tasks.length - 1; i >= 0; i -= 1) {
      const task = tasks[i];
      if (task && task.roomId === roomId) return task;
    }
    return null;
  }

  function roomCats(room: Room): Cat[] {
    const cats: Cat[] = [];
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
    if (mode === "commands") return tool === "run_command" ? "commands" : null;
    return "all";
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
