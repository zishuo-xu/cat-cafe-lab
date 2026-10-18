/** 入口：组装 Studio / Brain / Driver / 设置 / HTTP，启动猫咖。 */

import { resolve } from "node:path";

import { CATS, SCENARIOS } from "./agents/personas.ts";
import { createMockBrain } from "./agents/mock-brain.ts";
import { createDriver } from "./engine/driver.ts";
import { createHttpServer } from "./server/http.ts";
import { readSettings } from "./server/settings.ts";
import { SettingsStore, SwitchableBrain } from "./server/settings-store.ts";
import { Studio } from "./server/studio.ts";

const settings = readSettings();
const dataDir = resolve(settings.dataDir);

const studio = new Studio({ cats: CATS, mode: settings.mode, dataDir });
const mock = createMockBrain(SCENARIOS);
const switchable = new SwitchableBrain(mock);

// 设置面板可以在运行中切换 brain；driver 只持有 switchable 这层壳。
const settingsStore = new SettingsStore({
  studio,
  mock,
  switchable,
  settings,
  dataDirAbs: dataDir,
  port: settings.port,
});

// 回复节奏只缩放延迟，不影响协作逻辑。
const wait = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, Math.max(0, Math.round(ms * settingsStore.factor()))));

const driver = createDriver({ studio, brain: switchable, wait, stallMs: settings.stallMs });

const server = createHttpServer({
  studio,
  driver,
  publicDir: resolve(import.meta.dirname, "../public"),
  scenarios: SCENARIOS,
  mode: settings.mode,
  stallMs: settings.stallMs,
  settingsApi: settingsStore,
});

server.listen(settings.port, "127.0.0.1", () => {
  const publicSettings = settingsStore.getPublic();
  const modeText =
    publicSettings.mode === "llm"
      ? `真实模式（${publicSettings.llm.model}）`
      : "演出模式（无需 key）";
  console.log("");
  console.log("  🐾 Cat Café Lab · 猫咖工作台");
  console.log(`  ${CATS.map((c) => `${c.name}(${c.species})`).join("  ")}`);
  console.log(`  http://127.0.0.1:${settings.port}`);
  console.log(`  mode: ${modeText} · data: ${dataDir}`);
  if (publicSettings.llm.hasKey) {
    console.log(`  llm: ${publicSettings.llm.baseUrl} (key: ${publicSettings.llm.keySource})`);
  }
  console.log("");
});

function shutdown(): void {
  console.log("\n  猫猫下班了，喵。");
  server.close();
  studio.close();
  setTimeout(() => process.exit(0), 100).unref?.();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
