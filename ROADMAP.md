# ROADMAP

当前版本：四猫协作工作台（演出 + 真实对话 + 沙盒真干活）。

接下来的三步由铲屎官选定：**A 真实模式工具调用 → B MCP + Skills → C 真实仓库/多工作区**。

---

## A. 真实模式工具调用 + 铲屎官审批

**目标**：真实模式下，猫不只是说话，而是主动调用工具干活；模型发起的工具调用可以进审批队列。

现状（已完成的部分）：

- 工具层已有：`read_file` / `write_file` / `list_files` / `run_command`，路径锁沙盒、命令白名单、超时；
- 剧本里的工具节拍已经真实执行（金渐层写文件、砚砚跑测试）；
- 但真实模式（LLM）只输出对话类 turn，不会调用工具。

要做：

1. **工具目录进 prompt**：四个工具的用途、input schema、风险说明；模型可以请求工具。
2. **ReAct 回喂**：driver 执行工具后，用 `trigger.kind = "tool_result"` 再叫同一只猫，
   模型看到 exitCode / output 再决定下一步（最多连续 3 轮）。
3. **审批闸门**：模型发起的 `run_command`（或按策略所有工具）先挂起为 `pending`，
   铲屎官在工具卡上点「批准执行 / 拒绝」；拒绝不执行，结果回喂给模型。
4. **审批策略**：`auto`（全自动）/ `commands`（跑命令才批，默认）/ `all`（全批）。
   剧本工具永远自动放行——脚本是作者写的，模型决定才需要人把关。
5. **Needs Me**：待审批数量徽标 + 定位到 pending 卡。

验收：

- 真实模式（假端点即可）模型请求 `write_file` + `run_command`，审批通过后真实执行、
  结果回喂、猫基于结果继续；拒绝后猫换方案。
- 演出模式行为完全不变（不弹审批）。
- 审批接口 404/503 降级正常；桌面 + 手机可用。

状态：**已完成**（2026-10-18）。实现：工具目录进 prompt、ReAct 回喂（首轮 + 最多 3 轮）、
审批闸门与策略、Needs Me、审批 UI；132 个测试全绿。

---

## B. MCP + Skills 工具注册表

**目标**：工具不再是写死的四个，而是注册表 + provider；接 MCP server，每只猫挂不同技能包。

要做：

1. `ToolRegistry`：`{ name, description, inputSchema, risk, execute }`，沙盒工具变成一个 provider；
2. MCP client：支持 stdio / HTTP 两种 transport，把 MCP server 的工具动态注册进来；
3. 每猫工具权限：宪宪写 spec、砚砚跑测试、金渐层读写代码、烁烁只读设计资源；
4. Skills：按猫挂 prompt 包（TDD、review 清单、设计规范），按需加载；
5. 设置面板新增「工具与技能」：MCP server 列表、每猫工具开关。

验收：至少接一个真实 MCP server（filesystem 或 fetch），猫能通过它读文件/取网页；
关闭 MCP 时整套流程仍能跑。

状态：**已完成**（2026-10-18）。实现：ToolRegistry（内置 + MCP provider）、stdio/http MCP 客户端、
/MCP 管理 API 与设置 UI、每猫工具白名单、四个技能包注入真实模式 prompt；161 个测试全绿。

---

## C. 真实仓库 / 多工作区

**目标**：一个房间 = 一个真实仓库，猫在分支上改代码、出 diff、跑测试，权限分级。

要做：

1. 工作区管理：每个房间绑定一个仓库路径，沙盒从 `data/workspace` 换成真实仓库（只读/读写/拒绝三种权限）；
2. Git 集成：任务开始时建分支，猫的改动落工作区，砚砚 review 真实 diff，宪宪决定是否 commit；
3. 审批升级：写文件默认审批、危险命令二次确认、`git push` 永远需要人工；
4. 多房间并发：driver 从每房间串行扩展到多房间隔离，任务看板显示各房间状态；
5. 回滚：一键丢弃某个任务的改动。

验收：在一个测试仓库上完成「提需求 → 猫改代码 → 跑测试 → 出 diff → 人工 approve → commit」全链路，
不需要人手动执行任何命令；误操作可一键回滚。

状态：**已完成**（2026-10-18）。C-1：工作区模型/权限分级、多房间绑定与隔离、只读 git 状态/diff/文件。
C-2：任务分支 `deliverylab/<taskId>`、真实 diff、人工确认 commit（提交后回 base、分支保留）、
stash 可恢复回滚；只读/脏树/未收尾分支都有明确拒绝。181 个测试全绿。

---

---

## D. 收尾轮（可继续）

- **真实 provider 联调**：见 [real-model.md](./docs/real-model.md)，需要真实 key；
- ~~房间编辑/解绑~~：已完成（PATCH / DELETE /api/rooms/:id + 左栏房间菜单）；
- ~~MCP 鉴权~~：已完成（stdio env / http headers，值不泄露）；
- 下一步候选：任务分支 merge 收尾 UI、MCP server 市场示例、多用户/鉴权。

## 不做清单（现阶段）

- 不做公网多租户、不做计费、不接真实支付；
- 不做自动 merge 到主分支（C 阶段 commit 也要人工确认）；
- 不做语音/IM（之前评估过，属于产品变厚之后的层）。
