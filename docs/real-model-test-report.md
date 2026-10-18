# 真实模型测试报告（deepseek-flash）

> 日期：2026-10-18 · provider：DeepSeek · model：`deepseek-flash`（推理型）
> 测试方式：真实实例（端口 4320）+ `tools/matrix.py` 驱动 9 个场景
> 测试脚本：[tools/probe.py](../tools/probe.py)、[tools/matrix.py](../tools/matrix.py)

## 一、结论

真实 provider 下 A/B/C 三层的**机制全部生效**：模型会自主调用工具、会读真实输出、
会遵守审批结果、会基于工具回执继续推理、能调用 MCP 工具。但暴露了 **6 个真实缺陷**，
全部已修复并补了回归测试（201 个测试全绿）。

## 二、发现并修复的缺陷

### 1. 推理型模型 token 预算不足（严重）

**现象**：任务频繁降级到 mock，日志 `模型输出不是可用的 CatTurn[]`。

**证据**：抓包看到 `finish_reason: "length"`、`completion_tokens: 1600`（正好等于
`max_tokens`）、`reasoning_tokens: 1268`——deepseek-flash 的思考链吃掉了 79% 的预算，
台词/JSON 被截断。

**修复**：
- `DEFAULT_MAX_TOKENS` 1600 → 4096；
- 检测到 `finish_reason=length` 时**自动用 8192 重试一次**，仍截断才降级，并给出明确原因；
- 降级日志带上 `finish_reason` 与当前 `max_tokens`，不再是笼统的「缺少 content」。

**回归**：`tests/llm.test.ts` 新增 2 个用例（截断后重试成功 / 连续截断降级）。

### 2. 模型在 JSON 数组后追加人话，整段被丢弃（严重）

**现象**：日志里能看见完整合法的 JSON 数组，却仍报解析失败。

**证据**：模型输出形如
`[{...}] 能跑，但我知道有个坑：先红再绿，得知道测试怎么跑。`
`extractJsonArray` 只在文本**不以** `[` 开头时才裁剪，所以尾巴导致 `JSON.parse` 失败。

**修复**：统一按「第一个 `[` 到最后一个 `]`」切片，前后解说都丢弃；fenced 代码块里的尾巴也能救回。

**回归**：新增 3 个用例（尾部人话 / 前置解说 / 字符串内含 `]`）。

### 3. intake / planning 阶段被工具探索吃掉（严重）

**现象**：任务卡在 `intake`，模型连续 `list_files` / `read_file` 四五轮才肯拆活。

**证据**：抓到的 4 次连续请求全在 `intake` 阶段，每轮都在读文件；
第 4 轮因 token 截断降级，任务停在 intake。

**修复**：
- driver 对 `intake` / `planning` 阶段把 ReAct 回喂上限从 3 降到 **1**（够确认项目结构，
  不够把任务变成「读代码」）；
- system prompt 增加**阶段纪律**：这两步不要读代码/跑命令，最多 `list_files` 一次就交付。

### 4. 沙盒参数限制没告诉模型，导致反复重试（中）

**现象**：模型用 `node -e "import fs from 'fs';..."` 读文件，被沙盒拒绝（参数 >80 字），
然后换写法反复重试。一次任务里出现 **42 次工具调用、9 次审批**。

**修复**：
- `run_command` 的 schema/description 明确写出限制（参数 ≤80 字、不含空格/../绝对路径、
  最多 10 个、不支持 shell 管道重定向）；
- `read_file` 的 description 明确「读文件用这个，不要用 node -e 拼」；
- prompt 增加「同一类操作连续失败两次就停下」。

### 5. 工具连续失败没有硬上限（中）

**现象**：缺陷 4 的连锁反应——模型失败后继续重试，直到耗尽预算。

**修复**：driver 增加 `MAX_CONSECUTIVE_TOOL_FAILURES = 3`：连续 3 次工具失败
（error / rejected）就停止回喂，让模型基于已有信息收尾；有成功则计数归零。

### 6. 同房间排队被误判为「卡住」（中）

**现象**：并发任务场景两个任务都是 `stalled`，其实只是在排队等前一个任务。

**证据**：同房间串行队列里，后一个任务在等前一个跑完；stall watchdog 只看
「任务多久没更新」，把排队等待当成卡死。

**修复**：driver 增加 `roomPending` 计数，watchdog 触发时若该房间还有 wake 在跑或排队，
就**重新计时**而不是标 stalled。

**回归**：`tests/engine.test.ts` 新增「同房间并发任务不该被误标 stalled」。

## 三、场景测试结果（修复后）

| 场景 | 内容 | 结果 |
|---|---|---|
| basic | 完整任务（自动批准） | ✅ 15 次工具调用、3 次审批、116s 完成（修复前：42 次调用 / 超时） |
| reject | 全拒绝审批 | ✅ 模型收到 rejected 后不重复申请同一命令 |
| nudge | 卡住后催一下 | ✅ 可恢复 |
| rooms | 多房间隔离 | ✅ 两个房间任务都 done，消息互不串（修复前 FAIL） |
| concurrent | 同房间两个任务排队 | ✅ 都 done（修复前两个都 stalled） |
| invalid | 空/超长/短需求/未知房间/提示注入 | ✅ 全部按预期 400/正常处理，注入未泄露 prompt |
| permission | 移除工具权限 | ✅ 工具被拒并提示「没有权限使用」，任务仍推进 |
| memory | 跨任务记忆复用 | ✅ 第二个任务引用第一条记忆 |
| notools | 关闭工具执行 | ✅ 0 次工具调用，任务仍可收尾 |

### 7. 模型输出裸对象 / 多个对象拼接（严重）

**现象**：`模型输出不是可用的 CatTurn[]` 高频出现，但模型内容看起来是合法 JSON。

**证据**：日志里能看到两种形态：
- `{"kind":"tool",...}`（没有外层 `[...]`）；
- `{"kind":"tool",...} {"kind":"tool",...}`（多个对象用空格拼接）。

**修复**：`extractJsonArray` 在找不到 `[...]` 时，按平衡花括号切出所有顶层对象再包成数组；
字符串里的 `{` / `}` / 转义引号不会误切。

### 8. 模型把 `cmd` 写成 `command`

**修复**：`run_command` 同时接受 `cmd` 与 `command`。

### 9. 工具不在本轮目录时被静默丢弃 → 整轮降级

**现象**：宪宪（只有 read_file/list_files 权限）请求 `write_file`，turn 被丢弃 →
如果一轮里只有这类 turn，整轮降级到 mock，模型永远学不到「没权限」。

**修复**：内置工具名即使不在 `availableTools` 里也保留，交给 driver 拒绝并回喂
「没有权限使用 write_file」；完全编造的工具名（如 `delete_everything`）仍然丢弃。

### 10. 评审 ↔ 修订无限拉锯

**现象**：reviewer 反复 `request_changes`，任务永远在 revising/reviewing 之间打转；
实测一条任务打回 4 次以上仍未收尾。

**修复**：`MAX_REVISION_ROUNDS = 3`。超过上限后强制收尾（任务置 done），
并把最后一轮评审意见记成 `review-loop` 教训，避免无限消耗预算。

### 11. 重置后残留 wake 抛 `task not found`

**现象**：`/api/reset` 清空任务后，队列里还排着旧的 wake，处理时抛
`Error: task not found`，打断队列。

**修复**：`beginStage` / decision 分支先检查任务是否还存在，不存在就安静跳过。

## 四、仍然存在的限制（未修）

1. **推理型模型慢**：单任务 80–180s，比演出模式慢一个数量级；这是 provider 特性。
2. **模型倾向多轮读文件**：即使加了阶段纪律，working 阶段仍常见 6–8 次 `read_file`，
   属于合理探索但会拖慢节奏。
3. **审批频率**：`commands` 策略下一次完整任务约 3 次审批；想流畅演示用 `auto`。
4. **`nudge` 在审批挂起时无效**：工具在等审批时任务不会被标 stalled，催一下没有意义
   （这是正确行为，但用户可能困惑）。
5. 本次只测了 `deepseek-flash`；非推理模型（如 deepseek-chat）的 token 压力会小很多，
   但没实测。

## 五、复现方式

```bash
cd cat-cafe-lab
LLM_BASE_URL=https://api.deepseek.com \
LLM_MODEL=deepseek-flash \
LLM_API_KEY=sk-... \
PORT=4320 CATCAFE_DATA_DIR=/tmp/catcafe-real node src/main.ts

cd tools
python3 matrix.py --scenario all --out /tmp/matrix.json
```

脚本会打印每个场景 PASS/FAIL 与细节，并把结果写到 `--out`。
