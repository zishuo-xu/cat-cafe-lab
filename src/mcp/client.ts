/**
 * 最小 MCP 客户端（JSON-RPC 2.0）：
 * - stdio：newline-delimited JSON，适合 `npx @modelcontextprotocol/server-*`；
 * - http：Streamable HTTP（POST JSON-RPC，兼容 JSON 与 text/event-stream 响应）。
 *
 * 只实现需要的能力：initialize → tools/list → tools/call。
 * MCP server 是用户自己在设置里添加的本地程序，默认风险标 needs_approval。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  McpServerConfig,
  ToolDefinition,
  ToolName,
  ToolResult,
} from "../domain/types.ts";

const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "cat-cafe-lab", version: "0.1.0" };
const REQUEST_TIMEOUT_MS = 8000;

interface RpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface RawTool {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  inputSchema?: unknown;
}

let nextRequestId = 1;

export function mcpToolName(serverId: string, toolName: string): ToolName {
  return `${serverId}__${toolName}`;
}

export function stripMcpToolName(serverId: string, name: ToolName): string {
  const prefix = `${serverId}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

export class McpClient {
  status: "disconnected" | "connecting" | "connected" | "error" = "disconnected";
  lastError?: string;

  private readonly config: McpServerConfig;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private sessionId: string | null = null;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private tools: ToolDefinition[] = [];

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  listTools(): ToolDefinition[] {
    return [...this.tools];
  }

  async connect(): Promise<ToolDefinition[]> {
    this.status = "connecting";
    this.lastError = undefined;
    try {
      if (this.config.transport === "stdio") {
        this.openStdio();
        await this.request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        });
        this.notify("notifications/initialized", {});
      } else {
        const result = (await this.initializeHttp()) ?? null;
        void result;
      }
      const listed = await this.request("tools/list", {});
      this.tools = this.parseTools(listed);
      this.status = "connected";
      return this.tools;
    } catch (err) {
      this.status = "error";
      this.lastError = err instanceof Error ? err.message : String(err);
      await this.close();
      throw err;
    }
  }

  async callTool(name: ToolName, input: Record<string, unknown>): Promise<ToolResult> {
    if (this.status !== "connected") {
      return { status: "error", output: this.lastError ?? "MCP server 未连接" };
    }
    const toolName = stripMcpToolName(this.config.id, name);
    try {
      const result = await this.request(
        "tools/call",
        { name: toolName, arguments: input },
        30000,
      );
      return normalizeCallResult(result);
    } catch (err) {
      return {
        status: "error",
        output: `MCP 调用失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async close(): Promise<void> {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // 进程可能已经退出。
      }
      this.child = null;
    }
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("MCP client closed"));
      this.pending.delete(id);
    }
    this.status = "disconnected";
    this.sessionId = null;
  }

  // ── stdio 传输 ───────────────────────────────────────

  private openStdio(): void {
    const command = this.config.command?.trim();
    if (!command) throw new Error("stdio server 缺少 command");
    const child = spawn(command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdioData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text) console.warn(`[mcp:${this.config.id}] ${text.slice(0, 300)}`);
    });
    child.on("error", (err) => this.failAll(err));
    child.on("exit", (code) => {
      if (this.status === "connected") {
        this.status = "error";
        this.lastError = `MCP server 退出（code ${code ?? "?"}）`;
      }
      this.failAll(new Error(`MCP server 退出（code ${code ?? "?"}）`));
    });
  }

  private onStdioData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.handleLine(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: RpcResponse;
    try {
      message = JSON.parse(line) as RpcResponse;
    } catch {
      console.warn(`[mcp:${this.config.id}] 无法解析输出：${line.slice(0, 200)}`);
      return;
    }
    if (typeof message.id === "number") this.settle(message.id, message);
  }

  // ── http 传输 ────────────────────────────────────────

  private async initializeHttp(): Promise<unknown> {
    const result = await this.httpRequest("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    await this.httpNotify("notifications/initialized", {});
    return result;
  }

  private async httpRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const url = this.config.url?.trim();
    if (!url) throw new Error("http server 缺少 url");
    const id = nextRequestId++;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    if (contentType.includes("text/event-stream")) {
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload) continue;
        try {
          const message = JSON.parse(payload) as RpcResponse;
          if (message.id === id) return this.unwrap(message);
        } catch {
          // 跳过非 JSON 的心跳。
        }
      }
      throw new Error("SSE 响应里没有找到匹配的 JSON-RPC 结果");
    }
    const message = JSON.parse(text) as RpcResponse;
    return this.unwrap(message);
  }

  private async httpNotify(method: string, params: Record<string, unknown>): Promise<void> {
    const url = this.config.url?.trim();
    if (!url) return;
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => undefined);
  }

  // ── JSON-RPC ─────────────────────────────────────────

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.config.transport === "http") return this.httpRequest(method, params);
    return new Promise<unknown>((resolve, reject) => {
      if (!this.child) {
        reject(new Error("MCP server 未启动"));
        return;
      }
      const id = nextRequestId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (this.config.transport === "http") {
      void this.httpNotify(method, params);
      return;
    }
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private settle(id: number, message: RpcResponse): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    try {
      entry.resolve(this.unwrap(message));
    } catch (err) {
      entry.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private unwrap(message: RpcResponse): unknown {
    if (message.error) {
      throw new Error(
        `MCP 错误 ${message.error.code ?? ""}: ${message.error.message ?? "unknown"}`,
      );
    }
    return message.result;
  }

  private failAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }

  private parseTools(result: unknown): ToolDefinition[] {
    const record = result as { tools?: RawTool[] } | null;
    if (!record || !Array.isArray(record.tools)) return [];
    const risk = this.config.risk ?? "needs_approval";
    return record.tools
      .filter((tool): tool is RawTool & { name: string } => typeof tool?.name === "string")
      .map((tool) => ({
        name: mcpToolName(this.config.id, tool.name),
        title: typeof tool.title === "string" && tool.title ? tool.title : tool.name,
        description:
          typeof tool.description === "string" && tool.description
            ? tool.description
            : `${this.config.name} 提供的工具`,
        inputSchema:
          tool.inputSchema && typeof tool.inputSchema === "object"
            ? (tool.inputSchema as Record<string, unknown>)
            : { type: "object", properties: {} },
        risk,
        source: "mcp" as const,
        serverId: this.config.id,
      }));
  }
}

function normalizeCallResult(result: unknown): ToolResult {
  const record = result as
    | { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
    | null;
  const parts: string[] = [];
  if (record && Array.isArray(record.content)) {
    for (const item of record.content) {
      if (typeof item?.text === "string") parts.push(item.text);
      else if (item) parts.push(JSON.stringify(item));
    }
  }
  const output = parts.join("\n") || JSON.stringify(result ?? null);
  return {
    status: record?.isError ? "error" : "ok",
    output: output.length > 4000 ? `${output.slice(0, 4000)}\n…（截断）` : output,
  };
}
