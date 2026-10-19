# 文档

这个目录放猫咖工作台的全部文档。按「我想解决什么问题」来选。

## 文档地图

| 文档 | 解决什么问题 | 适合谁 |
|---|---|---|
| [getting-started.md](getting-started.md) | 怎么跑、怎么用、界面怎么看 | 第一次接触 |
| [architecture.md](architecture.md) | 整体分层、模块职责、关键取舍 | 想理解设计 |
| [engine.md](engine.md) | 协作引擎：事件驱动、阶段机、ReAct、审批、巡查 | 想改协作逻辑 |
| [data-model.md](data-model.md) | 核心类型、状态结构、持久化边界 | 想知道数据长什么样 |
| [api.md](api.md) | 所有 HTTP 端点、SSE 流、错误格式 | 写脚本或集成 |
| [frontend.md](frontend.md) | 前端结构、状态管理、各类 UI 机制 | 改界面 |
| [development.md](development.md) | 加工具/场景/端点/测试、调试技巧、坑 | 参与开发 |
| [deployment.md](deployment.md) | 环境变量、持久化、安全边界、排障 | 部署或运维 |
| [llm.md](llm.md) | 真实模式配置、prompt 构造、失败降级 | 接模型 |
| [mcp.md](mcp.md) | MCP 接入、鉴权、示例 server | 扩展工具 |
| [real-model.md](real-model.md) | 真实模型联调流程 | 换 provider |
| [real-model-test-report.md](real-model-test-report.md) | 11 个真实缺陷的现象/根因/修法 | 想知道踩过什么坑 |
| [user-scenario-test.md](user-scenario-test.md) | 真实用户模拟测试与发现的问题 | 想知道用户会踩什么坑 |
| [known-issues.md](known-issues.md) | 已知问题、能力边界、修复史 | **用之前建议先看一眼** |

## 几条推荐阅读路径

**想快速判断这个项目值不值得看** →
[getting-started](getting-started.md) 跑一下 → [user-scenario-test](user-scenario-test.md) 看它真跑起来什么样

**想理解它怎么设计的** →
[architecture](architecture.md) → [engine](engine.md) → [data-model](data-model.md)

**想改代码** →
[development](development.md) → [engine](engine.md) → [frontend](frontend.md) 或 [api](api.md)

**想接自己的模型** →
[deployment](deployment.md) 配置 → [llm](llm.md) 行为 → [real-model-test-report](real-model-test-report.md) 已知的坑

## 截图

`images/` 下是按时间积累的截图。最新的用户场景测试截图以 `uat-` 开头。
