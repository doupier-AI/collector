---
status: accepted
---

# 上一代「可信知识整理」采集后端退役删除

2026-08-19 确认（用户分两步裁决：浏览器来源采集扩展已无产品用途、退役删除；其旧后端层经评估后「也清掉」，相邻无 UI 孤儿端点「一起删掉」）：

1. **浏览器来源采集扩展退役删除**。`apps/browser-extension` 与其专属接线（回环适配入口、build-assets/clean 步骤、README 与架构文档提及）已移除。

2. **旧「采集」后端层整体退役删除**。`/v1/captures`、`/v1/topics`、`/v1/materials`、`/v1/recent-organization` 等接口；SQLite v37 迁移 DROP 19 张遗留表（`artifacts`、`fragments`、`knowledge_items`、`review_proposals`、`agent_runs`、`relations`、`user_decisions`、`topics`、`topic_memberships`、`material_revisions`、`backup_records`、`workflow_runs`、`workflow_steps`、`recent_cluster_snapshots`、`topic_document_versions`、`ai_budget_settings`、`verification_policy`、`verification_claims`、`update_previews`）；`@collector/capture-client` HTTP 客户端包；服务层遗留方法（`createCapture`、`organizeRecent`、`updateAiBudgetSettings`、`saveWorkflowRun`、`saveAiBudgetSetting` 等）与 `SourceParser`、`verification.ts`；对应专属测试（capture-smoke、material-history、material-library、topic-creation、topic-document、recent-organization、ai-budget、data-control、mvp-core-loop、旧 e2e 生命周期、provider-workflow-route）一并删除。

3. **相邻无 UI 的孤儿端点一并删除**：`/v1/backups`、`/v1/exports`、`/v1/ai-usage`、`/v1/settings/ai-budget`、`/v1/data-paths`。它们仅由测试与旧客户端消费，无 WebUI 调用方，不单独保留。

4. **名字含「采集」的现行资产不在退役范围**：`@collector/capture-contracts` 包承载全产品现行共享契约（研究、运行记录、模型路由、文档导入等），只裁剪采集专属类型导出，包保留；`model_calls` 表保留（运行记录与用量统计仍使用）。

**Why:** 该后端层属上一代「可信知识整理」产品形态，当前 WebUI 对其零调用，仅由自身测试保持存活；浏览器扩展退役后成为纯死代码。保留意味着迁移重放、专属测试与两套类型契约持续承担维护成本，并让「采集/材料/主题」旧产品语义潜伏在代码库中。删除后代码面收缩、门禁更快、产品边界单一。开发数据期（ADR-0007）下遗留表数据无保留承诺，DROP 不做兼容迁移。

**Consequences:**

- 19 张表数据永久删除；未来如需采集/材料/主题类产品形态需重新设计与实施，不复用此层。
- `capture-contracts` 包名保留（改名另行评估）；其中 `CaptureLocator`/`ArtifactRecord` 等现行导入与文档管线类型不受影响。
- 四态能力表无需改动：被删面本就不在现行能力表中，无任何现行能力状态变化。
- 相关接口不再出现在任何文档与契约面；Git 历史保留旧实现可供追溯。
