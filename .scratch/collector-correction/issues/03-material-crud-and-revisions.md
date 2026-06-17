# 完成全部材料 CRUD 与修订语义

Status: ready-for-agent
Category: bug
Type: AFK
Resolution: open

## What to build

把已有材料 API 接入桌面端，并纠正编辑、重复和删除影响的领域行为。

## Acceptance criteria

- [ ] 全部材料支持搜索、详情、编辑、修订历史、回收站、恢复和永久删除。
- [ ] 相同 checksum 不创建第二份原始材料。
- [ ] 编辑产生修订并更新当前有效内容与 Fragment。
- [ ] 搜索、近期整理和文档工作流读取当前有效版本。
- [ ] 删除影响包含专题成员、文档引用和未完成 workflow。
- [ ] 删除受引用材料后，文档显示引用缺失而不是静默变化。
- [ ] 场景 A 的自动化与 GUI 验收通过。

## Blocked by

- `02-product-information-architecture.md`

