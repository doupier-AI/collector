# 确认式融合：融合节点、融合来源边与融合正文生成契约

> **目标模型由 ADR-0022 扩展、ADR-0023 收缩（2026-08-11）**：融合节点继续保持无父节点、来源可回溯和纯增量，但目标归属改为独立会话根节点；融合提议可包含两个以上来源，并按一条新综合区分，而非按节点对唯一。本 ADR 中“确认融合同时创建普通语义关联边”的双写行为只说明当前实现；目标模型不再写入这条普通语义边。

2026-08-07 用户确认（#31 F2）：在 F1 相似性弱提示基础上交付确认式融合。ADR-0005 已确立融合节点关系模型（独立增量节点、`fused-from` 边、最低结构 = 共同核心 + 来源差异 + 增量综合 + 可回溯依据），但生产路径上"接受提议"只建 `semantic-related` 边，不创建融合节点——本轮把确认式融合的完整契约落地：确认 → 语义边 + 融合来源边 + 融合节点 + 融合正文生成。

**决策：**
- **确认后立即进入融合节点页**：用户点击「融合为节点」→ 同一事务落提案 accepted + 语义相关边 + 融合来源边 + 融合节点（无父节点）+ 首轮消息与任务 → 跳转融合节点页，由既有任务管线生成融合正文（可重试、刷新/重启恢复，与「深入研究生长子节点」交互一致）。「保留关系」（#42 既有行为，只建语义边）与「暂不处理」保留，三按钮并存。
- **融合节点无 `parentNodeId`**：融合节点不是任何来源的血统后代，来源关系完全由 `fused-from` 边表达（每条边 `from=来源节点, to=融合节点`）。已核实：图投影按边驱动、`buildFocusLineage` 对无祖先节点容错、多根是独立岛屿，树与地图均不破坏；来源节点页的"从这里长出的节点"列表不出现融合节点。
- **`fused-from` 边按来源节点一条**（UNIQUE(kind, from, to) 约束），`ResearchEdgeRecord` 增加可选 `sourceFragmentIds?: string[]`（该来源贡献的语义片段 ID 并集，存既有 record_json，零迁移）。满足验收 2"指向每个贡献来源切片的融合来源边"的实质——边记录列出贡献切片；切片级回溯由正文引用（fragmentId → `?fragment=` 深链）承担。
- **融合正文 = 自由正文 + 固定章节标题**（`## 共同核心` / `## 差异` / `## 综合推导`），与 #43/#44"正文唯一事实源"方向一致（不返回 JSON 结构）；章节由确定性派生切片为语义卡片。模型漏节不强制（#38 原则：不做内容质量评分）。正文以 `[来源n]` 标记引用来源，`parseFusionReferences` 确定性解析为 `ResearchFusionReference[]`（blockOrdinal + markerOffset + 来源快照）落任务 record_json。
- **独立提示词版本 `fusion-compose-v1` 与固定令牌预算**：`FUSION_COMPOSE_PROMPT_VERSION` / `FUSION_COMPOSE_TOKEN_BUDGET`（4_000），连同所选来源切片 ID、片段 ID 随模型调用 context 落入运行记录（验收 4）。提示词显式区分同一实体/同名异义/改编/类比/对比——跨作品、跨领域的同名概念默认对比或联想，仅在证据支持时让位更强断言（验收 5，与相似性核验同一判断方向）。
- **原子生成（首版）**：`composeFusion` 返回完整正文，经任务管线（GeneratingBody 显示生成中，失败走 `failResearchTask` → 可重试，来源关系永不丢）。流式融合正文列为后续增强。
- **来源回读诚实降级**：融合生成时按 bodyVersionId+fragmentId 用 `getOrDeriveMessageBodyArtifacts` + `tryResolveFragmentExcerpt` 取摘录；不可回溯来源跳过，可回溯来源不足两个则拒绝建节点（验收 2）。WebUI 引用标记越界/版本失效显示回退，不静默关联。

**Why:** 用户可见结果——从弱提示确认后得到可追溯的综合节点：融合节点页顶部来源条（来源节点可点击跳转）+ 正文内 `[来源n]` 标记（点击深链回来源节点对应语义卡片，复用 #42 定位链路），每条断言可逐字回溯到来源片段；来源节点、原文与既有关系逐字节不变（融合纯增量，ADR-0005）。

**Consequences:** 契约层新增 `ResearchFusionSource` / `ResearchFusionReference` / `parseFusionReferences`，`ResearchTaskRecord` 增加可选 `fusionPlan` / `fusionReferences`（存 record_json，零迁移），`ResearchNodeView` 增加可选 `fusionSources`；`ResearchEdgeRecord.sourceFragmentIds` 可选字段零迁移。服务端新增 `POST /v1/research-fusion-proposals/:id/fuse`（幂等键去重）、`confirmFusion`、`createResearchFusionTurn` 事务、`composeFusionBody` 生成分支。模型网关新增 `composeFusion`。数据库 schema_migrations 不变（v32 后无新迁移）。WebUI 新增「融合为节点」按钮、`FusionSourceBar`、`FusionCitationMarker`。**下一张 #32（自动融合）** 复用 #31 的不变量与回溯能力（融合契约同一、触发策略不同），仍默认关闭。

**决策纪律：** ①融合纯增量：来源节点、原文、父子血统与既有语义边逐字节不变；②融合节点永不挂 parentNodeId（来源关系只由 fused-from 边表达）；③`[来源n]` 引用只解析不猜测——n 超界、版本失效、片段缺失一律诚实回退；④融合生成失败保留来源关系（先保存关系再生成，与深入研究和选区生长同一共识），正文失败标记可重试；⑤每笔融合正文生成独立记账（promptVersion + sourceSliceIds + sourceFragmentIds + tokenBudget）。
