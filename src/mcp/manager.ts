/**
 * MCP server 管理：配置持久化、连接生命周期、把工具注册进注册表。
 *
 * 安全边界：
 * - 只有用户在本地设置里显式添加的 server 才会被启动；
 * - 配置不包含任何密钥（暂不支持 env / header 鉴权）；
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
    } catch (err) {
      console.warn("[mcp] 读取配置失败：", err);
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
  return {
    id: id || generateId(name, existing),
    name,
    transport,
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
    ...(url ? { url } : {}),
    enabled: raw["enabled"] !== false,
    risk,
  };
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

/** 给 driver 用的工具目录快照（按猫权限过滤）。 */
export function filterToolsForCat(
  tools: ToolDefinition[],
  allowed: string[] | undefined,
): ToolDefinition[] {
  // undefined = 不限制；空数组 = 明确一个都不给。
  if (allowed === undefined) return tools;
  return tools.filter((tool) => allowed.includes(tool.name));
}
