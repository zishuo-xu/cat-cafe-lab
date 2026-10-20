/**
 * MCP server 管理：配置持久化、连接生命周期、把工具注册进注册表。
 *
 * 安全边界：
 * - 只有用户在本地设置里显式添加的 server 才会被启动；
 * - 支持 stdio 的 env 与 http 的 headers 鉴权，但**值绝不回传**：
 *   list() 只给 envKeys / headerKeys（键名），日志与错误信息由 client 统一脱敏；
 * - 含密钥的配置只持久化到 data/mcp.json（0600），不进 Studio 状态、不进 SSE；
 * - MCP 工具默认风险等级 needs_approval，模型主动调用会进审批队列。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { McpServerConfig, ToolDefinition } from "../domain/types.ts";
import type { ToolRegistryImpl } from "../tools/registry.ts";
import { McpClient } from "./client.ts";

export interface McpStatus {
  id: string;
  name: string;
  transport: "stdio" | "http";
  enabled: boolean;
  status: McpClient["status"];
  toolCount: number;
  lastError?: string;
  command?: string;
  args?: string[];
  url?: string;
  risk: "safe" | "needs_approval";
  /** 只有键名，永远不含值。 */
  envKeys: string[];
  /** 只有键名，永远不含值。 */
  headerKeys: string[];
}

export interface McpInput {
  id?: unknown;
  name?: unknown;
  transport?: unknown;
  command?: unknown;
  args?: unknown;
  url?: unknown;
  enabled?: unknown;
  risk?: unknown;
  /** stdio：子进程环境变量；值不回传。 */
  env?: unknown;
  /** http：每个 JSON-RPC 请求附带的鉴权头；值不回传。 */
  headers?: unknown;
}

export interface McpTestResult {
  ok: boolean;
  tools: Array<{ name: string; description: string }>;
  error?: string;
}

export class McpManager {
  private readonly registry: ToolRegistryImpl;
  private readonly file: string | null;
  private readonly configs: McpServerConfig[] = [];
  private readonly clients = new Map<string, McpClient>();

  constructor(registry: ToolRegistryImpl, dataDir?: string) {
    this.registry = registry;
    this.file = dataDir ? join(dataDir, "mcp.json") : null;
    for (const config of this.load()) this.configs.push(config);
  }

  async init(): Promise<void> {
    for (const config of this.configs) {
      if (!config.enabled) continue;
      await this.connect(config, false);
    }
  }

  list(): McpStatus[] {
    return this.configs.map((config) => {
      const client = this.clients.get(config.id);
      return {
        id: config.id,
        name: config.name,
        transport: config.transport,
        enabled: config.enabled,
        status: client?.status ?? (config.enabled ? "error" : "disconnected"),
        toolCount: client?.listTools().length ?? 0,
        ...(client?.lastError ? { lastError: client.lastError } : {}),
        ...(config.command ? { command: config.command } : {}),
        ...(config.args ? { args: config.args } : {}),
        ...(config.url ? { url: config.url } : {}),
        risk: config.risk ?? "needs_approval",
        envKeys: Object.keys(config.env ?? {}),
        headerKeys: Object.keys(config.headers ?? {}),
      };
    });
  }

  async add(input: McpInput): Promise<McpStatus> {
    const config = parseConfig(input, this.configs);
    this.configs.push(config);
    if (config.enabled) await this.connect(config, false);
    this.persist();
    return this.statusOf(config.id);
  }

  async remove(id: string): Promise<boolean> {
    const index = this.configs.findIndex((config) => config.id === id);
    if (index < 0) return false;
    const [config] = this.configs.splice(index, 1);
    if (config) await this.disconnect(config.id);
    this.persist();
    return true;
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpStatus> {
    const config = this.configs.find((item) => item.id === id);
    if (!config) throw new Error("MCP server 不存在");
    config.enabled = enabled;
    if (enabled) await this.connect(config, false);
    else await this.disconnect(id);
    this.persist();
    return this.statusOf(id);
  }

  /**
   * 局部更新：env / headers / enabled / risk。
   * 不传的字段保留；env / headers 传 {} 表示清空（显式写空对象，不是 undefined）。
   */
  async update(id: string, patch: McpInput): Promise<McpStatus> {
    const config = this.configs.find((item) => item.id === id);
    if (!config) throw new Error("MCP server 不存在");
    const raw = (patch ?? {}) as Record<string, unknown>;
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("invalid mcp payload");
    }

    if (raw["enabled"] !== undefined && typeof raw["enabled"] !== "boolean") {
      throw new Error("enabled 必须是布尔值");
    }
    if (
      raw["risk"] !== undefined &&
      raw["risk"] !== "safe" &&
      raw["risk"] !== "needs_approval"
    ) {
      throw new Error("risk 只能是 safe 或 needs_approval");
    }

    const hasEnv = Object.hasOwn(raw, "env");
    const hasHeaders = Object.hasOwn(raw, "headers");
    const nextEnv = hasEnv ? parseSecretMap(raw["env"], "env") : config.env;
    const nextHeaders = hasHeaders
      ? parseSecretMap(raw["headers"], "headers")
      : config.headers;

    const previousRisk = config.risk ?? "needs_approval";
    const nextRisk =
      raw["risk"] === "safe" || raw["risk"] === "needs_approval"
        ? raw["risk"]
        : previousRisk;
    const nextEnabled =
      typeof raw["enabled"] === "boolean" ? raw["enabled"] : config.enabled;
    const connectionDirty =
      hasEnv || hasHeaders || nextRisk !== previousRisk || nextEnabled !== config.enabled;

    config.enabled = nextEnabled;
    config.risk = nextRisk;
    if (hasEnv) {
      if (nextEnv && Object.keys(nextEnv).length > 0) config.env = nextEnv;
      else delete config.env;
    }
    if (hasHeaders) {
      if (nextHeaders && Object.keys(nextHeaders).length > 0) config.headers = nextHeaders;
      else delete config.headers;
    }

    if (nextEnabled && connectionDirty) await this.connect(config, false);
    else if (!nextEnabled) await this.disconnect(id);

    this.persist();
    return this.statusOf(id);
  }

  /** 用临时 client 测试配置（不会落盘、不注册工具）。 */
  async test(input: McpInput): Promise<McpTestResult> {
    let config: McpServerConfig;
    try {
      const existing = typeof input.id === "string"
        ? this.configs.find((item) => item.id === input.id)
        : undefined;
      config = existing
        ? { ...existing, ...parseConfig({ ...existing, ...input, id: existing.id }, []) }
        : parseConfig(input, this.configs);
    } catch (err) {
      return { ok: false, tools: [], error: err instanceof Error ? err.message : String(err) };
    }
    const client = new McpClient(config);
    try {
      const tools = await client.connect();
      return {
        ok: true,
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
      };
    } catch (err) {
      return {
        ok: false,
        tools: [],
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await client.close();
    }
  }

  toolCount(): number {
    return this.registry.list().filter((tool) => tool.source === "mcp").length;
  }

  async close(): Promise<void> {
    for (const id of this.clients.keys()) await this.disconnect(id);
  }

  // ── 内部 ──────────────────────────────────────────────

  private statusOf(id: string): McpStatus {
    const status = this.list().find((item) => item.id === id);
    if (!status) throw new Error("MCP server 不存在");
    return status;
  }

  private async connect(config: McpServerConfig, throwOnError: boolean): Promise<void> {
    await this.disconnect(config.id);
    const client = new McpClient(config);
    this.clients.set(config.id, client);
    try {
      const tools = await client.connect();
      this.registry.registerProvider(config.id, {
        defs: tools,
        execute: (name, input) => client.callTool(name, input),
      });
    } catch (err) {
      this.registry.removeProvider(config.id);
      console.warn(
        `[mcp] 连接 ${config.name} 失败：${err instanceof Error ? err.message : String(err)}`,
      );
      if (throwOnError) throw err;
    }
  }

  private async disconnect(id: string): Promise<void> {
    const client = this.clients.get(id);
    if (client) {
      await client.close();
      this.clients.delete(id);
    }
    this.registry.removeProvider(id);
  }

  private load(): McpServerConfig[] {
    if (!this.file || !existsSync(this.file)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (!Array.isArray(parsed)) return [];
      const configs: McpServerConfig[] = [];
      for (const raw of parsed) {
        try {
          configs.push(parseConfig(raw, configs));
        } catch (err) {
          console.warn("[mcp] 跳过无效配置：", err);
        }
      }
      return configs;
    } catch {
      // 不要打印原始错误：JSON 解析错误信息可能带出文件片段（里面可能有鉴权值）。
      console.warn("[mcp] 读取 mcp.json 失败（文件可能损坏），已忽略既有配置");
      return [];
    }
  }

  private persist(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.configs, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      console.error("[mcp] 保存配置失败：", err);
    }
  }
}

function parseConfig(input: McpInput, existing: McpServerConfig[]): McpServerConfig {
  const raw = (input ?? {}) as Record<string, unknown>;
  const id = typeof raw["id"] === "string" && raw["id"].trim() ? raw["id"].trim() : "";
  if (id && !/^[A-Za-z0-9][A-Za-z0-9_-]{1,40}$/.test(id)) {
    throw new Error("id 只能是 2–41 位字母/数字/_/-");
  }
  if (id && existing.some((config) => config.id === id)) {
    throw new Error(`MCP server id "${id}" 已存在`);
  }
  const name = typeof raw["name"] === "string" ? raw["name"].trim() : "";
  if (!name || name.length > 40) throw new Error("name 需要 1–40 个字符");
  const transport = raw["transport"] === "http" ? "http" : raw["transport"] === "stdio" ? "stdio" : null;
  if (!transport) throw new Error("transport 只能是 stdio 或 http");

  let command: string | undefined;
  let args: string[] | undefined;
  let url: string | undefined;
  if (transport === "stdio") {
    command = typeof raw["command"] === "string" ? raw["command"].trim() : "";
    if (!command) throw new Error("stdio server 需要 command");
    if (raw["args"] !== undefined) {
      if (!Array.isArray(raw["args"]) || raw["args"].some((arg) => typeof arg !== "string")) {
        throw new Error("args 必须是字符串数组");
      }
      args = raw["args"] as string[];
    }
  } else {
    url = typeof raw["url"] === "string" ? raw["url"].trim() : "";
    if (!/^https?:\/\//i.test(url)) throw new Error("http server 需要 http(s):// 的 url");
  }

  const risk = raw["risk"] === "safe" ? "safe" : "needs_approval";
  const env = parseSecretMap(raw["env"], "env");
  const headers = parseSecretMap(raw["headers"], "headers");
  return {
    id: id || generateId(name, existing),
    name,
    transport,
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
    ...(url ? { url } : {}),
    enabled: raw["enabled"] !== false,
    risk,
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

const SECRET_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_SECRET_ENTRIES = 20;
const MAX_SECRET_VALUE_LENGTH = 500;

/**
 * 校验 env / headers 这类「敏感键值表」。
 * - 键名：`^[A-Za-z_][A-Za-z0-9_]{0,63}$`；
 * - 值：字符串，长度 ≤ 500 字；
 * - 数量 ≤ 20。
 * 错误信息只带键名 / 位置，绝不带值。
 */
function parseSecretMap(
  value: unknown,
  field: "env" | "headers",
): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} 必须是对象`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_SECRET_ENTRIES) {
    throw new Error(`${field} 最多 ${MAX_SECRET_ENTRIES} 项`);
  }
  const output: Record<string, string> = {};
  for (const [key, rawValue] of entries) {
    if (!SECRET_KEY_PATTERN.test(key)) {
      throw new Error(`${field} 的键名不合法：${key}（需匹配 ${SECRET_KEY_PATTERN.source}）`);
    }
    if (typeof rawValue !== "string") {
      throw new Error(`${field}.${key} 的值必须是字符串`);
    }
    if (rawValue.length > MAX_SECRET_VALUE_LENGTH) {
      throw new Error(`${field}.${key} 的值不能超过 ${MAX_SECRET_VALUE_LENGTH} 字`);
    }
    output[key] = rawValue;
  }
  return output;
}

function generateId(name: string, existing: McpServerConfig[]): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 20) || "mcp";
  let id = slug;
  let counter = 2;
  while (existing.some((config) => config.id === id)) {
    id = `${slug}-${counter}`;
    counter += 1;
  }
  return id;
}

/** 给 driver 用的工具目录快照（按成员权限过滤）。 */
export function filterToolsForCat(
  tools: ToolDefinition[],
  allowed: string[] | undefined,
): ToolDefinition[] {
  // undefined = 不限制；空数组 = 明确一个都不给。
  if (allowed === undefined) return tools;
  return tools.filter((tool) => allowed.includes(tool.name));
}
