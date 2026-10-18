# 真实模型联调

> 目标：把「真实模式」从"用假端点验证过链路"变成"用真 provider 跑通"。

A / B 两个阶段的核心机制（工具调用、ReAct 回喂、审批闸门、MCP 工具、技能注入）都在本地假端点上
验证过，但真实模型是否会稳定输出符合 schema 的 JSON 数组，**没有用真 key 验证过**。
这份清单就是补这一块。

---

## 0. 前提

- 一个有 `chat/completions` 的 OpenAI 兼容端点（DeepSeek / OpenAI / Moonshot / 百炼 / Ollama 都行）；
- 不需要把 key 写进任何文件：设置面板只存进程内存，或者用环境变量启动。

```bash
cd cat-cafe-lab
LLM_BASE_URL=https://api.deepseek.com/v1 \
LLM_MODEL=deepseek-chat \
LLM_API_KEY=sk-... \
node src/main.ts
```

启动后打开设置 →「测试连接」，确认能列出模型。

---

## 1. 冒烟 A：纯对话（不开工具）

在设置里把审批策略设成 `auto`（避免审批打断），开一个任务：

> 帮我解释一下登录页要加「记住我」要注意什么。

**看三件事**：
1. 左侧徽标变成「真实模式」；
2. 四只猫里只有被唤醒的那只说话，台词不是剧本；
3. 任务能走到某个阶段，不卡死。

**常见失败**：模型返回 markdown 围栏 / 前后解说 → llm-brain 的容错解析应该能救；
若整段被丢弃，会降级到 mock 并在 stderr 打印 `[llm-brain]` 一行。看到降级就说明 JSON 约束没被遵守。

---

## 2. 冒烟 B：单次工具调用

审批策略 `commands`，开任务：

> 读一下 src/export.js，告诉我它导出什么。

期望：模型输出一个 `kind:"tool"` 的 `read_file`，工具卡显示 ✓ 和文件内容；
随后 `tool_result` 回喂第二次，猫基于内容回答。

**如果模型不调用工具**，说明工具目录没进 prompt 或 schema 示例不够——检查 llm-brain 的
【工具目录】段落是否渲染出了 4 个工具。

---

## 3. 冒烟 C：审批闸门

真实模式下请求 `run_command`（比如「跑一下测试」）：

1. 工具卡变 pending，左上角出现 `Needs Me`；
2. 点「批准执行」→ 真实执行 → 输出可见；
3. 再来一次点「拒绝」→ 卡片变 rejected，模型收到 rejected 并换方案（不该重复申请同一命令）。

---

## 4. 冒烟 D：MCP 工具

设置 →「MCP 工具」加一个本地 stdio server（也可以先用自己的测试 server），
给某只猫勾上它的工具，真实模式请求一次。期望 pending → 批准 → 真实 MCP 调用。

---

## 5. 记录什么

每个冒烟跑完，记一行到下面表格（也方便以后回归）：

| 日期 | provider / model | 冒烟 | 结果 | 备注 |
|---|---|---|---|---|
| 2026-10-18 | DeepSeek / deepseek-flash | A 纯对话 | ✅ 通过 | 只唤醒被 @ 的宪宪，内容非剧本，含 HttpOnly/XSS 论证 |
| 2026-10-18 | DeepSeek / deepseek-flash | B 单工具 | ✅ 通过 | 自主 `read_file src/export.js`，回喂后准确回答 `toCsv` 唯一导出 |
| 2026-10-18 | DeepSeek / deepseek-flash | C 审批（批准） | ✅ 通过 | 自主请求 `run_command npm test` → pending → 批准 → 真实执行 exit 1 → 基于真实输出写下 review |
| 2026-10-18 | DeepSeek / deepseek-flash | C 审批（拒绝） | ✅ 通过 | rejected 回喂后**没有重复申请**，改为说明「要么批准、要么你贴输出」 |
| 2026-10-18 | DeepSeek / deepseek-flash | D MCP 工具 | ✅ 通过 | `echo-server__echo` 调用成功，回喂后准确复述 `echo:hello` |

### 实测记录（2026-10-18，deepseek-flash，端口 4320）

- 连接测试：`/models` 211ms，2 个模型可用。
- 一次任务里模型自己完成 `read_file ×5 → list_files → run_command(pending) → 批准 → review → decision`，
  工具调用全部来自模型决策，没有剧本台词混入。
- 拒绝路径表现符合设计：模型明确说「不会重复申请同一个命令」并给出两条替代路径。
- 观察到的问题：
  1. 模型会频繁请求 `run_command`（commands 策略下每次都要审批），一次任务里出现 2 次 pending；
  2. 审批在 review 阶段也会挡一下，节奏变慢；
  3. 个别任务因为审批被拒后没有继续推进，任务停在 `reviewing/active`（可通过「催一下」或再批准继续）。
- 建议：日常演示用 `auto`；要演示审批闸门时用 `commands` 并挑「跑一次就够」的任务。

---

## 6. 还没解决的已知风险

- 模型可能一次性返回多个 tool turn（目前串行执行，最多 3 轮回喂）；
- 模型可能虚构工具名（brain 会丢弃不在 `availableTools` 里的 turn）；
- 不同 provider 对"只输出 JSON 数组"的服从度差异很大，必要时把 temperature 调到 0–0.3。

如果某个 provider 持续不听话，可以在 `llm-brain.ts` 里加 provider 特判（例如 tool calling 原生 API），
但那是后续工作，当前实现坚持"纯 JSON 输出 + 容错解析"。
