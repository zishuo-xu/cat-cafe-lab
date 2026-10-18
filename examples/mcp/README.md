# 示例 MCP server

零依赖，直接 `node` 运行，只实现 MCP 需要的 `initialize` / `tools/list` / `tools/call`。

## 猫咖记事本 · notes-server.mjs

| 工具 | 作用 |
|---|---|
| `list_notes` | 列出笔记标题 |
| `read_note { title }` | 读一篇笔记 |
| `write_note { title, content }` | 写/覆盖一篇笔记 |

在猫咖「设置 → MCP 工具」里添加：

- transport：`stdio`
- command：`node`
- args：`<仓库绝对路径>/examples/mcp/notes-server.mjs`
- 风险等级：`safe`（不想它随便写就选 `needs_approval`）

笔记存在同目录 `notes.json`。
