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

export class ApprovalQueue implements ApprovalGate {
  private readonly entries = new Map<string, Entry>();

  request(input: {
    callId: string;
    mode: ToolApprovalMode;
    tool: ToolName;
    label: string;
    catId: CatId;
  }): Promise<ToolApprovalDecision> {
    return new Promise<ToolApprovalDecision>((resolve) => {
      this.entries.set(input.callId, {
        ...input,
        requestedAt: Date.now(),
        resolve,
      });
    });
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
