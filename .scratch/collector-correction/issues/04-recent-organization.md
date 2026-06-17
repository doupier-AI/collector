# 实现真实且可恢复的近期整理

Status: ready-for-agent
Category: bug
Type: AFK
Resolution: open

## What to build

以独立 Schema 完成候选召回、临时分组、校验、稳定化和快照发布，不复用旧 KnowledgeExtraction。

## Acceptance criteria

- [ ] 工作流包含契约规定的完整步骤。
- [ ] 相关材料形成分组，无关材料保留为 unclustered。
- [ ] 每组包含名称、概括、材料范围和代表材料。
- [ ] 失败继续展示上一成功快照。
- [ ] 浏览快照不会创建 Topic 或永久关系。
- [ ] 模型调用记录 ModelCall，预算和失败不影响原始材料。
- [ ] 黄金样本、恢复、幂等、取消和 GUI 场景 B 通过。

## Blocked by

- `03-material-crud-and-revisions.md`

