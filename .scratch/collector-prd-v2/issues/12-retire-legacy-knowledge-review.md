# 迁移历史数据并移除旧关系审核流程

Status: ready-for-agent
Category: enhancement
Type: AFK
Resolution: completed

## Parent

[`../PRD.md`](../PRD.md)

## What to build

在 PRD 2.0 新闭环全部可用后，停止写入并移除旧的 KnowledgeItem、RelationSuggestion、ReviewProposal 和 Relation 审核主流程。旧记录按明确规则迁移、归档或保留只读，不自动当作已验证事实。删除旧 UI、API、测试和无用表后，清理临时迁移文档，并再次校验 PRD、架构和实际行为一致。

## PRD acceptance path

- 场景 A–E：完成全部新路径后移除旧流程，不产生功能回退。

## Acceptance criteria

- [ ] 新功能代码不再创建 KnowledgeItem、ReviewProposal 或正式 Relation。
- [ ] 旧 Capture、Artifact、Fragment、模型调用和用户设置完整保留。
- [ ] 旧知识项和关系具有明确迁移或只读归档报告，不被自动升级为事实。
- [ ] 删除旧关系审核页面、IPC、API 路由和写入逻辑。
- [ ] 用新闭环测试替换旧关系行为测试，保留数据迁移回归覆盖。
- [ ] 删除不再使用的表前存在可验证备份和 migration 回滚策略。
- [ ] 删除 `docs/IMPLEMENTATION_TRANSITION.md`，更新差距审计为完成状态。
- [ ] PRD、架构、用户界面术语和实际运行流程一致。
- [ ] 全量测试、隔离 GUI smoke、打包 smoke 和真实数据升级验收通过。

## Blocked by

- [`03-material-library-and-search.md`](03-material-library-and-search.md)
- [`04-material-history-and-trash.md`](04-material-history-and-trash.md)
- [`05-recent-organization.md`](05-recent-organization.md)
- [`06-promote-cluster-to-topic.md`](06-promote-cluster-to-topic.md)
- [`07-generate-topic-document.md`](07-generate-topic-document.md)
- [`08-verify-key-claims.md`](08-verify-key-claims.md)
- [`09-incremental-document-update.md`](09-incremental-document-update.md)
- [`10-ai-usage-and-budget.md`](10-ai-usage-and-budget.md)
- [`11-local-data-export-and-backup.md`](11-local-data-export-and-backup.md)

## Comments
