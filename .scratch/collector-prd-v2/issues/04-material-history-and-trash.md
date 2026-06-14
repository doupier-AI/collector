# 实现材料编辑历史与回收站

Status: ready-for-agent
Category: enhancement
Type: AFK
Resolution: open

## Parent

[`../PRD.md`](../PRD.md)

## What to build

让用户能够编辑原始材料的可编辑内容，同时保留每次修订；支持移入回收站、恢复和永久删除。删除前展示当前已经存在的引用影响；依赖报告接口必须可扩展，但本切片不预先实现尚不存在的专题文档更新行为。

## PRD acceptance path

- 场景 A：步骤 4，批量整理前编辑或删除材料。
- 场景 D：为步骤 4 的文档版本恢复和引用影响提供材料历史基础。

## Acceptance criteria

- [ ] 材料编辑创建新修订记录，旧内容可查看且不被静默覆盖。
- [ ] 默认删除进入回收站，支持恢复和永久删除。
- [ ] 永久删除前返回当前存在的专题成员、工作流输入和其他引用影响；没有引用时明确显示无影响。
- [ ] 删除专题不删除其引用的原始材料。
- [ ] 被删除或修改的材料不会被后续近期整理当作当前有效输入。
- [ ] 所有写入具备事务和并发版本检查。
- [ ] UI、API 和 SQLite 测试覆盖编辑、回收、恢复、影响提示和永久删除。

## Blocked by

- [`03-material-library-and-search.md`](03-material-library-and-search.md)

## Comments
