/** C-2：任务分支 / 真实 diff / 人工 commit / stash 回滚。 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import type { Driver } from "../src/domain/types.ts";
import { createHttpServer } from "../src/server/http.ts";
import { Studio } from "../src/server/studio.ts";
import { WorkspaceManager } from "../src/workspaces/manager.ts";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "catcafe-git-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "cat@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Cat Café"], { cwd: dir });
  writeFileSync(join(dir, "app.js"), "export const x = 1;\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function resetRepo(dir: string): void {
  execFileSync("git", ["checkout", "-q", "main"], { cwd: dir });
  execFileSync("git", ["reset", "--hard", "-q"], { cwd: dir });
  const branches = execFileSync("git", ["branch", "--list", "catcafe/*"], {
    cwd: dir,
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.replace(/^[* ]+/, "").trim())
    .filter(Boolean);
  for (const branch of branches) {
    execFileSync("git", ["branch", "-D", branch], { cwd: dir });
  }
}

function fakeDriver(): Driver {
  return { submit() {}, async whenIdle() {}, stallMs: 12000 };
}

describe("C-2 任务 git 工作流", () => {
  let dataDir: string;
  let repoDir: string;
  let readonlyRepoDir: string;
  let noBranchRepoDir: string;
  let plainDir: string;
  let manager: WorkspaceManager;
  let studio: Studio;
  let server: ReturnType<typeof createHttpServer>;
  let base: string;
  let roomId: string;
  let writableId: string;
  let readOnlyId: string;
  let plainId: string;
  let noBranchId: string;

  async function listen(target: ReturnType<typeof createHttpServer>): Promise<string> {
    await new Promise<void>((done) => target.listen(0, "127.0.0.1", () => done()));
    const address = target.address();
    if (!address || typeof address !== "object") throw new Error("no port");
    return `http://127.0.0.1:${address.port}`;
  }

  async function createTask(brief: string): Promise<{ id: string; git?: { branch?: string; error?: string } }> {
    const res = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId, brief }),
    });
    assert.equal(res.status, 201);
    return (await res.json()) as { id: string; git?: { branch?: string; error?: string } };
  }

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "catcafe-git-data-"));
    repoDir = makeRepo();
    readonlyRepoDir = makeRepo();
    noBranchRepoDir = makeRepo();
    plainDir = mkdtempSync(join(tmpdir(), "catcafe-plain-"));
    writeFileSync(join(plainDir, "note.txt"), "hello", "utf8");

    manager = new WorkspaceManager(dataDir);
    writableId = manager.add({ name: "Writable Repo", path: repoDir, policy: "read-write" }).id;
    readOnlyId = manager.add({
      name: "Readonly Repo",
      path: readonlyRepoDir,
      policy: "read-only",
    }).id;
    plainId = manager.add({ name: "Plain", path: plainDir }).id;
    noBranchId = manager.add({
      name: "No Branch",
      path: noBranchRepoDir,
      policy: "read-write",
      branchPerTask: false,
    }).id;

    studio = new Studio({ cats: CATS, mode: "mock" });
    roomId = studio.createRoom({ name: "Repo Room", workspaceId: writableId }).id;

    server = createHttpServer({
      studio,
      driver: fakeDriver(),
      publicDir: resolve(import.meta.dirname, "../public"),
      scenarios: SCENARIOS,
      workspaces: manager,
      mode: "mock",
    });
    base = await listen(server);
  });

  beforeEach(() => {
    resetRepo(repoDir);
    resetRepo(readonlyRepoDir);
    resetRepo(noBranchRepoDir);
  });

  after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    manager.close();
    studio.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(readonlyRepoDir, { recursive: true, force: true });
    rmSync(noBranchRepoDir, { recursive: true, force: true });
    rmSync(plainDir, { recursive: true, force: true });
  });

  test("建任务自动创建 catcafe/<taskId> 分支", async () => {
    const task = await createTask("给登录页加记住我");
    assert.ok(task.git?.branch?.startsWith("catcafe/task_"));
    assert.equal(git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]), task.git?.branch);
    // 干净分支，可以继续干活。
    assert.equal(git(repoDir, ["status", "--porcelain=v1"]), "");
  });

  test("任务 diff 展示工作树改动；commit 需要确认", async () => {
    const task = await createTask("修改 app.js");
    const sandbox = manager.sandboxFor(writableId);
    const write = await sandbox.execute("write_file", {
      path: "app.js",
      content: "export const x = 2;\n",
    });
    assert.equal(write.status, "ok");

    const diff = await fetch(`${base}/api/tasks/${task.id}/diff`);
    assert.equal(diff.status, 200);
    const diffBody = (await diff.json()) as { ok: boolean; diff: string; status?: string };
    assert.equal(diffBody.ok, true);
    assert.match(diffBody.diff, /export const x = 2/);
    assert.match(diffBody.status ?? "", /M app\.js/);

    const noConfirm = await fetch(`${base}/api/tasks/${task.id}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "feat: x=2" }),
    });
    assert.equal(noConfirm.status, 400);

    const committed = await fetch(`${base}/api/tasks/${task.id}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "feat: x=2", confirm: true }),
    });
    assert.equal(committed.status, 200);
    const commitBody = (await committed.json()) as {
      ok: boolean;
      commit: string;
      task: { git?: { commit?: string } };
    };
    assert.match(commitBody.commit, /^[0-9a-f]{7,40}$/);
    assert.equal(commitBody.task.git?.commit, commitBody.commit);

    // 提交后回到 base 分支，任务分支保留。
    assert.equal(git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    assert.equal(git(repoDir, ["rev-parse", "--abbrev-ref", task.git?.branch ?? ""]), task.git?.branch);
    assert.match(git(repoDir, ["log", "-1", "--pretty=%s", task.git?.branch ?? ""]), /x=2/);
  });

  test("回滚：stash 收走改动、切回 base、删除任务分支", async () => {
    const task = await createTask("再改一版");
    const sandbox = manager.sandboxFor(writableId);
    await sandbox.execute("write_file", { path: "app.js", content: "export const x = 3;\n" });

    const noConfirm = await fetch(`${base}/api/tasks/${task.id}/rollback`, { method: "POST" });
    assert.equal(noConfirm.status, 400);

    const rolled = await fetch(`${base}/api/tasks/${task.id}/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(rolled.status, 200);
    const rolledBody = (await rolled.json()) as {
      ok: boolean;
      stash?: string;
      task: { git?: { stashedAt?: number; branch?: string } };
    };
    assert.equal(rolledBody.ok, true);
    assert.ok(rolledBody.task.git?.stashedAt);
    assert.equal(git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    assert.equal(readFileSync(join(repoDir, "app.js"), "utf8"), "export const x = 1;\n");
    assert.match(git(repoDir, ["stash", "list"]), /catcafe-rollback-/);
    // 空任务分支已删除。
    const branches = git(repoDir, ["branch", "--list", "catcafe/*"]);
    assert.ok(!branches.includes(task.git?.branch ?? "catcafe/none"));
  });

  test("已提交的任务拒绝回滚", async () => {
    const task = await createTask("提交后再回滚");
    await manager.sandboxFor(writableId).execute("write_file", {
      path: "app.js",
      content: "export const x = 4;\n",
    });
    const committed = await fetch(`${base}/api/tasks/${task.id}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "feat: x=4", confirm: true }),
    });
    assert.equal(committed.status, 200);
    const rollback = await fetch(`${base}/api/tasks/${task.id}/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(rollback.status, 400);
    const body = (await rollback.json()) as { error: string };
    assert.match(body.error, /已提交/);
  });

  test("工作树不干净时建任务：不建分支，只记录提示", async () => {
    writeFileSync(join(repoDir, "app.js"), "export const x = 99;\n", "utf8");
    try {
      const task = await createTask("脏工作树上开任务");
      assert.equal(task.git?.branch, undefined);
      assert.match(task.git?.error ?? "", /未提交改动/);
    } finally {
      git(repoDir, ["checkout", "--", "app.js"]);
    }
  });

  test("上一个任务分支未收尾时，拒绝开新任务分支", async () => {
    const first = await createTask("第一个任务");
    assert.ok(first.git?.branch);
    const second = await createTask("第二个任务");
    assert.equal(second.git?.branch, undefined);
    assert.match(second.git?.error ?? "", /请先提交或回滚/);
  });

  test("branchPerTask=false：不建分支，commit 被拒绝", async () => {
    const noBranchRoom = studio.createRoom({ name: "无分支房间", workspaceId: noBranchId }).id;
    const res = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: noBranchRoom, brief: "不开分支的任务" }),
    });
    assert.equal(res.status, 201);
    const task = (await res.json()) as { id: string; git?: unknown };
    assert.equal(task.git, undefined);

    const commit = await fetch(`${base}/api/tasks/${task.id}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "nope", confirm: true }),
    });
    assert.equal(commit.status, 400);
    const body = (await commit.json()) as { error: string };
    assert.match(body.error, /没有独立分支/);
  });

  test("只读 / 非 git 工作区拒绝 commit 与 rollback", async () => {
    const readOnlyRoom = studio.createRoom({ name: "只读房间", workspaceId: readOnlyId }).id;
    const readOnlyTask = (await (
      await fetch(`${base}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: readOnlyRoom, brief: "只读房间任务" }),
      })
    ).json()) as { id: string; git?: unknown };
    assert.equal(readOnlyTask.git, undefined);

    const commit = await fetch(`${base}/api/tasks/${readOnlyTask.id}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "nope", confirm: true }),
    });
    assert.equal(commit.status, 400);
    const rollback = await fetch(`${base}/api/tasks/${readOnlyTask.id}/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(rollback.status, 400);

    const plainRoom = studio.createRoom({ name: "普通目录", workspaceId: plainId }).id;
    const plainTask = (await (
      await fetch(`${base}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: plainRoom, brief: "普通目录任务" }),
      })
    ).json()) as { id: string };
    const plainCommit = await fetch(`${base}/api/tasks/${plainTask.id}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "nope", confirm: true }),
    });
    assert.equal(plainCommit.status, 400);
  });
});
