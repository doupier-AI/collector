# 增量更新专题文档并保护用户编辑

Status: ready-for-agent
Category: enhancement
Type: AFK
Resolution: open

## Parent

[`../PRD.md`](../PRD.md)

## What to build

当专题材料发生新增、删除或修订时，系统计算受影响章节和引用，只生成增量更新预览。用户编辑过的段落默认受保护；用户确认预览后创建新的主文档版本。删除唯一引用时保留陈述并标记依据缺失，所有版本均可查看和回退。

## PRD acceptance path

- 场景 D：步骤 1–4，新材料确认、更新预览、编辑保护和版本恢复。
- 场景 A：步骤 4，材料编辑或删除对后续整理正确生效。

## Acceptance criteria

- [ ] 新材料只产生待确认加入建议，不自动进入专题或改写文档。
- [ ] 比较前后材料集合并定位受影响章节和引用。
- [ ] 用户编辑段落具有保护标记，自动补丁不能覆盖。
- [ ] 默认生成增量补丁；全文重写只能由显式用户动作触发。
- [ ] 删除唯一引用时对应陈述显示依据缺失，不静默消失。
- [ ] 材料永久删除前的影响摘要包含受影响文档章节，并链接到本次更新预览。
- [ ] 更新预览明确展示增加、修改、保留和冲突内容。
- [ ] 用户确认后创建新版本，旧版本可查看和恢复。
- [ ] 同一专题的文档生成和更新互斥，重复确认不会创建重复版本。

## Blocked by

- [`04-material-history-and-trash.md`](04-material-history-and-trash.md)
- [`07-generate-topic-document.md`](07-generate-topic-document.md)

## Comments
