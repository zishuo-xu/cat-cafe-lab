/** C 阶段：工作区模型、只读策略、git 只读查询、多房间绑定。 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import type { CatBrain, CatTurn, Driver, SandboxRunner } from "../src/domain/types.ts";
import { createDriver } from "../src/engine/driver.ts";
import { createHttpServer } from "../src/server/http.ts";
import { Studio } from "../src/server/studio.ts";
import { WorkspaceManager } from "../src/workspaces/manager.ts";
import { fakeDriver } from "./helpers/fake-driver.ts";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "catcafe-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "cat@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Cat Café"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# demo repo\n", "utf8");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/app.js"), "export const x = 1;\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}


describe("WorkspaceManager", () => {
  let dataDir: string;
  let repoDir: string;
  let manager: WorkspaceManager;

  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), "catcafe-ws-data-"));
    repoDir = makeRepo();
    manager = new WorkspaceManager(dataDir);
  });

  after(() => {
    manager.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("默认只有内置沙盒工作区", () => {
    const workspaces = manager.list();
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0]?.id, "ws_sandbox");
    assert.equal(workspaces[0]?.policy, "read-write");
    assert.equal(workspaces[0]?.kind, "sandbox");
  });

  test("添加真实仓库默认只读；重复目录被拒绝", () => {
    const workspace = manager.add({ name: "Demo Repo", path: repoDir });
    assert.equal(workspace.policy, "read-only");
    assert.equal(workspace.kind, "repo");
    assert.equal(workspace.isGit, true);
    assert.equal(workspace.root, realpathSync(repoDir));

    assert.throws(() => manager.add({ name: "Again", path: repoDir }), /已经是一个工作区/);
    assert.throws(() => manager.add({ name: "Bad", path: "relative/path" }), /绝对路径/);
  });

  test("只读工作区禁止写文件和跑命令", async () => {
    const workspace = manager.list().find((item) => item.kind === "repo");
    assert.ok(workspace);
    const sandbox = manager.sandboxFor(workspace.id);

    const read = await sandbox.execute("read_file", { path: "README.md" });
    assert.equal(read.status, "ok");
    assert.match(read.output, /demo repo/);

    const write = await sandbox.execute("write_file", { path: "hack.js", content: "x" });
    assert.equal(write.status, "error");
    assert.match(write.output, /只读/);

    const run = await sandbox.execute("run_command", { cmd: "node", args: ["--version"] });
    assert.equal(run.status, "error");
    assert.match(run.output, /只读/);
  });

  test("读写工作区可以写文件", async () => {
    const repo2 = makeRepo();
    try {
      const workspace = manager.add({ name: "Writable", path: repo2, policy: "read-write" });
      const sandbox = manager.sandboxFor(workspace.id);
      const write = await sandbox.execute("write_file", { path: "notes.md", content: "hi" });
      assert.equal(write.status, "ok");
      assert.equal(readFileSync(join(repo2, "notes.md"), "utf8"), "hi");
    } finally {
      rmSync(repo2, { recursive: true, force: true });
    }
  });

  test("git 只读查询：分支 / 干净状态 / diff / 最近提交", async () => {
    const workspace = manager.list().find((item) => item.name === "Demo Repo");
    assert.ok(workspace);
    const clean = await manager.gitInfo(workspace.id);
    assert.equal(clean.isGit, true);
    assert.equal(clean.branch, "main");
    assert.equal(clean.clean, true);
    assert.match(clean.lastCommit ?? "", /init/);

    writeFileSync(join(repoDir, "src/app.js"), "export const x = 2;\n", "utf8");
    const dirty = await manager.gitInfo(workspace.id);
    assert.equal(dirty.clean, false);
    assert.match(dirty.status ?? "", /src\/app\.js/);

    const diff = await manager.gitDiff(workspace.id);
    assert.equal(diff.ok, true);
    assert.match(diff.diff, /export const x = 2/);
  });

  test("非 git 目录也能作为只读工作区，git 信息返回 isGit=false", async () => {
    const plain = mkdtempSync(join(tmpdir(), "catcafe-plain-"));
    try {
      writeFileSync(join(plain, "a.txt"), "a", "utf8");
      const workspace = manager.add({ name: "Plain", path: plain });
      const info = await manager.gitInfo(workspace.id);
      assert.equal(info.isGit, false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test("删除工作区：内置禁止、自定义可删", () => {
    assert.throws(() => manager.remove("ws_sandbox"), /不能删除/);
    const workspace = manager.list().find((item) => item.name === "Plain");
    assert.ok(workspace);
    assert.equal(manager.remove(workspace.id), true);
    assert.equal(manager.remove(workspace.id), false);
  });
});

describe("多房间与工作区绑定", () => {
  test("房间可以绑定工作区，reset 不会丢房间", () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    try {
      assert.equal(studio.state.rooms[0]?.workspaceId, "ws_sandbox");
      const room = studio.createRoom({ name: "真实仓库", workspaceId: "ws_repo_demo" });
      assert.equal(room.workspaceId, "ws_repo_demo");
      assert.throws(() => studio.createRoom({ name: "真实仓库", workspaceId: "x" }), /已存在/);

      studio.setRoomWorkspace("room_cafe", "ws_repo_demo");
      assert.equal(studio.state.rooms[0]?.workspaceId, "ws_repo_demo");

      studio.reset();
      assert.equal(studio.state.rooms.length, 2);
      assert.equal(studio.state.rooms[0]?.workspaceId, "ws_repo_demo");
      assert.equal(studio.state.messages.length, 5);
    } finally {
      studio.close();
    }
  });
});

describe("driver 按房间选沙盒", () => {
  test("sandboxFor 返回的执行器会被 tool turn 使用", async () => {
    const studio = new Studio({ cats: CATS, mode: "mock" });
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const roomSandbox: SandboxRunner = {
      async execute(tool, input) {
        calls.push({ tool, input });
        return { status: "ok", output: "room-sandbox-ok" };
      },
    };
    let round = 0;
    const brain: CatBrain = {
      mode: "mock",
      async think(): Promise<CatTurn[]> {
        round += 1;
        return round === 1
          ? [
              {
                kind: "tool",
                tool: "read_file",
                input: { path: "x.js" },
                label: "读文件",
              },
            ]
          : [{ kind: "message", text: "好了" }];
      },
    };
    const driver = createDriver({
      studio,
      brain,
      wait: async () => {},
      sandboxFor: (roomId) => (roomId === "room_cafe" ? roomSandbox : undefined),
    });
    try {
      const task = studio.createTask({
        roomId: "room_cafe",
        brief: "按房间沙盒写文件",
        scenarioId: "remember_me",
      });
      // 直接驱动首轮 wake：模拟 task_created。
      driver.submit({ type: "task_created", roomId: "room_cafe", taskId: task.id });
      await driver.whenIdle();
      assert.ok(calls.length >= 1);
      assert.equal(calls[0]?.tool, "read_file");
      assert.equal(studio.state.toolCalls[0]?.status, "ok");
    } finally {
      studio.close();
    }
  });
});

describe("HTTP workspaces / rooms", () => {
  let dataDir: string;
  let repoDir: string;
  let manager: WorkspaceManager;
  let studio: Studio;
  let server: ReturnType<typeof createHttpServer>;
  let bare: ReturnType<typeof createHttpServer>;
  let base: string;
  let bareBase: string;

  async function listen(target: ReturnType<typeof createHttpServer>): Promise<string> {
    await new Promise<void>((done) => target.listen(0, "127.0.0.1", () => done()));
    const address = target.address();
    if (!address || typeof address !== "object") throw new Error("no port");
    return `http://127.0.0.1:${address.port}`;
  }

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "catcafe-ws-http-"));
    repoDir = makeRepo();
    manager = new WorkspaceManager(dataDir);
    studio = new Studio({ cats: CATS, mode: "mock" });
    server = createHttpServer({
      studio,
      driver: fakeDriver(),
      publicDir: resolve(import.meta.dirname, "../public"),
      scenarios: SCENARIOS,
      workspaces: manager,
      mode: "mock",
    });
    bare = createHttpServer({
      studio,
      driver: fakeDriver(),
      publicDir: resolve(import.meta.dirname, "../public"),
      scenarios: SCENARIOS,
      mode: "mock",
    });
    base = await listen(server);
    bareBase = await listen(bare);
  });

  after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await new Promise<void>((done) => bare.close(() => done()));
    manager.close();
    studio.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("列表 / 添加（读写需 confirm）/ 文件 / git", async () => {
    const list = await fetch(`${base}/api/workspaces`);
    const listBody = (await list.json()) as { workspaces: Array<{ id: string }> };
    assert.equal(listBody.workspaces.length, 1);

    const noConfirm = await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Repo", path: repoDir, policy: "read-write" }),
    });
    assert.equal(noConfirm.status, 400);

    const readOnly = await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Repo", path: repoDir }),
    });
    assert.equal(readOnly.status, 201);
    const readOnlyBody = (await readOnly.json()) as { workspace: { id: string; policy: string } };
    assert.equal(readOnlyBody.workspace.policy, "read-only");
    const workspaceId = readOnlyBody.workspace.id;

    const files = await fetch(`${base}/api/workspaces/${workspaceId}/files`);
    const filesBody = (await files.json()) as { files: Array<{ path: string }> };
    assert.ok(filesBody.files.some((file) => file.path === "README.md"));

    const git = await fetch(`${base}/api/workspaces/${workspaceId}/git`);
    const gitBody = (await git.json()) as { isGit: boolean; branch: string };
    assert.equal(gitBody.isGit, true);
    assert.equal(gitBody.branch, "main");

    const diff = await fetch(`${base}/api/workspaces/${workspaceId}/git/diff`);
    assert.equal(diff.status, 200);

    const missing = await fetch(`${base}/api/workspaces/nope/git`);
    assert.equal(missing.status, 404);

    // 后面几个用例依赖这个工作区。
    (globalThis as unknown as { __workspaceId: string }).__workspaceId = workspaceId;
  });

  test("房间创建与绑定；绑定中的工作区不能删", async () => {
    const workspaceId = (globalThis as unknown as { __workspaceId: string }).__workspaceId;

    const room = await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "真实仓库房间", workspaceId }),
    });
    assert.equal(room.status, 201);
    const roomBody = (await room.json()) as { id: string; workspaceId: string };
    assert.equal(roomBody.workspaceId, workspaceId);

    const boundDelete = await fetch(`${base}/api/workspaces/${workspaceId}`, { method: "DELETE" });
    assert.equal(boundDelete.status, 400);

    const rebind = await fetch(`${base}/api/rooms/${roomBody.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws_sandbox" }),
    });
    assert.equal(rebind.status, 200);

    const unbind = await fetch(`${base}/api/rooms/room_cafe`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: workspaceId }),
    });
    assert.equal(unbind.status, 200);

    const stillBound = await fetch(`${base}/api/workspaces/${workspaceId}`, { method: "DELETE" });
    assert.equal(stillBound.status, 400);

    // 解绑后可以删。
    await fetch(`${base}/api/rooms/room_cafe`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws_sandbox" }),
    });
    const removed = await fetch(`${base}/api/workspaces/${workspaceId}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
  });

  test("内置工作区不能删；没有 manager 时 503", async () => {
    const builtin = await fetch(`${base}/api/workspaces/ws_sandbox`, { method: "DELETE" });
    assert.equal(builtin.status, 400);

    const bareRes = await fetch(`${bareBase}/api/workspaces`);
    assert.equal(bareRes.status, 503);
  });
});
