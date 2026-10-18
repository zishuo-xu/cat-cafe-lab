/**
 * Cat Café Lab — 领域契约。
 *
 * 这个文件是唯一契约：其他人只读。要改它，先找 Lead。
 * 约定：所有 import 都带 .ts 后缀；不用 enum / namespace / 参数属性。
 */

// ───────────────────────── IDs ─────────────────────────

export type CatId = string;
export type RoomId = string;
export type TaskId = string;
export type MessageId = string;
export type ArtifactId = string;
export type HandoffId = string;
export type MemoryId = string;
export type StepId = string;

/** 消息作者：某只猫、铲屎官、或系统。 */
export type AuthorId = CatId | "user" | "system";

// ───────────────────────── 猫 ─────────────────────────

export type Role = "architect" | "reviewer" | "designer" | "implementer";

export type CatModel = "claude" | "gpt" | "gemini" | "opencode";

export interface Cat {
  id: CatId;
  name: string;
  species: string;
  role: Role;
  /** 角色定位，如「主架构师 / 主理猫」。 */
  title: string;
  model: CatModel;
  /** 一句话人格。 */
  persona: string;
  /** 口头禅，前端可展示在 hover 上。 */
  catchphrase: string;
  /** 主题色 hex，前端用于头像环 / 名字 / 气泡描边。 */
  accent: string;
  /** 头像风格 key，前端据此生成内联 SVG。 */
  avatar: "ragdoll" | "mainecoon" | "siamese" | "golden";
  /** 初次进房时的招呼语。 */
  greeting: string;
  /** 真实模式下这只猫使用的模型 id；空/缺省时用全局 LLM_MODEL。 */
  llmModel?: string;
  /** 真实模式下这只猫的温度；缺省时用全局。 */
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
  catIds: CatId[];
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
  /** 被 @ 的猫；空数组表示没有显式点名。 */
  mentions: CatId[];
  taskId?: TaskId;
  handoffId?: HandoffId;
  artifactId?: ArtifactId;
  /** kind === "tool" 时指向 ToolCall。 */
  toolCallId?: ToolCall["id"];
  at: number;
}

// ───────────────────────── 任务与阶段 ─────────────────────────

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
  owner: CatId;
  status: StepStatus;
  startedAt?: number;
  doneAt?: number;
}

export type TaskStatus = "active" | "done" | "stalled";

export interface TaskGit {
  /** 任务分支（catcafe/<taskId>）。 */
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
  owner: CatId;
  steps: TaskStep[];
  createdAt: number;
  updatedAt: number;
  doneAt?: number;
  /** git 工作流状态（仅 git 工作区）。 */
  git?: TaskGit;
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
  from: CatId;
  to: CatId;
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
  author: CatId;
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

export interface StudioState {
  rooms: Room[];
  cats: Cat[];
  messages: Message[];
  tasks: Task[];
  handoffs: Handoff[];
  artifacts: Artifact[];
  memory: MemoryEntry[];
  /** 沙盒工具调用记录（写文件 / 跑命令）。 */
  toolCalls: ToolCall[];
  /** roomId -> 正在打字的猫（同一房间同时只有一只猫打字）。 */
  typing: Record<RoomId, CatId | null>;
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
  | "nudge";

export interface Trigger {
  kind: TriggerKind;
  roomId: RoomId;
  taskId?: TaskId;
  /** 触发这条轮次的消息 / 交接 / 产物。 */
  text?: string;
  mentions?: CatId[];
  fromCatId?: CatId;
  handoff?: HandoffCard;
  artifact?: Artifact;
  review?: { verdict: ReviewVerdict; findings: ReviewFinding[] };
  /** trigger.kind === "tool_result" 时，本轮拿到的工具回执。 */
  toolResults?: ToolRunResult[];
}

export interface TurnContext {
  cat: Cat;
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
  /** 这只猫当前可用的工具（已按权限过滤）。 */
  availableTools: ToolDefinition[];
  /** 这只猫挂载的技能包。 */
  skills: Skill[];
  /** 场景数据（mock brain 用于取台词模板）。 */
  scenario: Scenario | null;
}

export type CatTurn =
  | { kind: "message"; text: string; mentions?: CatId[]; delayMs?: number }
  | {
      kind: "tool";
      tool: ToolName;
      input: Record<string, unknown>;
      /** 人话摘要，如「写入 src/remember.js」；缺省由工具名生成。 */
      label?: string;
      /** 执行后可选的伴随说明。 */
      text?: string;
      mentions?: CatId[];
      delayMs?: number;
    }
  | {
      kind: "handoff";
      to: CatId;
      card: HandoffCard;
      /** 可选的伴随说明。 */
      text?: string;
      /**
       * 演示埋点：这次交接故意没 @ 到人（只写入卡片，不唤醒接收猫）。
       * driver 会让任务进入 stalled，等铲屎官「催一下」再补救。
       */
      fault?: "missed_mention";
      delayMs?: number;
    }
  | {
      kind: "artifact";
      artifact: { kind: ArtifactKind; title: string; body: string };
      text?: string;
      mentions?: CatId[];
      delayMs?: number;
    }
  | {
      kind: "review";
      verdict: ReviewVerdict;
      title: string;
      findings: ReviewFinding[];
      text: string;
      mentions?: CatId[];
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

export interface CatBrain {
  readonly mode: BrainMode;
  think(ctx: TurnContext): Promise<CatTurn[]>;
}

// ───────────────────────── 场景（mock 演出的数据） ─────────────────────────

export interface ScenarioBeat {
  /** 在哪个阶段播放。 */
  stage: TaskStage;
  cat: CatId;
  turn: CatTurn;
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

export type EngineEvent =
  | { type: "user_message"; roomId: RoomId; text: string; mentions: CatId[] }
  | { type: "task_created"; roomId: RoomId; taskId: TaskId }
  | { type: "nudge"; taskId: TaskId };

export interface Driver {
  /** 提交一个外部事件；内部按房间串行处理。 */
  submit(event: EngineEvent): void;
  /** 就绪后 resolve（测试用）。 */
  whenIdle(): Promise<void>;
  /** 卡住判定阈值（毫秒）。 */
  readonly stallMs: number;
}

// ───────────────────────── 配置 ─────────────────────────

export interface LlmSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
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
  catId: CatId;
  tool: ToolName;
  input: Record<string, unknown>;
  label: string;
  status: "pending" | "running" | "ok" | "error" | "rejected";
  exitCode?: number;
  /** 截断后的输出（stdout + stderr）。 */
  output?: string;
  startedAt: number;
  finishedAt?: number;
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
  /** 任务开始时是否创建 catcafe/<taskId> 分支（仅读写 git 仓库生效）。 */
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

/** 审批闸门：driver 发起，HTTP 层负责 resolve（铲屎官点按钮）。 */
export interface ApprovalGate {
  request(input: {
    callId: string;
    mode: ToolApprovalMode;
    tool: ToolName;
    label: string;
    catId: CatId;
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
  /** 是否允许猫在沙盒里执行工具（写文件 / 跑命令）。 */
  toolsEnabled: boolean;
  /** 审批策略：auto / commands / all。 */
  toolApproval: ToolApprovalMode;
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
export type MockBrainFactory = (scenarios: Scenario[]) => CatBrain;

/** T4 导出：src/agents/llm-brain.ts */
export type LlmBrainFactory = (
  settings: LlmSettings,
  fallback: CatBrain,
) => CatBrain;

/** T1 导出：src/engine/driver.ts */
export type DriverFactory = (deps: {
  studio: import("../server/studio.ts").Studio;
  brain: CatBrain;
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
