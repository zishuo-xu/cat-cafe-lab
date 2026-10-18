/** 内置沙盒工具的目录与注册表适配。 */

import type {
  SandboxRunner,
  ToolDefinition,
  ToolRegistry,
  ToolResult,
} from "../domain/types.ts";

export const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    name: "read_file",
    title: "读取文件",
    description: "读取沙盒内某个文件的内容（相对路径）。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "相对沙盒根目录的路径" } },
      required: ["path"],
    },
    risk: "safe",
    source: "sandbox",
  },
  {
    name: "write_file",
    title: "写入文件",
    description: "把完整内容写入沙盒内的文件（会覆盖），自动创建目录。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string", description: "完整文件内容" },
      },
      required: ["path", "content"],
    },
    risk: "safe",
    source: "sandbox",
  },
  {
    name: "list_files",
    title: "列出文件",
    description: "列出沙盒内的所有文件与大小。",
    inputSchema: { type: "object", properties: {} },
    risk: "safe",
    source: "sandbox",
  },
  {
    name: "run_command",
    title: "运行命令",
    description: "在沙盒根目录运行 node / npm 命令（不经过 shell，10 秒超时）。",
    inputSchema: {
      type: "object",
      properties: {
        cmd: { type: "string", enum: ["node", "npm"] },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["cmd"],
    },
    risk: "needs_approval",
    source: "sandbox",
  },
];

export function createSandboxRegistry(sandbox: SandboxRunner): ToolRegistry {
  const byName = new Map(BUILTIN_TOOLS.map((tool) => [tool.name, tool]));
  return {
    list: () => [...BUILTIN_TOOLS],
    get: (name) => byName.get(name),
    execute: async (name, input): Promise<ToolResult> => {
      if (!byName.has(name)) {
        return { status: "error", output: `工具不存在：${String(name)}` };
      }
      return sandbox.execute(name, input);
    },
  };
}
