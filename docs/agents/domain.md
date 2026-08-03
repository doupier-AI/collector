# Domain Docs

Collector 采用单一领域上下文。WebUI、API、存储与模型网关共享 `CONTEXT.md` 中的产品语言；联网搜索由模型供应商能力提供，归一后同样进入该上下文。

## 开始工程任务前

按任务相关性读取：

1. 根目录 `CONTEXT.md`：纯领域词汇表，统一定义术语，不描述实现状态；
2. `docs/PROJECT.md`：唯一现行事实入口——产品定义、基线、四态能力表、活动父 Issue、当前限制与待产品决定；
3. `docs/adr/`：关键、难逆转、有真实取舍的决策留痕；
4. `docs/ARCHITECTURE.md`：目标技术架构；
5. `docs/HUMAN_ACCEPTANCE_STANDARD.md`：人工验收要求。

## 目录布局

```text
/
├── AGENTS.md
├── CONTEXT.md
└── docs/
    ├── agents/
    ├── adr/
    ├── archive/
    ├── PROJECT.md
    ├── ARCHITECTURE.md
    └── HUMAN_ACCEPTANCE_STANDARD.md
```

## 使用领域术语

- Issue 标题、设计说明、测试名称和重构建议使用 `CONTEXT.md` 的规范术语；
- 同一概念使用同一个名称；
- 新概念先区分产品概念与实现细节；
- 经过确认的产品概念同步进入 `CONTEXT.md` 词汇表。

## 架构决策

稳定的架构决策进入 `docs/ARCHITECTURE.md`。难逆转、有真实取舍、需要保留决策背景的决策在 `docs/adr/` 记录 ADR。
