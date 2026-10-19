/**
 * CLI brain：把「猫的大脑」接到 Claude Code CLI（`claude -p`）。
 *
 * 与 llm-brain 的区别：
 * - llm-brain 直接打 HTTP API，自己拼 prompt、自己解析 JSON；
 * - cli-brain 起一个 `claude -p --output-format json` 子进程，把同样的
 *   system/user prompt 交给它，读回 JSON envelope 里的 result 字段。
 *
 * 为什么还要自己解析 CatTurn[]：CLI 的输出是自然语言（result 是一段文本），
 * 我们要求它内部只输出 JSON 数组，再用和 API 版完全相同的 parseTurns 校验。
 * 这样两种 brain 产出的 turn 结构完全一致，driver / UI 不用改。
 *
 * 安全边界：
 * - 默认禁用 CLI 内置工具（--disallowedTools），所有工具执行仍走我们的沙盒 + 审批；
 * - cwd 固定到沙盒目录，不碰用户仓库；
 * - 超时 kill，输出大小上限，不读 stderr 里的敏感信息。
 */

import { spawn } from "node:child_process";

import type { CatBrain, CatTurn, LlmSettings, TurnContext } from "../domain/types.ts";
import {
  buildSystemPrompt,
  buildUserPrompt,
  parseTurns,
} from "./llm-brain.ts";

export interface CliBrainOptions {
  /** CLI 可执行文件，默认 claude。 */
  command?: string;
  /** 工作目录（沙盒）。 */
  cwd: string;
  /** 单次调用超时，默认 120s。 */
  timeoutMs?: number;
  /** 额外 CLI 参数。 */
  extraArgs?: string[];
  /** 额外环境变量（如 CLAUDE_CONFIG_DIR）。 */
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 2 * 1024 * 1024;
/** 默认禁用 CLI 内置工具：工具执行统一走我们的沙盒 + 审批闸门。 */
const DEFAULT_DISALLOWED = ["Bash", "Edit", "Write", "Read", "WebFetch", "WebSearch"];

interface CliEnvelope {
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  session_id?: string;
  subtype?: string;
}

export function createCliBrain(
  settings: LlmSettings,
  fallback: CatBrain,
  options: CliBrainOptions,
): CatBrain {
  const command = options.command ?? "claude";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    mode: "llm",
    async think(ctx: TurnContext): Promise<CatTurn[]> {
      const warn = (line: string): void => {
        console.warn(line.split(settings.apiKey).join("***"));
      };

      const prompt = [
        buildSystemPrompt(ctx, settings.model),
        "",
        buildUserPrompt(ctx),
      ].join("\n");

      let envelope: CliEnvelope;
      try {
        envelope = await runCli(command, prompt, {
          cwd: options.cwd,
          timeoutMs,
          extraArgs: options.extraArgs,
          env: options.env,
        });
      } catch (err) {
        warn(`[cli-brain] 调用失败，降级 fallback：${err instanceof Error ? err.message : String(err)}`);
        return fallback.think(ctx);
      }

      if (envelope.is_error) {
        warn(`[cli-brain] CLI 返回错误（${envelope.subtype ?? "unknown"}），降级 fallback`);
        return fallback.think(ctx);
      }

      const content = typeof envelope.result === "string" ? envelope.result : "";
      if (!content.trim()) {
        warn("[cli-brain] CLI 返回空 result，降级 fallback");
        return fallback.think(ctx);
      }

      const turns = parseTurns(content, ctx);
      if (turns.length > 0) {
        // 增量草稿：CLI 是整段返回，这里只推一次最终文本，让前端有反馈。
        ctx.onDelta?.({ catId: ctx.cat.id, roomId: ctx.room.id, text: clipPrimaryText(turns) });
        return turns;
      }

      // 兜底：模型没按 JSON 输出，当成一条普通消息。
      warn("[cli-brain] 输出不是 CatTurn[]，包成一条 message");
      return [{ kind: "message", text: content.trim().slice(0, 600) }];
    },
  };
}

/** 从 turns 里挑一段文本当天花板草稿。 */
function clipPrimaryText(turns: CatTurn[]): string {
  for (const turn of turns) {
    if (turn.kind === "message") return turn.text.slice(0, 600);
    if (turn.kind === "artifact") return turn.artifact.body.slice(0, 800);
    if ("text" in turn && typeof turn.text === "string") return turn.text.slice(0, 600);
  }
  return "";
}

interface RunOptions {
  cwd: string;
  timeoutMs: number;
  extraArgs?: string[];
  env?: Record<string, string>;
}

function runCli(
  command: string,
  prompt: string,
  opts: RunOptions,
): Promise<CliEnvelope> {
  return new Promise<CliEnvelope>((done, fail) => {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--max-turns",
      "1",
      "--disallowedTools",
      DEFAULT_DISALLOWED.join(","),
      ...(opts.extraArgs ?? []),
    ];
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
      } catch {
        // 进程可能已退出
      }
      fail(new Error(`CLI 超时 ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
    timer.unref?.();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        fail(new Error("CLI 输出超过上限"));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {
      // 只消费不保存：可能包含环境信息。
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fail(new Error(`无法启动 CLI（${command}）：${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!stdout.trim()) {
        fail(new Error(`CLI 无输出（exit ${code ?? "?"}）`));
        return;
      }
      try {
        done(JSON.parse(stdout) as CliEnvelope);
      } catch {
        fail(new Error("CLI 输出不是合法 JSON envelope"));
      }
    });
  });
}
