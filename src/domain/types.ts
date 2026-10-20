/**
 * Delivery Lab — 领域契约。
 *
 * 这个文件是唯一契约：其他人只读。要改它，先找 Lead。
 * 约定：所有 import 都带 .ts 后缀；不用 enum / namespace / 参数属性。
 */

// ───────────────────────── IDs ─────────────────────────

export type MemberId = string;
export type RoomId = string;
export type TaskId = string;
export type MessageId = string;
export type ArtifactId = string;
export type HandoffId = string;
export type MemoryId = string;
export type StepId = string;

/** 消息作者：某个成员、负责人、或系统。 */
export type AuthorId = MemberId | "user" | "system";

// ───────────────────────── 成员 ─────────────────────────

export type Role = "architect" | "reviewer" | "designer" | "implementer";

export type CatModel = "claude" | "gpt" | "gemini" | "opencode";

export interface Member {
  id: MemberId;
  name: string;
  discipline: string;
  role: Role;
  /** 角色定位，如「主架构师 / 架构师」。 */
  title: string;
  model: CatModel;
  /** 一句话人格。 */
  persona: string;
  /** 口头禅，前端可展示在 hover 上。 */
  catchphrase: string;
  /** 主题色 hex，前端用于头像环 / 名字 / 气泡描边。 */
  accent: string;
  /** 头像风格 key，前端据此生成内联 SVG。 */
  /** 头像标识：决定前端用哪张 SVG。 */
  avatar: "architect" | "reviewer" | "designer" | "implementer";
  /** 初次进房时的招呼语。 */
  greeting: string;
  /** 真实模式下这个成员使用的模型 id；空/缺省时用全局 LLM_MODEL。 */
  llmModel?: string;
  /** 真实模式下这个成员的温度；缺省时用全局。 */
  llmTemperature?: number;
  /** 允许使用的工具名；缺省 = 全部允许（内置工具默认全开）。 */
  tools?: string[];
  /** 挂载的技能包 id；缺省 = 使用 CATS 里的默认配置。 */
  skills?: string[];
}

// ───────────────────────── 房间与消息 ─────────────────────────

export interface Room {
  id: RoomId;
  name: string;
  topic: string;
  catIds: MemberId[];
  /** 绑定的工作区 id；缺省用内置沙盒。 */
  workspaceId?: string;
  createdAt: number;
}

export type MessageKind =
  | "chat"
  | "handoff"
  | "review"
  | "decision"
  | "artifact"
  | "tool"
  | "system";

export interface Message {
  id: MessageId;
  roomId: RoomId;
  author: AuthorId;
  kind: MessageKind;
  text: string;
  /** 被 @ 的成员；空数组表示没有显式点名。 */
  mentions: MemberId[];
  taskId?: TaskId;
  handoffId?: HandoffId;
  artifactId?: ArtifactId;
  /** kind === "tool" 时指向 ToolCall。 */
  toolCallId?: ToolCall["id"];
  at: number;
}

// ───────────────────────── 任务与阶段 ─────────────────────────

export const STAGE_TEXT: Record<TaskStage, string> = {
  intake: "接单",
  planning: "规划",
  working: "实现",
  reviewing: "评审",
  revising: "修订",
  done: "完成",
};

export type TaskStage =
  | "intake"
  | "planning"
  | "working"
  | "reviewing"
  | "revising"
  | "done";

export type StepStatus = "pending" | "active" | "done";

export interface TaskStep {
  id: StepId;
  stage: TaskStage;
  owner: MemberId;
  status: StepStatus;
  startedAt?: number;
  doneAt?: number;
}

export type TaskStatus = "active" | "done" | "stalled";

export interface TaskGit {
  /** 任务分支（deliverylab/<taskId>）。 */
  branch?: string;
  baseBranch?: string;
  baseCommit?: string;
  /** 人工确认后产生的 commit。 */
  commit?: string;
  committedAt?: number;
  /** 已回滚（stash 可恢复）的时间。 */
  stashedAt?: number;
  /** 建分支失败等提示。 */
  error?: string;
}

export interface Task {
  id: TaskId;
  roomId: RoomId;
  title: string;
  brief: string;
  scenarioId: string;
  status: TaskStatus;
  stage: TaskStage;
  /** 当前阶段的负责人。 */
  owner: MemberId;
  steps: TaskStep[];
  createdAt: number;
  updatedAt: number;
  doneAt?: number;
  /** git 工作流状态（仅 git 工作区）。 */
  git?: TaskGit;
  /**
   * 任务的模型健康度。
   *
   * 背景：模型调用失败会静默降级回 mock 台词，任务照常跑完，但产出质量掉档。
   * 以前只有 LlmCall 上留了 `degraded`，负责人不翻任务轨迹根本不知道
   * 「这段话其实不是模型说的」。这里把降级汇总到任务本身，让它在任务卡上直接可见。
   *
   * 只统计真实模式（engine=api/cli）的降级；演出模式没有降级概念，不会有这个字段。
   */
  health?: TaskHealth;
}

/** 任务级模型健康度汇总。 */
export interface TaskHealth {
  /** 累计降级次数（一次 think 降级算一次）。 */
  degradedCount: number;
  /** 最近一次降级的原因（截断后的简短原因）。 */
  lastDegradeReason?: string;
  /** 最近一次降级发生的阶段，便于定位是哪一段不可信。 */
  lastDegradeStage?: TaskStage;
  /** 是否已把「产出可能不可信」作为系统消息告知过负责人（避免刷屏）。 */
  warned: boolean;
}

// ───────────────────────── 交接卡与产物 ─────────────────────────

/** 结构化交接卡：五栏缺一不可。 */
export interface HandoffCard {
  what: string;
  why: string;
  tradeoff: string;
  openQuestions: string[];
  nextAction: string;
}

export interface Handoff {
  id: HandoffId;
  taskId: TaskId;
  from: MemberId;
  to: MemberId;
  card: HandoffCard;
  createdAt: number;
}

export type ArtifactKind = "spec" | "design" | "patch" | "review" | "decision";

export interface Artifact {
  id: ArtifactId;
  taskId: TaskId;
  kind: ArtifactKind;
  title: string;
  /** 纯文本 / 轻量 markdown（前端渲染有限语法）。 */
  body: string;
  author: MemberId;
  version: number;
  createdAt: number;
}

export type Severity = "blocker" | "minor";

export interface ReviewFinding {
  severity: Severity;
  title: string;
  detail: string;
}

export type ReviewVerdict = "approve" | "request_changes";

// ───────────────────────── 记忆 ─────────────────────────

export type MemoryKind = "decision" | "lesson" | "preference";

export interface MemoryEntry {
  id: MemoryId;
  kind: MemoryKind;
  title: string;
  body: string;
  tags: string[];
  sourceTaskId?: TaskId;
  createdAt: number;
}

// ───────────────────────── 全量状态 ─────────────────────────

export type BrainMode = "mock" | "llm";

/**
 * 每个成员的「近期经历」：跨任务的连续记忆。
 *
 * 为什么需要：现在每个成员每次任务都是失忆的——它看不到"我上次参与过什么、做过哪些决定、
 * 踩过什么坑"。Member Café 的经验是「任何一个成员新开窗口，5 分钟内能进入状态」，
 * 靠的就是这种跨会话的连续性。
 */
export interface MemberEpisode {
  /** 任务 id。 */
  taskId: TaskId;
  /** 任务标题（便于人类和模型快速识别）。 */
  title: string;
  /** 这个成员在该任务里做了什么（从它自己的消息/产物里摘要）。 */
  summary: string;
  /** 最终结果。 */
  outcome: "done" | "abandoned" | "open";
  /** 结束时的时间戳。 */
  at: number;
}

export interface MemberSession {
  catId: MemberId;
  /** 最近参与的 N 个任务（新的在前）。 */
  episodes: MemberEpisode[];
  /** 这个成员自己的长期记忆（从共享记忆里分流出来的一部分）。 */
  lessons: MemoryEntry[];
  updatedAt: number;
}

export interface StudioState {
  rooms: Room[];
  cats: Member[];
  messages: Message[];
  tasks: Task[];
  handoffs: Handoff[];
  artifacts: Artifact[];
  memory: MemoryEntry[];
  /** 每个成员的跨任务会话记忆。 */
  catSessions: Record<MemberId, MemberSession>;
  /** 沙盒工具调用记录（写文件 / 跑命令）。 */
  toolCalls: ToolCall[];
  /** 模型调用记录（可观测性）。 */
  llmCalls: LlmCall[];
  /** roomId -> 正在打字的成员（同一房间同时只有一个成员打字）。 */
  typing: Record<RoomId, MemberId | null>;
  /**
   * 流式草稿：成员正在说但还没成型的文字。
   * 最终消息落库时清空；为空对象表示没有草稿。
   */
  drafts: Record<RoomId, { catId: MemberId; text: string; at: number } | null>;
  /** 单调递增，SSE 用。 */
  seq: number;
  mode: BrainMode;
  startedAt: number;
}

// ───────────────────────── Brain 契约 ─────────────────────────

export type TriggerKind =
  | "user_message"
  | "task_created"
  | "handoff"
  | "artifact"
  | "review_result"
  | "tool_result"
  | "nudge"
  /** 成员自己巡查时决定要说话（主动协作）。 */
  | "proactive";

export interface Trigger {
  kind: TriggerKind;
  roomId: RoomId;
  taskId?: TaskId;
  /** 触发这条轮次的消息 / 交接 / 产物。 */
  text?: string;
  mentions?: MemberId[];
  fromMemberId?: MemberId;
  handoff?: HandoffCard;
  artifact?: Artifact;
  review?: { verdict: ReviewVerdict; findings: ReviewFinding[] };
  /** trigger.kind === "tool_result" 时，本轮拿到的工具回执。 */
  toolResults?: ToolRunResult[];
}

export interface TurnContext {
  cat: Member;
  room: Room;
  task: Task | null;
  trigger: Trigger;
  /** 本房间最近消息，时间正序，最多 24 条。 */
  recentMessages: Message[];
  /** 与当前任务相关的记忆，最多 12 条。 */
  memory: MemoryEntry[];
  /** 当前任务的交接卡与产物。 */
  handoffs: Handoff[];
  artifacts: Artifact[];
  /** 最近的工具回执（真实模式下用来继续推理）。 */
  recentToolResults: ToolRunResult[];
  /** 这个成员当前可用的工具（已按权限过滤）。 */
  availableTools: ToolDefinition[];
  /** 这个成员挂载的技能包。 */
  skills: Skill[];
  /** 这个成员的跨任务经历（最近几个任务 + 自己的教训）。 */
  session: MemberSession | null;
  /** 房间里所有成员的 id 与名字（prompt 里用来对齐称呼，避免模型自创名字）。 */
  roomCats: Array<{ id: MemberId; name: string; role: Role }>;
  /**
   * 流式增量回调（可选）。brain 在生成过程中可以把"正在说的话"陆续推过来，
   * 前端渲染成半透明草稿气泡；最终 turn 落库后草稿会被正式消息替换。
   *
   * mock brain 不需要实现它；llm-brain 只在支持流式时调用。
   */
  onDelta?: (delta: DeltaUpdate) => void;
  /**
   * 用量回报（可选）。brain 在调用结束时回报 token / 降级 / 重试信息，
   * driver 落成 LlmCall 记录，前端据此展示"这个成员这次想了多久、多贵"。
   */
  onReport?: (report: BrainReport) => void;
  /** 场景数据（mock brain 用于取台词模板）。 */
  scenario: Scenario | null;
}

export type AgentTurn =
  | { kind: "message"; text: string; mentions?: MemberId[]; delayMs?: number }
  /**
   * 主动巡查时的「我不说话」。
   *
   * 巡查唤醒不是任务推进，成员有权判断"这里不需要我"。
   * 返回 silence 不会产生任何消息，只记一条审计（避免"它为什么不说话"无从查证）。
   */
  | { kind: "silence"; reason?: string }
  | {
      kind: "tool";
      tool: ToolName;
      input: Record<string, unknown>;
      /** 人话摘要，如「写入 src/remember.js」；缺省由工具名生成。 */
      label?: string;
      /** 执行后可选的伴随说明。 */
      text?: string;
      mentions?: MemberId[];
      delayMs?: number;
    }
  | {
      kind: "handoff";
      to: MemberId;
      card: HandoffCard;
      /** 可选的伴随说明。 */
      text?: string;
      /**
       * 演示埋点：这次交接故意没 @ 到人（只写入卡片，不唤醒接收方）。
       * driver 会让任务进入 stalled，等负责人「催一下」再补救。
       */
      fault?: "missed_mention";
      delayMs?: number;
    }
  | {
      kind: "artifact";
      artifact: { kind: ArtifactKind; title: string; body: string };
      text?: string;
      mentions?: MemberId[];
      delayMs?: number;
    }
  | {
      kind: "review";
      verdict: ReviewVerdict;
      title: string;
      findings: ReviewFinding[];
      text: string;
      mentions?: MemberId[];
      delayMs?: number;
    }
  | {
      kind: "decision";
      artifact: { title: string; body: string };
      text: string;
      memory: Array<{ kind: MemoryKind; title: string; body: string; tags: string[] }>;
      delayMs?: number;
    }
  | {
      kind: "memory";
      memory: { kind: MemoryKind; title: string; body: string; tags: string[] };
      text: string;
      delayMs?: number;
    };

/** 流式增量：一个成员正在打的字。 */
export interface DeltaUpdate {
  catId: MemberId;
  roomId: RoomId;
  /** 已累计的完整草稿文本（不是本段增量）。 */
  text: string;
}

/**
 * 一次 think 的副产物（用量 / 降级 / 重试）。
 * brain 通过 ctx.onReport 回传，driver 落成 LlmCall 记录。
 */
export interface BrainReport {
  model?: string;
  engine?: "api" | "cli";
  inputTokens?: number;
  outputTokens?: number;
  streamed?: boolean;
  degraded?: boolean;
  degradeReason?: string;
  retried?: boolean;
  error?: string;
}

export interface AgentBrain {
  readonly mode: BrainMode;
  think(ctx: TurnContext): Promise<AgentTurn[]>;
}

// ───────────────────────── 场景（mock 演出的数据） ─────────────────────────

export interface ScenarioBeat {
  /** 在哪个阶段播放。 */
  stage: TaskStage;
  cat: MemberId;
  turn: AgentTurn;
  /** 演示埋点：这一拍故意漏 @ / 掉线。 */
  fault?: "missed_mention" | "silent_drop";
}

export interface Scenario {
  id: string;
  name: string;
  /** 用户没想好时，UI 里可一键填入的示例需求。 */
  sampleBrief: string;
  tags: string[];
  /** 按阶段顺序播放的拍子；mock brain 按 stage 取。 */
  beats: ScenarioBeat[];
}

export interface ScenarioWithSource {
  scenario: Scenario;
  source: "builtin" | "custom";
}

// ───────────────────────── 引擎契约 ─────────────────────────

/** 负责人对「卡住 / 强制收尾」任务的处理方式。 */
export type TaskAction = "continue" | "pivot" | "close";

export type EngineEvent =
  | {
      type: "user_message";
      roomId: RoomId;
      text: string;
      mentions: MemberId[];
      /** 房间有活跃任务时，用户明确表示"我就是要说话"，跳过提醒。 */
      force?: boolean;
    }
  | { type: "task_action"; taskId: TaskId; action: TaskAction; note?: string }
  | { type: "task_created"; roomId: RoomId; taskId: TaskId }
  | { type: "nudge"; taskId: TaskId };

export interface Driver {
  /** 提交一个外部事件；内部按房间串行处理。 */
  submit(event: EngineEvent): void;
  /** 就绪后 resolve（测试用）。 */
  whenIdle(): Promise<void>;
  /** 卡住判定阈值（毫秒）。 */
  readonly stallMs: number;
  /** 启动 / 停止主动巡查（watch 模式）。 */
  setProactive(enabled: boolean, intervalMs?: number): void;
  /**
   * 手动触发一次巡查：把巡查任务排进队列后立即返回，不等执行完
   * （任务在跑时巡查本就该排队，等它跑完会让调用方以为卡死）。
   * 需要等待执行完成时用 whenIdle()。
   */
  patrol(): Promise<void>;
}

// ───────────────────────── 配置 ─────────────────────────

export interface LlmSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  /**
   * 额外请求头（如 opencode zen 要求 x-opencode-session）。
   * 值绝不回传前端、不进日志（与 apiKey 同等对待）。
   */
  headers?: Record<string, string>;
}

export interface StudioSettings {
  port: number;
  dataDir: string;
  mode: BrainMode;
  llm: LlmSettings | null;
  stallMs: number;
  /** 环境变量默认：是否允许沙盒工具执行。 */
  toolsEnabled?: boolean;
  /** 环境变量默认审批策略。 */
  toolApproval?: ToolApprovalMode;
}

// ───────────────────────── 运行时设置（设置面板） ─────────────────────────

/** 回复节奏：只影响打字/思考延迟，不影响协作逻辑。 */
export type Speed = "slow" | "normal" | "fast";

/** 内置沙盒工具。所有路径都相对沙盒根目录。 */
export type BuiltinToolName = "read_file" | "write_file" | "list_files" | "run_command";

/** 工具名：内置四种 + MCP 注册进来的动态名。 */
export type ToolName = BuiltinToolName | (string & {});

export interface ToolCall {
  id: string;
  taskId?: TaskId;
  catId: MemberId;
  tool: ToolName;
  input: Record<string, unknown>;
  label: string;
  status: "pending" | "running" | "ok" | "error" | "rejected";
  exitCode?: number;
  /** 截断后的输出（stdout + stderr）。 */
  output?: string;
  startedAt: number;
  finishedAt?: number;
  /** 进入待审批的时间（pending 状态）。 */
  approvalRequestedAt?: number;
  /** 负责人做出决定的时间。 */
  approvalDecidedAt?: number;
}

/**
 * 一次模型调用的记录（可观测性核心）。
 *
 * 记录"这个成员这一次想了多久、花了多少 token、有没有降级/重试"。
 * 这是协作层唯一能看清"钱和时间花在哪"的地方。
 */
export interface LlmCall {
  id: string;
  taskId?: TaskId;
  catId: MemberId;
  /** 调用的意图：哪个阶段、因为什么被唤醒。 */
  stage?: TaskStage;
  trigger?: TriggerKind;
  model: string;
  engine: "api" | "cli";
  startedAt: number;
  finishedAt?: number;
  /** 耗时（毫秒）。 */
  durationMs?: number;
  /** token 用量（provider 返回才有）。 */
  inputTokens?: number;
  outputTokens?: number;
  /** 是否走了流式。 */
  streamed?: boolean;
  /** 是否降级到 mock。 */
  degraded?: boolean;
  /** 降级原因（只记简短原因，不记原文）。 */
  degradeReason?: string;
  /** 被 max_tokens 截断后重试过一次。 */
  retried?: boolean;
  /** 产出的 turn 数量与种类，便于看"这次想了什么"。 */
  turnKinds?: string[];
  /** 错误信息（如果有）。 */
  error?: string;
}

export interface SandboxFile {
  path: string;
  size: number;
}

export interface ToolResult {
  status: "ok" | "error" | "rejected";
  exitCode?: number;
  output: string;
}

/** driver 只依赖这个接口，测试时可以塞一个假的。 */
export interface SandboxRunner {
  execute(tool: ToolName, input: Record<string, unknown>): Promise<ToolResult>;
}

/** 工具目录里的一项：内置沙盒工具或 MCP server 暴露的工具。 */
export interface ToolDefinition {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: "safe" | "needs_approval";
  source: "sandbox" | "mcp";
  serverId?: string;
}

/** 工具注册表：driver / brain 只依赖这个。 */
export interface ToolRegistry {
  list(): ToolDefinition[];
  get(name: ToolName): ToolDefinition | undefined;
  execute(name: ToolName, input: Record<string, unknown>): Promise<ToolResult>;
}

/** 技能包：一段可注入 system prompt 的方法论。 */
export interface Skill {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

// ───────────────────────── 工作区（C 阶段） ─────────────────────────

export type WorkspacePolicy = "read-only" | "read-write";

export interface Workspace {
  id: string;
  name: string;
  /** 绝对路径；默认工作区是 data/workspace。 */
  root: string;
  policy: WorkspacePolicy;
  kind: "sandbox" | "repo";
  isGit: boolean;
  /** 任务开始时是否创建 deliverylab/<taskId> 分支（仅读写 git 仓库生效）。 */
  branchPerTask: boolean;
  createdAt: number;
}

export interface WorkspaceGitInfo {
  workspaceId: string;
  isGit: boolean;
  branch?: string;
  clean?: boolean;
  status?: string;
  diffStat?: string;
  lastCommit?: string;
  error?: string;
}

/** MCP server 配置（持久化到 data/mcp.json，不含敏感 key）。 */
export interface McpServerConfig {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  /** MCP 工具默认风险等级；默认 needs_approval。 */
  risk?: "safe" | "needs_approval";
  /** stdio：子进程环境变量（合并 process.env）。值绝不回传前端。 */
  env?: Record<string, string>;
  /** http：每个 JSON-RPC 请求附带的鉴权头。值绝不回传前端。 */
  headers?: Record<string, string>;
}

/** 一次工具执行的回执，喂回给 brain 做下一步判断。 */
export interface ToolRunResult {
  callId: string;
  tool: ToolName;
  status: ToolResult["status"];
  exitCode?: number;
  output: string;
}

/** 审批策略：auto=全自动；commands=跑命令要批；all=所有工具都要批。 */
export type ToolApprovalMode = "auto" | "commands" | "all";

export type ToolApprovalDecision = "approved" | "rejected";

/** 审批闸门：driver 发起，HTTP 层负责 resolve（负责人点按钮）。 */
export interface ApprovalGate {
  request(input: {
    callId: string;
    mode: ToolApprovalMode;
    tool: ToolName;
    label: string;
    catId: MemberId;
  }): Promise<ToolApprovalDecision>;
  resolve(callId: string, decision: ToolApprovalDecision): boolean;
}

/** 可安全回传给前端 / 落盘的设置（绝不含 apiKey）。 */
export interface PublicSettings {
  mode: BrainMode;
  speed: Speed;
  llm: {
    baseUrl: string;
    model: string;
    temperature: number;
    hasKey: boolean;
    keySource: "env" | "ui" | null;
  };
  stallMs: number;
  /** 是否允许成员在沙盒里执行工具（写文件 / 跑命令）。 */
  toolsEnabled: boolean;
  /** 审批策略：auto / commands / all。 */
  toolApproval: ToolApprovalMode;
  /** 真实模式是否用流式输出（真机首字/首句更快出现）。 */
  streaming: boolean;
  /**
   * 主动协作：成员在任务推进时会不会自己决定插话。
   * - "off"：完全被动（只有 @ 和交接才动）
   * - "watch"：巡查模式——在关键节点让其他成员判断"我要不要说话"
   */
  proactive: "off" | "watch";
  /** 巡查间隔（毫秒），只在 watch 模式生效。 */
  proactiveIntervalMs: number;
  /**
   * 真实模式的大脑实现：
   * - "api"：直接打 OpenAI 兼容 HTTP 接口（默认，轻量）
   * - "cli"：起 `claude -p` 子进程（自带工具与 agent 能力，但更重）
   */
  engine: "api" | "cli";
  port: number;
  dataDir: string;
  version: string;
  node: string;
  startedAt: number;
  /** 环境变量是否提供了 LLM 默认值。 */
  envDefaults: boolean;
}

export interface SettingsPatch {
  mode?: BrainMode;
  speed?: Speed;
  toolsEnabled?: boolean;
  toolApproval?: ToolApprovalMode;
  streaming?: boolean;
  engine?: "api" | "cli";
  proactive?: "off" | "watch";
  proactiveIntervalMs?: number;
  llm?: {
    baseUrl?: string;
    model?: string;
    temperature?: number;
    /** 留空表示不修改；只有非空字符串才会覆盖。 */
    apiKey?: string;
    clearKey?: boolean;
  };
}

export interface LlmTestResult {
  ok: boolean;
  latencyMs: number;
  detail: string;
}

/** HTTP 层依赖的最小设置接口，便于测试时替换。 */
export interface SettingsApi {
  getPublic(): PublicSettings;
  update(patch: SettingsPatch): Promise<PublicSettings>;
  test(draft: { baseUrl: string; model: string; apiKey?: string }): Promise<LlmTestResult>;
}

// ───────────────────────── 工厂签名（各模块导出） ─────────────────────────

/** T2 导出：src/agents/mock-brain.ts */
export type MockBrainFactory = (scenarios: Scenario[]) => AgentBrain;

/** T4 导出：src/agents/llm-brain.ts */
export type LlmBrainFactory = (
  settings: LlmSettings,
  fallback: AgentBrain,
) => AgentBrain;

/** T1 导出：src/engine/driver.ts */
export type DriverFactory = (deps: {
  studio: import("../server/studio.ts").Studio;
  brain: AgentBrain;
  wait?: (ms: number) => Promise<void>;
  stallMs?: number;
  /** 沙盒工具执行器；不传则 tool turn 直接报错（便于测试/降级）。 */
  sandbox?: SandboxRunner;
  /** 运行时开关：设置面板里可以关掉工具执行。 */
  toolsEnabled?: () => boolean;
  /** 审批策略；mock 剧本里的工具默认自动放行。 */
  approvalMode?: () => ToolApprovalMode;
  approvals?: ApprovalGate;
  /** 工具注册表（内置 + MCP）；不传则回落到 sandbox。 */
  tools?: ToolRegistry;
  /** 按 id 解析技能包。 */
  resolveSkill?: (id: string) => Skill | undefined;
}) => Driver;
