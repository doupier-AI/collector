# Domain Docs

Collector 采用单一领域上下文。WebUI、API、存储与模型网关共享 `CONTEXT.md` 中的产品语言；联网搜索由模型供应商能力提供，归一后同样进入该上下文。

## 开始工程任务前

按任务相关性读取：

1. 根目录 `CONTEXT.md`：统一领域术语与不变量；
2. `docs/PRODUCT_REFOUNDATION.md`：产品范围与用户承诺；
3. `docs/PRODUCT_FUNCTION_FLOW.md`：完整功能流程；
4. `docs/INTERACTION_DESIGN.md` 与 `docs/INTERFACE_DIRECTIONS.md`：交互和布局；
5. `docs/ARCHITECTURE.md`：目标技术架构；
6. `docs/DEVELOPMENT_START.md`：当前开发起点；
7. `docs/HUMAN_ACCEPTANCE_STANDARD.md`：人工验收要求。

## 目录布局

```text
/
├── AGENTS.md
├── CONTEXT.md
└── docs/
    ├── agents/
    ├── ARCHITECTURE.md
    ├── DEVELOPMENT_START.md
    ├── HUMAN_ACCEPTANCE_STANDARD.md
    ├── INPUT_SOURCE_FEASIBILITY.md
    ├── INTERACTION_DESIGN.md
    ├── INTERFACE_DIRECTIONS.md
    ├── PRODUCT_FUNCTION_FLOW.md
    └── PRODUCT_REFOUNDATION.md
```

## 使用领域术语

- Issue 标题、设计说明、测试名称和重构建议使用 `CONTEXT.md` 的规范术语；
- 同一概念使用同一个名称；
- 新概念先区分产品概念与实现细节；
- 经过确认的产品概念同步进入领域语言与相关产品文档。

## 架构决策

稳定的架构决策进入 `docs/ARCHITECTURE.md`。需要保留决策背景和取舍时，在 `docs/adr/` 建立独立记录，并在架构正文保留当前结论。
