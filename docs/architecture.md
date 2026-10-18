# 架构

> 一句话：一个小到能一晚上读完的服务端 + 一个不依赖框架的前端。
> 复杂度全部花在"协作怎么发生"上，而不是基础设施上。

## 分层

```
┌──────────────────────────────────────────────┐
│  public/            原生 ESM + CSS，无构建    │
│  app.js  ──SSE──►   每条 {seq, state}         │
└───────────────▲──────────────────────────────┘
                │ fetch / EventSource
┌───────────────┴──────────────────────────────┐
│  src/server/http.ts    REST + SSE + 静态资源  │
├──────────────────────────────────────────────┤
│  src/server/studio.ts  唯一状态容器 + 写入口   │
│    · 所有 mutator 都走这里                     │
│    · seq 单调递增 → SSE 去重                   │
│    · debounce 200ms 落盘 data/studio.json      │
├──────────────────────────────────────────────┤
│  src/server/settings-store.ts  运行时设置      │
│    · 模式 / 节奏 / LLM 连接                    │
│    · apiKey 只在内存，从不落盘                 │
│    · 切换 brain 不需要重启                     │
├──────────────────────────────────────────────┤
│  src/agents/scenario-registry.ts  剧本库       │
│    · 内置只读 + 自定义导入，数组引用稳定        │
│    · 校验（cat id / 五栏卡 / verdict）         │
├──────────────────────────────────────────────┤
│  src/engine/driver.ts  协作会话驱动            │
│    · 每房间串行队列                            │
│    · 阶段推进 / @ 路由 / typing / 延迟         │
│    · tool turn → 沙盒执行 / 审批闸门           │
│    · 故障注入（漏 @）与 nudge 恢复             │
├──────────────────────────────────────────────┤
│  src/workspaces/manager.ts 工作区与只读策略   │
│    · 目录绑定 / 权限 / 只读 git 查询           │
│  src/tools/registry.ts 工具注册表              │
│    · 内置 provider + MCP provider              │
│  src/tools/sandbox.ts  沙盒工具运行时          │
│    · 路径锁根目录 / 命令白名单 / 10s 超时      │
│    · read_file / write_file / list / run       │
│  src/mcp/client.ts     MCP JSON-RPC 客户端     │
│    · stdio / http，tools/list + tools/call     │
│  src/skills/registry.ts 技能包                  │
│    · 按猫注入真实模式 system prompt            │
│  src/tools/approval.ts 铲屎官审批队列          │
│    · pending → approve / reject                │
├──────────────────────────────────────────────┤
│  src/agents/          猫猫的"大脑"             │
│    mock-brain.ts   场景 beats → CatTurn[]     │
│    llm-brain.ts    真实模型 → CatTurn[]       │
│    personas.ts     四猫人格 + 场景数据         │
└──────────────────────────────────────────────┘
```

依赖方向是单向的：`agents ← engine ← server ← main`。`domain/types.ts` 是唯一共享契约。

## 为什么这样切

### 1. 状态只有一个写入口

多 Agent 系统最容易烂的地方是"谁都能改状态"。这里所有变更都经过 `Studio` 的方法，
前端只读快照，driver 只调 mutator。好处：

- SSE 可以无脑推全量快照（状态小，几十 KB），前端不需要自己合并增量；
- 持久化、seq、订阅三件事只写一次，不会漏；
- 测试可以脱离 HTTP 直接驱动 `Studio`。

**代价**：每个状态变更都递增 `seq` 并广播。高频打字态也会触发广播，但这是本地单用户场景，
用带宽换掉一整类同步 bug，是划算的。

### 2. Brain 是可替换的纯函数

`CatBrain.think(ctx) → Promise<CatTurn[]>`。driver 不关心台词从哪来：

- `mock-brain` 从场景 beats 取数据，确定、离线、可测试；
- `llm-brain` 拼 prompt 调模型，失败降级到 mock。

**代价**：mock 演出是"半脚本"的——猫的反应由场景数据 + 当前阶段决定，
不会真的理解新需求。这是有意的取舍：没有 key 也能完整演示协作流程，接了 key 才换脑子。

### 3. @ 路由不是装饰

`message.mentions` 是真实的路由依据：

- 用户消息只唤醒被 @ 的猫；没 @ 时唤醒任务 owner（无任务时宪宪）；
- 猫的交接（handoff）只唤醒接收方；
- 未被唤醒的猫不产生任何 token / 动作，前端显示睡眠。

这条规则让"漏 @"成为可观察的故障：卡片照写、消息照发，但接收猫没被唤醒，
任务 `status` 变 `stalled`，铲屎官点「催一下」后由宪宪补投递。这是 Cat Café 教程里
第 4 课的真实教训，在这个项目里被做成了可复现的一幕。

## 任务阶段机

```
intake ──► planning ──► working ──► reviewing ──► done
                            ▲            │
                            └── revising ◄┘
```

| 阶段 | owner | 产出 |
|---|---|---|
| intake | 宪宪 | 接住需求、复述风险 |
| planning | 宪宪 | 方案骨架 + 两张五栏交接卡 |
| working | 烁烁 / 金渐层 | design / patch 产物 |
| reviewing | 砚砚 | review 产物（blocker / minor + verdict） |
| revising | 金渐层 | v2 patch |
| done | 宪宪 | decision 产物 + 记忆 |

阶段推进由 driver 根据 `CatTurn.kind` 决定：`handoff` → 下一阶段，`review.request_changes`
→ revising，`review.approve` → 等宪宪落 decision，`decision` → done。台词内容不属于状态机。

## 实时更新

- 初始化：`GET /api/state` 拉一次全量。
- 之后：`GET /api/events` SSE，每条 `data: {seq, state}`。
- 客户端按 `seq` 去重；断线后先重连，再补一次 `/api/state`（防止漏帧）。
- 服务端每 15s 发一次 `: ping` 心跳，避免代理掐连接。

## 运行时设置

设置面板（`GET/PUT /api/settings`、`POST /api/settings/test`）背后是 `SettingsStore`：

- **切模式不重启**：driver 持有 `SwitchableBrain` 这层壳，设置保存时原地换成 mock 或 llm；
- **节奏只缩放延迟**：`wait(ms)` 乘上 `slow=1.7 / normal=1 / fast=0.5`，状态机不受影响；
- **密钥边界**：`apiKey` 只存在进程内存。`getPublic()` 只回 `hasKey/keySource`，落盘的
  `data/settings.json`（0600）只有 `mode/speed/baseUrl/model/temperature`；
- **测试连接**：`POST /api/settings/test` 请求 `{baseUrl}/models`，8s 超时，返回耗时与
  可用模型数；错误信息经过脱敏，不会带出 key。

## 持久化

`data/studio.json`（协作状态 + 猫猫档案）、`data/settings.json`（非敏感设置）、
`data/scenarios.json`（导入的自定义剧本），都是原子写（tmp + rename）。
启动时若无 studio 文件则种下房间 + 四猫招呼；若有则恢复（并把残留的 typing 清空）。
没有数据库：这个体量的数据用 JSON 足够，且方便直接 `cat` 出来看。

## 下一层：档案 / 每猫模型 / 剧本

- **猫猫档案**存在 `studio.json` 的 `cats` 里。加载时以代码里的 `CATS` 为底，只接受
  白名单字段的合法覆盖（改名/称号/性格/口头禅/招呼语/主题色），并做重名回退。
  id / role / avatar / species 不可改，所以 `room.catIds`、@ 路由、历史消息都不受影响。
- **每猫模型**是 `Cat.llmModel / llmTemperature`：llm-brain 在每次 think 时从当前 `ctx.cat`
  解析，空值回落全局。这样不用为每只猫维护一个 brain 实例，也不影响 mock 模式。
- **剧本库**的核心是数组引用稳定：`SCENARIOS` 在启动时一次性交给 driver / HTTP / brain，
  导入和删除都原地 `push/splice`，所以不需要重启，也不需要重建对象。
  导入前走 `scenario-validation.ts` 的逐条校验——坏剧本宁可拒绝，也不能把运行时带崩。
  内置剧本只读；删除只对自定义生效。

## 工具执行（干活层）

工具不是提示词，是三个真实约束：**路径、命令、时间**。

- `CatTurn.kind === "tool"` → driver 先 `addToolCall`（running）→ `sandbox.execute` →
  `finishToolCall` → 落一条 `kind:"tool"` 的消息（带 `toolCallId`）。工具不改变阶段、不触发交接。
- 所有路径都 `resolve` 到 `data/workspace/` 内，绝对路径和 `..` 直接拒绝；
- `run_command` 只允许 `node` / `npm`，参数走正则白名单，`shell:false`，10s 超时，输出截断到 4000 字；
- 执行失败不抛异常，落 `status:"error"` + exitCode + 输出，让后面的 cat turn 继续解释；
- 设置面板可以关掉工具执行（`toolsEnabled`）；关掉后 tool turn 变一句说明，协作流程照走。
  注意：mock 剧本里"测试挂了/测试全绿"的台词是写死的，关掉工具后这些台词不再对应真实执行。

## 工具与技能（B 层）

**工具注册表**：`ToolRegistryImpl` 里挂两类 provider——

- `builtin`：沙盒的 4 个工具（`src/tools/builtin.ts` 里带 JSON schema、risk、source）；
- `mcp:<serverId>`：MCP manager 连接成功后动态注册，工具名统一是 `<serverId>__<toolName>`。

driver 只依赖 `ToolRegistry`，执行时先查内置、再遍历 provider；MCP 工具走
`McpClient.callTool`。工具是否可用还要过每猫权限：`Cat.tools` 为 `undefined` 表示不限制，
数组是白名单（空数组 = 一个都不给），未授权工具不执行、不弹审批，直接记一条 error 回喂。

**MCP 客户端**：JSON-RPC 2.0，支持两种 transport——

- stdio：spawn 本地进程，newline-delimited JSON，适合 `npx @modelcontextprotocol/server-*`；
- http：Streamable HTTP，POST JSON-RPC，兼容 JSON 与 `text/event-stream` 响应，带 `mcp-session-id`。

握手只做 `initialize → notifications/initialized → tools/list`；调用是 `tools/call`，
结果取 `content[].text` 拼接，`isError` 映射成 error。所有请求 8s 超时，连接失败只记
`lastError`，不会拖垮工作台。配置持久化在 `data/mcp.json`（用户显式添加，无密钥字段）。

**技能包**：`src/skills/registry.ts` 里四个内置技能（架构拆解 / Review 清单 / 设计系统 / TDD 纪律），
`Cat.skills` 缺省时按角色回落。driver 用 `skillsForCat(cat)` 填 `TurnContext.skills`，
llm-brain 把 name + prompt 全文塞进 system prompt；演出模式不调用模型，技能自然不生效。

**安全**：MCP server 是用户自己添加的本地进程/服务；MCP 工具默认 `risk = needs_approval`，
模型主动调用会进审批队列；审批策略为 `auto` 时才全自动放行。

## 工作区与多房间（C 阶段）

- `Room.workspaceId` 绑定一个工作区；默认房间绑 `ws_sandbox`（`data/workspace`，可读写）。
- `WorkspaceManager` 管理自定义仓库：绝对路径校验、realpath 去重、git 目录探测；
  自定义仓库默认 `read-only`，`PolicySandbox` 在工具执行前拦下 `write_file` / `run_command`。
- driver 新增 `sandboxFor(roomId)`：内置工具按「房间 → 工作区」选沙盒执行；MCP 工具仍走注册表。
- git 是只读的：`git rev-parse` / `status --porcelain` / `diff` / `log -1`，
  `GIT_TERMINAL_PROMPT=0`、5s 超时、输出截断；本阶段不做 checkout / commit / push。
- 房间切换是纯前端视图状态；服务端状态本来就按 roomId 隔离（消息、任务、typing、队列）。

## 任务级 git 工作流（C-2）

- 读写 git 工作区开任务时，`createTaskBranch` 检查「当前不在 catcafe/* 分支 + 工作树干净」后
  切出 `catcafe/<taskId>`；失败只把 `Task.git.error` 记进任务，不阻塞协作。
- `taskDiff`：已提交看 `git diff base...branch`，否则看工作树 `git diff` + status。
- `commitTask`：只允许读写 git 工作区；校验任务分支、`confirm:true`、message 1–200；
  `git add -A && git commit`，成功后 `git checkout base`，任务分支保留给人工 review。
- `rollbackTask`：已提交拒绝；否则 `git stash push -u` 收走改动（可恢复），
  切回 base 并删除空任务分支。
- 安全边界不变：不 push、不 merge、不 amend；branchPerTask 关闭或没有任务分支时禁止 commit。

## 真实模式的工具调用与审批

llm-brain 的输出 schema 增加第 7 种 turn：`kind:"tool"`。模型可以主动请求工具，
driver 执行后用 `trigger.kind="tool_result"` 再叫同一只猫，把 exitCode/output 喂回去
（首轮 + 最多 3 次回喂，工具轮本身不推进阶段）。

**审批闸门**（`src/tools/approval.ts`）：

- 只对「模型驱动」生效：`brain.mode === "llm"`；mock 剧本里的工具永远自动放行；
- 策略：`auto` 不批 / `commands` 只批 `run_command` / `all` 全批；
- pending 流程：`addToolCall(status:"pending")` → `await gate.request()` → 批准后
  `startToolCall` 再执行；拒绝则不执行，把 `rejected` 回喂给模型；
- HTTP：`POST /api/tool-calls/:id/approve|reject`、`GET /api/approvals`；
- 审批期间不触发 stall 判定（等待是人，不是猫卡住了）。

这样模型不能直接决定跑什么命令——命令执行要么来自剧本，要么经过铲屎官点头。

## 真实模式

设置面板保存 `baseUrl + model` 后进入 `llm` 模式；也可以让 `LLM_BASE_URL` / `LLM_MODEL` /
`LLM_API_KEY` 作为启动默认值。key 只存在进程内存，不落盘、不进日志。
任何调用失败都降级到 mock，保证界面永远有内容。详见 [llm.md](./llm.md)。

## 有意不做的事

- **不做鉴权 / 多用户**：本地单人工作台。
- **不做增量 patch 同步**：全量快照换简单。
- **不做前端构建**：零依赖、零构建，打开源码就能改。
- **不做真实任务执行**：猫交付的是 spec / design / patch 摘要，不是真的改你的仓库。
  这个项目的目标是"协作过程本身"，不是 coding agent。
- **不做可视化剧本编辑器**：剧本导入/导出 JSON，用你顺手的编辑器改；服务端负责校验。
