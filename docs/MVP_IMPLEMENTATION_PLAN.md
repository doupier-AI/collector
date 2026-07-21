# Collector MVP 核心闭环实施计划

最后更新：2026-07-21

本文件是 `DEVELOPMENT_START.md` 第 3 节核心闭环的当前实施计划，按完成的切片同步更新。产品定义与验收标准以 `DEVELOPMENT_START.md` 和产品文档为准；已经发生的阶段事实、验证证据和遗留限制记录于 `PROJECT_DEVELOPMENT_RECORD.md`，本文件只保留计划与状态。

## 目标

连通下划线处的核心闭环，全部连通并通过 `DEVELOPMENT_START.md` 第 8 节端到端场景后，才记录“核心流程 MVP 可体验”：

```text
阅读当前内容 → 手动选区 → 选区质量提示 → 选区智能窗口
→ 深入研究 / 稍后再学 → 保留来源关系 → 返回原内容和原选区
```

## 切片状态

| 切片 | 目标 | 状态 | 提交 | 验证级别 |
| --- | --- | --- | --- | --- |
| A1 | 消息块派生契约 + 模型状态 mode | 已完成 | `1004329` | 四级 |
| A2 | AI 回答分块渲染与模型状态显示 | 已完成 | `a637c60` | 二级 + 真实浏览器 |
| B1 | 选区记录与分析后端（迁移 v17） | 已完成 | `16108bf` | 四级 |
| B2 | 选区捕获与选区智能窗口 WebUI | 已完成 | `ab79a26` | 二级 + 真实浏览器 + e2e |
| C1 | 深入研究分支与独立会话后端（迁移 v18） | 已完成 | `e0741f3` | 四级 |
| C2 | 深入研究二选一、分支视图与来源返回 | 已完成 | `8ffc671` | 二级 + 真实浏览器 + e2e |
| D1 | 稍后再学保存与列表后端（迁移 v19） | 已完成 | `e168dbb` | 四级 |
| D2 | 稍后再学栏目与来源返回 | 已完成 | `提交后回填` | 二级 + 真实浏览器 + e2e |
| 收尾 | 四场景端到端验收与文档同步 | 未开始 | — | 真实模型 + 真实浏览器 |

每个切片一笔提交：后端切片四级验证（全量构建、全量 Node 测试、项目检查）；WebUI 切片二级（前端构建 / 类型检查 + 受影响测试）+ 真实浏览器（视口、键盘、可访问性、控制台、网络）+ Playwright e2e（只用确定性假模型，自动化永不访问真实云模型）。提交信息带验证级别与执行证据；阶段报告与“下一步交接语”写入 `PROJECT_DEVELOPMENT_RECORD.md`。

## 关键设计决策

1. **统一选区锚点（三层）**：契约包 `deriveMessageBlocks()` 是前后端唯一的段落切分实现；锚点统一两种内容来源——消息块 `{ messageId, blockOrdinal, startOffset, endOffset, exact, prefix?, suffix? }` 与快照块 `{ contentSnapshotId, blockId, ... }`。服务端校验 `exact` 与块文本切片一致，失败时用 prefix/suffix 自愈重定位，再失败转 stale：保留原文与粗粒度位置，不删除记录。
2. **选区分析 = 异步任务 + SSE**：镜像导入管线。创建同步返回（窗口立即有原文与操作区），分析异步执行，事件只有 snapshot / completed / failed；逐字段流式属可延后增强。
3. **AI 输出一次完整 JSON**：网关 `analyzeSelection()` 返回校验过的 insight；必需字段缺失即 `invalid_analysis` 可重试失败；可选字段 `relationToFocus` 缺失合法。不静默降级为假数据。
4. **深入研究第一轮材料范围**：只使用当前已有材料（来源内容 + 选区上下文），界面固定文案如实说明“未联网检索”，不呈现引用；联网检索属后续阶段。
5. **分支呈现**：分支独立路由 `/research/:sid/branch/:branchId`（与阅读路由同构），顶部来源条；“沿当前内容”分支消息通过 `ResearchMessageRecord.branchId` 区分。
6. **事件流客户端同构复制**：选区事件流复制任务 / 导入事件流的既有模式，不强行合并三条客户端，避免无关 diff。

## 各阶段内容

### 阶段 A：统一当前内容与真实 AI 基线（已完成）

A1 在契约包建立消息块派生与模型状态三种 mode；A2 把完成的 AI 回答改为逐块渲染并在会话页头显示模型状态点。详见开发记录 3.11 / 3.12。遗留：真实云模型人工验收待环境具备后补验。

### 阶段 B：选区智能窗口

**B1（已完成）**：统一选区锚点与质量评级契约、迁移 v17、选区服务（创建即保存、锚点校验与自愈、stale 降级、幂等、重试、重启恢复）、网关 `analyzeSelection()`、演示模式选区分析与五个端点。详见开发记录 3.13。

**B2（已完成）**：

- `features/selection/`：`selection-capture.ts`（Range → 块内偏移纯函数）、`useSelection.ts`（mouseup / touchend / Shift+keyup / selectionchange / Escape，只在带 `data-content-kind` 的完成内容上生效）、`SelectionQualityHint.tsx`（只给调整建议，不创建记录）、`SelectionInsightPanel.tsx`（原文即时可见、逐字段骨架、两层展开、宽屏就近浮层 / 窄屏底部抽屉、失败保留原文可重试、结束始终可用；幂等键纯 ASCII：原文部分用确定性 FNV-1a 摘要，避开 HTTP 请求头的非 ISO-8859-1 限制与服务端 200 字符上限）、`SelectionSurface.tsx`（每页挂一次）；
- `api/selection-events.ts` 事件流客户端 + 客户端 4 个选区方法 + 服务注册；
- 会话页与阅读页挂同一捕获层；`anchorCaption` 提取共享；选区高亮与窗口样式令牌（窗口高度按开启侧可用空间收口，正文区内部滚动，操作区始终可见）。
- 验证：135/135 WebUI 测试、Playwright 真实 Chromium 28/28（含窄屏抽屉与无模型失败路径）。详见开发记录 3.14。

### 阶段 C：深入研究与来源返回

**C1（已完成）**：`ResearchBranchRecord`、消息 `branchId`、会话 `origin`、`DeepResearchAccepted`；迁移 v18（`research_branches`，消息表加 `branch_id`，会话表加来源选区 / 来源会话列）；`startDeepResearch` 先事务创建分支（或带 origin 的新会话）与来源关系、再排队第一轮任务，幂等键防重复建分支；端点 `POST /v1/research-selections/:id/deep-research`、`GET /v1/research-branches/:id`、`POST /v1/research-branches/:id/messages`；测试覆盖两路径、生成失败后来源关系仍在、重启恢复、幂等。详见开发记录 3.15。

**C2（已完成）**：窗口“深入研究”→ 轻量二选一（两去向 + 适用场景说明；独立会话提供可选方向输入框；分析失败同样可发起；幂等键 `dr:<选区id>:<去向>:<方向摘要|auto>`）；分支路由视图 + 顶部来源条（来源内容名、选区摘要、返回原文）+ 材料范围固定说明 + 分支内追问；会话页接入来源条（带来源的独立会话）、分支入口列表与消息选区高亮；`resolveHighlight` 纯函数按锚点重定位（exact 校验 → 原文块内重定位 → 降级）、`<mark>` 高亮并滚动到位、`?sel=` 查询参数刷新后仍在；修复窗口内输入框聚焦、表单 selectionchange 误关窗口、同路由切换会话重建旧锚点选区三个缺陷。验证：171/171 WebUI 测试、Playwright 真实 Chromium 32/32（含窄屏抽屉二选一与无模型发起路径）。详见开发记录 3.16。

### 阶段 D：稍后再学基础闭环

**D1（已完成）**：契约新增 `ResearchLaterItemRecord`（priority 1–5、summary、status pending / done）、列表视图 `ResearchLaterItemView`（联接选区原文与来源标题）、创建 / 更新输入校验与确定性默认概括 `deriveDefaultLaterSummary`（选区首句 / 前 80 字符，不依赖 AI）；迁移 v19 创建 `research_later_items`（外键指向会话与选区、创建幂等键部分唯一索引、选区与状态索引）；`ResearchLaterService` 提供创建幂等、列表联接选区文本与来源说明、priority / summary / status 更新；端点 `POST / GET /v1/research-later-items`（列表支持 `?status=` 过滤）、`GET / PUT /v1/research-later-items/:id`。详见开发记录 3.17。

**D2（已完成）**：窗口“稍后再学”→ 星级 + 可编辑概括（预填确定性默认值）→ 保存即入栏目；稍后再学面板呈现真实列表（摘要、星级、来源、时间、数量徽标）；点击项目返回原内容原选区并自动重开选区窗口；标记完成 / 恢复待学；位置失效按降级展示。详见开发记录 3.18。

### 收尾

按 `DEVELOPMENT_START.md` 第 8 节场景一至四做真实模型 + 真实浏览器端到端人工验收；同步开发记录与前端实施指导；满足第 9.1 节全部条件后才使用“核心流程 MVP 可体验”表述。

## 主要风险

1. **锚点失效**：AI 消息重试重写内容后旧选区进入 stale，由自愈与粗粒度降级兜底，e2e 覆盖该路径；
2. **块派生前后端漂移**：单实现放契约包，前端禁止另写切分逻辑；
3. **jsdom 选区 API 薄弱**：偏移计算做成 Range-like 纯函数单测，真实选区行为只由 Playwright 断言；
4. **模型无结构化输出**：分析解析失败即任务失败可重试，不静默降级；
5. **branchId 侵入会话视图**：若 C1 复杂度失控，降级预案为两种模式都建带 origin 的独立会话（产品语义变弱，仅作预案）。

## 待确认事项

- 深入研究第一轮只使用当前材料（本计划按“是”执行；若需同步联网则阶段 C 重排）；
- 稍后再学即时控制范围为星级、概括、完成 / 恢复（其余留后续阶段）；
- 分支呈现位置为独立路由 + 来源条（如需嵌入会话主视图，在 C2 开工前确认）。
