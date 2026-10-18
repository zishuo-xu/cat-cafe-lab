#!/usr/bin/env node
/**
 * 示例 MCP server：猫咖记事本。
 *
 * 零依赖，只实现 MCP 需要的三个方法（initialize / tools/list / tools/call）。
 * 数据存在同目录 notes.json，猫可以读、写、列自己的笔记。
 *
 * 用法（在设置 →「MCP 工具」里添加）：
 *   transport: stdio
 *   command:   node
 *   args:      examples/mcp/notes-server.mjs（相对 cat-cafe-lab 根目录的绝对路径）
 *
 * 工具：
 *   - list_notes            列出所有笔记标题
 *   - read_note { title }   读一篇笔记
 *   - write_note { title, content }  写/覆盖一篇笔记
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE = join(HERE, "notes.json");

const TOOLS = [
  {
    name: "list_notes",
    title: "列出记事本",
    description: "列出猫咖记事本里所有笔记的标题。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_note",
    title: "读笔记",
    description: "按标题读取一篇笔记的完整内容。",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string", description: "笔记标题" } },
      required: ["title"],
    },
  },
  {
    name: "write_note",
    title: "写笔记",
    description: "新建或覆盖一篇笔记。内容会被完整替换。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "笔记标题" },
        content: { type: "string", description: "笔记正文" },
      },
      required: ["title", "content"],
    },
  },
];

function loadNotes() {
  if (!existsSync(STORE)) return {};
  try {
    return JSON.parse(readFileSync(STORE, "utf8"));
  } catch {
    return {};
  }
}

function saveNotes(notes) {
  writeFileSync(STORE, JSON.stringify(notes, null, 2), "utf8");
}

function callTool(name, args) {
  const notes = loadNotes();
  if (name === "list_notes") {
    const titles = Object.keys(notes);
    if (titles.length === 0) return { content: [{ type: "text", text: "记事本是空的。" }] };
    return {
      content: [
        {
          type: "text",
          text: titles.map((title) => `- ${title}（${notes[title].length} 字）`).join("\n"),
        },
      ],
    };
  }
  if (name === "read_note") {
    const title = String(args?.title ?? "");
    if (!notes[title]) {
      return { isError: true, content: [{ type: "text", text: `没有这篇笔记：${title}` }] };
    }
    return { content: [{ type: "text", text: notes[title] }] };
  }
  if (name === "write_note") {
    const title = String(args?.title ?? "").trim();
    const content = String(args?.content ?? "");
    if (!title) {
      return { isError: true, content: [{ type: "text", text: "标题不能为空" }] };
    }
    notes[title] = content;
    saveNotes(notes);
    return {
      content: [{ type: "text", text: `已保存「${title}」（${content.length} 字）` }],
    };
  }
  return { isError: true, content: [{ type: "text", text: `未知工具：${name}` }] };
}

function reply(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        // 忽略坏行
      }
    }
    index = buffer.indexOf("\n");
  }
});

function handle(message) {
  if (message.method === "initialize") {
    reply({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "cat-cafe-notes", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    reply({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    reply({ jsonrpc: "2.0", id: message.id, result: callTool(name, args) });
    return;
  }
  if (message.id !== undefined) {
    reply({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `unknown method: ${message.method}` },
    });
  }
}
