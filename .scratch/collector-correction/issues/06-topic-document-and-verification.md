# 生成真实专题文档并建立诚实核验

Status: ready-for-agent
Category: bug
Type: AFK
Resolution: open

## What to build

实现可恢复的带引用专题文档工作流，并把 FakeVerifier 严格限制在测试环境。

## Acceptance criteria

- [ ] workflow run 明确保存 topicId 和固定材料集合。
- [ ] 创建后调度执行，应用重启恢复未完成任务。
- [ ] 提纲、章节、合并和关键结论使用独立结构化 Schema。
- [ ] 不存在字符串截断拼接冒充正式整理。
- [ ] 关键陈述引用现有 Fragment，模型失败不发布正式版本。
- [ ] FakeVerifier 只通过测试依赖注入，生产不生成 example.com 来源。
- [ ] offline/timeout/无来源正确标记未核验或依据不足。
- [ ] 专题 UI 可阅读文档、引用、缺口和版本历史。

## Blocked by

- `05-topic-promotion.md`

