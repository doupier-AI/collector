# 在专题文档生成时集中核验关键结论

Status: ready-for-agent
Category: enhancement
Type: AFK
Resolution: open

## Parent

[`../PRD.md`](../PRD.md)

## What to build

在专题文档工作流中识别有限的关键事实性结论，并根据用户的长期授权策略运行 `VerificationWorkflow`。核验只解决来源支持、争议和时效性，不主动扩展主题。结果映射回对应文档陈述；无法联网或依据不足时仍生成文档，并明确显示不确定性。

## PRD acceptance path

- 场景 C：步骤 5，集中核验且失败不阻止生成。
- 场景 E：步骤 1–2，尊重云端授权且核验失败不破坏已有文档。

## Acceptance criteria

- [ ] 只对进入正式文档的重要事实性陈述核验，观点和偏好可以跳过。
- [ ] `offline` 策略不发起联网请求并返回未核验状态。
- [ ] `verify_only` 策略限制查询数、页面数、超时、响应大小和公开地址范围。
- [ ] 搜索结果默认只保存为核验依据，不自动创建原始材料。
- [ ] 每条结果表示为支持、存在争议、可能过时、依据不足或未核验。
- [ ] 核验失败不阻止文档版本生成，也不修改原始材料。
- [ ] 保存查询、来源 URL、访问时间、结论映射和成本记录。
- [ ] Fake Verification Adapter 覆盖支持、冲突、无结果、超时和未授权路径。

## Blocked by

- [`07-generate-topic-document.md`](07-generate-topic-document.md)

## Comments
