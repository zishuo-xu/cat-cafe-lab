# 前端

> 一句话：`public/` 是一份可以直接打开修改的原生 ESM 前端——没有框架、没有构建、没有外网资源，
> 所有内容都来自服务端的全量状态快照。

本文说明前端为什么这样写、页面怎么分层、状态怎么流动，以及几个关键交互的真实实现位置。
文中出现的函数名和 DOM 选择器都可以在 `public/app.js` / `public/index.html` /
`public/styles.css` 里直接搜到。

---

## 1. 设计原则

### 零框架、零构建、原生 ESM

- `public/index.html` 只引一个样式表和 `app.js`；`app.js` 用原生
  `import { avatarSvg, userAvatarSvg, brandMarkSvg } from "./avatars.js";`。
- `package.json` 的 scripts 只有 `start` / `dev` / `test` / `check`，没有前端 bundler；
  改完 `public/` 的文件刷新浏览器即可。
- 没有 React/Vue/Svelte，也没有虚拟 DOM；DOM 由 `h()` 与模板字符串生成，
  事件靠 `data-action` 委托（见第 6 节）。

这样做的收益：

- 前端没有运行时依赖，也没有 node_modules 参与页面加载；
- 源码就是产物，排障时不用 source map，直接看 `app.js`；
- 页面可以在 `file://` 之外任何静态服务器上跑，后端只负责 API + 静态文件。

代价见第 8 节。

### 零外部资源

- favicon 是 `index.html` 里的 `data:image/svg+xml` 内联 SVG；不请求 `/favicon.ico`。
- 字体使用系统字体栈（`--font-body` / `--font-display` / `--font-mono`），不引 Google Fonts。
- 所有成员头像由 `public/avatars.js` 生成：`avatarSvg(cat, options)`、
  `userAvatarSvg(size)`、`brandMarkSvg(size)`、`pawSvg(size)`。
- 页面没有 CDN、外部图片、统计脚本或远程字体。

### 内联 SVG 头像的取舍

`avatars.js` 用 SVG path 画四种成员（`ragdoll` / `mainecoon` / `siamese` / `golden`），
`avatarSvg(cat, { size, mood })` 支持 `idle` / `sleep` / `typing` 三种眼神/状态。

- **收益**：零请求、离线可用、没有 404；颜色跟着 `cat.accent` 走；
  名册、消息、交接卡可以传不同 `size`，不需要准备多套位图。
- **代价**：SVG 字符串在 JS 里，消息多时每次渲染都会重新拼字符串；
  头像的细节修改要改 path，不能像图片一样直接换文件。
- 头像 HTML 只来自本地生成器，通过 `innerHTML` 插入；没有把用户输入拼进头像 SVG。

---

## 2. 页面结构

桌面是三栏 `#app.app-shell`；移动端通过底部 tab 只显示其中一栏（样式见第 7 节）。

```
┌─────────────────────┬──────────────────────────────┬─────────────────────┐
│ aside.panel--left   │ section.panel--chat          │ aside.panel--work   │
│ 招牌 / 房间 / 名册  │ 消息流 / 输入框              │ 工作台              │
│ / 任务列表          │                              │ 任务/交接/产物/沙盒 │
└─────────────────────┴──────────────────────────────┴─────────────────────┘
```

### 左栏：招牌、房间、成员名册、任务列表

- `aside.panel--left`（`aria-label="交付台招牌、成员名册与任务列表"`）。
- 招牌：`#brand-mark`（由 `brandMarkSvg` 注入）、模式/连接/seq 胶囊
  `[data-mode]`、`[data-conn]`、`[data-seq]`、`[data-needs-me]`、`[data-test-button]`。
- 房间列表：`#room-list`，由 `renderRooms()` 渲染；切换房间走 `setRoom(roomId)`，
  当前房间 id 存在 `app.roomId`。
- 成员名册：`#cat-roster`，由 `renderRoster()` 渲染；状态来自 `catState(catId)`：
  `typing`（服务端 `typing`）、`working`（任务 owner）、`talking`（当前房间有草稿）
  或 `sleeping`。点击 `data-action="mention-cat"` 把 `@名字` 插入输入框。
- 任务列表：`#task-list`，由 `renderTasks()` 渲染；任务卡状态用
  `.task-item[data-status="active"]`、`.task-item[data-status="done"]`、`.task-item[data-status="stalled"]` 和 `.task-status-badge` 区分。

### 中栏：消息流与输入框

- `section.panel--chat` 里有：
  - 房间头 `.chat-head`：`[data-room-name]`、`[data-room-topic]`，房间切换按钮
    `data-action="open-room-picker"`；
  - 连接断线横幅 `#conn-banner`；
  - 时间线滚动容器 `#timeline-scroll`，内部 `#timeline`（`role="log"`，`aria-live="polite"`）；
  - 新消息浮条 `#jump-latest`（`data-action="jump-latest"`）；
  - 输入区：`#typing-hint`、`#mention-popup`、`#room-busy`、`#composer`、`#composer-input`、`#send-btn`。
- 消息节点由 `messageNode(message, animate)` 生成；任务分隔线由 `taskDividerNode(taskId)` 生成。
- 工具卡、交接卡、产物卡、评审卡都是消息节点的一部分，不是独立的浮层。

### 右栏：工作台

- `aside.panel--work` 顶部是 `.work-head`，内容在 `.work-scroll` 内：
  - 当前工作区 `#current-workspace-body`（`renderCurrentWorkspace()`）；
  - 任务进度 `#task-progress`（`renderWorkspace()` 内的进度区）：
    阶段轨道、owner、恢复面板、`data-action="open-task-trace"` 的「🔍 查看轨迹」按钮；
  - 任务 Git `#task-git-card`（`renderTaskGit()` / `ensureTaskGitDiff()` 相关逻辑）；
  - 交接卡 `#handoff-list`（`renderHandoffs()`）；
  - 产物 `#artifact-list`（`renderArtifacts()`）；
  - 沙盒/工作区文件 `#sandbox-list`（`renderSandbox()`）；
  - 共享记忆 `#memory-list`（`renderMemory()`）。

所有右栏数据都按当前房间过滤；房间切换后 `setRoom()` 会清空 timeline 缓存和沙盒状态，
再触发 `renderAll()`。

---

## 3. 状态管理

### 3.1 状态从哪来

`boot()` 的顺序：

1. `cacheDom()`：把所有固定 DOM 节点收进 `els`；
2. `bindUi()`：绑定全局 click/keydown 和输入框、表单、弹窗事件；
3. `paintChrome()` + `renderAll()`：先渲染空状态；
4. `refreshHealth()`、`refreshGlobalModel()`、`loadWorkspaces()`、`loadApprovals()`、
   `loadToolCatalog()`、`initTestCenter()`：拉次要数据；
5. `await refreshState()`：`GET /api/state` 拉首帧；
6. `connectEvents()`：建立 `EventSource("/api/events")`；
7. `startTicker()`：启动 1s 定时器，刷新卡住判定、审批倒计时、测试中心状态。

`app.state` 只由 `refreshState()` 和 SSE 的 `applyState(next)` 写入；前端不会先伪造一条消息再等服务端确认
（没有 optimistic message）。

### 3.2 全量快照 + seq 去重

- 服务端 SSE 每条是 `{ seq, state }`，`state` 是 `StudioState` 全量快照。
- `applyState(next)` 比较：
  - `Number(next.seq) <= app.lastSeq` 且 `next.startedAt === previous.startedAt` → 直接 return；
  - `startedAt` 变了（服务端重启/重置）→ 即使 seq 回退也接受，并更新 `app.lastSeq`。
- 连接断开重连时，`EventSource` 的 `onopen` 会先调用 `refreshState()` 补一次全量，
  再继续接收快照（见 `connectEvents()`）。
- 页面上 `[data-seq]` 显示当前 `seq`，用于确认是否还在收帧。

### 3.3 增量渲染与全量重建

- `renderAll()` 按区块调用渲染函数：`paintChrome()`、`renderRooms()`、`renderRoster()`、
  `renderTasks()`、`renderWorkspace()`、`renderCurrentWorkspace()`、`renderTimeline()`、
  `syncToolCards()`、`renderDraftBubble()`、`renderSandbox()`、`updateNeedsMe()` 等。
- 大部分区块用签名缓存（`app.sig.roster` / `app.sig.tasks` / `app.sig.progress` /
  `app.sig.handoffs` / `app.sig.artifacts` / `app.sig.memory` / `app.sig.rooms` /
  `app.sig.currentWorkspace`）：签名没变就直接 return，避免整块 `replaceChildren`。
- **timeline 是增量 append 的**：`renderTimeline()` 维护 `app.timeline.ids`，
  只给 `ids.length` 之后的新消息 `appendChild`，保留已有节点的动画与滚动位置。
- timeline 全量重建的条件（`renderTimeline()` 内）：
  - `app.timeline.ids.length > messages.length`；
  - 已渲染的 id 序列与新消息序列不一致；
  - `app.timeline.ids.length === 0` 但 `#timeline` 里还有残留的 `.msg` / `.sys-line` /
    `.task-divider` / `[data-synthetic-tool]` 节点。
- 全量重建会 `host.replaceChildren()`，清空 `toolCardNodes`、`app.timeline.ids` 和未读计数。
- 切换房间时 `setRoom()` 会直接清空 timeline 节点和缓存，再由 `renderAll()` 重建。

### 3.4 渲染边界

- 首帧之前 `app.state === null`，各渲染函数都为空数据兜底，不会抛错。
- 服务端字段缺失时（旧服务端）前端按空数据降级：例如 `state.drafts` 不存在就不画草稿，
  `settings.streaming` 不存在就禁用开关并显示说明。

---

## 4. 关键 UI 机制

### 4.1 时间线、滚动与新消息浮条

- 渲染：`renderTimeline()` 读取当前房间的 `roomMessages()`，逐条 `messageNode()`；
  跨任务的第一条消息前插入 `taskDividerNode(taskId)`。
- 滚动判定：`isNearBottom(el)` 用 `scrollHeight - scrollTop - clientHeight < 140`；
  `scrollToBottom(smooth)` 用 `requestAnimationFrame` + `scrollTo`，
  并根据 `prefersReducedMotion()` 决定是否平滑。
- 手动上滚保护：
  - 新消息追加前记录 `nearBottom`；
  - 如果原本在底部，调用 `scrollToBottom(true)`；
  - 否则不滚动，`app.unread += added`，由 `updateUnreadUi()` 显示 `#jump-latest` 浮条。
- `#jump-latest` 的 label 由 `updateUnreadUi()` 更新：普通新消息显示
  `↓ N 条新消息`；当前房间有 pending 审批时优先显示 `🙋 N 项待审批` 并加 `.is-pending`。
- 点击 `data-action="jump-latest"` → `scrollToBottom(true)` + `resetUnread()`。
- `updateUnreadUi()` 同时维护移动端聊天 tab 的小红点 `[data-tab-dot]`。
- **折叠**：消息本身不做逐条折叠；折叠出现在两处——
  - 工具卡输出：`data-action="toggle-tool-output"`，按钮文案在「展开输出 / 收起输出」之间切换；
  - 任务轨迹的阶段：`data-action="toggle-trace-stage"`（见 4.5）。
- timeline 没有虚拟滚动；消息会一直保留在 DOM 中。

### 4.2 工具卡与审批

工具卡由 `toolCardNode(call, message)` 创建，`toolCardNodes`（`Map<toolCallId, DOM>`）保存节点，
`syncToolCards()` 给没有对应消息的工具调用补位；`updateToolCard(card, call)` 原地更新状态，
避免 running → ok 时整卡重建。

五种状态由 `toolStatusLabel(call)` 给出：

| `call.status` | 卡片文案 |
|---|---|
| `pending` | `⏳ 等你批准` |
| `running` | `执行中…` |
| `ok` | `✓ 成功` |
| `error` | `✗ 失败` |
| `rejected` | `✗ 已拒绝` |

卡片根节点带 `.tool-card`、`data-tool-call-id`、`data-status`、`data-tool`；
状态/输出/审批区分别用 `[data-role="status"]`、`[data-role="approval"]`、
`[data-role="output"]` 等定位。

审批相关：

- `updateToolApprovalUi(card)` 渲染 pending 审批区（批准/拒绝/批准并记住/拒绝并记住、
  倒计时、说明文案）；`approvalRemainingMs(card)` 按 `startedAt + 5min - now` 算剩余，
  `formatApprovalCountdown(ms)` 格式化为 `m:ss`。
- `updateApprovalCountdowns()` 由 `startTicker()` 每秒调用；到 0 时显示
  `⏱ 已自动拒绝（超过 5 分钟）` 并禁用按钮（服务端会在 5 分钟自动拒绝）。
- 动作：
  - `data-action="approve-tool"` / `data-action="reject-tool"` 走普通审批；
  - `data-action="approve-tool-remember"` / `data-action="reject-tool-remember"` 带 `remember`。
- `decideToolCall(callId, decision, trigger, options)` 负责 POST
  `/api/tool-calls/:id/approve` 或 `/reject`，成功后在卡片上写
  `data-approval-remembered` 并显示「已记住」提示；失败走卡片内错误区。
- pending 数量由 `roomPendingApprovalCount()` 统计；`updateNeedsMe()` 更新 `[data-needs-me]` 的显隐、
  `[data-needs-count]` 和 `document.title`；`focusNeedsMe()` 会滚动到第一张 pending 卡并聚焦批准按钮。
- 审批排队/自动拒绝/记住的业务规则在后端；前端只展示和提交。

### 4.3 交接卡

- `HANDOFF_FIELDS` 定义五栏：`what`（做什么，宽栏）、`why`（为什么）、`tradeoff`（取舍）、
  `openQuestions`（未决问题）、`nextAction`（下一步）。
- `handoffCardNode(handoff)` 生成 `.handoff-card`：头部是交接路由（from/to 头像和名字）、
  中间 `.hc-grid`、末尾 warning（如果有缺栏）。
- `handoffFieldNode(field, card, missingLabels)` 生成 `.hc-field`；
  缺栏时加 `.is-missing`，值区显示 `.hc-missing`「空着 · 接收方会追问」。
- `handoffMissing(card)` 判断五个字段是否为空（字符串 trim 或数组至少一个非空项）；
  缺栏时卡根加 `.is-incomplete`，并显示 `.handoff-warning`
  「这张卡缺「…」——接收方会先追问再开工。」。
- 右栏缩略卡由 `miniHandoffNode` 生成，复用同一套 `HANDOFF_FIELDS` 和缺栏判断。

### 4.4 流式草稿气泡

- 数据来源：`state.drafts[roomId] = { catId, text, at }`；`currentDraft()` 只取当前房间的草稿。
- 渲染：
  - `renderDraftBubble()` 在 `renderAll()` 末尾调用；
  - `draftBubbleNode(draft)` 生成 `.msg.msg--cat.msg--chat.draft-bubble`，包含成员头像、名字、
    「正在输入…」脉冲点（`.draft-pulse`）和文本 `.bubble[data-role="draft-text"]`；
    没有 `.msg-time`，根节点是 `role="status"`、`aria-live="polite"`。
  - 草稿文本是「已累计的完整文本」，直接覆盖 `textContent`，不做增量拼接。
- 样式：`.draft-bubble` 半透明；`.draft-bubble .bubble` 限制最大高度（桌面 10.4em，
  移动端 8.8em）并 `overflow-y: auto`，超过约 6 行在气泡内部滚动，不把输入框挤走。
- 消失：正式消息落库后 `state.drafts` 的 key 消失，`renderDraftBubble()` 调
  `removeDraftBubbleWithFade()`，给节点加 `.is-leaving`，120ms 后移除（CSS transition）。
- 滚动：新草稿出现/更新时，若原本在底部则 `scrollToBottom(false)`；用户手动上滚时不强制。
- 名册联动：`catState(catId)` 先检查 `currentDraft()?.catId === catId`，返回 `talking`；
  `renderRoster()` 把它显示为「说话中」。
- 旧服务端没有 `drafts` 字段时 `currentDraft()` 返回 null，不渲染也不报错。

### 4.5 任务轨迹面板

- 入口：任务进度卡里的 `data-action="open-task-trace"`（`data-task-id` 绑定任务）
  打开 `#task-trace-modal`。
- 数据：`openTaskTrace(taskId)` → `loadTaskTrace(taskId)` 请求
  `GET /api/tasks/:taskId/trace`，响应 `{ task, entries, summary }` 存入 `traceState.data`。
- 汇总：`traceSummaryNode(data)` 生成：
  - `.trace-hero`：`.trace-hero-value` 显示
    `Math.round(summary.llmDurationMs / summary.durationMs * 100)%`，即「模型思考占总耗时」；
    下方是模型/总耗时和模型调用次数；
  - `.trace-share`：模型耗时占比条和第模型/其他耗时图例；
  - `.trace-metrics`：总耗时、模型调用、Tokens（in/out）、工具、交接、产物、
    降级（>0 时 `.trace-metric[data-tone="danger"]`）、审批拒绝、重试。
- 时间线：`renderTaskTrace()` 通过 `traceStageGroups(entries)` 按 `stage` 条目分组，
  每条 `traceEntryNode(entry, maxLlmDuration)` 生成 `.trace-item[data-kind="llm"]` 等（`data-kind` 为实际 kind）：
  - `stage`：不生成普通行，作为 `.trace-stage-head` 分隔线（接单/规划/实现/评审/修订/完成），
    点击 `data-action="toggle-trace-stage"` 收起/展开该阶段；
  - `llm`：紫色背景、`[data-role]` 之外的耗时条 `.trace-llm-bar` 和 token 文本；
  - `tool`：等宽字体；`data-tool-status` 为 `ok/error/rejected` 时文案颜色不同；
  - `handoff` / `artifact` / `review` / `chat`：各自的卡片色；actor 前有颜色点；
  - `meta.degraded === true` 的 llm 行：`.trace-item[data-degraded="true"]` 淡红背景、
    `.trace-degraded-badge`「降级」，根节点 `title` 是 `degradeReason`；
  - 长 detail 由 CSS `-webkit-line-clamp: 2` 折叠，点击 `.trace-detail` 切换 `.is-expanded`。
- 筛选：`.trace-filter[data-filter="all"]` / `[data-filter="llm"]` / `[data-filter="tool"]` / `[data-filter="handoff"]` 由
  `data-action="filter-task-trace"` 设置 `traceState.filter`，`traceVisibleEntries(entries)`
  过滤条目；筛选后没有匹配时显示「没有匹配的轨迹条目。」
- 空态/降级：entries 为空显示「这个任务还没有轨迹。」；404/503 显示「轨迹服务未就绪」+ 重试。
- 刷新：`data-action="refresh-task-trace"` 重新请求当前任务；面板打开时是快照，不会自动跟随后续事件。

### 4.5.1 模型连接状态与 Provider 预设（第一屏）

- 顶部 `#model-status-pill` 两个状态：`connected`（`模型：<model>`，绿）/
  `unconfigured`（`模型未配置 · 去设置`，红）。数据来自 `GET /api/health` 的
  `configured` / `model`（`refreshHealth()` 在启动、保存设置后拉取）。
- 未配置时点「＋ 新任务」（`openNewTaskModal()`）会 toast + 直接打开设置，并自动滚到 LLM 区；
  后端 `POST /api/tasks` 也会返回 `412 llm_unconfigured` 兜底。
- 设置第一屏 `#settings-llm-section`：
  - `#settings-provider-presets` 一排 chips（opencode zen / DeepSeek / OpenAI / 本地 Ollama / 自定义），
    点击 `applyProviderPreset(id)` 填 Base URL、默认模型、额外请求头；
  - 「高级：额外请求头」是 JSON textarea，保存时由 `parseHeadersInput()` 校验；
  - 「测试连接」`#settings-test-btn` 会真跑一次最小对话（见 `llm.md` 3.1），
    不只是查 `/models`。

### 4.5.2 「这句话像需求」确认框

- 发送前 `sendMessage()` 调 `looksLikeTaskBrief(text)`：
  - 有 `@成员` → 放行（针对某人的提问）；
  - 短句命中祈使动词（帮我 / 写一个 / 实现 / 修复 / 加个…）且不是纯提问 → 拦；
  - 长段落仍按结构信号（列表 / 多分句 / 多个要求）打分。
- 命中后 `showBriefHint(text)` 弹 `.confirm-dialog`（**必须带 CSS**，固定遮罩 + 居中卡片；
  曾经只加了 DOM 没加样式，用户点发送看不到任何反应）。
- 两个选择：「开任务」把原文带进新建任务弹窗并清空输入框；「就聊两句」放行一次
  （`app.briefHintAllowed`）。Esc / 点遮罩关闭且**不丢输入**。

### 4.6 测试中心

- 入口：`data-action="open-test-center"`（左栏顶部和聊天头各一个），打开
  `#test-center-modal`。
- 状态：`testCenterState` 保存 `runs` / `running` / `details` / `socket` /
  `selectedId` / `autoScroll` / `onlyFailures` 等。
- 启动：`startTest(kind, scenario)` POST `/api/tests/run`；unit / real / scenario。
  真实模型矩阵前有 `#test-real-confirm` 二次确认（`openTestRealConfirm()` /
  `confirmTestReal()`）。
- 日志：`connectTestStream()` 建立 `EventSource("/api/tests/stream")`，
  `handleTestStreamEvent(event)` 增量更新 `testCenterState.details`；
  `renderTestLog(force)` 增量 append `#test-log`，支持行号、只看失败行、自动滚动和「回到底部」。
  日志提示文案写明「最多保留 2000 行」。
- 历史：`loadTestRuns()` 拉 `/api/tests/runs`，`renderTestHistory()` 渲染
  `#test-history-list`；`updateTestCenterTicker()` 每秒更新状态、打开面板/运行中时轮询。
- 关闭 `closeTestCenter()` 只收抽屉，不停止运行；停止走 `data-action="stop-test"`。
- `testCenterState.available === false` 时显示服务未就绪，按钮禁用。

### 4.7 模型分工

- 设置 →「成员与模型」顶部 `#model-profiles-section`：
  `loadModelProfiles()` 请求 `GET /api/model-profiles`，`renderModelProfiles()` 渲染
  `#model-profile-list`。
- 每套档案由 `modelProfileCard(profile)` 生成 `.model-profile-card[data-profile-id]`：
  - 名称、描述、端点提示；
  - `recommended` → `.model-profile-badge[data-kind="recommended"]`「推荐」；
  - 当前配置与该档案完全一致 → `data-kind="active"`「当前生效」；
  - 当前选中的档案不一致 → `data-kind="drift"`「当前配置已偏离」；
  - 四条 `catId → model` 映射，`title` 是 `reason`；
  - 应用按钮 `data-action="apply-model-profile"` → `openModelProfileConfirm()` →
    `confirmModelProfileApply()` POST `/api/model-profiles/apply`。
- 分区标题旁的 `#model-profile-mode` 由 `currentModelMode()` 决定：
  四成员当前生效模型（覆盖或全局）不完全相同显示「混搭」，全相同显示「统一」。
- 按成员模型行的 `catModelRow(cat)` 在成员名旁渲染 `.cat-model-badge`：
  有 `llmModel` 显示模型名，没有显示「跟随全局：<全局模型>」。
- `profileMatchesCurrent(profile)` 同时比较模型和温度；手动保存模型后
  `applyUpdatedCat()` 会重渲染 `renderCatModelList()` 和 `renderModelProfiles()`，
  从而更新「当前配置已偏离」。
- 404/503 时分区显示「模型档案服务未就绪」和重试；按成员手动模型配置仍可用。

### 4.8 房间忙提示与 Needs Me

- **房间忙提示**：`updateRoomBusyNotice()` 找当前房间最后一个 `status !== "done"` 的任务；
  有则显示 `#room-busy`，文案
  「「<任务标题前 20 字>」还在进行中，你说的话会当成它的补充。」。
  点击 `data-action="room-busy-ack"` 设置 `app.forceNextMessage = true`，
  下一条消息作为补充发送，不再提醒。
- **Needs Me**：`roomPendingApprovalCount()` 统计当前房间的 pending 工具调用（优先 state，回退
  `/api/approvals`）；`updateNeedsMe()` 控制所有 `[data-needs-me]` 节点和
  `[data-needs-count]`，有 pending 时 `document.title` 前加 `(N) `。
  `focusNeedsMe()` 找到 `.tool-card[data-status="pending"]`，滚动并聚焦批准按钮。
- 两者都在 `renderAll()` / `startTicker()` 的调用链里更新；`#jump-latest` 的 pending
  分支见 4.1。

---

## 5. 请求与错误处理

- 所有 API 都走同源 `fetch`，统一 `cache: "no-store"`；JSON 错误通过
  `describeHttpError(response, label)` / `readApiError(response)` 转成中文提示。
- 404/503 表示该能力未启用（旧服务端或测试服务关闭）：前端在对应面板内显示
  「未就绪/未启用」，而不是抛到全局。
- toast 由 `toast(message, tone)` 写入 `#toast-stack`，2.8s 后淡出。
- 断线：`connectEvents().onerror` 把 `app.conn` 设为 `offline`，
  `paintChrome()` 更新连接胶囊并显示 `#conn-banner`；EventSource 自动重连，
  `onopen` 时补拉 `/api/state`。

---

## 6. 事件委托：`data-action` 模式

### 6.1 工作方式

`bindUi()` 只注册少量全局监听：

- `document.addEventListener("click", onGlobalClick)`；
- `document.addEventListener("keydown", onGlobalKeydown)`；
- 输入框、mention 补全、composer submit、各 `<dialog>` 的关闭/backdrop 在 `bindUi()`
  里单独绑定。

`onGlobalClick(event)`：

1. `target.closest("[data-action]")` 找到动作元素；
2. 读取 `actionEl.dataset.action` 和需要的 `data-*`（如 `data-task-id`、`data-cat-id`、
   `data-tool-call-id`、`data-profile-id`）；
3. 进入 `switch (action)` 分发到具体函数。

这意味着所有可点击控件只要写上 `data-action="..."` 和对应的 `data-*`，就会被统一接管；
动态生成的节点不需要逐个 `addEventListener`。

### 6.2 加一个新动作要改哪几处

1. **渲染节点**：在对应渲染函数里加 `data-action="my-action"`，把参数放到
   `data-*`（例如 `data-task-id`）；
2. **分发**：在 `onGlobalClick()` 的 `switch (action)` 加 `case "my-action":`，
   调用处理函数；
3. **处理函数**：在 `app.js` 内新增 async/sync 函数，负责请求、错误状态、toast；
4. **状态与重渲染**：更新 `app` 或局部状态对象（如 `testCenterState`、`traceState`），
   调用对应渲染函数（如 `renderTasks()`、`renderTimeline()`、`renderModelProfiles()`）；
   若涉及服务端状态，等 SSE/`refreshState()` 回来再更新；
5. **非 click 交互**（表单 submit、input、dialog close、backdrop）：在 `bindUi()` 对应节点上绑定，
   不要塞进 click 分支；
6. **DOM 引用**：固定节点在 `cacheDom()` 里加入 `els`，避免每次 `querySelector`。

### 6.3 约定

- 参数统一走 `data-*`，不要用闭包捕获可变状态后长期挂在全局；
- 异步动作要有进行中/失败状态（按钮 disabled、卡片错误区、`toast`），不要静默失败；
- 动作元素可以是 `<button>`，也可以是有 `data-action` 的容器；键盘可达性优先用 `<button>`。

---

## 7. 移动端

- 断点：`@media (max-width: 860px)`；更窄的 430px 断点在
  `@media (max-width: 430px)` 里做进一步压缩。
- `isCompactViewport()` 使用 `matchMedia("(max-width: 860px)")` 判断；
  `setTab(tab)` 只接受 `TAB_IDS = ["chat", "cats", "work"]`，切换 `body.dataset.tab`
  和 `.tabbar` 的 `aria-current`。
- 移动端 `.tabbar` 固定底部，三栏互斥显示：
  `body[data-tab="chat"] .panel--chat`、`body[data-tab="cats"] .panel--left`、
  `body[data-tab="work"] .panel--work`。高度用 `100dvh`，底部留 `var(--tabbar-h)` 和
  `env(safe-area-inset-bottom)`。
- 全屏/抽屉式对话框：
  - 测试中心 `.test-center-modal` 桌面是右侧 760px 抽屉，移动端 `width: 100vw` 全屏；
  - 任务轨迹 `.modal--trace` 移动端 `width: 100vw`，`.trace-card` 高 `100dvh`；
  - 设置、新任务等 `.modal` 在窄屏下按自身 CSS 收缩，内容区可滚动。
- 触摸/动画：`prefersReducedMotion()` 决定 `scrollToBottom` 是否平滑；发送按钮、
  弹窗关闭、底部 tab 都是原生 button/触摸区域。
- 回归检查：390px 宽度下无横向溢出；聊天输入框可见；抽屉/对话框可滚动；console 无 JS 错误。

---

## 8. 已知限制

1. **`app.js` 是单文件**（约 1 万行）：状态、渲染、请求、事件都在一起；改一处要全局搜
   同名选择器/函数，长期维护成本高于按 feature 拆模块。
2. **没有构建**：没有 TypeScript 类型检查（`tsc --noEmit` 只覆盖 `src/`）、没有 tree shaking/
   minify、没有 HMR；改完刷新页面是主要反馈方式。
3. **选择器是字符串契约**：`querySelector` / `data-action` / `data-role` 写错不会在构建期报错，
   只能靠浏览器 console 和端到端测试发现。
4. **全量快照**：每次 SSE 都传整个 `state`；本地单用户够用，但不适合多用户/大规模数据。
5. **timeline 没有虚拟滚动**：消息会一直留在 DOM；超长会话需要刷新或分房间。
6. **无乐观更新**：消息/任务/工具状态都等服务端快照；网络慢时按钮会等待而不是先改 UI。
7. **可访问性只覆盖关键路径**：timeline 是 `role="log"`，草稿是 `role="status"`，
   弹窗用原生 `<dialog>`；但复杂时间线、拖拽等没有完整键盘模型。
8. **无 i18n**：界面文案是中文硬编码。
9. **浏览器要求**：原生 ESM、`<dialog>`、`EventSource`、CSS `dvh` / `env()` 的现代浏览器；
   没有为旧浏览器做 polyfill。
10. **零外网资源**：字体/头像/图标都由系统字体或本地 SVG 提供，视觉在不同 OS 上会有差异；
    这是离线可用的代价。

---

## 9. 调试提示

- 页面暴露 `window.catCafe`：
  - `window.catCafe.state` 当前 `StudioState`；
  - `window.catCafe.seq` 最后处理的 seq；
  - `window.catCafe.connection` 连接状态。
- 看 `[data-seq]` 是否在增长，可判断 SSE 是否活着；断线时 `#conn-banner` 会出现。
- 所有动作都可以在 DevTools 里搜 `data-action="..."` 找到渲染处，再在 `onGlobalClick()`
  搜同一个字符串找到处理分支。
- 样式入口在 `public/styles.css` 顶部变量区（`--cream` / `--ink` / `--caramel` /
  `--danger` 等）；移动端规则集中在文件末尾的 `@media` 块。
