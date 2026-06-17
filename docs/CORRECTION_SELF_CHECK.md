# Collector 纠偏自检与防伪完成规范

日期：2026-06-15

## 1. 每轮开工前

- 阅读 `AGENTS.md`、`docs/PROGRAM_PLAN.md`、`docs/ARCHITECTURE.md`、
  `docs/WORKFLOW_CONTRACTS.md` 和当前纠偏 Issue。
- 运行 `git status --short`，记录已有用户修改，不得重置。
- 运行项目检查和相关测试，记录真实失败基线。
- 写明本轮唯一用户可见终点，以及 input -> persistence -> processing -> API -> UI 路径。
- 确认本轮没有增加 PRD 之外的新实体、导航或自动行为。

## 2. 实施规则

### 源码与构建

- 只修改源码，通过构建生成 dist。
- 禁止手工 patch dist。
- 禁止用 `@ts-ignore` 隐藏缺失模块或错误契约。
- 新增模块必须能在删除 dist 后重新生成。
- 不使用 shell 或 Python 重写源码文件，手工编辑使用 patch。

### 数据

- Artifact 和原始来源不可变。
- 编辑通过修订版本表达，并定义当前有效版本。
- migration 必须事务化、可重复启动、失败保留旧数据。
- 删除前计算真实依赖；删除不能让已发布文档静默改变。

### AI

- Fake Provider/FakeVerifier 只能由测试显式注入。
- 所有模型输出经过 Schema 和 Fragment 引用校验。
- 失败只更新运行状态，不写正式文档或正式领域结果。
- 每次调用记录 ModelCall；重试成本累计。
- 预算检查不能阻止本地保存和解析。

### UI

- 普通界面只使用“原始材料、近期收集、专题、专题文档”。
- 技术字段放在默认折叠诊断区。
- UI 成功状态必须等待持久化确认。
- API 存在不等于用户功能存在；必须有 Electron 可达入口。

## 3. 绝对禁止的伪完成方式

- 为让测试通过而降低或删除验收断言。
- mock 被测模块本身，仅证明 mock 返回了预期值。
- 在生产路径硬编码测试结果、空 cluster、固定摘要或示例来源。
- 用字符串截断拼接冒充摘要、聚类或专题文档。
- 只断言 status 200、queued 或表存在，不验证最终业务产物。
- 因 GUI smoke 失败而跳过测试、扩大 timeout 或改成只看 toast。
- 把未实现功能标为“后续提供”，同时把 Issue 设为 completed。
- 为绕过模型调用而直接写数据库中的最终产物。
- 使用聊天中出现过的 API Key。

## 4. 每轮验证矩阵

| 变更 | 最低验证 |
| --- | --- |
| 采集 | UI 提交、SQLite 记录、Capture ID 回查、失败保留草稿 |
| 材料编辑 | revision 历史、当前内容、Fragment 重建、搜索与下游读取 |
| 删除 | 影响预览、回收站、恢复、文档缺失引用标记 |
| 近期整理 | 黄金样本、无关材料不聚类、快照事务、重启恢复 |
| 专题 | cluster 身份校验、成员确认、不创建永久关系 |
| 文档 | 真实 step 输出、引用校验、失败无正式版本、版本历史 |
| 核验 | offline、超时、无来源、真实 adapter、禁止假来源 |
| 更新 | 无关段落保留、保护段落不变、引用删除、回退 |
| 成本 | ModelCall 与真实 provider 请求一一对应、重试累计、预算暂停 |
| 打包 | 删除 dist 后构建、portable 启动、全新 profile 数据路径 |

## 5. 必跑命令

```powershell
npm.cmd test
powershell -ExecutionPolicy Bypass -File .agents\skills\collector-engineering\scripts\check-project.ps1
npm.cmd run test:gui
```

涉及打包或发布时再运行：

```powershell
npm.cmd run pack
```

真实 DeepSeek 请求不是常规测试的一部分。只有用户明确授权并提供已轮换的运行时 Key 时执行。

## 6. 完成汇报模板

每个 Issue 结束时必须报告：

1. 修改了哪些源码文件。
2. 完成了哪条用户路径。
3. 哪些测试真实运行以及结果。
4. 是否进行了 GUI 验证、打包验证、真实模型调用。
5. 仍存在的限制和风险。
6. 为什么满足 Issue 每一条验收标准。

不允许只写“tests pass”或“backend complete”。

## 7. 独立验证 Agent 检查重点

- 从验收标准反推测试，不复述实施 Agent 的自我说明。
- 删除 dist 后重建，检查是否依赖残留文件。
- 搜索 `TODO`、`@ts-ignore`、FakeVerifier、硬编码 example.com、`slice(0,`。
- 检查 UI 是否真实可达，而不是只有 API。
- 检查数据是否写入隔离 SQLite，而不是内存对象或旧实例。
- 检查失败路径是否保护原始材料和已有正式版本。
- 发现任一 P0/P1 问题时，不得批准 Issue completed。

