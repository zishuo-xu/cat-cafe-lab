# 真实案例报告：order-service 三 bug 修复（两种引擎对照）

> 📅 **2026-10-20** · 真实模型实测，不是剧本演出
>
> 目的：用一个**真的会红**的仓库验证「提需求 → 成员协作 → 真实工具 → 评审打回 →
> commit → merge」整条链路，并对比两种引擎（CLI / API）。

---

## 一、案例设计

`order-service` 是一个真实的小仓库，初始状态下 `node --test test/` **7 个测试全红**：

| 文件 | 埋的 bug | 对应测试 |
|---|---|---|
| `src/csv.js` | 导出无 UTF-8 BOM；不转义逗号/引号/换行 | 3 条 |
| `src/pagination.js` | page 0 基（应从 1 开始）；越界不收敛；size 无上限 | 3 条 |
| `src/cache.js` | TTL 多除 1000 → 永不过期 | 1 条 |

需求原文（提给平台）：

> order-service 仓库有三个真 bug，跑 `node --test test/` 可以看到 7 个测试全红。请修复到全绿，要求：
> 1) csv 带 UTF-8 BOM + RFC 4180 转义；2) pagination page 从 1 开始、越界返回空、size 上限 100；
> 3) cache TTL 单位是毫秒。验收：`node --test test/` 全过；不许改测试迁就实现；只碰这三个源文件。

仓库绑定为**读写工作区**，任务自动建分支 `deliverylab/<taskId>`。

---

## 二、CLI 引擎（`claude -p`）

| 项 | 值 |
|---|---|
| 模型 | deepseek-v4.1-flash（CLI 内部路由） |
| 总耗时 | **215s** |
| 模型调用 | 17 次 / 193s |
| 工具调用 | 32 次 |
| token | in 90.9k / out 20.8k |
| 降级 | 2 次 |
| 结果 | **7/7 绿** → commit `6f63161` → merge `0dccc8a` |

过程里真实发生了评审打回：沈砚退回 pagination 非法参数一条，陈实改完重跑，复验通过才收尾。

**这次跑出两个平台缺陷**（已修）：

1. prompt 里透传了内置剧本 id（`场景 id：export_csv`），模型在产物标题/评语里开始编
   「导出 CSV v2」「权限在 service 层兜住了」——需求明明是修 bug。
2. 轨迹里 `kind: "artifact"` 有两种来源（消息 / 产物），消息条目没有 `meta`。

---

## 三、API 引擎（opencode zen · `deepseek-v4.1-flash`）

### 第 1 轮：修复前（暴露 3 个缺陷）

| 项 | 值 |
|---|---|
| 总耗时 | 380s |
| 模型调用 | 22 次 |
| 工具调用 | 48 次 |
| 降级 | **2 次** |
| 结果 | 7/7 绿，但过程不可信 |

问题：

1. **降级污染共享记忆**：降级退回演出台词后，剧本自带的「导出走异步 / 权限在 service 层
   再判一次」被写进共享记忆（需求明明是修 bug）。
2. **流式响应被提前断开**：流没有 `finish_reason` 就结束，JSON 断在半句
   （实测 `len=93`），解析失败 → 整轮降级。
3. **`status=done / stage=working` 卡死**：评审 approve 时先 `beginStage(done)`、
   `status` 仍是 active，架构师这一轮又发交接去补 minor，趁窗口把阶段拉回 working。

### 第 2 轮：修复后（干净跑）

| 项 | 值 |
|---|---|
| 总耗时 | **140s** |
| 模型调用 | 19 次 |
| 工具调用 | 36 次 |
| 降级 | **0 次** |
| 共享记忆 | 只有 1 条自动摘要，无剧本污染 |
| 结果 | **7/7 绿** → commit `2e4f5c8` → merge `38f50f6`，终态 `done/done` |

评审同样打回了一次（「没看到最终源码，分页边界必须亲眼看」），改完复验两次才签字。

---

## 四、对照

| | CLI 引擎 | API 引擎（修复前） | API 引擎（修复后） |
|---|---|---|---|
| 总耗时 | 215s | 380s | **140s** |
| 模型调用 | 17 | 22 | 19 |
| 工具调用 | 32 | 48 | 36 |
| 降级 | 2 | 2 | **0** |
| 终态 | done/done | done/done | done/done |
| 记忆可信 | 是 | **否（剧本污染）** | 是 |
| 代码结果 | 7/7 绿 | 7/7 绿 | 7/7 绿 |

**结论**：

- 两种引擎都能把真实仓库改对（7/7 绿 + 可合并），**瓶颈不在模型能力，在平台的健壮性**。
- CLI 引擎每次调用起步约 20k input token（CLI 自带系统提示），API 引擎更省、也更快。
- 真实模型会**超额完成**：验收已过后仍想补 minor——这正是「done 阶段是终态」要挡的。

---

## 五、这轮真跑修掉的 5 个缺陷

| # | 缺陷 | 修法 | 回归测试 |
|---|---|---|---|
| 1 | prompt 透传剧本 id，模型跑偏 | 真实模式不再传 `scenarioId` | 断言 prompt 不含内部 id |
| 2 | 轨迹条目分不清消息/产物 | 消息带 `meta.messageId`，产物带 `meta.artifactId` | 两类条目可区分 |
| 3 | 降级轮把剧本决策写进共享记忆 | 降级轮的 `decision/memory` 不落库；摘要标注降级 | 降级轮记忆为空 + 摘要标注 |
| 4 | 流式被提前断开就降级 | 无 `finish_reason` / 解析失败时改用非流式重试一次 | 截断流 → 非流式成功；双失败才降级 |
| 5 | done 阶段仍派活导致阶段回退卡死 | `routeHandoffs` 与交接落库都判 `stage === "done"` | 终态不回退、不留无效交接卡 |

---

## 六、仍然存在的小问题（未修，记录在案）

- **模型会在工作区留临时文件**：API 那轮留下 `tmp_probe.mjs`（4 行探针脚本）并被一起提交。
  提交确认弹窗目前不列出「将要提交的文件清单」，人不容易发现。属于体验改进项。
- **降级后的演出台词质量**：降级轮只保证「不污染记忆」，但对话里仍会出现与需求无关的剧本台词
  （界面有红色「降级 N」徽标、任务轨迹可查）。这是有意的取舍：宁可看得见地降级，也不要静默失败。
- **CLI 引擎成本**：每次调用约 20k 起步 token，长任务比 API 贵一个量级。

---

## 七、复现方式

```bash
# CLI 引擎
LLM_BASE_URL=http://127.0.0.1:1/v1 LLM_MODEL=<model> LLM_API_KEY=cli \
  PORT=4410 DELIVERYLAB_DATA_DIR=/tmp/dl-real node src/main.ts
curl -X PUT localhost:4410/api/settings -H 'content-type: application/json' \
  -d '{"mode":"llm","engine":"cli","toolApproval":"auto"}'

# API 引擎（以 opencode zen 为例）
LLM_BASE_URL=https://opencode.ai/zen/go/v1 LLM_MODEL=deepseek-v4.1-flash \
  LLM_API_KEY=<key> LLM_HEADERS='{"x-opencode-session":"deliverylab-x"}' \
  PORT=4413 DELIVERYLAB_DATA_DIR=/tmp/dl-api node src/main.ts
```

然后绑定一个**真的会失败的**仓库，把失败现象和验收标准写进需求，剩下交给成员。
