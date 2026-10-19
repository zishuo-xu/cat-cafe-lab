/**
 * 模型档案：一键把四只猫配置成「不同模型、不同分工」。
 *
 * 动机：猫咖的设定是「不同模型各有专长」。每猫 llmModel 早就有字段，
 * 但逐个手填太麻烦，也不知道该填什么。这里给几套可直接用的组合。
 *
 * 注意：这些是「推荐配置」，不是硬编码的默认值——用户可以随时改成自己的。
 */

import type { CatId } from "../domain/types.ts";

export interface ProfileAssignment {
  catId: CatId;
  model: string;
  temperature: number;
  /** 为什么给它这个模型。 */
  reason: string;
}

export interface ModelProfile {
  id: string;
  name: string;
  description: string;
  /** 适用的 provider（空表示通用）。 */
  endpoint?: string;
  assignments: ProfileAssignment[];
}

export const MODEL_PROFILES: ModelProfile[] = [
  {
    id: "opencode-mixed",
    name: "opencode · 混搭",
    description:
      "宪宪用推理强的模型做架构与评审，金渐层用快模型做实现，烁烁用便宜模型做设计。省钱且提速。",
    endpoint: "opencode.ai/zen/go",
    assignments: [
      { catId: "xianxian", model: "deepseek-v4.1-flash", temperature: 0.6, reason: "主架构师，推理链长但稳" },
      { catId: "yanyan", model: "qwen3.7-max", temperature: 0.3, reason: "Reviewer，需要严格与一致性" },
      { catId: "shuoshuo", model: "mimo-v2.6-flash", temperature: 0.9, reason: "设计，要发散、要快" },
      { catId: "jinjianceng", model: "mimo-v2.6-flash", temperature: 0.5, reason: "实现，要快、要能连续跑工具" },
    ],
  },
  {
    id: "opencode-fast",
    name: "opencode · 全快",
    description: "全部用最快的模型。适合演示，追求节奏而不是深度。",
    endpoint: "opencode.ai/zen/go",
    assignments: [
      { catId: "xianxian", model: "mimo-v2.6-flash", temperature: 0.7, reason: "快" },
      { catId: "yanyan", model: "mimo-v2.6-flash", temperature: 0.3, reason: "快且严格" },
      { catId: "shuoshuo", model: "mimo-v2.6-flash", temperature: 0.9, reason: "快且发散" },
      { catId: "jinjianceng", model: "mimo-v2.6-flash", temperature: 0.5, reason: "快" },
    ],
  },
  {
    id: "single-model",
    name: "统一模型（跟随全局）",
    description: "清掉每猫的模型覆盖，全部使用设置里的全局模型。",
    assignments: [],
  },
];

export function findProfile(id: string): ModelProfile | undefined {
  return MODEL_PROFILES.find((profile) => profile.id === id);
}

/** 按 endpoint 猜哪套档案适用（用于 UI 默认高亮）。 */
export function suggestedProfile(baseUrl: string): ModelProfile {
  const zen = MODEL_PROFILES.find(
    (profile) => profile.endpoint && baseUrl.includes(profile.endpoint),
  );
  if (zen) return zen;
  // 不认识这个端点：建议「统一模型」，不要凭空套 opencode 的模型名。
  return (
    MODEL_PROFILES.find((profile) => profile.id === "single-model") ??
    MODEL_PROFILES[MODEL_PROFILES.length - 1]!
  );
}
