# 生成首篇带引用的专题文档

Status: ready-for-agent
Category: enhancement
Type: AFK
Resolution: completed

## Parent

[`../PRD.md`](../PRD.md)

## What to build

用户在专题中触发文档生成后，系统冻结本次材料集合，校验引用基础，生成提纲并按章节整理，最终创建该专题的第一篇主文档版本。文档只整理用户选定材料，呈现共同观点、差异、限制和折叠的材料缺口，不使用模型记忆无标识补齐内容。

## PRD acceptance path

- 场景 C：步骤 3–4、6，生成忠于材料、带引用和折叠缺口的文档。
- 场景 E：步骤 2，模型失败不破坏已有状态。

## Acceptance criteria

- [ ] 用户发起生成时保存固定材料集合版本，后续新材料不混入本次运行。
- [ ] 提纲和章节使用独立结构化 Schema，不再依赖旧 `KnowledgeExtraction`。
- [ ] 长材料按预算分步处理，失败可从已完成 step 恢复。
- [ ] 关键陈述至少引用一个现有 Fragment，用户观点需明确区分。
- [ ] 重复表达被合并，冲突观点作为差异或限制保留。
- [ ] 来源不明材料不会被写成已确认事实。
- [ ] 材料缺口默认折叠且不会生成学习任务。
- [ ] 在集中核验功能尚未实现时，事实性结论明确标记为未核验，不阻塞首版文档生成。
- [ ] 校验通过后创建第一版主文档；失败不产生半成品正式版本。
- [ ] 专题页面可阅读文档并返回对应原始材料。

## Blocked by

- [`01-recoverable-local-workflow.md`](01-recoverable-local-workflow.md)
- [`06-promote-cluster-to-topic.md`](06-promote-cluster-to-topic.md)

## Comments


## Resolution

Backend infrastructure complete: contracts, SQLite v5 migration, API routes, workflow executor. Tests: topic-document.test.ts (3/3 pass).
