# Cat Café Lab · 猫咖工作台

**铲屎官提一句需求，四只猫在同一个房间里把它做出来。**
你能看见它们怎么拆活、怎么 @ 对方、怎么交接、怎么互相挑刺、怎么把决定记进共享记忆。

一个本地 Web 应用。**不需要任何 API key**——内置一套确定性的猫猫演出，打开就能看完一次完整协作。
配好模型后可以切换成真实 LLM。

![猫咖工作台](docs/images/hero.png)

---

## 为什么做这个

参考的是 [Cat Café / Clowder AI](https://github.com/zts212653/clowder-ai)：一个人同时用 Claude、GPT、Gemini，
结果自己变成了**人肉路由器**——在聊天窗口之间复制粘贴上下文，手动追踪谁说了什么。
猫咖要解决的就是这件事：让猫猫们共享同一个房间、同一张任务板、同一套记忆，自己协作。

这个项目不是 Clowder 的复刻，也不是通用 Agent 框架。它只做一件事：
**把猫咖那套协作纪律做成一个看得见、点得动的工作台。**

具体来说，下面这些机制都是真的在跑，不是文案：

- **@mention 路由**：`@烁烁` 只唤醒烁烁，其他猫睡觉；不 @ 时宪宪接话。
- **结构化交接卡**：五栏 `做什么 / 为什么 / 取舍 / 未决问题 / 下一步`，缺栏前端标黄。
- **跨猫互审**：实现永远由非作者 review；`request_changes` 会真的触发一轮 revise。
- **决策日志 + 共享记忆**：任务结束宪宪落 decision 和 lesson，后续任务会被大脑读到。
- **故障与恢复**：`remember_me` 剧本里埋了一次"交接漏 @"，任务会真卡住——点「催一下」才恢复。
- **真实工具**：金渐层在独立沙盒里真的写文件、真的跑测试；砚砚的 review 基于真实退出码和失败输出。
- **真实模式工具调用 + 审批**：模型可以主动请求工具，执行结果回喂给它继续推理；跑命令前可以挂起等铲屎官批准。
- **工具注册表 + MCP + 技能**：工具不再写死，MCP server 的工具动态注册；每只猫有自己的工具权限和技能包。
- **多房间 + 真实仓库**：一个房间绑定一个工作区；真实仓库默认只读，任务分支 + diff + 人工确认 commit + stash 回滚。

---

## 快速开始

要求 **Node.js >= 24**（项目直接用 Node 原生 TypeScript，无运行时依赖）。

```bash
cd cat-cafe-lab
pnpm install          # 只装 typescript + @types/node 两个 devDependency
node src/main.ts      # 或 pnpm start
```

打开 <http://127.0.0.1:4318>。

点「＋ 新任务」→ 选「记住我」示例 → 「让猫猫开工」，然后看着就行。

```bash
node --test tests/    # 181 个测试
npx tsc --noEmit      # 类型检查
```

默认端口 4318，可用 `PORT=4400` 覆盖；数据落在 `data/studio.json`，
沙盒项目在 `data/workspace/`，删掉这两个目录就是重开一局。

---

## 怎么玩

| 操作 | 会发生什么 |
|---|---|
| 输入 `@砚砚 帮我看下这个 token 方案` | 只有砚砚醒过来回复，其他猫继续睡 |
| 不 @ 直接说需求 | 宪宪接话，判断要不要开任务 |
| 点「＋ 新任务」 | 创建任务，宪宪进入 intake 阶段开始拆活 |
| 任务卡住时点「🐾 催一下」 | 宪宪检查并在漏 @ 的地方补投递，任务继续 |
| 跑完「记住我」后再提「导出 CSV」 | 宪宪会引用上次决策，而不是从零开始 |
| 点左侧猫名 | 往输入框插入 `@名字` |
| 点左上角 ⚙️ | 打开设置：切演出/真实模式、配 LLM、调回复节奏、重置数据 |

### 六阶段

```
接单 → 规划 → 实现 → 评审 → 修订 → 完成
intake planning working reviewing revising done
```

每个阶段有明确 owner：宪宪接单/规划/收尾，烁烁做设计、金渐层做实现，砚砚负责评审。
评审打回后金渐层交 v2，砚砚通过后宪宪落决策与记忆。

![完成后：评审通过、决策落库](docs/images/tools-run.png)

手机宽度下折叠成单列，底部「聊天 / 猫猫 / 工作台」三个 tab：

<img src="docs/images/ui-mobile.png" alt="手机宽度" width="320" />

---

## 猫猫真的会干活（沙盒）

到这一层，猫交付的不再是"看起来像代码的文字"。金渐层会在 `data/workspace/` 里真的写文件，
然后跑 `node --test`；砚砚的 review 依据是**真实的退出码和失败输出**。

工具只有四个，全部锁在沙盒根目录里：

| 工具 | 能做什么 | 限制 |
|---|---|---|
| `read_file` | 读沙盒里的文件 | 拒绝绝对路径、`..`、越界 |
| `write_file` | 写文件（自动建目录） | 单文件 ≤ 64KB |
| `list_files` | 列目录 | 最多 200 条 |
| `run_command` | 跑 `node` / `npm` | 命令白名单、不经过 shell、10s 超时、输出截断 |

一次真实的「记住我」任务会看到 6 次工具调用：

```
write_file  src/remember.js v1   ✓
run_command node --test ...      ✗ exit 1（过期后校验失败）
run_command node --test ...      ✗ exit 1（砚砚复跑）
write_file  src/remember.js v2   ✓
run_command node --test ...      ✓ exit 0
run_command node --test ...      ✓ exit 0（砚砚放行）
```

右侧「沙盒」面板能直接看文件树、点开文件看猫写进去的内容；
设置里可以一键关掉工具执行（关掉后猫只产出文字方案），也可以重置沙盒回初始状态。

![真实工具调用](docs/images/tools-run.png)

![沙盒文件](docs/images/sandbox.png)

---

## 真实模式：猫会自己决定用工具（需要铲屎官点头）

演出模式里的工具节拍是剧本写好的。到了真实模式，模型可以**自己请求工具**：

1. 模型的输出里带一个 `kind:"tool"` 的 turn（比如「跑一下 `node --test test/export.test.js`」）；
2. driver 执行后，把 `exitCode` + 输出作为 `tool_result` 再喂回给同一只猫——它可以据此决定下一步
   （ReAct 循环，最多连续 3 轮）；
3. 模型主动发起的 `run_command`（按策略也可以是所有工具）会先挂起成 **pending**，
   左上角出现 `Needs Me`，工具卡上出现「批准执行 / 拒绝」；
4. 批准 → 真实执行；拒绝 → 不执行，把 `rejected` 回喂给模型，让它换方案。

审批策略在设置里：`auto`（全自动）/ `commands`（跑命令才批，默认）/ `all`（全批）。
**剧本里的工具永远自动放行**——脚本是作者写的，模型决定才需要人把关。

![待审批的工具调用](docs/images/approval.png)

> 真实模型效果取决于 provider 是否能稳定输出 JSON 数组；当前用本地假端点端到端验证过完整链路，
> 失败会自动降级回演出模式。真机接真实 provider 时，建议先用低风险任务试。

---

## 工具与技能（MCP + Skills）

工具从「写死四个」变成了**注册表**：内置沙盒工具是一个 provider，MCP server 是另一个。

- 设置 →「MCP 工具」里添加 server（stdio 命令或 HTTP URL），连接成功后它的工具会出现在
  `/api/tools` 和猫的工具目录里；MCP 工具默认风险等级 `needs_approval`，模型调用要经过审批。
- 设置 →「猫猫与模型」→「工具/技能」：给每只猫勾选允许的工具和技能包。
  默认配置是：宪宪只读、砚砚只读+跑测试、烁烁只读、金渐层读写+跑命令。
- 技能包会注入真实模式的 system prompt（架构拆解 / Review 清单 / 设计系统 / TDD 纪律）。
  演出模式不调用模型，技能不生效。
- MCP server 是你自己添加的本地进程或服务；项目只负责连接、列工具、调用和审批，不内置任何 server。

![MCP server 管理](docs/images/mcp.png)

![每猫工具与技能](docs/images/mcp-access.png)

---

## 多房间与真实仓库（C 阶段）

工作台不再只有一个房间：

- 每个房间绑定一个**工作区**；默认房间绑内置沙盒（`data/workspace`，可读写）。
- 设置 →「工作区」可以把一个真实目录加进来。**真实仓库默认只读**：只允许读文件、列目录；
  `write_file` / `run_command` 会被直接拒绝，工具卡上能看到原因。
- 改成读写必须显式确认（「我确认写入会修改真实文件」），并且会一直有醒目提示。
- git 部分目前是**只读查询**：分支、clean/dirty、status、diff、文件浏览。
  不会自动 checkout、不会自动 commit、不会 push。
- 房间切换后，timeline / 任务 / 交接卡 / 产物 / 记忆 / 输入框都按当前房间隔离；
  只读房间跑任务时，写文件工具会显示只读错误，仓库一个字节都不会被改。

![房间与当前工作区](docs/images/workspaces-main.png)

![工作区管理](docs/images/workspaces.png)

![git 状态与 diff](docs/images/git.png)

### 任务级 git 工作流

读写 git 工作区里开任务时，会自动从当前 base 分支切出 `catcafe/<taskId>`：

1. 猫在一个独立任务分支上改文件，工作树不干净 / 已有未收尾任务分支时**不会硬开**，只记录提示；
2. 右侧「任务 Git」卡显示分支、base、工作树改动数；「查看 diff」是真实 `git diff`；
3. 「提交」必须填 message + 勾选确认，服务端再校验 `confirm:true` 与当前分支；
   提交后自动切回 base 分支，任务分支保留给你 review / merge；
4. 「回滚」用 `git stash push -u` 收走改动（可 `git stash list` 找回），切回 base 并删除空任务分支；
   已提交的任务拒绝回滚，避免动历史；
5. 只读工作区、非 git 工作区、`branchPerTask` 关闭时不允许提交。

![任务 Git 卡片](docs/images/task-git.png)

![任务 diff](docs/images/task-diff.png)

![提交后](docs/images/task-git-committed.png)

> 仍然不做的事：不自动 push、不自动 merge 到主分支、不 amend、不删有 commit 的分支。
> 这些故意留给你。

---

## 一次真实协作（从 `data/studio.json` 里摘的）

> **铲屎官**：给登录页加一个「记住我」勾选框，7 天内免登录。
>
> **宪宪**：收到——能做，但先钉两件事：token 存在哪、7 天到了谁负责清；再把活拆成设计和实现两张卡。
>
> **宪宪**：风险我摆桌上了，活拆两张卡：烁烁管勾选框的状态和文案，金渐层管后端 token。
>
> **宪宪**（交接卡 → 烁烁）：勾选框不是画个方块，它得说清楚「这台设备以后不用再登」。
>
> **宪宪**（交接卡 → 金渐层）：先别急着写，把过期和吊销这两条想清楚再动手。
>
> **烁烁**：设计稿交了：状态图加三段文案。勾选这件事，说白了是把「我信这台设备」讲成人话。
>
> **金渐层**：我先把 token 写出来，跑一遍测试；跑完再交卡。
>
> **金渐层**：✍️ 写入 `src/remember.js`……✓
>
> **金渐层**：▶️ 跑 `node --test test/remember.test.js`……✗ 退出码 1。
> 「测试没全过：签发和有效期都过了，但『过期后校验失败』那条挂了——过期校验我还没补。」
>
> **金渐层**：能跑，但我知道有个坑，先交出来让砚砚看。砚砚，卡贴这儿了，过期和并发那两块重点帮我盯一下。
>
> *（任务卡住：交接卡写了给砚砚，但没带 @，消息没投出去。）*
>
> **铲屎官**：🐾 催一下
>
> **宪宪**：我看了，金渐层那张交接卡写了给砚砚，但没带 @，消息根本没投出去。我这就把 @ 补上。
>
> **砚砚**：▶️ 先跑测试……✗ 退出码 1，3 条挂了 1 条。
> 「第 1 条，过期时间只是写进了记录，校验时根本没比较；第 2 条，勾选框默认勾选、也没绑 label。」
>
> **金渐层**：✍️ 写入 v2……✓ ▶️ 再跑……✓ 退出码 0。
>
> **砚砚**：▶️ 再跑一遍……✓ 3 条全过。blocker 关掉，minor 收掉，approve。
>
> **宪宪**：收工。决策和教训各记一条进共享记忆，下次谁再提 remember-me 相关需求，直接接着往下走。

紧接着提「后台加一个导出 CSV 功能，要校验权限」，宪宪的开场是：

> 接着上次的记忆：remember-me 用 HttpOnly cookie，固定 7 天过期，默认不勾选。这次导出沿用同一套权限思路。

---

## 四只猫

| 猫 | 品种 | 角色 | 说话方式 |
|---|---|---|---|
| **宪宪** | 布偶猫 | 主架构师 / 主理猫 | 稳，先问为什么，爱把风险摆桌上 |
| **砚砚** | 缅因猫 | Reviewer / 安全与细节 | 较真，只认证据，爱把问题编号 |
| **烁烁** | 暹罗猫 | 设计 / 创意 | 跳脱，画面感强，爱用比喻 |
| **金渐层** | 英短金渐层 | 实现 / 多面手 | 话少，先干再说，偶尔偷偷省一步 |

名字和人格来自 Cat Café 的原始设定（布偶猫宪宪、缅因猫砚砚、暹罗猫烁烁）。

---

## 真实模式（可选）

两种配置方式，效果一样：

**方式 A：设置面板（推荐，不用重启）**

点左上角 ⚙️ → 填 Base URL / 模型名 / API Key → 点「测试连接」确认通 → 选「真实模式」→ 保存。
四只猫的下一条回复就会走模型。任何调用失败都会自动降级回演出模式，界面不会空。

**方式 B：环境变量（启动默认值）**

```bash
LLM_BASE_URL=https://api.deepseek.com/v1 \
LLM_MODEL=deepseek-chat \
LLM_API_KEY=sk-... \
node src/main.ts
```

面板里填过的值会覆盖环境变量；**API Key 只存在服务进程内存**，不写盘、不回传前端、不进日志。
重启后需要重填 key，或者继续用环境变量。细节见 [docs/llm.md](docs/llm.md)。

支持任何 OpenAI 兼容端点：OpenAI / DeepSeek / Moonshot / 百炼 / OpenRouter / Ollama / vLLM。

---

## 设置面板

左上角 ⚙️ 打开，包含四组真正需要的配置：

| 分组 | 内容 |
|---|---|
| 运行模式 | 演出模式 / 真实模式，切换后 `state.mode` 实时生效 |
| LLM 连接 | Base URL、模型名、API Key（密码框，留空不修改）、温度、**测试连接**（显示耗时与可用模型数） |
| 回复节奏 | 慢 / 正常 / 快，只缩放打字延迟，不影响协作逻辑 |
| 数据 | 重置猫咖（二次确认，清空任务/消息/记忆） |
| 猫猫与模型 | 改名字/称号/性格/口头禅/招呼语/主题色；真实模式下每只猫独立模型与温度 |
| 剧本库 | 查看/导出/删除自定义剧本，导入 JSON 剧本 |
| 工具执行 | 开关沙盒工具（写文件 / 跑命令）；关掉后猫只产出文字方案 |
| 审批策略 | auto / commands / all；只对真实模式下模型主动发起的工具生效 |
| MCP 工具 | 添加/启停/测试/删除 MCP server，工具动态进注册表 |
| 工具与技能 | 每只猫的工具白名单与技能包（技能注入真实模式 prompt） |
| 工作区 | 添加真实目录（默认只读）、读写二次确认、任务分支开关、git 状态/diff/文件浏览 |
| 任务 Git | 分支 / 真实 diff / 人工确认 commit / stash 回滚（仅读写 git 工作区） |

底部还有只读的运行信息（版本、端口、数据目录、Node、启动时间、stallMs）。
只有 `mode / speed / baseUrl / model / temperature` 会落盘到 `data/settings.json`（0600），key 永远只在内存。

![设置面板](docs/images/settings.png)

---

## 猫猫档案、每猫模型、自定义剧本

这三件事是「下一层」，都在设置面板里：

**猫猫档案**：名字、称号、性格、口头禅、招呼语、主题色都能改（id 不变）。
改名后 @ 新名字立刻生效，名册和消息里的旧名字也会跟着变。

**每猫模型**：真实模式下，每只猫可以单独指定模型和温度；留空就跟随全局设置。
比如宪宪用推理模型、金渐层用便宜快速的模型——和猫咖原本「不同模型不同分工」的思路一致。

**剧本库**：剧本是数据，不是代码。内置两个（记住我 / CSV 导出）只读可导出；
自定义剧本以 JSON 导入，服务端会逐条校验（猫 id、交接卡五栏、review verdict/findings），
通过后立刻出现在「新任务」的场景选择里。导入的剧本保存在 `data/scenarios.json`。

```jsonc
// 一个最简剧本骨架（完整示例可从「剧本库 → 导出」拿到）
{
  "id": "my_scenario",
  "name": "我的场景",
  "sampleBrief": "一句话示例需求",
  "tags": ["示例"],
  "beats": [
    { "stage": "intake", "cat": "xianxian",
      "turn": { "kind": "message", "text": "我先接住。" } }
  ]
}
```

![猫猫与模型](docs/images/settings-cats.png)

![剧本库](docs/images/settings-scenarios.png)

---

## 架构

```
public/            原生 ESM + CSS，无构建、无框架
  ↕ SSE（每条 {seq, state} 全量快照）
src/server/http.ts    REST + SSE + 静态资源
src/server/studio.ts  唯一状态容器，所有写操作走这里
src/server/settings-store.ts  运行时设置：模式 / 节奏 / LLM（key 只在内存）
src/workspaces/manager.ts 工作区：目录绑定、只读策略、只读 git 查询
src/tools/registry.ts 工具注册表：内置 + MCP
src/tools/sandbox.ts  沙盒：路径锁根目录、命令白名单、10s 超时
src/mcp/client.ts     MCP JSON-RPC 客户端（stdio / http）
src/skills/registry.ts 技能包（注入真实模式 prompt）
src/engine/driver.ts  每房间串行队列：阶段机 / 路由 / 延迟 / 工具执行 / 故障恢复
src/agents/           brain：mock（剧本）或 llm（真实模型）
src/domain/types.ts   唯一契约
```

设计取舍、状态机细节、为什么"全量快照"和"半脚本演出"是故意的，见
[docs/architecture.md](docs/architecture.md)。

跑起来之后还可以看 `GET /api/state` 的原始 JSON——整个应用的状态都在里面。

---

## 边界（诚实说明）

- **演出模式是半脚本的**：猫的反应由场景数据 + 当前阶段决定，不会真的理解任意新需求。
  这是为了让"没有 key 也能完整演示协作流程"；接了真实模型才会换脑子。
- **默认不碰你的仓库**：内置沙盒可读写；真实仓库加进来默认只读，写/跑命令会被拒绝，
  改成读写必须显式确认。commit 必须人工填 message + 二次确认；不会自动 push / merge；
  回滚走 stash，可恢复。
- **本地单人**：没有鉴权、没有多用户、没有数据库。JSON 文件就是全部持久化。
- **MCP server 由你负责**：项目只连接你显式添加的 server；默认没有鉴权配置，也不内置任何 server。
- **剧本台词不会自动改名**：改猫名后，@ 路由、名册、消息作者都用新名字，但剧本里写死的旧名字不会自动替换（剧本是数据，不是模板变量）。
- **剧本要自己写**：内置两个（记住我、CSV 导出），也可以在「剧本库」导入 JSON；不写剧本的需求会走通用兜底回复。

---

## 目录

```
cat-cafe-lab/
├── src/
│   ├── domain/        types.ts（契约）、ids.ts
│   ├── server/        studio.ts、http.ts、settings.ts、settings-store.ts
│   ├── tools/         registry.ts、sandbox.ts、builtin.ts、approval.ts
│   ├── mcp/           client.ts、manager.ts
│   ├── workspaces/    manager.ts
│   ├── skills/        registry.ts
│   ├── engine/        driver.ts、stages.ts、mentions.ts
│   ├── agents/        personas.ts、scenarios.ts、mock-brain.ts、llm-brain.ts
│   └── main.ts
├── public/            index.html、app.js、styles.css、avatars.js
├── tests/             engine / agents / llm / integration / settings / tools / cats-scenarios / workspaces / task-git / smoke（181 个）
├── docs/              architecture.md、llm.md、images/
├── data/              studio.json、workspace/（gitignore）
└── PLAN.md            设计与分工记录
```

---

## 致谢

- 概念与协作纪律参考 [Cat Café Tutorials](https://github.com/zts212653/cat-cafe-tutorials) 与 [Clowder AI](https://github.com/zts212653/clowder-ai)。
- 四猫人格与"漏 @ 会卡住"的教训来自 Cat Café 的真实复盘。

*猫咖开门，铲屎官随意。🐾*
