/** 稳定 id 生成：前缀 + 时间 + 自增计数 + 随机后缀。 */

let counter = 0;

function suffix(): string {
  counter = (counter + 1) % 36 ** 4;
  return (
    Date.now().toString(36).slice(-5) +
    counter.toString(36).padStart(2, "0") +
    Math.random().toString(36).slice(2, 5)
  );
}

export function newId(prefix: string): string {
  return `${prefix}_${suffix()}`;
}

export const ids = {
  room: () => newId("room"),
  message: () => newId("msg"),
  task: () => newId("task"),
  step: () => newId("step"),
  handoff: () => newId("ho"),
  artifact: () => newId("art"),
  memory: () => newId("mem"),
  workspace: () => newId("ws"),
};
