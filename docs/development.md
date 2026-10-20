# 开发指南

> 面向要在这个仓库里加东西的人：怎么跑、东西放哪、加一个工具/剧本/接口/测试的固定套路、
> 以及这个项目里踩过的坑。所有命令都在 Node **v26.8.2** 上实际跑过。

---

## 1. 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **≥ 24**（`package.json` engines），实测 **v26.8.2** | 直接 `node src/main.ts` 运行 TypeScript |
| 包管理 | npm / pnpm 均可 | **零运行时依赖**，`pnpm install` 只装类型检查用的 devDependencies |
| TypeScript | devDependency（5.9+） | 只用于 `tsc --noEmit` 类型检查，不参与运行 |
| git | 可选 | 任务级 git 工作区的测试需要；不跑那组测试可以不装 |
| Python 3 | 可选 | 根目录 `tools/*.py` 是真实模型压测脚本，日常开发不需要 |

### 为什么不需要 build

Node 24+ 默认支持 **type stripping**：`node foo.ts` 会擦掉类型注解后直接执行。
所以：

- 没有 bundler、没有 `dist/`，改完源码直接 `node src/main.ts`；
- `tsc` 只检查类型（`noEmit: true`），不产出文件；
- 所有跨文件 import **必须带 `.ts` 后缀**（`module: NodeNext` + `allowImportingTsExtensions`）。

`tsconfig.json` 开了 `erasableSyntaxOnly`，因此**不能用** `enum`、`namespace`、
构造函数参数属性——这些语法无法被擦除。

---

## 2. 快速开始（已在 v26.8.2 验证）

```bash
# 0) 版本
node --version            # v26.8.2

# 1) 装开发依赖（可选，只影响类型检查）
pnpm install              # 或 npm install

# 2) 启动（默认 http://127.0.0.1:4318）
node src/main.ts
```

启动日志类似：

```
  🐾 Delivery Lab · 协作交付台
  林知远(布偶成员)  沈砚(缅因成员)  周烁(暹罗成员)  陈实(英短陈实)
  http://127.0.0.1:4318
  mode: 演出模式（无需 key） · data: /path/to/cat-cafe-lab/data
  sandbox: /path/to/cat-cafe-lab/data/workspace · tools: on · mcp tools: 0
  workspaces: 1（真实仓库默认只读，写入需显式授权）
```

### 常用命令

| 命令 | 作用 | 实测结果 |
|---|---|---|
| `node src/main.ts` | 启动服务 | 正常监听 4318 |
| `npm start` / `make dev` | 同上（脚本别名） | 见 `package.json` / `Makefile` |
| `node --watch src/main.ts` | 改代码自动重启 | 平时开发用 |
| `node --test tests/` | 全量测试 | **293 tests / 293 pass / ~32s** |
| `node --test tests/engine.test.ts` | 只跑引擎测试 | 只加载该文件 |
| `node --test --test-name-pattern="最后一个房间" tests/rooms.test.ts` | 按用例名过滤 | 只跑匹配用例 |
| `npx tsc --noEmit` | 类型检查 | 无输出即通过 |
| `npm run check` / `make check` | 同上（脚本别名） | 通过 |
| `npm test` / `make test` | 全量测试（脚本别名） | 293 pass |

> 测试数量会随迭代增长；上面的数字是写本文档时的值。

### 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | `4318` | HTTP 端口 |
| `DELIVERYLAB_DATA_DIR` | `data` | 状态/配置/沙盒根目录 |
| `DELIVERYLAB_STALL_MS` | `12000` | 判定「卡住」的毫秒数（真实模型建议调大） |
| `DELIVERYLAB_TOOLS` | 开启 | 设为 `0` 关闭工具执行 |
| `DELIVERYLAB_APPROVAL` | `commands` | 审批策略：`auto / commands / all` |
| `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` | 空 | 配置后进入真实模型模式（见 `docs/llm.md`） |
| `LLM_TEMPERATURE` | `0.8` | 全局温度 |
| `LLM_HEADERS` | 空 | JSON 字符串形式的额外请求头（键值都不进日志/前端） |

### 30 秒冒烟

```bash
curl -s http://127.0.0.1:4318/api/health
# {"ok":true,"mode":"mock","seq":1,"stallMs":12000,"settings":true}

curl -s http://127.0.0.1:4318/api/state | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);console.log(`rooms=${s.rooms.length} cats=${s.cats.length} seq=${s.seq}`)})'
# rooms=1 cats=4 seq=1

# SSE：连接先推一次全量快照，之后每次状态变更多一条
curl -sN --max-time 2 http://127.0.0.1:4318/api/events

# 建一个任务
curl -s -X POST http://127.0.0.1:4318/api/tasks \
  -H 'content-type: application/json' \
  -d '{"roomId":"room_cafe","brief":"给登录页加一个「记住我」勾选框，7 天内免登录。"}'
```

调试时建议把数据目录指到临时目录，避免污染仓库里的 `data/`：

```bash
TMPD=$(mktemp -d)
PORT=4599 DELIVERYLAB_DATA_DIR="$TMPD" node src/main.ts
# Ctrl-C 后 rm -rf "$TMPD"
```

---

## 3. 目录结构

```
cat-cafe-lab/
├── src/
│   ├── main.ts              组装 Studio / Brain / Driver / HTTP / 设置，并启动
│   ├── domain/              唯一契约与稳定 id
│   │   ├── types.ts         所有共享类型（冻结；要改先找 Lead）
│   │   ├── ids.ts           前缀 + 时间 + 自增 + 随机后缀
│   │   └── constants.ts     默认工作区 id 等常量
│   ├── server/
│   │   ├── studio.ts        唯一状态容器 + 所有 mutator + 持久化（debounce 200ms）
│   │   ├── http.ts          REST + SSE + 静态资源；所有路由都在 handle() 里
│   │   ├── settings.ts      环境变量解析
│   │   ├── settings-store.ts 运行时设置 + SwitchableBrain（切模式不重启）
│   │   ├── model-profiles.ts 模型分工档案
│   │   └── test-runner.ts   页面内测试中心（spawn node --test / python 脚本）
│   ├── engine/              协作引擎（见 docs/engine.md）
│   │   ├── driver.ts        队列 / 唤醒 / ReAct / 审批 / stall / 巡查
│   │   ├── stages.ts        纯函数状态机（handoffMove / reviewMove / …）
│   │   └── mentions.ts      @ 解析与用户消息路由
│   ├── agents/              成员的大脑
│   │   ├── personas.ts      四成员人格（CATS）+ 默认场景导出
│   │   ├── scenarios.ts     内置剧本 beats
│   │   ├── scenario-registry.ts 内置 + 自定义剧本库（数组引用稳定）
│   │   ├── scenario-validation.ts 自定义剧本导入校验
│   │   ├── mock-brain.ts    确定性演出（按 stage + cat 播 beats）
│   │   ├── llm-brain.ts     OpenAI 兼容 API，失败降级 mock
│   │   └── cli-brain.ts     `claude -p` 子进程大脑
│   ├── tools/
│   │   ├── sandbox.ts       沙盒运行时（路径锁根 / 命令白名单 / 超时）
│   │   ├── builtin.ts       内置工具目录（ToolDefinition）+ 注册表适配
│   │   ├── registry.ts      工具注册表（内置 provider + MCP provider）
│   │   ├── approval.ts      审批队列（remember + 5 分钟超时）
│   │   └── seed.ts          沙盒初始项目
│   ├── workspaces/manager.ts 工作区 / 只读策略 / 只读 git 查询
│   ├── mcp/                 MCP JSON-RPC 客户端 + server 管理器
│   └── skills/registry.ts   技能包（按角色/成员注入 prompt）
├── public/                  原生 ESM + CSS 前端（无构建）
├── tests/                   node:test 套件；fixtures/ 放假的 MCP server，helpers/ 放共享测试工具
├── docs/                    架构 / 引擎 / 前端 / 部署 / MCP / LLM 等文档与截图
├── tools/                   真实模型压测脚本（matrix.py / probe.py）
├── examples/mcp/            示例 MCP server
└── data/                    运行时数据（gitignore）
```

依赖方向是单向的：`agents ← engine ← server ← main`，`domain/types.ts` 是唯一共享契约。

### data/ 里有什么

| 文件/目录 | 内容 | 是否敏感 |
|---|---|---|
| `studio.json` | 房间 / 成员 / 消息 / 任务 / 交接 / 产物 / 记忆 / 会话 / 工具调用 / LLM 调用 | 否 |
| `settings.json` | 非敏感设置（模式 / 节奏 / baseUrl / model / 温度） | 否 |
| `scenarios.json` | 导入的自定义剧本 | 否 |
| `mcp.json` | MCP server 配置（env/headers 的值也在里面，文件权限 0600） | **是** |
| `workspaces.json` | 自定义工作区 | 否 |
| `workspace/` | 沙盒初始项目（成员真实改文件的地方） | 否 |

`data/` 整个目录被 `.gitignore` 忽略；不要提交运行时数据。

---

## 4. 工程约定

- **`src/domain/types.ts` 是冻结契约**：改它要先找 Lead。其他文件只读它。
- **所有状态变更走 Studio mutator**：HTTP 层只校验 + 转发；driver 只调方法，不直接改字段。
- **零运行时依赖**：不要为了一个小工具引入 npm 包；Node 内置能力优先。
- **中文 UI / 英文标识符**；id 统一用 `src/domain/ids.ts`。
- **所有 import 带 `.ts` 后缀**；类型导入用 `import type`（`verbatimModuleSyntax`）。
- **不能用 `enum` / `namespace` / 参数属性**（`erasableSyntaxOnly`）。
- `strict` + `noUncheckedIndexedAccess`：数组下标类型是 `T | undefined`，
  用 `!`（确认存在）或显式 guard。

---

## 5. 常见开发任务

### 5.1 新增一个工具

1. **登记定义**：在 `src/tools/builtin.ts` 的 `BUILTIN_TOOLS` 里加一项：

   ```ts
   {
     name: "read_file",           // 工具名；内置工具建议同时在 types.ts 的 BuiltinToolName 登记（契约文件，先问 Lead）
     title: "读取文件",            // 前端显示
     description: "……",           // 会给模型看；写清限制（长度/路径/命令）
     inputSchema: { type: "object", properties: { … }, required: [ … ] },
     risk: "safe",                // safe 或 needs_approval（needs_approval 会进审批）
     source: "sandbox",           // sandbox 或 mcp
   }
   ```

2. **实现执行**：在 `src/tools/sandbox.ts` 的 `execute()` switch 里加分支。
   必须继续遵守安全边界：路径 `resolve` 到根目录内、限制输出长度、命令走白名单、
   不经过 shell。

3. **权限**：工具是否对某个成员开放由 `Cat.tools` 白名单决定（`src/agents/personas.ts`）。
   新增工具后确认目标成员的白名单里有它，否则会被 driver 记成「没有权限」。

4. **测试**：在 `tests/tools.test.ts` 用临时目录构造 `Sandbox`，断言
   `status / exitCode / output`；如果工具有风险等级，顺手在 `tests/engine.test.ts`
   补一条审批路径。若需要种子文件，改 `src/tools/seed.ts`。

5. **MCP 工具不需要写代码**：用户在设置面板添加 MCP server 后，工具会动态注册进
   `ToolRegistryImpl`，名字是 `<serverId>__<toolName>`；后端与前端都从 `/api/tools` 读。

### 5.2 新增一个场景剧本

1. 在 `src/agents/scenarios.ts` 的 `SCENARIOS` 数组里加一个 `Scenario`：

   ```ts
   {
     id: "export_csv",
     name: "后台 · 导出 CSV",
     sampleBrief: "后台导出 CSV 加权限校验。",
     tags: ["后台", "导出", "csv", "权限"],
     beats: [
       { stage: "intake",   cat: "xianxian",    turn: { kind: "message", text: "……{{brief}}……" } },
       { stage: "planning", cat: "xianxian",    turn: { kind: "handoff", to: "jinjianceng", card: { … } } },
       { stage: "working",  cat: "jinjianceng", turn: { kind: "artifact", artifact: { kind: "patch", title: "…", body: "…" } } },
       // …review / revising / decision
     ],
   }
   ```

2. **driver 的调用契约**（mock 剧本最容易踩这里）：

   - `intake`：架构师只回消息、不带 handoff；driver 会自动进 planning；
   - `planning`：一次返回「消息 + 两张 handoff」；
   - `working`：目标成员返回 artifact；陈实的实现稿通常再带一张给 reviewer 的 handoff；
   - `reviewing`：**一次只能返回一个 verdict**。同一阶段会被调用两次（v1 打回 / v2 通过），
     mock-brain 按 `ctx.artifacts` 里的 patch 版本区分；
   - `revising`：v2 patch + 重新交接；
   - `done`：架构师返回 `decision`（含 `memory[]`）；
   - 漏 @ 埋点：把 `fault: "missed_mention"` 放在 **handoff turn** 上（`ScenarioBeat.fault`
     会被 mock-brain 透传到 turn，driver 只认 `turn.fault`）。

3. 模板占位符（mock-brain 支持）：`{{brief}}`、`{{title}}`、`{{quote}}`、`{{memory}}`、
   `{{memoryDetail}}`、`{{catName}}`。

4. **测试**：`tests/agents.test.ts` 里已有「按 (scenario, stage, cat) 取 turn」「五栏卡完整」
   等契约测试，新场景加進 `SCENARIOS` 后照抄参数即可；`tests/cats-scenarios.test.ts`
   覆盖自定义剧本导入/删除。

5. **自定义剧本（不写代码）**：通过 `POST /api/scenarios` 导入 JSON，会先走
   `src/agents/scenario-validation.ts` 的逐条校验（id 规则、beats ≤120、五栏卡、
   verdict 白名单、cat id、工具/命令白名单等），坏剧本直接 400。

### 5.3 新增一个 API 端点

所有路由都在 `src/server/http.ts` 的 `handle(req, res)` 里，按 `method + pathname` 分支。
用三个现成 helper：

```ts
json(res, 200, payload);          // 成功响应（自动 JSON + Content-Length）
fail(res, 400, "原因");           // 错误统一 { error: string }
const body = await readBody(req); // 读 JSON body（上限 64KB）
```

固定套路（以 `PATCH /api/rooms/:id` 为例）：

```ts
const match = /^\/api\/rooms\/([^/]+)$/.exec(pathname);
if (match && method === "PATCH") {
  const roomId = decodeURIComponent(match[1] ?? "");
  if (!studio.getRoom(roomId)) return fail(res, 404, "房间不存在");

  const raw = await readBody(req);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail(res, 400, "请求体必须是对象");
  }
  // …逐字段校验，非法直接 fail(res, 400, "...")…

  try {
    json(res, 200, studio.updateRoom(roomId, patch)); // 写操作只调 Studio mutator
  } catch (err) {
    fail(res, 400, err instanceof Error ? err.message : "invalid patch");
  }
  return;
}
```

约定：

- 可选依赖（settings / workspaces / mcp / sandbox…）没接时返回 **503**，不要让服务崩；
- 校验失败 4xx、找不到 404、创建 201、已接受 202（如 nudge）；
- 路由顺序有意义：具体路径放在兜底 `GET` 静态资源之前；
- 前端用 SSE 全量快照，不需要为读接口再做增量。

**测试**：参考 `tests/rooms.test.ts` 的装配方式——`new Studio(...)` + `fakeDriver()` +
`createHttpServer({ studio, driver, publicDir, scenarios, workspaces })`，`listen(0)` 拿随机端口，
`t.after` 里 `server.closeAllConnections()` + `close` + 清理临时目录。

### 5.4 新增一个测试套件

约定：

- 文件名 `tests/<主题>.test.ts`；用 `node:test` + `node:assert/strict`；
- 每个套件自己起 `Studio`（**不传 dataDir**，纯内存）和假依赖；
- 需要 HTTP 就 `listen(0)`；需要持久化就 `mkdtemp` 并用 `t.after`/`after` 清理；
- 不依赖真实网络 / 真实模型 / 真实时间；driver 的 `wait` 注入成 `async () => {}`；
- 异步清理写 `t.after(async () => …)`。

最小模板：

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { CATS } from "../src/agents/personas.ts";
import type { Driver } from "../src/domain/types.ts";
import { createDriver } from "../src/engine/driver.ts";
import { Studio } from "../src/server/studio.ts";

function fakeDriver(): Driver {
  return { submit() {}, async whenIdle() {}, stallMs: 12_000 };
}

test("……", async (t) => {
  const studio = new Studio({ cats: CATS, mode: "mock" });
  t.after(() => studio.close());
  const driver = createDriver({
    studio,
    brain: { mode: "mock", async think() { return []; } },
    wait: async () => {},
    stallMs: 60_000,
  });
  assert.equal(driver.stallMs, 60_000);
});
```

真实 `driver` 测试可以直接 `driver.submit(...)` + `await driver.whenIdle()`，不用 HTTP。
`tests/engine.test.ts` 里有大量可抄的写法（脚本化 brain、fake sandbox、fake approvals、
fake registry）。

---

## 6. 本地调试技巧

| 想干什么 | 做法 |
|---|---|
| 看服务日志 | 前台跑 `node src/main.ts`，日志直接打到 stdout |
| 看全量状态 | `curl -s /api/state`（类型见 `src/domain/types.ts`，概览见 `docs/architecture.md`） |
| 看实时更新 | `curl -sN /api/events`（SSE；连接先推一次全量，之后 `data: {seq,state}`） |
| 建任务并观察 | `POST /api/tasks` 后轮询 `/api/state` 里的 `task.stage/status` |
| 看某任务的完整时间线 | `GET /api/tasks/:id/trace`（消息/交接/产物/工具/LLM/记忆） |
| 看模型调用开销 | `GET /api/state` 里的 `llmCalls`（耗时 / token / 降级 / 重试） |
| 重置状态 | `POST /api/reset`（清空协作状态并重新种入房间与招呼） |
| 只跑某个用例 | `node --test --test-name-pattern="关键词" tests/xxx.test.ts` |
| 隔离数据 | `DELIVERYLAB_DATA_DIR=$(mktemp -d) PORT=4599 node src/main.ts` |
| 复现真实模型问题 | 见 `tools/README.md`（`matrix.py` / `probe.py`） |

小技巧：`curl` 结果用 Node 一行解析，避免依赖 `jq`：

```bash
curl -s http://127.0.0.1:4318/api/state | node -e \
  'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);console.log(s.tasks.map(t=>`${t.id} ${t.stage}/${t.status}`).join("\n"))})'
```

---

## 7. 常见陷阱

| 陷阱 | 现象 | 正确做法 |
|---|---|---|
| import 没带 `.ts` | `ERR_MODULE_NOT_FOUND` | 所有相对 import 写 `./x.ts` / `../x.ts` |
| `enum` / `namespace` / 参数属性 | 运行时报 type-stripping 错误 | 用 union type / 普通对象 / 显式字段 |
| 类型导入没用 `import type` | `tsc` 报错（`verbatimModuleSyntax`） | 纯类型导入统一 `import type { … }` |
| 数组下标直接当非空 | `tsc` 报 `T \| undefined` | 用 `arr[i]!` 或先 guard（`noUncheckedIndexedAccess`） |
| **`NODE_TEST_CONTEXT` 被继承** | 测试里 spawn `node --test` 会「递归调用」并跳过所有文件 | spawn 前 `delete env.NODE_TEST_CONTEXT`（`TestRunner` 已这么做，同样要删 `NODE_OPTIONS`） |
| Studio 持久化是 debounce 200ms | 测试里立刻读 `studio.json` 读不到 | 用 `studio.persistNow()` / `studio.close()` 后再读 |
| 测试里开 SSE 后不关连接 | `server.close()` 一直挂住 | 关连接：`AbortController.abort()`；关服务前 `server.closeAllConnections?.()` |
| 定时器没 `unref` | 测试结束后进程不退出 | stall / patrol 定时器已经 `unref`；自己加定时器也要记得 |
| 端口写死 | 本地已有服务时冲突 | 测试用 `listen(0)`；手动调试用 `PORT=4599` 等 |
| 在测试里依赖真实模型 / 网络 | CI 慢且不稳定 | 默认 mock；真实模型测试必须显式跳过或走环境变量 |
| 改 `types.ts` | 会打破所有模块契约 | 契约冻结；先发消息找 Lead |
| 引入运行时依赖 | 和「零依赖」目标冲突 | Node 内置能力优先；确实需要先讨论 |
| 提交 `data/` | 运行时状态进仓库 | `.gitignore` 已忽略；不要 `git add -f` |

---

## 8. 提交前检查清单

```bash
# 1) 自己的测试
node --test tests/engine.test.ts      # 或你改的模块对应的测试文件

# 2) 全量
node --test tests/

# 3) 类型
npx tsc --noEmit
```

- 新机制/新坑请顺手补测试与文档（`docs/engine.md` 的机制描述要能在 `driver.ts` 找到）；
- 改了 `docs/` 就核对链接与命令可执行；
- 不要提交 `data/`、`node_modules/`、`*.log`；
- 大改动前先看 `docs/architecture.md` 与 `docs/engine.md`，确认没有绕过既有约束。
