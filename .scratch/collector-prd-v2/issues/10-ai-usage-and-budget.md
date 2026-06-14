# 提供 AI 用量、费用和预算控制

Status: ready-for-agent
Category: enhancement
Type: AFK
Resolution: completed

## Parent

[`../PRD.md`](../PRD.md)

## What to build

把模型调用观测从单次 AgentRun 明细提升为用户可理解的用量管理。每次调用归属到明确工作流和用途，重试成本累计；设置页面展示本月 token、估算费用、成功率、模型分布和预算状态。预算只限制后续 AI step，不影响原始材料保存、本地解析和已有结果访问。

## PRD acceptance path

- 场景 E：步骤 2–3，失败隔离及本月 token、费用和调用目的可见。
- 场景 B：步骤 1，批量整理成本可归因。

## Acceptance criteria

- [ ] 每次模型调用关联 WorkflowRun、WorkflowStep、用途、模型和提示词版本。
- [ ] 输入、输出、缓存 token、延迟、重试、估算费用和脱敏错误完整记录。
- [ ] 重试和分章节调用按一次业务工作流累计展示。
- [ ] 设置页面显示本月与历史用量、费用、成功率和模型分布。
- [ ] 用户可配置软预算及提醒阈值。
- [ ] 预算不足使待执行 AI step 进入 `waiting_for_budget`，不影响本地功能。
- [ ] 采集和正常阅读流程不展示 token 技术细节。
- [ ] API 聚合、时区边界、重试累计和预算暂停有测试覆盖。

## Blocked by

- [`01-recoverable-local-workflow.md`](01-recoverable-local-workflow.md)
- [`02-single-window-application-shell.md`](02-single-window-application-shell.md)

## Comments
