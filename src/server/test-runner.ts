/**
 * 测试中心：在页面上一键跑测试，并把输出实时推给前端。
 *
 * 只允许两种运行：
 * - unit：`node --test tests/`（秒级，不碰网络）
 * - real / scenario：`python3 tools/matrix.py`（真实模型，分钟级，产生费用）
 *
 * 设计边界：
 * - 同一 kind 同时只允许一个运行（避免把机器跑满）；
 * - 每次运行最多保留 2000 行、最近 20 次记录；
 * - 子进程输出按行切分，stdout / stderr 分开标记；
 * - 服务端不读取、不记录任何 API key（真实模型配置在启动环境里）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ids } from "../domain/ids.ts";

export type TestKind = "unit" | "real" | "scenario";

export interface TestLine {
  at: number;
  stream: "stdout" | "stderr";
  text: string;
}

export interface TestRunSummary {
  tests?: number;
  pass?: number;
  fail?: number;
  scenarios?: number;
  failed?: number;
}

export interface TestRun {
  id: string;
  kind: TestKind;
  scenario?: string;
  status: "running" | "passed" | "failed" | "cancelled";
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  lines: TestLine[];
  summary?: TestRunSummary;
}

export interface TestStreamEvent {
  runId: string;
  event?: "start" | "exit";
  line?: string;
  stream?: "stdout" | "stderr";
  at?: number;
  code?: number | null;
}

const MAX_LINES = 2000;
const MAX_RUNS = 20;
const SCENARIOS = [
  "basic",
  "reject",
  "nudge",
  "rooms",
  "concurrent",
  "invalid",
  "permission",
  "memory",
  "notools",
] as const;

export interface TestRunnerOptions {
  projectRoot: string;
  port: number;
  /** 当前服务端是否配了真实模型（决定 real 能不能跑）。 */
  realModelReady: () => boolean;
}

export class TestRunner {
  private readonly runs: TestRun[] = [];
  private readonly children = new Map<string, ChildProcess>();
  private readonly listeners = new Set<(event: TestStreamEvent) => void>();
  private readonly opts: TestRunnerOptions;

  constructor(opts: TestRunnerOptions) {
    this.opts = opts;
  }

  /** 供 HTTP 层调用的场景列表。 */
  static scenarios(): readonly string[] {
    return SCENARIOS;
  }

  list(): Array<Omit<TestRun, "lines"> & { lineCount: number }> {
    return this.runs.map(({ lines, ...rest }) => ({ ...rest, lineCount: lines.length }));
  }

  get(id: string): TestRun | undefined {
    return this.runs.find((run) => run.id === id);
  }

  subscribe(listener: (event: TestStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 启动一次运行；同一 kind 已在跑时抛错。 */
  start(kind: TestKind, scenario?: string): TestRun {
    if (this.runs.some((run) => run.kind === kind && run.status === "running")) {
      throw new Error(`${kind} 测试已经在跑了，等它结束或先停止`);
    }
    if (kind !== "unit" && !this.opts.realModelReady()) {
      throw new Error(
        "真实模型未配置：请用 LLM_BASE_URL / LLM_MODEL / LLM_API_KEY 启动服务后再跑真实模型测试",
      );
    }
    const chosen = kind === "scenario" ? scenario ?? "basic" : undefined;
    if (kind === "scenario" && !SCENARIOS.includes((chosen ?? "") as (typeof SCENARIOS)[number])) {
      throw new Error(`未知场景：${chosen}`);
    }

    const run: TestRun = {
      id: ids.testRun(),
      kind,
      ...(chosen ? { scenario: chosen } : {}),
      status: "running",
      startedAt: Date.now(),
      lines: [],
    };
    this.runs.unshift(run);
    if (this.runs.length > MAX_RUNS) this.runs.length = MAX_RUNS;

    const { command, args, cwd, env } = this.commandFor(kind, chosen);
    // 关键：如果服务本身是在 `node --test` 里被拉起来的（集成测试），
    // NODE_TEST_CONTEXT 会被继承，子进程的 node --test 会以为「递归调用」而跳过所有文件。
    const childEnv = { ...process.env, ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.NODE_OPTIONS;
    const child = spawn(command, args, {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.children.set(run.id, child);
    this.emit({ runId: run.id, event: "start" });

    this.attach(child, "stdout", (text) => this.append(run, "stdout", text));
    this.attach(child, "stderr", (text) => this.append(run, "stderr", text));

    child.on("error", (err) => {
      this.append(run, "stderr", `无法启动测试进程：${err.message}`);
    });
    child.on("close", (code) => {
      this.children.delete(run.id);
      run.exitCode = code ?? undefined;
      run.finishedAt = Date.now();
      run.status =
        run.status === "cancelled"
          ? "cancelled"
          : code === 0
            ? "passed"
            : "failed";
      run.summary = summarize(run);
      this.emit({ runId: run.id, event: "exit", code });
    });

    return run;
  }

  cancel(id: string): boolean {
    const child = this.children.get(id);
    const run = this.get(id);
    if (!child || !run || run.status !== "running") return false;
    run.status = "cancelled";
    try {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 1500).unref?.();
    } catch {
      // 进程可能已经退出。
    }
    return true;
  }

  close(): void {
    for (const [id] of this.children) this.cancel(id);
  }

  // ── 内部 ──────────────────────────────────────────────

  private commandFor(
    kind: TestKind,
    scenario: string | undefined,
  ): { command: string; args: string[]; cwd: string; env: Record<string, string> } {
    const base = `http://127.0.0.1:${this.opts.port}`;
    const env: Record<string, string> = { CATCAFE_BASE: base, PYTHONUNBUFFERED: "1" };
    if (kind === "unit") {
      return {
        command: process.execPath,
        args: ["--test", "tests/"],
        cwd: this.opts.projectRoot,
        env,
      };
    }
    const toolsDir = join(this.opts.projectRoot, "tools");
    if (!existsSync(join(toolsDir, "matrix.py"))) {
      throw new Error("找不到 tools/matrix.py，无法跑真实模型测试");
    }
    return {
      command: "python3",
      args: [
        "matrix.py",
        "--scenario",
        kind === "real" ? "all" : (scenario ?? "basic"),
        "--out",
        "/tmp/catcafe-matrix-ui.json",
      ],
      cwd: toolsDir,
      env,
    };
  }

  private attach(
    child: ChildProcess,
    stream: "stdout" | "stderr",
    push: (text: string) => void,
  ): void {
    const source = stream === "stdout" ? child.stdout : child.stderr;
    if (!source) return;
    source.setEncoding("utf8");
    let buffer = "";
    source.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line) push(line);
        index = buffer.indexOf("\n");
      }
    });
    source.on("end", () => {
      if (buffer.trim()) push(buffer);
      buffer = "";
    });
  }

  private append(run: TestRun, stream: "stdout" | "stderr", text: string): void {
    const line: TestLine = { at: Date.now(), stream, text };
    run.lines.push(line);
    if (run.lines.length > MAX_LINES) run.lines.splice(0, run.lines.length - MAX_LINES);
    this.emit({ runId: run.id, line: text, stream, at: line.at });
  }

  private emit(event: TestStreamEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[tests] listener failed:", err);
      }
    }
  }
}

/** 从输出里提取测试统计（unit 用 node:test 的格式，real 用 matrix 的 PASS/FAIL）。 */
function summarize(run: TestRun): TestRunSummary {
  const summary: TestRunSummary = {};
  const text = run.lines.map((line) => line.text).join("\n");
  const tests = /ℹ tests (\d+)/.exec(text);
  const pass = /ℹ pass (\d+)/.exec(text);
  const fail = /ℹ fail (\d+)/.exec(text);
  if (tests) summary.tests = Number(tests[1]);
  if (pass) summary.pass = Number(pass[1]);
  if (fail) summary.fail = Number(fail[1]);

  const passedScenarios = (text.match(/\[PASS\]/g) ?? []).length;
  const failedScenarios = (text.match(/\[FAIL\]/g) ?? []).length;
  if (passedScenarios + failedScenarios > 0) {
    summary.scenarios = passedScenarios + failedScenarios;
    summary.failed = failedScenarios;
  }
  return summary;
}
