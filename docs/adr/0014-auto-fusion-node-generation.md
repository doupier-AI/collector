# 自动融合：触发策略、自动生成标记与呈现契约

2026-08-08 用户确认（#32 F3）：在 #31 确认式融合基础上交付自动融合模式。自动融合不改变增量、来源可回溯与跨领域同名判定规则；自动触发与确认触发（#31）复用同一融合契约（`confirmFusion` / `createResearchFusionTurn` / `fused-from` 边 / `composeFusion` 正文生成），仅触发策略不同。

**决策：**
- **默认关闭的功能开关**：设置新增「自动融合」开关（settings 键 `research_fusion_auto`，`"true"/"false"`，缺省关闭），经 `GET/PUT /v1/settings/fusion` 读写并持久化（settings 表，刷新与服务重启后保持）。关闭时核验成立的提议只呈现弱提示「熟悉的概念再现，节点可融合」，不生成融合节点（#31 行为不变）。
- **触发策略 = 关系类型代理**：相似性核验返回的 `relationType` 中，`identity` / `shared-concept` 视为高置信 → 自动融合；`analogy` / `contrast` 视为低置信 → 保持 pending 弱提示逐条确认。不改相似性核验提示词与契约（模型仍只返回关系类型与理由，不新增置信度数值）。
- **扫描触发 = 页面挂载自动扫描**：开关开启后，用户进入/刷新研究节点页时页面挂载自动调用一次既有 `POST /v1/research-nodes/:id/fusion-proposals/scan`（复用 scan 端点，不改 URL）；开关关闭时 WebUI 不自动扫描。scan 响应从数组扩展为 `{ proposals, autoFused }`（`ResearchFusionScanResult`）：`proposals` 为本次扫描后与本节点相关的全部提案（含自动融合成功后已 accepted 的留痕提案），`autoFused` 为本次新自动生成的融合节点摘要（proposalId + nodeId + sessionId，供提示条跳转）。
- **只处理开启后新出现的提议**：扫描前对既有提案 ID 快照，只有本次扫描新建的 pending 提案才尝试自动融合——开关开启前已落库的 pending 提案保持逐条确认，不追溯自动生成。
- **自动生成标记与回链**：自动融合节点在 `ResearchNodeRecord` 上新增可选 `isAutoFusionNode: true` 与 `triggerFusionProposalId`（触发提议 ID，存 record_json，零迁移）；确认式融合不设这两个字段。不变量：`isAutoFusionNode === true` → `isFusionNode === true`。
- **幂等键命名空间隔离**：自动融合用 `auto-fuse:${proposalId}`（确认式沿用 `fuse:${proposalId}`）；同对节点、跨重启绝不在 `auto-fuse:` 下重建第二个融合节点。
- **成功呈现 = 顶部提示条，不自动跳转**：自动融合成功后留在当前节点页，顶部显示「已自动生成融合节点」提示条（可点击跳转融合节点页），不打断用户当前阅读。融合节点页标题旁显示「自动生成」徽章；「回到触发提议」复用既有路径——融合节点页来源条链接来源节点 → 来源节点页 accepted 提案即只读依据入口（#42）→ 可深链回来源切片。
- **失败诚实降级**：自动融合失败（可回溯来源不足两个、研究服务未接线等）保持提案 pending，由 WebUI 弱提示逐条确认；scan 返回既有提案（pending/accepted）不隐藏留痕，绝不因自动融合失败中断扫描或页面。

**Why:** 用户可见结果——开启开关后，浏览研究节点页即自动把高置信相似提议融合为可追溯的综合节点（带「自动生成」标记与回链，可随时回到触发提议与来源切片），低置信提议与开关关闭时保持既有弱提示；全程留痕、来源可回溯，与确认式融合同一契约同一数据模型。

**Consequences:** 契约层 `ResearchNodeRecord` 新增可选 `isAutoFusionNode?` / `triggerFusionProposalId?`，新增 `ResearchFusionScanResult` / `ResearchFusionAutoResult`（零迁移）。服务端 `scan` 返回 `ResearchFusionScanResult`（行为级变更，HTTP 路径不变）；`confirmFusion` 增加可选 `options.autoFused`；新增 `isHighConfidenceFusion` 纯函数；新增 `GET/PUT /v1/settings/fusion` 与 `getFusionAutoConfig` / `updateFusionAutoConfig`。WebUI 新增设置页 `settings/fusion`（抽屉入口「融合设置」）、节点页挂载自动扫描 effect、`AutoFusionNotice` 提示条、「自动生成」徽章；`scanResearchFusionProposals` 返回类型改 `ResearchFusionScanResult`。确定性 e2e 覆盖关闭路径（不自动扫描、弱提示正常）、开启+高置信（自动融合、标记、提示条、回溯、持久化）与开启+低置信（保持弱提示）。

**决策纪律：** ①自动融合纯增量：来源节点、原文与既有关系逐字节不变（复用 #31 纪律）；②低置信永不自动：类比/对比一律保持逐条确认；③只处理新提议：开启前已存在的 pending 不追溯；④幂等与防重：`auto-fuse:${proposalId}` 幂等键 + 提案状态短路双重闸；⑤失败诚实降级：来源不足/未接线保持弱提示，不静默丢弃也不中断。
