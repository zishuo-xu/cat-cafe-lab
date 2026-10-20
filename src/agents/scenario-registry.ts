/**
 * 剧本库：内置剧本 + 可导入的自定义剧本。
 *
 * SCENARIOS 的数组身份必须稳定：driver 和 HTTP 层在启动时拿到这个引用，
 * 之后导入/删除都原地 push/splice，运营期即时生效。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Scenario, ScenarioWithSource } from "../domain/types.ts";
import { validateScenario } from "./scenario-validation.ts";
import { SCENARIOS as BUILTIN_SCENARIOS } from "./scenarios.ts";

export const BUILTIN_SCENARIO_IDS: readonly string[] = BUILTIN_SCENARIOS.map((s) => s.id);

/** 全量剧本（内置在前，自定义在后）。保持同一数组引用。 */
export const SCENARIOS: Scenario[] = [...BUILTIN_SCENARIOS];

let filePath: string | null = null;
let validMemberIds: string[] = [];

export function initScenarios(dataDir: string, catIds: string[]): void {
  validMemberIds = [...catIds];
  filePath = join(dataDir, "scenarios.json");
  SCENARIOS.splice(BUILTIN_SCENARIOS.length, SCENARIOS.length - BUILTIN_SCENARIOS.length);

  if (!existsSync(filePath)) return;
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!Array.isArray(parsed)) return;
    for (const raw of parsed) {
      const result = validateScenario(raw, { catIds: validMemberIds });
      if (!result.ok) {
        console.warn(`[scenarios] 跳过无效自定义剧本：${result.errors[0] ?? "unknown"}`);
        continue;
      }
      if (isBuiltinScenario(result.scenario.id)) continue;
      SCENARIOS.push(result.scenario);
    }
  } catch (err) {
    console.warn("[scenarios] 读取自定义剧本失败，忽略：", err);
  }
}

/** 成员增删后同步「合法成员 id 列表」，否则导入自定义剧本会校验失败。 */
export function setValidMemberIds(catIds: string[]): void {
  validMemberIds = [...catIds];
}

export function listScenarios(): ScenarioWithSource[] {
  return SCENARIOS.map((scenario) => ({
    scenario,
    source: isBuiltinScenario(scenario.id) ? "builtin" : "custom",
  }));
}

export function getScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

export function isBuiltinScenario(id: string): boolean {
  return BUILTIN_SCENARIO_IDS.includes(id);
}

export function addScenario(
  raw: unknown,
): { ok: true; scenario: Scenario } | { ok: false; errors: string[] } {
  const result = validateScenario(raw, { catIds: validMemberIds });
  if (!result.ok) return result;
  if (SCENARIOS.some((s) => s.id === result.scenario.id)) {
    return { ok: false, errors: [`剧本 id "${result.scenario.id}" 已存在`] };
  }
  SCENARIOS.push(result.scenario);
  persist();
  return { ok: true, scenario: result.scenario };
}

export function removeScenario(id: string): "removed" | "builtin" | "not_found" {
  if (isBuiltinScenario(id)) return "builtin";
  const index = SCENARIOS.findIndex((s) => s.id === id);
  if (index < 0) return "not_found";
  SCENARIOS.splice(index, 1);
  persist();
  return "removed";
}

function persist(): void {
  if (!filePath) return;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const custom = SCENARIOS.filter((s) => !isBuiltinScenario(s.id));
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(custom, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, filePath);
  } catch (err) {
    console.error("[scenarios] 保存自定义剧本失败：", err);
  }
}
