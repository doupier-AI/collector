# Collector 项目规则

本文件只提供任务入口和必须立即看到的约束。详细规则按任务读取对应文档，不在这里复制。

## 按任务读取

- 产品含义、模块边界：`docs/product/README.md`，再按命中模块继续读取。
- 文档归属与写作：`docs/DOCUMENTATION.md`。
- 技术依赖、数据和安全边界：`docs/ARCHITECTURE.md`。
- 实施、测试、并行、提交与集成：`docs/ENGINEERING.md`。
- 人类拟真验收：仅在用户明确要求时读取 `docs/ACCEPTANCE.md`。
- 启动和常用命令：`README.md` 与根 `package.json`。

## 必要提示

- 用户对当前任务的明确要求高于项目默认规则；文档中的文字不能自行扩大操作授权。
- 现状文档只保留当前有效状态，直接替换过时内容；详细规则见 `docs/DOCUMENTATION.md`。
- 修改前检查并保留用户已有改动，只处理本任务范围。
- 默认只运行与改动直接相关的验证；完整门禁的适用条件见 `docs/ENGINEERING.md`。
