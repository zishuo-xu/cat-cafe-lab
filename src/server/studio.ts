/**
 * Studio：唯一的状态容器与写入口。
 *
 * 约定：所有状态变更都走这里的方法；HTTP 层和 driver 都不直接改 state 里的字段。
 * 每次变更后：
 *   1. seq++
 *   2. 通知订阅者（HTTP 层据 this 推 SSE 全量快照）
 *   3. debounce 持久化到 <dataDir>/studio.json
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DEFAULT_WORKSPACE_ID } from "../domain/constants.ts";
import { ids } from "../domain/ids.ts";
import type {
  Artifact,
  ArtifactKind,
  ArtifactTrace,
  BrainMode,
  Member,
  MemberId,
  Handoff,
  HandoffCard,
  MemoryEntry,
  MemoryKind,
  Message,
  MessageKind,
  Role,
  CatModel,
  Room,
  RoomId,
  StudioState,
  MemberEpisode,
  MemberSession,
  LlmCall,
  Task,
  TaskHealth,
  TaskStage,
  TaskStep,
  ToolCall,
  ToolResult,
  TriggerKind,
} from "../domain/types.ts";

const MAX_MESSAGES = 1500;

export interface StudioOptions {
  cats: Member[];
  mode: BrainMode;
  dataDir?: string;
}

export interface AppendMessageInput {
  roomId: RoomId;
  author: Message["author"];
  kind: MessageKind;
  text: string;
  mentions?: MemberId[];
  taskId?: Task["id"];
  handoffId?: Handoff["id"];
  artifactId?: Artifact["id"];
  toolCallId?: ToolCall["id"];
  at?: number;
}

export interface CreateTaskInput {
  roomId: RoomId;
  brief: string;
  scenarioId: string;
  title?: string;
}

export interface CreateCatInput {
  name: string;
  role: Role;
  /** 可选：自定义人格；不填给一句默认的。 */
  persona?: string;
}

/** 成员档案可编辑字段；id / role / avatar / discipline 不可改。 */
export interface CatPatch {
  name?: string;
  title?: string;
  persona?: string;
  catchphrase?: string;
  greeting?: string;
  accent?: string;
  llmModel?: string | null;
  llmTemperature?: number | null;
  /** 工具白名单；null 表示恢复默认（全部允许）。 */
  tools?: string[] | null;
  /** 技能包 id 列表；null 表示恢复默认。 */
  skills?: string[] | null;
}

type Listener = (state: StudioState) => void;

function now(): number {
  return Date.now();
}

function freshState(cats: Member[], mode: BrainMode): StudioState {
  const room: Room = {
    id: "room_cafe",
    name: "交付台 · 主工作区",
    topic: "把需求丢进来，成员们会在同一张桌子上把它做出来。",
    catIds: cats.map((c) => c.id),
    workspaceId: DEFAULT_WORKSPACE_ID,
    createdAt: now(),
  };
  return {
    rooms: [room],
    cats,
    retiredCats: [],
    messages: [],
    tasks: [],
    handoffs: [],
    artifacts: [],
    memory: [],
    catSessions: {},
    toolCalls: [],
    llmCalls: [],
    typing: { [room.id]: null },
    drafts: {},
    seq: 0,
    mode,
    startedAt: now(),
  };
}

/**
 * 新成员的角色默认值。
 *
 * 只给「新建时」用；四只内置成员的人格在 personas.ts 里，不走这里。
 */
const ROLE_META: Record<
  Role,
  { discipline: string; title: string; model: CatModel; accent: string; avatar: Member["avatar"] }
> = {
  architect: {
    discipline: "架构师",
    title: "架构师 · 需求把关与任务拆解",
    model: "claude",
    accent: "#c58a4a",
    avatar: "architect",
  },
  reviewer: {
    discipline: "评审",
    title: "评审 · 证据与边界",
    model: "gpt",
    accent: "#6b7f8a",
    avatar: "reviewer",
  },
  designer: {
    discipline: "设计",
    title: "设计 · 交互与文案",
    model: "gemini",
    accent: "#b06c8a",
    avatar: "designer",
  },
  implementer: {
    discipline: "实现",
    title: "实现 · 编码与自测",
    model: "opencode",
    accent: "#5f8a6b",
    avatar: "implementer",
  },
};

/**
 * 名册完整性：引擎的阶段机需要这些角色才能跑完一个任务。
 *
 * - 架构师：接单 / 规划 / 收尾落决策；
 * - 评审：reviewing 阶段；
 * - 干活的（设计或实现至少一个）：working / revising 阶段。
 */
function assertRosterComplete(cats: readonly Member[]): void {
  const has = (role: Role): boolean => cats.some((cat) => cat.role === role);
  if (!has("architect")) throw new Error("至少要保留一个架构师");
  if (!has("reviewer")) throw new Error("至少要保留一个评审");
  if (!cats.some((cat) => cat.role === "designer" || cat.role === "implementer")) {
    throw new Error("至少要保留一个设计或实现成员");
  }
}

const CAT_MODELS = new Set<CatModel>(["claude", "gpt", "gemini", "opencode"]);

/** 名册能否支撑一个完整任务（不抛错版本，供存档恢复时判断）。 */
function isRosterUsable(cats: readonly Member[]): boolean {
  try {
    assertRosterComplete(cats);
    return cats.length > 0;
  } catch {
    return false;
  }
}

/**
 * 从存档恢复一个「用户自己加的」成员（不在内置 CATS 里的）。
 *
 * 存档可能是手改的，所以每个字段都要兜底：缺字段回落到角色默认值，
 * 非法值直接丢弃。恢复不出来就返回 null（该成员被跳过，不拖垮整个应用）。
 */
function restoreCustomCat(record: Record<string, unknown>): Member | null {
  const id = typeof record["id"] === "string" ? record["id"].trim() : "";
  const name = typeof record["name"] === "string" ? record["name"].trim() : "";
  const role = record["role"];
  if (!id || !name) return null;
  if (typeof role !== "string" || !(role in ROLE_META)) return null;
  const meta = ROLE_META[role as Role];

  const text = (key: string, fallback: string, max: number): string => {
    const value = record[key];
    if (typeof value !== "string") return fallback;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : fallback;
  };
  const accent = typeof record["accent"] === "string" ? record["accent"].trim() : "";
  const model = record["model"];
  const avatar = record["avatar"];

  const base: Member = {
    id,
    name: name.slice(0, 8),
    discipline: text("discipline", meta.discipline, 20),
    role: role as Role,
    title: text("title", meta.title, 24),
    model: typeof model === "string" && CAT_MODELS.has(model as CatModel) ? (model as CatModel) : meta.model,
    persona: text("persona", `我是${name}，${meta.discipline}。`, 100),
    catchphrase: text("catchphrase", "先做，再说。", 50),
    accent: /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : meta.accent,
    avatar:
      typeof avatar === "string" && avatar in ROLE_META
        ? (avatar as Member["avatar"])
        : meta.avatar,
    greeting: text("greeting", `我是${name}。`, 100),
  };
  // 模型覆盖 / 工具 / 技能这些可编辑字段复用同一套清洗逻辑。
  return { ...base, ...sanitizeCatOverrides(record), id };
}

function titleFromBrief(brief: string): string {
  const line = brief.trim().split(/\n/)[0] ?? brief;
  const cut = line.length > 22 ? `${line.slice(0, 22)}…` : line;
  return cut || "未命名需求";
}

export class Studio {
  readonly state: StudioState;
  private readonly listeners = new Set<Listener>();
  private readonly dataFile: string | null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly roomGreetingsAt: number;

  constructor(opts: StudioOptions) {
    this.state = freshState(opts.cats, opts.mode);
    this.dataFile = opts.dataDir ? join(opts.dataDir, "studio.json") : null;
    this.roomGreetingsAt = now();

    if (opts.dataDir && !existsSync(opts.dataDir)) {
      mkdirSync(opts.dataDir, { recursive: true });
    }
    if (!this.load()) {
      this.seedWelcome();
    }
    this.notify();
  }

  // ── 读 ────────────────────────────────────────────────

  snapshot(): StudioState {
    return this.state;
  }

  getCat(id: MemberId): Member | undefined {
    return this.state.cats.find((c) => c.id === id);
  }

  getRoom(id: RoomId): Room | undefined {
    return this.state.rooms.find((r) => r.id === id);
  }

  getTask(id: Task["id"]): Task | undefined {
    return this.state.tasks.find((t) => t.id === id);
  }

  recentMessages(roomId: RoomId, limit = 24): Message[] {
    const list = this.state.messages.filter((m) => m.roomId === roomId);
    return list.slice(Math.max(0, list.length - limit));
  }

  /** 当前任务相关的记忆：同 room 下较新的、以及带同 tag 的。 */
  memoryForTask(task: Task | null): MemoryEntry[] {
    if (!task) return this.state.memory.slice(-12);
    const briefTags = new Set(this.taskTags(task));
    const scored = this.state.memory.map((m) => {
      let score = 0;
      if (m.sourceTaskId === task.id) score += 3;
      for (const tag of m.tags) if (briefTags.has(tag)) score += 2;
      if (m.kind === "preference") score += 1;
      return { m, score };
    });
    scored.sort((a, b) => b.score - a.score || b.m.createdAt - a.m.createdAt);
    return scored.slice(0, 12).map((x) => x.m);
  }

  taskTags(task: Task): string[] {
    const text = `${task.title} ${task.brief}`.toLowerCase();
    const tags: string[] = [];
    if (/登录|login|auth|token|cookie|session/.test(text)) tags.push("auth");
    if (/记住我|remember|免登录/.test(text)) tags.push("remember-me");
    if (/ui|页面|设计|勾选|移动端/.test(text)) tags.push("ui");
    if (/性能|缓存|cache|redis/.test(text)) tags.push("perf");
    if (/安全|权限|越权|xss|csrf/.test(text)) tags.push("security");
    return tags;
  }

  // ── 写：消息 ──────────────────────────────────────────

  appendMessage(input: AppendMessageInput): Message {
    const room = this.requireRoom(input.roomId);
    const mentions = [...new Set(input.mentions ?? [])].filter((id) =>
      room.catIds.includes(id),
    );
    const message: Message = {
      id: ids.message(),
      roomId: input.roomId,
      author: input.author,
      kind: input.kind,
      text: input.text,
      mentions,
      at: input.at ?? now(),
    };
    if (input.taskId) message.taskId = input.taskId;
    if (input.handoffId) message.handoffId = input.handoffId;
    if (input.artifactId) message.artifactId = input.artifactId;
    if (input.toolCallId) message.toolCallId = input.toolCallId;

    this.state.messages.push(message);
    if (this.state.messages.length > MAX_MESSAGES) {
      this.state.messages.splice(0, this.state.messages.length - MAX_MESSAGES);
    }
    this.touchTask(input.taskId);
    this.notify();
    return message;
  }

  // ── 写：任务 ──────────────────────────────────────────

  createTask(input: CreateTaskInput): Task {
    this.requireRoom(input.roomId);
    const architect = this.state.cats.find((c) => c.role === "architect");
    if (!architect) throw new Error("no architect cat configured");
    const task: Task = {
      id: ids.task(),
      roomId: input.roomId,
      title: input.title ?? titleFromBrief(input.brief),
      brief: input.brief.trim(),
      scenarioId: input.scenarioId,
      status: "active",
      stage: "intake",
      owner: architect.id,
      steps: [],
      createdAt: now(),
      updatedAt: now(),
    };
    this.state.tasks.push(task);
    this.notify();
    return task;
  }

  updateTaskStage(taskId: Task["id"], stage: TaskStage, owner: MemberId): Task {
    const task = this.requireTask(taskId);
    task.stage = stage;
    task.owner = owner;
    task.updatedAt = now();
    this.notify();
    return task;
  }

  updateTaskGit(taskId: Task["id"], git: Task["git"]): Task {
    const task = this.requireTask(taskId);
    if (git) task.git = git;
    else delete task.git;
    task.updatedAt = now();
    this.notify();
    return task;
  }

  /**
   * 任务完成时的兜底记忆。
   *
   * 为什么需要：记忆原本依赖模型在 decision turn 里主动给 memory 字段。
   * 实测真实模型经常只说话不给字段，于是「任务跑完了但共享记忆是空的」——
   * 而跨任务记忆是这个项目的核心卖点之一，不能靠模型自觉。
   *
   * 这里只做**兜底**：已经有该任务的记忆就不重复写。
   */
  ensureTaskMemory(taskId: Task["id"]): MemoryEntry | null {
    const existing = this.state.memory.filter((entry) => entry.sourceTaskId === taskId);
    if (existing.length > 0) return null;

    const task = this.getTask(taskId);
    if (!task) return null;

    const delivery = this.deliverySummary(taskId);
    const verdict =
      delivery.verdict === "approve"
        ? "评审通过"
        : delivery.verdict === "request_changes"
          ? "评审未通过"
          : "无评审结论";
    const artifacts = delivery.artifacts.length
      ? `产出 ${delivery.artifacts.length} 个：${delivery.artifacts
          .map((item) => `${item.kind}「${item.title}」`)
          .join("、")}`
      : "没有产出";
    const blockers = delivery.blockers.length
      ? `；未清 blocker ${delivery.blockers.length} 条：${delivery.blockers.join("；")}`
      : "";

    // 降级过的任务：摘要里明说产出可能不可信，别让后续任务把它当可信结论。
    const degraded = task.health?.degradedCount ?? 0;
    const degradedNote =
      degraded > 0 ? `；本任务有 ${degraded} 次模型降级，产出可能不可信` : "";
    return this.addMemory({
      kind: "decision",
      title: `任务「${task.title.slice(0, 40)}」${verdict}`,
      body: `${artifacts}${blockers}（系统自动记录${degradedNote}）`,
      tags: ["auto-summary", task.scenarioId, ...(degraded > 0 ? ["degraded"] : [])],
      sourceTaskId: task.id,
    });
  }

  /**
   * 任务交付摘要：当前有什么、还差什么。
   *
   * 收尾（尤其是被强制收尾）时最该告诉用户的两件事：
   * 1. 我现在拿到的产物有哪些；
   * 2. 评审还剩几条 blocker 没清。
   */
  deliverySummary(taskId: Task["id"]): {
    artifacts: Array<{ kind: string; title: string; version: number }>;
    blockers: string[];
    verdict: string | null;
  } {
    const artifacts = this.state.artifacts
      .filter((artifact) => artifact.taskId === taskId)
      .map((artifact) => ({ kind: artifact.kind, title: artifact.title, version: artifact.version }));

    // 找最后一次评审，抽出 blocker。
    const reviews = this.state.artifacts.filter(
      (artifact) => artifact.taskId === taskId && artifact.kind === "review",
    );
    const latest = reviews.at(-1);
    const blockers: string[] = [];
    let verdict: string | null = null;
    if (latest) {
      const body = latest.body;
      if (/verdict:\s*request_changes/i.test(body)) verdict = "request_changes";
      else if (/verdict:\s*approve/i.test(body)) verdict = "approve";
      for (const line of body.split("\n")) {
        if (!/blocker/i.test(line)) continue;
        const cleaned = line
          .replace(/^\s*[-*]\s*/, "")
          .replace(/\[blocker\]\s*/i, "")
          .trim();
        if (cleaned) blockers.push(cleaned.slice(0, 140));
      }
    }
    return { artifacts, blockers: blockers.slice(0, 6), verdict };
  }

  /** 强制收尾：记录原因，任务置 done。 */
  closeTaskWithReason(taskId: Task["id"], reason: string): Task {
    const task = this.requireTask(taskId);
    if (task.status === "done") return task;
    this.appendMessage({
      roomId: task.roomId,
      author: "system",
      kind: "system",
      text: `负责人选择收尾：${reason}`,
      taskId: task.id,
    });
    this.finishStep(task.id, task.stage);
    this.updateTaskStage(task.id, "done", task.owner);
    this.setTaskStatus(task.id, "done");
    this.addMemory({
      kind: "lesson",
      title: `任务「${task.title}」由负责人提前收尾`,
      body: reason,
      tags: ["manual-close", "process"],
      sourceTaskId: task.id,
    });
    return task;
  }

  setTaskStatus(taskId: Task["id"], status: Task["status"]): Task {
    const task = this.requireTask(taskId);
    task.status = status;
    task.updatedAt = now();
    if (status === "done") task.doneAt = now();
    this.notify();
    return task;
  }

  addStep(taskId: Task["id"], input: { stage: TaskStage; owner: MemberId }): TaskStep {
    const task = this.requireTask(taskId);
    const step: TaskStep = {
      id: ids.step(),
      stage: input.stage,
      owner: input.owner,
      status: "active",
      startedAt: now(),
    };
    task.steps.push(step);
    task.updatedAt = now();
    this.notify();
    return step;
  }

  finishStep(taskId: Task["id"], stage: TaskStage): void {
    const task = this.requireTask(taskId);
    for (const step of task.steps) {
      if (step.stage === stage && step.status !== "done") {
        step.status = "done";
        step.doneAt = now();
      }
    }
    task.updatedAt = now();
    this.notify();
  }

  // ── 写：交接 / 产物 / 记忆 ────────────────────────────

  addHandoff(input: {
    taskId: Task["id"];
    from: MemberId;
    to: MemberId;
    card: HandoffCard;
  }): Handoff {
    this.requireTask(input.taskId);
    const handoff: Handoff = {
      id: ids.handoff(),
      taskId: input.taskId,
      from: input.from,
      to: input.to,
      card: input.card,
      createdAt: now(),
    };
    this.state.handoffs.push(handoff);
    this.touchTask(input.taskId);
    this.notify();
    return handoff;
  }

  addArtifact(input: {
    taskId: Task["id"];
    kind: ArtifactKind;
    title: string;
    body: string;
    author: MemberId;
    /** 产物溯源：产生它的模型调用与阶段。 */
    trace?: ArtifactTrace;
  }): Artifact {
    this.requireTask(input.taskId);
    const sameKind = this.state.artifacts.filter(
      (a) => a.taskId === input.taskId && a.kind === input.kind,
    );
    const artifact: Artifact = {
      id: ids.artifact(),
      taskId: input.taskId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      author: input.author,
      version: sameKind.length + 1,
      createdAt: now(),
      ...(input.trace ? { trace: input.trace } : {}),
    };
    this.state.artifacts.push(artifact);
    this.touchTask(input.taskId);
    this.notify();
    return artifact;
  }

  addMemory(input: {
    kind: MemoryKind;
    title: string;
    body: string;
    tags: string[];
    sourceTaskId?: Task["id"];
  }): MemoryEntry {
    const entry: MemoryEntry = {
      id: ids.memory(),
      kind: input.kind,
      title: input.title,
      body: input.body,
      tags: [...new Set(input.tags)],
      createdAt: now(),
    };
    if (input.sourceTaskId) entry.sourceTaskId = input.sourceTaskId;
    this.state.memory.push(entry);
    this.notify();
    return entry;
  }

  /** 模型调用：开始时落一条记录，结束时补齐。 */
  startLlmCall(input: {
    catId: MemberId;
    model: string;
    engine: "api" | "cli";
    taskId?: Task["id"];
    stage?: TaskStage;
    trigger?: TriggerKind;
  }): LlmCall {
    const call: LlmCall = {
      id: ids.message(),
      catId: input.catId,
      model: input.model,
      engine: input.engine,
      startedAt: now(),
    };
    if (input.taskId) call.taskId = input.taskId;
    if (input.stage) call.stage = input.stage;
    if (input.trigger) call.trigger = input.trigger;
    this.state.llmCalls.push(call);
    // 只保留最近 200 条，避免状态无限增长。
    if (this.state.llmCalls.length > 200) {
      this.state.llmCalls.splice(0, this.state.llmCalls.length - 200);
    }
    return call;
  }

  finishLlmCall(id: string, patch: Partial<LlmCall>): LlmCall | undefined {
    const call = this.state.llmCalls.find((item) => item.id === id);
    if (!call) return undefined;
    Object.assign(call, patch);
    call.finishedAt = now();
    call.durationMs = call.finishedAt - call.startedAt;
    // 降级要能到达负责人：以前只留在 LlmCall 上，不翻轨迹根本看不见。
    if (call.degraded) this.recordTaskDegradation(call);
    this.notify();
    return call;
  }

  /**
   * 记录一次模型调用失败（健康度汇总）。
   *
   * 只累加计数与最近原因，不自己发消息——用户可见的提示由 driver 统一发，
   * 避免「暂停提示 + 降级提示」两条消息重复。
   */
  recordTaskDegradation(call: LlmCall): void {
    if (!call.taskId) return;
    const task = this.getTask(call.taskId);
    if (!task) return;

    const health: TaskHealth = task.health ?? { degradedCount: 0, warned: false };
    health.degradedCount += 1;
    if (call.degradeReason) health.lastDegradeReason = call.degradeReason;
    if (call.stage) health.lastDegradeStage = call.stage;
    task.health = health;

    // 用户可见的提示由 driver 在暂停任务时统一发（模型失败 = 暂停，不再有「降级演出」），
    // 这里只负责汇总健康度，供任务卡徽标与轨迹查看。
    health.warned = true;
  }

  /** 沙盒工具调用：先落一条 running，执行完再 finish。 */
  addToolCall(input: {
    catId: MemberId;
    tool: ToolCall["tool"];
    args: Record<string, unknown>;
    label: string;
    taskId?: Task["id"];
    status?: "running" | "pending";
  }): ToolCall {
    const call: ToolCall = {
      id: ids.message(),
      catId: input.catId,
      tool: input.tool,
      input: input.args,
      label: input.label,
      status: input.status ?? "running",
      startedAt: now(),
    };
    if (input.taskId) call.taskId = input.taskId;
    if (call.status === "pending") call.approvalRequestedAt = call.startedAt;
    this.state.toolCalls.push(call);
    if (this.state.toolCalls.length > 300) {
      this.state.toolCalls.splice(0, this.state.toolCalls.length - 300);
    }
    this.touchTask(input.taskId);
    this.notify();
    return call;
  }

  /** 审批通过后把 pending 转成 running，再执行。 */
  startToolCall(id: string): ToolCall {
    const call = this.state.toolCalls.find((item) => item.id === id);
    if (!call) throw new Error(`tool call not found: ${id}`);
    if (call.approvalRequestedAt && !call.approvalDecidedAt) call.approvalDecidedAt = now();
    call.status = "running";
    call.startedAt = now();
    this.notify();
    return call;
  }

  finishToolCall(id: string, result: ToolResult): ToolCall {
    const call = this.state.toolCalls.find((item) => item.id === id);
    if (!call) throw new Error(`tool call not found: ${id}`);
    call.status = result.status;
    if (result.exitCode !== undefined) call.exitCode = result.exitCode;
    call.output = result.output;
    call.finishedAt = now();
    this.notify();
    return call;
  }

  // ── 写：每成员会话 ──────────────────────────────────────

  /** 取某个成员的会话（没有则创建一个空的）。 */
  sessionFor(catId: MemberId): MemberSession {
    const existing = this.state.catSessions[catId];
    if (existing) return existing;
    const created: MemberSession = { catId, episodes: [], lessons: [], updatedAt: now() };
    this.state.catSessions[catId] = created;
    return created;
  }

  /**
   * 记录一个成员在某任务里的经历（任务结束时调用）。
   * 只保留最近 8 条，避免 prompt 无限膨胀。
   */
  recordEpisode(input: {
    catId: MemberId;
    taskId: Task["id"];
    title: string;
    summary: string;
    outcome: "done" | "abandoned" | "open";
  }): MemberEpisode {
    const session = this.sessionFor(input.catId);
    const episode = {
      taskId: input.taskId,
      title: input.title.slice(0, 80),
      summary: input.summary.slice(0, 300),
      outcome: input.outcome,
      at: now(),
    };
    // 同一任务只保留一条（重跑时覆盖）。
    session.episodes = [episode, ...session.episodes.filter((e) => e.taskId !== input.taskId)]
      .slice(0, 8);
    session.updatedAt = now();
    this.notify();
    return episode;
  }

  /** 把一条教训挂到具体某个成员名下。 */
  attachLesson(catId: MemberId, entry: MemoryEntry): void {
    const session = this.sessionFor(catId);
    session.lessons = [entry, ...session.lessons.filter((e) => e.id !== entry.id)].slice(0, 12);
    session.updatedAt = now();
    this.notify();
  }

  // ── 写：易变状态 ──────────────────────────────────────

  /** 流式草稿：成员正在说的话。传 null 清空。 */
  setDraft(roomId: RoomId, draft: { catId: MemberId; text: string } | null): void {
    const current = this.state.drafts[roomId];
    if (!draft) {
      if (!current) return;
      delete this.state.drafts[roomId];
      this.notify();
      return;
    }
    // 文本没变就不推送，避免每个 token 都触发一次全量 SSE。
    if (current && current.catId === draft.catId && current.text === draft.text) return;
    this.state.drafts[roomId] = { catId: draft.catId, text: draft.text, at: now() };
    this.notify();
  }

  setTyping(roomId: RoomId, catId: MemberId | null): void {
    if (!this.state.typing[roomId] && !catId) return;
    if (this.state.typing[roomId] === catId) return;
    this.state.typing[roomId] = catId;
    this.notify();
  }

  /** 设置面板切换模式后同步给前端（SSE 会带出 state.mode）。 */
  /** 新建房间；workspaceId 由 HTTP 层先用 WorkspaceManager 校验。 */
  createRoom(input: { name: string; workspaceId: string; topic?: string }): Room {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 30) throw new Error("房间名需要 1–30 个字符");
    if (this.state.rooms.some((room) => room.name === name)) {
      throw new Error(`房间「${name}」已存在`);
    }
    const room: Room = {
      id: ids.room(),
      name,
      topic: input.topic?.trim() || "这个房间绑定了自己的工作区。",
      catIds: this.state.cats.map((cat) => cat.id),
      workspaceId: input.workspaceId,
      createdAt: now(),
    };
    this.state.rooms.push(room);
    this.state.typing[room.id] = null;
    this.notify();
    return room;
  }

  /** 房间编辑：改名 / 改主题 / 换工作区。 */
  updateRoom(
    roomId: RoomId,
    patch: { name?: string; topic?: string; workspaceId?: string },
  ): Room {
    const room = this.requireRoom(roomId);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name.length < 1 || name.length > 30) throw new Error("房间名需要 1–30 个字符");
      if (this.state.rooms.some((other) => other.id !== roomId && other.name === name)) {
        throw new Error(`房间「${name}」已存在`);
      }
      room.name = name;
    }
    if (patch.topic !== undefined) {
      const topic = patch.topic.trim();
      if (topic.length > 120) throw new Error("主题不能超过 120 个字符");
      room.topic = topic;
    }
    if (patch.workspaceId !== undefined) room.workspaceId = patch.workspaceId;
    this.notify();
    return room;
  }

  /** 删除房间并级联清理它的任务/消息/交接/产物/工具记录。 */
  deleteRoom(roomId: RoomId): { tasks: number; messages: number; handoffs: number; artifacts: number; toolCalls: number } {
    if (this.state.rooms.length <= 1) throw new Error("至少保留一个房间");
    const index = this.state.rooms.findIndex((room) => room.id === roomId);
    if (index < 0) throw new Error(`room not found: ${roomId}`);
    const active = this.state.tasks.filter(
      (task) => task.roomId === roomId && (task.status === "active" || task.status === "stalled"),
    );
    if (active.length > 0) {
      throw new Error(`这个房间还有 ${active.length} 个进行中的任务，先等它们结束或重置交付台`);
    }
    const taskIds = new Set(this.state.tasks.filter((task) => task.roomId === roomId).map((task) => task.id));
    const removed = {
      tasks: taskIds.size,
      messages: this.state.messages.filter((message) => message.roomId === roomId).length,
      handoffs: this.state.handoffs.filter((handoff) => taskIds.has(handoff.taskId)).length,
      artifacts: this.state.artifacts.filter((artifact) => taskIds.has(artifact.taskId)).length,
      toolCalls: this.state.toolCalls.filter((call) => call.taskId && taskIds.has(call.taskId)).length,
    };
    this.state.rooms.splice(index, 1);
    this.state.tasks = this.state.tasks.filter((task) => task.roomId !== roomId);
    this.state.messages = this.state.messages.filter((message) => message.roomId !== roomId);
    this.state.handoffs = this.state.handoffs.filter((handoff) => !taskIds.has(handoff.taskId));
    this.state.artifacts = this.state.artifacts.filter((artifact) => !taskIds.has(artifact.taskId));
    this.state.toolCalls = this.state.toolCalls.filter((call) => !call.taskId || !taskIds.has(call.taskId));
    this.state.memory = this.state.memory.filter(
      (entry) => !entry.sourceTaskId || !taskIds.has(entry.sourceTaskId),
    );
    delete this.state.typing[roomId];
    delete this.state.drafts[roomId];
    this.notify();
    return removed;
  }

  setRoomWorkspace(roomId: RoomId, workspaceId: string): Room {
    const room = this.requireRoom(roomId);
    room.workspaceId = workspaceId;
    this.notify();
    return room;
  }

  setMode(mode: BrainMode): void {
    if (this.state.mode === mode) return;
    this.state.mode = mode;
    this.notify();
  }

  /**
   * 编辑成员档案（名字 / 称号 / 性格 / 口头禅 / 招呼语 / 主题色）与真实模式模型覆盖。
   * id、角色、头像、品种不可改。改名后 @ 解析会自动用新名字。
   */
  updateCat(catId: MemberId, patch: CatPatch): Member {
    const index = this.state.cats.findIndex((c) => c.id === catId);
    const current = this.state.cats[index];
    if (index < 0 || !current) throw new Error(`cat not found: ${catId}`);
    const next: Member = { ...current };

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name.length < 1 || name.length > 8) throw new Error("名字需要 1–8 个字符");
      if (this.state.cats.some((c) => c.id !== catId && c.name === name)) {
        throw new Error(`名字「${name}」已经被其他成员用了`);
      }
      next.name = name;
    }
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (title.length < 1 || title.length > 24) throw new Error("称号需要 1–24 个字符");
      next.title = title;
    }
    if (patch.persona !== undefined) {
      const persona = patch.persona.trim();
      if (persona.length < 1 || persona.length > 100) throw new Error("性格需要 1–100 个字符");
      next.persona = persona;
    }
    if (patch.catchphrase !== undefined) {
      const catchphrase = patch.catchphrase.trim();
      if (catchphrase.length < 1 || catchphrase.length > 50) throw new Error("口头禅需要 1–50 个字符");
      next.catchphrase = catchphrase;
    }
    if (patch.greeting !== undefined) {
      const greeting = patch.greeting.trim();
      if (greeting.length < 1 || greeting.length > 100) throw new Error("招呼语需要 1–100 个字符");
      next.greeting = greeting;
    }
    if (patch.accent !== undefined) {
      if (!/^#[0-9a-fA-F]{6}$/.test(patch.accent.trim())) {
        throw new Error("主题色需要是 #RRGGBB 格式");
      }
      next.accent = patch.accent.trim();
    }
    if (patch.llmModel !== undefined) {
      if (patch.llmModel === null || patch.llmModel.trim() === "") {
        delete next.llmModel;
      } else {
        const model = patch.llmModel.trim();
        if (model.length > 80) throw new Error("模型名不能超过 80 个字符");
        next.llmModel = model;
      }
    }
    if (patch.llmTemperature !== undefined) {
      if (patch.llmTemperature === null) {
        delete next.llmTemperature;
      } else {
        const temperature = Number(patch.llmTemperature);
        if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
          throw new Error("温度需要在 0–2 之间");
        }
        next.llmTemperature = temperature;
      }
    }
    if (patch.tools !== undefined) {
      if (patch.tools === null) {
        delete next.tools;
      } else {
        if (patch.tools.length > 24 || patch.tools.some((tool) => typeof tool !== "string" || tool.length > 80)) {
          throw new Error("tools 必须是最多 24 个工具名的数组");
        }
        next.tools = [...new Set(patch.tools)];
      }
    }
    if (patch.skills !== undefined) {
      if (patch.skills === null) {
        delete next.skills;
      } else {
        if (patch.skills.length > 12 || patch.skills.some((skill) => typeof skill !== "string" || skill.length > 40)) {
          throw new Error("skills 必须是最多 12 个技能 id 的数组");
        }
        next.skills = [...new Set(patch.skills)];
      }
    }

    this.state.cats[index] = next;
    this.notify();
    return next;
  }

  // ── 成员增删（成员数量可配置） ─────────────────────────

  /**
   * 新增成员。
   *
   * 成员数量不写死：名册渲染、房间 catIds、@ 路由、提示词都按 `state.cats` 动态走，
   * 引擎只要求角色齐全（一个架构师 + 一个评审 + 至少一个干活的），
   * 所以架构师/评审限制各最多一个，设计与实现可以有任意多个。
   */
  addCat(input: CreateCatInput): Member {
    const name = String(input.name ?? "").trim();
    if (name.length < 1 || name.length > 8) throw new Error("名字需要 1–8 个字符");
    if (this.state.cats.some((cat) => cat.name === name)) {
      throw new Error(`名字「${name}」已经被其他成员用了`);
    }
    const role = input.role;
    if (!ROLE_META[role]) throw new Error(`未知角色：${String(role)}`);
    const exclusive = role === "architect" || role === "reviewer";
    if (exclusive) {
      const existing = this.state.cats.find((cat) => cat.role === role);
      if (existing) {
        throw new Error(
          `已经有一个${ROLE_META[role].discipline}了（${existing.name}）；` +
            `${ROLE_META[role].discipline}只能有一个`,
        );
      }
    }

    const meta = ROLE_META[role];
    const cat: Member = {
      id: ids.cat(),
      name,
      discipline: meta.discipline,
      role,
      title: meta.title,
      model: meta.model,
      persona: `（新成员，还没写人格）我是${name}，${meta.discipline}。`,
      catchphrase: "先做，再说。",
      accent: meta.accent,
      avatar: meta.avatar,
      greeting: `我是${name}，${meta.discipline}。有活派给我。`,
      ...(input.persona?.trim() ? { persona: input.persona.trim() } : {}),
    };
    this.state.cats.push(cat);
    for (const room of this.state.rooms) room.catIds.push(cat.id);
    this.notify();
    return cat;
  }

  /**
   * 移除成员：进 `retiredCats` 存档（历史消息仍能显示名字），不再参与协作。
   *
   * 拒绝的两种情况：
   * - 移除后角色不齐（没有架构师 / 评审 / 干活的人）；
   * - 这个成员手上还有没结束的任务（先让它收尾或换人，避免任务卡死）。
   */
  removeCat(catId: MemberId): Member {
    const index = this.state.cats.findIndex((cat) => cat.id === catId);
    const cat = this.state.cats[index];
    if (index < 0 || !cat) throw new Error(`成员不存在：${catId}`);

    const busyTask = this.state.tasks.find(
      (task) => task.status !== "done" && task.owner === catId,
    );
    if (busyTask) {
      throw new Error(
        `「${cat.name}」还负责着进行中的任务「${busyTask.title}」，` +
          `先让它收尾或换个负责人再移除`,
      );
    }

    const remaining = this.state.cats.filter((item) => item.id !== catId);
    assertRosterComplete(remaining);

    this.state.cats = remaining;
    if (!this.state.retiredCats.some((item) => item.id === catId)) {
      this.state.retiredCats.push(cat);
    }
    for (const room of this.state.rooms) {
      room.catIds = room.catIds.filter((id) => id !== catId);
      if (this.state.typing[room.id] === catId) this.state.typing[room.id] = null;
    }
    delete this.state.catSessions[catId];
    this.notify();
    return cat;
  }

  /** 按 id 找成员，包含已移除的（历史记录渲染用）。 */
  getCatIncludingRetired(catId: MemberId): Member | undefined {
    return (
      this.state.cats.find((cat) => cat.id === catId) ??
      this.state.retiredCats.find((cat) => cat.id === catId)
    );
  }

  // ── 订阅 / 持久化 ─────────────────────────────────────

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  reset(): StudioState {
    this.state.messages.length = 0;
    this.state.tasks.length = 0;
    this.state.handoffs.length = 0;
    this.state.artifacts.length = 0;
    this.state.memory.length = 0;
    this.state.catSessions = {};
    this.state.llmCalls.length = 0;
    this.state.toolCalls.length = 0;
    for (const roomId of Object.keys(this.state.typing)) this.state.typing[roomId] = null;
    this.state.drafts = {};
    this.state.startedAt = now();
    this.seedWelcome();
    this.notify();
    return this.state;
  }

  persistNow(): void {
    if (!this.dataFile) return;
    try {
      mkdirSync(dirname(this.dataFile), { recursive: true });
      const tmp = `${this.dataFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), "utf8");
      renameSync(tmp, this.dataFile);
    } catch (err) {
      console.error("[studio] persist failed:", err);
    }
  }

  close(): void {
    this.closed = true;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistNow();
  }

  // ── 内部 ──────────────────────────────────────────────

  private seedWelcome(): void {
    const room = this.state.rooms[0];
    if (!room) return;
    this.state.messages.push({
      id: ids.message(),
      roomId: room.id,
      author: "system",
      kind: "system",
      text: "☕ 交付台开门了。把需求丢进来，或者 @ 一个成员聊两句。",
      mentions: [],
      at: this.roomGreetingsAt,
    });
    this.state.cats.forEach((cat, index) => {
      this.state.messages.push({
        id: ids.message(),
        roomId: room.id,
        author: cat.id,
        kind: "chat",
        text: cat.greeting,
        mentions: [],
        at: this.roomGreetingsAt + (index + 1) * 400,
      });
    });
  }

  private load(): boolean {
    if (!this.dataFile || !existsSync(this.dataFile)) return false;
    try {
      const parsed = JSON.parse(readFileSync(this.dataFile, "utf8")) as Partial<StudioState>;
      if (!parsed || !Array.isArray(parsed.rooms) || !Array.isArray(parsed.messages)) {
        return false;
      }
      this.state.rooms = (parsed.rooms as Room[]).map((room) => ({
        ...room,
        workspaceId: room.workspaceId ?? DEFAULT_WORKSPACE_ID,
      }));
      this.state.messages = parsed.messages as Message[];
      this.state.tasks = (parsed.tasks ?? []) as Task[];
      this.state.handoffs = (parsed.handoffs ?? []) as Handoff[];
      this.state.artifacts = (parsed.artifacts ?? []) as Artifact[];
      this.state.memory = (parsed.memory ?? []) as MemoryEntry[];
      this.state.catSessions = (parsed.catSessions ?? {}) as Record<string, MemberSession>;
      this.state.llmCalls = (parsed.llmCalls ?? []) as LlmCall[];
      this.state.toolCalls = (parsed.toolCalls ?? []) as ToolCall[];
      this.state.typing = (parsed.typing ?? {}) as Record<RoomId, MemberId | null>;
      // 草稿是瞬态：重启后不恢复（否则会留下永远不消失的半截气泡）。
      this.state.drafts = {};

      // 成员档案：内置成员以代码里的 CATS 为底（只接受安全字段覆盖），
      // 用户后来加的成员按存档原样恢复 —— 成员数量不再写死成 4 个。
      const baseCats = this.state.cats;
      const savedCats = Array.isArray(parsed.cats) ? (parsed.cats as unknown[]) : [];
      if (savedCats.length > 0) {
        const restored: Member[] = [];
        for (const raw of savedCats) {
          if (!raw || typeof raw !== "object") continue;
          const record = raw as Record<string, unknown>;
          const id = typeof record["id"] === "string" ? record["id"] : "";
          if (!id) continue;
          const base = baseCats.find((cat) => cat.id === id);
          if (base) {
            const patch = sanitizeCatOverrides(record);
            restored.push(Object.keys(patch).length > 0 ? { ...base, ...patch, id: base.id } : base);
          } else {
            const custom = restoreCustomCat(record);
            if (custom) restored.push(custom);
          }
        }
        // 存档被手工改坏（角色不齐）时退回代码默认名册，别让应用起不来。
        if (restored.length > 0 && isRosterUsable(restored)) {
          this.state.cats = restored;
        } else {
          console.warn("[studio] 存档里的成员名册不可用（角色不齐），改用默认名册");
        }
        // 防止手工改坏存档导致重名：重名的那只回退默认名。
        const seenNames = new Set<string>();
        for (const cat of this.state.cats) {
          if (seenNames.has(cat.name)) {
            const fallback = baseCats.find((c) => c.id === cat.id);
            if (fallback) cat.name = fallback.name;
          }
          seenNames.add(cat.name);
        }
        // 房间成员跟着名册走：已移除的成员不再留在房间里。
        const activeIds = new Set(this.state.cats.map((cat) => cat.id));
        for (const room of this.state.rooms) {
          room.catIds = room.catIds.filter((id) => activeIds.has(id));
          if (room.catIds.length === 0) room.catIds = this.state.cats.map((cat) => cat.id);
        }
      }

      // 已移除成员：只用于历史渲染。
      const retired = Array.isArray(parsed.retiredCats) ? (parsed.retiredCats as unknown[]) : [];
      this.state.retiredCats = retired
        .map((raw) => (raw && typeof raw === "object" ? restoreCustomCat(raw as Record<string, unknown>) : null))
        .filter((cat): cat is Member => cat !== null);

      this.state.startedAt = parsed.startedAt ?? now();
      this.state.seq = parsed.seq ?? 0;
      // 上次退出时可能残留 typing，恢复时清掉。
      for (const key of Object.keys(this.state.typing)) this.state.typing[key] = null;
      return this.state.rooms.length > 0 && this.state.messages.length > 0;
    } catch (err) {
      console.error("[studio] load failed, starting fresh:", err);
      return false;
    }
  }

  private touchTask(taskId: Task["id"] | undefined): void {
    if (!taskId) return;
    const task = this.getTask(taskId);
    if (task) task.updatedAt = now();
  }

  private requireRoom(id: RoomId): Room {
    const room = this.getRoom(id);
    if (!room) throw new Error(`room not found: ${id}`);
    return room;
  }

  private requireTask(id: Task["id"]): Task {
    const task = this.getTask(id);
    if (!task) throw new Error(`task not found: ${id}`);
    return task;
  }

  private notify(): void {
    if (this.closed) return;
    this.state.seq += 1;
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (err) {
        console.error("[studio] listener failed:", err);
      }
    }
    if (this.dataFile) {
      if (this.persistTimer) clearTimeout(this.persistTimer);
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null;
        this.persistNow();
      }, 200);
      this.persistTimer.unref?.();
    }
  }
}

/** 从存档里只挑安全、合法的档案字段，其余丢弃。 */
function sanitizeCatOverrides(record: Record<string, unknown>): Partial<Member> {
  const patch: Partial<Member> = {};
  const takeText = (
    key: "name" | "title" | "persona" | "catchphrase" | "greeting",
    max: number,
  ): void => {
    const value = record[key];
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length >= 1 && trimmed.length <= max) patch[key] = trimmed;
  };
  takeText("name", 8);
  takeText("title", 24);
  takeText("persona", 100);
  takeText("catchphrase", 50);
  takeText("greeting", 100);

  const accent = record["accent"];
  if (typeof accent === "string" && /^#[0-9a-fA-F]{6}$/.test(accent.trim())) {
    patch.accent = accent.trim();
  }
  const llmModel = record["llmModel"];
  if (typeof llmModel === "string" && llmModel.trim().length > 0 && llmModel.length <= 80) {
    patch.llmModel = llmModel.trim();
  }
  const llmTemperature = record["llmTemperature"];
  if (
    typeof llmTemperature === "number" &&
    Number.isFinite(llmTemperature) &&
    llmTemperature >= 0 &&
    llmTemperature <= 2
  ) {
    patch.llmTemperature = llmTemperature;
  }
  const tools = record["tools"];
  if (
    Array.isArray(tools) &&
    tools.length <= 24 &&
    tools.every((tool) => typeof tool === "string" && tool.length <= 80)
  ) {
    patch.tools = [...new Set(tools as string[])];
  }
  const skills = record["skills"];
  if (
    Array.isArray(skills) &&
    skills.length <= 12 &&
    skills.every((skill) => typeof skill === "string" && skill.length <= 40)
  ) {
    patch.skills = [...new Set(skills as string[])];
  }
  return patch;
}
