# 模型配置与行为（LLM）

交付台**只有一种运行形态**：接上模型干活。成员会真的读文件、跑测试、改代码，
协作流程（谁接活、交接顺序、review 打回、谁写得进记忆）由引擎决定。

**没接上模型时**只能聊天（成员会直说「还没接上模型」），派活会被 `412` 拦下并引导去配置。

实现只有两处：

- `src/server/settings.ts` / `src/server/settings-store.ts` —— 环境变量默认值 + 运行时设置面板，维护连接配置；
- `src/agents/llm-brain.ts` —— 调用 OpenAI 兼容端点；**调用失败不退回假台词**，而是把失败上报给 driver 暂停任务。

---

## 1. 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `LLM_BASE_URL` | 是 | 空 | 端点根地址，**不要**带 `/chat/completions`；末尾 `/` 会被自动去掉 |
| `LLM_API_KEY` | 否 | 空 | 鉴权 key；本地模型（Ollama / vLLM 等）可不填 |
| `LLM_MODEL` | 是 | 空 | 模型名，原样透传给端点 |
| `LLM_TEMPERATURE` | 否 | `0.8` | 采样温度，会被夹到 `[0, 2]` |
| `PORT` | 否 | `4318` | HTTP 端口 |
| `DELIVERYLAB_DATA_DIR` | 否 | `data` | 状态持久化目录（`studio.json`） |
| `DELIVERYLAB_STALL_MS` | 否 | `12000` | 任务卡住判定阈值 |

**是否已配置**：`LLM_BASE_URL` 和 `LLM_MODEL` 都非空才算配好（`LLM_API_KEY` 看端点要求）。
环境变量可以**只给一部分**：例如 baseUrl/model 存在设置里，启动时只给 `LLM_API_KEY` / `LLM_HEADERS`
也会合并进来（早期版本会静默丢掉这些值）。
`GET /api/health` 的 `configured` 字段可以确认；`mode` 字段恒为 `llm`，保留兼容。

> 也可以完全不用环境变量：打开工作台左上角 ⚙️ **设置面板**（第一屏就是「LLM 连接」），
> 选一个 **Provider 预设**（opencode zen / DeepSeek / OpenAI / 本地 Ollama）会自动填好
> Base URL、默认模型和需要的请求头，再粘 key、点「测试连接」保存即可。
> 额外请求头也可以展开「高级」手填 JSON。请求头会随 `settings.json` 落盘（0600），
> 重启后仍在；但值**不会回传前端**（只暴露名字）。API key 仍然只在内存/环境变量。面板保存的值会覆盖环境变量；API Key 只存在进程内存，
> 不回传、不落盘。下面的环境变量方式仍然可用，作为启动默认值。

### 每个成员独立模型

设置面板「成员与模型」里可以给每个成员单独填 `llmModel` 和 `llmTemperature`
（等价于 `PUT /api/cats/:id`）。llm-brain 每次调用按当前这个成员解析：

- `Cat.llmModel` 非空 → 用这个成员的模型；空/缺省 → 用全局 `LLM_MODEL`；
- `Cat.llmTemperature` 是数字（包括 `0`）→ 用它；否则回落全局 `LLM_TEMPERATURE`；
- 覆盖值存在 `data/studio.json` 的 `cats` 里，重启保留。

这样可以让林知远用推理模型、陈实用便宜快速的模型，而不需要维护多个 brain 实例。

### 模型与沙盒工具

模型的输出第 7 种 turn 是 `kind:"tool"`，可用工具来自 `TurnContext.availableTools`：
内置沙盒四个工具 + 已连接的 MCP server 工具（按按成员权限过滤）。driver 执行后以
`trigger.kind="tool_result"` 再叫一次，把 exitCode 和输出喂回去（最多连续 3 轮）。

`TurnContext.skills` 里的技能包会以 `### <name>` + prompt 全文注入 system prompt。
MCP 工具默认风险 `needs_approval`，模型调用会进审批队列。

模型主动发起的命令默认要负责人审批（`commands` 策略），拒绝会以 `rejected` 回喂。
详见 README「成员会自己决定用工具」。

### 启动示例

```bash
# OpenAI
LLM_BASE_URL=https://api.openai.com/v1 \
LLM_API_KEY=sk-... \
LLM_MODEL=gpt-4o-mini \
node src/main.ts

# DeepSeek
LLM_BASE_URL=https://api.deepseek.com/v1 \
LLM_API_KEY=sk-... \
LLM_MODEL=deepseek-chat \
node src/main.ts

# Ollama（本地，无需 key）
LLM_BASE_URL=http://127.0.0.1:11434/v1 \
LLM_MODEL=qwen2.5:7b \
node src/main.ts
```

确认生效：

```bash
curl -s http://127.0.0.1:4318/api/health
# {"ok":true,"mode":"llm","seq":12}
```

---

## 2. 支持的端点

任何兼容 `POST /chat/completions` 的服务都可以。程序实际请求的 URL 是：

```
{LLM_BASE_URL}/chat/completions
```

| 服务 | `LLM_BASE_URL` 示例 | `LLM_MODEL` 示例 |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 阿里云百炼（兼容模式） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` |
| Ollama | `http://127.0.0.1:11434/v1` | `qwen2.5:7b` |
| vLLM / llama.cpp server | `http://127.0.0.1:8000/v1` | 部署时的模型名 |
| 自建网关 | 网关的 `/v1` 前缀 | 网关映射的模型名 |

> 模型名以服务商文档为准；部分兼容端点对 `max_tokens` 字段名有差异，本项目使用
> OpenAI 标准的 `max_tokens`，暂不做自动改写。

### 请求约定

```http
POST {LLM_BASE_URL}/chat/completions
Authorization: Bearer {LLM_API_KEY}
Content-Type: application/json

{
  "model": "{LLM_MODEL}",
  "temperature": 0.8,
  "max_tokens": 1600,
  "stream": false,
  "messages": [
    { "role": "system", "content": "……成员的人格 + 当前阶段 + 输出契约……" },
    { "role": "user", "content": "……最近消息 + 交接卡 + 产物 + 记忆 + 触发事件……" }
  ]
}
```

Prompt 会带上：

- 这个成员的名字/品种/角色/性格/口头禅，以及房间信息；
- 当前任务的标题、需求原文、阶段、负责人、场景 id；
- 最近 24 条房间消息（每条截断到约 220 字）；
- 当前任务的交接卡、已有产物（正文截断）、相关共享记忆（最多 12 条）；
- 触发这次回复的事件（用户消息 / 交接 / 产物 / review 结论 / 催一下）。

### 输出契约

模型必须**只输出一个 JSON 数组**（`CatTurn[]`），元素是下面六种之一：

```jsonc
[
  { "kind": "message", "text": "我先说结论，再拆。", "mentions": ["yanyan"] },
  {
    "kind": "handoff",
    "to": "jinjianceng",
    "card": {
      "what": "实现 remember-me token",
      "why": "减少重复登录",
      "tradeoff": "便利性 vs 共享设备安全",
      "openQuestions": ["7 天后是否重新验证身份？"],
      "nextAction": "先出接口，再补测试"
    },
    "text": "这块交给你。"
  },
  {
    "kind": "artifact",
    "artifact": { "kind": "patch", "title": "v1 patch", "body": "diff …" },
    "text": "改完了。"
  },
  {
    "kind": "review",
    "verdict": "request_changes",
    "title": "打回：token 缺过期时间",
    "findings": [
      { "severity": "blocker", "title": "token 永久有效", "detail": "必须设 7 天过期" }
    ],
    "text": "第 1 条必须改。",
    "mentions": ["jinjianceng"]
  },
  {
    "kind": "decision",
    "artifact": { "title": "决策：7 天滚动 token", "body": "……" },
    "text": "落一条决策。",
    "memory": [
      { "kind": "decision", "title": "remember-me 用 7 天滚动 token", "body": "……", "tags": ["auth"] }
    ]
  },
  {
    "kind": "memory",
    "memory": { "kind": "lesson", "title": "token 必须有过期时间", "body": "……", "tags": ["security"] },
    "text": "记一笔教训。"
  }
]
```

解析后做**结构校验**，不合法就丢弃该条（而不是整轮崩掉）：

- `kind` 必须是上面六种之一，未知 kind 直接丢弃；
- `handoff.card` 五栏 `what / why / tradeoff / openQuestions / nextAction` 必须齐全，
  缺栏的交接卡整条丢弃；`openQuestions` 必须是字符串数组（单个字符串会被宽容包装）；
- `review.verdict` 只能是 `approve` / `request_changes`，`findings[].severity` 只能是
  `blocker` / `minor`，非法项被过滤；
- `artifact.kind` 必须是 `spec / design / patch / review / decision`；
- `memory.kind` 必须是 `decision / lesson / preference`；
- `mentions`、`handoff.to` 只保留房间里存在的 catId，交接给自己或被 @ 到不存在的成员会被丢弃；
- 一次最多接受 6 个 turn，`delayMs` 被夹到 `0 ~ 8000`。

校验后一条合法 turn 都不剩，视为整轮失败 → **暂停任务**（见第 3 节）。

---

## 3. 失败行为（不退回假台词）

核心承诺：**模型不可靠，但结果不能被伪装**。调用失败时不会退回演出台词假装还在干活，
而是把失败上报给 driver，**暂停任务**并把决定权交回给人。

| 失败情况 | 行为 | 日志（一行） |
|---|---|---|
| HTTP 非 2xx | 上报 `failed`，任务暂停 | `[llm-brain] HTTP 500（成员=林知远，stage=reviewing）→ 任务将暂停` |
| 响应体不是 JSON | 同上 | `…响应不是合法 JSON envelope…` |
| 缺 `choices[0].message.content` | 同上 | `…响应缺少 choices[0].message.content…` |
| 内容不是可用 `AgentTurn[]` | 同上 | `…模型输出不是可用的 AgentTurn[]…` |
| 输出被 max_tokens 截断 | 阶梯提升预算重试（4096 → 8192 → 16384 → 32000）后再判失败 | `…用 32000 重试第 3 次…` |
| 返回空内容（finish=stop 但 content 为空） | 先换非流式重试一次；仍为空才失败 | `…端点返回空内容（finish=stop）…` |
| 请求超时 | abort → 同上 | `…请求超时 30000ms…` |
| 网络错误（DNS / 连接失败） | 同上 | `…网络错误：fetch failed…` |

要点：

- 暂停时任务 `status` 变 `stalled`，聊天区落一条系统消息说明原因：
  「模型调用失败：<原因>。任务已暂停（不是卡住，是真实报错）——你可以「继续试试」「换个方案」或「收尾」。」
- 恢复面板复用现有的三选一；「继续试试」会重试，若仍失败会再次暂停并累加 `Task.health`。
- **流式输出被提前断开**（没有 `finish_reason`）时会先改用**非流式重试一次**；
  回退时超时放宽到 90s（推理模型 20s 不够），非流式也拿不到才判定失败。
- 模型的个别 turn 不合法只丢弃该 turn（只有一条都不剩才算整轮失败）。
- 失败的这一轮**不写共享记忆**（避免把错内容沉淀成后续任务的上下文）。

---

## 3.1 「测试连接」测的是什么

设置面板里的「测试连接」不是 ping 域名，而是**真的跑一次最小对话**：

```
POST {baseUrl}/chat/completions
{ "model": "<模型名>", "max_tokens": 8, "messages": [{ "role": "user", "content": "ping" }] }
```

为什么不能用 `GET /models` 代替：opencode zen 的模型列表端点**不校验**
`x-opencode-session`，会返回 200；但真正的对话端点缺这个头直接
`400 MissingSessionID`。只测 `/models` 会得到假阳性——用户以为配好了，
派活后任务立刻暂停（真实踩过）。

失败时返回可操作提示：

| 状态 | 提示 |
|---|---|
| 400 | 请求参数或请求头不被接受；opencode zen 需要 `x-opencode-session` |
| 401 / 403 | API Key 无效或没有该模型权限 |
| 404 | Base URL / 模型名不对（注意是否要以 `/v1` 结尾） |
| 429 | 被限流，稍后再试或换模型 |
| 5xx | 模型服务端报错 |

成功时返回「连接成功（已跑通一次真实对话）」，并顺手报一下可用模型数量。

---

## 4. 隐私注意

- **key 只从环境变量读**，只存在进程内存里的 `LlmSettings`；不写入 `data/`、
  不写日志、不进 `Studio` 状态，`data/studio.json` 里永远没有 key。
- key 只出现在请求头 `Authorization: Bearer …`；所有 warn 日志都会经过一次
  `scrub()` 二次脱敏（即使 key 因某种原因出现在文本里也会被替换成 `***`）。
- 上行给模型的内容包括：需求原文（brief）、最近 24 条房间消息、交接卡、产物正文
  （截断）、共享记忆（最多 12 条）与成员的人格设定。**这意味着这些内容会发送到你配置的
  端点**。处理真实业务数据时：
  - 优先用本地模型（Ollama / vLLM / llama.cpp），数据不出机器；
  - 用云端服务时，确认提供方的数据留存与训练政策；
  - 不要用来源不明的第三方兼容网关。
- 不要把 key 写进 `package.json`、脚本参数或提交到 git；`.gitignore` 已忽略
  `data/*.json`、`*.log`，但环境变量文件（如 `.env`）没有被自动加载，也不会被读取。
- 排障分享日志前检查一下 warn 行：本次实现保证不带 key，但终端回显、shell history
  里仍可能有你启动时手敲的 key。

---

## 5. 自测与排障

只跑 LLM 相关测试（全部本地假端点，不联网、不需要 key）：

```bash
node --test tests/llm.test.ts
```

测试覆盖：合法 JSON 被正确解析（并断言请求体带成员名与 brief）、坏 JSON / HTTP 500 /
超时 / 网络错误都上报 `failed`（不调用 fallback、返回空数组）、结构校验（未知 kind、
缺栏卡片、非法 verdict）、以及“日志不出现 apiKey”。

集成测试（临时 dataDir + 端口 0）真跑完整链路，其中一组专门验证“端点全程不可用 →
任务暂停 + 给出原因 + 不写记忆、继续后仍失败会再次暂停”：

```bash
node --test tests/integration.test.ts
```

手工验证端点是否兼容：

```bash
curl -s "${LLM_BASE_URL}/chat/completions" \
  -H "Authorization: Bearer ${LLM_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"model":"'"${LLM_MODEL}"'","messages":[{"role":"user","content":"只输出 []"}]}'
```

常见现象：

| 现象 | 可能原因 |
|---|---|
| 「测试连接」失败但 `/models` 能打开 | 对话端点要求额外请求头（如 opencode zen 的 `x-opencode-session`）；连接测试现在会真跑一次对话来发现这点 |
| `/api/health` 的 `configured` 是 `false` | `LLM_BASE_URL` 或 `LLM_MODEL` 为空（注意 `export`） |
| 一直看到 `HTTP 404` | `LLM_BASE_URL` 多写了 `/chat/completions`，或少了 `/v1` |
| 一直看到 `HTTP 401/403` | key 无效或没权限访问该模型 |
| 任务突然「卡住了」并提示模型调用失败 | 看服务端 stderr 的 `[llm-brain]` 行与任务轨迹，常见是端点/模型/key 配错 |
| 模型输出被大量丢弃 | 换更强的模型，或调低 `LLM_TEMPERATURE`（如 `0.3`） |

> 协作纪律由 engine 决定，模型只负责“说什么”和“怎么交接”。
> 模型持续失败时任务会暂停，而不是按剧本演完——这是有意设计：不给你假结果。
