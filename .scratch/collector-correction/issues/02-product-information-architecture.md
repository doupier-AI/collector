# 用 PRD 信息架构替换旧收件箱主流程

Status: ready-for-agent
Category: bug
Type: AFK
Resolution: open

## What to build

将单窗口主界面调整为近期收集、专题、全部材料和设置；移除旧知识关系审核的用户入口，
并让紧凑采集正确恢复进入前页面。

## Acceptance criteria

- [ ] 一级导航仅呈现近期收集、专题、全部材料和设置。
- [ ] 普通界面不展示 Inbox、KnowledgeItem、ReviewProposal、Relation、L0-L3 和证据等级。
- [ ] preload/IPC 按能力命名，不继续扩展 legacy workspace review bridge。
- [ ] 快捷键只切换同一窗口 compact 状态。
- [ ] compact 状态只显示采集区，退出后恢复真实先前页面。
- [ ] GUI smoke 覆盖导航、compact 进入与恢复。

## Blocked by

- `01-secure-reproducible-baseline.md`

