# HTTP API 参考

协作交付台的 HTTP 层是「REST + SSE + 静态资源」：所有状态变更都经由 `Studio` / `Driver`，HTTP 只做校验和转发。
本文按 `src/server/http.ts` 的实际实现整理，路径、方法、错误码都以代码为准。

- Base URL：`http://127.0.0.1:4318`（`PORT` 可覆盖）
- 请求 / 响应：`application/json; charset=utf-8`（SSE 为 `text/event-stream`）
- **没有鉴权**：定位是本地单人工具，不要直接暴露到公网。
- 请求体上限 **64 KB**；多个文本字段上限 **2000 字符**。
- 资源创建成功返回 `201`；交给 driver 异步处理的动作用 `202`；其余成功用 `200`。
- 部分子系统是可选的（设置 / 审批 / 工作区 / MCP / 测试中心），未注入时对应接口返回 **503**。

> 类型定义以 [data-model.md](data-model.md) 为准，本文只列接口形状。

---

## 端点总览

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/health` | 健康检查 + 运行模式 / 卡住阈值 |
| GET | `/api/state` | 拉取全量 `StudioState` 快照 |
| GET | `/api/events` | SSE：状态全量快照流 |
| POST | `/api/reset` | 重置交付台（清空消息/任务/产物/记忆等） |
| GET / PUT | `/api/settings` | 读取 / 修改运行时设置 |
| POST | `/api/settings/test` | 测试 LLM 连接 |
| GET | `/api/cats` | 成员名册 |
| PUT | `/api/cats/:id` | 修改单个成员的档案 / 模型 / 工具 / 技能 |
| POST | `/api/rooms` | 新建房间（绑定工作区） |
| PATCH | `/api/rooms/:id` | 改房间名 / 主题 / 工作区 |
| PUT | `/api/rooms/:id` | 绑定 / 切换房间的工作区 |
| DELETE | `/api/rooms/:id` | 删除房间（级联清理该房间的任务等） |
| POST | `/api/rooms/:id/messages` | 负责人发消息 |
| POST | `/api/tasks` | 创建任务并开工 |
| GET | `/api/tasks/:id/trace` | 任务轨迹（时间线 + 汇总） |
| GET | `/api/tasks/:id/diff` | 任务分支 / 工作树 diff（git） |
| POST | `/api/tasks/:id/commit` | 确认提交任务改动 |
| POST | `/api/tasks/:id/rollback` | 回滚任务改动（stash 可恢复） |
| POST | `/api/tasks/:id/action` | 卡住 / 强制收尾后的三选一 |
| POST | `/api/tasks/:id/nudge` | 催一下 |
| GET | `/api/approvals` | 待审批工具调用列表 |
| POST | `/api/tool-calls/:id/approve` | 批准工具调用 |
| POST | `/api/tool-calls/:id/reject` | 拒绝工具调用 |
| POST | `/api/patrol` | 手动触发一次主动巡查 |
| GET | `/api/tools` | 工具目录（内置 + MCP） |
| GET | `/api/skills` | 技能包目录 |
| GET / POST | `/api/scenarios` | 剧本列表 / 导入自定义剧本 |
| DELETE | `/api/scenarios/:id` | 删除自定义剧本 |
| GET / POST | `/api/mcp` | MCP server 列表 / 添加 |
| PUT / DELETE | `/api/mcp/:id` | 更新 / 删除 MCP server |
| POST | `/api/mcp/:id/test` | 临时连接测试（不注册工具） |
| POST | `/api/mcp/:id/toggle` | 启用 / 停用 MCP server |
| GET / POST | `/api/workspaces` | 工作区列表 / 添加工作区 |
| GET / DELETE | `/api/workspaces/:id` | 工作区详情 / 删除 |
| GET | `/api/workspaces/:id/files` | 工作区文件列表 |
| GET | `/api/workspaces/:id/file?path=` | 读取工作区文件 |
| GET | `/api/workspaces/:id/git` | git 状态（只读） |
| GET | `/api/workspaces/:id/git/diff` | git diff（只读） |
| GET | `/api/workspace/tree` | 默认沙盒文件列表（旧接口） |
| GET | `/api/workspace/file?path=` | 默认沙盒读文件（旧接口） |
| POST | `/api/workspace/reset` | 重置默认沙盒（旧接口） |
| POST | `/api/tests/run` | 启动测试（unit / real / scenario） |
| GET | `/api/tests/runs` | 测试历史列表（无日志正文） |
| GET / DELETE | `/api/tests/runs/:id` | 测试详情（含日志）/ 取消运行中的测试 |
| GET | `/api/tests/stream` | SSE：测试日志流 |
| GET | `/api/model-profiles` | 模型分工推荐档案 |
| POST | `/api/model-profiles/apply` | 应用某套模型档案 |
| GET | `/` 等 | 静态前端（`public/`） |

> **注意**：没有 `GET /api/rooms`、`GET /api/tasks`、`GET /api/rooms/:id/messages`。
> 房间、任务、消息、交接、产物、记忆都在 `GET /api/state` 的全量快照里；前端靠 SSE 增量刷新。

---

## 1. 健康、状态与实时推送

### `GET /api/health`

健康检查 + 前端需要的运行参数。

```json
{
  "ok": true,
  "mode": "llm",
  "configured": true,
  "model": "deepseek-v4.1-flash",
  "engine": "api",
  "seq": 41,
  "stallMs": 12000,
  "settings": true
}
```

| 字段 | 说明 |
|---|---|
| `mode` | 恒为 `llm`（产品只有真实模式，字段保留兼容） |
| `configured` | 模型是否已配好（Base URL + 模型名）。**未配置时派活会被 412 拦下** |
| `model` / `engine` | 当前模型名与引擎（`api` / `cli`） |
| `seq` | 当前状态版本号，与 SSE 的 `seq` 对齐 |
| `stallMs` | 「卡住」判定阈值（默认 12000） |
| `settings` | 设置子系统是否启用 |

无错误分支。

### `GET /api/state`

返回完整 `StudioState`（结构见 [data-model.md](data-model.md)）。前端首次加载、SSE 断线兜底都用它。

```json
{
  "rooms": [{ "id": "room_cafe", "name": "交付台 · 主工作区", "workspaceId": "ws_sandbox" }],
  "cats": [],
  "messages": [],
  "tasks": [],
  "handoffs": [],
  "artifacts": [],
  "memory": [],
  "catSessions": {},
  "toolCalls": [],
  "llmCalls": [],
  "typing": { "room_cafe": null },
  "drafts": {},
  "seq": 41,
  "mode": "llm",
  "startedAt": 1792420785923
}
```

### `GET /api/events`（SSE）

实时状态流。连接时先推一次全量快照，之后状态变化时推**全量**快照
（状态小，换取前端零同步 bug），但同一时间窗内的多次变化会**合并成一帧**。

```
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no

retry: 3000

data: {"seq":41,"state":{...}}

data: {"seq":42,"state":{...}}

: ping
```

- 事件格式：`data: {"seq": number, "state": StudioState}`。
- **首帧立即推送**；之后的变更合并到每 **120ms 最多一帧**，且只发最新状态。
  这样长任务里一条消息链触发的几十次 `notify` 不会变成几十帧 1.8MB 的流量。
- `seq` 单调递增（始终是最新状态的 seq），前端可用它去重 / 判断是否丢包；
  合并意味着**中间 seq 可能被跳过**，不要假设连续。
- 每 **15 秒**发一条注释心跳 `: ping`；`retry: 3000` 建议浏览器 3 秒后重连。
- 重连后服务端会再推一次全量快照；前端也可以主动 `GET /api/state` 校准。
- 该接口不会主动报错，连接断开由客户端重连处理。

### `POST /api/reset`

重置交付台：清空消息、任务、交接、产物、共享记忆、按成员会话、工具/模型调用记录，并重新播放入房问候。
**保留**房间、成员档案与沙盒文件。

```json
{ "ok": true, "seq": 44 }
```

沙盒单独重置用 `POST /api/workspace/reset`（或设置里的「重置沙盒」）。
无错误分支。

---

## 2. 设置

### `GET /api/settings`

```json
{
  "mode": "llm",
  "configured": true,
  "speed": "normal",
  "llm": {
    "baseUrl": "https://api.example.com/v1",
    "model": "some-model",
    "temperature": 0.8,
    "hasKey": true,
    "headerNames": ["x-opencode-session"],
    "keySource": "env"
  },
  "stallMs": 12000,
  "toolsEnabled": true,
  "toolApproval": "commands",
  "streaming": true,
  "proactive": "off",
  "proactiveIntervalMs": 60000,
  "engine": "api",
  "port": 4318,
  "dataDir": "data",
  "version": "0.1.0",
  "node": "v26.8.2",
  "startedAt": 1792420785923,
  "envDefaults": false
}
```

- 绝不返回 API Key / headers 的值，只给 `hasKey`、`keySource`。
- 503：`{"error":"settings api not enabled"}`。

### `PUT /api/settings`

修改运行设置。`llm.headers` 可以传额外请求头（例如 opencode zen 的
`x-opencode-session`）：会随 `settings.json` 落盘（0600），但**值不回传前端**——
`GET /api/settings` 只返回 `headerNames`；传 `null` 或空对象清空。API key 仍只在内存。


请求体为 `SettingsPatch`，只传要改的字段：

```json
{
  "mode": "llm",
  "speed": "fast",
  "toolsEnabled": true,
  "toolApproval": "all",
  "streaming": true,
  "engine": "api",
  "proactive": "watch",
  "proactiveIntervalMs": 60000,
  "llm": {
    "baseUrl": "https://api.example.com/v1",
    "model": "some-model",
    "temperature": 0.7,
    "apiKey": "sk-...",
    "clearKey": false
  }
}
```

- `llm.apiKey` 留空表示不修改；`clearKey: true` 清空内存里的 key。
- 成功返回更新后的 `PublicSettings`（同 GET）。
- 主动协作字段变化时，服务端会同步启停 driver 的巡查。
- 错误：`400 {"error": "..."}`（字段校验失败 / 真实模式缺配置）、`405`、`503`。

### `POST /api/settings/test`

用给定配置探测 LLM 连接，**不会保存**。

```json
{ "baseUrl": "https://api.example.com/v1", "model": "some-model", "apiKey": "sk-..." }
```

```json
{ "ok": true, "latencyMs": 412, "detail": "200 OK" }
```

失败时同样返回 200，`ok:false`、`detail` 带原因。
错误：`400`（`baseUrl` / `model` 缺失）、`503`。

---

## 3. 成员

### `GET /api/cats`

返回在职成员与已移除成员（后者只用于历史渲染，不参与协作）：

```json
{
  "cats": [ { "id": "linzhiyuan", "name": "林知远", "role": "architect", "...": "..." } ],
  "retired": []
}
```

> 成员数量不写死：可以自由增删成员，成员数量由 `cats` 决定，房间的 `catIds`
> 会跟着更新。完整名册也随 `GET /api/state` 返回（`cats` / `retiredCats`）。

### `POST /api/cats`

新增成员。角色只能发生在四种之一：

```json
{ "name": "小满", "role": "implementer", "persona": "（可选）干活快，不爱废话" }
```

```json
{
  "id": "cat_xxx",
  "name": "小满",
  "role": "implementer",
  "discipline": "实现",
  "title": "实现 · 编码与自测",
  "avatar": "implementer",
  "...": "..."
}
```

- `name` 1–8 字且不能与在职成员重名；`role` 必填。
- **约束**：`architect` / `reviewer` 各最多一个（引擎的阶段机按角色找人）；
  `designer` / `implementer` 可以有任意多个。
- 新成员自动加入所有房间。
- 错误：`400` + 可读原因（如「已经有一个架构师了（林知远）」）。

### `DELETE /api/cats/:id`

移除成员：进 `retiredCats` 存档（历史消息仍能显示名字），退出所有房间，
清掉它的成员会话。返回 `{ "ok": true, "retired": Member }`。

- **拒绝的情况**（`400`）：名册角色不齐（会没有架构师 / 评审 / 干活的人）；
  该成员手上还有未结束的任务。
- 不存在返回 `404`。

### `PUT /api/cats/:id`

修改单个成员的档案、模型、工具与技能。所有字段可选，至少传一个：

```json
{
  "name": "林知远",
  "title": "主架构师 / 架构师",
  "persona": "稳，先问为什么……",
  "catchphrase": "我先说结论，再拆。",
  "greeting": "我先把需求接住。",
  "accent": "#7C9EB2",
  "llmModel": "some-model",
  "llmTemperature": 0.6,
  "tools": ["read_file", "list_files"],
  "skills": ["architecture"]
}
```

- `llmModel` / `llmTemperature` 传 `null` 表示清除覆盖、跟随全局。
- `tools` / `skills` 传 `null` 表示恢复默认；`tools: []` 表示**一个工具都不给**。
- 成功返回更新后的 `Cat`。
- 错误：`400`（字段类型 / 名字重复 / 颜色格式 / 温度越界）、`404`（成员不存在）。

---

## 4. 房间

> 新建房间需要工作区子系统。没有 `GET /api/rooms`，列表在 `/api/state`。

### `POST /api/rooms`

```json
{ "name": "前端仓库 · 只读", "workspaceId": "ws_xxx", "topic": "这个房间用来做什么（可选）" }
```

- `workspaceId` **必填**：漏传返回 `400`「workspaceId 必填」；传了查不到返回
  `400`「workspaceId 不存在：<id>」。

返回 `201` + `Room`：

```json
{
  "id": "room_xxx",
  "name": "前端仓库 · 只读",
  "topic": "这个房间用来做什么（可选）",
  "catIds": ["xianxian", "yanyan", "shuoshuo", "jinjianceng"],
  "workspaceId": "ws_xxx",
  "createdAt": 1792420785923
}
```

- `name` 1–30 字且不能与现有房间重名；`workspaceId` 必须存在。
- 错误：`400`（校验失败）、`503`（工作区子系统未启用）。

### `PATCH /api/rooms/:id`

只改传入的字段：`{ "name"?, "topic"?, "workspaceId"? }`。
返回 `Room`。错误：`400`（重名 / 长度 / 空 patch）、`404`、`503`（改 `workspaceId` 时）。

### `PUT /api/rooms/:id`

绑定 / 切换房间的工作区：`{ "workspaceId": "ws_xxx" }`，返回 `Room`。
错误：`400`（工作区不存在）、`404`（房间不存在）、`503`。

### `DELETE /api/rooms/:id`

```json
{
  "ok": true,
  "removed": { "tasks": 2, "messages": 37, "handoffs": 5, "artifacts": 6, "toolCalls": 9 }
}
```

- 不允许删除最后一个房间；有进行中 / 卡住任务时也拒绝。
- 错误：`400`（这两种情况）、`404`。

### `POST /api/rooms/:id/messages`

负责人发消息。会立刻落库，再交给 driver 决定谁来接话。

```json
{ "text": "@沈砚 帮我看下这个 token 方案", "force": false }
```

返回 `201` + 落库的 `Message`：

```json
{
  "id": "msg_xxx",
  "roomId": "room_cafe",
  "author": "user",
  "kind": "chat",
  "text": "@沈砚 帮我看下这个 token 方案",
  "mentions": ["yanyan"],
  "at": 1792420785923
}
```

- `text` 1–2000 字；`@名字` / `@catId` 会被解析进 `mentions`。
- 房间有活跃任务且 `force` 不为 `true` 时，服务端会追加一条系统提醒（同一房间一次只做一件事）；
  `force: true` 表示「我确认这是补充」，跳过提醒。
- 错误：`400`（文本为空 / 超长）。

---

## 5. 任务与协作控制

### `GET /api/tasks?q=关键词`

跨房间的任务总览。左栏任务列表只显示当前房间的任务，这个接口用于「我记得做过一个
CSV 的任务，但忘了在哪个房间」这类检索。

- `q` 可选：同时匹配任务标题和需求原文（`brief`），大小写不敏感；空白视为不筛选。
- 按 `createdAt` 倒序返回。
- 每条任务额外带 `roomName`，便于跨房间辨认。

```json
{
  "tasks": [
    {
      "id": "task_xxx",
      "roomId": "room_cafe",
      "roomName": "交付台 · 主工作区",
      "title": "导出 CSV 时中文乱码，加 UTF-8 BOM",
      "status": "done",
      "stage": "done"
    }
  ]
}
```

### `POST /api/tasks`

创建任务并立刻开工：落一条用户消息 → `task_created` 交给 driver。

```json
{
  "roomId": "room_cafe",
  "brief": "给登录页加一个「记住我」勾选框，7 天内免登录。",
  "scenarioId": "remember_me"
}
```

- `roomId` 缺省为 `room_cafe`；`brief` 4–2000 字。
- `scenarioId` 省略或不存在时，按需求关键词自动匹配剧本。
- **未配置模型时**：返回 `412 { "error": "...", "code": "llm_unconfigured" }`——不会建出一个假装在干活的任务。
- `scenarioId` 只作历史标识（内置剧本是示例素材），真实任务由模型按需求原文处理。
- 如果房间绑定的是**读写 git 工作区**且开启任务分支，会先创建 `deliverylab/<taskId>` 分支（失败只记录提示，不阻塞任务）。
- 返回 `201` + `Task`（结构见 data-model）。
- 错误：`400`（`brief` 长度不合法）；`roomId` 不存在时返回 `404`。

### `GET /api/tasks/:id/trace`

任务轨迹：把所有与该任务相关的事件按时间拼起来，并给一份汇总。

```json
{
  "task": { "id": "task_xxx", "title": "…", "stage": "done" },
  "entries": [
    { "at": 1792420786000, "kind": "stage", "actor": "linzhiyuan", "actorName": "林知远", "detail": "进入阶段 intake", "meta": { "stage": "intake" } },
    { "at": 1792420786100, "kind": "llm", "actor": "linzhiyuan", "actorName": "林知远", "detail": "some-model · 10063ms · in 2378/out 905", "meta": { "id": "msg_abc", "stage": "intake", "trigger": "task_created", "engine": "api", "streamed": true, "degraded": false, "durationMs": 10063 } },
    { "at": 1792420786500, "kind": "artifact", "actor": "jinjianceng", "actorName": "陈实", "detail": "patch「后台导出 CSV 实现 v1」v1", "meta": { "artifactId": "art_xyz", "version": 1, "stage": "working", "llmCallId": "msg_abc", "trigger": "handoff" } },
    { "at": 1792420787000, "kind": "tool", "actor": "jinjianceng", "actorName": "陈实", "detail": "run_command error (exit 1)", "meta": { "label": "跑测试", "durationMs": 97 } }
  ],
  "summary": {
    "durationMs": 1216000,
    "llmCalls": 46,
    "llmDurationMs": 532000,
    "inputTokens": 322850,
    "outputTokens": 52547,
    "degradations": 5,
    "retries": 2,
    "toolCalls": 80,
    "rejected": 0,
    "approvalWaitMs": 0,
    "handoffs": 17,
    "artifacts": 14
  }
}
```

`entries[].kind` 可能是 `stage` / 消息的 kind（`chat` / `handoff` / `review` / `decision` / `artifact` / `tool` / `system`）/ `handoff` / `artifact` / `tool` / `llm` / `memory`。

**产物溯源**：`artifact` 条目的 `meta.llmCallId` 对应某个 `llm` 条目的 `meta.id`，
前端据此从产物跳回产生它的那次模型调用（老数据可能没有 `llmCallId`）。

**区分消息与产物**：`kind` 同为 `artifact` 的条目有两种来源——消息条目带
`meta.messageId`，真产物条目带 `meta.artifactId`（另有 `version / stage / llmCallId`）。
错误：`404`（任务不存在）。

### `GET /api/tasks/:id/diff`

只读查看任务分支或工作树的 diff（git 工作区）。

```json
{ "ok": true, "branch": "deliverylab/task_xxx", "base": "main", "status": " M src/a.js", "diff": "diff --git ..." }
```

错误：`400`（任务所在房间没有工作区）、`404`、`503`。

### `POST /api/tasks/:id/commit`

把任务改动提交到任务分支（不会自动合并 / push）。必须显式确认：

```json
{ "confirm": true, "message": "feat: 记住我" }
```

```json
{ "ok": true, "commit": "a1b2c3d", "task": { "id": "task_xxx", "git": { "commit": "a1b2c3d", "committedAt": 1792420900000 } } }
```

**敏感文件保护**：提交前会把 `.env`、`id_rsa*`、`*.pem`、`secrets.*`、`.npmrc` 等
从暂存区撤下（文件仍留在工作区），只提交其余改动。被挡下的路径通过 `skipped` 返回：

```json
{ "ok": true, "commit": "a1b2c3d", "skipped": [".env", "id_rsa"], "task": {...} }
```

错误：`400`（未确认 / 提交失败）、`404`、`503`。

### `POST /api/tasks/:id/rollback`

回滚任务改动：改动收进 `git stash`（可恢复），并切回 base 分支。同样需要确认：

```json
{ "confirm": true }
```

```json
{ "ok": true, "note": "已切回 main，改动已 stash", "stash": "stash@{0}", "task": { "id": "task_xxx", "git": { "stashedAt": 1792420900000 } } }
```

错误：`400`（未确认 / 回滚失败）、`404`、`503`。

### `POST /api/tasks/:id/merge`

把任务分支合并回 base 分支（收尾最后一步）。需要显式确认：

```json
{ "confirm": true }
```

```json
{ "ok": true, "merged": "f1e2d3c", "task": { "id": "task_xxx", "git": { "mergeCommit": "f1e2d3c", "mergedAt": 1792420900000 } } }
```

- 前提：任务已提交（`git.commit` 存在）、工作树干净、有独立任务分支。
- 用 `--no-ff` 合并，保留一条合并提交，历史上看得出「这个任务是一个整体」。
- **不自动 push，也不删任务分支**——合并只发生在本地 base 分支上。
- 冲突时返回 `400 { error, conflicts }`，并且已经 `merge --abort`：仓库不会留半成品现场，
  负责人解决冲突后再点一次即可。
- 重复合并返回 `200` + `note`「无需重复合并」，不会产生空提交。

### `POST /api/tasks/:id/action`

任务是「卡住」或「被强制收尾」时，负责人的三选一：

```json
{ "action": "continue", "note": "再试一次（可选，pivot/close 时建议写）" }
```

| action | 含义 |
|---|---|
| `continue` | 继续试试，再给一次机会 |
| `pivot` | 换个方案，继续任务（`note` 会带新方向） |
| `close` | 收尾，记录原因并写 `manual-close` 教训（不可撤销） |

返回 `202 {"ok":true,"action":"continue"}`（异步交给 driver）。
错误：`400`（`action` 只能是三个值之一）、`404`。

### `POST /api/tasks/:id/nudge`

催一下：唤醒林知远检查卡点、补投漏掉的交接。返回 `202 {"ok":true}`。
错误：`404`。

---

## 6. 审批与巡查

### `GET /api/approvals`

```json
{
  "pending": [
    {
      "callId": "tool_xxx",
      "catId": "jinjianceng",
      "tool": "run_command",
      "label": "运行 npm test",
      "mode": "commands",
      "requestedAt": 1792420800000
    }
  ]
}
```

错误：`503`（审批子系统未启用）。

### `POST /api/tool-calls/:id/approve` / `POST /api/tool-calls/:id/reject`

```json
{ "remember": false }
```

```json
{ "ok": true, "decision": "approved", "remembered": false }
```

- `decision` 分别为 `approved` / `rejected`。
- `remember: true` 表示同一个成员 + 同一工具本进程内后续不再询问。
- 错误：`404`（没有等待中的审批 / 已处理过）、`503`。

### `POST /api/patrol`

手动触发一次主动巡查（「现在就看一眼」）。返回 `200 {"ok":true}`，不等巡查执行完——需要等待时看 SSE / 状态。

---

## 7. 工具、技能与剧本

### `GET /api/tools`

```json
{
  "tools": [
    {
      "name": "run_command",
      "title": "运行命令",
      "description": "在沙盒根目录运行 node / npm 命令……",
      "inputSchema": { "type": "object", "properties": { "cmd": { "type": "string" } }, "required": ["cmd"] },
      "risk": "needs_approval",
      "source": "sandbox"
    }
  ]
}
```

MCP 工具的 `source` 为 `"mcp"`，并带 `serverId`。没有注册表时返回空数组（不报 503）。

### `GET /api/skills`

```json
{
  "skills": [
    { "id": "tdd", "name": "TDD 纪律", "description": "先让测试失败，再改代码让它通过。", "prompt": "【技能：TDD 纪律】…" }
  ]
}
```

### `GET /api/scenarios`

```json
{
  "scenarios": [
    {
      "scenario": { "id": "remember_me", "name": "登录页 · 记住我", "sampleBrief": "…", "tags": ["…"], "beats": [] },
      "source": "builtin"
    }
  ]
}
```

### `POST /api/scenarios`

导入自定义剧本。请求体可以是 `{ "scenario": {…} }`，也可以直接是剧本对象：

```json
{
  "scenario": {
    "id": "my_scenario",
    "name": "我的剧本",
    "sampleBrief": "一句话示例需求",
    "tags": ["示例"],
    "beats": [
      { "stage": "intake", "cat": "xianxian", "turn": { "kind": "message", "text": "我先接住。" } }
    ]
  }
}
```

- 成功：`201 {"scenario": {...}, "source": "custom"}`。
- 失败：`400 {"error":"…","errors":["…"]}`（逐条校验错误）；
  剧本 id 已存在时 `409 {"error":"剧本 id … 已存在","errors":[...]}`。

### `DELETE /api/scenarios/:id`

成功 `200 {"ok":true}`。错误：`400`（内置剧本不能删除）、`404`。

---

## 8. MCP servers

### `GET /api/mcp`

```json
{
  "servers": [
    {
      "id": "memory",
      "name": "团队记事本",
      "transport": "stdio",
      "enabled": true,
      "status": "connected",
      "toolCount": 3,
      "command": "node",
      "args": ["examples/mcp/notes-server.mjs"],
      "risk": "needs_approval",
      "envKeys": [],
      "headerKeys": []
    }
  ]
}
```

`envKeys` / `headerKeys` 只给键名，绝不返回值。错误：`503`。

### `POST /api/mcp`

```json
{
  "name": "团队记事本",
  "transport": "stdio",
  "command": "node",
  "args": ["examples/mcp/notes-server.mjs"],
  "enabled": true,
  "risk": "needs_approval",
  "env": { "TOKEN": "…" },
  "headers": {}
}
```

http 传输则用 `"transport":"http"` + `"url":"https://…"`。
成功 `201 {"server": McpStatus}`；错误 `400`（校验失败 / id 冲突）、`503`。

### `PUT /api/mcp/:id`

局部更新：不传的字段保留；`env` / `headers` 传 `{}` 表示清空（不传则保留）。
成功 `200 {"server": …}`；错误 `400`、`404`、`503`。

### `DELETE /api/mcp/:id`

成功 `200 {"ok":true}`；错误 `404`、`503`。

### `POST /api/mcp/:id/test`

用临时连接测试配置（**不保存、不注册工具**）。请求体可以省略或局部覆盖——省略时用已保存的配置：

```json
{ "name": "测试用", "transport": "stdio", "command": "node", "args": ["…"] }
```

```json
{ "ok": true, "tools": [{ "name": "echo", "description": "回显" }] }
```

失败时 200 + `{"ok":false,"tools":[],"error":"…"}`。错误：`503`。

### `POST /api/mcp/:id/toggle`

```json
{ "enabled": false }
```

成功 `200 {"server": …}`；错误 `400`（非布尔）、`404`、`503`。

---

## 9. 工作区与沙盒

> 工作区 = 房间绑定的目录。内置沙盒可读写；真实仓库默认只读，切读写需要显式确认。

### `GET /api/workspaces`

```json
{
  "workspaces": [
    {
      "id": "ws_sandbox",
      "name": "内置沙盒",
      "root": "/…/data/workspace",
      "policy": "read-write",
      "kind": "sandbox",
      "isGit": false,
      "branchPerTask": false,
      "createdAt": 0,
      "roomCount": 1,
      "bound": true
    }
  ]
}
```

错误：`503`。

### `POST /api/workspaces`

```json
{
  "name": "我的前端仓库",
  "path": "/Users/you/project",
  "policy": "read-only",
  "branchPerTask": true,
  "confirm": false
}
```

- `path` 必须是存在的绝对路径；不能是交付台自己的数据目录；同一目录不能重复添加。
- `policy: "read-write"` 时必须同时传 `confirm: true`。
- `branchPerTask` 缺省为 `true`（仅读写 git 仓库会真正建分支）。
- 成功 `201 {"workspace": Workspace}`；错误 `400`、`503`。

### `GET /api/workspaces/:id`

成功 `200 {"workspace": Workspace}`；错误 `404`、`503`。

### `GET /api/workspaces/:id/files`

```json
{ "files": [{ "path": "src/remember.js", "size": 374 }] }
```

错误：`404`、`503`。

### `GET /api/workspaces/:id/file?path=src/remember.js`

```json
{ "path": "src/remember.js", "content": "// …" }
```

错误：`400`（路径越界 / 文件读不到）、`404`、`503`。

### `GET /api/workspaces/:id/git`

```json
{
  "workspaceId": "ws_xxx",
  "isGit": true,
  "branch": "main",
  "clean": false,
  "status": " M src/a.js",
  "diffStat": " src/a.js | 2 +-",
  "lastCommit": "a1b2c3d feat: …"
}
```

非 git 目录返回 `{"workspaceId":"…","isGit":false}`。错误：`404`（工作区不存在）、`503`。

### `GET /api/workspaces/:id/git/diff`

```json
{ "ok": true, "diff": "diff --git a/src/a.js b/src/a.js\n…" }
```

失败时 200 + `{"ok":false,"diff":"","error":"…"}`。错误：`404`（工作区不存在）、`503`。

### `DELETE /api/workspaces/:id`

成功 `200 {"ok":true}`。错误：`400`（内置沙盒不能删 / 还有房间绑定）、`404`、`503`。

### 旧接口：默认沙盒

用于「内置沙盒」的快捷操作（不需要指定 workspaceId）：

| 方法 | 路径 | 成功响应 | 错误 |
|---|---|---|---|
| GET | `/api/workspace/tree` | `{"root":"…","files":[{"path","size"}]}` | `503` |
| GET | `/api/workspace/file?path=` | `{"path","content"}` | `400`、`503` |
| POST | `/api/workspace/reset` | `{"ok":true}` | `503` |

---

## 10. 测试中心

### `POST /api/tests/run`

```json
{ "kind": "unit" }
```

| kind | 跑什么 |
|---|---|
| `unit` | 仓库单元测试（`node --test tests/`） |
| `real` | 真实模型矩阵（需要已配置真实模型） |
| `scenario` | 单个真实模型场景，配合 `scenario` 字段（如 `basic` / `reject` / `nudge` / `rooms` / `concurrent` / `invalid` / `permission` / `memory` / `notools`） |

成功 `202`：

```json
{ "runId": "tst_xxx", "kind": "unit", "startedAt": 1792420800000 }
```

错误：`400`（kind 非法 / 真实模型未配置 / 未知场景）、`409`（同类测试已在跑）、`503`。

### `GET /api/tests/runs`

```json
{
  "runs": [
    {
      "id": "tst_xxx",
      "kind": "unit",
      "status": "passed",
      "startedAt": 1792420800000,
      "finishedAt": 1792420840000,
      "exitCode": 0,
      "summary": { "tests": 218, "pass": 218, "fail": 0 },
      "lineCount": 314
    }
  ]
}
```

列表**不返回日志正文**，只有 `lineCount`。错误：`503`。

### `GET /api/tests/runs/:id`

返回完整 `TestRun`，含 `lines: [{ at, stream: "stdout"|"stderr", text }]`（最多保留 2000 行）。
错误：`404`、`503`。

### `DELETE /api/tests/runs/:id`

取消运行中的测试。成功 `200 {"ok":true}`；不在运行中返回 `409 {"error":"该测试不在运行中"}`；错误：`404`、`503`。

### `GET /api/tests/stream`（SSE）

测试日志流，事件对象：

```json
{ "runId": "tst_xxx", "event": "start" }
{ "runId": "tst_xxx", "line": "✔ 某个测试", "stream": "stdout", "at": 1792420801000 }
{ "runId": "tst_xxx", "event": "exit", "code": 0 }
```

- 连接响应同样带 `retry: 3000` 和 15 秒心跳。
- 错误：`503`。

---

## 11. 模型档案

### `GET /api/model-profiles`

```json
{
  "profiles": [
    {
      "id": "opencode-mixed",
      "name": "opencode · 混搭",
      "description": "…",
      "endpoint": "opencode.ai/zen/go",
      "assignments": [
        { "catId": "xianxian", "model": "deepseek-v4.1-flash", "temperature": 0.6, "reason": "主架构师，推理链长但稳" }
      ]
    }
  ],
  "suggested": "single-model"
}
```

`suggested` 根据当前 `llm.baseUrl` 推断。

### `POST /api/model-profiles/apply`

```json
{ "id": "opencode-mixed" }
```

```json
{ "ok": true, "profile": "opencode-mixed", "cats": [{ "catId": "xianxian", "model": "deepseek-v4.1-flash" }] }
```

`single-model` 会清掉所有成员的模型覆盖。错误：`400`（未知档案）。

---

## 12. 静态资源

`GET /` 返回 `public/index.html`；其余 `GET` 走白名单扩展名（`.html` / `.js` / `.css` / `.svg` / `.png` / `.ico`），
带路径穿越防护（拒绝 `..`、绝对路径、越界路径）。

错误：`400`（bad path）、`404`（not found / index.html missing）、`405`（部分接口方法不允许）。

---

## SSE 事件流

### `/api/events`：状态流

| 项 | 说明 |
|---|---|
| Content-Type | `text/event-stream; charset=utf-8` |
| 首包 | 连接后立即推一次全量 `{seq,state}` |
| 后续 | 每次状态变更推一次全量快照（不是增量） |
| 心跳 | 每 15 秒一行注释 `: ping` |
| 重连 | 响应里 `retry: 3000`；重连后服务端会重推全量，前端也可 `GET /api/state` 校准 |
| 去重 | 用 `seq` 单调递增判断；小于等于已知 seq 的快照可丢弃 |

### `/api/tests/stream`：测试日志流

| 项 | 说明 |
|---|---|
| 首包 | 无（只推之后的测试事件） |
| 事件 | `{runId, event:"start"}`、`{runId, line, stream, at}`、`{runId, event:"exit", code}` |
| 心跳 | 每 15 秒 `: ping` |

---

## 错误响应格式

绝大多数错误是统一结构：

```json
{ "error": "人类可读的错误说明" }
```

剧本导入校验会额外带 `errors` 数组：

```json
{ "error": "第一条错误", "errors": ["beats[0].cat 必须是现有成员的 id", "…"] }
```

| 状态码 | 何时出现 |
|---|---|
| `400` | 请求体 / 字段校验失败、缺少显式确认、业务前置条件不满足 |
| `404` | 房间 / 任务 / 工作区 / MCP server / 剧本 / 测试记录不存在，或没有等待中的审批 |
| `405` | 路径匹配但方法不允许（如对 `/api/settings` 用 POST、对 `/api/mcp/:id` 用 PATCH） |
| `409` | 资源冲突：剧本 id 已存在、测试已在运行、测试不在运行中无法取消 |
| `500` | 未捕获异常 / 请求体过大 / 非法 JSON（`{"error":"request body too large"}` 等） |
| `503` | 可选子系统未启用（settings / approvals / workspaces / mcp / tests / sandbox） |

其它约定：

- 所有响应带 `Cache-Control: no-store`（SSE 为 `no-cache, no-transform`）。
- 没有 CORS 头、没有鉴权、没有 rate limit：**只适合本机 / 可信内网**，公网部署必须自己在反向代理上加鉴权。
- 时间戳都是毫秒（`Date.now()`）。
- id 前缀：`room_` / `msg_` / `task_` / `step_` / `ho_` / `art_` / `mem_` / `ws_` / `tst_`。
