# Triage Labels

工程 Skills 使用以下五种标准角色。右栏是本地 Issue 文件 `Status:` 应使用的实际字符串。

| 标准角色 | 本地状态 | 含义 |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 等待维护者评估 |
| `needs-info` | `needs-info` | 等待报告者补充信息 |
| `ready-for-agent` | `ready-for-agent` | 需求完整，Agent 无需额外上下文即可实施 |
| `ready-for-human` | `ready-for-human` | 需要人工判断或实施 |
| `wontfix` | `wontfix` | 明确不会实施 |

Skill 提到某个角色时，必须使用表中的实际状态字符串，不创建语义重复的状态。

这些状态描述处理责任，不替代 Issue 正文中的功能类型和 AFK/HITL 分类。

每个 Issue 还必须有且仅有一个 `Category:`：

- `bug`：已有行为损坏；
- `enhancement`：新增或改进能力。

`Resolution:` 独立表示任务是否结束，不属于 Triage 状态机。
