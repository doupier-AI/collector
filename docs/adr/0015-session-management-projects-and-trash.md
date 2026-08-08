# 会话管理：项目分组与回收站

2026-08-08 会话管理系统需求确认（项目分组 + CRUD + 回收站）。

**决策：**
- **项目 = 会话的第一层分组容器**，不嵌套。`research_sessions.project_id` 为独立列 + 外键（`REFERENCES projects(id)`，可空 = 未分类），可索引过滤与分组查询；`projects` 表沿用 JSON-in-column 模式。第一版不做嵌套文件夹、不做拖拽排序、不做置顶/显式排序（项目与会话均按 `updated_at DESC`，更新即冒顶）。
- **删除项目不删会话**：同一事务内先将其下会话移回未分类（`project_id` 置 NULL 并同步 `json_remove` record_json 中的 `projectId`），再删除项目行。
- **软删除 + 回收站**：删除会话即置 `trashedAt`（存 record_json 内，对齐素材 `captures.trashedAt` 先例，无独立列）；回收站可恢复或彻底删除；超过 30 天由调度器每日自动彻底清理（复用 `cleanupTrash` 入口）。
- **彻底删除 = 级联清理整棵节点树**：单事务内按依赖顺序删除全部关联表（语义片段、正文版本、切片、引用、grounding、任务与事件、术语预览、边、融合提议、任务、导入、附件、选区、分支、稍后项、节点、消息、会话）。FK 无 `ON DELETE CASCADE`（除声明 CASCADE 的表），须先删最下游引用方。
- **归档复用既有 `status` 字段**（`active | archived`，契约早已定义，topics 先例），不新增字段。
- **用户显式改名后自动标题永久让位**：`ResearchSessionRecord` 增可选 `titleEdited`（存 record_json，零迁移）。`PATCH /v1/research-sessions/:id` 的 title 分支置位；`nameSession` 与 `refineSessionTitle` 开头检查后直接返回。未改名会话行为完全不变。
- **开发数据期**（ADR-0007）：不做存量会话/项目数据的兼容迁移；v33 迁移中存量 `project_id` 均为 NULL（未分类），符合决策纪律。

**Why:** 会话数量增长后平铺列表不可管理；删除会话涉及整棵节点树（含融合节点、正文版本等），直接硬删误删代价大；用户显式命名不应被模型异步提炼覆盖。

**Consequences:** 侧栏"最近研究"升级为项目分组树 + 菜单操作（重命名/移动到项目/归档/删除）；新增回收站页与 `/trash` 路由；会话删除（软删/彻底删）、项目 CRUD、会话部分更新（PATCH）端点进入 API；`clearAllData` 需同步清空 `projects`；回收站会话仍可 GET（已打开页面不报错），仅变更类请求 409。未来若批准数据兼容基线或引入拖拽排序/置顶，需要相应迁移与字段扩展（record_json 内可选字段零迁移）。
