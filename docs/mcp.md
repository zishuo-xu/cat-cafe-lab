# MCP 服务器接入与鉴权

猫咖支持挂载 [MCP](https://modelcontextprotocol.io) server，把它们的工具注册成
`serverId__toolName` 交给猫猫使用。支持两种传输：

| 传输 | 适用 | 鉴权字段 | 连接方式 |
|---|---|---|---|
| `stdio` | 本地子进程（`npx ...`、本地可执行文件） | `env` | 启动子进程，stdin/stdout 走 JSON-RPC |
| `http` | 远程 / 本机 HTTP 服务 | `headers` | 每个 JSON-RPC 请求走 HTTP POST |

MCP 工具默认风险等级 `needs_approval`：模型主动调用时会进审批队列，
铲屎官批准后才真正执行（可在设置里按 `auto` / `commands` / `all` 调整）。

> 前端设置面板是后续任务；本文以 HTTP API 为准，面板只是这些接口的壳。

---

## 1. 添加带鉴权的 server

### stdio + env（例如 GitHub MCP）

```bash
curl -s http://127.0.0.1:4318/api/mcp \
  -H 'content-type: application/json' \
  -d '{
    "name": "GitHub MCP",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxxxxxxx"
    },
    "risk": "needs_approval",
    "enabled": true
  }'
```

- `env` 会**合并进子进程环境**（同名覆盖 `process.env` 的值）。
- 工具会注册成 `<返回的 server.id>__<toolName>`，例如 `github-mcp__list_issues`。
- 子进程的 stderr 会被转发到服务端日志，但 env / headers 里的值会先被脱敏成 `***`。

### http + headers（例如带 token 的远程服务）

```bash
curl -s http://127.0.0.1:4318/api/mcp \
  -H 'content-type: application/json' \
  -d '{
    "name": "Internal Docs MCP",
    "transport": "http",
    "url": "https://mcp.example.com/mcp",
    "headers": {
      "Authorization": "Bearer <your-token>"
    }
  }'
```

- `headers` 会附加到**每个** JSON-RPC 请求（initialize / tools/list / tools/call / 通知）。
- 与协议头合并规则：
  - `content-type` 固定为 `application/json`，**不允许**覆盖；
  - `mcp-session-id` 由服务端下发 / 客户端维护，**不允许**用户覆盖；
  - `accept` 允许覆盖（有些 server 只返回 `application/json`，不返回 SSE）；
  - 其他头（如 `Authorization`、自定义 `X-Api-Key`）原样发送。
- 如果 server 在 initialize 响应里下发 `mcp-session-id`，后续请求会自动带上它。

---

## 2. 字段与校验

### 公共字段

| 字段 | 说明 |
|---|---|
| `name` | 1–40 字，用于展示与生成 id |
| `transport` | `stdio` 或 `http` |
| `enabled` | 是否启用；`false` 时不连接、不注册工具 |
| `risk` | `safe` / `needs_approval`（默认后者） |

### stdio

| 字段 | 说明 |
|---|---|
| `command` | 必填，可执行文件（如 `npx` / `node` / 绝对路径） |
| `args` | 可选，字符串数组 |
| `env` | 可选，`Record<string, string>`；合并进子进程环境 |

### http

| 字段 | 说明 |
|---|---|
| `url` | 必填，`http(s)://` 开头 |
| `headers` | 可选，`Record<string, string>`；附加到每个请求 |

### `env` / `headers` 校验

- 键名：`^[A-Za-z_][A-Za-z0-9_]{0,63}$`（如 `Authorization`、`X_API_KEY`）；
- 值：字符串，长度 ≤ 500 字；
- 数量：≤ 20 项。

违反任一条 → `400`，错误信息**只报键名 / 规则，不回显值**。

### id 规则

不传 id 时按 name 生成 slug；显式 id 需匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{1,40}$`。

---

## 3. 更新（PUT /api/mcp/:id）

```bash
# 轮换 token
curl -s -X PUT http://127.0.0.1:4318/api/mcp/github-mcp \
  -H 'content-type: application/json' \
  -d '{"headers": {"Authorization": "Bearer new-token"}}'

# 清空 env（传 {} 才会清空；不传则保留）
curl -s -X PUT http://127.0.0.1:4318/api/mcp/github-mcp \
  -H 'content-type: application/json' \
  -d '{"env": {}}'

# 启停 / 改风险等级
curl -s -X PUT http://127.0.0.1:4318/api/mcp/github-mcp \
  -H 'content-type: application/json' \
  -d '{"enabled": false}'
```

语义：

- **不传**的字段保持原值；
- `env` / `headers` 传 `{}` 表示清空该项；
- 改了 `env` / `headers` / `risk` / `enabled` 且 server 处于启用状态 → 自动断开重连，
  新配置立即生效；
- 其他字段（name / transport / command / args / url）不支持 PUT 修改，请删除后重建。

---

## 4. 查询（GET /api/mcp）

```jsonc
{
  "servers": [
    {
      "id": "github-mcp",
      "name": "GitHub MCP",
      "transport": "stdio",
      "enabled": true,
      "status": "connected",
      "toolCount": 2,
      "risk": "needs_approval",
      "envKeys": ["GITHUB_PERSONAL_ACCESS_TOKEN"],  // 只有键名
      "headerKeys": []                               // 只有键名
    }
  ]
}
```

**只返回键名，永远不返回值，也不返回 masked 值。**

其他接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/mcp/:id/test` | 用临时连接试连，返回 `{ ok, tools, error? }`；不落盘、不注册工具，错误信息同样脱敏 |
| `POST` | `/api/mcp/:id/toggle` | `{ "enabled": boolean }`，等价于 PUT 只改 enabled |
| `DELETE` | `/api/mcp/:id` | 断开并从配置中删除 |

---

## 5. 隐私与安全

1. **值不进响应**：`GET /api/mcp`、`POST /api/mcp`、`PUT`、`POST /:id/test` 都只回
   键名；任何接口都不会回显 `env` / `headers` 的值。
2. **值不进日志 / 错误信息**：stdio 子进程 stderr、JSON-RPC 错误信息、连接失败原因在
   写日志或返回前统一脱敏：只要文本里出现配置过的值，就替换成 `***`。
3. **值不落 Studio 状态**：MCP 配置不会进入 `StudioState`、SSE 快照或前端状态；
   只在服务端内存与 `data/mcp.json` 里。
4. **持久化**：配置写入 `data/mcp.json`，文件权限 `0600`（仅当前用户可读）。
   `data/` 已被 `.gitignore` 忽略；仍然不要把它提交或随手发给别人。
   重启后自动加载并连接启用的 server。
5. **别把密钥放 args**：`command` / `args` 会原样出现在 `GET /api/mcp` 的返回里
   （它们不是鉴权字段）。token 一律放 `env`（stdio）或 `headers`（http）。
6. **stdio env 会合并 `process.env`**：配置同名变量会覆盖父进程；不要覆盖
   `PATH` / `HOME` 这类基础变量，除非你清楚后果。
7. **http 头的边界**：用户头不能覆盖 `content-type` 与 `mcp-session-id`，避免破坏
   JSON-RPC 会话；`accept` 可以覆盖。
8. **执行仍然走审批**：MCP 工具默认 `needs_approval`，模型调用会排队等待铲屎官
   批准；被拒后回执 `status=rejected`，模型不会无限重试。

---

## 6. 自测

```bash
node --test tests/mcp.test.ts
```

测试用 `tests/fixtures/fake-mcp-stdio.mjs` 作为本地 MCP server：

- `echo`：回显文本；
- `env_echo`：返回启动时注入的 `FAKE_TOKEN`，验证 stdio `env` 真的传进去了；
- （`FAKE_EXTRA_TOOLS=1` 时）`token_error`：故意把 token 放进 JSON-RPC 错误信息，
  验证错误信息脱敏。

覆盖点：env 传递、http headers 传递与合并规则、GET 只回键名、PUT 轮换 / 清空、
校验失败 400、日志 / 错误信息脱敏、`data/mcp.json` 0600。

## 7. 排错

| 现象 | 排查 |
|---|---|
| `status: "error"` | 看返回的 `lastError`（已脱敏）；再用 `POST /api/mcp/:id/test` 试连 |
| http 一直 401 | `Authorization` 值是否正确、前缀（`Bearer `）是否带全；PUT 轮换后观察是否重连 |
| stdio 启动失败 | `command` 是否在 PATH / 是否是绝对路径；`args` 是否完整 |
| 工具没出现 | server 是否 `enabled`；`tools/list` 是否返回工具；`GET /api/tools` 里看 `source=mcp` |
| 改了配置没生效 | 确认是 PUT 且该 server 处于启用状态（禁用状态下不会重连，启用时生效） |


---

## 内置示例 server

仓库里有几个零依赖的示例，复制到设置里就能用（路径写绝对路径）：

### 1. 猫咖记事本（examples/mcp/notes-server.mjs）

让猫能读写一个本地记事本：

| 工具 | 作用 |
|---|---|
| `list_notes` | 列出记事本里的笔记标题 |
| `read_note { title }` | 读一篇笔记 |
| `write_note { title, content }` | 写/覆盖一篇笔记 |

在设置 →「MCP 工具」→「添加 MCP Server」：

```json
{
  "id": "notes",
  "name": "猫咖记事本",
  "transport": "stdio",
  "command": "node",
  "args": ["/绝对路径/cat-cafe-lab/examples/mcp/notes-server.mjs"],
  "risk": "safe"
}
```

> 建议显式给 `id`：不给的话服务端会按名字生成（中文名会退化成 `mcp`），
> 工具名会变成 `mcp__list_notes` 这种看不出归属的形式。

添加后名册里的猫就能在真实模式下使用 `list_notes` / `read_note` / `write_note`。
数据存在 `examples/mcp/notes.json`（gitignore 之外的演示文件，自己注意别提交私密内容）。

> `risk: "safe"` 表示不需要审批；如果让猫频繁写东西，建议保持默认的 `needs_approval`。

### 2. 自测用 fake server（tests/fixtures/fake-mcp-stdio.mjs）

只用于跑测试（echo / env_echo 等），不建议在日常使用中添加。
