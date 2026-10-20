/**
 * @mention 解析与投递规则（纯函数）。
 *
 * driver 用这些函数决定：用户消息该唤醒谁、交接卡该 @ 谁。
 * 解析规则与 HTTP 层保持一致：支持 @名字（前缀匹配）与 @catId。
 */

import type { Member, MemberId, Task } from "../domain/types.ts";

const MENTION_RE = /@([^\s@，。！？,.!?、:：;；]+)/g;

/** 从文本里解析被 @ 的成员：先按 id，再按名字（允许「@周烁顺便」这种连写）。 */
export function parseMentions(text: string, cats: readonly Member[]): MemberId[] {
  const found = new Set<MemberId>();
  for (const match of text.matchAll(MENTION_RE)) {
    const token = match[1] ?? "";
    const cat =
      cats.find((c) => c.id === token) ??
      cats.find((c) => token === c.name || token.startsWith(c.name));
    if (cat) found.add(cat.id);
  }
  return [...found];
}

/** 过滤未知成员、去重，保持原顺序。 */
export function normalizeMentions(
  mentions: readonly MemberId[] | undefined,
  cats: readonly Member[],
): MemberId[] {
  if (!mentions || mentions.length === 0) return [];
  const known = new Set(cats.map((c) => c.id));
  const seen = new Set<MemberId>();
  const result: MemberId[] = [];
  for (const id of mentions) {
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * 用户消息路由：
 *   1. 只唤醒被 @ 的成员（可多只）；
 *   2. 没有 @ 时唤醒当前任务 owner；
 *   3. 没有任务时唤醒架构师（architect）。
 */
export function routeUserMessage(
  cats: readonly Member[],
  task: Task | null,
  mentions: readonly MemberId[] | undefined,
): MemberId[] {
  const named = normalizeMentions(mentions, cats);
  if (named.length > 0) return named;

  if (task) {
    const owner = cats.find((c) => c.id === task.owner);
    if (owner) return [owner.id];
  }

  const architect = cats.find((c) => c.role === "architect") ?? cats[0];
  return architect ? [architect.id] : [];
}

/**
 * 交接消息 @ 谁。漏 @ 埋点（fault: "missed_mention"）时**仍然**写接收者，
 * 表示「本意是给它的、但没递到」，只是 driver 不会因此唤醒它。
 */
export function handoffMentions(to: MemberId): MemberId[] {
  return [to];
}
