/**
 * 工具注册表：内置沙盒工具 + MCP server 动态注册的工具。
 *
 * driver 只认 ToolRegistry，不关心工具来自哪里。
 */

import type {
  SandboxRunner,
  ToolDefinition,
  ToolName,
  ToolRegistry,
  ToolResult,
} from "../domain/types.ts";
import { BUILTIN_TOOLS } from "./builtin.ts";

export interface ProviderRegistration {
  defs: ToolDefinition[];
  execute: (name: ToolName, input: Record<string, unknown>) => Promise<ToolResult>;
}

export class ToolRegistryImpl implements ToolRegistry {
  private readonly builtins: ToolDefinition[];
  private readonly sandbox: SandboxRunner | null;
  private readonly providers = new Map<string, ProviderRegistration>();

  constructor(sandbox: SandboxRunner | null = null) {
    this.sandbox = sandbox;
    this.builtins = sandbox ? [...BUILTIN_TOOLS] : [];
  }

  registerProvider(serverId: string, registration: ProviderRegistration): void {
    this.providers.set(serverId, registration);
  }

  removeProvider(serverId: string): void {
    this.providers.delete(serverId);
  }

  list(): ToolDefinition[] {
    const tools = [...this.builtins];
    for (const registration of this.providers.values()) tools.push(...registration.defs);
    return tools;
  }

  get(name: ToolName): ToolDefinition | undefined {
    const builtin = this.builtins.find((tool) => tool.name === name);
    if (builtin) return builtin;
    for (const registration of this.providers.values()) {
      const found = registration.defs.find((tool) => tool.name === name);
      if (found) return found;
    }
    return undefined;
  }

  async execute(name: ToolName, input: Record<string, unknown>): Promise<ToolResult> {
    if (this.builtins.some((tool) => tool.name === name)) {
      if (!this.sandbox) {
        return { status: "error", output: "沙盒未启用" };
      }
      return this.sandbox.execute(name, input);
    }
    for (const registration of this.providers.values()) {
      if (registration.defs.some((tool) => tool.name === name)) {
        return registration.execute(name, input);
      }
    }
    return { status: "error", output: `工具不存在：${String(name)}` };
  }
}
