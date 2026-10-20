/**
 * 测试用假 Driver。
 *
 * 之前 11 个测试文件各自复制了一份，新增 Driver 方法时要改 11 处——
 * 抽到这里之后，接口变化只需要改一个文件。
 */

import type { Driver, EngineEvent } from "../../src/domain/types.ts";

export interface FakeDriver extends Driver {
  /** 记录所有 submit 过来的事件（需要断言的测试用）。 */
  events: EngineEvent[];
}

export function fakeDriver(overrides: Partial<Driver> = {}): FakeDriver {
  const events: EngineEvent[] = [];
  return {
    events,
    submit(event) {
      events.push(event);
    },
    setProactive() {},
    async patrol() {},
    async whenIdle() {},
    stallMs: 12_000,
    ...overrides,
  };
}
