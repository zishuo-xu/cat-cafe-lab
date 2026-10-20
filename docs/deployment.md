# 部署与运行

> 本文覆盖本地启动、环境变量、持久化、安全边界、远程访问、备份和常见排障。
> 环境变量以 `src/server/settings.ts` 为准；持久化行为以 `src/server/studio.ts` /
> `settings-store.ts` / `workspaces/manager.ts` / `mcp/manager.ts` /
> `agents/scenario-registry.ts` 为准。

---

## 1. 前置条件

- **Node.js >= 24**（`package.json` 的 `engines`；项目直接运行 `.ts`，依赖 Node 原生
  TypeScript 支持，没有运行时依赖）。
- 可选：`pnpm`（`package.json` 使用 pnpm-lock；只用 `node src/main.ts` 也能跑）。
- 不需要数据库、不需要前端构建、不需要外网资源。

```bash
cd cat-cafe-lab
pnpm install          # 只装 typescript + @types/node 两个 devDependency
node src/main.ts
```

打开 <http://127.0.0.1:4318>。默认是**演出模式**（mock brain），不需要任何 API key。

---

## 2. 本地运行

### 2.1 演出模式（默认）

```bash
node src/main.ts
# 或
pnpm start
```

没有 `LLM_BASE_URL` / `LLM_MODEL` 时 `readSettings()` 返回 `mode: "mock"`；
四个成员的台词来自内置剧本，工具与审批照常工作，只是不调用真实模型。

### 2.2 真实模式

方式 A：环境变量（推荐给服务/容器）

```bash
LLM_BASE_URL=https://api.deepseek.com/v1 \
LLM_MODEL=deepseek-chat \
LLM_API_KEY=sk-... \
node src/main.ts
```

OpenAI 兼容的 opencode 端点示例（需要额外 header 时）：

```bash
LLM_BASE_URL=https://opencode.ai/zen/go/v1 \
LLM_MODEL=deepseek-v4.1-flash \
LLM_API_KEY=... \
LLM_HEADERS='{"x-opencode-session":"catcafe-abc"}' \
node src/main.ts
```

方式 B：启动后在右上角 ⚙ 设置里填 Base URL / 模型 / API Key 并「测试连接」。
**面板里填的 key 只存在进程内存**，重启后丢失；写进环境变量的 key 每次启动都会有。

`mode` 判定规则：`readSettings()` 只有在 `LLM_BASE_URL` 与 `LLM_MODEL` **都非空**时
才生成 `llm` 配置；否则是 `mock`。没有设置 `CATCAFE_MODE` 这类环境变量。

### 2.3 指定端口 / 数据目录

```bash
PORT=4400 CATCAFE_DATA_DIR=/var/lib/cat-cafe-lab node src/main.ts
```

- `PORT` 只影响 HTTP 端口；服务固定绑定 `127.0.0.1`（见 `src/main.ts` 的
  `server.listen(settings.port, "127.0.0.1", …)`），没有绑定地址环境变量。
- `CATCAFE_DATA_DIR` 支持相对路径（相对于进程工作目录）和绝对路径；目录不存在会自动创建。
- 同一台机器可以起多个实例，只要 `PORT` 和 `CATCAFE_DATA_DIR` 都不同：

```bash
PORT=4319 CATCAFE_DATA_DIR=/tmp/catcafe-a node src/main.ts
PORT=4320 CATCAFE_DATA_DIR=/tmp/catcafe-b node src/main.ts
```

### 2.4 测试与类型检查

```bash
node --test tests/     # 后端测试
npx tsc --noEmit       # 类型检查
```

页面里也可以打开「🧪 测试」测试中心；它跑的是同一个项目的测试命令，输出通过 SSE 实时显示。

### 2.5 进程管理

项目没有内置 daemon。生产/长期运行时，用 systemd、launchd、supervisor 或 pm2 托管
`node /path/to/cat-cafe-lab/src/main.ts` 即可；确保：

- 工作目录在仓库根目录（`public/` 和 `tests/` 使用相对路径）；
- 环境变量在托管配置里显式声明；
- 收到 `SIGINT` / `SIGTERM` 时程序会执行 `shutdown()`，关闭 MCP、工作区、测试中心，
  并让 `Studio` 落盘；不要用 `SIGKILL` 代替正常停止。

---

## 3. 环境变量全表

`src/server/settings.ts` 的 `readSettings()` 读取以下变量：

| 变量 | 默认值 | 作用 | 示例 / 说明 |
|---|---|---|---|
| `PORT` | `4318` | HTTP 监听端口 | `PORT=4400`；`Number.parseInt`，非法值回落 4318 |
| `CATCAFE_DATA_DIR` | `data` | 数据目录 | `CATCAFE_DATA_DIR=/var/lib/cat-cafe-lab`；相对路径基于进程 cwd |
| `CATCAFE_STALL_MS` | `12000` | 判定任务「卡住了」的静默毫秒数 | 只接受正数；非法/<=0 回落 12000。前端也会读 `/api/health.stallMs` |
| `CATCAFE_TOOLS` | 开启 | 是否允许成员执行沙盒工具 | **只有字符串 `"0"` 关闭**；其他值都视为开启。设置面板保存的 `toolsEnabled` 会覆盖初始值 |
| `CATCAFE_APPROVAL` | `commands` | 工具审批策略 | `auto`（全自动）/ `all`（全审批）/ `commands`（只审批跑命令，默认）；其他值按 `commands` |
| `LLM_BASE_URL` | 空 | OpenAI 兼容 API base URL | `https://api.deepseek.com/v1`；末尾 `/` 会被去掉；与 `LLM_MODEL` 同时非空才进入真实模式 |
| `LLM_MODEL` | 空 | 默认模型名 | `deepseek-chat`；与 `LLM_BASE_URL` 同时非空才进入真实模式 |
| `LLM_API_KEY` | 空 | 模型 API key | 只读进进程内存；`getPublic()` 只回 `hasKey/keySource`，不落盘、不回前端、不进日志 |
| `LLM_TEMPERATURE` | `0.8` | 模型温度 | `parseFloat`；最终在 `SettingsStore` 里 clamp 到 `0–2`，非法值回落 0.8 |
| `LLM_HEADERS` | 空 | 给模型请求附加的 HTTP headers | JSON 对象字符串，如 `'{"x-opencode-session":"catcafe-abc"}'`；键只接受 `[A-Za-z0-9-]+`，值必须是字符串；非法 JSON 会警告并忽略（不打印内容）；**不持久化、不回前端、不进日志** |

### 3.1 优先级

1. `readSettings()` 先按环境变量生成初始配置；
2. `SettingsStore` 启动时读取 `data/settings.json`，其中保存的
   `mode/speed/toolsEnabled/toolApproval/streaming/engine/proactive/proactiveIntervalMs`
   以及 `llm.baseUrl/model/temperature` 会覆盖环境变量；
3. `LLM_API_KEY` 没有持久化字段：启动时只从环境变量取；面板输入的 key 只存在于当前进程；
4. `LLM_HEADERS` 也只来自环境变量，保存在 `SettingsStore.envHeaders`，不写入
   `settings.json`、不通过 API 暴露；如果重启时需要它，必须重新提供环境变量；
5. `CATCAFE_STALL_MS` 不走 `settings.json`，每次启动由环境变量决定；
6. 如果持久化配置是 `llm` 但缺少 Base URL 或模型名，启动时会回落到 `mock`。

> 注意：`/api/settings` 的 PUT 会持久化上面第 2 条列出的非敏感字段；
> 不要通过设置面板写 API key 后期待它跨重启保留。

---

## 4. 持久化

### 4.1 `data/` 目录结构

默认 `data/`（可用 `CATCAFE_DATA_DIR` 改）：

```
data/
├── studio.json          # 协作状态：房间、成员、消息、任务、交接、产物、记忆、调用记录…
├── settings.json        # 非敏感运行时设置（0600；首次修改设置后才出现）
├── workspaces.json      # 用户添加的工作区（0600；只有自定义工作区，不含内置沙盒）
├── mcp.json             # MCP server 配置（0600；可能含 env / HTTP headers 等鉴权值）
├── scenarios.json       # 导入的自定义剧本（0600；只有自定义，不含内置）
└── workspace/           # 内置沙盒工作区（ws_sandbox）
    ├── package.json
    ├── README.md
    └── src/ test/ ...   # 成员真实写出来的文件
```

用户添加的真实仓库不在 `data/` 里面——`workspaces.json` 只记录它的绝对路径和策略，
仓库本身仍在原位置。

### 4.2 `studio.json` 内容

由 `Studio` 的 `persistNow()` 把整个 `StudioState` `JSON.stringify` 写入。顶层字段：

| 字段 | 内容 |
|---|---|
| `rooms` | 房间（id / name / topic / catIds / workspaceId / createdAt） |
| `cats` | 成员档案；恢复时只接受安全字段覆盖，id/role/avatar 等以代码 `CATS` 为底 |
| `messages` | 当前保留的消息（含 user / system / chat / tool / handoff / artifact / review / decision） |
| `tasks` | 任务（状态、阶段、owner、标题、时间等） |
| `handoffs` | 交接卡 |
| `artifacts` | 产物 |
| `memory` | 共享记忆 |
| `catSessions` | 每个成员的跨任务会话记忆 |
| `toolCalls` | 沙盒工具调用记录 |
| `llmCalls` | 模型调用记录（耗时、token、降级等） |
| `typing` | 每房间当前打字的成员（恢复时会被清空） |
| `drafts` | 流式草稿（瞬态，恢复时不保留） |
| `seq` | SSE 递增序号 |
| `mode` | 启动时的大脑模式 |
| `startedAt` | 本次会话开始时间；前端用它识别服务端重启/重置 |

### 4.3 原子写入

所有 JSON 持久化都是「先写 `<file>.tmp`，再 `renameSync` 覆盖」：

- `studio.json`：`Studio.notify()` 里 200ms debounce，`persistNow()` 执行 tmp+rename；
  `Studio.close()` 在退出时立即落盘一次；
- `settings.json`、`workspaces.json`、`mcp.json`、`scenarios.json`：各自 `persist()` 里
  tmp+rename；权限 `0600`（MCP/设置/工作区/剧本文件）。
- 因此正常退出不会写半个 JSON；`*.tmp` 是写入中间态，可安全删除（但应先确认没有进程正在写）。

### 4.4 重启后：什么恢复、什么清空

**恢复：**

- 房间、成员档案（安全字段）、消息、任务状态/阶段、交接、产物、共享记忆、`catSessions`；
- `toolCalls` / `llmCalls` 历史（用于页面展示和轨迹）；
- `settings.json` 里的非敏感设置；
- 自定义剧本（`scenarios.json`）、自定义工作区（`workspaces.json`，目标目录必须仍存在）；
- MCP server 配置（`mcp.json`，启动时重新连接）；
- 内置沙盒 `data/workspace` 里的文件（不会重新种，已有 `package.json` 就保留成员的成果）。

**清空/不恢复：**

- `state.drafts`：流式草稿是瞬态，重启后清空（避免永久半截气泡）；
- `state.typing`：启动时全部置 null；
- 待审批队列 `ApprovalQueue`：只在内存；重启后悬挂审批作废；
- “记住的选择”（批准并记住）：只在进程内；
- 正在执行的模型/工具轮次和队列：不会自动续跑；任务记录可能仍是 `active`/`stalled`，
  需要新消息、催一下或恢复操作重新触发；
- 测试中心运行历史、临时日志：在内存，重启丢失；
- API key（除非通过 `LLM_API_KEY` 环境变量重新提供）和 `LLM_HEADERS`（必须重新用环境变量提供）。

> `studio.json` 损坏/顶层结构不合法时，`Studio.load()` 会记录
> `[studio] load failed, starting fresh:` 并重新种房间/招呼；不会尝试半恢复。
> 这是“宁可干净重开，不带着坏状态跑”的取舍。

---

## 5. 安全边界

> ⚠️ **当前没有用户鉴权，不要直接暴露到公网。**
>
> 应用没有登录、没有会话、没有多用户、没有 RBAC，也没有内置 TLS/CSRF token。
> 任何能访问这个 HTTP 端口的人，都可以读写状态、批准工具调用、修改设置、
> 触发命令执行和测试。把它当成“本机单人控制台”，不是“可公开访问的服务”。

### 5.1 默认只监听本机

`src/main.ts` 明确调用：

```ts
server.listen(settings.port, "127.0.0.1", …)
```

即使用 `PORT=0.0.0.0` 也不会改绑定地址；不要通过修改代码/反代把它直接暴露到不可信网络。
本机其他进程、其他用户（如果系统权限允许）仍能访问回环端口；需要隔离时用系统防火墙/权限。

### 5.2 审批不是身份认证

- 默认 `CATCAFE_APPROVAL=commands`，模型主动发起的 `run_command` 会挂起等待批准；
- `auto` 会跳过审批，`all` 会连读文件也要求批准；
- 审批超时 5 分钟自动按拒绝处理；「批准并记住」只在进程内有效；
- 审批 UI 是**给人看的确认环节**，不是安全边界。任何拿到 HTTP 访问权的人都能点批准，
  或在 `auto` 模式下直接绕过。不要把审批当成“只有我能批准”的保障。

### 5.3 API key / headers

- LLM `apiKey` 只存在 `SettingsStore` 内存；`getPublic()` 只返回 `hasKey` / `keySource`；
  错误信息经 `sanitizeError` 脱敏；`settings.json` 不写 key；
- `LLM_HEADERS` 只存在 `SettingsStore.envHeaders`，不写 `settings.json`、不回前端、不进日志；
- **注意区分**：MCP server 的 `env` / HTTP headers 属于 `mcp.json` 配置，会以 `0600`
  持久化到本地。它们同样绝不回前端或进日志，但确实落盘；备份 `data/` 时要把 `mcp.json`
  当敏感文件处理；
- 面板输入的 key 重启后丢失；`LLM_API_KEY` 环境变量的 key 每次启动会重新进入内存。

### 5.4 沙盒 / 路径 / 命令

`src/tools/sandbox.ts` 的边界：

- 所有工具路径通过 `resolveInside` 校验：拒绝绝对路径、盘符路径、`..`、越界；
- 读取/写入单文件上限 **64KB**；`list_files` 最多 **200** 条；
- 命令白名单只有 `node` / `npm`；最多 10 个参数、每个 ≤80 字，参数必须匹配安全字符，
  不允许 `/` 开头或包含 `..`；不经过 shell；
- 命令执行 **10s 超时**，stdout/stderr 截断到 **4000 字**。

### 5.5 工作区策略

- 内置沙盒 `data/workspace` 是 `read-write`；
- 用户添加的真实目录默认 `read-only`：`write_file` / `run_command` 会被
  `PolicySandbox` 直接拒绝；改成 `read-write` 需要显式确认；
- git 查询（分支/status/diff/文件）默认只读；任务分支、commit、rollback 需要在 UI 里显式操作，
  且只对 `read-write` 工作区生效；不会自动 push。

### 5.6 测试中心

测试中心通过 HTTP 触发 `node --test` / 真实模型矩阵。它不是只读的观测工具：
任何能访问 API 的人都能启动测试进程。测试运行使用当前用户权限，不要把它暴露给不可信访问者。

### 5.7 外部 MCP 进程

MCP stdio server 以当前用户权限启动，能力和它的命令一样大；HTTP MCP server 连接外部网络。
只添加你信任的 MCP server；不要把带密钥的 `mcp.json` 交给不可信的人。

---

## 6. 反向代理与远程访问

### 6.1 首选：不要直接暴露

推荐顺序：

1. **只在本机用**：`http://127.0.0.1:4318`；
2. 需要从另一台机器访问：用 SSH 端口转发 / VPN / Tailscale 等把回环端口安全地带过去，
   例如 `ssh -L 4318:127.0.0.1:4318 user@host`；
3. 必须用反向代理时：把代理放在同一台机器、应用仍只监听 `127.0.0.1`，在代理层加认证。

不要做「把 4318 端口转发到路由器/公网」或「改代码 bind 0.0.0.0」这类操作。

### 6.2 如果一定要放到内网

应用自身没有身份认证，因此安全责任全部在代理/网络层，至少需要：

- **认证**：代理层 Basic Auth / OIDC / VPN 等；授权后仍是同一个管理员身份；
- **TLS**：应用没有 HTTPS，敏感设置和 API key 走代理时必须是 HTTPS；
- **网络限制**：只允许可信网段/IP，不要 `0.0.0.0/0`；
- **不要复用公网端口**，不要在没有认证的情况下把 `/api/*` 暴露给浏览器扩展或第三方页面；
- 代理和应用在同一信任域；应用仍监听回环，别让代理之外的人直连应用端口。

Nginx 方向性示例（不是开箱即用的完整配置）：

```nginx
location / {
    # 先配置 auth_basic / auth_request / OIDC 等认证
    proxy_pass http://127.0.0.1:4318;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
}

# SSE：必须关闭缓冲，否则 /api/events 与 /api/tests/stream 会“卡住不更新”
location ~ ^/api/(events|tests/stream)$ {
    # 同样先认证
    proxy_pass http://127.0.0.1:4318;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
}
```

任何代理层认证都只是“谁能进门”；进门之后所有操作权限相同。不要把代理认证误认为
应用内的多用户权限系统。

---

## 7. 备份与迁移

### 7.1 备份

最小备份范围是**整个 `data/` 目录**：

```bash
# 最好先正常停止进程（Ctrl-C / SIGTERM），让 Studio 完成最后一次落盘
tar czf catcafe-backup-$(date +%F).tgz data/
```

包含：

- `studio.json`（协作状态）
- `settings.json`（非敏感设置）
- `workspaces.json`（自定义工作区引用）
- `mcp.json`（**可能含密钥**，按敏感文件保管）
- `scenarios.json`（自定义剧本，若有）
- `workspace/`（内置沙盒里成员写的文件）

**不在** `data/` 里、但业务上可能需要的：

- 你添加的真实仓库本身（`workspaces.json` 只记录路径，不会复制仓库）；
- 环境变量里的 `LLM_API_KEY` / `LLM_HEADERS`（不在任何文件里，备份后要单独安全保存）。

### 7.2 恢复 / 迁移

1. 把备份的 `data/` 放到目标机器，或 `CATCAFE_DATA_DIR` 指向它；
2. 如果换了路径，确保 `workspaces.json` 里的真实仓库绝对路径在新机器存在，否则在设置里重新添加；
3. 环境变量按新机器重新配置（key、headers、端口）；
4. `chmod 700` 数据目录、`chmod 600 data/settings.json data/mcp.json data/workspaces.json data/scenarios.json`；
5. 启动并打开页面，检查房间/任务/记忆是否恢复。

项目没有显式数据 schema 版本号；升级代码后如果字段变化，`Studio.load()` /
`SettingsStore.load()` 会按当前代码做安全合并/忽略未知字段。**升级前先备份**；
如果想彻底重开，停止进程后删除 `data/` 即可。

---

## 8. 故障排查表

| 现象 | 可能原因 | 怎么查 / 怎么处理 |
|---|---|---|
| 启动报 `EADDRINUSE` | 4318 被占用 | `lsof -nP -iTCP:4318 -sTCP:LISTEN`；换 `PORT=4400`，或停止旧进程 |
| 页面打不开 / 连接中 | 端口不对、进程没起、代理没转发 | `curl http://127.0.0.1:4318/api/health`；看启动日志；检查 `PORT` |
| 模型 401 / 403 | key 无效、key 过期、环境变量没带进进程 | 设置里「测试连接」；`GET /api/settings` 看 `llm.hasKey` / `keySource`；确认 `LLM_BASE_URL` 是否含 `/v1`；重启后面板 key 会丢 |
| 模型 404 / 400 | Base URL 或模型名不对；provider 需要额外 header | 用 `curl {baseUrl}/models` 检查；`LLM_HEADERS` 是否为合法 JSON；看 trace 里的降级原因 |
| 模型 429 / 超时 | 限流；长时间 reasoning | 看任务轨迹的 llm 条目和降级标记；换模型/降低并发；不要把 `stallMs` 调得过低 |
| 工具调用一直 pending | 审批策略要求人工批准；页面没看到 Needs Me | 看左上 `Needs Me` / `#jump-latest`；5 分钟后服务端自动拒绝；重启后 pending 队列会丢，重新触发任务 |
| 任务一直 stalled | `CATCAFE_STALL_MS` 太小；审批等待被误判；漏 @ / 交接没唤醒 | 看 `GET /api/state` 的 task.status 和 `/api/tasks/:id/trace`；点「催一下」/恢复面板；确认没有 pending 工具 |
| 真实模式没有流式草稿 | `settings.streaming=false`；provider 不走 SSE；演出模式不产生草稿 | `GET /api/settings` 看 `streaming`；设置里打开「流式输出」；演出模式没有草稿是预期 |
| MCP server 显示未连接 | 命令/参数路径不对、stdio 进程起不来、HTTP 不可达 | 看启动日志；检查 `data/mcp.json`（0600）里的 command/args/env/url；先手动跑该命令 |
| 测试中心 503 / 未就绪 | 服务端未挂载 TestRunner；旧进程 | 用最新 `node src/main.ts`；`GET /api/tests/runs` 看状态；测试中心只在 `main.ts` 组装 |
| `/api/...` 404 | 用了旧进程 / 旧版本 | 重启到当前代码；对比 `git log`；前端对 404/503 会显示“未就绪”而不是崩溃 |
| 自定义仓库写不进去 | 工作区是 `read-only` | 设置 → 工作区里显式授权 `read-write`；只读时 `write_file`/`run_command` 会被拒绝 |
| 命令被拒绝 | 不是 `node`/`npm`、参数含 `/` 或 `..`、路径越界 | 看工具卡 output；只允许白名单命令和安全参数；用相对沙盒路径 |
| `data/studio.json` 损坏 | 手工编辑/写入中断 | 看 `[studio] load failed, starting fresh:` 日志；先备份，再删除或修复文件；`*.tmp` 是中间态 |
| 页面数字不更新 | SSE 断了 / 旧 seq | 看 `[data-seq]` 是否增长、`#conn-banner`；刷新页面；EventSource 会自动重连并补拉 `/api/state` |
| 远程访问 SSE 卡住 | 反向代理缓冲/超时 | 对 `/api/events` 和 `/api/tests/stream` 关 `proxy_buffering`、加大 `proxy_read_timeout`；确认认证已配置 |

### 8.1 快速自检

```bash
curl -s http://127.0.0.1:4318/api/health | jq .
curl -s http://127.0.0.1:4318/api/settings | jq '{mode, streaming, toolsEnabled, toolApproval, hasKey: .llm.hasKey, keySource: .llm.keySource}'
curl -s http://127.0.0.1:4318/api/state | jq '{rooms: (.rooms|length), tasks: (.tasks|length), messages: (.messages|length)}'
```

- `/api/health` 的 `stallMs` 应与前端卡住判定一致（前端也会用它的值）；
- `mode: "llm"` 且 `hasKey: false` 时，真实调用会失败，先配置 key；
- 任务一直 `active` 但没有进展时，看 `/api/tasks/:id/trace` 最后一条事件和 pending 审批。

---

## 9. 运维检查清单

- [ ] Node >= 24；进程 cwd 是仓库根目录；
- [ ] `PORT` / `CATCAFE_DATA_DIR` 明确且互不冲突；
- [ ] `data/` 只允许本机用户访问（建议 `chmod 700`；敏感 JSON `0600`）；
- [ ] 只要不是本机使用，先加 VPN/SSH 隧道或代理认证；**绝不以无鉴权状态暴露公网**；
- [ ] `LLM_API_KEY` 只通过环境变量/密钥管理系统注入，不写进仓库；
- [ ] 备份 `data/`，并确认 `mcp.json` 按敏感文件保管；
- [ ] 升级前备份；需要全新状态时停止进程后删除 `data/`；
- [ ] 反向代理对 SSE 路径关闭缓冲、设置足够的读超时；
- [ ] 查看一次 `/api/health`、`/api/settings`、`/api/state`，确认模式和 key 状态符合预期。
