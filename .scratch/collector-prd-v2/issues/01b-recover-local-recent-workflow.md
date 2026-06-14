# 恢复、取消并隔离本地近期整理运行

Status: ready-for-agent
Category: enhancement
Type: AFK
Resolution: completed

## Parent

[`01-recoverable-local-workflow.md`](01-recoverable-local-workflow.md)

## What to build

在首个本地近期快照路径上补齐可靠执行语义：执行器通过原子状态转换和租约领取 step，应用在步骤之间退出后可以从最后一个已完成步骤继续；用户可以取消尚未完成的运行；失败运行不会覆盖上一成功快照，并允许重新触发。

## PRD acceptance path

- 场景 B：步骤 1、3，批量整理在重启或重试后仍只发布一个有效快照。
- 场景 E：步骤 2，失败和取消不影响原始材料或上一成功结果。

## Acceptance criteria

- [x] 执行器使用原子状态转换和到期租约领取 step，两个实例不能同时执行同一步骤。
- [x] step 输出和状态推进在同一事务中提交。
- [x] 应用在任一步骤完成后退出，重启只继续后续步骤，不重复发布快照。
- [x] 到期租约可由新执行器安全接管，未到期租约不可重复领取。
- [x] 用户取消后不再开始后续 step，已完成审计记录继续保留。
- [x] 失败运行保存脱敏错误，且不覆盖上一成功快照。
- [x] 失败或取消后用户可以使用新的幂等键重新触发。
- [x] 受保护 API 可读取当前运行、最近失败和最新成功快照，但不暴露内部 step 名称。
- [x] 测试覆盖恢复、双实例竞争、租约到期、取消、失败隔离和重新触发。

## Blocked by

- [`01a-publish-local-recent-snapshot.md`](01a-publish-local-recent-snapshot.md)

## Comments

## Comments

- 2026-06-14: 实现完成。原子租约领取、跨重启恢复、双实例隔离、失败不覆盖快照、取消支持均已实现。新增 6 个测试，全 69 测试通过。
