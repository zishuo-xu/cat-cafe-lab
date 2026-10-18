/** 技能包：注入真实模式 system prompt 的方法论。T2 负责润色内容。 */

import type { Cat, Role, Skill } from "../domain/types.ts";

export const BUILTIN_SKILLS: Skill[] = [
  {
    id: "architecture",
    name: "架构拆解",
    description: "接需求时先钉边界与风险，再拆活。",
    prompt: `【技能：架构拆解】
- 先复述需求并给结论，再把 1–2 个会返工的风险（安全、兼容、回滚）摆到桌上；
- 活拆到「一只猫能独立完成并自测」的粒度，写清依赖顺序和谁在等谁；
- 交接卡必须写取舍与被否掉的方案；未决问题列出来，不替下游拍板。`,
  },
  {
    id: "review-checklist",
    name: "Review 清单",
    description: "只认证据、按编号给结论。",
    prompt: `【技能：Review 清单】
- 先跑测试、看真实输出，再读代码；结论只认证据，问题按 blocker / minor 编号；
- 每条 finding 写清「现象—危害—改法」，能复现就附命令或输入；
- 边界不放过：过期、并发、失败重试、权限绕过；没证据的「我觉得可以」不算通过。`,
  },
  {
    id: "design-system",
    name: "设计系统",
    description: "先定状态与文案，再谈视觉。",
    prompt: `【技能：设计系统】
- 每个控件先列全状态：默认 / 悬停 / 禁用 / 加载 / 错误 / 空，再谈颜色和动效；
- 文案单独拿出来也要读得通，并写明「在什么设备上生效」这类限定；
- 动效只服务理解（状态变化、进度反馈），不做纯装饰；先给一版可实现的最小方案。`,
  },
  {
    id: "tdd",
    name: "TDD 纪律",
    description: "先让测试失败，再改代码让它通过。",
    prompt: `【技能：TDD 纪律】
- 动代码前先跑测试，确认当前失败点和对应断言，别凭感觉改；
- 一次只修一个失败原因，改完立刻复跑全套：先让测试红，再让它绿；
- 不为了让测试通过而改测试；真要改，先在交接卡写明测试本身哪里错了。`,
  },
];

/** 角色默认技能：猫没有显式配置 skills 时用这套。 */
const SKILLS_BY_ROLE: Record<Role, string[]> = {
  architect: ["architecture"],
  reviewer: ["review-checklist"],
  designer: ["design-system"],
  implementer: ["tdd"],
};

export function listSkills(): Skill[] {
  return [...BUILTIN_SKILLS];
}

export function getSkill(id: string): Skill | undefined {
  return BUILTIN_SKILLS.find((skill) => skill.id === id);
}

/**
 * 解析一只猫实际挂载的技能包：
 * - `cat.skills` 优先（用户/档案里配过就用它）；
 * - 没配或配了空数组时，回落到角色默认；
 * - 未知 id 直接忽略、重复 id 去重，坏配置不会把 system prompt 带崩。
 */
export function skillsForCat(cat: Cat): Skill[] {
  const ids = cat.skills && cat.skills.length > 0 ? cat.skills : SKILLS_BY_ROLE[cat.role];
  const skills: Skill[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    const skill = getSkill(id);
    if (!skill) continue;
    seen.add(id);
    skills.push(skill);
  }
  return skills;
}
