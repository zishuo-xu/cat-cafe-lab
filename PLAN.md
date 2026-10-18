# Cat Café Lab · 猫咖工作台

> 铲屎官提一句需求，四只猫在同一个房间里把它做出来。你能看见它们怎么拆活、怎么 @ 对方、
> 怎么交接、怎么互相挑刺、怎么把决定记进共享记忆。

一个可交互的本地 Web 应用。默认**不需要任何 API key**：内置一套确定性的"猫猫演出"，
打开就能看完一次完整协作。配好模型后可以切到真实 LLM。

**不做的事**：不做 benchmark，不做指标表，不证明"某机制提升 X%"。这个项目只回答一件事——
多 Agent 协同**看起来、用起来**是什么样，以及猫咖那套协作纪律落地后是什么手感。

---

## 1. 体验剧本（默认演出模式）

铲屎官在房间输入：

> 给登录页加一个「记住我」勾选框，7 天内免登录。

接下来发生的事情（每步都有打字延迟，节奏像真的在聊）：

1. **宪宪（主架构师）**先接住：复述需求、指出两个风险（安全 / 过期策略），
   然后给出方案骨架，并把活拆开。
2. 宪宪发出**两张结构化交接卡**：
   - 给 **烁烁**：设计勾选框的状态与文案；
   - 给 **金渐层**：实现后端 remember-me token。
   交接卡固定五栏：`做什么 / 为什么 / 取舍 / 未决问题 / 下一步`。
3. **烁烁**交回设计稿（交互文案 + 状态图），顺手 @ 宪宪。
4. **金渐层**交回实现稿（diff 摘要），并 @ 砚砚 请求 review。
5. **砚砚**逐条 review：抓到一个 blocker（token 没设过期时间）和一个 minor
   （勾选框默认可访问性问题），@ 金渐层 要求修改。
6. **金渐层**改完 v2，重新交接给砚砚。
7. **砚砚**通过，宪宪落一条**决策**和一条**教训**进共享记忆，任务完成。

### 可玩的地方

- **@ 谁谁来**：`@烁烁 顺便看看移动端`，只有烁烁醒；其他猫显示 `💤 睡觉中`。
  不 @ 任何人时，宪宪作为主理猫接话。
- **打断 / 催一下**：任何阶段铲屎官都可以插话。任务卡住时（演示里埋了一次"交接漏 @"
  导致的卡死），点「催一下」会触发宪宪检查并补救。
- **记忆复用**：再提一个相关需求（"上次那个 token 方案，换成 30 天"），
  猫会引用上次的决策记录，而不是从零开始。
- **真实模式**：设置 `LLM_*` 环境变量后，四只猫的台词由真实模型生成，
  协作流程（谁接活、怎么交接、review 顺序）保持不变。

---

## 2. 四只猫

| id | 名字 | 品种 | 角色 | 默认模型 | 性格与说话方式 |
|---|---|---|---|---|---|
| `xianxian` | 宪宪 | 布偶猫 | 主架构师 / 主理猫 | Claude | 稳、先问为什么、爱把风险摆桌上；"我先说结论，再拆。" |
| `yanyan` | 砚砚 | 缅因猫 | Reviewer / 安全与细节 | GPT/Codex | 较真、只认证据、爱列编号问题；"第 2 条，我不同意。" |
| `shuoshuo` | 烁烁 | 暹罗猫 | 设计 / 创意 | Gemini | 跳脱、画面感强、爱用比喻；"这个勾选框得会呼吸。" |
| `jinjianceng` | 金渐层 | 英短金渐层 | 实现 / 多面手 | opencode | 话少、先干再说、偶尔偷偷省一步；"能跑，但我知道有个坑。" |

每只猫有：专属头像（内联 SVG）、主题色、口头禅、睡眠状态。**名字、人格来自 Cat Café 的原始设定**。

---

## 3. 协作机制（必须真实生效，不是文案）

1. **共享房间**：所有猫和铲屎官在同一个 timeline 里，消息、交接卡、artifact 都在同一处。
2. **@mention 路由**：消息只投递给被 @ 的猫 + 当前任务的 owner。
   未被 @ 的猫不产生回复，UI 显示睡眠。不 @ 时默认路由给宪宪。
3. **结构化交接卡**：`what / why / tradeoff / openQuestions / nextAction` 五栏。
   缺任何一栏，UI 会把卡片标黄，且接收猫的回复里会追问缺失项（演示中至少出现一次）。
4. **跨猫互审**：实现永远由非作者 review；review 结论只能是
   `request_changes` 或 `approve`，`request_changes` 会触发一轮 revise。
5. **决策日志 + 共享记忆**：任务结束时宪宪写入 `decision`；review 里发现的问题
   沉淀为 `lesson`。memory 在右侧面板可见，后续任务会被 brain 读取。
6. **故障与恢复（演示用）**：
   - `missed_mention`：某次 handoff 故意不带 @，任务卡住 → 「催一下」触发补救；
   - `silent_drop`：可选开关，让某只猫"去喝水"暂时不回，由宪宪重排。
   故障由任务场景决定，不是随机。

---

## 4. 任务状态机

```
intake ──plan──> planning ──handoff──> working ──handoff──> reviewing
   ^                  ^                                          │
   │                  └────────── revise <──request_changes──────┤
   │                                                             │
   └────────────── nudge / interrupt ────────────────────────────┘
                                                                  │
                                                          approve → done
```

- **owner** 随阶段变化：`intake/planning` = 宪宪；`working` = 金渐层 / 烁烁；
  `reviewing` = 砚砚；`done` = 宪宪。
- 每个阶段至少产生一条消息；`working/reviewing` 阶段产出 artifact。
- 任何阶段铲屎官消息都会让 owner 优先回应（除非被 @ 的是别人）。
- 卡住判定：owner 在该阶段超过 `STALL_MS`（默认 12s）没有新动作 → UI 显示「卡住了」+ 催一下按钮。

**场景（scenario）**是状态机的数据驱动部分：每个任务带一个场景 id，
决定交接给谁、埋什么 review 问题、什么时候漏 @。场景定义在 `src/agents/scenarios.ts`（T2 负责）。

---

## 5. 数据模型

以 `src/domain/types.ts` 为唯一契约。核心实体：

```
Cat, Room, Message, Task, TaskStep, Handoff, HandoffCard,
Artifact, MemoryEntry, StudioState
```

- 所有实体都有稳定字符串 id（`msg_xxx`、`task_xxx`…），由 `src/domain/ids.ts` 生成。
- `Message.kind`: `chat | handoff | review | decision | system | artifact`
- `Message.mentions`: 被 @ 的 catId；`Message.taskId / artifactId / handoffId` 用于卡片绑定。
- `StudioState.seq` 单调递增，用于 SSE 去重。
- 状态是**内存 + JSON 持久化**（`data/studio.json`，debounce 200ms），重启可恢复。

---

## 6. HTTP API 与实时推送

服务：`node src/main.ts`，默认 `http://127.0.0.1:4318`（`PORT` 可覆盖）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | `{ ok, mode }` |
| GET | `/api/state` | 返回完整 `StudioState` 快照 |
| POST | `/api/rooms/:roomId/messages` | body `{ text }`；解析 @mention；返回创建的 message |
| POST | `/api/tasks` | body `{ roomId, brief }`；创建任务并启动协作 |
| POST | `/api/tasks/:taskId/nudge` | 催一下，触发恢复 |
| POST | `/api/rooms/:roomId/interrupt` | body `{ text }`，等价于带 @ 的插话（同 messages 即可，可省） |
| GET | `/api/events` | **SSE**；每条 `data: {"seq":n,"state":StudioState}`；连接时先推一次全量 |
| GET | `/` | 静态前端（`public/`） |

约定：
- 服务端**单写者**：所有状态变更走 `src/server/studio.ts` 的方法，HTTP 层只做校验。
- SSE 每次推送全量快照（状态小，换取前端零状态同步 bug）；`seq` 单调。
- 错误返回 `{ error: string }` + 4xx/5xx。
- 静态文件做路径穿越防护，只服务 `public/` 下的白名单扩展名。

---

## 7. 目录与文件所有权

```
src/domain/types.ts        Lead 冻结契约（其他人只读）
src/domain/ids.ts          Lead
src/server/studio.ts       Lead：状态容器 + 所有 mutator + 持久化
src/server/http.ts         Lead：路由 + SSE + 静态服务
src/server/settings.ts     T4：环境变量解析 + 模式判定
src/main.ts                Lead：组装 driver/brain/server 并启动
src/engine/driver.ts       T1：会话队列、延迟调度、typing、中断
src/engine/stages.ts       T1：任务状态机 + 路由 + 故障/恢复
src/engine/mentions.ts     T1：@ 解析与投递规则
src/agents/personas.ts     T2：四猫定义（含 UI 颜色/emoji/SVG key）
src/agents/scenarios.ts    T2：演示场景与埋点（交接顺序、review 问题、漏 @）
src/agents/mock-brain.ts   T2：确定性 brain（根据 context 生成 CatTurn[]）
src/agents/llm-brain.ts    T4：真实 LLM brain（OpenAI 兼容），失败降级 mock
public/index.html          T3
public/app.js              T3
public/styles.css          T3
public/avatars.js          T3（内联 SVG 生成）
tests/engine.test.ts       T1
tests/agents.test.ts       T2
tests/llm.test.ts          T4
tests/integration.test.ts  T4
tests/smoke.test.ts        Lead
docs/architecture.md       Lead
README.md                  Lead
```

**规则**：只改自己 scope 内的文件；需要改 `types.ts` 或跨 scope，先给 Lead 发消息。
所有代码用 `.ts` 后缀 import（Node 原生 TS），不用 enum / namespace / 参数属性
（`erasableSyntaxOnly`）。

---

## 8. 技术约束

- Node >= 24，原生运行 `.ts`（`node src/main.ts`）、原生 `node:test`。
- **零运行时依赖**；devDependencies 仅 `typescript` + `@types/node`。
- 前端零框架、零构建：原生 ESM + CSS，`public/` 直接由服务端吐。
- 不使用外网字体/CDN/图片；头像用内联 SVG，保证离线可用。
- 中文 UI；代码标识符英文。
- 不记录 API key 到磁盘/日志；真实模式配置只从环境变量读。
- 前端必须支持 1280 桌面 + 手机窄屏（<= 720px 单列折叠）。

---

## 9. 验收清单（人工体验，不量化）

- [ ] `node src/main.ts` 一条命令起服务，浏览器打开即是完整猫咖界面。
- [ ] 无 API key 时，点「新任务 / 提需求」能看完整六阶段协作，节奏自然（有打字感）。
- [ ] `@` 任意猫会只唤醒它；其他猫处于睡眠态；不 @ 时宪宪接话。
- [ ] 交接卡五栏完整渲染；漏 @ 那一幕能观察到"卡住 → 催一下 → 补救"。
- [ ] review 阶段能看见"打回 → 修改 → 通过"的完整闭环。
- [ ] 任务结束后决策/教训出现在记忆面板；第二个相关任务会引用它。
- [ ] 刷新页面状态不丢；SSE 断线重连后能恢复。
- [ ] 手机宽度可用；没有任何外网资源请求。
- [ ] `node --test tests/` 全绿；`tsc --noEmit` 无错。
- [ ] README 有截图 + 一段真实协作 transcript。

---

## 10. 里程碑

1. **M0 骨架**（Lead）：types / studio / http / ids / 配置 / 启动脚本，`/api/state` 可访问。
2. **M1 引擎**（T1）：状态机 + 路由 + 延迟调度；单测覆盖"只有 owner 动""漏 @ 卡住 → nudge 恢复"。
3. **M2 猫猫内容**（T2）：四猫人格 + 场景 + 确定性台词；单测覆盖"每个阶段都有台词且带五栏卡片"。
4. **M3 前端**（T3）：三栏布局 + 消息流 + 卡片 + 记忆面板 + SSE + 移动端。
5. **M4 真实模式**（T4）：LLM brain + 降级 + 配置文档 + 集成测试。
6. **M5 集成收尾**（Lead）：端到端走查、截图、README、docs。

## 11. 协作约定

- 先读本文件 + `src/domain/types.ts`，再动手。
- 每完成一块跑自己的测试；接口有疑问先发消息，不要擅自改契约。
- 不提交 `data/`、`node_modules/`。
- 提交粒度：每个里程碑一个 commit（Lead 统一提交，或各自 commit 后 Lead squash）。
