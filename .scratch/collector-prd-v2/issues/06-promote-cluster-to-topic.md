# 将近期分组固化为专题

Status: ready-for-agent
Category: enhancement
Type: AFK
Resolution: completed

## Parent

[`../PRD.md`](../PRD.md)

## What to build

用户可以从近期分组保存一个长期专题，也可以从全部材料中选择材料创建专题。创建前展示并允许调整材料范围。专题保存名称、已确认材料和待确认的新材料；同一材料可被多个专题引用。系统只建议新材料加入，不自动改变专题成员。

## PRD acceptance path

- 场景 B：步骤 4，浏览不会产生专题。
- 场景 C：步骤 1–2，固化专题并调整材料范围。

## Acceptance criteria

- [ ] 只有“保存为专题”或“生成专题文档”等明确动作才创建专题。
- [ ] 创建前可查看、增加和移除候选材料。
- [ ] 同一材料可属于多个专题，底层不复制原始内容。
- [ ] 专题成员变化具有审计记录和并发版本检查。
- [ ] 新材料只进入待确认建议，接受后才成为正式成员。
- [ ] AI 不能自动重命名、拆分、合并或归档专题。
- [ ] 专题页面显示成员来源和当前主文档状态，不显示永久语义关系。
- [ ] API、SQLite 和 GUI 测试覆盖从近期分组固化及手工创建两条路径。

## Blocked by

- [`05-recent-organization.md`](05-recent-organization.md)

## Comments


## Resolution

Backend API + tests: topic-creation.test.ts passes (7/7).
