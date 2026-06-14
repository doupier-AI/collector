# Domain Docs

Collector 采用 single-context 领域文档布局。桌面端、浏览器扩展、本地 API、存储和模型网关共享同一套产品语言。

## 开始工程任务前

按任务相关性读取：

1. 根目录 `CONTEXT.md`：统一领域术语与不变量；
2. `docs/adr/`：已经确认的架构决策；
3. `docs/PROGRAM_PLAN.md`：产品范围与用户承诺；
4. `docs/ARCHITECTURE.md`：目标技术架构；
5. `docs/IMPLEMENTATION_TRANSITION.md`：迁移期临时约束。

如果 `CONTEXT.md` 或 `docs/adr/` 尚不存在，继续执行任务，不把缺失本身视为阻塞。只有在术语或架构决策实际得到确认时，才由相应生产 Skill 创建或更新它们。

## 目录布局

```text
/
├── CONTEXT.md
├── AGENTS.md
└── docs/
    ├── adr/
    ├── agents/
    │   ├── domain.md
    │   ├── issue-tracker.md
    │   └── triage-labels.md
    ├── PROGRAM_PLAN.md
    └── ARCHITECTURE.md
```

## 使用领域术语

- Issue 标题、设计说明、测试名称和重构建议应使用 `CONTEXT.md` 的规范术语；
- 不为同一概念随意创造近义词；
- 需要的新概念不在词汇表时，先判断它是实现细节还是确实缺少的领域概念；
- 确认存在领域缺口后，再通过 `grill-with-docs` 或 `ubiquitous-language` 更新文档。

## ADR 冲突

若方案与现有 ADR 冲突，必须明确指出所冲突的 ADR、重新讨论的证据和迁移影响，不得静默覆盖历史决策。
