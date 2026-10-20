/**
 * 工作区：一个房间可以绑定一个目录。
 *
 * 安全默认：
 * - 内置沙盒工作区（data/workspace）可读写，供演示使用；
 * - 用户添加的仓库默认 read-only，只有显式确认才给 read-write；
 * - 只读工作区禁止 write_file / run_command（读和列目录不受影响）；
 * - git 只做只读查询（status / diff / log），本阶段不自动 checkout / commit。
 */

import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { DEFAULT_WORKSPACE_ID } from "../domain/constants.ts";
import { ids } from "../domain/ids.ts";
import type {
  SandboxFile,
  SandboxRunner,
  ToolResult,
  Workspace,
  WorkspaceGitInfo,
  WorkspacePolicy,
} from "../domain/types.ts";
import { Sandbox } from "../tools/sandbox.ts";

const MAX_GIT_OUTPUT = 100_000;

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
};

/** 只读策略包装：拦下会改文件的工具。 */
export class PolicySandbox implements SandboxRunner {
  private readonly inner: Sandbox;
  private readonly policy: WorkspacePolicy;
  private readonly label: string;

  constructor(inner: Sandbox, policy: WorkspacePolicy, label: string) {
    this.inner = inner;
    this.policy = policy;
    this.label = label;
  }

  async execute(tool: string, input: Record<string, unknown>): Promise<ToolResult> {
    if (this.policy === "read-only" && (tool === "write_file" || tool === "run_command")) {
      return {
        status: "error",
        output: `工作区「${this.label}」是只读的，禁止 ${tool}。需要写入请先在设置里授予读写权限。`,
      };
    }
    return this.inner.execute(tool, input);
  }
}

export interface AddWorkspaceInput {
  name?: unknown;
  path?: unknown;
  policy?: unknown;
  branchPerTask?: unknown;
}

export class WorkspaceManager {
  private readonly dataDir: string;
  private readonly file: string;
  private readonly custom: Workspace[] = [];
  private readonly sandboxes = new Map<string, { sandbox: Sandbox; policy: PolicySandbox }>();

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    this.file = join(this.dataDir, "workspaces.json");
    for (const workspace of this.load()) this.custom.push(workspace);
    this.ensureSandbox(this.defaultWorkspace());
  }

  list(): Workspace[] {
    return [this.defaultWorkspace(), ...this.custom].map((workspace) => ({ ...workspace }));
  }

  get(id: string): Workspace | undefined {
    if (id === DEFAULT_WORKSPACE_ID) return this.defaultWorkspace();
    const found = this.custom.find((workspace) => workspace.id === id);
    return found ? { ...found } : undefined;
  }

  /** 给工具执行用的受限沙盒。 */
  sandboxFor(workspaceId: string | undefined): SandboxRunner {
    const workspace = this.get(workspaceId ?? DEFAULT_WORKSPACE_ID) ?? this.defaultWorkspace();
    return this.ensureSandbox(workspace).policy;
  }

  /** 给文件浏览 / git 查询用的原始沙盒（不做写策略拦截）。 */
  rawSandbox(workspaceId: string | undefined): Sandbox {
    const workspace = this.get(workspaceId ?? DEFAULT_WORKSPACE_ID) ?? this.defaultWorkspace();
    return this.ensureSandbox(workspace).sandbox;
  }

  files(workspaceId: string | undefined): SandboxFile[] {
    return this.rawSandbox(workspaceId).listFiles();
  }

  add(input: AddWorkspaceInput): Workspace {
    const raw = (input ?? {}) as Record<string, unknown>;
    const name = typeof raw["name"] === "string" ? raw["name"].trim() : "";
    if (!name || name.length > 40) throw new Error("name 需要 1–40 个字符");

    const rawPath = typeof raw["path"] === "string" ? raw["path"].trim() : "";
    if (!rawPath || !isAbsolute(rawPath)) throw new Error("path 必须是绝对路径");
    const root = resolve(rawPath);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`目录不存在：${root}`);
    }
    const canonical = realpathSync(root);

    const policy: WorkspacePolicy =
      raw["policy"] === "read-write" ? "read-write" : "read-only";

    if (this.list().some((workspace) => workspace.root === canonical)) {
      throw new Error("这个目录已经是一个工作区");
    }
    if (canonical === this.dataDir || canonical.startsWith(`${this.dataDir}/`)) {
      throw new Error("不要把交付台自己的数据目录添加为工作区");
    }

    const workspace: Workspace = {
      id: ids.workspace(),
      name,
      root: canonical,
      policy,
      kind: "repo",
      isGit: existsSync(join(canonical, ".git")),
      branchPerTask: raw["branchPerTask"] !== false,
      createdAt: Date.now(),
    };
    this.custom.push(workspace);
    this.persist();
    return { ...workspace };
  }

  remove(id: string): boolean {
    if (id === DEFAULT_WORKSPACE_ID) throw new Error("内置沙盒工作区不能删除");
    const index = this.custom.findIndex((workspace) => workspace.id === id);
    if (index < 0) return false;
    this.custom.splice(index, 1);
    this.sandboxes.delete(id);
    this.persist();
    return true;
  }

  async gitInfo(workspaceId: string): Promise<WorkspaceGitInfo> {
    const workspace = this.get(workspaceId);
    if (!workspace) return { workspaceId, isGit: false, error: "工作区不存在" };
    if (!workspace.isGit) return { workspaceId, isGit: false };

    const branch = await this.git(workspace.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = await this.git(workspace.root, ["status", "--porcelain=v1"]);
    const diffStat = await this.git(workspace.root, ["diff", "--stat"]);
    const lastCommit = await this.git(workspace.root, ["log", "-1", "--pretty=%h %s"]);

    const info: WorkspaceGitInfo = {
      workspaceId,
      isGit: true,
      branch: branch.ok ? branch.stdout.trim() : undefined,
      status: status.ok ? status.stdout.trim().slice(0, 20_000) : undefined,
      clean: status.ok ? status.stdout.trim() === "" : undefined,
      diffStat: diffStat.ok ? diffStat.stdout.trim().slice(0, 20_000) : undefined,
      lastCommit: lastCommit.ok ? lastCommit.stdout.trim() : undefined,
    };
    const error = [branch, status, diffStat, lastCommit].find((result) => !result.ok)?.stderr;
    if (error) info.error = error.trim().slice(0, 500);
    return info;
  }

  async gitDiff(workspaceId: string): Promise<{ ok: boolean; diff: string; error?: string }> {
    const workspace = this.get(workspaceId);
    if (!workspace) return { ok: false, diff: "", error: "工作区不存在" };
    if (!workspace.isGit) return { ok: false, diff: "", error: "不是 git 仓库" };
    const result = await this.git(workspace.root, ["diff", "--no-color"]);
    if (!result.ok) return { ok: false, diff: "", error: result.stderr.trim().slice(0, 500) };
    const diff = result.stdout.slice(0, MAX_GIT_OUTPUT);
    return {
      ok: true,
      diff: diff.length < result.stdout.length ? `${diff}\n…（diff 已截断）` : diff,
    };
  }

  /**
   * 任务开始时建分支：只有读写 git 仓库、branchPerTask=true、工作树干净时才建。
   * 任何一步失败都返回 error，不半途留垃圾状态。
   */
  async createTaskBranch(
    workspaceId: string,
    taskId: string,
  ): Promise<{ branch?: string; baseBranch?: string; baseCommit?: string; error?: string }> {
    const workspace = this.get(workspaceId);
    if (!workspace) return { error: "工作区不存在" };
    if (!workspace.isGit) return { error: "不是 git 仓库，跳过任务分支" };
    if (workspace.policy !== "read-write") return { error: "只读工作区不创建任务分支" };
    if (!workspace.branchPerTask) return {};

    const current = await this.git(workspace.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (current.ok && current.stdout.trim().startsWith("deliverylab/")) {
      return { error: `当前在任务分支 ${current.stdout.trim()} 上，请先提交或回滚再开新任务` };
    }

    const status = await this.git(workspace.root, ["status", "--porcelain=v1"]);
    if (!status.ok) return { error: status.stderr.trim() || "git status 失败" };
    if (status.stdout.trim()) {
      return { error: "工作区有未提交改动，未创建任务分支；请先清理工作树" };
    }

    const baseBranch = await this.git(workspace.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const baseCommit = await this.git(workspace.root, ["rev-parse", "HEAD"]);
    const branch = `deliverylab/${taskId}`;
    const created = await this.git(workspace.root, ["checkout", "-b", branch]);
    if (!created.ok) return { error: created.stderr.trim() || "创建分支失败" };
    return {
      branch,
      baseBranch: baseBranch.stdout.trim(),
      baseCommit: baseCommit.stdout.trim(),
    };
  }

  /** 任务 diff：已提交看 base...branch，否则看当前工作树。 */
  async taskDiff(
    workspaceId: string,
    taskGit?: { branch?: string; baseBranch?: string; commit?: string },
  ): Promise<{ ok: boolean; branch?: string; base?: string; status?: string; diff: string; error?: string }> {
    const workspace = this.get(workspaceId);
    if (!workspace) return { ok: false, diff: "", error: "工作区不存在" };
    if (!workspace.isGit) return { ok: false, diff: "", error: "不是 git 仓库" };

    const status = await this.git(workspace.root, ["status", "--porcelain=v1"]);
    const range =
      taskGit?.branch && taskGit.commit && taskGit.baseBranch
        ? `${taskGit.baseBranch}...${taskGit.branch}`
        : null;
    const diff = await this.git(
      workspace.root,
      range ? ["diff", "--no-color", range] : ["diff", "--no-color"],
    );
    if (!diff.ok) return { ok: false, diff: "", error: diff.stderr.trim() || "git diff 失败" };
    const text = diff.stdout.length > MAX_GIT_OUTPUT
      ? `${diff.stdout.slice(0, MAX_GIT_OUTPUT)}\n…（diff 已截断）`
      : diff.stdout;
    return {
      ok: true,
      ...(taskGit?.branch ? { branch: taskGit.branch } : {}),
      ...(taskGit?.baseBranch ? { base: taskGit.baseBranch } : {}),
      status: status.ok ? status.stdout.trim().slice(0, 20_000) : undefined,
      diff: text,
    };
  }

  /** 人工确认后提交：只允许读写 git 工作区；在任务分支上时校验分支。 */
  async commitTask(
    workspaceId: string,
    taskGit: { branch?: string; baseBranch?: string } | undefined,
    message: string,
  ): Promise<{ ok: boolean; commit?: string; error?: string }> {
    const workspace = this.get(workspaceId);
    if (!workspace) return { ok: false, error: "工作区不存在" };
    if (!workspace.isGit) return { ok: false, error: "不是 git 仓库" };
    if (workspace.policy !== "read-write") {
      return { ok: false, error: "只读工作区不能提交，请先授予读写权限" };
    }
    const cleanMessage = message.trim();
    if (!cleanMessage || cleanMessage.length > 200) {
      return { ok: false, error: "commit message 需要 1–200 个字符" };
    }
    if (!taskGit?.branch) {
      return {
        ok: false,
        error: "任务没有独立分支，拒绝提交；请在工作区开启「任务分支」后重新开任务",
      };
    }
    {
      const current = await this.git(workspace.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (!current.ok || current.stdout.trim() !== taskGit.branch) {
        return { ok: false, error: `当前不在任务分支 ${taskGit.branch} 上，拒绝提交` };
      }
    }
    const added = await this.git(workspace.root, ["add", "-A"]);
    if (!added.ok) return { ok: false, error: added.stderr.trim() || "git add 失败" };
    const committed = await this.git(workspace.root, ["commit", "-m", cleanMessage]);
    if (!committed.ok) {
      const detail = `${committed.stdout}\n${committed.stderr}`.trim();
      return { ok: false, error: detail.includes("nothing to commit") ? "没有可提交的改动" : detail };
    }
    const head = await this.git(workspace.root, ["rev-parse", "HEAD"]);
    // 提交后回到 base 分支，任务分支保留给人工 review / merge。
    if (taskGit?.baseBranch) {
      await this.git(workspace.root, ["checkout", taskGit.baseBranch]);
    }
    return { ok: true, ...(head.ok ? { commit: head.stdout.trim() } : {}) };
  }

  /**
   * 回滚：用 git stash -u 收走改动（可恢复），有任务分支时切回 base 并删除空分支。
   * 已提交的任务拒绝回滚，避免动历史。
   */
  async rollbackTask(
    workspaceId: string,
    taskGit: { branch?: string; baseBranch?: string; commit?: string } | undefined,
    taskId: string,
  ): Promise<{ ok: boolean; stash?: string; error?: string; note?: string }> {
    const workspace = this.get(workspaceId);
    if (!workspace) return { ok: false, error: "工作区不存在" };
    if (!workspace.isGit) return { ok: false, error: "不是 git 仓库" };
    if (workspace.policy !== "read-write") {
      return { ok: false, error: "只读工作区不能回滚，请先授予读写权限" };
    }
    if (taskGit?.commit) {
      return { ok: false, error: "任务已提交，回滚请手动处理分支（stash 不会撤销 commit）" };
    }
    const status = await this.git(workspace.root, ["status", "--porcelain=v1"]);
    if (status.ok && !status.stdout.trim()) {
      return { ok: true, note: "没有改动需要回滚" };
    }
    const label = `deliverylab-rollback-${taskId}`;
    const stash = await this.git(workspace.root, ["stash", "push", "-u", "-m", label]);
    if (!stash.ok) return { ok: false, error: stash.stderr.trim() || "git stash 失败" };

    if (taskGit?.branch) {
      if (taskGit.baseBranch) await this.git(workspace.root, ["checkout", taskGit.baseBranch]);
      await this.git(workspace.root, ["branch", "-D", taskGit.branch]);
    }
    return { ok: true, stash: label, note: `改动已收进 ${label}，可用 git stash list 找回` };
  }

  close(): void {
    this.sandboxes.clear();
  }

  // ── 内部 ──────────────────────────────────────────────

  private defaultWorkspace(): Workspace {
    return {
      id: DEFAULT_WORKSPACE_ID,
      name: "交付台沙盒",
      root: join(this.dataDir, "workspace"),
      policy: "read-write",
      kind: "sandbox",
      isGit: false,
      branchPerTask: false,
      createdAt: 0,
    };
  }

  private ensureSandbox(workspace: Workspace): { sandbox: Sandbox; policy: PolicySandbox } {
    const cached = this.sandboxes.get(workspace.id);
    if (cached) return cached;
    const sandbox = new Sandbox(workspace.root);
    if (workspace.kind === "sandbox") sandbox.ensureSeed();
    const policy = new PolicySandbox(sandbox, workspace.policy, workspace.name);
    const entry = { sandbox, policy };
    this.sandboxes.set(workspace.id, entry);
    return entry;
  }

  private git(
    root: string,
    args: string[],
  ): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return new Promise((done) => {
      execFile(
        "git",
        args,
        { cwd: root, timeout: 5000, maxBuffer: 2 * 1024 * 1024, env: GIT_ENV },
        (error, stdout, stderr) => {
          done({
            ok: !error,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? "") || (error ? String(error.message) : ""),
          });
        },
      );
    });
  }

  private load(): Workspace[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (!Array.isArray(parsed)) return [];
      const workspaces: Workspace[] = [];
      for (const raw of parsed) {
        if (!raw || typeof raw !== "object") continue;
        const record = raw as Record<string, unknown>;
        if (typeof record["id"] !== "string" || typeof record["root"] !== "string") continue;
        if (!existsSync(record["root"])) continue;
        workspaces.push({
          id: record["id"],
          name: typeof record["name"] === "string" ? record["name"] : record["id"],
          root: record["root"],
          policy: record["policy"] === "read-write" ? "read-write" : "read-only",
          kind: "repo",
          isGit: existsSync(join(record["root"], ".git")),
          branchPerTask: record["branchPerTask"] !== false,
          createdAt: typeof record["createdAt"] === "number" ? record["createdAt"] : Date.now(),
        });
      }
      return workspaces;
    } catch (err) {
      console.warn("[workspaces] 读取配置失败：", err);
      return [];
    }
  }

  private persist(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.custom, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      console.error("[workspaces] 保存配置失败：", err);
    }
  }
}
