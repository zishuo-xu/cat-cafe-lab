# 测试工具

真实模型下才暴露的问题，靠这两个脚本驱动复现。

```bash
# 1. 起一个真实实例（不要把 key 写进文件）
LLM_BASE_URL=https://api.deepseek.com \
LLM_MODEL=deepseek-flash \
LLM_API_KEY=sk-... \
PORT=4320 CATCAFE_DATA_DIR=/tmp/catcafe-real node src/main.ts

# 2. 跑矩阵（可指定场景）
cd tools
python3 matrix.py --scenario all --out /tmp/matrix.json
python3 matrix.py --scenario basic,reject --out /tmp/matrix.json
```

## 场景

| 名称 | 验证什么 |
|---|---|
| `basic` | 完整任务：模型自主调用工具、审批、评审、收尾 |
| `reject` | 全拒绝审批：模型不重复申请同一命令 |
| `nudge` | 卡住后「催一下」能否恢复 |
| `rooms` | 多房间隔离：消息/任务不串 |
| `concurrent` | 同房间两个任务排队（不应被误判卡住） |
| `invalid` | 空/超长/短需求/未知房间/提示注入 |
| `permission` | 移除某猫工具权限后的行为 |
| `memory` | 跨任务记忆复用 |
| `notools` | 关闭工具执行后任务仍能收尾 |

`matrix.py` 会自动批准或拒绝审批（每个场景不同策略），并把结果写到 `--out`。

> 注意：测试会真实调用 provider，按次计费；`basic` 单场景约 100~180s。
