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
}

// ───────────────────────── 房间与消息 ─────────────────────────

export interface Room {
  id: RoomId;
  name: string;
  topic: string;
  catIds: CatId[];
  createdAt: number;
}

export type MessageKind =
  | "chat"
  | "handoff"
  | "review"
  | "decision"
  | "artifact"
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
  /** 场景数据（mock brain 用于取台词模板）。 */
  scenario: Scenario | null;
}

export type CatTurn =
  | { kind: "message"; text: string; mentions?: CatId[]; delayMs?: number }
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
}

// ───────────────────────── 运行时设置（设置面板） ─────────────────────────

/** 回复节奏：只影响打字/思考延迟，不影响协作逻辑。 */
export type Speed = "slow" | "normal" | "fast";

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
}) => Driver;
