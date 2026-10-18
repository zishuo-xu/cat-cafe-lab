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
 */

import { SCENARIOS } from "../agents/personas.ts";
import type {
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
  Task,
  TaskId,
  TaskStage,
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

type TurnOf<K extends CatTurn["kind"]> = Extract<CatTurn, { kind: K }>;
type HandoffTurn = TurnOf<"handoff">;

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
}

export function createDriver(deps: {
  studio: Studio;
  brain: CatBrain;
  wait?: (ms: number) => Promise<void>;
  stallMs?: number;
}): Driver {
  const { studio, brain } = deps;
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
      let turns: CatTurn[] = [];
      try {
        await wait(THINK_DELAY_MS);
        turns = await brain.think(buildContext(cat, room, task, wake.trigger));
      } catch (err) {
        console.error(`[engine] ${cat.id} 的 brain 调用失败，按空轮次继续：`, err);
      }

      const applied = await applyTurns(room, cat, task, turns);
      if (task && runtime) afterTurns(wake, room, cat, task, runtime, applied);
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
    const applied: AppliedTurns = { handoffs: [], review: null, lastArtifact: null };

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
