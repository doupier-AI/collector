# 在单窗口中接入近期整理状态与快照

Status: ready-for-agent
Category: enhancement
Type: AFK
Resolution: completed

## Parent

[`01-recoverable-local-workflow.md`](01-recoverable-local-workflow.md)

## What to build

在已经确认并实现的单窗口应用壳中接入本地近期整理路径。用户从“近期收集”触发“立即整理”，查看排队、处理中、完成或失败状态，并在完成后看到未归类材料范围。界面只展示产品状态，不暴露 WorkflowStep、租约或内部 ID。

## PRD acceptance path

- 场景 B：步骤 1–3，用户在统一应用中触发整理、查看状态和未归类材料。
- 场景 E：步骤 2，失败时仍显示上一成功结果和明确重试入口。

## Acceptance criteria

- [ ] “近期收集”提供单一“立即整理”动作，并避免重复点击创建重复运行。
- [ ] 页面展示排队、处理中、完成或失败状态，不展示内部 step 名称。
- [ ] 完成后展示未归类材料数量和可进入材料详情的范围。
- [ ] 失败时继续展示上一成功快照，并提供明确的重新整理动作。
- [ ] Renderer 只通过受限 Preload IPC 调用本地服务，不直接访问 SQLite。
- [ ] 导航、整理触发、状态刷新、失败保留和真实 SQLite 结果进入 GUI smoke。

## Blocked by

- [`01b-recover-local-recent-workflow.md`](01b-recover-local-recent-workflow.md)
- [`02-single-window-application-shell.md`](02-single-window-application-shell.md)

## Comments
