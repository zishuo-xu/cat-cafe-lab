/** 沙盒工具：路径安全、命令白名单、真实执行、workspace API。 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { CATS, SCENARIOS } from "../src/agents/personas.ts";
import type { Driver } from "../src/domain/types.ts";
import { createHttpServer } from "../src/server/http.ts";
import { Studio } from "../src/server/studio.ts";
import { Sandbox } from "../src/tools/sandbox.ts";
import { SEED_FILES } from "../src/tools/seed.ts";
import { fakeDriver } from "./helpers/fake-driver.ts";


function sandboxAt(dir: string): Sandbox {
  const sandbox = new Sandbox(join(dir, "workspace"));
  sandbox.ensureSeed();
  return sandbox;
}

describe("Sandbox", () => {
  let dir: string;
  let sandbox: Sandbox;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "deliverylab-sandbox-"));
    sandbox = sandboxAt(dir);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("种子项目落盘，重复 ensureSeed 不覆盖已有改动", async () => {
    for (const path of Object.keys(SEED_FILES)) {
      assert.ok(readFileSync(join(sandbox.root, path), "utf8").length > 0, path);
    }
    await sandbox.execute("write_file", { path: "src/remember.js", content: "// 猫改过的" });
    sandbox.ensureSeed();
    assert.equal(readFileSync(join(sandbox.root, "src/remember.js"), "utf8"), "// 猫改过的");
    sandbox.reset();
    assert.match(readFileSync(join(sandbox.root, "src/remember.js"), "utf8"), /TOKENS/);
  });

  test("read/write/list 正常，路径锁在沙盒内", async () => {
    const write = await sandbox.execute("write_file", {
      path: "notes/plan.md",
      content: "先修 token 过期",
    });
    assert.equal(write.status, "ok");

    const read = await sandbox.execute("read_file", { path: "notes/plan.md" });
    assert.equal(read.status, "ok");
    assert.match(read.output, /过期/);

    const list = await sandbox.execute("list_files", {});
    assert.match(list.output, /notes\/plan\.md/);

    const escape = await sandbox.execute("read_file", { path: "../package.json" });
    assert.equal(escape.status, "error");
    assert.match(escape.output, /\.\./);

    const absolute = await sandbox.execute("read_file", { path: "/etc/passwd" });
    assert.equal(absolute.status, "error");
    assert.match(absolute.output, /绝对路径/);
  });

  test("命令白名单与参数安全", async () => {
    const blocked = await sandbox.execute("run_command", { cmd: "sh", args: [] });
    assert.equal(blocked.status, "error");
    assert.match(blocked.output, /白名单/);

    const badArgs = await sandbox.execute("run_command", {
      cmd: "node",
      args: ["../escape.js"],
    });
    assert.equal(badArgs.status, "error");
    assert.match(badArgs.output, /不安全/);
  });

  test("真的执行 node --test：初始 remember 测试失败、export 测试通过", async () => {
    const remember = await sandbox.execute("run_command", {
      cmd: "node",
      args: ["--test", "test/remember.test.js"],
    });
    assert.equal(remember.status, "error");
    assert.equal(remember.exitCode, 1);
    assert.match(remember.output, /过期后校验失败|not ok/);

    const exportRun = await sandbox.execute("run_command", {
      cmd: "node",
      args: ["--test", "test/export.test.js"],
    });
    assert.equal(exportRun.status, "ok");
    assert.equal(exportRun.exitCode, 0);
    assert.match(exportRun.output, /pass/);
  });

  test("写对文件后测试通过（真实修复闭环）", async () => {
    sandbox.reset();
    const repaired = `const TOKENS = new Map();
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function signRememberToken(userId, now = Date.now()) {
  const token = \`rm_\${userId}_\${Math.random().toString(36).slice(2)}\`;
  TOKENS.set(token, { userId, expiresAt: now + TTL_MS });
  return token;
}

export function verifyRememberToken(token, now = Date.now()) {
  const record = TOKENS.get(token);
  if (!record) return null;
  if (record.expiresAt <= now) {
    TOKENS.delete(token);
    return null;
  }
  return record;
}
`;
    await sandbox.execute("write_file", { path: "src/remember.js", content: repaired });
    const run = await sandbox.execute("run_command", {
      cmd: "node",
      args: ["--test", "test/remember.test.js"],
    });
    assert.equal(run.status, "ok", run.output);
    assert.match(run.output, /pass/);
  });
});

describe("HTTP /api/workspace", () => {
  let dir: string;
  let sandbox: Sandbox;
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
    dir = mkdtempSync(join(tmpdir(), "deliverylab-workspace-http-"));
    sandbox = sandboxAt(dir);
    const studio = new Studio({ cats: CATS, mode: "mock" });
    server = createHttpServer({
      studio,
      driver: fakeDriver(),
      publicDir: resolve(import.meta.dirname, "../public"),
      scenarios: SCENARIOS,
      sandbox,
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
    rmSync(dir, { recursive: true, force: true });
  });

  test("tree / file / reset", async () => {
    const tree = await fetch(`${base}/api/workspace/tree`);
    assert.equal(tree.status, 200);
    const treeBody = (await tree.json()) as { root: string; files: Array<{ path: string }> };
    assert.ok(treeBody.files.some((file) => file.path === "src/remember.js"));
    assert.ok(treeBody.root.includes("workspace"));

    const file = await fetch(`${base}/api/workspace/file?path=package.json`);
    assert.equal(file.status, 200);
    const fileBody = (await file.json()) as { content: string };
    assert.match(fileBody.content, /cafe-sandbox/);

    const traversal = await fetch(`${base}/api/workspace/file?path=../studio.json`);
    assert.equal(traversal.status, 400);

    const reset = await fetch(`${base}/api/workspace/reset`, { method: "POST" });
    assert.equal(reset.status, 200);
  });

  test("没有沙盒时返回 503", async () => {
    const res = await fetch(`${bareBase}/api/workspace/tree`);
    assert.equal(res.status, 503);
  });
});
