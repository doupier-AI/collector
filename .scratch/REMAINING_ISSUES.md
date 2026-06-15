# 待处理问题清单

> 更新于 2026-06-15 | 72 tests passing

## 已修复

| # | 问题 | 修复内容 |
|---|------|----------|
| 1 | SqliteStore 缺失 listRevisions/saveRevision/trashCapture/restoreCapture/deleteCapture/getDeleteImpact | 添加 material_revisions 表(migration v10)、6 个接口方法、6 个 SqliteStore 实现 |
| 2 | AI Usage 端点永远报 0 | 添加 saveModelCallFromAgentRun 辅助方法、migration v11 解除 model_calls FK、修复 executeModelRun 三路分支 + 外层 catch |
| 3 | 采集后 AI 不自动触发 | 已存在 enqueueModelRun 逻辑，修复 Key 连通性后正常工作 |
| A | 近期整理聚类永远为空 | 添加 cluster_materials 步骤到 organizeRecent 工作流(freeze→dedup→cluster→publish)，executeRecentOrganizationStep 改为 async |
| C | 文档版本查询端点 404 | 实现 GET /v1/topics/{id}/documents、GET /v1/documents/{id} 路由 |
| D | 近期整理快照不持久化 | SQLite 持久化 + 测试验证通过 |
| E | 缺少端点 | 实现 /v1/data-paths、/v1/ai-configuration 端点及 getDataPaths/getAiConfiguration 方法 |

## 待处理

### 中级

| # | 问题 | 说明 |
|---|------|------|
| B | 专题文档生成是垫片实现 | executeTopicDocumentStep 的 build_outline/draft_sections 取 content 前 80/500 字符，不调用 DeepSeek |

### 低级

| # | 问题 | 说明 |
|---|------|------|
| F | 浏览器扩展未端到端验证 | 构建产物存在但未在 Chromium 加载测试 |
| G | Electron 桌面端 GUI 待验证 | GUI smoke test 需要桌面会话环境 |