# 提供本地数据位置、导出与备份

Status: ready-for-agent
Category: enhancement
Type: AFK
Resolution: completed

## Parent

[`../PRD.md`](../PRD.md)

## What to build

在设置页面向用户显示 Collector 的实际数据目录，并提供两种明确不同的数据操作：完整备份用于恢�?Collector；便携导出用于以 Markdown、JSON 和原始附件读取或迁移个人内容。操作必须基于一致性快照，不能导出模型 Key、本地鉴�?Token 或其他凭据�?
该切片同时实现备份恢复验证，避免只生成一个未经证明可用的压缩文件�?
## PRD acceptance path

- 场景 E：步�?4，用户可以导出数据并明确知道本地存储位置�?- 场景 D：步�?4，文档历史版本在完整备份恢复后仍然存在�?
## Acceptance criteria

- [ ] 设置页面显示实际 SQLite、Artifact 和备份目录，不使用模糊的“本地保存”描述�?- [ ] 完整备份包含一致�?SQLite 快照、Artifact 文件和带格式版本�?manifest�?- [ ] 便携导出包含原始材料元数据、专题文�?Markdown、引用映射、用户编辑和允许导出的附件�?- [ ] DeepSeek Key、主 Token、扩�?Token、Token hash 和其他认证材料不进入任何归档�?- [ ] 备份和导出先写入临时目标，完成校验后再原子发布�?- [ ] 失败归档不会出现在有效备份列表，界面显示可操作的失败原因�?- [ ] 使用隔离用户目录执行一次备份恢复，材料、专题、文档版本和附件 checksum 保持一致�?- [ ] 导出格式�?manifest 版本有兼容性测试，不依赖当前数据库内部表名供用户读取�?
## Blocked by

- [`04-material-history-and-trash.md`](04-material-history-and-trash.md)
- [`08-verify-key-claims.md`](08-verify-key-claims.md)
- [`09-incremental-document-update.md`](09-incremental-document-update.md)
- [`10-ai-usage-and-budget.md`](10-ai-usage-and-budget.md)

## Comments
