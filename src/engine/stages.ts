/**
 * 任务状态机：阶段流转、owner 决策、交接 / 评审目标推导。
 *
 * 这里是**纯函数**，不碰 Studio；driver 负责把决策落成 mutator 调用。
 *
 * 主流程：
 *   intake → planning → working → reviewing →(revising → reviewing)*→ done
 */

import type {
  Artifact,
  Cat,
  CatId,
  ReviewFinding,
  ReviewVerdict,
  Role,
  TaskStage,
} from "../domain/types.ts";

/** 正常主流程顺序（revising 是 reviewing 的回环，不在线性序列里重复）。 */
export const STAGE_FLOW: readonly TaskStage[] = [
  "intake",
  "planning",
  "working",
  "reviewing",
  "revising",
  "done",
];

/** working / revising 都是「产生产物」的工作阶段。 */
export function isWorkerStage(stage: TaskStage): boolean {
  return stage === "working" || stage === "revising";
}

export function isTerminalStage(stage: TaskStage): boolean {
  return stage === "done";
}

export function findByRole(cats: readonly Cat[], role: Role): Cat | null {
  return cats.find((cat) => cat.role === role) ?? null;
}

export function catById(cats: readonly Cat[], id: CatId): Cat | null {
  return cats.find((cat) => cat.id === id) ?? null;
}

/** 主理猫：role=architect；配置缺失时退化为第一只猫，方便测试 / 自定义房间。 */
export function architectOf(cats: readonly Cat[]): Cat | null {
  return findByRole(cats, "architect") ?? cats[0] ?? null;
}

/** 进入下一阶段的目标。 */
export interface StageMove {
  stage: TaskStage;
  cat: Cat;
}

/**
 * 交接目标 ⇒ 下一阶段与 owner：
 *   - 交给 reviewer → reviewing；
 *   - reviewing/revising 里交给其他人 → revising（打回返工）；
 *   - 其余情况 → working。
 */
export function handoffMove(current: TaskStage, target: Cat): StageMove {
  if (target.role === "reviewer") return { stage: "reviewing", cat: target };
  if (current === "reviewing" || current === "revising") {
    return { stage: "revising", cat: target };
  }
  return { stage: "working", cat: target };
}

/**
 * review 结论 ⇒ 下一阶段与 owner：
 *   - request_changes → revising，回到实现者；
 *   - approve → done，交给 architect 落 decision。
 */
export function reviewMove(
  cats: readonly Cat[],
  verdict: ReviewVerdict,
  mentions: readonly CatId[],
  artifacts: readonly Artifact[],
): StageMove | null {
  if (verdict === "approve") {
    const architect = architectOf(cats);
    return architect ? { stage: "done", cat: architect } : null;
  }
  const target = pickReviseTarget(cats, mentions, artifacts);
  return target ? { stage: "revising", cat: target } : null;
}

/**
 * 打回后回到谁：优先被 @ 的实现者，其次 @ 到的其他作者，
 * 再次最近一个 patch 的作者，最后按角色兜底。
 */
export function pickReviseTarget(
  cats: readonly Cat[],
  mentions: readonly CatId[],
  artifacts: readonly Artifact[],
): Cat | null {
  const mentioned = mentions
    .map((id) => catById(cats, id))
    .filter((cat): cat is Cat => cat !== null);

  const implementer = mentioned.find((cat) => cat.role === "implementer");
  if (implementer) return implementer;

  const otherWorker = mentioned.find(
    (cat) => cat.role === "designer" || cat.role === "implementer",
  );
  if (otherWorker) return otherWorker;

  for (let i = artifacts.length - 1; i >= 0; i -= 1) {
    const artifact = artifacts[i];
    if (artifact && artifact.kind === "patch") {
      const author = catById(cats, artifact.author);
      if (author) return author;
    }
  }

  return findByRole(cats, "implementer") ?? findByRole(cats, "designer");
}

/**
 * review 落库正文（前端按固定格式解析，勿改）：
 *
 *   verdict: request_changes
 *
 *   - [blocker] 标题 — 详情
 *   - [minor] 标题 — 详情
 */
export function formatReviewBody(
  verdict: ReviewVerdict,
  findings: readonly ReviewFinding[],
): string {
  const lines: string[] = [`verdict: ${verdict}`, ""];
  for (const finding of findings) {
    lines.push(`- [${finding.severity}] ${finding.title} — ${finding.detail}`);
  }
  return lines.join("\n");
}
