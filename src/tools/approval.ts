/**
 * 铲屎官审批队列。
 *
 * driver 在执行"模型主动发起的工具调用"前会 request()，HTTP 层收到按钮点击后 resolve()。
 * 队列只存在内存里：进程重启后悬挂的审批随任务一起作废（不会误放行）。
 */

import type {
  ApprovalGate,
  CatId,
  ToolApprovalDecision,
  ToolApprovalMode,
  ToolName,
} from "../domain/types.ts";

export interface PendingApproval {
  callId: string;
  catId: CatId;
  tool: ToolName;
  label: string;
  mode: ToolApprovalMode;
  requestedAt: number;
}

interface Entry extends PendingApproval {
  resolve: (decision: ToolApprovalDecision) => void;
}

/** 审批超时：等待超过这个时间自动按拒绝处理，避免任务永远挂着。 */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export interface ApprovalRememberScope {
  catId: CatId;
  tool: ToolName;
}

export class ApprovalQueue implements ApprovalGate {
  private readonly entries = new Map<string, Entry>();
  /** 记住的选择：同一只猫 + 同一工具，本进程内直接放行/拒绝，不再问。 */
  private readonly remembered = new Map<string, ToolApprovalDecision>();
  /** 超时处理回调（HTTP 层可用来在 UI 上提示）。 */
  onTimeout?: (callId: string) => void;

  request(input: {
    callId: string;
    mode: ToolApprovalMode;
    tool: ToolName;
    label: string;
    catId: CatId;
  }): Promise<ToolApprovalDecision> {
    const key = rememberKey(input.catId, input.tool);
    const remembered = this.remembered.get(key);
    if (remembered) return Promise.resolve(remembered);

    return new Promise<ToolApprovalDecision>((resolve) => {
      let settled = false;
      const finish = (decision: ToolApprovalDecision): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(decision);
      };
      const timer = setTimeout(() => {
        if (!this.entries.has(input.callId)) return;
        this.entries.delete(input.callId);
        this.onTimeout?.(input.callId);
        finish("rejected");
      }, APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      this.entries.set(input.callId, {
        ...input,
        requestedAt: Date.now(),
        resolve: finish,
      });
    });
  }

  /** 记住选择：true 表示之后同类审批不再询问。 */
  remember(callId: string, decision: ToolApprovalDecision): boolean {
    const entry = this.entries.get(callId);
    if (!entry) return false;
    this.remembered.set(rememberKey(entry.catId, entry.tool), decision);
    return this.resolve(callId, decision);
  }

  /** 清空记住的选择（设置面板 / 测试用）。 */
  clearRemembered(): void {
    this.remembered.clear();
  }

  rememberedCount(): number {
    return this.remembered.size;
  }

  resolve(callId: string, decision: ToolApprovalDecision): boolean {
    const entry = this.entries.get(callId);
    if (!entry) return false;
    this.entries.delete(callId);
    entry.resolve(decision);
    return true;
  }

  list(): PendingApproval[] {
    return [...this.entries.values()]
      .map(({ resolve: _resolve, ...rest }) => rest)
      .sort((a, b) => a.requestedAt - b.requestedAt);
  }

  /** 进程退出/测试清理用：所有悬挂审批按拒绝处理。 */
  rejectAll(): void {
    for (const [callId, entry] of this.entries) {
      this.entries.delete(callId);
      entry.resolve("rejected");
    }
  }
}


function rememberKey(catId: CatId, tool: ToolName): string {
  return `${catId}:${tool}`;
}
