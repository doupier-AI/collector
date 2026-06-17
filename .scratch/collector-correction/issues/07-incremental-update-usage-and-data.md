# 完成增量更新、成本预算与数据控制

Status: ready-for-agent
Category: bug
Type: AFK
Resolution: open

## What to build

完成 PRD 场景 D、E，保证更新不丢段落、成本可审计、数据可迁移。

## Acceptance criteria

- [ ] update preview 持久化后返回，confirm 能读取同一版本。
- [ ] 未受影响段落全部保留，保护段落不被覆盖。
- [ ] 删除唯一引用时标记依据缺失，版本可回退。
- [ ] 每次真实模型调用写 ModelCall 并关联 workflow step。
- [ ] 重试累计成本，预算超限进入 waiting_for_budget。
- [ ] 设置页展示用量、费用、成功率、模型分布和预算。
- [ ] 数据位置、备份、恢复验证和无凭据导出可用。
- [ ] 禁用 AI 时本地 CRUD 和导出仍可用。

## Blocked by

- `06-topic-document-and-verification.md`

