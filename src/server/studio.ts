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

import { ids } from "../domain/ids.ts";
import type {
  Artifact,
  ArtifactKind,
  BrainMode,
  Cat,
  CatId,
  Handoff,
  HandoffCard,
  MemoryEntry,
  MemoryKind,
  Message,
  MessageKind,
  Room,
  RoomId,
  StudioState,
  Task,
  TaskStage,
  TaskStep,
} from "../domain/types.ts";

const MAX_MESSAGES = 1500;

export interface StudioOptions {
  cats: Cat[];
  mode: BrainMode;
  dataDir?: string;
}

export interface AppendMessageInput {
  roomId: RoomId;
  author: Message["author"];
  kind: MessageKind;
  text: string;
  mentions?: CatId[];
  taskId?: Task["id"];
  handoffId?: Handoff["id"];
  artifactId?: Artifact["id"];
  at?: number;
}

export interface CreateTaskInput {
  roomId: RoomId;
  brief: string;
  scenarioId: string;
  title?: string;
}

/** 猫猫档案可编辑字段；id / role / avatar / species 不可改。 */
export interface CatPatch {
  name?: string;
  title?: string;
  persona?: string;
  catchphrase?: string;
  greeting?: string;
  accent?: string;
  llmModel?: string | null;
  llmTemperature?: number | null;
}

type Listener = (state: StudioState) => void;

function now(): number {
  return Date.now();
}

function freshState(cats: Cat[], mode: BrainMode): StudioState {
  const room: Room = {
    id: "room_cafe",
    name: "猫咖 · 客厅",
    topic: "把需求丢进来，猫猫们会在同一张桌子上把它做出来。",
    catIds: cats.map((c) => c.id),
    createdAt: now(),
  };
  return {
    rooms: [room],
    cats,
    messages: [],
    tasks: [],
    handoffs: [],
    artifacts: [],
    memory: [],
    typing: { [room.id]: null },
    seq: 0,
    mode,
    startedAt: now(),
  };
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

  getCat(id: CatId): Cat | undefined {
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

  updateTaskStage(taskId: Task["id"], stage: TaskStage, owner: CatId): Task {
    const task = this.requireTask(taskId);
    task.stage = stage;
    task.owner = owner;
    task.updatedAt = now();
    this.notify();
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

  addStep(taskId: Task["id"], input: { stage: TaskStage; owner: CatId }): TaskStep {
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
    from: CatId;
    to: CatId;
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
    author: CatId;
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

  // ── 写：易变状态 ──────────────────────────────────────

  setTyping(roomId: RoomId, catId: CatId | null): void {
    if (!this.state.typing[roomId] && !catId) return;
    if (this.state.typing[roomId] === catId) return;
    this.state.typing[roomId] = catId;
    this.notify();
  }

  /** 设置面板切换模式后同步给前端（SSE 会带出 state.mode）。 */
  setMode(mode: BrainMode): void {
    if (this.state.mode === mode) return;
    this.state.mode = mode;
    this.notify();
  }

  /**
   * 编辑猫猫档案（名字 / 称号 / 性格 / 口头禅 / 招呼语 / 主题色）与真实模式模型覆盖。
   * id、角色、头像、品种不可改。改名后 @ 解析会自动用新名字。
   */
  updateCat(catId: CatId, patch: CatPatch): Cat {
    const index = this.state.cats.findIndex((c) => c.id === catId);
    const current = this.state.cats[index];
    if (index < 0 || !current) throw new Error(`cat not found: ${catId}`);
    const next: Cat = { ...current };

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name.length < 1 || name.length > 8) throw new Error("名字需要 1–8 个字符");
      if (this.state.cats.some((c) => c.id !== catId && c.name === name)) {
        throw new Error(`名字「${name}」已经被其他猫用了`);
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

    this.state.cats[index] = next;
    this.notify();
    return next;
  }

  // ── 订阅 / 持久化 ─────────────────────────────────────

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  reset(): StudioState {
    this.state.rooms.splice(0, this.state.rooms.length, ...freshState(this.state.cats, this.state.mode).rooms);
    this.state.messages.length = 0;
    this.state.tasks.length = 0;
    this.state.handoffs.length = 0;
    this.state.artifacts.length = 0;
    this.state.memory.length = 0;
    this.state.typing = { room_cafe: null };
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
      text: "☕ 猫咖开门了。把需求丢进来，或者 @ 一只猫聊两句。",
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
      this.state.rooms = parsed.rooms as Room[];
      this.state.messages = parsed.messages as Message[];
      this.state.tasks = (parsed.tasks ?? []) as Task[];
      this.state.handoffs = (parsed.handoffs ?? []) as Handoff[];
      this.state.artifacts = (parsed.artifacts ?? []) as Artifact[];
      this.state.memory = (parsed.memory ?? []) as MemoryEntry[];
      this.state.typing = (parsed.typing ?? {}) as Record<RoomId, CatId | null>;

      // 猫猫档案：以代码里的 CATS 为底，只接受安全的字段覆盖。
      const baseCats = this.state.cats;
      const savedCats = Array.isArray(parsed.cats) ? (parsed.cats as unknown[]) : [];
      if (savedCats.length > 0) {
        const overrides = new Map<string, Partial<Cat>>();
        for (const raw of savedCats) {
          if (!raw || typeof raw !== "object") continue;
          const record = raw as Record<string, unknown>;
          if (typeof record["id"] !== "string") continue;
          const patch = sanitizeCatOverrides(record);
          if (Object.keys(patch).length > 0) overrides.set(record["id"], patch);
        }
        this.state.cats = this.state.cats.map((base) => {
          const patch = overrides.get(base.id);
          return patch ? { ...base, ...patch, id: base.id } : base;
        });
        // 防止手工改坏存档导致重名：重名的那只回退默认名。
        const seenNames = new Set<string>();
        for (const cat of this.state.cats) {
          if (seenNames.has(cat.name)) {
            const fallback = baseCats.find((c) => c.id === cat.id);
            if (fallback) cat.name = fallback.name;
          }
          seenNames.add(cat.name);
        }
      }

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
function sanitizeCatOverrides(record: Record<string, unknown>): Partial<Cat> {
  const patch: Partial<Cat> = {};
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
  return patch;
}
