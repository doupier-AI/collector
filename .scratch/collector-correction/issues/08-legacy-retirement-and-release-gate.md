# 迁移旧数据并完成发布门禁

Status: ready-for-agent
Category: enhancement
Type: AFK
Resolution: open

## What to build

在新闭环完整可用后归档旧知识审核数据，删除旧写入路径，并完成真实升级和打包验收。

## Acceptance criteria

- [ ] 旧 KnowledgeItem、ReviewProposal、Relation 有明确只读归档或迁移报告。
- [ ] 新代码不再创建旧知识项、提案或永久关系。
- [ ] 删除旧 UI、IPC、Client、API 写入路径和主流程测试。
- [ ] 删除旧表前存在备份、升级和回滚验证。
- [ ] 删除 dist 后构建、全量测试、GUI smoke、pack smoke 全绿。
- [ ] 使用真实旧数据副本完成升级，材料和专题文档无丢失。
- [ ] 更新实现差距审计，PRD、架构、UI 与测试术语一致。

## Blocked by

- `07-incremental-update-usage-and-data.md`

