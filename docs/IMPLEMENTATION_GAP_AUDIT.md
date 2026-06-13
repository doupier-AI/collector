# Collector PRD 2.0 实现差距审计

日期：2026-06-13

状态：工程实施基线。每完成一个垂直切片同步更新。

## 1. 审计结论

当前程序已经具备可靠采集、来源解析、本地持久化、模型网关和基础安全能力，但产品主流程仍是旧版的“逐条抽取 → 关系建议 → 用户审核”。PRD 2.0 要求的新主流程“近期分组 → 专题 → 专题文档”尚未实现。

现有代码不适合整体推倒重写。推荐保留底层可信能力，以垂直切片替换桌面交互、领域实体和 AI 编排。

## 2. 模块处置矩阵

| 模块 | 主要文件 | 当前状态 | 处置 | 完成标准 |
| --- | --- | --- | --- | --- |
| 浏览器采集 | `apps/browser-extension` | 可用 | 直接保留 | 继续提交统一材料协议，不感知专题或文档 |
| 桌面采集 | `renderer.ts`、`preload.cts` | 可用 | 改造 | 嵌入单窗口应用壳的紧凑采集模式 |
| 三窗口生命周期 | `main.ts` | 与 PRD 冲突 | 替换 | 只维护一个主 `BrowserWindow`，托盘和快捷键只导航或切换模式 |
| 工作台 UI | `workspace-*` | 绑定旧审核流程 | 替换 | 呈现近期收集、专题、全部材料，不显示关系审核 |
| 设置 UI | `settings-*` | 独立窗口 | 合并 | 成为应用内设置页面，保留 Key 和快捷键能力 |
| Capture/Artifact | contracts、store、service | 基础可靠 | 兼容重命名 | 用户侧统一称“原始材料”，底层迁移期可保留旧表名 |
| Fragment | parser、store | 有价值 | 直接保留 | 仅作为引用和核验基础，不作为用户管理实体 |
| 本地解析 | `parsers.ts` | 可用 | 直接保留 | 补充稳定定位与解析失败状态测试 |
| SQLite | `store.ts` | 可用但领域表旧 | 扩展 | 新增工作流、近期分组、文档版本、核验和回收站表 |
| JsonStore | `store.ts`、部分测试 | 迁移遗留 | 逐步删除 | 测试全部迁至 SQLite 或内存 Store Adapter 后移除 |
| Model Gateway | `packages/model-gateway` | 单一抽取 Schema | 深化 | Provider 调用与任务 Schema 分离，每类工作流独立契约 |
| 进程内双队列 | `service.ts` | 状态恢复不完整 | 替换 | SQLite 任务领取、step checkpoint、租约、取消和幂等 |
| KnowledgeItem | contracts、store、UI | 与新 PRD 冲突 | 兼容后删除 | 停止新写入，旧数据只读迁移，最终移除界面和表 |
| Relation/Proposal | contracts、store、service、UI | 与新 PRD 冲突 | 兼容后删除 | 停止扩展，完成旧数据迁移后删除写入路径 |
| Topic | store、service、UI | 概念可复用 | 重构 | 从“关系容器”改为用户确认的材料与主文档容器 |
| AgentRun | contracts、store | 观测有价值 | 演进 | 拆分为 `WorkflowRun`、`WorkflowStep` 与 `ModelCall` |
| 本地 API 鉴权 | `auth.ts`、`http.ts` | 可用 | 直接保留 | 新数据路由沿用鉴权、限流和输入边界 |
| GUI smoke | `scripts/gui-smoke.mjs` | 覆盖旧三页面 | 重写 | 验证单窗口导航、紧凑采集、上下文恢复与真实持久化 |

## 3. 关键耦合点

### 3.1 `CaptureService` 过度集中

`CaptureService` 当前同时承担采集、解析、模型调度、旧知识写入、审核、主题和深度分析。PRD 2.0 实施前需要将其收束为几个具有明确职责的领域模块：

- `MaterialModule`：采集、解析、CRUD、回收站和引用影响；
- `WorkflowModule`：任务创建、领取、恢复、取消和预算；
- `RecentOrganizationModule`：近期材料选择和临时分组；
- `TopicModule`：专题与材料成员；
- `TopicDocumentModule`：主文档、版本、用户编辑保护和更新；
- `VerificationModule`：关键结论核验及外部来源记录。

第一阶段不要求一次性拆完。每个新垂直切片直接进入目标模块，旧方法只作为兼容入口。

### 3.2 模型 Schema 与旧领域模型绑定

`KnowledgeExtraction` 强制一次返回 summary、concepts、claims、questions、topicSuggestions 和 relationSuggestions。它不适合批量分组或文档生成，也造成模型必须填充与任务无关的字段。

目标是按任务拆分契约：

- `RecentClusterProposal`；
- `DocumentOutline`；
- `DocumentSectionDraft`；
- `KeyClaimSet`；
- `VerificationAssessment`；
- `DocumentUpdatePatch`。

Provider、计费、超时和脱敏能力保留，旧 `KnowledgeExtraction` 仅服务迁移期测试。

### 3.3 UI 与 IPC 按窗口拆分

当前 Preload 暴露 capture、workspace、settings 三组桥接，Main Process 通过三个窗口对象验证 sender。单窗口后应改为按能力而非窗口命名：

- `materials`；
- `recent`；
- `topics`；
- `documents`；
- `settings`；
- `shell`。

仍只暴露最小 IPC 接口；单窗口不意味着 Renderer 可以直接访问 Node 或数据库。

## 4. 推荐实施切片

### Slice 0：安全迁移护栏

- 为新 Schema 建立 migration 版本；
- 增加旧数据只读兼容测试；
- 为工作流建立 Fake Model 和 Fake Verification Adapter；
- 禁止新功能依赖 Relation 写入。

### Slice 1：单窗口应用壳

- 合并 HTML、Renderer 和窗口生命周期；
- 快捷键进入紧凑采集模式；
- 提交后恢复原路由和窗口状态；
- GUI smoke 覆盖主导航与采集持久化。

### Slice 2：全部材料与 CRUD

- 原始材料列表、详情、搜索、编辑版本；
- 回收站、恢复和永久删除；
- 删除前展示专题和文档引用影响。

### Slice 3：近期收集

- SQLite 持久化工作流；
- 批量选择、去重、候选召回和临时分组；
- 零散材料保留；
- 分组快照可更新且不影响专题。

### Slice 4：专题

- 用户固化分组；
- 可视化增删材料；
- 新材料只产生待确认加入建议。

### Slice 5：专题文档

- 冻结材料集合；
- 提纲、分章节整理和引用映射；
- 主文档、版本历史、用户编辑保护和回退。

### Slice 6：集中核验与成本

- 提取关键结论；
- 依据授权联网核验；
- 不确定性呈现；
- token、费用、用途和预算总览。

### Slice 7：旧流程清理

- 停止 KnowledgeItem、Proposal、Relation 新写入；
- 迁移或归档旧数据；
- 删除旧 UI、API、测试和无用表；
- 删除 `IMPLEMENTATION_TRANSITION.md`；
- 再次核对 PRD、架构和实际行为。

## 5. 当前开工风险

| 风险 | 影响 | 准备措施 |
| --- | --- | --- |
| 旧关系测试数量较多 | 删除代码时容易失去回归保护 | 新闭环测试先建立，再移除旧测试 |
| 三窗口 IPC 与生命周期耦合 | 合并时可能破坏快捷键、草稿和文件上传 | 先用隔离原型确认状态模型，再做真实迁移 |
| 当前任务恢复依赖 Promise chain | 重启可能重复调用模型 | 新工作流先实现 SQLite 原子领取与幂等键 |
| 文档生成输入可能很长 | 成本、超时和上下文超限 | 冻结材料集、分章节处理、step 级预算 |
| 核验依赖联网和来源质量 | 结果不可控 | 使用 Adapter、明确授权、失败不阻断文档 |
| 打包目录触发密钥扫描误报 | 项目检查失败 | 后续单独修复检查脚本排除二进制发布目录 |

## 6. 准备完成判定

- PRD 和目标架构已独立提交；
- 单窗口原型可通过独立命令运行；
- 四类工作流输入、输出、状态与恢复规则已定义；
- 固定验收样本覆盖相关、无关、重复、冲突、来源不明和长材料；
- 实施切片与旧模块处置均有明确顺序；
- 正式开发可以从 Slice 0 或 Slice 1 开始，不需要继续补产品定位。
