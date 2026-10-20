# 文档索引

协作交付台的完整文档。按「我现在想解决什么问题」来查。

> 📌 **先分清两类文档**：
> - **下面前六组 = 描述系统当前状态**，随代码更新；
> - **[reports/](reports/README.md) = 历史测试快照**，记录某次测试发现了什么，**不代表现状**。

---

## 一、入门（新读者从这里开始）

| 文档 | 解决什么问题 | 篇幅 |
|---|---|---|
| [getting-started.md](getting-started.md) | 5 分钟跑起来、10 分钟看懂它在干什么 | 334 行 |
| [architecture.md](architecture.md) | 整体分层、模块职责、关键取舍 | 250 行 |

**推荐路径**：getting-started 跟着点一遍 → architecture 理解设计。

---

## 二、理解协作机制（这个项目的核心）

| 文档 | 解决什么问题 | 篇幅 |
|---|---|---|
| [engine.md](engine.md) | 事件驱动、阶段状态机、ReAct、审批、巡查、stall 判定 | 412 行 |
| [data-model.md](data-model.md) | 核心类型、状态结构、持久化边界 | 659 行 |

**推荐路径**：先读 engine 的「阶段状态机」和「Wake 8 种 purpose」两节，
这两块理解了，其他机制都是它们的延伸。

---

## 三、动手改代码

| 文档 | 解决什么问题 | 篇幅 |
|---|---|---|
| [development.md](development.md) | 加工具/场景/端点/测试的菜谱、调试技巧、常见坑 | 411 行 |
| [frontend.md](frontend.md) | 前端结构、状态管理、9 类 UI 机制、事件委托 | 443 行 |
| [api.md](api.md) | 54 个 HTTP 端点、两个 SSE 流、错误格式 | 927 行 |

**推荐路径**：development 的「四套菜谱」→ 你要改的那一块的专门文档。

---

## 四、部署与接模型

| 文档 | 解决什么问题 | 篇幅 |
|---|---|---|
| [deployment.md](deployment.md) | 10 个环境变量、持久化、安全边界、排障表 | 420 行 |
| [llm.md](llm.md) | 真实模式配置、prompt 构造、失败降级 | 284 行 |
| [mcp.md](mcp.md) | MCP 接入、鉴权、示例 server | 256 行 |

**⚠️ 部署前必读**：[deployment.md](deployment.md) 的「安全边界」——当前**没有用户鉴权**。

---

## 五、出问题先看这里

| 文档 | 解决什么问题 | 篇幅 |
|---|---|---|
| [known-issues.md](known-issues.md) | 能力边界（设计取舍 vs 缺陷）、21 个已修问题 | 125 行 |

**这是唯一一份「描述当前缺陷」的文档**。用之前建议先扫一眼。

---

## 六、历史测试报告（不代表现状）

| 报告 | 日期 | 现在还有用的部分 |
|---|---|---|
| [reports/real-model-test-report](reports/real-model-test-report.md) | 2026-10-18 | 11 个真实缺陷的根因 |
| [reports/user-scenario-test](reports/user-scenario-test.md) | 2026-10-19 | 第一次使用会踩的坑 |
| [reports/full-test-report](reports/full-test-report.md) | 2026-10-20 | 性能剖面（模型思考占 62%） |

详见 [reports/README.md](reports/README.md)。

---

## 按角色选读

**我想快速判断这项目值不值得看**
→ [getting-started](getting-started.md) 跑一下 → [reports/user-scenario-test](reports/user-scenario-test.md) 看它真跑起来什么样

**我想理解它怎么设计的**
→ [architecture](architecture.md) → [engine](engine.md) → [data-model](data-model.md)

**我要改协作逻辑**
→ [engine](engine.md)（重点看阶段机与 wake）→ [development](development.md)（测试菜谱）

**我要改界面**
→ [frontend](frontend.md) → [api](api.md)（数据从哪来）

**我要接自己的模型**
→ [deployment](deployment.md) 配置 → [llm](llm.md) 行为 → [known-issues](known-issues.md) 已知的 provider 差异

**我要部署给别人用**
→ [deployment](deployment.md)（**特别注意安全边界**）→ [known-issues](known-issues.md)（能力边界）

---

## 截图

`images/` 下是各时期的截图，共 38 张。`uat-` 开头的是用户场景测试时期的，
`ft-` 是全量测试时期的，其余是功能开发各阶段的记录。
