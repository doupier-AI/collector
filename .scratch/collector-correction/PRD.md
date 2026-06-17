# Collector PRD 2.0 实现纠偏

Status: ready-for-agent
Category: enhancement
Resolution: open

## Canonical sources

- 产品需求：`docs/PROGRAM_PLAN.md`
- 技术架构：`docs/ARCHITECTURE.md`
- 工作流契约：`docs/WORKFLOW_CONTRACTS.md`
- 纠偏计划：`docs/IMPLEMENTATION_CORRECTION_PLAN.md`
- 自检规范：`docs/CORRECTION_SELF_CHECK.md`

## Objective

移除当前实现中的旧 Inbox/Relation 主流程、占位 AI 产物和不可重现构建，
按既定 PRD 完成“可靠采集 -> 全部材料 -> 近期收集 -> 专题 -> 专题文档 -> 核验与更新”的闭环。

## Issues

1. `issues/01-secure-reproducible-baseline.md`
2. `issues/02-product-information-architecture.md`
3. `issues/03-material-crud-and-revisions.md`
4. `issues/04-recent-organization.md`
5. `issues/05-topic-promotion.md`
6. `issues/06-topic-document-and-verification.md`
7. `issues/07-incremental-update-usage-and-data.md`
8. `issues/08-legacy-retirement-and-release-gate.md`

