/**
 * 任务分支合并（收尾）：`POST /api/tasks/:id/merge`
 *
 * 完成「提需求 → 改代码 → 跑测试 → 出 diff → 人工 approve → commit → merge」的最后一步。
 * 关键约束：不自动 push、不删任务分支、冲突时把现场撤干净。
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import type { Task } from "../src/domain/types.ts";
import { createHttpServer } from "../src/server/http.ts";
import { Studio } from "../src/server/studio.ts";
import { WorkspaceManager } from "../src/workspaces/manager.ts";
import { fakeDriver } from "./helpers/fake-driver.ts";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "deliverylab-merge-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "cat@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Member Café"], { cwd: dir });
  writeFileSync(join(dir, "app.js"), "export const x = 1;\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function resetRepo(dir: string): void {
  execFileSync("git", ["checkout", "-q", "-f", "main"], { cwd: dir });
  execFileSync("git", ["reset", "--hard", "-q"], { cwd: dir });
  // reset --hard 不清未跟踪文件，上一条用例留下的 dirty.txt 会让下一条建分支失败。
  execFileSync("git", ["clean", "-fdq"], { cwd: dir });
  const branches = execFileSync("git", ["branch", "--list", "deliverylab/*"], {
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

describe("任务分支合并", () => {
  let dataDir: string;
  let repoDir: string;
  let manager: WorkspaceManager;
  let studio: Studio;
  let server: ReturnType<typeof createHttpServer>;
  let base: string;
  let roomId: string;
  let workspaceId: string;

  async function createTask(brief: string): Promise<Task> {
    const res = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId, brief }),
    });
    assert.equal(res.status, 201);
    return (await res.json()) as Task;
  }

  async function writeFile(task: Task, path: string, content: string): Promise<void> {
    const sandbox = manager.sandboxFor(workspaceId);
    const result = await sandbox.execute("write_file", { path, content });
    assert.equal(result.status, "ok", `写文件失败：${result.output}`);
  }

  async function commitTask(taskId: string, message = "feat: 改点东西"): Promise<Response> {
    return fetch(`${base}/api/tasks/${taskId}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true, message }),
    });
  }

  async function mergeTask(taskId: string, body: Record<string, unknown> = { confirm: true }): Promise<Response> {
    return fetch(`${base}/api/tasks/${taskId}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "deliverylab-merge-data-"));
    repoDir = makeRepo();
    manager = new WorkspaceManager(dataDir);
    workspaceId = manager.add({
      name: "Merge Repo",
      path: repoDir,
      policy: "read-write",
    }).id;
    studio = new Studio({ cats: CATS, mode: "mock" });
    roomId = studio.createRoom({ name: "Merge Room", workspaceId }).id;
    server = createHttpServer({
      studio,
      driver: fakeDriver(),
      publicDir: resolve(import.meta.dirname, "../public"),
      scenarios: SCENARIOS,
      workspaces: manager,
      mode: "mock",
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("no port");
    base = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    resetRepo(repoDir);
  });

  after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    manager.close();
    studio.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("提交后合并回 base：内容到位、留合并提交、任务分支保留", async () => {
    const task = await createTask("修改 app.js 导出值");
    assert.ok(task.git?.branch, "应创建任务分支");
    await writeFile(task, "app.js", "export const x = 42;\n");
    const committed = await commitTask(task.id);
    assert.equal(committed.status, 200, `提交应成功：${await committed.clone().text()}`);
    const commitBody = (await committed.json()) as { commit: string; task: Task };
    assert.ok(commitBody.commit, "应返回 commit hash");

    // 提交后已经回到 base 分支，且工作树干净 —— 满足合并前提。
    assert.equal(git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    assert.equal(git(repoDir, ["status", "--porcelain=v1"]), "");

    const merged = await mergeTask(task.id);
    const mergedBody = (await merged.json()) as { ok?: boolean; merged?: string; error?: string };
    assert.equal(merged.status, 200, `合并应成功：${mergedBody.error ?? ""}`);
    assert.ok(mergedBody.merged, "应返回合并提交 hash");

    // base 分支上能看到改动。
    assert.match(readFileSync(join(repoDir, "app.js"), "utf8"), /export const x = 42/);
    // --no-ff：合并提交有两个父提交。
    const parents = git(repoDir, ["rev-list", "--parents", "-n", "1", "HEAD"]).split(" ").length - 1;
    assert.equal(parents, 2, "应产生 --no-ff 合并提交");
    // 任务分支保留（不自动删，便于追溯）。
    assert.equal(
      git(repoDir, ["branch", "--list", task.git?.branch ?? ""]).includes("deliverylab/"),
      true,
    );
  });

  test("合并需要显式确认", async () => {
    const task = await createTask("改点东西");
    await writeFile(task, "app.js", "export const x = 7;\n");
    assert.equal((await commitTask(task.id)).status, 200);

    const res = await mergeTask(task.id, { confirm: false });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /确认/);
  });

  test("没提交时拒绝合并", async () => {
    const task = await createTask("只改不提交");
    await writeFile(task, "app.js", "export const x = 9;\n");

    const res = await mergeTask(task.id);
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /还没有提交/);
  });

  test("工作区有未提交改动时拒绝合并", async () => {
    const task = await createTask("提交后再留脏改动");
    await writeFile(task, "app.js", "export const x = 11;\n");
    assert.equal((await commitTask(task.id)).status, 200);

    // 提交后回到 base，再往 base 上留一个未提交改动。
    writeFileSync(join(repoDir, "dirty.txt"), "dirty\n", "utf8");

    const res = await mergeTask(task.id);
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /未提交改动/);
  });

  test("冲突时中止合并、不留半成品现场，并列出冲突文件", async () => {
    const task = await createTask("任务分支改 app.js");
    await writeFile(task, "app.js", "export const x = 100;\n");
    assert.equal((await commitTask(task.id)).status, 200);

    // base 上改同一行，制造冲突。
    writeFileSync(join(repoDir, "app.js"), "export const x = 999;\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "base 也改了同一行"], { cwd: repoDir });

    const res = await mergeTask(task.id);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; conflicts?: string[] };
    assert.match(body.error, /冲突/);
    assert.deepEqual(body.conflicts, ["app.js"], "应列出冲突文件");

    // 现场要干净：没有 MERGE_HEAD，工作树无冲突标记。
    assert.equal(git(repoDir, ["status", "--porcelain=v1"]), "");
    const mergeHead = spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    assert.notEqual(mergeHead.status, 0, "不应残留 MERGE_HEAD（合并应已中止）");
    assert.equal(git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]), "main", "应回到 base 分支");
  });

  test("重复合并提示已在 base 里，不产生多余提交", async () => {
    const task = await createTask("合并两次");
    await writeFile(task, "app.js", "export const x = 5;\n");
    assert.equal((await commitTask(task.id)).status, 200);
    assert.equal((await mergeTask(task.id)).status, 200);
    const headAfterFirst = git(repoDir, ["rev-parse", "HEAD"]);

    const second = await mergeTask(task.id);
    assert.equal(second.status, 200);
    const body = (await second.json()) as { note?: string };
    assert.match(body.note ?? "", /无需重复合并/);
    assert.equal(git(repoDir, ["rev-parse", "HEAD"]), headAfterFirst, "不应产生新提交");
  });

  test("只读工作区不能合并", async () => {
    const readonlyRepo = makeRepo();
    const readonlyId = manager.add({
      name: "Readonly Merge",
      path: readonlyRepo,
      policy: "read-only",
    }).id;
    const readonlyRoom = studio.createRoom({ name: "Readonly Room", workspaceId: readonlyId }).id;
    try {
      const created = await fetch(`${base}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: readonlyRoom, brief: "只读仓库的任务" }),
      });
      assert.equal(created.status, 201);
      const task = (await created.json()) as Task;
      assert.ok(!task.git?.branch, "只读工作区不建任务分支");

      const res = await mergeTask(task.id);
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { error: string }).error, /没有独立分支|只读/);
    } finally {
      rmSync(readonlyRepo, { recursive: true, force: true });
    }
  });
});
