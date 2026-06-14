# 通过受保护 API 发布首个本地近期快照

Status: ready-for-agent
Category: enhancement
Type: AFK
Resolution: open

## Parent

[`01-recoverable-local-workflow.md`](01-recoverable-local-workflow.md)

## What to build

提供一条不调用云模型的最小真实整理路径：已配对客户端触发“立即整理”后，系统冻结当前有效原始材料集合，创建持久化工作流记录，执行本地精确去重，并发布一个把非重复材料全部列入未归类集合的 `RecentClusterSnapshot`。调用方可通过受保护 API 查看当前运行状态和最新成功快照。

本切片只证明 SQLite、服务、执行器和受保护 API 能形成完整结果，不接入当前即将替换的旧三窗口界面，也不实现租约恢复、取消或 AI 分组。

## PRD acceptance path

- 场景 B：步骤 1、3，用户触发整理后得到保留未归类材料的近期快照。
- 场景 E：步骤 2，整理不修改或删除原始材料。

## Acceptance criteria

- [ ] `WorkflowRun`、`WorkflowStep`、`ModelCall` 和 `RecentClusterSnapshot` 使用正式 SQLite 表及显式 migration 持久化。
- [ ] 受保护 API 可以触发一次 `recent_organization` 运行，并读取用户可理解的排队、处理中、完成或失败状态。
- [ ] 工作流保存固定的有效材料 ID 集合和可重复计算的材料集合版本。
- [ ] 本地精确去重使用稳定 checksum；每组重复材料只保留一个代表材料进入快照。
- [ ] 首个快照不伪造 AI 分组，所有代表材料明确进入 `unclusteredMaterialIds`。
- [ ] 相同工作流类型、幂等键和材料集合版本只返回一个有效运行。
- [ ] 发布快照和完成运行在事务边界内保持一致，不产生“运行完成但快照不存在”的状态。
- [ ] 原始材料、Artifact 和 Fragment 不被工作流覆盖或删除。
- [ ] API 鉴权、空材料集合、重复材料、幂等触发和成功发布有集成测试。

## Blocked by

None - can start immediately.

## Comments

