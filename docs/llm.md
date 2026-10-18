# 真实模式（LLM）配置与行为

猫咖默认是**演出模式**：零 API key、确定性台词，打开就能看完一次完整协作。
配好模型后切到**真实模式**：四只猫的台词与交接由真实模型生成，协作流程（谁接活、
交接顺序、review 打回、谁写得进记忆）保持不变。

真实模式的实现只有两处：

- `src/server/settings.ts` / `src/server/settings-store.ts` —— 环境变量默认值 + 运行时设置面板，判定与切换模式；
- `src/agents/llm-brain.ts` —— 调用 OpenAI 兼容端点，失败时降级到 mock brain。

---

## 1. 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `LLM_BASE_URL` | 是 | 空 | 端点根地址，**不要**带 `/chat/completions`；末尾 `/` 会被自动去掉 |
| `LLM_API_KEY` | 否 | 空 | 鉴权 key；本地模型（Ollama / vLLM 等）可不填 |
| `LLM_MODEL` | 是 | 空 | 模型名，原样透传给端点 |
| `LLM_TEMPERATURE` | 否 | `0.8` | 采样温度，会被夹到 `[0, 2]` |
| `PORT` | 否 | `4318` | HTTP 端口 |
| `CATCAFE_DATA_DIR` | 否 | `data` | 状态持久化目录（`studio.json`） |
| `CATCAFE_STALL_MS` | 否 | `12000` | 任务卡住判定阈值 |

**模式判定**：`LLM_BASE_URL` 和 `LLM_MODEL` 都非空才进入真实模式，否则演出模式。
`GET /api/health` 返回的 `mode` 字段可以确认当前模式。

> 也可以完全不用环境变量：打开工作台左上角 ⚙️ **设置面板**，填 Base URL / 模型 / Key 后
> 点「测试连接」并保存，运行中即时切换。面板保存的值会覆盖环境变量；API Key 只存在进程内存，
> 不回传、不落盘。下面的环境变量方式仍然可用，作为启动默认值。

### 每只猫独立模型

设置面板「猫猫与模型」里可以给每只猫单独填 `llmModel` 和 `llmTemperature`
（等价于 `PUT /api/cats/:id`）。真实模式下，llm-brain 每次调用按当前这只猫解析：

- `Cat.llmModel` 非空 → 用这只猫的模型；空/缺省 → 用全局 `LLM_MODEL`；
- `Cat.llmTemperature` 是数字（包括 `0`）→ 用它；否则回落全局 `LLM_TEMPERATURE`；
- 覆盖值存在 `data/studio.json` 的 `cats` 里，重启保留。

这样可以让宪宪用推理模型、金渐层用便宜快速的模型，而不需要维护多个 brain 实例。

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
    { "role": "system", "content": "……猫的人格 + 当前阶段 + 输出契约……" },
    { "role": "user", "content": "……最近消息 + 交接卡 + 产物 + 记忆 + 触发事件……" }
  ]
}
```

Prompt 会带上：

- 这只猫的名字/品种/角色/性格/口头禅，以及房间信息；
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
- `mentions`、`handoff.to` 只保留房间里存在的 catId，交接给自己或被 @ 到不存在的猫会被丢弃；
- 一次最多接受 6 个 turn，`delayMs` 被夹到 `0 ~ 8000`。

校验后一条合法 turn 都不剩，视为整轮失败 → 降级。

---

## 3. 降级行为

真实模式的核心承诺：**模型不可靠，但演出不能停**。

| 失败情况 | 行为 | 日志（一行） |
|---|---|---|
| HTTP 非 2xx | `fallback.think(ctx)` | `[llm-brain] HTTP 500，降级 fallback（猫=宪宪，stage=reviewing）` |
| 响应体不是 JSON | `fallback.think(ctx)` | `…响应不是合法 JSON envelope…` |
| 缺 `choices[0].message.content` | `fallback.think(ctx)` | `…响应缺少 choices[0].message.content…` |
| 内容不是可用 `CatTurn[]`（坏 JSON / 全被校验过滤） | `fallback.think(ctx)` | `…模型输出不是可用的 CatTurn[]…` |
| 请求超过 **20s** | abort → `fallback.think(ctx)` | `…请求超时 20000ms…` |
| 网络错误（DNS / 连接失败） | `fallback.think(ctx)` | `…网络错误：fetch failed…` |
| `LLM_BASE_URL` / `LLM_MODEL` 缺失 | `fallback.think(ctx)` | `…LLM_BASE_URL 缺失或非法…` |

要点：

- 降级调用的是 `fallback.think(ctx)`，也就是**确定性 mock brain**，所以任务状态机、
  交接、review、记忆照常推进，只是台词变回演出稿；
- 每次失败只 `console.warn` **一行**，不抛异常、不中断 driver；
- 超时是 per-request 的 `AbortController`，不用全局定时器，不会影响其他猫的轮次；
- 模型的个别 turn 不合法只丢弃该 turn，不整轮降级（只有一条都不剩才降级）；
- 恢复不需要重启：下一次 `think()` 会重新请求模型。

---

## 4. 隐私注意

- **key 只从环境变量读**，只存在进程内存里的 `LlmSettings`；不写入 `data/`、
  不写日志、不进 `Studio` 状态，`data/studio.json` 里永远没有 key。
- key 只出现在请求头 `Authorization: Bearer …`；所有 warn 日志都会经过一次
  `scrub()` 二次脱敏（即使 key 因某种原因出现在文本里也会被替换成 `***`）。
- 上行给模型的内容包括：需求原文（brief）、最近 24 条房间消息、交接卡、产物正文
  （截断）、共享记忆（最多 12 条）与猫的人格设定。**这意味着这些内容会发送到你配置的
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

测试覆盖：合法 JSON 被正确解析（并断言请求体带猫名与 brief）、坏 JSON / HTTP 500 /
超时 / 网络错误全部降级、结构校验（未知 kind、缺栏卡片、非法 verdict）、以及
“日志不出现 apiKey”。

集成测试（临时 dataDir + 端口 0）真跑完整链路，其中一组专门验证“真实模式端点
全程不可用 → 每次失败降级、日志不泄 key，但六阶段协作 + review 打回 + 记忆照常跑完”：

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
| `/api/health` 的 `mode` 仍是 `mock` | `LLM_BASE_URL` 或 `LLM_MODEL` 为空（注意 `export`） |
| 一直看到 `HTTP 404` | `LLM_BASE_URL` 多写了 `/chat/completions`，或少了 `/v1` |
| 一直看到 `HTTP 401/403` | key 无效或没权限访问该模型 |
| 台词看起来像模板 | 已在降级；看服务端 stderr 的 `[llm-brain]` warn 行定位原因 |
| 模型输出被大量丢弃 | 换更强的模型，或调低 `LLM_TEMPERATURE`（如 `0.3`） |

> 真实模式的协作纪律由 engine 决定，模型只负责“说什么”和“怎么交接”。
> 因此即使模型持续失败，任务依然会按场景跑完 —— 这是有意设计。
