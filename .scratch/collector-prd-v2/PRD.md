# Collector PRD 2.0 本地实施索引

Status: ready-for-human
Category: enhancement
Resolution: open

> **文件职责：** `docs/PROGRAM_PLAN.md` 是唯一正式产品 PRD。本文件保留 `PRD.md` 名称只是为了符合本地 `to-issues` Tracker 约定，仅负责索引实施任务，不得复制或改写产品需求。

## Canonical sources

- 产品需求：[`docs/PROGRAM_PLAN.md`](../../docs/PROGRAM_PLAN.md)
- 目标架构：[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)
- 实现差距审计：[`docs/IMPLEMENTATION_GAP_AUDIT.md`](../../docs/IMPLEMENTATION_GAP_AUDIT.md)
- AI 工作流契约：[`docs/WORKFLOW_CONTRACTS.md`](../../docs/WORKFLOW_CONTRACTS.md)

## Implementation objective

将现有“逐条抽取、关系建议、用户审核”流程迁移为 PRD 2.0 的核心闭环：

```text
原始材料
→ 近期收集分组
→ 用户固化专题
→ 生成带引用的专题文档
→ 集中核验与版本更新
```

本地 Tracker 中的 Issues 按端到端纵向切片拆分。每个任务完成后必须能够独立演示或验证，不按数据库、API、前端等技术层横向拆分。

## Issues

1. [`01-recoverable-local-workflow.md`](issues/01-recoverable-local-workflow.md)
2. [`02-single-window-application-shell.md`](issues/02-single-window-application-shell.md)
3. [`03-material-library-and-search.md`](issues/03-material-library-and-search.md)
4. [`04-material-history-and-trash.md`](issues/04-material-history-and-trash.md)
5. [`05-recent-organization.md`](issues/05-recent-organization.md)
6. [`06-promote-cluster-to-topic.md`](issues/06-promote-cluster-to-topic.md)
7. [`07-generate-topic-document.md`](issues/07-generate-topic-document.md)
8. [`08-verify-key-claims.md`](issues/08-verify-key-claims.md)
9. [`09-incremental-document-update.md`](issues/09-incremental-document-update.md)
10. [`10-ai-usage-and-budget.md`](issues/10-ai-usage-and-budget.md)
11. [`11-local-data-export-and-backup.md`](issues/11-local-data-export-and-backup.md)
12. [`12-retire-legacy-knowledge-review.md`](issues/12-retire-legacy-knowledge-review.md)

## Comments

- 2026-06-14：用户确认将 Issue Tracker 从 GitHub Issues 改为本地 Markdown。
