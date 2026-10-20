/** 入口：组装 Studio / Brain / Driver / 设置 / HTTP，启动交付台。 */

import { resolve } from "node:path";

import { CATS, SCENARIOS } from "./agents/personas.ts";
import { createMockBrain } from "./agents/mock-brain.ts";
import { initScenarios } from "./agents/scenario-registry.ts";
import { createDriver } from "./engine/driver.ts";
import { createHttpServer } from "./server/http.ts";
import { ApprovalQueue } from "./tools/approval.ts";
import { ToolRegistryImpl } from "./tools/registry.ts";
import { McpManager } from "./mcp/manager.ts";
import { readSettings } from "./server/settings.ts";
import { SettingsStore, SwitchableBrain } from "./server/settings-store.ts";
import { Studio } from "./server/studio.ts";
import { WorkspaceManager } from "./workspaces/manager.ts";
import { TestRunner } from "./server/test-runner.ts";
import { DEFAULT_WORKSPACE_ID } from "./domain/constants.ts";

const settings = readSettings();
const dataDir = resolve(settings.dataDir);
const projectRoot = resolve(import.meta.dirname, "..");

const studio = new Studio({ cats: CATS, mode: settings.mode, dataDir });

// 工作区：默认沙盒可读写；用户添加的真实仓库默认只读（C 阶段）。
const workspaces = new WorkspaceManager(dataDir);
const sandbox = workspaces.rawSandbox(DEFAULT_WORKSPACE_ID);
const approvals = new ApprovalQueue();
const registry = new ToolRegistryImpl(sandbox);
const mcp = new McpManager(registry, dataDir);
await mcp.init();
// 导入的自定义剧本会原地追加到 SCENARIOS，driver / HTTP 拿到的是同一数组引用。
initScenarios(dataDir, studio.state.cats.map((cat) => cat.id));
const mock = createMockBrain(SCENARIOS, {
  catName: (id) => studio.getCat(id)?.name ?? id,
});
const switchable = new SwitchableBrain(mock);

// 设置面板可以在运行中切换 brain；driver 只持有 switchable 这层壳。
const settingsStore = new SettingsStore({
  studio,
  mock,
  switchable,
  settings,
  dataDirAbs: dataDir,
  port: settings.port,
  cliCwd: sandbox.root,
});

// 回复节奏只缩放延迟，不影响协作逻辑。
const wait = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, Math.max(0, Math.round(ms * settingsStore.factor()))));

const driver = createDriver({
  studio,
  brain: switchable,
  wait,
  stallMs: settings.stallMs,
  sandbox,
  sandboxFor: (roomId) => workspaces.sandboxFor(studio.getRoom(roomId)?.workspaceId),
  tools: registry,
  toolsEnabled: () => settingsStore.toolsOn(),
  approvals,
  approvalMode: () => settingsStore.approvalMode(),
});

// 测试中心：在页面上跑单元测试 / 真实模型矩阵，输出实时推给前端。
const testRunner = new TestRunner({
  projectRoot,
  port: settings.port,
  realModelReady: () => settingsStore.getPublic().mode === "llm" && settingsStore.getPublic().llm.hasKey,
});

const server = createHttpServer({
  studio,
  driver,
  publicDir: resolve(import.meta.dirname, "../public"),
  scenarios: SCENARIOS,
  mode: settings.mode,
  stallMs: settings.stallMs,
  settingsApi: settingsStore,
  sandbox,
  approvals,
  tools: registry,
  mcp,
  workspaces,
  tests: testRunner,
});

// 主动协作：按设置启停巡查。
const proactiveConfig = settingsStore.proactiveMode();
driver.setProactive(proactiveConfig.mode === "watch", proactiveConfig.intervalMs);

server.listen(settings.port, "127.0.0.1", () => {
  const publicSettings = settingsStore.getPublic();
  const modeText =
    publicSettings.mode === "llm"
      ? `真实模式（${publicSettings.llm.model}）`
      : "演出模式（无需 key）";
  console.log("");
  console.log("  🐾 Delivery Lab · 协作交付台");
  console.log(`  ${CATS.map((c) => `${c.name}(${c.discipline})`).join("  ")}`);
  console.log(`  http://127.0.0.1:${settings.port}`);
  console.log(`  mode: ${modeText} · data: ${dataDir}`);
  const mcpTools = registry.list().filter((tool) => tool.source === "mcp").length;
  console.log(
    `  sandbox: ${sandbox.root} · tools: ${publicSettings.toolsEnabled ? "on" : "off"} · mcp tools: ${mcpTools}`,
  );
  console.log(
    `  workspaces: ${workspaces.list().length}（真实仓库默认只读，写入需显式授权）`,
  );
  if (publicSettings.llm.hasKey) {
    console.log(`  llm: ${publicSettings.llm.baseUrl} (key: ${publicSettings.llm.keySource})`);
  }
  console.log("");
});

function shutdown(): void {
  console.log("\n  本次协作结束。");
  server.close();
  void mcp.close();
  workspaces.close();
  testRunner.close();
  studio.close();
  setTimeout(() => process.exit(0), 100).unref?.();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
