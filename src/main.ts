/** 入口：组装 Studio / Brain / Driver / HTTP，启动猫咖。 */

import { resolve } from "node:path";

import { CATS, SCENARIOS } from "./agents/personas.ts";
import { createMockBrain } from "./agents/mock-brain.ts";
import { createLlmBrain } from "./agents/llm-brain.ts";
import { createDriver } from "./engine/driver.ts";
import { createHttpServer } from "./server/http.ts";
import { readSettings } from "./server/settings.ts";
import { Studio } from "./server/studio.ts";

const settings = readSettings();
const dataDir = resolve(settings.dataDir);

const studio = new Studio({ cats: CATS, mode: settings.mode, dataDir });
const mock = createMockBrain(SCENARIOS);
const brain =
  settings.mode === "llm" && settings.llm ? createLlmBrain(settings.llm, mock) : mock;
const driver = createDriver({ studio, brain, stallMs: settings.stallMs });

const server = createHttpServer({
  studio,
  driver,
  publicDir: resolve(import.meta.dirname, "../public"),
  scenarios: SCENARIOS,
  mode: settings.mode,
  stallMs: settings.stallMs,
});

server.listen(settings.port, "127.0.0.1", () => {
  const modeText = settings.mode === "llm" ? "真实模式（LLM）" : "演出模式（无需 key）";
  console.log("");
  console.log("  🐾 Cat Café Lab · 猫咖工作台");
  console.log(`  ${CATS.map((c) => `${c.name}(${c.species})`).join("  ")}`);
  console.log(`  http://127.0.0.1:${settings.port}`);
  console.log(`  mode: ${modeText} · data: ${dataDir}`);
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
