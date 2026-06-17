# Collector 实现纠偏计划

日期：2026-06-15

状态：执行基线

## 1. 文档职责

本文只规定如何把当前实现纠正到 `docs/PROGRAM_PLAN.md`、`docs/ARCHITECTURE.md` 和
`docs/WORKFLOW_CONTRACTS.md` 已确认的产品边界。本文不修改产品定位，也不增加新功能。

正式需求仍以以下文件为准：

1. `docs/PROGRAM_PLAN.md`
2. `docs/ARCHITECTURE.md`
3. `docs/WORKFLOW_CONTRACTS.md`
4. `docs/IMPLEMENTATION_GAP_AUDIT.md`

旧 `.scratch/collector-prd-v2/issues/` 中的 `Resolution: completed` 只表示当时的实现 Agent
宣称完成，不能作为验收事实。纠偏工作使用 `.scratch/collector-correction/` 下的新 Issue。

## 2. 当前真实状态

### 2.1 可以保留的基础能力

- Electron 单主窗口、托盘和全局快捷键已有基本结构。
- Chromium 扩展、桌面粘贴和文件上传已有采集适配器。
- SQLite、Artifact、Capture、Fragment、鉴权和迁移框架可继续使用。
- URL 安全边界、文件大小限制和解析器已有一定测试基础。
- WorkflowRun、WorkflowStep、RecentClusterSnapshot、TopicDocumentVersion 等表结构已经出现。
- DeepSeek Provider、Fake Provider 和基础 token/cost 字段可以复用。

### 2.2 不可视为完成的能力

- 当前桌面工作台仍是旧版 Inbox/Relation/ReviewProposal UI。
- `workspace-renderer.ts` 已删除，运行依赖被 Git 忽略的残留 dist 文件。
- “近期整理”不会生成分组，所有材料只进入 unclustered。
- 专题文档只截断拼接原文，不执行真实整理工作流。
- 专题文档任务创建后不会自动执行或在启动时恢复。
- 生产核验固定使用 FakeVerifier，会生成虚假来源。
- 增量更新预览未持久化，确认链路和段落保全存在错误。
- ModelCall、预算和设置页没有贯通真实调用。
- 全部材料 CRUD 主要停留在 API，桌面端没有完整可达路径。
- 数据导出、备份和数据位置没有形成用户可用闭环。

### 2.3 当前验证基线

- `npm.cmd test`：60/61，通过失败项为 schema version 仍断言 v9，实际已到 v11。
- `npm.cmd run test:gui`：失败，文本提交后等待 SQLite 持久化超时。
- Collector project check：在移除 `start.ps1` 明文 Key 前失败；后续必须重新运行。
- 工作区存在未提交修改，不允许通过重置或覆盖方式清理。

## 3. 核心纠偏原则

### 3.1 用户可见领域只保留四种形态

- 原始材料
- 近期收集
- 专题
- 专题文档

`Fragment`、`AgentRun`、处理等级、证据等级、模型错误和 token 明细只能进入折叠诊断区。
`KnowledgeItem`、`ReviewProposal`、`Relation` 不得重新成为主流程。

### 3.2 采集与 AI 解耦

提交成功只取决于原始材料已经写入 SQLite。解析、整理和模型失败不得导致草稿丢失，
也不得把“请求已发送”当作“材料已保存”。

### 3.3 不允许占位实现冒充完成

以下行为一律视为未实现：

- 用前 N 个字符拼接代替模型整理。
- 使用 Fake Provider 或 FakeVerifier 产生生产可见结果。
- 只创建 API 路由或数据库表，没有用户可达流程。
- 只验证 HTTP 200，不验证 SQLite 中的真实结果。
- 通过 `@ts-ignore`、手工修改 `dist` 或残留构建产物绕过缺失源码。
- 测试只断言任务被创建，不断言最终产物正确。

## 4. 目标信息架构

单个 Electron 主窗口包含：

1. **近期收集**：近期快照、临时分组、零散材料、整理状态。
2. **专题**：专题材料范围、待确认材料、主文档和版本。
3. **全部材料**：搜索、详情、编辑、修订、回收站和删除影响。
4. **设置**：通用、AI、成本预算、数据和诊断。

快捷键进入同一窗口的紧凑采集状态。退出紧凑状态后恢复进入前所在页面。

## 5. 分阶段修改方案

### 阶段 0：安全与可重现基线

目标：任何后续修改都建立在干净、可重现、无明文凭据的工程基线上。

修改：

- 撤销曾出现在聊天和 `start.ps1` 中的 DeepSeek Key。
- 启动脚本不写入 Key 或固定 master token；Key 只从 safeStorage 或临时环境获得。
- 恢复 `workspace-renderer.ts` 的源码所有权，删除对 ignored dist 残留的依赖。
- 构建前清理各 workspace 的 dist，证明全新构建可以生成全部运行文件。
- 修复 migration 测试，使其验证所需表和当前显式 schema version。
- 修复 GUI smoke 的启动、端口、profile、instance ID 和数据库路径隔离。
- project check、unit tests、GUI smoke 全部纳入强制门禁。

验收：

- 新 clone 或删除 dist 后能够构建并启动。
- 项目扫描不发现凭据。
- `npm.cmd test` 全绿。
- `npm.cmd run test:gui` 至少证明文本和文件采集真实写入隔离 SQLite。

### 阶段 1：移除旧主流程并建立正确应用壳

目标：让桌面端的页面结构与 PRD 一致。

修改：

- 删除 Inbox、知识条目、关系审核、正式关系、单条 L3 深度分析的主界面入口。
- 保留旧表和旧 API 的只读迁移能力，但停止新增用户可见写入路径。
- 将一级导航改为“近期收集 / 专题 / 全部材料 / 设置”。
- Renderer 与 preload 按 `materials/recent/topics/documents/settings/shell` 能力划分。
- 正确处理 `shell:mode`，进入 compact 时只展示采集区；退出后恢复真实先前路由。
- 不在此阶段做视觉精修，只保证功能结构和可访问性。

验收：

- 普通用户界面不出现 Capture、Fragment、AgentRun、L0-L3、证据等级和永久关系。
- 快捷键不会创建第二窗口。
- 从任意页面进入采集并退出后恢复原页面。

### 阶段 2：可靠采集与全部材料 CRUD

目标：先完成产品最基础、必须离线可用的闭环。

修改：

- 提交后用返回的 capture ID 再验证持久化；失败时保留草稿和附件。
- 同一 checksum 不创建第二份原始材料；返回已有材料并记录重复采集事件或轻量反馈。
- 全部材料页面接入 list/detail/search/revisions/trash/restore/delete-impact/delete。
- 编辑生成修订版本，同时明确“当前有效内容”；重新解析 Fragment，并使后续工作流读取当前版本。
- 删除影响同时检查 Topic membership、TopicDocument citation、未完成 workflow 输入。
- 永久删除后保留必要审计，文档引用标记缺失，不能静默消失。

验收：

- PRD 场景 A 全部通过。
- 编辑后的内容可被搜索、近期整理和专题文档读取。
- 删除受引用材料前展示准确影响；删除后文档显示引用缺失。

### 阶段 3：真实近期整理

目标：交付动态、轻量、非永久的近期关注方向。

修改：

- 实现完整步骤：freeze、local dedup、candidate retrieval、cluster proposal、validation、
  stabilization、publish。
- 使用独立 `RecentClusterProposal` Schema，不能复用旧 KnowledgeExtraction。
- 无可靠归属的材料进入 unclustered；不得强制形成主题。
- 快照发布必须事务化；失败继续展示上一成功快照。
- 触发策略支持手动“立即整理”，随后再增加节奏策略，不能每条材料都执行旧抽取。
- UI 展示分组名称、概括、材料数量、代表材料和零散材料。

验收：

- 相关、无关、重复、来源不明材料的黄金样本输出稳定。
- 查看快照不会创建 Topic。
- 重启可以恢复未完成任务，且不重复发布。

### 阶段 4：专题与材料确认

目标：用户明确把临时方向固化为长期容器。

修改：

- `from-cluster` 必须读取并校验真实 snapshot 和 cluster index，不能信任客户端传入材料列表。
- Topic 只包含用户确认的材料。
- 新材料只生成待确认加入建议，不自动加入。
- 同一材料可属于多个专题，底层只存一份。
- 专题页面支持成员增删、归档、重命名，并显示主文档状态。

验收：

- 错误 snapshot、越界 cluster 或篡改 material IDs 会被拒绝。
- 保存专题不创建永久语义关系。

### 阶段 5：真实专题文档工作流

目标：生成可阅读、忠于材料、带引用的主文档。

修改：

- 创建后立即调度；启动时恢复 queued/processing topic_document workflow。
- 工作流严格实现契约中的 freeze、citation check、outline、section draft、merge、
  key claim extraction、verification、validation、publish。
- 每个 step 使用独立结构化 Schema；长输入按章节和预算分步。
- `run` 必须直接保存 `topicId`，发布时禁止通过共享材料反查 Topic。
- 文档版本只有在最终校验通过后发布。
- UI 能阅读主文档、展开引用、查看版本历史和材料缺口。

验收：

- 不能再出现 `slice(0, 500)` 作为正式文档生成逻辑。
- 每个关键陈述回到现有 Fragment。
- 模型失败不产生正式版本；重启从 checkpoint 恢复。

### 阶段 6：真实性核验

目标：核验结果诚实、受控、不会伪造。

修改：

- FakeVerifier 只能通过测试依赖注入使用，生产构造不得引用。
- offline 策略明确展示“未核验”。
- verify_only 使用受限真实 adapter，记录查询、来源 URL、访问时间和失败。
- 核验失败不阻止文档发布，但不得标记 supported。
- 结果使用自然语言呈现，不宣称绝对真理。

验收：

- 生产代码搜索不到 `new FakeVerifier()`。
- 断网、超时、空来源均产生 not_checked/insufficient，不产生虚假网址。

### 阶段 7：增量更新、成本和数据控制

目标：完成 PRD 场景 D、E。

修改：

- 修复材料集合版本读取，预览必须先持久化再返回。
- 未受影响段落全部保留；用户保护段落不能被覆盖。
- 删除唯一引用时标记依据缺失。
- 每次真实模型调用写 ModelCall，并关联 WorkflowRun、WorkflowStep 和用途。
- 重试累计 token/cost；预算检查发生在 AI step 领取前，超限进入 waiting_for_budget。
- 设置页显示本月用量、费用、成功率、模型分布和预算提醒。
- 实现数据位置、完整备份、恢复验证和不含凭据的导出。

验收：

- 增量更新不丢失无关段落，版本可回退。
- AI Usage 与真实调用记录一致。
- 禁用 AI 后采集、查看、编辑、删除和导出仍可用。

### 阶段 8：旧数据迁移与最终清理

目标：结束双模型并存，恢复单一领域语言。

修改：

- 为旧 KnowledgeItem、ReviewProposal、Relation 生成只读归档或迁移报告。
- 停止并删除旧写入路径、IPC、Client 方法、UI 和相关主流程测试。
- 经过备份与迁移验证后再考虑删除旧表。
- 更新 `IMPLEMENTATION_GAP_AUDIT.md`；仅在迁移结束后清理过渡文档。

验收：

- 新代码中不存在旧关系流程入口。
- PRD、架构、界面术语、API 和测试表达同一套产品模型。

## 6. 推荐提交顺序

每个提交只完成一个可验证目标：

1. `security: remove leaked runtime credentials`
2. `build: restore source-owned workspace renderer`
3. `test: restore green migration and GUI capture gates`
4. `feat: replace legacy inbox navigation with product IA`
5. `feat: complete material library and revision semantics`
6. `feat: implement recent organization workflow`
7. `feat: promote validated clusters to topics`
8. `feat: generate recoverable cited topic documents`
9. `feat: add honest verification adapter boundary`
10. `feat: preserve documents through incremental updates`
11. `feat: connect model usage budget and data controls`
12. `chore: archive and remove legacy relation workflow`

禁止把多个阶段压进一次巨大提交。

## 7. 完成定义

Collector 只有同时满足以下条件才可宣称 PRD 2.0 首版完成：

- 场景 A-E 均从 Electron UI 可完成，不依赖手工 HTTP 请求。
- 单元、API、迁移、Fake Provider、GUI smoke、打包 smoke 全绿。
- 删除 dist 后仍可完整构建。
- 没有明文凭据、测试替身生产化或旧 Inbox 主流程。
- 真实数据升级演练通过，用户材料无丢失。
- 真实云模型验收使用用户重新生成、仅运行时提供的 Key，并得到明确授权。

