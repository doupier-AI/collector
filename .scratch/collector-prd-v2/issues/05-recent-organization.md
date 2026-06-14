# 生成可恢复的“近期收集”分组

Status: ready-for-agent
Category: enhancement
Type: AFK
Resolution: open

## Parent

[`../PRD.md`](../PRD.md)

## What to build

在 Issue 01 的可恢复近期快照上增加有限候选召回和 AI 分组，完成候选分组、分组校验、稳定性处理和新快照发布。主界面展示临时名称、一句话概括、材料数量、代表性材料和未归类内容。分组属于可重算快照，不创建专题或永久知识关系。

## PRD acceptance path

- 场景 B：步骤 1–4，形成临时方向、保留无关材料且浏览不固化专题。
- 场景 E：步骤 1–2，遵守单条云处理禁用，且模型失败不破坏材料或上一快照。

## Acceptance criteria

- [ ] 用户可手动“立即整理”，系统也支持可配置的批量触发策略。
- [ ] 输入只包含当前有效且允许对应处理方式的材料，并保存材料集合版本。
- [ ] checksum 和近重复候选避免重复观点被放大。
- [ ] 一个材料在一个快照中最多属于一个主要分组。
- [ ] 明显无关或不可靠归属的材料进入未归类集合。
- [ ] 新快照尽量保持仍成立分组的名称和身份稳定。
- [ ] 工作流失败时继续显示上一成功快照和更新时间。
- [ ] 分组不会创建 Topic、Relation 或修改原始材料。
- [ ] 固定验收样本验证相关、重复、冲突、无关和来源不明材料。

## Blocked by

- [`01-recoverable-local-workflow.md`](01-recoverable-local-workflow.md)
- [`03-material-library-and-search.md`](03-material-library-and-search.md)

## Comments
