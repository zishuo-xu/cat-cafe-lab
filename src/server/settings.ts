/** 从环境变量解析运行配置。API key 只存在内存里，绝不落盘。 */

import type { LlmSettings, StudioSettings } from "../domain/types.ts";

export function readSettings(env: NodeJS.ProcessEnv = process.env): StudioSettings {
  const port = Number.parseInt(env.PORT ?? "4318", 10);
  const dataDir = env.CATCAFE_DATA_DIR?.trim() || "data";
  const stallMs = Number.parseInt(env.CATCAFE_STALL_MS ?? "12000", 10);

  const baseUrl = env.LLM_BASE_URL?.trim() ?? "";
  const apiKey = env.LLM_API_KEY?.trim() ?? "";
  const model = env.LLM_MODEL?.trim() ?? "";
  const llm: LlmSettings | null =
    baseUrl && model
      ? {
          baseUrl: baseUrl.replace(/\/+$/, ""),
          apiKey,
          model,
          temperature: Number.parseFloat(env.LLM_TEMPERATURE ?? "0.8"),
        }
      : null;

  return {
    port: Number.isFinite(port) ? port : 4318,
    dataDir,
    mode: llm ? "llm" : "mock",
    llm,
    stallMs: Number.isFinite(stallMs) && stallMs > 0 ? stallMs : 12000,
  };
}
