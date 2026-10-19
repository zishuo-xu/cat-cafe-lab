/**
 * 运行时设置：模式 / 回复节奏 / LLM 连接。
 *
 * 安全约定：
 * - apiKey 只存在进程内存，绝不写盘、绝不出现在 getPublic() / 日志里；
 * - 落盘的只有 mode / speed / baseUrl / model / temperature（data/settings.json，0600）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createLlmBrain } from "../agents/llm-brain.ts";
import { createCliBrain } from "../agents/cli-brain.ts";
import type {
  BrainMode,
  CatBrain,
  LlmSettings,
  LlmTestResult,
  PublicSettings,
  ToolApprovalMode,
  SettingsApi,
  SettingsPatch,
  Speed,
  StudioSettings,
} from "../domain/types.ts";
import type { Studio } from "./studio.ts";

const SPEED_FACTOR: Record<Speed, number> = { slow: 1.7, normal: 1, fast: 0.5 };
const DEFAULT_VERSION = "0.1.0";

/** 可替换 brain：driver 只持这个壳，设置面板换模式时原地换芯。 */
export class SwitchableBrain implements CatBrain {
  private current: CatBrain;

  constructor(initial: CatBrain) {
    this.current = initial;
  }

  get mode(): BrainMode {
    return this.current.mode;
  }

  set(brain: CatBrain): void {
    this.current = brain;
  }

  think(ctx: Parameters<CatBrain["think"]>[0]): ReturnType<CatBrain["think"]> {
    return this.current.think(ctx);
  }
}

interface PersistedSettings {
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
  };
}

export interface SettingsStoreOptions {
  studio: Studio;
  mock: CatBrain;
  switchable: SwitchableBrain;
  settings: StudioSettings;
  dataDirAbs: string;
  port: number;
  /** CLI 引擎的工作目录（通常是沙盒）。 */
  cliCwd?: string;
}

export class SettingsStore implements SettingsApi {
  private mode: BrainMode;
  private speed: Speed;
  private toolsEnabled: boolean;
  private toolApproval: ToolApprovalMode;
  private streaming: boolean;
  private engine: "api" | "cli";
  private proactive: "off" | "watch";
  private proactiveIntervalMs: number;
  private baseUrl: string;
  private model: string;
  private temperature: number;
  private apiKey: string;
  private keySource: "env" | "ui" | null;

  private readonly studio: Studio;
  private readonly mock: CatBrain;
  private readonly switchable: SwitchableBrain;
  private readonly stallMs: number;
  private readonly dataDirAbs: string;
  private readonly port: number;
  private readonly cliCwd: string;
  private readonly file: string;
  private readonly envDefaults: boolean;
  /** 环境变量带来的自定义请求头（如 opencode zen 的 session）；面板不可见、不落盘。 */
  private readonly envHeaders: Record<string, string> | undefined;
  private readonly version: string;

  constructor(opts: SettingsStoreOptions) {
    this.studio = opts.studio;
    this.mock = opts.mock;
    this.switchable = opts.switchable;
    this.stallMs = opts.settings.stallMs;
    this.dataDirAbs = opts.dataDirAbs;
    this.port = opts.port;
    this.cliCwd = opts.cliCwd ?? opts.dataDirAbs;
    this.file = join(opts.dataDirAbs, "settings.json");
    this.envDefaults = Boolean(opts.settings.llm);
    this.envHeaders = opts.settings.llm?.headers;
    this.version = readVersion();

    const persisted = this.load();
    const env = opts.settings.llm;

    this.mode = persisted.mode ?? opts.settings.mode;
    this.speed = persisted.speed ?? "normal";
    this.toolsEnabled = persisted.toolsEnabled ?? opts.settings.toolsEnabled ?? true;
    this.toolApproval = persisted.toolApproval ?? opts.settings.toolApproval ?? "commands";
    this.streaming = persisted.streaming ?? true;
    this.engine = persisted.engine === "cli" ? "cli" : "api";
    this.proactive = persisted.proactive === "watch" ? "watch" : "off";
    this.proactiveIntervalMs = persisted.proactiveIntervalMs ?? 60_000;
    this.baseUrl = persisted.llm?.baseUrl ?? env?.baseUrl ?? "";
    this.model = persisted.llm?.model ?? env?.model ?? "";
    this.temperature = clampTemperature(
      persisted.llm?.temperature ?? env?.temperature ?? 0.8,
    );
    this.apiKey = env?.apiKey ?? "";
    this.keySource = this.apiKey ? "env" : null;

    // 存了 llm 模式但配置不完整（比如换机器、清过配置），回落到演出模式。
    if (this.mode === "llm" && !this.hasLlmConfig()) this.mode = "mock";

    this.applyBrain();
    this.studio.setMode(this.mode);
  }

  factor(): number {
    return SPEED_FACTOR[this.speed];
  }

  toolsOn(): boolean {
    return this.toolsEnabled;
  }

  approvalMode(): ToolApprovalMode {
    return this.toolApproval;
  }

  streamingOn(): boolean {
    return this.streaming;
  }

  engineKind(): "api" | "cli" {
    return this.engine;
  }

  proactiveMode(): { mode: "off" | "watch"; intervalMs: number } {
    return { mode: this.proactive, intervalMs: this.proactiveIntervalMs };
  }

  getPublic(): PublicSettings {
    return {
      mode: this.mode,
      speed: this.speed,
      llm: {
        baseUrl: this.baseUrl,
        model: this.model,
        temperature: this.temperature,
        hasKey: this.apiKey.length > 0,
        keySource: this.keySource,
      },
      stallMs: this.stallMs,
      toolsEnabled: this.toolsEnabled,
      toolApproval: this.toolApproval,
      streaming: this.streaming,
      engine: this.engine,
      proactive: this.proactive,
      proactiveIntervalMs: this.proactiveIntervalMs,
      port: this.port,
      dataDir: this.dataDirAbs,
      version: this.version,
      node: process.version,
      startedAt: this.studio.state.startedAt,
      envDefaults: this.envDefaults,
    };
  }

  async update(patch: SettingsPatch): Promise<PublicSettings> {
    if (patch.mode !== undefined && patch.mode !== "mock" && patch.mode !== "llm") {
      throw new Error("mode 只能是 mock 或 llm");
    }
    if (patch.streaming !== undefined && typeof patch.streaming !== "boolean") {
      throw new Error("streaming 必须是布尔值");
    }
    if (patch.engine !== undefined && patch.engine !== "api" && patch.engine !== "cli") {
      throw new Error("engine 只能是 api 或 cli");
    }
    if (patch.proactive !== undefined && patch.proactive !== "off" && patch.proactive !== "watch") {
      throw new Error("proactive 只能是 off 或 watch");
    }
    if (
      patch.proactiveIntervalMs !== undefined &&
      (!Number.isFinite(patch.proactiveIntervalMs) || patch.proactiveIntervalMs < 5000)
    ) {
      throw new Error("proactiveIntervalMs 至少 5000 毫秒");
    }
    if (patch.speed !== undefined && !(patch.speed in SPEED_FACTOR)) {
      throw new Error("speed 只能是 slow / normal / fast");
    }
    if (patch.toolsEnabled !== undefined && typeof patch.toolsEnabled !== "boolean") {
      throw new Error("toolsEnabled 必须是布尔值");
    }
    if (
      patch.toolApproval !== undefined &&
      patch.toolApproval !== "auto" &&
      patch.toolApproval !== "commands" &&
      patch.toolApproval !== "all"
    ) {
      throw new Error("toolApproval 只能是 auto / commands / all");
    }

    const nextMode = patch.mode ?? this.mode;
    const nextSpeed = patch.speed ?? this.speed;
    const nextToolsEnabled = patch.toolsEnabled ?? this.toolsEnabled;
    const nextStreaming = patch.streaming ?? this.streaming;
    const nextEngine = patch.engine ?? this.engine;
    const nextProactive = patch.proactive ?? this.proactive;
    const nextProactiveIntervalMs = patch.proactiveIntervalMs ?? this.proactiveIntervalMs;
    const nextToolApproval = patch.toolApproval ?? this.toolApproval;

    let baseUrl = this.baseUrl;
    let model = this.model;
    let temperature = this.temperature;
    let apiKey = this.apiKey;
    let keySource = this.keySource;

    const llm = patch.llm;
    if (llm) {
      if (llm.baseUrl !== undefined) {
        baseUrl = String(llm.baseUrl).trim().replace(/\/+$/, "");
        if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
          throw new Error("Base URL 需要以 http:// 或 https:// 开头");
        }
      }
      if (llm.model !== undefined) model = String(llm.model).trim();
      if (llm.temperature !== undefined) {
        const value = Number(llm.temperature);
        if (!Number.isFinite(value)) throw new Error("温度必须是数字");
        temperature = clampTemperature(value);
      }
      if (llm.clearKey) {
        apiKey = "";
        keySource = null;
      } else if (typeof llm.apiKey === "string" && llm.apiKey.trim().length > 0) {
        apiKey = llm.apiKey.trim();
        keySource = "ui";
      }
    }

    if (nextMode === "llm" && !(baseUrl && model)) {
      throw new Error("切到真实模式前，请先填写 Base URL 和模型名");
    }

    const llmChanged =
      baseUrl !== this.baseUrl ||
      model !== this.model ||
      temperature !== this.temperature ||
      apiKey !== this.apiKey ||
      nextStreaming !== this.streaming ||
      nextEngine !== this.engine;

    this.mode = nextMode;
    this.speed = nextSpeed;
    this.toolsEnabled = nextToolsEnabled;
    this.streaming = nextStreaming;
    this.engine = nextEngine;
    this.proactive = nextProactive;
    this.proactiveIntervalMs = nextProactiveIntervalMs;
    this.toolApproval = nextToolApproval;
    this.baseUrl = baseUrl;
    this.model = model;
    this.temperature = temperature;
    this.apiKey = apiKey;
    this.keySource = keySource;

    if (llmChanged || patch.mode !== undefined) this.applyBrain();
    this.studio.setMode(this.mode);
    this.persist();
    return this.getPublic();
  }

  async test(draft: {
    baseUrl: string;
    model: string;
    apiKey?: string;
  }): Promise<LlmTestResult> {
    const baseUrl = String(draft.baseUrl ?? "").trim().replace(/\/+$/, "");
    const model = String(draft.model ?? "").trim();
    const apiKey = draft.apiKey?.trim() || this.apiKey;

    if (!baseUrl || !model) {
      return { ok: false, latencyMs: 0, detail: "请先填写 Base URL 和模型名" };
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      return { ok: false, latencyMs: 0, detail: "Base URL 需要以 http:// 或 https:// 开头" };
    }

    const startedAt = Date.now();
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(8000),
      });
      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        return {
          ok: false,
          latencyMs,
          detail: `端点返回 HTTP ${response.status} ${response.statusText}`.trim(),
        };
      }
      let detail = "连接成功";
      try {
        const body = (await response.json()) as { data?: unknown[] };
        if (Array.isArray(body.data)) detail = `连接成功，可用模型 ${body.data.length} 个`;
      } catch {
        // 端点不返回 JSON 也不影响连通性结论。
      }
      return { ok: true, latencyMs, detail };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      return { ok: false, latencyMs, detail: `连接失败：${sanitizeError(err, apiKey)}` };
    }
  }

  // ── 内部 ──────────────────────────────────────────────

  private hasLlmConfig(): boolean {
    return this.baseUrl.length > 0 && this.model.length > 0;
  }

  private applyBrain(): void {
    const streamingEnabled = this.streaming;
    if (this.mode === "llm") {
      const settings: LlmSettings = {
        baseUrl: this.baseUrl,
        model: this.model,
        apiKey: this.apiKey,
        temperature: this.temperature,
        ...(this.envHeaders ? { headers: this.envHeaders } : {}),
      };
      if (this.engine === "cli") {
        // CLI 大脑：起 `claude -p` 子进程。工作目录用沙盒，避免碰到用户仓库。
        this.switchable.set(
          createCliBrain(settings, this.mock, {
            cwd: this.cliCwd,
            ...(this.envHeaders ? { env: this.envHeaders } : {}),
          }),
        );
      } else {
        this.switchable.set(
          createLlmBrain(settings, this.mock, {
            // 流式：仅在真有 ctx.onDelta 时才发流式请求（见 llm-brain 内部判断）。
            get streaming() {
              return streamingEnabled;
            },
          }),
        );
      }
    } else {
      this.switchable.set(this.mock);
    }
  }

  private load(): PersistedSettings {
    if (!existsSync(this.file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as PersistedSettings;
      if (!parsed || typeof parsed !== "object") return {};
      return parsed;
    } catch (err) {
      console.error("[settings] load failed, using defaults:", err);
      return {};
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const payload: PersistedSettings = {
        mode: this.mode,
        speed: this.speed,
        toolsEnabled: this.toolsEnabled,
        toolApproval: this.toolApproval,
        streaming: this.streaming,
        engine: this.engine,
        proactive: this.proactive,
        proactiveIntervalMs: this.proactiveIntervalMs,
        llm: {
          baseUrl: this.baseUrl,
          model: this.model,
          temperature: this.temperature,
        },
      };
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      console.error("[settings] persist failed:", err);
    }
  }
}

function clampTemperature(value: number): number {
  if (!Number.isFinite(value)) return 0.8;
  return Math.min(2, Math.max(0, value));
}

function sanitizeError(err: unknown, apiKey: string): string {
  let message = err instanceof Error ? err.message : String(err);
  if (apiKey) message = message.split(apiKey).join("***");
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

function readVersion(): string {
  try {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : DEFAULT_VERSION;
  } catch {
    return DEFAULT_VERSION;
  }
}
