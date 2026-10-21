/**
 * 从环境变量解析运行配置。API key 只存在内存里，绝不落盘。
 *
 * 额外支持 LLM_HEADERS：JSON 字符串，例如
 *   LLM_HEADERS='{"x-opencode-session":"deliverylab-abc"}'
 * 用于 opencode zen 这类需要自定义请求头的端点。值同样不进日志、不回传前端。
 */

import type { LlmSettings, StudioSettings, ToolApprovalMode } from "../domain/types.ts";

/**
 * 读环境变量，同时接受新前缀（DELIVERYLAB_）与旧前缀（CATCAFE_）。
 *
 * 旧前缀是项目改名前的名字，保留是为了不破坏已有的启动脚本。
 */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[`DELIVERYLAB_${name}`] ?? env[`CATCAFE_${name}`];
}

export function readSettings(env: NodeJS.ProcessEnv = process.env): StudioSettings {
  const port = Number.parseInt(env.PORT ?? "4318", 10);
  const dataDir = readEnv(env, "DATA_DIR")?.trim() || "data";
  const stallMs = Number.parseInt(readEnv(env, "STALL_MS") ?? "12000", 10);

  const baseUrl = env.LLM_BASE_URL?.trim() ?? "";
  const apiKey = env.LLM_API_KEY?.trim() ?? "";
  const model = env.LLM_MODEL?.trim() ?? "";
  const headers = parseHeaders(env.LLM_HEADERS);
  // 只要 env 里给了任意一项就保留，交给 SettingsStore 与 settings.json 合并：
  // baseUrl/model 可能已经存在设置里，而 key / headers 只从环境变量来。
  // 以前要求「baseUrl 和 model 都在 env」才构造 llm，导致 `LLM_API_KEY=... node src/main.ts`
  // 这种用法静默丢 key（真实踩过）。
  const hasAnyLlmEnv = Boolean(baseUrl || model || apiKey || headers);
  const llm: LlmSettings | null = hasAnyLlmEnv
    ? {
        baseUrl: baseUrl.replace(/\/+$/, ""),
        apiKey,
        model,
        temperature: Number.parseFloat(env.LLM_TEMPERATURE ?? "0.8"),
        ...(headers ? { headers } : {}),
      }
    : null;

  return {
    port: Number.isFinite(port) ? port : 4318,
    dataDir,
    mode: llm ? "llm" : "mock",
    llm,
    stallMs: Number.isFinite(stallMs) && stallMs > 0 ? stallMs : 12000,
    toolsEnabled: readEnv(env, "TOOLS") !== "0",
    toolApproval:
      readEnv(env, "APPROVAL") === "auto" || readEnv(env, "APPROVAL") === "all"
        ? (readEnv(env, "APPROVAL") as "auto" | "all")
        : "commands",
  };
}


/** 解析 LLM_HEADERS（JSON 对象字符串）；非法时忽略并告警（不打印内容）。 */
function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value && /^[A-Za-z0-9-]+$/.test(key)) {
        headers[key] = value;
      }
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
  } catch {
    console.warn("[settings] LLM_HEADERS 不是合法 JSON，已忽略（内容不打印）");
    return undefined;
  }
}
