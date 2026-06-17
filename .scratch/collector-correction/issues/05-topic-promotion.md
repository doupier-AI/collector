# 从经校验的近期分组固化专题

Status: ready-for-agent
Category: bug
Type: AFK
Resolution: open

## What to build

用户从真实快照选择分组或手动选择材料创建专题，所有成员变更保持用户确认。

## Acceptance criteria

- [ ] from-cluster 服务端读取 snapshot 与 cluster index。
- [ ] 客户端不能篡改 cluster material IDs。
- [ ] 同一材料可属于多个专题但只保存一份。
- [ ] 新材料只产生待确认建议，不自动加入。
- [ ] 专题页面支持成员管理、重命名、归档和主文档状态。
- [ ] 不创建永久语义关系。

## Blocked by

- `04-recent-organization.md`

