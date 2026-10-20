/**
 * 沙盒工具运行时。
 *
 * 安全边界（重要）：
 * - 所有路径都被锁在 root 内，拒绝绝对路径、`..`、越界；
 * - 命令必须命中白名单（node / npm），参数只能用安全字符，不经过 shell；
 * - 每次执行 10s 超时，输出截断到 4000 字；
 * - 沙盒目录独立（默认 data/workspace），不是用户的仓库。
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { SandboxFile, SandboxRunner, ToolName, ToolResult } from "../domain/types.ts";
import { SEED_FILES } from "./seed.ts";

const ALLOWED_COMMANDS = new Set(["node", "npm"]);
const MAX_OUTPUT = 4000;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_WRITE_BYTES = 64 * 1024;
const MAX_LIST = 200;
const COMMAND_TIMEOUT_MS = 10_000;
const ARG_PATTERN = /^[A-Za-z0-9_./@:=+-]+$/;

export class Sandbox implements SandboxRunner {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** 没有项目时种一份初始代码；已有则保持上次的成果。 */
  ensureSeed(): void {
    mkdirSync(this.root, { recursive: true });
    if (existsSync(join(this.root, "package.json"))) return;
    this.writeSeed();
  }

  reset(): void {
    rmSync(this.root, { recursive: true, force: true });
    mkdirSync(this.root, { recursive: true });
    this.writeSeed();
  }

  async execute(tool: ToolName, input: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (tool) {
        case "read_file":
          return this.readFile(input);
        case "write_file":
          return this.writeFile(input);
        case "list_files":
          return this.listFilesResult();
        case "run_command":
          return await this.runCommand(input);
        default:
          return { status: "error", output: `未知工具：${String(tool)}` };
      }
    } catch (err) {
      return { status: "error", output: err instanceof Error ? err.message : String(err) };
    }
  }

  listFiles(): SandboxFile[] {
    const files: SandboxFile[] = [];
    const walk = (dir: string): void => {
      if (files.length >= MAX_LIST) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries.sort()) {
        if (files.length >= MAX_LIST) return;
        if (name === "node_modules" || name === ".git") continue;
        const abs = join(dir, name);
        let stat;
        try {
          stat = statSync(abs);
        } catch {
          continue;
        }
        if (stat.isDirectory()) walk(abs);
        else files.push({ path: relative(this.root, abs).split(sep).join("/"), size: stat.size });
      }
    };
    walk(this.root);
    return files;
  }

  readTextFile(path: string): { path: string; content: string } {
    const abs = this.resolveInside(path);
    const content = readFileSync(abs, "utf8");
    if (content.length > MAX_FILE_BYTES) throw new Error("文件太大，拒绝读取");
    return { path, content };
  }

  // ── 工具实现 ─────────────────────────────────────────

  private readFile(input: Record<string, unknown>): ToolResult {
    const path = normalizePath(input["path"]);
    const abs = this.resolveInside(path);
    const content = readFileSync(abs, "utf8");
    return {
      status: "ok",
      output: content.length > MAX_OUTPUT ? `${content.slice(0, MAX_OUTPUT)}\n…（截断）` : content,
    };
  }

  private writeFile(input: Record<string, unknown>): ToolResult {
    const path = normalizePath(input["path"]);
    const content = input["content"];
    if (typeof content !== "string") throw new Error("content 必须是字符串");
    if (content.length > MAX_WRITE_BYTES) throw new Error("内容太大，拒绝写入");
    const abs = this.resolveInside(path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return { status: "ok", output: `已写入 ${path}（${content.length} 字符）` };
  }

  private listFilesResult(): ToolResult {
    const files = this.listFiles();
    return {
      status: "ok",
      output: files.map((file) => `${file.path}  ${file.size}B`).join("\n") || "(空目录)",
    };
  }

  private runCommand(input: Record<string, unknown>): Promise<ToolResult> {
    const cmd = input["cmd"];
    if (typeof cmd !== "string" || !ALLOWED_COMMANDS.has(cmd)) {
      return Promise.resolve({
        status: "error",
        output: `命令不在白名单：${String(cmd)}（只允许 ${[...ALLOWED_COMMANDS].join(" / ")}）`,
      });
    }
    const rawArgs = input["args"] ?? [];
    if (!Array.isArray(rawArgs) || rawArgs.length > 10) {
      return Promise.resolve({ status: "error", output: "args 必须是最多 10 个字符串的数组" });
    }
    const args: string[] = [];
    for (const raw of rawArgs) {
      if (typeof raw !== "string" || raw.length > 80) {
        return Promise.resolve({ status: "error", output: "参数必须是不超过 80 字的字符串" });
      }
      if (!ARG_PATTERN.test(raw) || raw.startsWith("/") || raw.includes("..")) {
        return Promise.resolve({ status: "error", output: `参数不安全：${raw}` });
      }
      args.push(raw);
    }

    return new Promise<ToolResult>((done) => {
      let output = "";
      let settled = false;
      const child = spawn(cmd, args, {
        cwd: this.root,
        shell: false,
        timeout: COMMAND_TIMEOUT_MS,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? this.root,
          NODE_ENV: "test",
          npm_config_update_notifier: "false",
        },
      });
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        done({ status: "error", output: truncate(`无法执行：${err.message}`) });
      });
      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        const timedOut = signal === "SIGTERM";
        const text = output.trim() || "(无输出)";
        done({
          status: code === 0 && !timedOut ? "ok" : "error",
          ...(typeof code === "number" ? { exitCode: code } : {}),
          output: truncate(timedOut ? `${text}\n（超时 ${COMMAND_TIMEOUT_MS}ms，已终止）` : text),
        });
      });
    });
  }

  // ── 路径安全 ─────────────────────────────────────────

  private resolveInside(relPath: string): string {
    if (!relPath || relPath.length > 200) throw new Error("路径为空或过长");
    if (isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) throw new Error("不允许绝对路径");
    const normalized = relPath.split("\\").join("/");
    if (normalized.split("/").includes("..")) throw new Error("不允许 .. 路径");
    const abs = resolve(this.root, normalized);
    const rel = relative(this.root, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("路径越界");
    return abs;
  }

  private writeSeed(): void {
    for (const [path, content] of Object.entries(SEED_FILES)) {
      const abs = resolve(this.root, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
    }
  }
}

function normalizePath(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("path 必须是非空字符串");
  }
  return value.trim();
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…（输出截断）` : text;
}
