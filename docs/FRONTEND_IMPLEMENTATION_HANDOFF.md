# Collector WebUI 前端实施交接

基线 ID：`FRONTEND-BASELINE`

基线版本：`1.6.0`

最后更新：2026-07-20

适用角色：KIMI 3 前端

状态：KIMI 3 前端实施基线

当前状态入口：`docs/handoffs/CURRENT.md`

阅读规则：首次接手、基线版本变化或当前状态明确要求时阅读本文；日常交接只读取当前状态和本轮增量文件。

## 1. 交接目标

本文提供给负责 `apps/web` 的 KIMI 3。阅读本文后，可以在不重新整理全部产品讨论的情况下开始 Collector WebUI 开发。

本次共同目标是交付首个纵向切片“启动并恢复一场研究会话”：

1. 用户打开 Collector 后看到最近研究会话和研究画布；
2. 用户提交文字后，输入先保存，再创建 AI 生成任务；
3. 页面立即显示用户输入、AI 固定占位和生成状态；
4. 生成结果通过渐进事件进入当前会话；
5. 页面刷新后恢复会话、消息、已生成内容和任务状态；
6. 未配置模型或生成失败时，用户输入仍然保留，并显示明确的恢复入口。

前端不是独立演示原型。所有可操作控件连接真实后端状态；尚无后端能力的入口不伪造成功结果。

## 2. 协作职责

### GPT-5.6 负责

- 产品工程框架和纵向切片边界；
- 共享数据契约和运行时校验；
- SQLite 数据模型、迁移、事务和恢复；
- 研究会话、消息和后台任务领域服务；
- HTTP、SSE、本地会话、Host/Origin 校验和输入边界；
- 模型网关、模型调用记录和失败语义；
- 后端单元测试、集成测试和持久化验证；
- 与 KIMI 3 确认接口变化。

### KIMI 3 负责

- `apps/web` React、TypeScript 与 Vite 工程；
- WebUI 路由、组件、客户端状态和 API 客户端；
- 研究画布、内容导航、会话列表、Chat 输入和任务状态；
- SSE 连接、断线恢复、刷新恢复和用户可见错误处理；
- 响应式布局、键盘操作、焦点、减少动态效果和可访问性；
- Playwright 浏览器端到端测试；
- 构建后的前端静态资源与本机服务同源集成；
- 实际浏览器截图、控制台、网络请求和可访问结构验证。

### 共同约束

- 前端不直接访问 SQLite、文件系统或模型供应商；
- 后端不决定界面布局，但负责提供完整、稳定、可恢复的状态；
- 接口不一致时，以共享 TypeScript 契约和实际 API 测试为准，并同步更新本文；
- 不把 API Key、本地会话令牌或认证头写入浏览器存储、界面日志或截图；
- 自动化测试使用隔离数据目录和确定性假模型，不调用真实云模型。

## 3. 分层阅读与优先级

每次实施先读取：

1. 根目录 `AGENTS.md`；
2. `docs/handoffs/CURRENT.md`；
3. 当前状态指定的单次增量交接；
4. 本轮相关源码、共享契约和测试。

首次接手前端角色、本文 Major 版本变化或当前状态明确要求时，再完整读取：

1. 根目录 `CONTEXT.md`；
2. `docs/DEVELOPMENT_START.md`；
3. `docs/PRODUCT_REFOUNDATION.md`；
4. `docs/PRODUCT_FUNCTION_FLOW.md`；
5. `docs/INTERACTION_DESIGN.md`；
6. `docs/INTERFACE_DIRECTIONS.md`；
7. `docs/ARCHITECTURE.md`；
8. `docs/HUMAN_ACCEPTANCE_STANDARD.md`；
9. 本文。

相同角色连续工作且基线版本未变化时，不重复读取上述长文档。Minor 或 Patch 版本变化时只读取增量交接列出的变化章节。

冲突处理顺序：用户最新明确要求 > `AGENTS.md` > 当前产品文档 > 本文 > 旧源码行为。

## 4. 仓库当前真实状态

当前已验证状态如下：

| 区域 | 当前状态 |
| --- | --- |
| `apps/web` | 已实现 React 19、TypeScript、Vite 8 和 React Router 7 WebUI |
| React、React DOM、Vite、React Router | 已按 npm workspace 安装在 `apps/web`，lockfile 已更新 |
| Playwright | 已接入 `test:e2e`，22 项 Chromium 场景通过并自然退出，覆盖启动器自动配对、研究会话、SSE 恢复、文件导入与阅读恢复 |
| `apps/api` | 已有 Node HTTP 服务、认证、SQLite、文件和模型网关基础 |
| API 根路径 `/` | 正式服务返回 WebUI 生产入口；未配置 Web 根目录的嵌入式测试服务保持 API JSON 响应 |
| WebUI 静态资源同源服务 | 提交 `709246b` 已实现并通过真实 Chromium 验证；页面、资源、HTTP 与 SSE 使用同一 loopback 来源 |
| 研究会话、消息、生成任务契约 | 已在 `packages/capture-contracts` 实现 |
| 研究会话后端 | 已实现幂等会话创建、会话增查、恢复视图、幂等消息提交、任务查询和失败重试 |
| Chat 渐进事件 | 已实现可续传 SSE：`snapshot`、`delta`、`completed`、`failed` |
| SQLite | migration v16 已加入研究附件、导入任务、内容快照和持久事件；会话创建幂等键、会话、消息、任务和任务事件保持可恢复 |
| WebUI 首次认证引导 | 启动器通过短时一次性回环入口下发 HttpOnly Cookie；URL、storage 和日志不包含令牌，手动 6 位码页作为开发回退 |
| 真实模型流式能力 | 模型完整返回 JSON 后按 80 字符分片写入 SSE，不是供应商原生 token stream |
| 当前服务端口 | 正式启动器由系统选择动态端口；直接开发服务保留 `43110`，已配对浏览器扩展使用 `43110` 适配入口 |
| 当前认证 | Bearer token 或 `collector_session` HttpOnly Cookie |
| 当前构建 | TypeScript project references + WebUI 类型检查与 Vite 构建 + `scripts/build-assets.mjs` |
| 研究会话文件导入与阅读 | 会话内支持 TXT、Markdown、DOCX、文本型 PDF 的真实上传、状态、取消、重试、刷新恢复和同画布阅读；开始页附件按钮因没有会话上下文继续保持占位 |
| 当前测试 | 137 项 Node 单元与集成测试、99 项 WebUI 测试、22 项 Chromium 端到端场景通过 |

不要把“文档定义了”写成“代码已经实现”。合并前以源码、自动化测试和实际界面验证为依据。

## 5. 本次前端交付范围

### 5.1 必须完成

- 新建 `apps/web` 工作区；
- 使用 React、TypeScript、Vite 和 React Router；
- 建立可复用的 API 客户端和渐进事件客户端；
- 实现研究会话列表、空状态和当前会话恢复；
- 实现 Chat 文本输入、提交和提交中的防重复处理；
- 立即显示用户消息、AI 消息占位和任务状态；
- 接收任务渐进事件，并合并为同一条 AI 消息；
- 页面刷新后重新获取完整会话视图；
- SSE 中断后回退到任务状态查询，不丢失已显示内容；
- 明确处理模型未配置、任务失败、离线、认证过期和接口不可用；
- 实现常规笔记本、窄窗口和宽屏基础响应式布局；
- 完成键盘操作、可访问名称、焦点和 `prefers-reduced-motion`；
- 添加 Playwright 真实浏览器测试；
- 让生产构建产物由本机 API 同源提供；
- 在 README 或开发脚本中提供 WebUI 开发与测试命令。

### 5.2 已进入当前切片的扩展能力

- 会话内“导入文档”连接真实后端上传、任务、SSE、取消、重试与阅读恢复；开始页没有会话上下文，附件按钮保持明确占位；
- “稍后再学”可以显示入口和真实数量，若数量接口尚未提供则不显示虚假数字；
- 设置入口只在真实配置状态接口可用时开放；
- “关闭 Collector”在后端关闭接口和启动器生命周期就绪后接入。

若入口尚不可用，优先不显示；确需展示时使用清楚的不可用状态，并说明依赖，不使用无反馈按钮。

### 5.3 本切片不实现

- 选区智能窗口；
- 深入研究二选一和研究分支；
- 稍后再学保存与弱重现；
- AI 弱标记；
- PDF 页面版式、文本层和页内精确高亮；
- 行内引用胶囊和来源返回；
- 搜索结果视图；
- 模型供应商完整设置页；
- 本地启动器打包。

这些能力的结构空间要预留，但不要提前构造复杂状态或假数据。

## 6. 用户路径与页面状态

### 6.1 首次打开

用户看到：

- 左上“内容”入口；
- 中央 Collector 名称、简短说明和 Chat 输入；
- 最近会话为空时的明确邀请；
- 可用时显示“导入文档”入口；
- 不出现技术术语、空白大卡片或无意义统计数字。

推荐文案：

- 页面标题：“从一个问题开始”
- 说明：“写下你正在理解的内容，Collector 会保存这次研究，并让你随时回来继续。”
- 输入提示：“输入你想理解、比较或继续研究的问题……”
- 主要操作：“开始研究”

### 6.2 提交文字

单次提交的可见顺序：

1. 保留输入框文字，直到后端确认已保存；
2. 后端返回成功后清空输入框；
3. 立即在画布显示用户消息；
4. 紧接着显示 AI 回答固定占位；
5. 状态显示“已保存，正在生成”；
6. 渐进事件到达后填入同一条 AI 消息；
7. 完成后状态变为“已完成”，不额外弹成功提示。

前端不得在接口返回前把提交展示成已保存。请求超时时保留草稿，并说明“尚未确认保存”。

### 6.3 刷新恢复

刷新后：

- 路由中的会话 ID 保持不变；
- 重新获取会话、消息和任务，不依赖内存状态；
- 已完成消息完整恢复；
- 进行中任务先显示已保存内容，再恢复事件连接或状态轮询；
- 失败任务显示失败原因和后端允许的恢复操作；
- 草稿只允许保存非敏感文字，需使用带版本的最小浏览器存储结构，不保存认证信息。

### 6.4 模型未配置或生成失败

用户输入必须存在于会话中。AI 消息区域显示：

- 状态标题：“内容已保存，暂时无法生成回答”；
- 可理解的原因，例如“还没有配置可用模型”；
- 后端已提供时显示“重试”或“前往模型设置”；
- 不显示原始堆栈、供应商响应体、密钥或认证信息；
- 当前会话仍然可以继续查看和恢复。

### 6.5 空、加载、离线与过期状态

每个数据区域必须覆盖：

- 首次加载：稳定骨架，不用整页转圈；
- 空状态：告诉用户下一步动作；
- 离线或服务停止：保留页面和草稿，提供重新连接；
- 认证过期：说明需要重新打开 Collector，不循环请求；
- 服务错误：显示请求 ID（后端提供时）和重试；
- 无权限或来源被拒绝：不尝试绕过本地安全检查。

## 7. 信息结构与视觉方向

### 7.1 桌面默认结构

```text
┌──────────────────────────────────────────────────────────────┐
│ [内容图标]                                       [稍后图标]  │
├──────────────┬──────────────────────────────┬────────────────┤
│ 内容         │ 当前研究会话标题             │ 稍后再学       │
│ 开始 Chat    │ 最近更新时间                 │ 暂无内容       │
│ 最近研究     │                              │                │
│              │ 用户问题                     │                │
│              │ │                            │                │
│              │ ● AI 回答或稳定加载占位      │                │
│              │                              │                │
│              │ [＋ 输入当前问题……  ↑发送]  │                │
└──────────────┴──────────────────────────────┴────────────────┘
```

宽屏（至少 900px）默认展开左右固定侧栏，主内容保持居中阅读宽度。左右侧栏默认宽度为 264px，可通过内边缘拖拽或方向键在 208px 至 400px 范围内调整；宽度当前只保存在页面内存中，刷新后恢复默认值。

开始页在主内容区居中显示占位 logo、标题、说明和输入区。占位 logo 在正式品牌资产确定前使用本地内联 SVG，不引入远程资源。

### 7.2 内容导航

左上“内容”图标控制左侧导航：

```text
内容
├─ 开始 Chat
├─ 导入文档（契约可用后）
└─ 最近研究
   ├─ 会话 A
   └─ 会话 B
```

右上“稍后再学”图标控制右侧栏；当前右侧栏只显示“暂无内容”，不伪造尚未实现的保存能力。

窄窗口使用覆盖抽屉并默认收起，同一时间只展开一侧；遮罩点击或 Escape 关闭后，焦点返回对应图标按钮。图标按钮保留可访问名称、`aria-expanded` 和 `aria-controls`。

输入框内左下角保留“+”圆形按钮；在研究会话内点击会打开真实文件选择，开始页因没有会话上下文而显示明确占位提示。右下角为圆形发送按钮。输入框外显示 Enter 发送、Shift+Enter 换行提示，输入框仍通过无障碍标签和说明建立关联。

### 7.3 视觉令牌建议

颜色围绕产品文档中的安静研究画布，不使用大面积紫色渐变：

| 语义 | 建议值 | 用途 |
| --- | --- | --- |
| `--color-canvas` | `#F5F6F3` | 页面底色 |
| `--color-surface` | `#FCFCFA` | 阅读表面 |
| `--color-ink` | `#20231F` | 主文字 |
| `--color-muted` | `#6B7168` | 次要信息 |
| `--color-line` | `#D8DDD5` | 边界和来源线 |
| `--color-ai` | `#435A73` | AI 状态和来源节点 |
| `--color-later` | `#9A6A24` | 稍后再学语义 |
| `--color-danger` | `#A33B36` | 错误与危险操作 |

圆角使用统一层级：`--radius-control: 10px`、`--radius-button: 12px`、`--radius-input: 18px`、`--radius-panel: 20px`、`--radius-circle: 50%`。固定侧栏贴边，不使用面板圆角。

字体优先使用本机可用字体，不为首个切片引入远程字体请求。中文正文使用系统无衬线字体栈；较长阅读内容可在后续原型验证本地衬线字体。正文行宽控制在约 68 至 76 个中文字符的舒适范围。

### 7.4 标志性元素

使用一条克制的“研究来源线”串联用户输入、AI 占位、生成状态和后续回答。它既表示本轮生成关系，也为之后的研究分支来源线保留一致语言。

来源线不应成为装饰时间线：只在确有父子关系时显示节点，不给普通列表强行编号。

### 7.5 动效

- 首屏只做一次轻微内容显现；
- AI 占位使用低对比度呼吸或静态骨架；
- 流式文字不逐字跳动布局，按稳定片段追加；
- 抽屉和状态变化控制在短时、低位移范围；
- `prefers-reduced-motion: reduce` 下关闭非必要动画。

## 8. 建议前端工程结构

```text
apps/web/
├─ package.json
├─ tsconfig.json
├─ vite.config.ts
├─ index.html
├─ src/
│  ├─ main.tsx
│  ├─ app/
│  │  ├─ App.tsx
│  │  ├─ router.tsx
│  │  ├─ services.tsx
│  │  ├─ useMediaQuery.ts
│  │  └─ usePrefersReducedMotion.ts
│  ├─ api/
│  │  ├─ client.ts
│  │  ├─ research.ts
│  │  ├─ task-events.ts
│  │  └─ errors.ts
│  ├─ features/
│  │  ├─ auth/
│  │  ├─ navigation/
│  │  ├─ research-session/
│  │  └─ chat-composer/
│  ├─ components/
│  │  ├─ AppShell/
│  │  ├─ StatusMessage/
│  │  └─ Skeleton/
│  ├─ styles/
│  │  ├─ tokens.css
│  │  ├─ global.css
│  │  └─ utilities.css
│  └─ test/
└─ e2e/
   └─ research-session.spec.ts
```

保持组件聚焦。数据获取、渐进事件和展示组件分离；不要在一个大组件中同时处理路由、网络、事件解析、表单和全部视觉状态。

## 9. 路由建议

| 路由 | 作用 |
| --- | --- |
| `/` | 自动恢复最近会话；没有会话时显示开始页 |
| `/research/new` | 新研究开始状态，不提前创建空数据库记录 |
| `/research/:sessionId` | 研究会话和恢复入口 |

无效会话 ID 显示“这场研究不存在或已经清理”，并提供返回开始页；不要自动创建同名会话掩盖错误。

## 10. 已实现后端契约

以下契约的研究会话基础由后端提交 `e4ce72ebb9ba1df18a72481b8e83ef67988357c1` 实现；会话创建幂等由当前 migration v15 切片补充。接口行为由 `tests/research-session.test.ts` 和 `tests/sqlite-store.test.ts` 验证。

共享类型位于 `packages/capture-contracts/src/index.ts`：

- `ResearchSessionRecord`；
- `ResearchMessageRecord`；
- `ResearchTaskRecord`；
- `ResearchSessionView`；
- `ResearchTurnAccepted`；
- `ResearchTaskEvent`。

KIMI 3 直接导入共享类型，不在前端复制一套近似接口。

### 10.1 会话列表

```http
GET /v1/research-sessions
```

当前响应是按 `updatedAt`、`createdAt` 倒序排列的 `ResearchSessionRecord[]`：

```json
[
  {
    "id": "session-id",
    "title": "理解注意力机制",
    "status": "active",
    "createdAt": "2026-07-17T08:00:00.000Z",
    "updatedAt": "2026-07-17T08:01:00.000Z"
  }
]
```

当前没有分页、`limit` 或 `currentContentId`。首个前端切片可以直接显示当前本机列表；引入大量历史数据前由 GPT-5.6 增加分页契约。

### 10.2 创建会话

```http
POST /v1/research-sessions
Content-Type: application/json
Idempotency-Key: <uuid>

{
  "title": "理解注意力机制"
}
```

响应为 `201` 和 `ResearchSessionRecord`。`title` 可省略，省略时使用“新研究会话”；标题长度为 1 至 200 个字符。`Idempotency-Key` 必填且不超过 200 个字符。

前端为一次创建意图生成稳定的幂等键。请求失败且结果不确定时，重试复用原键；后端在 SQLite 事务中返回首次创建的同一会话，不新增空会话，也不使用重试请求中的标题覆盖首次标题。用户成功进入会话后，再次明确开始新研究时生成新键。

### 10.3 获取恢复视图

```http
GET /v1/research-sessions/:sessionId
```

响应为 `ResearchSessionView`：

```json
{
  "session": {},
  "messages": [],
  "tasks": [],
  "attachments": [],
  "importTasks": []
}
```

消息、任务、附件和导入任务按创建时间稳定排序。`ResearchTaskRecord` 包含输入/输出消息 ID、幂等键、状态、是否可重试、模型路由、提示版本、错误和时间。附件和导入任务用于刷新、关闭页面和服务重启后恢复文件处理状态。

### 10.4 文件导入与阅读恢复

```http
POST /v1/research-sessions/:sessionId/imports
Content-Type: text/plain | text/markdown | application/vnd.openxmlformats-officedocument.wordprocessingml.document | application/pdf
X-File-Name: <encodeURIComponent(file.name)>
Idempotency-Key: <uuid>

<原始文件字节>
```

当前 MVP 接受 TXT、Markdown、DOCX 和文本型 PDF，单文件上限为 20 MiB。文件名必填且不超过 255 个字符；上传幂等键必填且不超过 200 个字符。响应为 `202` 和 `{ attachment, task }`。上传键只在同一会话内生效，与创建会话键和消息键相互独立；网络结果不确定时重用原键和同一文件。若同一会话的同一键改传另一文件，返回 `409 idempotency_conflict`。

公开的 `ResearchAttachmentRecord` 只包含稳定 ID、会话 ID、文件名、MIME、大小、SHA-256、状态、任务 ID、可选内容快照 ID和时间，不包含本地路径。`ResearchImportTaskRecord.status` 为 `queued | running | completed | failed | cancelled`，进度阶段为 `queued | parsing | persisting | completed`。

状态与阅读接口：

```http
GET  /v1/research-imports/:taskId
GET  /v1/research-imports/:taskId/events
POST /v1/research-imports/:taskId/cancel
POST /v1/research-imports/:taskId/retry
GET  /v1/research-content/:contentSnapshotId
```

导入 SSE 与研究消息 SSE 分离，支持 `Last-Event-ID` 或 `?after=<sequence>`，事件为 `snapshot | progress | completed | failed | cancelled`。终态后关闭连接并查询最终任务；断线时按现有研究任务策略退避重连和回退查询。

取消只接受 `queued` 或 `running`，其他状态返回 `409 import_not_cancellable`。重试只接受 `failed && retryable`，保留同一任务、附件、原文件和稳定 ID，清除旧事件并重新排队；其他状态返回 `409 import_not_retryable`。服务重启时 queued 继续处理，running 转为 `failed/service_restarted` 并可重试；completed 的内容快照和结构锚点保持不变。

`ResearchContentSnapshotRecord` 包含稳定 block ID、顺序、文本和结构锚点。TXT 保留行号；Markdown 保留行号、标题和 heading/paragraph/list/code；DOCX 保留段落序号、标题和 heading/paragraph/list/table；PDF 保留页码。前端依据 `contentSnapshotId` 和 block ID 进入同一会话阅读视图，不保存 DOM 路径，也不猜 MIME。

稳定上传错误：

| HTTP | 错误码 | 前端动作 |
| --- | --- | --- |
| 400 | `idempotency_key_required` / `invalid_file_name` / `empty_file` | 修正请求或提示重新选择 |
| 413 | `file_too_large` | 提示 20 MiB 上限 |
| 415 | `unsupported_file_type` | 提示仅支持 TXT、Markdown、DOCX、PDF |
| 422 | `invalid_file_content` | 提示文件内容与声明格式不符 |
| 409 | `idempotency_conflict` / `import_not_cancellable` / `import_not_retryable` | 刷新任务状态或生成新上传意图 |
| 404 | `not_found` | 会话、任务或快照不存在 |

### 10.5 提交消息

```http
POST /v1/research-sessions/:sessionId/messages
Content-Type: application/json
Idempotency-Key: <uuid>

{
  "content": "为什么 Transformer 需要多个注意力头？"
}
```

`content` 去除首尾空白后必须非空，原始长度上限 200,000 字符；`Idempotency-Key` 必填且不超过 200 字符。

响应为 `202` 和 `ResearchTurnAccepted`：

```json
{
  "session": {},
  "inputMessage": {},
  "outputMessage": {},
  "task": {}
}
```

后端在一次 SQLite 事务中保存用户消息、AI 占位消息、任务和会话更新时间。同一会话内使用同一个幂等键重复提交会返回同一组记录。前端重试网络请求时必须复用原幂等键；用户明确再次发送才生成新键。

### 10.6 查询任务

```http
GET /v1/research-tasks/:taskId
```

用于初次恢复、SSE 中断和后台任务完成后的最终确认。

`ResearchTaskRecord.status` 是 `queued | running | completed | failed`。AI 占位消息的状态是 `pending | streaming | completed | failed`。

### 10.7 渐进事件

```http
GET /v1/research-tasks/:taskId/events
Accept: text/event-stream
```

也可以使用 `Last-Event-ID` 请求头或 `?after=<sequence>` 只读取指定序号之后的持久化事件。`after` 必须是非负安全整数。

事件语义：

```text
event: snapshot
data: {"type":"snapshot","task":{},"message":{},"createdAt":"..."}

id: 41
event: delta
data: {"id":41,"type":"delta","delta":"新增片段","message":{},"createdAt":"..."}

id: 42
event: completed
data: {"id":42,"type":"completed","task":{},"message":{},"createdAt":"..."}

id: 43
event: failed
data: {"id":43,"type":"failed","task":{},"message":{},"createdAt":"..."}
```

客户端要求：

- 先处理 `snapshot`，再合并 `delta`；
- `delta.message` 已包含追加后的完整消息，前端优先用它替换同 ID 消息；`delta` 字段用于增量动效，不作为唯一事实来源；
- 使用事件 `id` 去重并保存当前连接的内存游标，不依赖到达次数；
- `completed` 或 `failed` 后关闭连接并获取最终任务状态；
- 服务端单次 SSE 连接最长约 25 秒；未完成时浏览器需要使用 `Last-Event-ID` 自动或手动重连；
- 连接中断时使用退避重连，超过前端重试上限后回退任务查询；
- 不把认证令牌拼进 URL；
- 同源 Cookie 由浏览器自动携带；
- 页面隐藏时降低轮询频率，页面恢复时立即同步一次。

### 10.8 失败重试

```http
POST /v1/research-tasks/:taskId/retry
Content-Type: application/json

{}
```

仅当任务是 `failed` 且 `retryable: true` 时返回 `202` 和重新排队后的 `ResearchTaskRecord`。重试沿用原任务和 AI 消息，清理该任务旧事件，并从空 AI 消息重新生成；前端不要新增第二条占位消息。

当前可重试任务错误：

| 错误码 | 含义 | 用户可见结果 |
| --- | --- | --- |
| `model_not_configured` | 没有可用模型 | 输入已保存；配置模型后可重试 |
| `provider_error` | 模型调用、格式或本地输出边界失败 | 输入和已有内容保留；可以稍后重试 |
| `service_restarted` | 服务在任务运行中重启 | 部分输出保留；任务标记为可重试 |

### 10.9 HTTP 错误格式

沿用后端统一结构：

```json
{
  "error": {
    "code": "invalid_request",
    "message": "content is required"
  }
}
```

当前 HTTP 错误码包括 `unauthorized`、`local_access_denied`、`invalid_request`、`not_found` 和 `internal_error`。任务生成错误保存在 `ResearchTaskRecord.error`，不会作为消息提交接口的 HTTP 失败返回。

当前接口尚未返回 `requestId`。前端按 `code` 映射用户文案，不依赖英文 `message` 做逻辑判断。

### 10.10 认证和来源校验

除 `/`、`/health` 和配对码交换外，数据路由需要以下一种凭据：

- `Authorization: Bearer <token>`；
- `collector_session` HttpOnly Cookie。

浏览器 Cookie 通过以下现有接口取得：

```http
POST /v1/pairings/exchange
Content-Type: application/json

{
  "code": "123456",
  "session": true
}
```

成功后返回 `{ "paired": true }`，并设置 `HttpOnly; SameSite=Strict; Path=/` Cookie。KIMI 3 不读取 Cookie 内容。

后端已拒绝非 `127.0.0.1` / `localhost` Host、错误同源 Origin 和未授权访问。Chrome 扩展 Origin 仍按现有受控规则允许。

启动器通过短时一次性回环入口完成首次 WebUI 配对，生产 WebUI 静态资源由同一本机服务提供；页面、资源、HTTP 与 SSE 使用同一 loopback 来源。手动 6 位码页只作为开发回退。

### 10.11 当前模型流限制

确定性假模型可以真正逐段产生 `delta`。当前真实模型网关等待供应商返回完整 JSON 回答，再按最多 80 字符拆分写入 SSE。因此持久化、续传和前端渐进契约已成立，但首片延迟仍等于完整云模型响应时间。KIMI 3 不要用前端定时器伪造更早的模型输出。

## 11. 客户端状态规则

- 服务端是会话、消息和任务的唯一事实来源；
- 路由保存当前会话身份；
- React 本地状态只保存抽屉、输入草稿和瞬时交互；
- 不在组件间复制完整会话对象；
- 首个切片不需要 Redux 等全局状态库；
- 请求可以使用轻量自建 hook 或小型请求库，但要避免重复并发和请求瀑布；
- 会话详情和 AI 配置等互不依赖请求应并行；
- SSE delta 合并必须使用函数式状态更新，避免闭包丢片段；
- 列表和消息使用稳定数据库 ID 作为 React key；
- 不使用数组下标作为持久内容 key。

## 12. 安全要求

- 只请求当前页面同源 `/v1/...`；
- 不接受用户输入的 API base URL；
- 不读取或展示 `collector_session` Cookie；
- 不把 Bearer token、Cookie、API Key 写入 localStorage、sessionStorage、URL、日志或错误上报；
- 所有 AI 内容和来源内容视为不可信文本；首个切片默认按纯文本渲染；
- 后续 Markdown 渲染必须使用严格白名单清理；
- 禁止 `dangerouslySetInnerHTML`，除非有专门的安全封装和测试；
- 文件名、会话标题和错误信息按普通文本呈现；
- 401 停止自动重试并提示重新打开 Collector；
- 403 来源拒绝不使用替代跨域请求绕过；
- 外部链接接入后使用明确来源和安全的新窗口属性。

## 13. 可访问性与键盘

- 页面只有一个 `h1`，章节按 `h2`、`h3` 顺序；
- Chat 输入具有可见标签，不只依赖 placeholder；
- 发送使用原生 `button`；
- `Enter` 发送，`Shift+Enter` 换行，并在界面中说明；
- 输入为空或请求未确认时正确禁用发送；
- 动态生成状态通过克制的 `aria-live="polite"` 通知；
- 不逐片段朗读所有流式文字，完成后再通知结果可用；
- 打开导航抽屉时移动焦点，关闭后返回触发按钮；
- Escape 关闭临时抽屉；
- 所有交互具有清楚的 `:focus-visible`；
- 颜色不是状态的唯一表达，状态同时包含文字；
- 320、768、1024、1440 像素宽度下验证布局；
- 200% 缩放下不遮挡发送、返回和错误恢复操作。

## 14. 测试交付

### 14.1 组件与客户端测试

至少覆盖：

- 会话列表空、成功和失败；
- 提交确认前保留草稿；
- 提交成功后清空草稿；
- 幂等键在网络重试中保持不变；
- `snapshot`、重复 `delta`、`completed` 和 `failed` 事件处理；
- SSE 中断回退查询；
- 401、404、模型未配置和普通 500 文案；
- 减少动态效果设置。

### 14.2 Playwright 真实浏览器测试

使用隔离端口、数据目录、本地会话和确定性假模型，覆盖：

1. 首次打开显示空状态；
2. 输入问题并提交；
3. 用户消息和 AI 占位立即出现；
4. 渐进内容进入同一条消息；
5. 完成状态出现；
6. 刷新页面恢复同一会话和完整内容；
7. 关闭页面后重新打开仍可恢复；
8. 模型未配置时输入保留并显示恢复状态；
9. 快速双击发送不会创建两条不同任务；
10. 键盘完成打开导航、输入、发送和返回；
11. 320、768、1024、1440 像素截图无溢出；
12. 浏览器控制台没有错误和警告；
13. 网络请求状态和路径符合契约；
14. API 可见结果和 SQLite 记录与界面一致。

### 14.3 分级验证命令

KIMI 3 按 `COLLAB-PROTOCOL 1.3.0` 第 7.3 节选择验证范围：

- 只改文档、文案、交接状态或元数据时，检查格式、链接、版本和提交范围，不运行前端构建、测试或浏览器验证；
- 修改前端组件、样式、客户端状态或逻辑时，运行前端构建或类型检查以及受影响的测试；
- 修改用户可见交互时，在上一项基础上运行真实浏览器验证，覆盖受影响视口、键盘、可访问性、控制台和网络；
- 修改共享契约、构建配置、跨端集成，或进行发布回交时，运行完整验证入口。

完整验证入口应提供类似命令：

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run test:web
npm.cmd run test:e2e
powershell -ExecutionPolicy Bypass -File .agents\skills\collector-engineering\scripts\check-project.ps1
```

命令名称可以根据最终 `package.json` 调整，但根目录必须提供单一、清楚的完整验证入口。阶段 D 的跨端集成回交执行完整验证；日常局部改动不默认重复无关检查。

## 15. 实施顺序

### 阶段 A：工程和只读恢复

- 建立 `apps/web`、Vite 构建和根 TypeScript reference；
- 建立路由、令牌化样式和 AppShell；
- 接入会话列表和会话详情；
- 完成空、加载、错误、404 和认证过期状态；
- 完成同源开发代理或生产静态资源服务。

验收：可以在浏览器中打开真实会话，刷新后内容一致。

### 阶段 B：真实提交

- 实现 ChatComposer；
- 生成并复用幂等键；
- 接入提交接口；
- 显示用户消息、AI 占位和任务状态；
- 完成未配置模型与请求失败恢复。

验收：提交先落库，刷新后仍能看到输入和任务。

### 阶段 C：渐进事件和恢复

- 接入 SSE；
- 处理 snapshot、delta、completed、failed；
- 实现断线重连和状态查询回退；
- 避免重复片段和布局跳动。

验收：生成中刷新、断线和重新打开都恢复一致。

### 阶段 D：浏览器验收和同源交付

- 增加 Playwright；
- 运行多视口、键盘、控制台和网络验证；
- 验证 SQLite 结果；
- 接入生产构建静态资源；
- 更新 README 和人工验收手册。

验收：完整用户路径、构建、测试和项目检查全部通过。

## 16. 后续产品切片与前端扩展边界

GPT-5.6 负责按纵向切片控制整体产品框架。KIMI 3 当前只实现第一个切片，但工程结构需要允许后续能力在不推翻研究画布的情况下进入。

| 顺序 | 后续纵向切片 | 前端新增区域 | 首个切片需要预留的边界 |
| --- | --- | --- | --- |
| 1 | 启动并恢复研究会话 | 会话列表、研究画布、Chat、任务状态 | 当前交付 |
| 2 | 选区智能窗口 | 选区定位浮层、小屏底部抽屉、AI 字段占位 | 当前内容使用语义化、可选择的正文容器 |
| 3 | 深入研究 | 轻量二选一、来源条、研究分支路由 | 路由和画布不把消息层级写死为单层 |
| 4 | 稍后再学 | 右侧抽屉、优先级和弱重现 | AppShell 保留按需右侧区域，不常驻空侧栏 |
| 5 | 来源返回与引用 | 行内引用胶囊、来源预览和定位高亮 | 消息内容组件允许安全的结构化片段渲染 |
| 6 | 文件导入与阅读 | 上传状态、内部阅读器、页码和结构锚点 | 当前内容类型通过共享契约区分，不在组件里猜 MIME |
| 7 | AI 弱标记 | 低注意力概念标记和按需解释 | 选区与标记层独立于正文文本数据 |
| 8 | 按需搜索 | 联网状态、搜索轨迹和外部来源 | 任务状态组件支持工具步骤但首版不显示假步骤 |
| 9 | 设置与本地观测 | 模型状态、任务轨迹、导出和清理 | API 客户端统一错误与请求 ID，不分散记录敏感数据 |

扩展原则：

- 每个切片同时完成契约、持久化、服务、HTTP/事件、WebUI、刷新恢复和浏览器验收；
- GPT-5.6 在同一后端阶段连续补齐共享契约、迁移、持久化、接口、恢复和确定性联调条件，达到 `frontend-ready` 后再交给 KIMI 3；KIMI 3 不接收仅有契约说明或缺少真实可调用能力的半成品交接；
- 未来能力通过明确内容类型和领域 ID 进入，不通过大量布尔属性堆叠在单一消息组件上；
- AppShell 只定义画布、按需抽屉和来源区域，不预先渲染空白功能面板；
- 当前内容渲染器与 Chat 消息列表分离，为文档和研究分支复用；
- 来源锚点、选区和引用由后端稳定 ID 驱动，前端不保存脆弱 DOM 路径作为唯一依据；
- 每完成一个切片再更新当前产品文档，不在文档中提前标记后续能力已实现。

## 17. 禁止事项

- 不使用静态假会话作为最终实现；
- 不在后端确认前显示“已保存”；
- 不只在 localStorage 保存研究会话；
- 不把模型输出当作可信 HTML；
- 不使用轮询替代全部渐进事件而不说明原因；
- 不为未来功能引入复杂全局状态；
- 不使用大面积紫色渐变、泛滥圆角卡片、装饰性统计和模板化英雄区；
- 不让每条消息都成为厚重卡片；
- 不用整页 spinner 代替稳定内容骨架；
- 不隐藏失败原因或用“出错了”作为唯一说明；
- 不在自动化测试中调用真实云模型；
- 不把用户未提交的草稿发送到后端或外部服务。

## 18. 完成交付清单

KIMI 3 提交前逐项确认：

- [ ] `apps/web` 构建成功；
- [ ] WebUI 和 API 同源运行；
- [ ] 最近会话来自真实 API；
- [ ] 提交操作使用真实事务和幂等任务；
- [ ] AI 加载占位立即出现且布局稳定；
- [ ] 渐进事件不会重复或覆盖已有内容；
- [ ] 页面刷新和服务重启恢复一致；
- [ ] 模型未配置时输入仍然存在；
- [ ] 空、加载、离线、失败、401、404 状态完整；
- [ ] 键盘、焦点、语义结构和减少动态效果通过；
- [ ] 320、768、1024、1440 像素验证通过；
- [ ] 控制台无错误和警告；
- [ ] Playwright 验证 WebUI、API 和 SQLite 同一结果；
- [ ] 没有真实云模型调用；
- [ ] README、架构和人工验收文档只更新当前有效事实；
- [ ] 已创建 KIMI 3 到 GPT-5.6 的增量交接文件；
- [ ] 已更新 `docs/handoffs/CURRENT.md` 和 `docs/handoffs/INDEX.md`；
- [ ] 已说明基线版本是否变化和下一轮最小必读列表；
- [ ] Git 提交按实现边界和交接边界组织，只包含本次相关改动；
- [ ] 新交接文件、`CURRENT.md`、`INDEX.md` 和相关接收状态没有拆成多个小提交。

## 19. 后端与前端联调状态

### 当前已确认

- 研究会话基础、会话创建与消息幂等、SQLite migration v16、文件导入、内容快照和可恢复事件均已实现；
- 会话内附件按钮连接真实上传，开始页附件按钮因没有会话上下文保持占位；
- TXT、Markdown、DOCX 与文本型 PDF 可以上传、取消、失败重试并进入同画布阅读视图；
- 导入状态通过独立 SSE 恢复；切换会话后旧上传结果和待重试文件不会进入新会话；
- 研究消息与导入 SSE 在首次断线后查询任务确认认证状态，确认 401 时立即停止并进入重新配对；确认查询拿到终态时直接更新任务并停止重连，即使查询返回前已切到轮询也不会丢弃晚到的 401 或终态；
- `npm run test:web` 共 99 项，全部通过；
- `npm run test:e2e` 共 22 项 Chromium 场景，全部通过并自然退出；
- 最近完整 Node 验证记录为 137 项，见 H-011；
- Collector 项目检查最近记录通过；
- 测试使用确定性假模型，没有真实云模型调用。

### 启动器切片已完成

- `Collector.cmd` 和 `npm.cmd run launch` 启动或复用同一本地服务，并打开默认浏览器；
- 正式启动器让系统选择可用端口，实例文件记录进程、端口和实例 ID，健康检查核对身份后才复用；
- 启动器专用控制凭据在独立私有文件中保存，普通已配对客户端不能申请浏览器启动入口；
- 一次性回环入口下发 HttpOnly、SameSite=Strict Cookie 后立即关闭，URL、storage、实例文件和日志不包含会话令牌；
- 已配对浏览器扩展通过 `43110` 本机适配入口访问同一领域服务，未配对请求仍返回 401；
- 14 项 Chromium 场景通过并自然退出；场景验证自动配对、URL 无令牌、Cookie 不可被页面读取、创建响应丢失后恢复同一会话、控制台无错误与产品请求同源。

### 会话创建幂等已完成

- 创建接口要求 `Idempotency-Key`，同一键的并发请求和服务重启后重试返回同一会话；
- WebUI 在创建响应丢失后保留原键，用户点击重试会恢复已经落库的会话；
- SQLite migration v15 为新会话保存创建幂等键，既有会话保持兼容；
- 单元、API、重启恢复和真实 Chromium 场景覆盖了结果不确定时不产生重复空会话。

### 后续实现顺序

1. 在接近 20 MiB 的浏览器性能目标、Markdown 列表结构渲染和第 16 节下一纵向切片之间确定优先级；
2. 需要时增加会话列表分页和自动标题更新；
3. 供应商原生流式输出，降低真实模型首片延迟。

以上阻塞项未完成前，KIMI 3 不自行引入 token URL 参数、浏览器持久化密钥、跨域绕过、假上传成功或前端伪流式输出。

## 20. KIMI 3 完成后的回交约定

KIMI 3 的工作完成不等于协作轮次完成。只有完成以下回交，GPT-5.6 才接回后端和产品框架责任：

1. 从 `docs/handoffs/TEMPLATE.md` 创建下一份递增编号的 `KIMI3-TO-GPT56` 文件；
2. 把本轮接收的 GPT-5.6 交接标记为 `accepted` 或 `superseded`；
3. 更新 `docs/handoffs/CURRENT.md`，将当前责任改为 GPT-5.6，并列出 GPT-5.6 的本轮必读；
4. 更新 `docs/handoffs/INDEX.md`；
5. 按 `COLLAB-PROTOCOL 1.3.0` 的任务边界提交：前端代码、测试和直接相关的长期文档形成实现提交；只有正式转移责任且交接需要引用已生成的实现提交哈希时，才增加一笔交接提交；
6. 新交接文件、`CURRENT.md`、`INDEX.md` 和相关接收状态合并到同一交接边界，不分别提交，并报告相关提交哈希；
7. 按 `docs/IMPLEMENTATION_COLLABORATION_PROTOCOL.md` 第 9 节提供完整回交证据。

回交至少回答：

- 用户现在能完成什么，哪些状态仍未完成；
- 修改了哪些文件、依赖、路由、组件和客户端行为；
- 实际调用的接口、SSE、错误和恢复行为是否与共享契约一致；
- 真实浏览器、多视口、键盘、焦点、可访问性、控制台和网络结果；
- 刷新、关闭页面和重新打开后的恢复结果；
- WebUI 操作对应的 API 与 SQLite 结果；
- 发现了哪些后端缺口，如何复现，期望 GPT-5.6 提供什么契约；
- 运行了哪些命令，哪些通过、失败、跳过，是否调用真实云模型；
- 哪些实现是临时兼容、假数据、技术债或不能进入正式交付；
- 长期基线是否变化，下一轮 GPT-5.6 只需要读取哪些文件和章节。

缺少真实浏览器证据、接口核对或刷新恢复验证时，交接状态只能是部分完成或阻塞，不能写成前端完成。
