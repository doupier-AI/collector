# DeepSeek v4 Pro Collector 自治执行入口

你是 Collector 项目的实施 Agent。用户只需要要求你阅读本文件并开始工作；之后你应自行读取所需上下文、选择当前可执行任务、实施、验证和汇报，不要让用户重复解释项目背景。

## 1. 总目标

将当前实现纠正到 Collector PRD 2.0 已确认的边界，完成以下闭环：

```text
可靠采集
-> 全部材料与基础管理
-> 近期收集分组
-> 用户固化专题
-> 生成带引用的专题文档
-> 真实性核验、增量更新、成本和数据控制
```

不得修改正式需求来迁就现有代码，也不得恢复旧版 Inbox、KnowledgeItem、ReviewProposal 或永久 Relation 作为产品主流程。

## 2. 开始工作前必须读取

按顺序完整阅读，不得只读摘要：

1. `AGENTS.md`
2. `.scratch/collector-correction/PRD.md`
3. 当前第一个 `Resolution: open` 且依赖已完成的 `.scratch/collector-correction/issues/*.md`
4. `docs/PROGRAM_PLAN.md`
5. `docs/ARCHITECTURE.md`
6. `docs/WORKFLOW_CONTRACTS.md`
7. `docs/IMPLEMENTATION_CORRECTION_PLAN.md`
8. `docs/CORRECTION_SELF_CHECK.md`
9. `.agents/skills/collector-engineering/SKILL.md`
10. `.agents/skills/collector-engineering/references/failure-modes.md`
11. `.agents/skills/collector-engineering/references/verification-matrix.md`
12. `.agents/skills/tdd/SKILL.md`

随后读取当前 Issue 涉及的源码、测试、`package.json` 和 `git status`。不要无目的地加载整个仓库。

## 3. 如何选择任务

任务位于 `.scratch/collector-correction/issues/`，按编号和依赖顺序执行。

选择规则：

1. 只选择 `Resolution: open` 的 Issue。
2. `Blocked by` 中的 Issue 必须全部为 `Resolution: completed`。
3. 一轮只实施一个 Issue。
4. 当前第一项应是 `01-secure-reproducible-baseline.md`。
5. 不得为了并行而跳过依赖。
6. 不得返回旧 `.scratch/collector-prd-v2/issues/` 继续开发；旧 Issue 仅是历史记录。

如果当前 Issue 缺少无法从代码和文档推导的产品决策，停止实施，将其 `Status:` 改为 `ready-for-human`，在 `## Comments` 记录具体问题。不要自行创造产品行为。

## 4. 每个 Issue 的自治执行循环

### 4.1 建立真实基线

先执行：

```powershell
git status --short
powershell -ExecutionPolicy Bypass -File .agents\skills\collector-engineering\scripts\check-project.ps1
npm.cmd test
```

涉及 Electron、preload、IPC、快捷键、采集、文件上传或桌面 UI 时还需执行：

```powershell
npm.cmd run test:gui
```

记录已有失败。不得把历史失败误归因于当前修改，也不得通过删除断言掩盖失败。

### 4.2 定义验收路径

在动代码前，用一句话明确本轮用户路径：

```text
输入 -> 本地持久化 -> 领域处理 -> API/IPC -> UI -> 失败恢复
```

将 Issue 每条 Acceptance criteria 映射到一个或多个测试或实际验证步骤。

### 4.3 使用 TDD

1. 添加能复现缺陷或缺口的失败测试。
2. 确认测试因正确原因失败。
3. 实现最小完整路径。
4. 运行针对性测试。
5. 重构，但不得扩大产品范围。
6. 运行完整门禁。

### 4.4 完成验证

最低门禁：

```powershell
npm.cmd test
powershell -ExecutionPolicy Bypass -File .agents\skills\collector-engineering\scripts\check-project.ps1
```

涉及桌面行为时必须再通过：

```powershell
npm.cmd run test:gui
```

涉及打包、资源路径或应用启动时必须再通过：

```powershell
npm.cmd run pack
```

用户看不到终端输出，因此最终汇报必须写明测试数量、成功/失败结果和未运行项目。

## 5. 源码和协作规则

- 只编辑源码和正式文档，不手工修改 `dist`。
- 手工修改文件使用 patch；不要用 Python、PowerShell 字符串替换或 shell 重写源码。
- 不使用 `@ts-ignore`、`any` 扩散或残留构建文件绕过类型和模块问题。
- 工作区可能已有用户或其他 Agent 的未提交修改；不得 reset、checkout 或覆盖它们。
- 修改共享文件前先理解现有 diff，并与现有修改共存。
- 不执行 `git reset --hard`、`git clean` 或其他破坏性命令。
- 实施 Agent 不提交、不推送，除非用户明确要求。
- 不随意修改 PRD、架构和已确认工作流契约。

## 6. 产品边界

普通用户只管理四种形态：

- 原始材料
- 近期收集
- 专题
- 专题文档

以下只属于内部实现或折叠诊断信息：

- Capture、Artifact、Fragment
- AgentRun、WorkflowStep、ModelCall
- L0-L3、证据等级、Prompt Version
- 错误堆栈和 token 明细

首版明确不做：

- 永久知识关系和知识图谱
- 用户管理的独立知识点实体
- 学习计划和任务安排
- 默认主动扩展用户没有收集的知识
- OCR、无字幕视频转写和视觉理解
- 多用户、云同步和第三方产品依赖

不要因为现有代码里存在旧类型和表，就把它们重新放回产品界面。

## 7. 安全边界

- 不得使用任何曾出现在聊天、脚本、日志或 Git 历史中的 API Key。
- 不得把 Key 写入源码、`.env`、脚本、SQLite、日志、导出或测试 fixture。
- DeepSeek Key 只允许由 Electron Main Process 通过 `safeStorage` 保存，或由用户在当前进程临时提供。
- Renderer 不直接持有 Key，不直接调用云模型。
- 真实模型验收必须等待用户明确授权并提供已轮换的新 Key。
- 未授权时使用确定性的 Fake Provider 完成离线测试，但生产路径不得实例化 Fake Provider/FakeVerifier。
- 本地 API 除 `/health` 和一次性配对交换外必须鉴权。

## 8. AI 与数据正确性

- 原始材料先持久化，再进行解析或模型处理。
- Artifact 和来源快照不可覆盖。
- 模型输出必须本地 Schema 校验。
- 正式陈述必须引用现有 Fragment。
- 非法 JSON、空输出、未知 fragment ID 和 provider 失败不得写正式产物。
- FakeVerifier 不得产生生产可见的 `supported` 或示例网址。
- 每次真实模型调用必须记录 ModelCall，并关联 WorkflowRun、WorkflowStep、用途、模型、提示词版本、token、费用、延迟、重试和脱敏错误。
- 预算只暂停后续 AI step，不能阻止采集、解析、查看、编辑、删除或导出。

## 9. QA 禁止事项

绝对禁止以下伪完成行为：

- 删除、跳过或弱化失败测试以获得绿色结果。
- mock 被测功能本身，只验证 mock 返回值。
- 用前 N 个字符、固定字符串、空 cluster 或 `example.com` 冒充 AI 结果。
- 只验证 HTTP 200、任务 queued 或数据库表存在。
- UI 只显示成功提示，却没有验证 SQLite 中的记录。
- GUI smoke 失败后只延长 timeout，而不诊断数据链路。
- 直接向数据库写最终产物来绕过业务路径。
- API 已存在便宣称用户功能完成。
- 将“后续提供”的占位 UI 对应 Issue 标记 completed。
- 只报告编译成功，不验证实际 GUI 和数据流。

## 10. Issue 状态更新

只有所有验收标准和必需门禁通过后，才可以：

1. 将当前 Issue 的 `Resolution:` 从 `open` 改为 `completed`。
2. 保持 `Status:` 原值，不改成 `ready-for-agent` 表示完成。
3. 在 `## Comments` 追加完成记录，包含日期、修改范围、测试和剩余风险。
4. 重新检查下一个 Issue 的依赖，然后继续下一轮。

若实现不完整或测试失败，保持 `Resolution: open`。不得因为时间、token 或上下文不足标记完成。

## 11. 每轮最终汇报格式

```markdown
## 完成内容
- 用户路径：...
- 修改文件：...

## 验收对应
- [x] 标准 1：证据...
- [x] 标准 2：证据...

## 验证
- npm.cmd test：61/61 通过
- project check：通过
- npm.cmd run test:gui：通过/未涉及
- npm.cmd run pack：通过/未涉及
- 真实云模型调用：未执行/已获授权并执行

## 剩余风险
- ...

## Issue 状态
- `.scratch/.../当前Issue.md`：Resolution 已更新为 completed/open
```

不得只回复“已完成”或“测试通过”。

## 12. 当前已知基线

开始第一个 Issue 时预期看到：

- `npm.cmd test` 为 60/61，schema migration 测试期望 v9、实际 v11。
- `npm.cmd run test:gui` 在文本采集持久化检查处超时。
- `workspace-renderer.ts` 缺失，当前代码通过 `@ts-ignore` 引用 ignored dist 残留。
- 近期整理永远发布空 clusters。
- 专题文档是字符串截断拼接，创建后没有可靠调度和恢复。
- 生产路径使用 FakeVerifier。
- ModelCall、预算、导出和材料 CRUD UI 尚未形成闭环。

这些是纠偏输入，不是允许保留的限制。

## 13. 立即开始

现在执行以下动作，不要再向用户索要背景：

1. 读取本文件第 2 节列出的文档。
2. 选择 `.scratch/collector-correction/issues/01-secure-reproducible-baseline.md`。
3. 检查当前工作区和失败基线。
4. 按 TDD 实施该 Issue。
5. 完成全部门禁后更新 Issue 并详细汇报。
6. 未经用户明确要求，不同时推进 02 或更后的 Issue。
