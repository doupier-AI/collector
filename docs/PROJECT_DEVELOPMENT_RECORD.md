# Collector 项目开发记录

最后更新：2026-08-01

状态：截至当前源码的项目阶段记录。本文记录已经发生的产品与工程里程碑、关键提交、验证证据和遗留限制；当前产品定义以 `PRODUCT.md` 为准，切片计划与状态见 `MVP_IMPLEMENTATION_PLAN.md`，源码与测试是实现状态的最终依据。

进行中：阶段 H（统一研究节点树与弱标记生长）已于 2026-07-30 启动，H1（节点数据模型归并与迁移）已在 `c696317` 完成。H3c（issue #20，悬停流式预览、一次生成复用与点击生长）已于 2026-08-01 完成；修订二·D（issue #12，标记按钮与笔记输入框）已在 `e26c6fa` 完成；本轮修订二·E（issue #13，标记列表与原文返回，`18f93d4`）完成后，用户可以查看选区、笔记、来源节点和时间，点击列表项目返回原文并恢复高亮，恢复后只有明确点击【引用】才进入引用态。阶段 E（可信研究能力）已于 2026-07-22 完成并提交（`0343c56`），真实供应商联网验收受限于当前供应商能力——当前已配置的 DeepSeek（`deepseek-v4-flash`）不支持原生联网（`webGrounding: "unsupported"`），阶段 E 以代码实现与自动化测试作为完成边界。阶段 F（联网搜索策略改进）已全部完成：F1 日志+查询改写（`68b39be`）、F2 工具拆分+Agent 多轮循环（`9952a02`）、F3 多搜索后端（`efe0d73`）。阶段 G（WebUI 模型配置）已完成：G1 配置与凭证持久化（`0bf2781`）、G2 配置管理增强与按任务类型分配（`3581c46` / `d198a7e` / `50f7007`）、G3 模型设置页交互优化（`7b0adfc`）。2026-07-31 的最新真实模型与可见浏览器复核见 §3.42：可见 Chrome 主流程通过，真实模型 Playwright 验收 1/4 通过，另 3 个场景停在自动化选区辅助函数。

批次①（Markdown 渲染 + 悬停来源卡片，2026-07-23）已交付：`b814d95`（引用角标悬停来源卡片）+ `3b1f124`（AI 文本统一 Markdown 渲染管线）——见 §3.25。

## 1. 记录原则

- 按用户可见结果、可独立验证的工程阶段、关键提交、验证证据和遗留限制记录；
- 长期产品共识、交互规则、架构边界和验收标准保留在各自文档，本文只记录已经发生的阶段事实；
- “已实现”以对应源码、提交和验证证据为依据；历史验证只证明当时记录的代码状态，不自动证明后续版本仍然通过；
- 未验证、部分验证和已知限制与完成项分开记录；
- 详细文件变化可以通过所列 Git 提交审查。

### 1.1 真实模型验收配置（2026-07-31）

- 真实模型验收脚本 `apps/web/e2e/acceptance-real-harness.mjs` 在未提供 `COLLECTOR_AI_*` 环境变量时，读取本机 `.collector-data/collector.sqlite` 中已保存的模型配置与凭证；优先使用 DeepSeek `deepseek-v4-flash`，环境变量仍可作为明确覆盖。
- 每次验收继续使用独立临时数据目录，持久化配置数据库只读访问，不把 API Key 写入源码、Git 或日志。
- 验证证据：无环境变量启动验收 harness 成功，输出 `provider=deepseek model=deepseek-v4-flash`；`node --check apps/web/e2e/acceptance-real-harness.mjs` 通过；随后在 Chrome DevTools MCP 的可见 Chrome 中实际完成 DeepSeek 回答、选区、标记、笔记、列表返回、高亮恢复、深入研究和在此追问。真实模型 Playwright 验收 4 个场景中 1 个通过，另 3 个因自动化选区辅助函数未找到足够长文本而失败，详见 §3.42。
- 关键提交：`cc3d6f7`（稳定复用本机真实模型配置）；`c840ffe`（记录持久化配置规则）；`AGENTS.md` 已记录长期读取规则。

## 2. 当前用户可见状态

当前程序已经形成以下本地使用路径：

1. 用户通过 `Collector.cmd` 或 `npm.cmd run launch` 启动或复用本机服务，并在默认浏览器打开 Collector；
2. 用户可以创建和恢复研究会话，提交 Chat 问题，并查看渐进生成状态；
3. 用户可以在已有研究会话中选择或拖入 TXT、Markdown、DOCX 和文本型 PDF，单文件上限为 20 MiB；
4. 用户可以查看导入状态、取消处理中任务、重试可恢复失败，并在同一研究画布中阅读稳定内容快照；
5. 页面刷新、关闭重开和阅读路由直接刷新后，会话、消息、任务、附件和内容快照从本机数据恢复；
6. 用户可以使用 `npm.cmd run launch:mvp` 在无网络、无模型密钥环境中演示上述流程；模拟回答始终标明“本地演示回答｜非真实 AI｜未联网检索”。

当前实现已经连通核心闭环的完整主链路：阅读当前内容（Chat 回答与导入文档）→ 手动选择文字 → 选区上方浮动胶囊 → 显式引用或立即标记 → 可选填写笔记 → 右侧标记列表展示选区、笔记、来源节点和时间 → 点击项目返回原内容原选区并恢复高亮和浮动胶囊；恢复后不会自动创建引用，用户明确点击【引用】后才进入引用态。标记保存、列表展示、刷新恢复、旧数据兼容和来源返回不依赖 AI。

此前收尾阶段已用真实 DeepSeek 模型 + 真实 Chromium 浏览器完成四场景端到端验收（场景一 Chat → 深入研究 → 返回 → 刷新；场景二文档导入 → 独立研究 → 返回 → 重启恢复；场景三标记保存 → 列表 → 返回原选区 → 刷新；场景四刷新幂等 + 材料范围 + 无演示标记）。2026-07-31 的 Issue 13 最新复核已在可见 Chrome 中复跑标记列表、来源返回、刷新恢复和双模操作；真实模型 Playwright 套件另有 3 个场景停在自动化选区辅助函数，当前不把旧四场景结果当作本次版本自动化套件全部通过的证据。

```text
核心闭环主链路已全部连通；此前收尾版本已通过真实模型端到端验收（DeepSeek + 真实 Chromium，四场景全通过），本次 Issue 13 复核的最新边界见 §3.42
阅读当前内容 → 手动选区 → 选区上方浮动胶囊
→ 深入研究 / 标记与笔记 → 保留来源关系 → 返回原内容和原选区
```

旧“稍后再学”的后端与数据底座在切片 D1 完成并作为兼容层保留；修订二·D/E 在其上连通用户可见的标记保存、笔记输入、标记列表、来源节点投影、刷新恢复和原文返回（二级 / 四级 + 真实浏览器 + e2e 验证）。

因此，当前版本证明本地运行、研究会话、文件导入、阅读、恢复底座、选区引用、深入研究全链路与标记保存 / 笔记 / 列表 / 来源返回均可用；旧数据仍可读取，标记主链路不依赖模型。

## 3. 产品与工程阶段

### 3.1 产品重构与开发基线（2026-07-17）

**目标**

将 Collector 确认为本地优先的 AI 学习与研究 Web 应用，统一 Chat、文档阅读、选区、深入研究、稍后再学和来源返回的产品语言，并从旧桌面界面转向本地 WebUI。

**结果**

- 形成产品定义、功能链路、交互设计、界面方向、输入来源、架构和人工验收基线；
- 确认 Chat 与导入文档是并列入口，AI 回答、导入文档和研究分支都属于“当前内容”；
- 移除 Electron 桌面端实现，确定浏览器中的本地 WebUI 为唯一产品界面；
- 建立 TypeScript、Node、SQLite、模型网关和浏览器测试的开发基础。

**关键提交**

- `76cb329`：项目重构开发前状态；
- `68f42eb`：开发前基线；
- `53dcfd9`：合并 WebUI 重构与模型供应商开发基线；
- `beddd4c`：移除 Electron 桌面端实现。

### 3.2 研究会话后端纵向切片（2026-07-17）

**用户和产品结果**

研究会话获得真实的本地持久化和恢复基础。用户输入先保存，再创建生成任务；失败时保留输入和会话现场。

**工程结果**

- 建立研究会话、消息、生成任务和任务事件的共享类型；
- 使用 SQLite 保存会话、输入、AI 占位、生成状态和可重放事件；
- 提供会话列表、会话详情、消息提交、任务查询、失败重试和渐进事件接口；
- 支持 `snapshot`、`delta`、`completed` 和 `failed` 事件；
- 确定性假模型用于自动化测试，不调用真实云模型。

**关键提交**

- `e4ce72e`：实现研究会话后端纵向切片。

### 3.3 首个本地 WebUI（2026-07-17）

**用户可见结果**

用户可以在浏览器中看到研究会话列表和研究画布，提交问题，查看同一条 AI 消息逐步补全，并在刷新后恢复会话和生成状态。

**工程结果**

- 建立 React 19、TypeScript、Vite 8 和 React Router 7 WebUI；
- 接入真实会话、消息、任务和渐进事件接口；
- 完成空状态、加载、离线、认证过期、未配置模型、失败和重试反馈；
- 建立响应式布局、键盘操作、焦点、减少动态效果和可访问性基础；
- 引入 Playwright，核对 WebUI、API 和 SQLite 的一致结果；
- 调整双侧栏、输入区、占位标志和整体界面方向。

**关键提交**

- `5db1a85`：实现启动并恢复研究会话的首个 WebUI；
- `9a3ad62`：调整双侧栏、尺寸、输入按钮和界面细节。

### 3.4 WebUI 与本机 API 同源交付（2026-07-18）

**用户可见结果**

正式服务使用同一本地地址提供页面、静态资源、HTTP 请求和渐进事件，用户不需要分别启动前端和 API。

**工程结果**

- Node 服务直接提供 WebUI 生产构建；
- 支持浏览器路由回退，同时保持 API 和静态资源边界；
- Playwright 直接连接同源服务；
- 修复端到端测试完成后服务不能自然退出的问题。

**关键提交**

- `709246b`：实现 WebUI 与本机 API 同源生产服务；
- `07ae609`：收敛同源浏览器测试并修复测试收尾。

### 3.5 动态端口启动器与首次安全配对（2026-07-18）

**用户可见结果**

用户可以双击启动器，Collector 自动启动或复用本机服务，并在默认浏览器打开已配对工作区。重复启动不会创建第二套数据服务。

**工程结果**

- 正式启动器使用系统分配的动态端口；
- 实例文件记录进程、端口和实例身份，复用前核对健康状态与身份；
- 一次性回环入口设置 `HttpOnly; SameSite=Strict` Cookie；
- 会话令牌不进入 URL、浏览器存储、实例文件或普通日志；
- 浏览器扩展通过固定本机适配入口访问同一领域服务；
- 普通已配对客户端不能申请启动器专用浏览器入口。

**关键提交**

- `7c4899b`：实现动态端口启动器与首次安全配对。

**阶段验证**

- 14 项 Chromium 场景通过并自然退出；
- 覆盖自动配对、URL 无令牌、Cookie 不可被页面读取、创建响应丢失后的恢复、控制台和同源网络请求；
- Windows 默认浏览器启动和重复启动进行了人工补验。

### 3.6 研究会话创建幂等（2026-07-19）

**用户可见结果**

创建会话的响应丢失或网络结果不确定时，用户重试会恢复已经创建的会话，不会产生多个重复空会话。

**工程结果**

- 创建会话要求稳定的幂等键；
- 同一键的并发请求和服务重启后重试返回同一会话；
- SQLite migration v15 保存创建幂等键，同时兼容既有会话；
- WebUI 在结果不确定时保留原始创建意图和幂等键。

**关键提交**

- `5a06700`：实现研究会话创建幂等。

**阶段验证**

- 单元、API、并发、持久化和重启恢复测试覆盖重复创建边界；
- 真实 Chromium 场景验证响应丢失后的同一会话恢复。

### 3.7 研究会话文件导入后端（2026-07-19）

**用户和产品结果**

研究会话获得真实文件导入、任务状态、取消、失败重试和稳定阅读快照能力，为文档选区、引用和来源返回建立统一底座。

**工程结果**

- 支持 TXT、Markdown、DOCX 和文本型 PDF，单文件上限 20 MiB；
- SQLite migration v16 加入研究附件、导入任务、内容快照和持久事件；
- 上传使用会话内幂等键；同一键改传不同文件会明确冲突；
- 文件名、声明类型、内容结构、大小和摘要由服务端校验；
- 导入任务支持 `queued`、`running`、`completed`、`failed` 和 `cancelled`；
- 导入进度通过独立可续传事件连接交付；
- 取消只作用于可取消状态，重试复用同一附件、任务、原文件和稳定身份；
- 服务重启时，排队任务继续，处理中任务转为可重试失败；
- 内容快照使用稳定 block ID 和结构锚点：TXT 保留行号，Markdown 保留标题、段落、列表和代码结构，DOCX 保留段落、列表和表格结构，PDF 保留页码；
- 公开记录不暴露本机文件路径或对象键。

**关键提交**

- `15f2f48`：实现研究会话文件导入后端；
- `ee01685`：收紧文件名、内容、类型和私有存储等安全边界；
- `fe562aa`：完善 Markdown 列表结构锚点。

### 3.8 文件导入 WebUI 与阅读恢复（2026-07-19 至 2026-07-20）

**用户可见结果**

- 用户可以在已有研究会话内点击附件入口或把文件拖入页面；
- 界面显示排队、解析、保存、完成、失败和取消状态；
- 用户可以取消处理中任务、重试可恢复失败，并在网络结果不确定时恢复同一上传；
- 完成后可以进入同一研究画布中的阅读页；
- 页面刷新、关闭重开和阅读页直接刷新后，从本机服务恢复附件、任务和内容快照；
- TXT、Markdown、DOCX 和文本型 PDF 使用各自稳定结构显示，不执行导入内容中的 HTML 或脚本。

**可靠性补强**

- 切换会话后，旧会话的延迟上传结果和待重试文件不会进入新会话；
- 研究消息和导入事件在断线确认遇到 401 时停止重连并进入重新配对；
- 断线确认已经得到终态时立即收口，不继续无效重连或轮询；
- 待重试请求复用同一文件和幂等键，避免重复附件。

**关键提交**

- `6479a37`：接入研究会话文件导入与阅读 WebUI；
- `fcfb3c7`：隔离跨会话导入恢复并收紧事件终态处理；
- `64d5f4f`：同步文件导入验收与启动器验证记录。

**最终阶段验证记录**

- Node 单元与集成测试：137/137 通过；
- WebUI 测试：99/99 通过；
- Playwright Chromium：22/22 通过并自然退出；
- 浏览器覆盖文件选择、整页拖放、进度、取消、失败重试、服务端拒绝、前端类型拦截、刷新恢复、键盘路径以及 320、768、1024、1440 像素视口；
- 检查控制台、网络请求、API 与 SQLite 的一致结果；
- 全部自动化使用本地确定性 fixture 和假模型，没有调用真实云模型。

### 3.9 启动器运行版本替换与数据目录独占（2026-07-20）

**用户可见结果**

当构建产物或锁定依赖发生变化时，启动器不会误复用旧版本，也不会并行启动两个服务读写同一份用户数据。

**工程结果**

- 运行指纹区分构建产物、锁定依赖和运行模式；
- 当前运行兼容时复用同一进程和端口；
- 支持受控关闭的旧实例会先安全关闭，再启动当前版本；
- 无法验证身份或不支持安全关闭的旧进程不会被强制结束；
- 服务运行期间独占数据目录，防止多个进程同时写入 SQLite 和用户文件；
- 运行模式进入指纹，普通模式与离线演示模式不会相互误复用。

**关键提交**

- `8b87708`：保护运行版本替换和数据目录访问；
- `64d5f4f`：记录对应自动化验证状态。

### 3.10 无凭证离线 MVP 演示（2026-07-20）

**用户可见结果**

用户运行 `npm.cmd run launch:mvp` 后，无需联网和模型密钥即可演示研究会话、渐进回答、SQLite、文件导入、内部阅读和刷新恢复。

**边界**

- 演示模式不构造真实云模型运行时；
- 不进行联网搜索；
- 回答为确定性本地模拟，不读取导入附件进行真实资料问答；
- 每条回答永久显示“本地演示回答｜非真实 AI｜未联网检索”；
- 该模式只证明流程可运行，不证明回答质量、事实性、检索能力、引用质量或产品核心闭环。

**关键提交**

- `1cf5fda`：增加离线研究演示模式。

### 3.11 统一消息内容块派生与模型状态标识（切片 A1，2026-07-20）

**用户和产品结果**

AI 回答的段落结构有了前后端共用的唯一确定性规则；模型状态明确区分真实模型、本地演示模式与未配置三种情况，演示模式不再与未配置混淆。

**工程结果**

- 契约包新增 `deriveMessageBlocks` 纯函数与 `MessageContentBlock`，前后端共用同一切分实现，为选区锚点提供稳定块结构；
- `GET /v1/ai-configuration` 增加 `mode` 字段（`real` / `demo` / `unconfigured`）；
- 新增契约单测与三种模式的 API 测试。

**关键提交**

- `1004329`：统一消息内容块派生与模型状态标识。

**验证记录**

- 四级：全量构建通过；Node 测试 150/150 通过；项目检查通过。

### 3.12 AI 回答分块渲染与模型状态显示（切片 A2，2026-07-20）

**用户可见结果**

完成的 AI 回答按段落逐块渲染；会话页头新增克制的模型状态点，用户能直接看到当前回答来自真实模型、本地演示还是未配置模型。

**工程结果**

- 完成的 AI 消息按契约包 `deriveMessageBlocks` 逐块渲染，块 id 与后续选区锚点使用同一派生规则；
- 会话页头模型状态点在状态接口不可用时静默省略，不影响会话内容；
- API 客户端接入 `/v1/ai-configuration`。

**关键提交**

- `a637c60`：AI 回答分块渲染与模型状态显示。

**验证记录**

- 二级 + 真实浏览器：前端构建通过；WebUI 测试 106/106 通过；Chromium 端到端 22/22 通过；
- 演示模式真实服务核对分块渲染、状态标识与 320 / 768 / 1280 视口，控制台无错误；
- 真实云模型未配置，人工真实密钥验收待环境具备后补验。

### 3.13 选区记录与选区分析后端能力（切片 B1，2026-07-20）

**用户和产品结果**

用户选中的文字会立即保存为选区记录，AI 分析异步执行并通过事件流回传；分析失败时选区不丢，位置失效时保留原文并如实标记。

**工程结果**

- 契约新增统一选区锚点（消息块 / 快照块两种来源）、选区记录与分析字段（summary、difficulty、quickReadMinutes、deepStudyMinutes、prerequisites、relationToContent、可选 relationToFocus、rationale）、任务记录与事件联合、输入校验与质量评级纯函数（4–4000 字符、单块阈值前后端同源）；
- 迁移 v17：`research_selections`、`research_selection_tasks`（会话内幂等键唯一）、`research_selection_task_events`；
- 选区服务：创建即持久化选区与排队任务，服务端锚点校验、prefix/suffix 自愈重定位、失败降级 stale；异步任务 + SSE（snapshot / completed / failed）、幂等重放、可重试失败、重启恢复；
- 模型网关 `analyzeSelection()` 一次返回完整 JSON，必需字段缺失即 `invalid_analysis` 可重试失败，不静默降级为假数据；
- 演示模式选区分析全部字段带「本地演示分析｜非真实 AI」标识；
- 端点：`POST / GET /v1/research-sessions/:id/selections`、`GET /v1/research-selections/:id`、`GET /v1/research-selection-tasks/:id` 及其事件流与重试。

**关键提交**

- `16108bf`：选区记录与选区分析后端能力。

**验证记录**

- 四级：全量构建通过；Node 测试 167/167 通过（新增契约单测 6 项、选区 API 集成 10 项，覆盖创建→SSE→完成、无模型失败重试、`invalid_analysis`、幂等重放、锚点自愈与 stale 降级、快照块锚点、跨会话拒绝、重启恢复）；项目检查通过。

### 3.14 选区捕获与选区智能窗口（切片 B2，2026-07-21）

**用户可见结果**

- 用户在 Chat AI 回答或导入文档阅读页中用鼠标或键盘选择一段文字，就近弹出选区智能窗口：窗口立即显示原文，AI 分析完成后逐字段呈现（这段在说什么、理解难度、快速了解与深入研究预计时间；展开详情可见可能的前置知识、与当前内容的关系、与当前关注方向的关系、判断依据与不确定性、来源位置）；
- 宽屏窗口就近浮层，窄屏（≤720px）为不遮断主流程的底部抽屉；详情展开后正文区内部滚动，结束操作始终在视口内；
- 选区太短、太长或跨多个段落时只给调整建议，不创建选区记录；
- AI 分析失败或未配置模型时，原始选区保留、给出原因并可重试，结束操作始终可用；
- 按 Escape 或点击“结束”关闭窗口，已保存的选区不因关闭而丢失。

**工程结果**

- 新增选区捕获纯函数（Range → 块内偏移，消息块 / 快照块两种内容上下文，行号标注不参与偏移）与文档级捕获 hook（mouseup / touchend / Shift 键盘抬起 / selectionchange / Escape，忽略选区窗口自身）；
- 新增选区质量提示组件与选区智能窗口组件（原文即时、逐字段骨架、两层展开、失败保留原文与重试、幂等创建）；幂等键为纯 ASCII（原文部分用确定性 FNV-1a 摘要），避免非 ISO-8859-1 字符进入 HTTP 请求头，并满足服务端 200 字符上限；
- 新增第三条可注入事件流客户端（选区任务事件：event-id 去重、`?after` 续传、终态确认、连续失败降级轮询、401 提前停止）；API 客户端新增选区创建 / 查询 / 任务查询 / 重试方法与事件流连接并注册到服务容器；
- 消息块容器与阅读页接入同一捕获层；来源位置说明提取为共享 `anchorCaption`（消息按段落序号、快照按结构锚点）；tokens.css 与 global.css 增加选区高亮、质量提示与窗口样式（窗口高度按开启侧可用空间收口、正文区内部滚动、操作区固定）。

**接口 / 数据变化**

- 无新迁移、无新端点，复用切片 B1 的选区契约与 API；窗口创建请求带稳定幂等键 `sel:<块标识>:<起>:<止>:<原文摘要>`。

**验证记录（二级 + 真实浏览器 + 端到端）**

- `npx tsc -b` 全项目类型检查通过；
- WebUI 客户端测试 135/135 通过（较 A2 的 106 项新增 29 项：选区捕获纯函数、捕获 hook、质量提示、智能窗口、事件流客户端、幂等键 ASCII 回归断言）；
- 前端构建通过（vite 69 模块）；
- Playwright 真实 Chromium 28/28 通过并自然退出：假模型完整链（Chat 回答选区 → 窗口原文即时 → 分析逐字段 → 详情展开 → 幂等键与 `text/event-stream` 网络契约 → API 列表与 SQLite 一致 → 结束关闭）、选区太短只提示不落库、键盘 Shift 选择与 Escape 关闭、阅读页快照选区（来源位置按行号说明、跨段落只提示）、窄屏底部抽屉（详情展开后结束操作仍在视口内）、无模型下选区保留 + 失败原因 + 可重试（SQLite 核对 `model_not_configured` 与 retryable）；
- 控制台无错误、无告警（PDF 可选 canvas 原生绑定警告为既有已知限制，见第 6 节）；
- 按二级规则跳过无关后端全量测试与项目检查（本切片未改后端、契约与数据库，B1 四级验证仍有效）；真实云模型人工验收待环境具备后与收尾阶段一并补验。

**未完成项与风险**

- 无编辑焦点的正文上，无头浏览器不会用 Shift+方向键逐字符扩展选区；自动化以“按扩展结果建立选区 + 触发真实键盘事件”覆盖键盘捕获路径，真实逐字符扩展未在无头浏览器中逐步断言；
- 窗口字段顺序与默认展开层级按当前共识实现，最终信息密度仍属待确认事项（见 `MVP_IMPLEMENTATION_PLAN.md`）；
- 真实云模型下分析延迟与字段质量未验收。

**关键提交**

- `ab79a26`：选区捕获与选区智能窗口。

**下一步交接语**

下一切片：C1——选区深入研究分支与独立会话后端能力（迁移 v18）。前置依赖已满足：选区记录与统一锚点契约、选区任务管线与事件流、窗口操作区均已就位且验证通过。开工第一动作：读取 `docs/MVP_IMPLEMENTATION_PLAN.md` 的 C1 条目，按“先事务创建分支（或带来源的新会话）与空来源关系，再排队第一轮任务”设计迁移 v18（`research_branches`、`research_messages.branch_id`、`research_sessions.origin_selection_id / origin_session_id`）与 `startDeepResearch` 服务。

### 3.15 深入研究分支与独立会话后端能力（切片 C1，2026-07-21）

**用户和产品结果**

从选区发起深入研究的两条去向具备真实的数据与服务底座：沿当前内容建立研究分支，或以当前选区开启带来源的独立研究会话。来源关系在第一轮生成开始前保存，生成失败、服务重启和重试都不会删除分支、来源会话和来源选区。用户可见的窗口操作、分支视图与返回原文由切片 C2 连接。

**工程结果**

- 契约新增研究分支记录（`ResearchBranchRecord`）、消息 `branchId`、会话 `originSelectionId / originSessionId`、深入研究输入与结果（`DeepResearchInput / DeepResearchAccepted / DeepResearchMode / DeepResearchContext`）、分支视图（`ResearchBranchView`）、确定性默认标题派生（选区首句或前 40 字符，不依赖 AI）与输入校验；会话视图只返回主线消息与主线任务并附分支列表，`branchId` 不侵入会话主视图；
- 迁移 v18：`research_branches`（会话内创建幂等键部分唯一索引、外键指向会话与选区）、`research_messages.branch_id`、`research_sessions.origin_selection_id / origin_session_id`；`clearAllData` 同步补齐选区三表与分支表的删除，修复既有选区数据因外键导致清空失败的问题；
- 新增 `DeepResearchService`：`startDeepResearch` 先在同一事务创建分支（或带 origin 的新会话）与第一轮消息、任务，再复用研究会话任务管线排队生成；分支创建键与既有会话创建键分别防止重复建分支或重复建会话；分支视图联接来源选区、分支消息与分支任务；分支内追问消息带 `branchId` 并复用会话任务幂等规则；
- 任务处理按任务所属线索构建生成上下文：分支任务只用分支内消息，主线任务只用主线消息；深入研究第一轮（分支或来源会话的首个用户消息对应的任务）额外注入来源选区材料（来源标题、前后文摘录），分支内追问与后续对话不重复注入；第一轮任务提示版本记为 `deep-research-v1`；
- 模型网关新增 `generateDeepResearchRound()`：只使用提供的当前已有材料，不联网检索、不编造来源，材料不足时如实说明不确定性；演示模式深入研究回答继续带「本地演示回答｜非真实 AI｜未联网检索」标识；
- 端点：`POST /v1/research-selections/:id/deep-research`、`GET /v1/research-branches/:id`、`POST /v1/research-branches/:id/messages`；生成重试与 SSE 事件流复用既有研究任务端点。

**接口 / 数据变化**

- 迁移 v18（`research_branches`、消息 `branch_id`、会话来源列）；
- 三个新端点；会话视图消息与任务收敛为主线，新增 `branches` 列表；消息记录可能携带 `branchId`，会话记录可能携带 origin 字段。

**验证记录（四级）**

- 从零全量构建（`npm run clean` + `npm run build`，含 WebUI 与扩展资源）通过；
- Node 测试 183/183 通过（较 B1 的 167 项新增 16 项：契约单测 3 项、API 集成 13 项，覆盖分支路径、独立会话路径、确定性默认标题、生成失败后来源保留与重试、无模型可重试失败、幂等重放不重复建分支 / 会话、重启恢复、运行中断标记、分支追问范围与主线隔离、快照选区来源标题、参数校验与 404、清空数据外键、演示模式标识；`sqlite-store` 两项迁移测试扩展到 v14→v18 升级路径与 v18 结构断言）；
- 项目检查（`check-project.ps1`）通过；
- 本切片为后端切片、无用户可见路径，按分级规则不运行浏览器端到端验证（UI 连接与浏览器验收随 C2 进行）；真实云模型人工验收待环境具备后与收尾阶段一并补验。

**未完成项与风险**

- 深入研究二选一界面、分支路由视图、顶部来源条与返回原选区高亮由 C2 连接；
- 第一轮“未联网检索、仅当前材料”的界面固定提示文案在 C2 呈现；
- 真实云模型下第一轮生成延迟与内容质量未验收。

**关键提交**

- `e0741f3`：深入研究分支与独立会话后端能力。

**下一步交接语**

下一切片：C2——深入研究二选一、分支视图与来源返回（WebUI，二级 + 真实浏览器 + e2e）。前置依赖已满足：深入研究三个端点、分支 / 来源会话与来源关系持久化、任务事件流与重试均通过四级验证。开工第一动作：读取 `docs/MVP_IMPLEMENTATION_PLAN.md` 的 C2 条目，在选区智能窗口操作区增加“深入研究”轻量二选一（独立会话提供方向输入框），新增分支路由 `/research/:sid/branch/:branchId`（顶部来源条 + 分支消息渲染），并实现 `SelectionHighlight` 从分支来源条返回会话页或阅读页、按锚点重定位高亮原选区。

### 3.16 深入研究二选一、分支视图与来源返回（切片 C2，2026-07-21）

**用户可见结果**

- 选区智能窗口操作区新增“深入研究”：先保存选区后可用，打开轻量二选一——沿当前内容建立研究分支（默认）或以选区开启独立研究会话，各附适用场景说明；独立会话提供可选的研究方向输入框；分析失败或未配置模型时同样可以发起；
- 分支去向进入独立分支视图（`/research/:sid/branch/:branchId`）：顶部来源条显示来源内容名、选区摘要与“返回原文”，页面固定说明“本轮研究只使用来源选区与当前已有材料生成，未联网检索”，第一轮真实生成渐进呈现，失败给出原因与重试，可以在分支内继续追问、再次选区；
- 独立会话去向进入新会话页：新会话顶部同样呈现来源条与材料范围说明，研究方向成为第一轮输入，新会话进入会话列表；
- 来源返回：分支或独立会话点击“返回原文”回到原会话页或阅读页，按锚点重定位并以高亮标记原选区、滚动到位；精确位置无法恢复时降级展示保存原文与粗粒度位置（段落序号 / 行号 / 页内说明）；刷新后查询参数仍在，高亮与分支入口保持一致；
- 会话页新增研究分支入口，按来源选区原文命名（如“深入研究：本地优先会先把输入保存在本机”），可回到分支继续。

**工程结果**

- API 客户端新增 `startDeepResearch` / `getResearchBranch` / `submitBranchMessage` / `listResearchSelections` 四个方法，全部复用同源请求与统一错误映射；
- 选区智能窗口增加二选一状态机（去向单选、方向输入、发起中禁用、失败保留去向选择）、深入研究幂等键 `dr:<选区id>:<去向>:<方向摘要|auto>`（方向用既有 FNV-1a 摘要保持纯 ASCII）；
- 新增分支路由与 `ResearchBranchPage`、`useResearchBranch` 控制器（与会话页同构的服务端事实来源模式：加载分支视图、进行中任务接既有研究任务事件流、终态对齐、分支内追问复用 `TurnSubmitter` 幂等提交、重试沿用原任务）与 `branch-view` 事件合并助手；
- 新增来源条组件 `SelectionSourceBar`、材料范围固定说明 `ResearchScopeNote`、降级展示 `SelectionRestoreFallback`、来源信息读取 `useSelectionSource` 与选区恢复 `useSelectionRestore`；来源返回路由由纯函数 `backRouteForSelection` 派生（消息选区回会话页、快照选区回阅读页，均携带 `?sel=`）；
- 高亮重定位为纯函数 `resolveHighlight`（锚点切片校验 → 原文块内重定位 → null 降级），消息页与阅读页各自在本页数据中定位后由共享 `HighlightedText` 渲染 `<mark>`，滚动行为尊重 `prefers-reduced-motion`；
- 会话页接入来源条（带来源的独立会话）、分支列表 `BranchList`（按会话选区列表映射分支名称）与消息选区高亮；阅读页接入快照选区高亮与降级；
- 修复三个来源返回相关的真实缺陷：窗口内 `mousedown` 拦截改为放行表单控件（方向输入框此前无法点击聚焦）；捕获 hook 忽略表单控件内的 `selectionchange`（输入方向时窗口被误关闭）；同路由切换会话时窗口不再向新会话重建旧锚点选区（深入研究开启独立会话时触发 404），窗口导航前先关闭、`sessionId` 变化后不重新提交、捕获层随会话切换清空；
- e2e 假模型为深入研究第一轮提供确定性回答（标记“未联网检索，回答完毕”），e2e 助手新增分支 / 分支消息 / 带来源会话的只读 SQLite 核对。

**接口 / 数据变化**

- 无新迁移、无新端点，复用 C1 的深入研究端点与选区端点；
- 前端新增路由 `/research/:sid/branch/:branchId`；会话页与阅读页支持 `?sel=<选区id>` 查询参数作为来源返回依据（可刷新、不依赖路由 state）；
- 前端实施指导同步：5.3 移除已实现的选区窗口与深入研究条目，路由表补齐阅读与分支路由。

**验证记录（二级 + 真实浏览器 + 端到端）**

- `npx tsc -b` 全项目类型检查通过；前端生产构建通过（vite）；
- WebUI 客户端测试 171/171 通过（较 B2 的 135 项新增 36 项：高亮与幂等键纯函数、分支视图合并、分支页渲染 / 追问 / 404 / 会话编号一致性 / 重试、窗口二选一六项、会话切换不重建选区、会话页来源条与高亮降级及分支列表、阅读页高亮 / 重定位 / 降级 / 跨内容忽略、表单焦点 selectionchange 守卫）；
- Playwright 真实 Chromium 32/32 通过并自然退出：分支去向完整链（二选一 → 分支视图来源条与未联网说明 → 第一轮确定性生成 → 幂等键网络契约与重放不重复建分支 → SQLite 分支 / 分支消息 / 任务终态 → 返回原文高亮 → 刷新保持 → 分支入口回到分支并追问）、独立会话去向（方向输入 → 新会话来源条 → 返回原文高亮 → 带来源会话落库与会话列表）、窄屏抽屉内完成二选一且开始操作始终在视口、无模型下分析失败仍可发起深入研究且分支与来源保留可重试；
- 控制台无错误、网络无异常（新用例均断言）；1280 与 390 视口覆盖；
- 按二级规则跳过无关后端全量测试与项目检查（本切片未改后端、契约与数据库，C1 四级验证仍有效；e2e 假模型回答变更属测试基础设施，已由 e2e 覆盖）；真实云模型人工验收待环境具备后与收尾阶段一并补验。

**未完成项与风险**

- 稍后再学保存、优先级与列表由 D1 / D2 连接；窗口“稍后再学”操作尚未出现；
- 深入研究第一轮的联网检索与行内引用属后续阶段，界面已按固定文案如实说明材料范围；
- 来源返回高亮在 AI 消息重试重写后依赖块内原文重定位与粗粒度降级，已由单测与降级路径覆盖，真实模型下的重写场景待收尾验收观察。

**关键提交**

- `8ffc671`：深入研究二选一、分支视图与来源返回。

**下一步交接语**

下一切片：D1——稍后再学保存与列表后端（契约 + 迁移 v19 + 后端，四级）。前置依赖已满足：选区记录、统一锚点与来源返回均已连通并验证。开工第一动作：读取 `docs/MVP_IMPLEMENTATION_PLAN.md` 的 D1 条目，按“summary 确定性默认值（选区首句 / 前 80 字符）不依赖 AI、创建幂等、列表联接选区文本与来源说明”设计 `ResearchLaterItemRecord`、迁移 v19 `research_later_items` 与对应服务和端点。

### 3.17 稍后再学保存与列表后端能力（切片 D1，2026-07-21）

**用户和产品结果**

从选区保存稍后再学项目具备真实的数据与服务底座：项目保存原始选区、用户优先级（一至五星，默认三星）、简短概括（确定性默认值取选区首句或前 80 字符）与 pending / done 状态。保存、列表展示和来源联接完全不依赖 AI：无模型环境下同样可以保存和查看。网络重试按幂等键返回已保存项目，不重复创建。用户可见的窗口保存操作、稍后再学栏目与来源返回由切片 D2 连接。

**工程结果**

- 契约新增稍后再学记录（`ResearchLaterItemRecord`：priority 1–5、summary、status pending / done）、列表视图（`ResearchLaterItemView`：联接选区记录与来源标题）、创建与更新输入（`ResearchLaterItemInput / ResearchLaterItemUpdate`）及校验纯函数（selectionId 必填、priority 整数 1–5、summary 非空且不超过 200 字符、更新至少含一个字段）；确定性默认概括 `deriveDefaultLaterSummary`（选区首句 / 前 80 字符，与标题派生同源规则，不依赖 AI，前后端可复用）；
- 迁移 v19：`research_later_items`（外键指向会话与选区、创建幂等键部分唯一索引、选区与状态索引）；`clearAllData` 按外键逆序补齐稍后再学表删除；
- 新增 `ResearchLaterService`：创建时校验幂等键（必填、不超过 200 字符）并先取选区，幂等键命中返回首次创建的项目；列表联接选区原文与来源说明（消息选区取会话标题、快照选区取内容快照标题），按创建时间倒序，支持状态过滤；更新 priority / summary / status，未提供字段保持原值；
- 端点：`POST /v1/research-later-items`（创建，201）、`GET /v1/research-later-items`（列表，支持 `?status=pending|done`）、`GET /v1/research-later-items/:id`、`PUT /v1/research-later-items/:id`（更新）；错误映射复用既有 400 / 404 链。

**接口 / 数据变化**

- 迁移 v19（`research_later_items`）；
- 四个新端点；列表项为联接视图（项目 + 选区记录 + 来源标题），前端无需再次查询选区即可呈现摘要、星级、来源与时间。

**验证记录（四级）**

- 从零全量构建（`npm run clean` + `npm run build`，含 WebUI 与扩展资源）通过；
- Node 测试 198/198 通过（较 C1 的 183 项新增 15 项：契约单测 4 项覆盖默认概括派生与创建 / 更新校验，API 集成 11 项覆盖无模型保存、确定性默认概括、显式优先级与概括、幂等重放不重复创建、跨会话列表联接与倒序、状态过滤、priority / summary / status 独立更新、快照选区来源标题、参数校验与 404、重开数据库后项目仍在、清空数据外键；`sqlite-store` 迁移测试扩展到 v14→v19 升级路径与 v19 结构断言）；
- 项目检查（`check-project.ps1`）通过；
- 全量测试中 `mvp-core-loop` 一项因 Windows 临时目录清理偶发 ENOTEMPTY 失败，单独重跑 10/10 通过，与主题文档功能相关、与本切片改动无关；
- 本切片为后端切片、无用户可见路径，按分级规则不运行浏览器端到端验证（UI 连接与浏览器验收随 D2 进行）；真实云模型人工验收待环境具备后与收尾阶段一并补验。

**未完成项与风险**

- 窗口“稍后再学”操作（星级 + 可编辑概括预填）、稍后再学栏目（列表、数量徽标）、标记完成 / 恢复与来源返回重开窗口由 D2 连接；
- 删除等其余即时用户控制按实施计划留待后续阶段（当前即时控制范围为星级、概括、完成 / 恢复）；
- 自动弱重现与触发规则属完整 MVP 阶段，本切片不涉及。

**关键提交**

- `e168dbb`：稍后再学保存与列表后端能力。

**下一步交接语**

下一切片：D2——稍后再学栏目与来源返回（WebUI，二级 + 真实浏览器 + e2e）。前置依赖已满足：稍后再学四个端点、创建幂等、列表联接与更新均已通过四级验证。开工第一动作：读取 `docs/MVP_IMPLEMENTATION_PLAN.md` 的 D2 条目与 `apps/web/IMPLEMENTATION.md` 右侧区域约定，在选区智能窗口操作区增加“稍后再学”（星级 + 可编辑概括，预填 `deriveDefaultLaterSummary` 默认值，幂等键建议 `later:<选区id>`），接入右侧稍后再学面板呈现真实列表（摘要、星级、来源、时间、数量徽标），并复用 C2 的 `backRouteForSelection` 与 `resolveHighlight` 实现点击项目返回原内容原选区、自动重开选区窗口与位置失效降级展示。

### 3.18 稍后再学栏目与来源返回（切片 D2，2026-07-21）

**用户可见结果**

- 选区智能窗口操作区新增“稍后再学”：选区保存后可用，分析失败或未配置模型时同样可用；进入后呈现一至五星优先级（默认三星）与可编辑概括（预填确定性默认值，取选区首句 / 前 80 字符，不依赖 AI），保存成功就地给出确认；
- 右侧“稍后再学”栏目由占位空态改为真实列表：呈现概括、星级、来源内容标题、时间与待学数量徽标，区分待学与已完成两段；读取失败给出重试，配对前 401 静默并在配对后自动刷新；
- 点击栏目项目返回原内容原选区：消息选区回会话页、快照选区回阅读页，按锚点高亮原选区并自动重开选区智能窗口（取回已保存的选区与分析），刷新后仍在；精确位置无法恢复时保留原文与粗粒度位置说明；
- 每个项目可“标记完成 / 恢复待学”，状态与数量徽标即时变化；窄屏下保存在底部抽屉内完成，overlay 栏目点击返回后自动关闭；
- 保存、列表展示与来源返回完全不依赖 AI：无模型环境下选区分析失败仍可保存、查看与返回。

**工程结果**

- API 客户端新增稍后再学四方法（`createResearchLaterItem` / `listResearchLaterItems` / `getResearchLaterItem` / `updateResearchLaterItem`，均返回联接视图 `ResearchLaterItemView`），复用同源请求与统一错误映射；
- 选区智能窗口操作区新增 `later` 态（星级单选 + 概括编辑 + 保存 + 确认 / 失败态），保存幂等键 `later:<选区id>`（选区 id 为数据库 id，纯 ASCII），概括被清空时省略字段由后端套用确定性默认值，成功后经模块事件通知栏目刷新；
- 新增模块事件 `later-event.ts`（镜像 `paired-event.ts`）：保存 / 更新成功后 `notifyLaterChanged()`，栏目获取同时订阅该事件与既有 `PAIRED_EVENT` 刷新，保存（页面内窗口）与列表（AppShell 栏目）借此解耦，无全局状态；
- `SelectionSurface` 接受可选 `restoreSelection`：无实时选区时用新纯函数 `captureFromSelection`（`selection-highlight.ts`）合成捕获重开窗口；窗口以锚点幂等键复用创建接口取回已保存选区与任务，不重复创建；本次挂载内关闭后不再自动弹出，刷新后按 URL `?sel=` 意图再次重开；会话页只在消息锚点、阅读页只在匹配当前快照的快照锚点时传入，防止跨类型错配；
- 稍后再学栏目自取列表（空 / 加载 / 失败三态，沿用左侧会话列表“本地获取 + 401 静默 + 配对后刷新”约定），数量徽标置于栏目头部；`AppShell` 保持纯布局未改动；
- 修复星级单选真实缺陷：原裁剪隐藏的 radio 点击落在 label 上，被窗口 `mousedown` 选区保护拦截（仅豁免表单控件）而无法切换；改为 radio 透明铺满星标成为真实点击目标，既被拦截豁免又受 `isFormFieldFocused` 保护，点击不误关窗口。

**接口 / 数据变化**

- 无新迁移、无新端点、无契约变化，复用 D1 的稍后再学端点与 C2 的 `backRouteForSelection` / `resolveHighlight` / `useSelectionRestore`；
- 前端新增纯函数 `laterIdempotencyKey` / `captureFromSelection`；会话页与阅读页向 `SelectionSurface` 传入按锚点类型守卫的 `restoreSelection`；
- e2e 助手新增 `readResearchLaterTables`（只读核对 `research_later_items`）。

**验证记录（二级 + 真实浏览器 + 端到端）**

- `npx tsc -b` 全项目类型检查通过；前端生产构建通过（vite 77 模块）；
- WebUI 客户端测试 185/185 通过（较 C2 的 171 项新增 14 项：窗口稍后再学态四项、稍后再学栏目七项、纯函数三项；并加固既有来源返回用例以覆盖自动重开窗口）；顺带把既有的“会话分支列表按来源选区原文命名”用例从对兜底名的非等待断言改为等待具名链接，消除其在本机偶发失败（仅测试改动）；
- Playwright 真实 Chromium 37/37 通过并自然退出（较 C2 的 32 项新增 5 项）：保存完整链（窗口星级 + 概括预填 → 保存 → 栏目呈现与徽标 → `Idempotency-Key: later:<选区id>` 网络契约 → 幂等重放不重复创建 → SQLite `research_later_items` 一致）、点击项目返回原选区高亮并自动重开窗口 + 刷新保持、标记完成 / 恢复待学状态与 SQLite 一致、窄屏底部抽屉内保存与 overlay 栏目点击后关闭、无模型（43212）分析失败仍可保存 / 列表 / 返回重开；
- 控制台无错误、网络无异常（新用例均断言），1280 与 390 视口覆盖；PDF 可选 canvas 原生绑定警告为既有已知限制（见第 6 节）；
- 按二级规则跳过无关后端全量测试与项目检查（本切片未改后端、契约与数据库，D1 四级验证仍有效）；真实云模型人工验收待环境具备后与收尾阶段一并补验。

**未完成项与风险**

- 删除等其余即时用户控制按实施计划留待后续阶段（当前即时控制范围为星级、概括、完成 / 恢复）；
- 自动弱重现与触发规则属完整 MVP 阶段，本切片不涉及；
- 核心闭环主链路已端到端连通，但自动化只使用确定性假模型，真实模型下回答 / 分析 / 研究质量与端到端四场景验收待收尾阶段完成；在此之前不使用“核心流程 MVP 可体验”表述。

**关键提交**

- `50775d8`：稍后再学栏目与来源返回。

**下一步交接语**

下一切片：收尾——按四场景做真实模型 + 真实浏览器端到端人工验收。前置依赖已满足：核心闭环主链路（阅读 → 选区 → 选区智能窗口 → 深入研究 / 稍后再学 → 来源返回）已全部连通并通过二级 + 真实浏览器 + e2e 验证。开工第一动作：配置至少一种真实模型，逐场景验收真实回答、选区分析、深入研究第一轮与稍后再学保存 / 返回，核对刷新恢复与失败重试；验收通过后同步开发记录与前端实施指导，满足全部条件后才使用”核心流程 MVP 可体验”表述。

### 3.19 收尾：真实模型四场景端到端验收与文档同步（2026-07-21）

**用户可见结果**

- 真实 DeepSeek 模型配置后，Collector 以真实 AI 能力运行：Chat 回答、选区分析、深入研究第一轮和稍后再学保存均使用真实模型生成；
- 右上角模型状态指示器显示当前模型名称（如”模型：deepseek-v4-flash”），不再为”演示”或”未配置”；
- 主链路核心功能经真实模型 + 真实浏览器完成端到端验收，四条场景全部通过；刷新无重复创建、材料范围如实、全程无演示标记；
- 提供真实模型启动入口（`Collector-真实模型.cmd`）与人工验收手册（`核心功能人工验收手册.md`），供人工逐例测试核心功能。

**工程结果**

- 新增验收专用 harness `apps/web/e2e/acceptance-real-harness.mjs`：镜像 `api-harness.mjs`，但接入真实 DeepSeek 网关；读 `COLLECTOR_AI_API_KEY` / `COLLECTOR_AI_PROVIDER` 等环境变量构造真实 `ProviderRuntime`，提供隔离临时数据目录，写同样的 `.runtime` 文件使 e2e 助手原样可用；SIGTERM/SIGINT 优雅关闭；
- 新增验收专用 spec `apps/web/e2e/z-acceptance-real.spec.ts`（四场景）与独立配置 `apps/web/playwright.acceptance.config.ts`（testMatch 只匹配该 spec，不进 `test:e2e` 默认套件）；
- 修复全局 CSS 缺陷：`.branch-list__items > li` 添加 `min-width: 0`，防止 `nowrap` 分支名在 390px 窄屏撑宽 grid 轨道导致横向溢出；
- `selectRealAnswerText` 支持 offset 参数挑选不同片段，支持场景四的二次选区需求；
- 场景二重启验证通过全新浏览器上下文重新配对，确认持久化数据（研究会话、来源快照、返回路径）在服务重启后完整可恢复；
- `.gitignore` 新增 `Collector-真实模型.cmd`、`核心功能人工验收手册.md`、`apps/web/test-results-acceptance/`；
- 所有真实模型验收工具与配置作为明确标注的验收基础设施提交，需真实密钥、非 CI 可跑。

**验证记录（真实模型 + 真实浏览器 + 四级）**

- 四级全量基线（重建于本阶段开始）：`npx tsc -b` 全量通过；Node 单元与集成测试 137/137 通过；WebUI 客户端测试 185/185 通过；Playwright Chromium 端到端 37/37 通过并自然退出；项目检查通过；
- DeepSeek 真实模型冒烟调用成功（模型 `deepseek-v4-flash`，api.deepseek.com）；
- 四场景真实模型验收 `npx playwright test --config playwright.acceptance.config.ts` 4/4 通过（34.8s）：场景一 Chat → 深入研究 → 返回 → 刷新；场景二文档导入 → 独立研究 → 返回 → 重启恢复；场景三稍后再学保存 → 栏目 → 返回重开 → 刷新；场景四刷新幂等 + 材料范围 + 无演示标记；
- 控制台无错误、网络无异常，1280 与 390 视口覆盖，SQLite 一致性验证通过；
- DeepSeek API 密钥仅用于启动一次性验收服务，不入库、不入日志、不出现在任何提交文件中。

**未完成项与风险**

- 联网搜索、行内引用、自动弱重现与触发规则、PDF 版式修复等仍属后续阶段；
- 真实模型响应时间受网络与供应商影响，非 Collector 可控，验收超时已设置为 120s；
- 真实模型应答内容具有非确定性（已在 spec 中避免对具体文字做精确断言）；
- 本项目规则：提交进套件的自动化（`test:e2e`）只用确定性假模型，真实模型验收为一次性事件排除出默认套件。

**关键提交**

- `3fc8ca6`：收尾——真实模型四场景端到端验收与文档同步。

**下一步交接语**

核心流程 MVP 已可体验。

### 3.20 文件直接发起研究与阅读页聊天输入（2026-07-21）

**用户可见结果**

- 开始页（/research/new）支持直接上传或拖入 TXT、Markdown、DOCX、PDF 文件来创建研究会话并导入文件，无需先输入问题；
- 在阅读文档时，页面底部新增聊天输入框，可以直接对当前文档提问，无需返回会话页；
- 开始页上传文件后再输入文本，不会重复创建会话，消息直接进入同一会话；
- 拖放文件到开始页自动创建研究会话，覆盖 drop 时显示"松开鼠标，开始研究这个文件"。

**工程结果**

- StartPage 新增 `handleFileImport`：前端预检 → 创建会话 → 导入文件 → 导航；会话创建失败显示错误允许重试，会话已创建但导入失败仍导航（会话可从会话页重试导入）；
- StartPage 新增 `createdSessionIdRef`：文件+文本组合路径不重复创建会话；
- StartPage 集成拖放支持（dragHasFiles/dragEnter/dragOver/dragLeave/drop）；
- ReadingPage 新增 ChatComposer + TurnSubmitter：使用 `api.submitResearchMessage`，401 时渲染 PairingGate；
- ChatComposer 增加 `onImportFile` 及 `importAccept` prop，开始页附件按钮从"后续版本提供"变为真实可操作。

**关键提交**

- `6ee4175`：文件直接发起研究与阅读页聊天输入。

### 3.21 关闭 Collector 服务按钮（2026-07-21）

**用户可见结果**

- 顶栏右侧新增"关闭 Collector"按钮，用户可以从界面直接关闭 Collector 服务，解决旧实例占用端口导致新配置无法生效的问题；
- 关闭期间按钮禁用显示"正在关闭……"；
- 关闭失败显示行内错误提示并给出手动关闭指引。

**工程结果**

- API 客户端新增 `requestShutdown()`：`POST /v1/launcher/shutdown`，无返回体，错误时解析 JSON 错误体；
- AppShell 集成 `useServices` 获取 `api`，`shuttingDown`/`shutdownError` 状态管理与按钮 JSX；
- CSS：`.app-bar__spacer` 将按钮推至右侧，hover 时边框和文字变红提示危险操作。

**关键提交**

- `ff9823d`：顶栏添加关闭 Collector 按钮。

**后续变更**

- `cb22894`（2026-07-22）：回退本功能（`Revert "feat(web): 顶栏添加关闭 Collector 按钮"`）。顶栏按钮、`ApiClient.requestShutdown()` 与相关样式已移除，WebUI 不再提供界面关闭入口；后端 `/v1/launcher/shutdown` 接口保留，仍供启动器版本替换时内部受控关闭使用。

### 3.22 搜索适配层与搜索轨迹持久化（切片 E1，2026-07-22，已弃用）

**状态**：历史 E1 采用独立 SearXNG 适配层。2026-07-22 用户决定改用模型供应商联网，对应代码（`apps/api/src/web-search.ts`、迁移 v20 三表、`WebSearch*` 契约与测试）已在 `0343c56` 中全部清除；该路径从未合入 `master` 或远端跟踪分支。


### 3.23 供应商联网研究、引用与来源预览（阶段 E，2026-07-22）

**用户可见结果**

- Chat、深入研究第一轮和分支追问自动请求当前模型供应商的联网能力；选区分析维持不联网；
- 完成回答如实显示已联网、联网失败、供应商不支持或无可核验来源；
- 有可定位引用时，正文在实际陈述位置显示可键盘访问的行内编号；展开来源可查看净化后的标题、摘要、定位信息并安全打开原始来源；主线与分支刷新后都可恢复这些信息。

**工程结果**

- 共享契约新增 `ProviderWebGrounding`、`ResearchGrounding*` 运行 / 来源 / 引用 / 状态模型，以及 URL、摘要、错误的净化与校验；`AiConfigurationView` 增加 `webGrounding` 字段，前端可按供应商能力决定是否显示联网状态；
- 模型网关适配 OpenAI Responses `web_search`、Gemini Google Search grounding 与 Anthropic server-side web search/web fetch；Anthropic 支持 `pause_turn` 续接；
- SQLite migration v21 新增 `research_grounding_runs`、`research_grounding_sources`、`research_citations`；v20 旧独立搜索表已在同一提交中完全清除（本分支从未合入 master，不影响主分支数据）；
- 研究任务保存同一份干净回答、联网运行、来源与行内引用，再完成任务；联网失败时回退普通回答并写入 `grounding_failed`；
- 演示模式增加 `generateGrounded` 方法，返回确定性回答 + 2 个来源，供无密钥环境下验证 grounding UI；
- WebUI 在引用偏移位置插入空文本 `<sup data-citation-marker>`，编号只由 CSS `::after` 绘制，避免破坏已验收的选区锚点；来源详情使用 `noopener noreferrer`；
- 供应商来源标题、摘要、定位、运行摘要和错误在写入 SQLite 前二次脱敏。

**验证记录（四级自动化）**

- `npm run build` 通过；
- `npm run test:web`：25 个文件、197 项通过；
- `npm test`：205 项通过，含 v21 SQLite 升级、三家 provider 请求 / 映射、Anthropic `pause_turn` 续接、联网来源脱敏与引用持久化；
- 确定性浏览器回归：39 个 Chromium 场景通过，覆盖宽 / 窄屏、键盘、SSE 恢复、分支与独立研究、来源返回、控制台与网络契约；
- 项目检查通过（0 errors, 0 warnings）。

**未完成项与风险**

- 未提供三家真实供应商凭证，尚未完成真实搜索、真实引用、无引用降级和本地轨迹脱敏的人工验收；
- 联网生成当前在供应商返回完整回答后一次写入，不保留原有 token 级流式体验；
- 联网开始状态由已保存任务状态呈现，尚未新增独立 SSE 联网阶段事件。

**关键提交**

- `39dffe5`：供应商联网引用（grounding）全栈实现，含 SearXNG 旧方案清除、AiConfigurationView 缺口补齐与演示模式 grounding 模拟。

### 3.24 搜索链路诊断与 DeerFlow 源码调研（2026-07-23）

**目标**

诊断用户报告的搜索失真问题（"什么是loop engineering" → 全部返回"什么"的词典解释），分析 DeerFlow 开源项目的搜索实现寻找参考，并形成联网搜索策略改进计划。

**调研结果**

- 确认根因：Bing 对中英混合查询优先匹配中文词，"什么"作为高频词主导了 query 信号，导致搜索结果完全不相关；
- 确认搜索链路零可观测性：`web-search-agent.ts` 中无任何 console.log，搜索数据虽写入 SQLite 三张表但无 HTTP API 查询；
- 确认架构缺陷：`runWebSearch` 将搜索+抓取耦合在单一函数中，固定抓取 Top 5 全文，Agent 无自主决策权；
- 完成 DeerFlow v2.0（`C:\Users\Administrator\deer-flow`）完整源码分析：确认其核心优势是"搜索作为 Agent 可多轮调用的独立工具"而非特定搜索引擎；
- 形成三阶段改进计划（F1 日志+查询改写 → F2 工具化+Agent循环 → F3 多后端），详见 `docs/MVP_IMPLEMENTATION_PLAN.md` 阶段 F。

**已确认的设计方向**

- 优先级：D（日志）> A2（查询改写）> A1+B（工具化+Agent循环）> C（多后端）；
- F1 不改架构，在 `web-search-agent.ts` 加日志并前置 LLM query reformulation，直接修复中文分词问题；
- F2 为对标 DeerFlow 的核心改造，需要引入 Agent tool-use loop，实现框架待调研项目现有依赖后确认。

**交付文件**

- `docs/MVP_IMPLEMENTATION_PLAN.md` 阶段 F：搜索优化实施路线和切片详情；
- `docs/MVP_IMPLEMENTATION_PLAN.md`：更新切片状态表、关键设计决策、待确认事项，新增阶段 F 详细内容；
- `docs/PROJECT_DEVELOPMENT_RECORD.md`：本次更新（§3.24、§7）。

**无代码提交**：本次为纯调研与计划阶段，不涉及代码改动。

**下一步交接语**

F1（日志+查询改写）优先级已确认，待启动。实施时读取 `docs/MVP_IMPLEMENTATION_PLAN.md` 阶段 F 获取完整上下文。改动集中在 `apps/api/src/web-search-agent.ts`，验证级别二至三级。

### 3.25 F1：搜索链路日志与查询改写（2026-07-23）

**目标**

为自建搜索（Bing HTML 抓取）添加可观测性，并通过前置 LLM 查询改写修复中英混合查询的中文分词偏差问题。

**改动内容**

| 文件 | 改动 |
|------|------|
| `apps/api/src/web-search-agent.ts` | 在 `searchBing`、`fetchPageContent`、`runWebSearch` 关键节点添加 `console.log`（`[web-search]` 前缀），输出 query、结果数、抓取成功/失败、总耗时 |
| `packages/model-gateway/src/index.ts` | 新增 `ModelGateway.reformulateSearchQuery()` 方法：轻量调用当前模型，将自然语言问题改写为搜索引擎关键词（10s 超时、200 token 上限、失败时返回原文不阻塞搜索） |
| `apps/api/src/service.ts` | 在 `generateAgentGrounded` 中搜索前调用 `reformulateSearchQuery`，改写后的 query 传给 `runWebSearch`；`queries` 数组同时保留改写前后两个查询词 |

**效果**

- 日志示例：`[web-search] searchBing query="loop engineering 定义 概念"` → `[web-search] searchBing completed resultCount=8 latency=1234ms` → `[web-search] runWebSearch completed fetchOk=4 fetchFail=1 sourceCount=5 latency=5678ms`
- 改写示例：用户输入「什么是 loop engineering」→ 改写为「loop engineering 定义 概念 原理」，避开 Bing 对中文语气词的分词偏好

**验证**

- TypeScript 构建：零错误
- Node 全量测试：205/205 通过
- 验证级别：二级（无浏览器变更，仅 API + model-gateway）
- 提交：`68b39be`

### 3.26 F2：工具拆分 + Agent 多轮工具调用循环（2026-07-23）

**目标**

将搜索从"前置一次性步骤"升级为"Agent 可调用的工具"，对标 DeerFlow 的自主搜索体验。拆分 web_search/web_fetch 两个独立工具，引入 Agent tool-use 循环让模型自主决定搜索/抓取/重搜策略。

**改动内容**

| 文件 | 改动 |
|------|------|
| `apps/api/src/web-search-agent.ts` | 新增 `webSearch(query, maxResults)` 只搜不抓（内部复用 `searchBing`）和 `webFetch(url)` 只抓不搜（薄封装 `fetchPageContent`）；新增 `WebSearchResultSet`、`WebFetchResult` 返回类型；现有 `searchBing`/`fetchPageContent`/`runWebSearch`/`parseAgentCitations` 全部保留向后兼容 |
| `packages/model-gateway/src/index.ts` | 新增类型：`AgentChatMessage`、`ToolDefinition`、`AgentChatResponse`、`AgentSearchToolContext`、`AgentSearchResult`；`OpenAiCompatibleProvider` 类上新增 `agentChat(messages, tools)` 方法（发送 tools + tool_choice: "auto"，不发送 response_format）；`ModelGateway` 类上新增 `runAgentSearchLoop(userMessage, tools, options)` 方法（多轮 ReAct 循环：search → fetch → re-search → answer；5 次搜索硬上限、10 轮总轮次、URL 去重全局编号）；模块级常量 `AGENT_SEARCH_SYSTEM_PROMPT`（中文 system prompt）和 `AGENT_SEARCH_TOOLS`（两个 tool definition） |
| `apps/api/src/service.ts` | `generateAgentGrounded` 从 F1 单轮搜索替换为 F2 Agent 循环：调用 `gateway.runAgentSearchLoop()` 替代 F1 的 `reformulateSearchQuery()` + `runWebSearch()` + `answerResearchConversation()`；工具实现从 `web-search-agent.ts` 注入；`promptVersion: "agent-search-v2"`；`responseSummary` 增加 `method: "agent-loop-v2"` 和 `queryCount` |
| `tests/agent-loop.test.ts`（新） | 9 个 Agent 循环专项测试：单轮搜索、搜索→抓取→回答、换词重搜、搜索上限阻止、直接回答无工具调用、并行工具调用、URL 去重、length finish reason 兜底、搜索上限后 web_fetch 仍可用。使用可编程的 `ProgrammableAgentProvider` 进行确定性测试 |

**架构决策**

1. **零新依赖**：不引入 Vercel AI SDK 或任何框架，利用 DeepSeek 已有的 OpenAI 兼容 tool calling API（`/chat/completions` + `tools` 参数），手写轻量 ReAct 循环
2. **不改 `ModelProvider` 接口**：`agentChat` 方法只加到 `OpenAiCompatibleProvider` 类上，`runAgentSearchLoop` 通过鸭子类型检查 `agentChat` 方法存在性，所有现有 Provider 零改动
3. **工具注入模式**：`runAgentSearchLoop` 接收可注入的 `webSearch`/`webFetch` 函数，`model-gateway` 不依赖 Bing/Readability，测试可注入确定性 mock
4. **来源序数全局分配 + URL 去重**：跨多轮搜索统一编号，同一 URL 只分配一次序数
5. **硬上限兜底**：最多 5 次 `web_search` 调用 + 10 轮总轮次，防止模型无限循环

**验证**

- TypeScript 构建：零错误
- Node 全量测试：214/214 通过（含 9 个新增 Agent 循环测试）
- 验证级别：三级（局部后端：model-gateway + API + 研究会话集成测试）
- 提交：`9952a02`

### 3.27 F3：多搜索后端可选（2026-07-23）

**目标**

为 Agent 式搜索增加 DDG（免费零配置）、Tavily（AI 专用 API）和 SearXNG（自托管）三个可选后端，解除 Bing 单点依赖。通过统一的 `SearchBackend` 接口与注册表模式，支持配置切换和自动故障回退。

**改动内容**

| 文件 | 改动 |
|------|------|
| `apps/api/src/search-backends/types.ts`（新） | `SearchBackend` 接口（`id`/`requiresKey`/`search()`）+ `SearchBackendId` 联合类型 + `SearchBackendRegistry`（Map 注册模式，对标 model-gateway 的 `ProviderRegistry`）|
| `apps/api/src/search-backends/bing.ts`（新） | Bing 后端：提取现有 `searchBing()` 逻辑为 `SearchBackend` 实现，零配置 |
| `apps/api/src/search-backends/duckduckgo.ts`（新） | DDG 后端：HTML 抓取 `html.duckduckgo.com/html/`，解析 `result__body`/`result__snippet` CSS 类，零配置 |
| `apps/api/src/search-backends/tavily.ts`（新） | Tavily 后端：`POST api.tavily.com/search` JSON API，需 API Key（`createTavilyBackend(key)` 工厂函数）|
| `apps/api/src/search-backends/searxng.ts`（新） | SearXNG 后端：`GET {instance}/search?format=json`，需实例 URL（`createSearxngBackend(url)` 工厂函数）|
| `apps/api/src/search-backends/index.ts`（新） | 模块导出 + `SearchConfig` 类型 + `createSearchBackendRegistry()` / `selectSearchBackend()` + 回退逻辑 |
| `apps/api/src/web-search-agent.ts` | `webSearch()` 从直接调用 `searchBing` 改为调度器：读取配置 → 选择后端 → 调用 `backend.search()` → 失败时按固定顺序回退（bing→ddg→tavily→searxng）；新增 `initSearchBackends()`/`getSearchConfig()`/`updateSearchConfig()`/`listAvailableBackends()` 配置 API；`WebSearchResultSet` 增加 `backend`/`usedFallback` 字段 |
| `apps/api/src/service.ts` | 新增 `getSearchConfig()`/`updateSearchConfig()` 方法（校验后端 ID + 持久化 settings + 同步 Agent 层）；`getAiConfiguration()` 增加 `searchBackend`/`availableSearchBackends` 字段；`responseSummary` 增加 `searchBackend` |
| `apps/api/src/http.ts` | 新增 `GET/PUT /v1/settings/search` 端点（遵循 `/v1/settings/<resource>` 命名模式）|
| `packages/capture-contracts/src/index.ts` | `AiConfigurationView` 增加 `searchBackend?`/`availableSearchBackends?` 可选字段 |
| `tests/search-backends.test.ts`（新） | 21 个专项测试：接口约定、零配置校验、密钥校验、注册表操作、后端选择与回退、配置持久化与切换 |

**架构决策**

1. **Strategy 模式**：所有后端实现 `SearchBackend` 接口，`webSearch()` 是纯调度器不感知具体后端
2. **注册表对标 ProviderRegistry**：`SearchBackendRegistry` 使用相同的 Map-based 注册 + `list()`/`get()` 模式
3. **依赖注入保持解耦**：`AgentSearchToolContext` 不变，`runAgentSearchLoop` 不感知后端切换
4. **零新依赖**：所有后端使用原生 `fetch`，不引入第三方 SDK
5. **回退顺序固定**：bing → duckduckgo → tavily → searxng（免费→付费→自托管）
6. **配置持久化**：settings 表存 `search_backend`/`search_fallback`/`search_tavily_api_key`/`search_searxng_url`，通过现有 `saveSetting`/`getSetting` 读写

**验证**

- 构建：TypeScript 全量零错误、WebUI 构建通过
- Node 全量测试：235/235 通过（含 21 个新增搜索后端测试）
- WebUI 测试：197/197 通过
- 验证级别：三级（局部后端：搜索模块 + API + Service 集成）
- 提交：`efe0d73`

## 4. 当前数据与接口里程碑

| 版本 | 主要变化 |
| --- | --- |
| SQLite 研究会话基础 | 会话、消息、生成任务和可重放任务事件 |
| migration v15 | 会话创建幂等键和重试恢复 |
| migration v16 | 研究附件、导入任务、内容快照和持久导入事件 |
| migration v17 | 研究选区、选区分析任务和选区任务事件 |
| migration v18 | 研究分支、消息分支归属和会话来源选区 / 来源会话 |
| migration v19 | 稍后再学项目（创建幂等键、优先级与状态） |
| migration v20 | 历史独立搜索表（兼容与清理，不再写入） |
| migration v21 | 供应商联网运行、净化来源与行内引用 |
| migration v22 | 供应商凭证独立表 `provider_credentials`（与 Profile 外键级联），支持 WebUI 配置 API Key 并持久化 |
| migration v23 | 按任务类型的模型分配表 `model_purpose_routes`（外键级联），支持不同任务使用不同模型配置 |

当前主要恢复边界：

- 会话创建、消息提交和文件上传分别使用独立幂等键；
- 用户明确的新操作创建新键，网络请求重试复用原键；
- AI 输入、来源关系、附件和基础任务先持久化，再执行可能失败的生成或解析；
- 渐进事件断线后先尝试续传，再通过任务状态确认最终结果；
- 页面不把本地浏览器存储当作业务事实来源；
- 私有路径、对象键、模型凭证和本地会话令牌不进入公开记录。

## 5. 当前验证基线

阶段 H 并行三切片合并后（2026-07-30，§3.37）建立四级基线；选区交互修订一·A（§3.38）为纯前端切片按二级 + e2e 验证；修订一·B（2026-07-31，§3.39，契约改动）重跑四级全量；修订一·C（2026-07-31，§3.40，纯前端）按二级 + e2e 验证；修订二·D（2026-07-31，§3.41，共享契约 + 迁移 + 跨端路径）建立完整基线；阶段 I D1/E1（2026-08-02，§3.46，共享契约 + 迁移 v28/v29 + 跨端路径）刷新为当前最新基线（下表为修订二·D/E 历史基线，阶段 I 当前数字见本节末）。Issue 13 的最新复核追加证据见 §3.42：

| 范围 | 结果 |
| --- | --- |
| Node 单元与集成测试 | 302/302 通过（dist-tests 287 + ralph 脚本 15；全量并发收尾曾出现 2 项 Windows 临时目录清理竞态，相关测试单独复跑通过） |
| WebUI 客户端测试 | 279/279 通过（修订二·D 后；含标记编辑器、标记 hook、胶囊与捕获层用例） |
| Playwright e2e（假模型，真实 Chromium） | 修订二·E 实施时首轮 57 项中 55 项通过；修正定位断言后，Issue 13 标记列表与无模型返回场景定向通过；Windows webServer 收尾未自然退出（详见 §3.41） |
| Collector 项目检查 | 通过（`scripts/check-project.ps1`，2026-07-31 收尾复核时补跑） |
| 真实云模型调用 | 历史收尾版本 DeepSeek 四场景 4/4；本次 §3.42 可见 Chrome 主流程通过，真实模型 Playwright 1/4，另 3 个场景停在选区辅助函数 |
| 真实供应商联网验收 | 已停止（当前已配置供应商均不支持原生联网；阶段 E 以代码实现 + 自动化测试作为完成边界） |
| Agent 搜索（自动化） | 30 项 Agent 循环 + 搜索后端测试通过 |
| Agent 搜索（真实模型） | 待人工验收（Bing 已验证可行，DDG/Tavily 待配置后验证） |

**阶段 I 当前基线（2026-08-02，§3.46）**：D1 独立状态全量构建通过、Node 344/344、WebUI 297/297；D1+E1 合并状态全量构建通过、Node 366/366、WebUI 301/301（35 文件）。Playwright e2e 56/62，6 项失败经基线对照（检出 `904bfb6` 同规格复跑）确认全部先于阶段 I 即存在，零回归，预存测试债另立 issue #33 跟踪。添加迁移 v28/v29 暴露的三个旧迁移回滚测试（硬编码版本列表）已修复并纳入基线。

## 6. 已知限制与待验证事项

### 文件导入与阅读

- 接近 20 MiB 上限的浏览器上传、状态更新和阅读性能尚未实测；现有最大浏览器样本约 300 KB；
- 服务重启期间的导入恢复由后端集成测试覆盖，尚未在真实浏览器中复现；
- PDF 当前提供文本快照和页码锚点，不提供原始页面版式、文本层或页内精确高亮；
- 扫描 PDF、OCR、图片和 HTML 不在当前输入范围；
- Markdown 列表按原始文本行显示，结构渲染策略仍待与选区和引用体验一起确认；
- 网络结果不确定时的待重试文件和上传意图当前保存在浏览器内存中，关闭页面后不能恢复尚未得到服务端确认的本地文件选择；
- `pdfjs` 在缺少可选 canvas 原生绑定时会输出渲染警告，当前文本提取和页码锚点测试仍通过。

### 启动器与运行状态

- 运行版本替换和数据目录独占已有自动化覆盖；
- 真实旧服务替换、PID 退出、异常终止后的锁释放和无法安全关闭的旧实例仍需实际运行验收；
- 启动器不会强制结束身份无法验证的进程，这类情况需要用户先关闭旧服务。

### AI、搜索和产品核心

- 历史收尾阶段完成过一次真实模型四场景验收（DeepSeek deepseek-v4-flash，四场景全通过）；本次 Issue 13 复核在可见 Chrome 中走通主流程，但真实模型 Playwright 套件为 1/4，另 3 个场景停在自动化选区辅助函数；自动化测试套件（`test:e2e`）按项目约定只用确定性假模型；自动弱重现等仍属后续阶段；
- H2 起 WebUI 统一为节点页与全屏树导航；子节点选区归属当前节点与返回原文节点路由已于 §3.36 修复（原定 H4，提前完成），旧“独立会话”数据作为带来源选区的根节点呈现；
- H4a（§3.37）起旧选区智能窗口退役，替换为引用胶囊与双模发送（在此追问 / 深入研究这段）；修订一·A（§3.38）起引用改为选区上方浮动胶囊显式触发，引用态与原生选区解耦（死循环修复），Escape 不再关闭选区或胶囊，取消方式唯一为点击选取以外区域；修订一·B（§3.39）起最短字符限制全层退役（非空即有效，字数上限不变）；修订一·C（§3.40）起 `?sel=` 恢复后浮动胶囊呈现在高亮标记上方、引用后焦点回归输入框，窄屏钳制与上方空间不足翻转有端到端证明，浮动胶囊键盘可达，胶囊出现 / 消失带轻过渡（减弱动效环境关闭），修订一全部完成；修订二·D（§3.41）起浮动胶囊提供【标记】，点击即持久化本机标记并展开笔记输入框，1 秒未聚焦自动收起为纯标记，聚焦后锁定视口位置，点击外部保存笔记，重复标记幂等回填，节点页与阅读页均不依赖 AI；修订二·E（§3.41）起标记列表展示选区、笔记、来源节点和时间，点击项目通过 `?sel=` 返回原文并恢复高亮，刷新与服务重启继续恢复，恢复后不自动创建引用；旧面板「稍后再学」UI 入口暂时移除，后端端点保留；术语检测（H3a）与父链上下文（H5a）为地基层，尚未接入提示词与渲染；
- 离线演示回答不是产品能力证据；
- 真实模型当前等待供应商返回完整 JSON 后再按最多 80 字符写入渐进事件，不是供应商原生 token 流，首片延迟仍等于完整模型响应时间；
- 本地观测、模型设置和搜索轨迹还未形成完整的用户可见产品界面。

### 文件入口与阅读页聊天

- 开始页文件上传与拖放、阅读页 ChatComposer 已实现并通过 e2e 验证；
- 开始页上传文件再输入文字的组合路径不重复创建会话；
- 网络结果不确定时本地文件选择仍保存在浏览器内存，关闭页面后不能恢复。

### 联网搜索与引用（阶段 E，已实现）

- 联网搜索由当前 AI 模型供应商的原生联网能力提供（OpenAI `web_search` / Gemini Google Search grounding / Anthropic server-side web search/web fetch），迁移 v21 三表（`research_grounding_runs` / `research_grounding_sources` / `research_citations`）保存净化后的轨迹与引用；
- 历史 SearXNG 独立适配层方案（迁移 v20）已清除，相关代码从未合入 master；
- 行内引用胶囊、来源预览与定位高亮已在提交 `b814d95`（悬停来源卡片）和 `3b1f124`（Markdown 渲染）中升级：引用角标在 Markdown 排版内通过 remark 插件渲染为可悬停来源卡片；返回高亮改为在渲染后 DOM 上直接圈 `<mark>`，偏移失败时 exact 文本兜底；旧 AI 选区可能退化为粗粒度说明（产品已允许）。
- 外部来源链接使用 `noopener noreferrer` 安全开窗，写入 SQLite 前二次脱敏；
- 联网开始状态由任务记录呈现，尚未新增独立 SSE 联网阶段事件；
- **真实验收状态**：阶段 E 真实供应商联网验收**已停止**。当前已配置的 DeepSeek 与 Mimo 在代码中均标记为 `webGrounding: "unsupported"`，无法触发供应商联网路径；用户确认 Mimo 使用模型商自有联网搜索服务，协议待确认接入。产品决策已更新为"用户主动场景默认关闭、输入框开关控制"，但阶段 E 不再执行真实环境验收，以代码实现 + 自动化测试作为完成边界。

## 7. 下一阶段开发方向

阶段 E（可信研究能力）全栈实现已提交（`0343c56`），产品决策曾调整为"用户主动场景默认关闭、输入框联网开关控制"（详见 §3.33）。**真实供应商联网验收已停止**：当前后端保存的 4 个 profile 均不支持原生联网，且用户决定不再继续阶段 E 真实环境验收。阶段 E 以"代码已实现 + 自动化测试通过"作为完成边界，用户可控开关作为后续增强另行安排。

阶段 F（联网搜索策略改进）已全部完成（2026-07-23）：
1. **F1（日志+查询改写）**：已完成（`68b39be`）。在 `web-search-agent.ts` 关键节点加 console.log，前置 LLM query reformulation 修复中文分词问题；
2. **F2（工具化+Agent 循环）**：已完成（`9952a02`）。拆分 web_search/web_fetch 为独立工具，引入 Agent tool-use loop，让模型自主控制搜索节奏。对标 DeerFlow 搜索体验的核心改造；
3. **F3（多后端）**：已完成（`efe0d73`）。增加 DDG / Tavily / SearXNG 三个可选后端，统一 SearchBackend 接口 + Registry 模式 + 自动故障回退。Bing 单点依赖已解除。

完整调研结论、设计决策和切片详情见 `docs/MVP_IMPLEMENTATION_PLAN.md` 阶段 F。

### 3.28 批次①：Markdown 渲染 + 悬停来源卡片（2026-07-23）

**用户可见结果**

- AI 回答、研究内容、研究分支均按 Markdown 排版（标题、表格、加粗、代码块、列表等），选区分析散文同步渲染 Markdown；
- 引用角标 `[n]` 在桌面端悬停/聚焦时弹出来源预览卡片（站点名、标题、摘要、发布时间），卡片内可点击"打开原文"跳转原网址；
- 返回高亮改为在渲染后 DOM 上直接圈 `<mark>`，偏移失败时 exact 文本兜底搜索；旧 AI 选区可能退化为粗粒度说明（产品允许）。

**改动**

- 新增 `react-markdown` / `remark-gfm` / `remark-breaks` / `rehype-sanitize` 依赖（`apps/web/package.json`）；
- 新增 `MarkdownContent` 组件（白名单 sanitize、`cite-marker` 自定义节点支持、`insight`/`message` 变体）、`remarkCitationMarkers` 插件（`[来源n]`→hast 节点）、`SourceCard` 悬停卡片组件、`useHoverCard` 定位/显隐钩子（`createPortal` 到 body、z-index 55）、`CitationMarker` 共享引用角标组件；
- 抽取 `citation-utils.ts`（`buildSourceMap` / `buildCitationIndex`），编号逻辑从 `MessageItem` 提出共用；
- `MessageItem` 三表面（`AssistantBlocks`/`GeneratingBody`/`FailedBody`）全换 `MarkdownContent`，旧 `BlockTextWithCitations`/`TextRange` 已移除；
- `highlightForMessages` 不再交叉比对原始 `block.text`，直传可见空间偏移；`MessageBlock` 用 `useLayoutEffect` + `setRangeFromOffsets` 圈 `<mark>`；
- `SelectionInsightPanel` 散文字段接 `MarkdownContent`（`variant="insight"`）；
- `global.css` 增 `.markdown-content*` 体系与 `.source-card*` 样式。

**关键提交**

- `b814d95`：来源引用角标升级为可悬停来源卡片（子步 1）
- `3b1f124`：AI 文本表面统一 Markdown 渲染管线（子步 2）

**验证**

- TypeScript `tsc --noEmit` 两次零错误；
- `apps/web` vitest run：25 文件 197 测试全通过，子步 1 零回归、子步 2 适配新语义（消息块夹具改用 `[来源n]` token + remark 路径；高亮测试改用新语义）。

**未完成 / 风险**

- 旧 AI 选区可能降级为粗粒度高亮（产品已允许的精确位置降级）；
- 模型混写 `[1]` 与 `[来源n]` 不处理（留到"收紧引用指令"批次）；
- 知乎等 JS/反爬站深层抓取仍未解决（留到批次②"联网抓取质量"）；
- 设置页面 WebUI 未做（后端 API 就绪，前段按计划排在未来阶段）。

### 3.29 阶段 G：WebUI AI 模型配置与凭证持久化（2026-07-29）

**用户可见结果**

- 左侧导航新增“AI 模型设置”入口，会话页模型状态点可点击直达设置页；
- 用户在设置页选择供应商（含自定义兼容端点）、输入模型与 API Key，可先“测试连接”再“保存并启用”；
- 配置保存在本机 SQLite，服务重启后用普通 `Collector.cmd` 启动即可恢复真实模型，不再依赖带硬编码密钥的启动器；
- 已保存配置列表支持“设为当前”与“删除”；未配置 Key 的配置明确标注；
- 界面与响应永不回显完整 API Key，Key 只在提交瞬间存在于页面内存，保存后立即清空。

**改动**

- 契约：`ProviderProfileInput` 新增 `apiKey?`（仅提交用），新增 `ProviderProfileTestInput`；
- 存储：SQLite 迁移 v22 新建 `provider_credentials` 表（外键级联删除），`CollectorStore` 新增凭证三个 CRUD；清空全部数据保留 AI 配置；
- 服务层：`saveProviderProfileWithCredential`（Key 三态：非空写入 / 空串删除 / 未提供保留）、`activateProviderProfile` 与删除后重建当前模型网关、`testProviderProfile(Input)` 连接测试；
- 启动流程：环境变量存在时强制覆盖激活 `environment-<providerId>` 配置；否则从持久化激活配置 + 凭证重建网关；`setModelGatewayResolver` 按路由的 `providerProfileId` 校验并解析任意已存配置，支持重启后任务恢复；
- HTTP：新增 `/v1/provider-catalog`、`/v1/provider-profiles`（列表 / 创建 / 激活 / 删除 / 测试）与 `/v1/provider-profiles/active`（无配置返回 204）；
- WebUI：新增 `AiModelSettingsPage`（表单 + 已保存列表）、路由 `/settings/ai-model`、导航入口与状态点引导；API 客户端新增对应 8 个方法；
- 安全约束：API Key 不写入 localStorage / sessionStorage / URL / 日志；响应不含 `apiKey` 字段；`clearAllData` 保留凭证。

**验证**

- 验证级别：四级（共享契约 + SQLite 迁移 + 跨端集成）；
- Node 全量测试 244/244 通过（新增凭证存储、服务层、HTTP、激活恢复共 10 个测试；`sqlite-store.test.ts` 迁移断言适配 v22）；
- WebUI 测试 200/200 通过（新增设置页 3 个测试：保存清空 Key、测试连接、列表激活删除）；
- 项目检查 `check-project.ps1` 通过（0 errors, 0 warnings）；
- 未执行项及理由：真实浏览器人工验收待用户在真实环境完成（本切片交付后首次使用需人工配置一次真实 Key）；Playwright e2e 未新增——设置页无流式 / 选区等复杂交互，组件级测试已覆盖提交与错误路径。

**未完成 / 风险**

- 明文凭钥存储符合当前本机单用户威胁模型；未来接入 Windows DPAPI / 系统钥匙串只需替换凭证 CRUD 层；
- 升级前已存在且 `credentialConfigured=true` 的旧配置没有真实密钥，首次启动会显示为已配置但调用失败，需在设置页重新输入 Key；
- 真实模型 + 真实浏览器端到端验收（保存 → 重启 → 直接可用）待人工执行。

### 3.30 阶段 G2：模型配置管理增强与按任务类型分配（2026-07-29）

**用户可见结果**

- 设置页可编辑已有配置（供应商类型锁定、Key 留空保持不变），并可「仅保存」不启用，多套配置自由添加与切换；
- 模型输入框旁「获取模型」按钮一键拉取当前供应商的可调用模型列表并下拉选择，失败时给出中文原因（认证失败 / 端点不支持 / 解析失败 / 超时）；
- 测试连接显示耗时（如「连接成功：gpt-4.1-mini · 1.2s」）；
- 供应商目录新增 Kimi (Moonshot)、智谱 GLM、SiliconFlow 预设（通义百炼此前已在目录）；
- 会话页模型状态点展开即可在已保存配置间一键切换，无需进入设置页；
- 设置页新增「任务模型分配」：对话、选区分析、深入研究、联网搜索、文档生成可分别指定使用哪套配置，默认全部跟随当前配置。

**改动**

- G2a（`3581c46`，三级）：契约新增 `ProviderModelDiscoveryInput/Result` 与 `ProviderTestResult.durationMs`；模型网关新增 `discoverProviderModels`（OpenAI 兼容 Bearer / Anthropic x-api-key / Gemini x-goog-api-key 三种认证，统一 GET `{baseUrl}/models` 解析）；HTTP 新增 `POST /v1/provider-models/discover`（可复用已保存凭证）；设置页表单双模式 + datalist 候选；前端结果型接口修复——502 业务失败解析响应体，友好错误不再被吞；
- G2b（`d198a7e`，二级）：`ModelStatusIndicator` 从链接改为可展开菜单，直接激活切换；`AiConfigurationView` 增量补充 `providerProfileId`；
- G2c（`50f7007`，四级）：契约 `ModelPurpose`（chat/selection/research/search/document）；SQLite 迁移 v23 `model_purpose_routes`（外键级联、删配置联动清理、`clearAllData` 保留）；service 按用途的网关快照懒重建，生成调用按用途解析（Agent 搜索→search、深入研究→research、对话→chat、选区分析→selection、文档增量更新→document），失效分配静默回退激活配置；HTTP `GET/PUT /v1/model-routing`；设置页分配区块。

**验证**

- G2a 三级：Node 251/251、WebUI 204/204、前端构建通过；
- G2b 二级：WebUI 207/207、类型检查与构建通过；
- G2c 四级：Node 256/256（连续两轮；新增 service 3 项、store 1 项、HTTP 1 项）、WebUI 208/208、`check-project.ps1` 通过；
- 未执行项及理由：真实浏览器与真实供应商验收（获取真实模型列表、真实切换与分工生效）随阶段 G 收尾人工进行；自动化永不访问真实云模型。

**未完成 / 风险**

- 任务记录上的 provider/model 元数据仍按激活配置盖章；实际每次调用的真实供应商与模型以模型调用轨迹（model_calls）为准，任务详情展示口径待后续统一；
- 工作流（整理、文档生成）的冻结路由恢复语义未接入任务分配，沿用既有行为；
- 课题级 Deep Research（从自由课题发起、多轮研究报告）为待确认方向，见 `MVP_IMPLEMENTATION_PLAN.md` 待确认事项。

### 3.31 阶段 G2d：获取模型后勾选批量添加（2026-07-29）

**背景**：对照 CC Switch 仓库源码（`useModelState.ts`、`ModelDropdown.tsx`、`claudeProviderPresets.ts`）核实其真实机制——CC Switch 一个供应商配置内含多个模型槽位（主模型 + Haiku/Sonnet/Opus/Fable 角色 + 子代理），Key 只填一次；获取模型下拉按 `owned_by` 分组。此前 G2 把任务分工做成配置粒度（一个配置一个模型），同一厂商多模型需重复输入 Key，与 CC Switch 的添加体验存在偏差。经用户确认采用轻量方案：保持"配置 = 一个模型"的数据结构不变，把"添加"升级为可勾选批量保存；配置内多模型作为候选方向暂不实施。

**用户可见结果**

- 「获取模型」成功后，模型列表以按家族分组的勾选列表展示（`deepseek-ai/…` 按 `/` 前缀、`gpt-…` 按 `-` 首段分组），当前默认模型自动勾选；
- 勾选多个模型后点保存，为每个勾选模型各生成一套配置（命名为"配置名 · 模型名"），共用同一个 Key——Key 只输一次即可配好同一厂商的多个模型；
- 「保存并启用」只启用第一个勾选项；已保存过的同厂商模型在列表中标记"已保存"并禁用，防止重复添加；
- 部分保存失败时，已成功的保留、失败的保持勾选且 Key 不清空，可直接重试。

**改动**

- `AiModelSettingsPage.tsx`：新增纯函数 `groupModelsByFamily`；表单新增勾选状态与分组勾选列表（仅新建模式）；`handleSave` 增加批量分支，串行调用既有 `saveProviderProfile`（激活语义由顺序保证）；按钮文案带勾选数量；`global.css` 新增 `.settings-model-picker` 系列样式（全部使用既有设计令牌）；
- 后端、契约与数据表零改动——批量保存复用既有逐配置保存接口。

**验证**

- 二级（局部前端）：`tsc --noEmit` 通过、WebUI 214/214（新增 6 项：分组纯函数、列表展示与默认勾选、批量保存并启用、批量仅保存、部分失败重试、已保存禁用）、生产构建通过；
- 未执行项及理由：无后端与跨端契约改动，不执行 Node 全量测试与浏览器 e2e；真实供应商批量添加体验随阶段 G 收尾人工验收。

**未完成 / 风险**

- 配置内多模型槽位（彻底对齐 CC Switch 的数据模型）为候选方向，如后续确认需要再单独立项（涉及表结构与任务分工口径调整）。



### 3.32 阶段 G3：模型设置页交互优化（2026-07-29）

**用户可见结果**

- 设置页默认显示「已保存的模型配置」列表，并通过「新建模型供应商」按钮给出明确的新建入口；编辑时表单展开，取消后回到列表；首次使用无配置时自动展开新建表单；
- API Key 输入框旁新增眼睛按钮，可在明文与暗文间切换；
- 编辑已有配置时，已保存的 Key 自动从本机凭证读取并暗文回填，因此服务重启后再次编辑仍能看到暗文 Key，无需重新输入；保存后 Key 继续以暗文停留在输入框中（新建/编辑均不清空，降低误触丢失风险）；
- 模型输入框不再使用下拉候选，点击「获取模型」后在同页面内以按家族分组的复选框列表展示可调用模型；新建模式可勾选多个模型批量保存，编辑模式同样可勾选批量补充模型；
- 已保存配置列表按供应商分组，每行一个启用/停用复选框；停用的配置不再出现在会话页快速切换和任务模型分配中；当前使用中的配置不能停用。

**改动**

- 后端：
  - 契约 `packages/capture-contracts/src/index.ts`：新增 `ProviderCredentialView` 读取视图；修正 `ProviderProfileInput.apiKey` 注释，说明专用凭证端点用于设置页回填；
  - 服务层 `apps/api/src/service.ts`：新增 `getProviderCredentialView(id)` 与 `setProviderProfileEnabled(id, enabled)`；激活配置时校验 `enabled`，已停用配置不能设为当前；
  - HTTP `apps/api/src/http.ts`：新增 `GET /v1/provider-profiles/:id/credential` 与 `POST /v1/provider-profiles/:id/enabled`；
  - 测试 `tests/provider-profile-http.test.ts`：新增凭证读取（认证、未配置 404、响应不含完整 Key 之外）与启停用边界（当前配置不能停用、已停用不能激活、boolean 校验）测试；
- WebUI：
  - `apps/web/src/api/client.ts`：新增 `getProviderCredential(id)` 与 `setProviderProfileEnabled(id, enabled)`；
  - `apps/web/src/features/settings/AiModelSettingsPage.tsx`：重构页面结构，默认收起表单；新增 `ProviderProfileList` 按供应商分组与启用复选框；`ProviderProfileForm` 移除 datalist，编辑模式自动读取并回填 Key，眼睛按钮切换 Key 明文/暗文，批量保存支持编辑模式补充模型，保存后不清空 Key；
  - `apps/web/src/features/research-session/ModelStatusIndicator.tsx`：快速切换菜单过滤已停用配置；
  - `apps/web/src/styles/global.css`：新增 Key 输入框包裹、眼睛按钮、新建入口与已保存列表分组样式；
  - 测试 `apps/web/src/features/settings/AiModelSettingsPage.test.tsx`：适配新交互并新增 5 项（眼睛切换、Key 回填、读取失败时保持原凭证、新建入口流程、启停用复选框、编辑模式批量补充模型）；
  - e2e `apps/web/e2e/settings-ai-model.spec.ts`：新增真实浏览器验收（新建入口、Key 暗文持久、眼睛切换、编辑回填、启停）。

**验证**

- 验证级别：四级（新增后端端点 + 契约 + WebUI 行为 + 浏览器 e2e）；
- Node 全量测试 258/258 通过（新增 2 个 HTTP 端点测试）；
- WebUI 测试 219/219 通过（新增/适配 10 项）；
- 真实浏览器 Playwright e2e `settings-ai-model.spec.ts` 1/1 通过（Chromium，验证 Key 暗文持久、眼睛切换、新建入口、编辑回填、启停边界、控制台无错误）；
- `check-project.ps1` 通过（0 errors, 0 warnings）；
- 未执行项及理由：e2e 仅新增设置页专项，未重新跑全量 e2e 套件；其余 e2e 在前序阶段已通过且本次改动未涉及对应用户路径。

**未完成 / 风险**

- 凭证明文仍按当前本机单用户威胁模型存储于 SQLite；未来接入系统钥匙串仅替换凭证 CRUD 层；
- 眼睛按钮显示明文时，截图/录屏可能短暂暴露 Key，与密码输入框标准行为一致，用户需自行注意；
- 已停用配置在会话页快速切换和任务模型分配中已过滤，但工作流/整理等未接入任务分配的路径仍使用当前激活配置，不受影响。
1. 真实供应商联网验收：配置支持原生联网的模型（OpenAI / Gemini / Anthropic）后，完成真实搜索、真实引用、无引用/失败/不支持降级、SQLite 与日志脱敏、主线与分支刷新恢复、以及宽/窄屏、键盘、可访问性、控制台和网络检查；
2. AI 短概念弱标记、自动弱重现（学习增强）；
3. 本地观测界面、模型设置与用量查看；
4. 选区智能窗口字段顺序与信息密度的最终确认。

完整范围、阶段顺序和用户可见验收场景见 `PRODUCT.md` 和 `MVP_IMPLEMENTATION_PLAN.md`。

### 3.33 阶段 E 验收状态与联网搜索产品决策调整（2026-07-30）

**背景**

阶段 E 全栈实现已于 2026-07-22 提交（`0343c56`），原计划使用 OpenAI / Gemini / Anthropic 三家供应商的原生联网能力完成真实验收。本次重新检查后端已保存配置后发现：当前 4 个已配置 profile（DeepSeek v4-pro、DeepSeek v4-flash、Mimo v2.5、Mimo v2.5-pro）在项目代码中均被标记为 `webGrounding: "unsupported"`，四家均可连通但都无法触发供应商联网路径。用户当前没有 OpenAI / Gemini / Anthropic 的 API Key，且 Mimo 使用的是模型商自有的联网搜索服务（非 OpenAI / Gemini / Anthropic 协议），需要先确认其具体协议才能接入。

**产品决策调整（已确认）**

1. **联网搜索默认关闭**：用户主动发起的 Chat、研究会话和分支追问不再自动请求联网；输入框增加联网搜索开关，开关默认关闭。
2. **用户主动场景手动控制**：只有用户明确打开联网开关时，Chat / 研究会话 / 分支追问才请求当前模型供应商的联网能力。
3. **其他 AI 生成场景由模型/任务类型自行判断**：文档生成、整理、节点命名等后台或任务驱动场景，按任务类型配置决定是否联网，不由用户开关控制。
4. **选区分析维持始终不联网**：保持可复现性，不因网络波动改变质量判断。
5. **Mimo 等自有联网服务后续单独接入**：当前阶段 E 默认适配 OpenAI / Gemini / Anthropic 三家；Mimo 等模型商自有联网协议确认后，作为新增 provider 或 custom 扩展单独接入网关。

**当前实现状态**

- 模型网关已支持 OpenAI `web_search`、Gemini Google Search grounding、Anthropic server-side web search/web fetch；
- SQLite v21 已保存联网运行、来源、引用结构；
- 当前调用入口仍按旧决策"自动请求联网"实现，需要按新决策改造为"默认关闭 + 输入框开关"；
- 真实供应商联网验收需在新入口改造完成后，且配置至少一家支持联网的模型（OpenAI / Gemini / Anthropic 或已接入的 Mimo）才能执行。

**验收决策（2026-07-30 更新）**

用户决定**停止阶段 E 真实供应商联网验收**。原因：当前已配置的 4 家供应商在项目代码中均不支持原生联网，用户也没有 OpenAI / Gemini / Anthropic 的 API Key；Mimo 自有联网协议尚需单独接入。阶段 E 以"代码已实现 + 自动化测试通过"作为完成边界，不再执行真实环境验收。

**待实施（调整为后续增强，不阻塞阶段 E 收尾）**

- 契约：消息提交增加 `webSearchEnabled` 字段；
- 后端：研究任务、对话任务按该字段决定是否请求 `generateGrounded` / 供应商联网；
- WebUI：ChatComposer / 分支输入区增加联网开关（默认关闭），状态与当前会话/消息绑定；
- 更新自动化测试与 e2e 场景，覆盖"开关关闭不联网"和"开关开启产生引用"两条路径；
- 若未来配置支持联网的模型，再执行真实联网验收。

**影响**

- `docs/PRODUCT.md` 与 `docs/MVP_IMPLEMENTATION_PLAN.md` 已同步更新；
- 阶段 E 收尾从"待真实验收"调整为"真实验收已停止，以自动化测试与代码实现作为完成边界"；
- 用户可控联网开关作为后续增强，不阻塞阶段 H（统一研究节点树）启动；阶段 H 中的"就地追问"和"节点生长"输入框如实现联网开关，需继承同一语义。

### 3.34 阶段 H1：节点数据模型归并与迁移（2026-07-30）

**背景**

Collector 此前用 `ResearchSessionRecord` + `ResearchBranchRecord` 两套结构分别表达研究会话与深入研究分支，导致同一个"可追问、可生长、可返回"的语义被割裂。阶段 H 的方向已确认：把会话和分支归并为同构递归节点树，根节点对应一次 Chat 或一篇导入文档，子节点由选区/弱标记生长而来。H1 先落地风险最高的数据层改造与迁移，保持旧 API 兼容，避免 WebUI 一次性大改。

**用户可见结果**

- H1 为纯后端数据层改造，用户可见行为保持不变：Chat、分支视图、选区窗口、稍后再学、来源返回的既有路径继续工作；
- 旧 `/research/:sid/branch/:branchId` 路由与旧 HTTP 端点仍可用，已有数据和最近会话列表不受影响；
- 新增节点端点已就绪但尚未接入 WebUI，H2 将统一为 `/research/:sessionId/node/:nodeId` 页面。

**工程结果**

- 共享契约（`packages/capture-contracts/src/index.ts`）：
  - 新增 `ResearchNodeRecord`、`ResearchNodeView`、`CreateChildNodeInput`、`NodeGrowthAccepted`；
  - `ResearchMessageRecord`、`ResearchTaskRecord`、`ResearchSelectionRecord`、`ResearchLaterItemRecord` 增加 `nodeId?: string`；
  - `ResearchBranchRecord` 与 `DeepResearchMode` 标记为弃用但保留，避免 H1 同时改 WebUI 路由。
- SQLite 存储（`apps/api/src/store.ts`）：
  - 迁移 v24 新建 `research_nodes` 自引用表（`parent_node_id`、`origin_selection_id`、`session_id`），并恢复此前被意外覆盖的 v23 `model_purpose_routes` 迁移；
  - 根节点复用 `research_sessions.id`，子节点复用 `research_branches.id`，保证 URL 与 FK 稳定；
  - 迁移对每行会话/分支生成节点，回填 `research_messages`、`research_tasks`、`research_selections`、`research_later_items` 的 `node_id` 与 `record_json`；
  - 新增 `createResearchNode`、`getResearchNode`、`listResearchNodes`、`listChildNodes`、`listResearchMessagesByNode`、`listResearchTasksByNode`、`createResearchTurnForNode`、`createResearchChildNode`；
  - 旧 `createResearchSession`、`createResearchTurn`、`createResearchBranch` 等路径继续双写 `sessionId` / `branchId` 与 `nodeId`，避免漂移；
  - `clearAllData` 调整删除顺序，先删子节点再删根节点，满足外键约束。
- 服务层：
  - `apps/api/src/research.ts`：`submitMessageToNode`、按 `nodeId` 组装生成上下文；区分根节点 origin 会话（无 `parentNodeId`）与分支子节点；
  - `apps/api/src/deep-research.ts`：新增 `NodeGrowthService`（`startChildNode`、`getNodeView`、`listChildNodes`），旧 `submitBranchMessage` 改走 `createResearchTurnForNode`；
  - `apps/api/src/selection.ts`：新建选区默认归属当前会话的根节点；
  - `apps/api/src/service.ts`：实例化 `nodeGrowth` 服务。
- HTTP 层（`apps/api/src/http.ts`）：保留旧端点；新增 `POST /v1/research-selections/:id/nodes`、`POST /v1/research-nodes/:id/messages`、`GET /v1/research-nodes/:id`、`GET /v1/research-nodes/:id/children`。
- WebUI 测试与 e2e：
  - `apps/web/src/test/fakes.ts` 新增 `makeNode` 辅助，消息/任务夹具支持 `nodeId`；
  - `apps/web/e2e/helpers.ts` 新增共享 `selectAnswerText`，改为在 `data-block-text` 容器内查找目标文本的最深层文本节点，兼容 Markdown 渲染后的嵌套 `<p>`；
  - 三个用到该助手的 e2e 文件（`selection-window.spec.ts`、`z-deep-research.spec.ts`、`z-research-later.spec.ts`）改为从 helpers 导入，并修复键盘 Shift 选区测试的文本节点查找。

**关键提交**

- `c696317`：阶段 H1 节点数据模型归并与迁移。

**验证**

- 验证级别：四级（共享契约 + SQLite 迁移 + 跨端集成 + 旧 API 兼容）；
- `npm run build` 通过（TypeScript project references + WebUI 生产构建 + asset 构建）；
- Node 全量测试 259/259 通过（新增 `migration v24 maps sessions and branches to nodes and backfills node_id` 等迁移断言）；
- WebUI 测试 219/219 通过；
- Playwright e2e 40/40 通过（含 `selection-window`、`z-deep-research`、`z-research-later`、无模型路径）；
- 未执行项及理由：真实浏览器人工验收在 H1 不需要（无用户可见行为变化），H2 统一节点页后再补真实浏览器验收。

**未完成 / 风险**

- H2 将退役 `/research/:sid/branch/:branchId`，需添加重定向保留旧书签；
- `branchId` 与旧 `DeepResearchMode` 二选一将在 H2 或 H3 彻底移除；
- 子节点稍后再学（H4）、父链上下文编排（H5）、节点命名（H6）尚未实施；
- 迁移回滚：v24 未提供 down-migration，若生产环境需要回滚应依赖部署前备份。

### 3.35 阶段 H2：节点页统一与全屏树导航（2026-07-30）

**背景**

H1 完成了节点数据层（`research_nodes` 自引用表与迁移），但 WebUI 仍按旧"会话页 + 分支页"两套呈现，选区"深入研究"仍是"沿当前内容 / 独立会话"二选一。H2 把界面收敛到同构节点模型：一个页面呈现所有节点，一个动作生长子节点，一个全屏树视图完成节点间导航。

**用户可见结果**

- 研究界面统一为一个节点页：对话是根节点，从选区长出的深入研究是子节点，页面结构、追问、来源条、子节点入口完全一致；旧的会话页地址和分支页地址自动跳转到新地址（选区高亮参数保留）；
- 选区窗口的"深入研究"不再弹二选一：直接打开"开枝散叶"面板，可选填写重点问题后开始研究，进入新子节点；旧"独立会话"数据继续正常显示来源条；
- 新增全屏树导航：顶栏"节点树"按钮或快捷键 `t` 唤出，顶部面包屑显示从根到当前节点的路径（每级可点击），树中方向键移动 / 展开折叠、Enter 进入、兄弟节点并列点击即跳，Esc 关闭后焦点回到按钮；
- 修复：Esc 关闭树视图时不再连带收起两侧栏目并抢走焦点（侧栏 Escape 处理让位于已处理的覆盖层）。

**工程结果**

- 后端：共享契约新增 `ResearchSessionNodeTreeItem`；`NodeGrowthService.getNodeTree(sessionId)` 输出扁平树条目（根=会话标题、子=来源选区摘要的确定性标签）；新增 `GET /v1/research-sessions/:id/nodes`；旧端点全部保留作兼容层。
- WebUI 节点页：`ResearchNodePage` + `useResearchNode`（数据走 `/v1/research-nodes/:id`，提交走 `/v1/research-nodes/:id/messages`）；`NodeChildList` 取代 `BranchList`；附件与拖放导入仅根节点显示；删除 `ResearchSessionPage`、`ResearchBranchPage`、`useResearchSession`、`useResearchBranch`、`BranchList` 及对应测试。
- 路由：`/research/:sessionId` 与 `/research/:sessionId/branch/:branchId` 经 `<Navigate replace>` 重定向到 `/research/:sessionId/node/:nodeId` 并保留 `?sel=`；`backRouteForSelection`、阅读页返回链接直接指向节点路由。
- 选区窗口：二选一退役，`stage` 收敛为 actions/grow/later；`POST /v1/research-selections/:id/nodes` + `ng:<选区id>:<query摘要|auto>` 幂等键（FNV-1a 摘要，中文不进请求头）。
- 树导航：`NodeTreeOverlay`（role="dialog" + role="tree"/"treeitem"、roving tabindex、aria-expanded/selected/level）+ `useNodeTree` 纯函数（建树、可见行展开、祖先链、默认展开集合）；AppShell 顶栏入口与全局快捷键 `t`（输入控件聚焦时不触发）。
- e2e 基础设施：`readResearchNodeTables` 取代 `readResearchBranchTables`（按 `research_nodes` 与 `node_id` 核对）；修复 `recent-organization.test.ts` 在 Windows 上的拆卸竞态（`rm` 加 `maxRetries`）。

**关键提交**

- 本阶段实现提交见 Git 历史（阶段 H2 节点页统一与全屏树导航）。

**验证**

- 验证级别：四级（共享契约新增 + HTTP 新端点 + 跨端路由集成 + 旧路由重定向）；
- `npm run build` 通过；Node 全量测试 260/260；WebUI 测试 229/229；Playwright e2e 45/45（chromium 41 + chromium-nomodel 4，含新增 `z-node-tree.spec.ts` 树导航三场景与 `z-old-route-redirect.spec.ts` 旧路由重定向两场景）；`scripts/check-project.ps1` 通过；
- 真实 Chromium 浏览器证据（`z-node-tree.spec.ts` 自动取证）：节点页 320/768/1024/1440 视口无横向溢出并留截图（`e2e-artifacts/node-page-viewport-*.png`）、320px 树视图全屏覆盖截图、键盘全流程（按钮/快捷键唤出、方向键、Enter 跳转、Esc 焦点返回）、单一 h1、`role="tree"` aria 属性齐全、网络契约（节点页只调 `/v1/research-nodes/:id`，打开树时整树一次拉取）、控制台无错误；
- 未执行项及理由：真实模型验收套件（`z-acceptance-real.spec.ts`）已同步改造为节点生长流程，但按既有约定真实模型验收不由本阶段自动执行；如需复验真实模型路径，单独运行 acceptance 配置。

**未完成 / 风险**

- 在子节点页面上创建的选区仍归属根节点、返回原文一律回根节点（该正确性缺陷已于 §3.36 从 H4 提前修复）；
- 弱标记（H3）、就地追问与选区窗口字段简化（H4）、父链上下文编排（H5）、节点命名（H6）尚未实施；HUD 导航为独立实验切片；
- 旧 HTTP 端点与 `branchId` 双写字段作为兼容层保留，移除时机随 H3–H6 另行确认；
- 真实浏览器人工体验（手感、动画、朗读）建议用户在正式使用时补充确认，自动化已覆盖结构、键盘与网络契约。

### 3.36 选区归属当前节点与返回原文节点路由修复（issue #3，2026-07-30）

**背景**

H2 统一节点页后试用发现两个用户可见缺陷，根因相同——选区没有归属到它被创建时所在的节点（H1 过渡处理把选区一律归属会话根节点，原计划在 H4 支持归属当前节点）。本修复把该正确性缺陷从 H4 提前，分两张票据实施：票据 1（#4）修选区创建归属与生长链落库，票据 2（#5）修返回原文路由与精确高亮并做端到端收口。

**用户可见结果**

- 生长链不再断裂：在子节点内容里发起深入研究，新节点挂在该子节点下，知识树能自然形成 A-C-D 的多级层级；全屏树导航、面包屑、节点页子节点列表随之呈现真实层级（这些呈现侧本已按父节点工作，归属修对后自然正确）；
- 返回原文不再一律回到最初会话：从子节点来源条点“返回原文”回到选区所属节点的页面，原选区在该节点内容里被精确圈出（不漂移、不降级），刷新后高亮与树结构保持；
- 兼容：无节点归属的旧选区仍回根节点页面，阅读页快照选区仍回阅读页，行为与修复前一致；旧数据不做迁移。

**工程结果**

- 契约：`ResearchSelectionInput` 增加可选 `nodeId`，`validateResearchSelectionInput` 校验其为非空字符串。
- 服务端（票据 1）：`ResearchSelectionService.createSelection` 按输入 `nodeId` 归属选区——提供时校验节点存在且属于当前会话，不合法按 400 验证错误拒绝（不静默改写）；未提供时归属会话根节点；`ResearchSelectionStore` 接口补充 `getResearchNode`。生长侧 `startChildNode` 本已按 `selection.nodeId ?? selection.sessionId` 挂父节点，归属修复后自动形成多级链，未改动。
- WebUI（票据 1）：`SelectionSurface` / `SelectionInsightPanel` 增加当前节点 id 输入，节点页创建选区时随请求提交；阅读页不传，归属根节点不变。
- WebUI（票据 2）：`backRouteForSelection` 对消息锚点选区生成 `/research/:sessionId/node/:nodeId?sel=...`，`nodeId` 取 `selection.nodeId ?? selection.sessionId`；快照锚点仍回阅读页。来源条与稍后再学面板的返回链接统一走该函数。
- 幂等键不变：选区创建幂等键由锚点派生、节点生长幂等键为 `ng:<选区id>:<摘要|auto>`，均不含节点 id。

**关键提交**

- 票据 1（选区创建归属当前节点，生长链落库）：`4d5d0c1`；
- 票据 2（返回原文节点路由、精确高亮与端到端三级链验收）：本次提交。

**验证**

- 验证级别：四级（共享契约改动 + 跨端路由集成 + e2e）；
- 票据 1：`npm run build` 通过；Node 全量测试 262/262（含新增“选区归属默认根节点并校验输入节点”“子节点选区生长孙节点形成 A-C-D 三级链”两条）；WebUI 测试 232/232（含窗口携带 nodeId、子节点页呈现自有子节点、来源返回携带当前节点 id 三条）；
- 票据 2：Node 全量测试 262/262；WebUI 测试 233/233（含返回原文路由两种归属）；Playwright e2e 46/46（chromium 42 + chromium-nomodel 4，含新增 `z-node-tree.spec.ts` 三级生长链场景：根生长 B、回根生长并列 C、进入 C 生长 D，全屏树呈现 A-(B, C-D)，D 返回原文落在 C 且精确高亮、刷新后保持）；
- e2e 基础设施：配对码池初始数量由 40 调整为 64，覆盖整套 chromium 用例，避免在 90 秒补充窗口内耗尽。

**未完成 / 风险**

- 弱标记（H3）、就地追问与选区窗口字段简化（H4 其余部分）、父链上下文编排（H5）、节点命名（H6）尚未实施；
- 若修复后仍有个别选区高亮漂移，属 Markdown 渲染偏移问题，另立 issue 排查锚点自愈算法。

### 3.37 阶段 H 并行三切片：父链上下文、弱标记数据与选区引用胶囊（票据 01/04/07，2026-07-30）

**背景**

阶段 H 改按票据制推进（`.scratch/stage-h-tickets/issues/`，9 张票据含依赖声明）。本轮取三张无依赖阻塞票据在隔离 git worktree 中并行开发，各自实现与验证后合入主分支统一验收：票据 01（H5a 父链上下文组装）、票据 04（H3a 概念术语检测与弱标记数据）、票据 07（H4a 选区引用胶囊与双模发送）。

**用户可见结果**

- 选中文字后的旧「选区智能窗口」整体退役：不再触发 AI 选区分析，difficulty / quickReadMinutes / deepStudyMinutes / prerequisites / relationToFocus 等装饰字段不再呈现；
- 取而代之的是输入框旁的轻量引用胶囊（选区文本截取 36 字符 + 移除按钮），键盘可达（Tab 聚焦、Escape 移除）；
- 发送分叉为双模：「在此追问」携带引用选区作为上下文在当前节点对话流发送（就地追问，不产生新结构）；「深入研究这段」以引用选区为来源创建子节点，输入框文字作为可选 query，成功后导航到新子节点；
- `?sel=` 恢复选区时直接呈现引用胶囊（不弹旧面板）；阅读页与节点页均支持双模发送；
- 旧面板「稍后再学」入口随退役暂时移除（后端端点保留，API 层测试保留），新入口由票据 08（用户标记与笔记）提供；
- 父链上下文与术语检测当前对用户不可见，是后续提示词注入（票据 02）、弱标记渲染（票据 05）与悬停生长（票据 06）的地基。

**工程结果**

- H5a：新增 `ParentChainContextService`（`apps/api/src/parent-chain-context.ts`）——从任意节点沿 `parentNodeId` 上溯到根，收集每个祖先的有界上下文（标签：根取会话标题、子节点取来源选区摘要或首条用户消息；来源选区引用文本；首条用户消息摘要）；三层边界（maxAncestors=20、perAncestorCharacters=200、totalCharacters=2000，均可配置）；visited 集合检测环路、安全截断并标记 `cycleDetected`；依赖最小只读 store 接口（4 个方法），未新增迁移，未修改现有研究生成 prompt；
- H3a：契约包末尾追加 `TermCategory` / `TermMarker` / `TermDetectionResult`（text + blockOrdinal + startOffset/endOffset + category，与 `deriveMessageBlocks()` 块契约严格对齐）；新增 `TermDetectionService`（`apps/api/src/term-detection.ts`）——确定性规则检测（括号缩写、带 45 词停用词集的全大写词、camelCase/PascalCase），`validateTermMarkers()` 逐条校验偏移、非法条目丢弃而非整体失败；按消息内存缓存（重启后重检结果一致）；短于 20 字符的消息不触发；检测异常静默降级为空术语列表；
- H4a：新增 `SelectionCapsule.tsx` 与 `useSelectionCitation.ts`（引用生命周期：幂等去重创建、移除、清理）；`SelectionSurface` 改为回调模式不再渲染面板；`selectionIdempotencyKey` / `selectionExactDigest` 迁入 `selection-highlight.ts`；`ChatComposer` 增加 `citedSelection` / `onRemoveCitation` / `onStartChildNode` props 与双模按钮；删除 `SelectionInsightPanel.tsx` 及其测试；`selection-capture.ts` 锚点与自愈机制未扰动；后端零改动（两种发送模式分别复用现有节点消息提交与 POST `/v1/research-selections/:id/nodes`）。

**关键提交**

- 票据 04（契约术语类型 + 确定性检测服务）：`aba0ddc`（worktree 原始提交 `75ddf10`）；
- 票据 01（父链上下文组装服务）：`aab1d68`（worktree 原始提交 `4bb9596`）；
- 票据 07（选区引用胶囊与双模发送，旧面板退役）：`98ed8b4`（worktree 原始提交 `061db96`）；
- 并行分支在 `apps/api/src/service.ts` 的三处同位置追加（import / 属性 / 构造器注册）合并时解决，两个新服务注册并列保留。

**验证**

- 验证级别：四级（共享契约改动 + 跨切片集成 + e2e）；
- 各通道独立验证：票据 01 三级通过（新增 12/12 + 回归 49/49）；票据 04 四级通过（Node 全量 290/290，含新增 28 项）；票据 07 二级 + e2e 通过（vitest 238/238、Playwright 46 通过 + 2 暂停）；
- 合并后四级：全量构建通过；Node 全量测试 302/302；WebUI 客户端测试 238/238（27 个文件）；Playwright e2e 46/46 通过（chromium 43 + chromium-nomodel 3），2 项暂停（旧面板「稍后再学」入口相关，已标注「H4a 后暂停，待票据 08 恢复入口」）；
- 项目检查脚本本轮不可用（路径缺失），已跳过。（2026-07-31 收尾复核更正：脚本实际位于 `scripts/check-project.ps1`，此前报告的路径有误；补跑结果为通过，见 §5 基线。）

**未完成 / 风险**

- 「稍后再学」UI 入口暂缺（待票据 08）；`selection-events` 事件流客户端暂无组件引用但保留；
- 胶囊在极窄视口未单独优化布局；「在此追问」以 `> 选区文本\n\n问题` 内嵌消息正文，后端不感知引用结构，后续如需结构化引用需扩展消息或提交契约；
- 术语检测对无英文标记的纯中文术语覆盖有限（确定性规则取舍；契约对检测来源中立，未来可升级模型方案）；
- 父链上下文尚未注入研究提示词（票据 02）、内容收敛（票据 03）、弱标记渲染（票据 05）、悬停生长（票据 06）、用户标记（票据 08）、节点命名（票据 09）待实施；票据 02/05/08/09 的前置依赖已随本轮完成解除。

### 3.38 选区交互修订一·A：浮动胶囊与引用闭环（issue #9，2026-07-31）

**背景**

H4a（§3.37）的"输入框区域引用胶囊 + 选中即自动引用"设计在真实使用中形成死循环：选中文字后引用胶囊出现在输入框区域，用户点击输入框准备提问时浏览器原生选区坍缩，捕获层随之上报"选区清除"并清空引用态——"选中 → 想提问 → 引用没了"循环往复。用户确认新交互方向（issue #7 修订版规格），选区交互按修订一（issues #9/#10/#11，严格串行依赖）与修订二（issues #8/#12/#13）推进；本轮完成修订一·A（issue #9），修订一内部无可并行空间，按依赖链顺序开发。

**用户可见结果**

- 选中任意达标文字后，浮动操作胶囊出现在选区正上方（上方空间不足时翻转至下方，横向钳制在视口内），含【引用】按钮；胶囊随内容滚动，不固定在视口；
- 点击【引用】完成引用：浮动胶囊关闭，输入框区域呈现引用态胶囊（文本截取 + 移除按钮），双模发送（在此追问 / 深入研究这段）行为不变；
- 死循环修复：引用后聚焦输入框、输入文字、原生选区坍缩均不影响引用态——引用与浏览器原生选区完全解耦；
- 取消方式唯一：点击选取文字以外的屏幕区域关闭选区与浮动胶囊；Escape 在任何环节都没有关闭效果（捕获层与引用态胶囊的 Esc 逻辑全部移除）；
- 重新选取另一段文字后浮动胶囊再次出现，引用后输入框引用态更新为新选区；
- `?sel=` 来源返回仍直接呈现引用态胶囊与高亮（浮动胶囊在恢复高亮上呈现由修订一·C 实施）；阅读页与节点页行为一致。

**工程结果**

- 新增 `FloatingSelectionCapsule.tsx`（Portal 挂 body、页面绝对定位、容器 mousedown preventDefault 使点击【引用】不坍缩原生选区、`data-selection-ui` 标记）与纯函数定位模块 `floating-capsule-position.ts`（优先选区上方、空间不足翻转下方、横向以选区中心对齐并钳制视口安全边距、输出叠加滚动量的页面绝对坐标）；
- `SelectionSurface` 废除"达标选区自动上报引用"与 `onSelectionClear` 回调（死循环根源），改为渲染浮动胶囊 + `onCite` 显式回调；引用后以锚点键标记 consumed 隐藏胶囊，选区坍缩后复位允许再次引用；
- `useSelection` 移除 Escape 关闭分支；`useSelectionCitation` 移除"已移除锚点不再重报"守卫（自动上报废除后，显式点击【引用】即用户意图，幂等接口返回既有记录），锚点键抽取为共享的 `selectionAnchorKey`；`SelectionCapsule` 移除 Escape 移除逻辑；
- 两个页面（节点页 / 阅读页）接线改为 `onCite`；后端与共享契约零改动（锚点、自愈、幂等、字数下限均未扰动，字数下限退役属修订一·B）；
- e2e 助手新增 `citeCurrentSelection` / `citeAnswerText`，六个既有 spec（selection-window / z-deep-research / z-node-tree / z-old-route-redirect / z-research-later / no-model / z-acceptance-real）同步改造为显式引用流程。

**关键提交**

- 修订一·A（浮动胶囊与引用闭环，issue #9）：当前切片提交（`feat(web): 选区浮动胶囊与引用闭环`，提交信息含验证证据）。

**验证**

- 验证级别：二级 + 真实浏览器 + e2e（纯前端切片，无共享契约 / 迁移 / 后端改动，按分级验证规则不运行后端全量测试）；
- WebUI 全量客户端测试 255/255 通过（31 个文件；基线 238 + 新增 17：定位纯函数 7、浮动胶囊组件 5、SelectionSurface 状态机 5）；
- 前端类型检查与生产构建通过；
- Playwright 真实 Chromium e2e 48/48 通过（chromium 45 + chromium-nomodel 3）+ 2 项暂停（稍后再学 UI 入口，待修订二替换为标记流程）；新增死循环回归用例（引用后点击输入框输入，引用保持）、点击外部关闭与 Escape 无效用例、重选更新用例；控制台与网络断言干净；
- 项目检查脚本（`scripts/check-project.ps1`）属四级范围，本轮按规则跳过。

**未完成 / 风险**

- 修订一·B（issue #10，最短字符限制全层退役）、修订一·C（issue #11，`?sel=` 恢复后浮动胶囊呈现、窄屏钳制 e2e、键盘焦点回归、过渡动效）依次待实施；
- 修订二（issues #8/#12/#13，【标记】按钮与笔记输入框、标记列表与旧数据迁移）在修订一完成后实施，与浮动胶囊共享同一组件；
- 浮动胶囊的出现 / 消失暂无过渡动效（修订一·C 处理）；极窄视口钳制已有纯函数单测覆盖，真实窄屏 e2e 由修订一·C 补充。

### 3.39 选区交互修订一·B：最短字符限制退役（issue #10，2026-07-31）

**背景**

修订一·A（§3.38）完成后，按 issue 声明的串行依赖实施修订一·B。旧"最短 4 字符"限制与"选区太短"提示对短而有意义的选区（单字术语、符号）构成打扰，用户明确要求取消：任何非空选区都有效。

**用户可见结果**

- 单字选区不再触发任何"选区太短"提示，浮动胶囊直接出现，可完整走通"引用 → 双模发送（在此追问 / 深入研究这段）"；
- 跨段落选择仍只给调整建议（跨块无法锚定，属结构限制而非长度限制）；超长选区（4000 字上限）提示不变；
- 节点页与阅读页行为一致。

**工程结果**

- 契约：`RESEARCH_SELECTION_MIN_CHARACTERS` 常量与 `ResearchSelectionQuality` 的 `too_short` 级别移除；`evaluateSelectionQuality` 语义调整为"非空即有效"（跨块 → 超长 → ok），字数上限（`RESEARCH_SELECTION_MAX_CHARACTERS = 4000`）不变；"非空"的结构保证由 `validateResearchSelectionInput` 的 exact 校验承担（exact 必须为非空的修剪后文本，纯空白被拒绝）——后端创建校验因此自然放宽为非空，服务层无额外质量拒绝逻辑，无迁移；
- UI：`SelectionQualityHint` 退役 too_short 提示分支（保留太长与跨段落）；`SelectionSurface` 不达标分支收敛为跨块 / 超长 / 无锚点；
- 测试同步：契约测试单字 / 三字选区断言改为 ok（纯空白 exact 仍被验证函数拒绝）；捕获层与 SelectionSurface 单测改为单字有效 + 跨块提示；e2e 两个"太短"用例替换为单字选区用例（selection-window 落库验证、selection-capsule 引用 → 在此追问完整发送链路）。

**关键提交**

- 修订一·B（最短字符限制全层退役，issue #10）：当前切片提交（`feat(web,contracts): 最短字符限制退役`，提交信息含验证证据）。

**验证**

- 验证级别：四级（共享契约改动 + 跨端测试同步）；
- 全量构建通过；Node 全量测试 302/302（dist-tests 287 + ralph 脚本 15）；WebUI 客户端测试 256/256（较 §3.38 基线 +1：SelectionSurface 跨块提示用例）；
- Playwright 真实 Chromium e2e 48/48 通过 + 2 项暂停（稍后再学 UI 入口，待修订二）；
- 项目检查脚本 `scripts/check-project.ps1` 通过。

**未完成 / 风险**

- 修订一·C（issue #11）待实施：`?sel=` 恢复后浮动胶囊呈现在高亮上方、窄屏钳制 e2e、键盘焦点回归、胶囊出现 / 消失过渡动效；
- 纯空白选区（仅空格）在捕获层会被评估为 ok，但 exact 修剪后为空的请求会被后端验证函数拒绝——该路径在真实交互中不可达（浏览器折叠选区不触发捕获），未单独设 UI 防护。

### 3.40 选区交互修订一·C：胶囊边界场景与恢复（issue #11，2026-07-31）

**背景**

修订一·A/B（§3.38/§3.39）完成后，按 issue 声明的串行依赖实施修订一收口切片。此前 `?sel=` 来源返回只恢复输入框引用态，浮动胶囊不在恢复高亮上呈现；极窄视口钳制只有纯函数单测、缺端到端证明；引用完成后键盘焦点无处回归，键盘用户无法顺畅接续"引用 → 输入问题"；胶囊出现 / 消失没有过渡。

**用户可见结果**

- `?sel=` 恢复后选区高亮呈现，浮动胶囊出现在高亮标记上方；点击【引用】收起恢复胶囊，输入框引用态保持，键盘焦点回归输入框（下一步即输入问题）；
- 恢复后出现新的有效选区时，恢复胶囊自动让位，新选区的浮动胶囊照常呈现（任何时刻只有一个浮动胶囊）；
- 窄屏（320px 宽）：胶囊钳制在视口内、任何情况不溢出；选区上方空间不足时翻转至选区下方；
- 键盘可达：【引用】按钮处于 Tab 序列、可聚焦、Enter 触发引用；Escape 对浮动胶囊仍无任何效果（复验修订一·A 约束）；
- 胶囊出现 / 消失带 120ms 淡入淡出，不突兀闪烁；系统"减弱动效"设置下关闭动画、立即呈现与退出；
- 阅读页与节点页行为一致：实时选区引用与 `?sel=` 恢复均一致（同一组件、同一接线）。

**工程结果**

- `FloatingSelectionCapsule` 新增调用方驱动的淡出：`state="closing"` 播放淡出，动画结束回调 `onExited` 供调用方卸载；减弱动效环境立即退出；240ms 定时器兜底（动画被外部样式覆盖或运行环境缺席时按时间退出）；closing 期间 aria-hidden 并退出 Tab 序列（tabIndex -1）；
- `SelectionSurface` 以 `closingRect` 记录最后位置：胶囊消失（引用 consumed、选区坍缩）时先淡出再卸载；`onSelectionActivity` 在新有效选区出现时通知页面收起恢复胶囊；
- 节点页 / 阅读页：高亮恢复后量取高亮标记视口位置、在其上方渲染恢复浮动胶囊（恢复胶囊【引用】只收起 + 回归焦点，引用态已由恢复流程从已存记录创建）；`selection-highlight` 新增 `focusComposerTextarea`，实时引用与恢复引用完成后统一回归输入框焦点；
- 样式：`.floating-capsule` 淡入 / 淡出动画与 `prefers-reduced-motion` 媒体查询；
- 测试基建：新增 `src/test/jsdom-shims.ts` 并置于 vitest setupFiles 首位——jsdom 缺 `AnimationEvent` 构造器，react-dom 首次求值时据此删除标准 `animation` 前缀条目，而 jsdom 的 CSSStyleDeclaration 恰好报告 `WebkitAnimation` 存在，React 遂以 `webkitAnimationEnd` 之名注册监听，测试中 onAnimationEnd 永不触发；补齐先于一切 react 相关 import 执行后走标准事件名路径（真实浏览器原生具备，不受影响）；
- 测试：单测新增 4 项（260/260；胶囊 closing 淡出与 open 状态不误退出、SelectionSurface 坍缩淡出与选区活动通知），定位纯函数 7 项不变；e2e 新增 5 项：节点页 `?sel=` 恢复浮动胶囊位置 + 焦点回归 + 新选区切换、浮动胶囊键盘可达、320×568 视口钳制、320×240 上方空间不足翻转、阅读页 `?sel=` 恢复一致。

**关键提交**

- 修订一·C（胶囊边界场景与恢复，issue #11）：`236d2fb`（`feat(web): 胶囊边界场景与恢复`，提交信息含验证证据）。

**验证**

- 验证级别：二级 + 真实浏览器 + e2e（纯前端切片，无共享契约 / 迁移 / 后端改动；e2e 依赖 apps/web 生产构建，改动后重建 dist 再执行）；
- WebUI 全量客户端测试 260/260 通过；前端类型检查与生产构建通过；
- Playwright 真实 Chromium e2e 全量 53/53 通过（chromium 50 + chromium-nomodel 3，较修订一·B 基线 +5）+ 2 项暂停（稍后再学 UI 入口，待修订二替换为标记流程）；新增用例覆盖 `?sel=` 恢复胶囊位置与让位、窄屏钳制与翻转、键盘焦点回归、阅读页一致；控制台与网络断言干净；
- 项目检查脚本（`scripts/check-project.ps1`）属四级范围，本轮按规则跳过（无契约 / 迁移 / 构建配置改动）。

**未完成 / 风险**

- 修订一（A/B/C）全部完成；修订二（issues #8/#12/#13：【标记】按钮与【引用】共用浮动胶囊、笔记输入框、标记列表与返回原文、旧"稍后再学"数据迁移）已完成；
- 2 项暂停 e2e（稍后再学 UI 入口）由修订二·D/E 的标记流程替换，确定性标记列表与无模型返回路径已定向复跑通过。

### 3.41 修订二·E：标记列表与原文返回（issue #13，2026-07-31）

**背景**

修订二·D（issue #12，`e26c6fa`）已经让用户可以从选区胶囊立即保存标记并填写笔记。本轮继续实施 issue #13，把标记变成可返回、可恢复的完整用户路径；旧 `research_later_items` 表和接口继续作为兼容底座，不让已有数据失效。

**用户可见结果**

- 右侧“标记”列表展示选区原文截取、用户笔记、来源节点和创建时间；没有笔记的旧项目显示“未添加笔记”，不再呈现星级、AI 概括和待学 / 完成切换；
- 点击标记项目返回消息所属节点或导入文档阅读页的 `?sel=<selectionId>`，按稳定锚点恢复原文高亮；锚点失效时保留原有自愈与来源位置降级提示；
- 返回后默认只显示高亮上方的浮动胶囊，不自动创建引用；用户明确点击【引用】才进入引用态，点击【标记】可继续打开既有笔记；
- 标记列表在保存、刷新和服务重启后保持一致，完整路径不依赖模型；同一选区兼容旧 `later:<selectionId>` 与新 `mark:<selectionId>` 幂等键，不重复创建。

**工程结果**

- 共享契约新增 `ResearchLaterSourceNode`，列表视图同时返回来源节点；SQLite 标记记录补齐当前 `nodeId`，服务通过根节点标题、子节点来源选区或首条用户消息生成稳定来源标签；
- `ResearchLaterService` 按 `selectionId` 兼容旧 / 新幂等键，保留旧 priority / summary / status 字段供旧接口和数据读取；JsonStore 保留明确的空实现，SQLite 为正式持久化路径；
- `LaterPanel` 收敛为“标记”语义，保存事件触发列表刷新；节点页和阅读页都移除 `?sel=` 的自动引用副作用，并把恢复胶囊的【引用】和【标记】接回显式动作；
- 确定性与无模型 e2e 流程替换原暂停的稍后再学 UI 流程，覆盖列表展示、来源节点、返回高亮、恢复后不自动引用和刷新保持。

**关键提交**

- 修订二·D（issue #12，标记按钮与笔记输入框）：`e26c6fa`；
- 修订二·E（issue #13，标记列表与原文返回）：`18f93d4`。

**验证**

- 验证级别：四级（共享契约、SQLite 持久化 / 兼容、跨端 HTTP 与 WebUI 用户路径）；
- 全量构建通过；`dist-tests` Node 测试 290/290 通过；issue13 相关后端定向测试 27/27 通过；WebUI 测试 278/278 通过；
- Playwright 真实 Chromium 全量用例体首轮执行 57 项，其中 55 项通过；修正两个测试定位断言后，issue13 新增的确定性标记列表返回和无模型标记返回用例定向复跑通过。Windows 下 Playwright webServer 收尾未自然退出，测试命令因此没有输出最终汇总；页面流程本身已完成；
- 截至该提交，真实模型验收用例未执行：当时环境没有可用的 AI API Key；后续复核结果见 §3.42。

**未完成 / 风险**

- Windows Playwright webServer 的进程树收尾仍可能在用例完成后挂起，需要后续单独处理测试基础设施；不影响本轮页面和 API 用例结果；
- 自动提醒 / 弱重现仍是后续候选，不属于 issue13；标记删除、批量操作、标签和独立笔记编辑仍不在当前范围。

### 3.42 Issue 13 收尾复核与真实模型验收（2026-07-31）

**复核范围**

- 本次复核不改动 Issue 13 功能代码，核对当前分支 `mvp/fast-validation` 的源码、稳定真实模型配置、真实服务和可见浏览器行为；功能实现提交为 `18f93d4`。
- 真实模型验收 harness 未提供临时环境变量，复用本机持久化的 DeepSeek `deepseek-v4-flash` 配置，并为验收使用隔离的临时数据目录；API Key 未写入源码、Git、日志或本记录。
- Chrome DevTools MCP 连接的是用户重启后的可见 Chrome，不是无头浏览器；隔离服务和临时数据在复核后已停止并清理。

**用户可见结果**

- 真实回答生成、模型状态、单字选区、浮动胶囊、明确引用、标记立即保存、笔记保存、标记列表、来源节点、`?sel=` 返回高亮、刷新恢复、深入研究、在此追问和节点树键盘导航均已走通。
- 设置页显示持久化并启用的 `deepseek-v4-flash`；窄屏开始页检查无明显横向溢出；已退役的“AI 分析”“稍后再学”等入口未在当前 DOM 中出现。

**验证证据**

- `npm.cmd run build` 通过；真实模型 Playwright 套件 4 个场景中场景二通过，场景一、三、四均在 `selectRealAnswerText` 自动化选区辅助函数阶段报“找不到足够长的可选文字”。失败截图中实际存在较长真实回答，人工可见浏览器同类选区已成功，因此该结果暂按“测试辅助函数与真实回答 DOM 形态兼容性待修复”记录，不按 API Key 或功能缺失判定。
- 可见 Chrome 控制台没有错误或警告；网络请求主要为 200。一次探索中的零长度选区产生 400，随后合法选区成功 201，第二轮未复现，暂不确认产品缺陷。
- Lighthouse 快照：Accessibility 98、Best Practices 100、Agentic Browsing 100；另有标题层级和缺少 meta description 两项审计提示，均不阻断 Issue 13 主流程。
- `npm.cmd test` 已执行并观察到相关 Node / WebUI / 持久化 / 导入 / 标记 / 研究恢复测试通过，但测试进程未返回最终统计，因遗留子进程挂起而停止；因此不能把本次运行记为“全量测试最终通过”。
- 可见 MCP 的文件上传受其文件沙箱限制，未完成手动导入动作；文档导入的自动化场景二和导入集成测试通过，未上传私人文档。

**未完成 / 风险**

- `apps/web/e2e/z-acceptance-real.spec.ts` 的真实回答选区辅助函数需要兼容当前真实回答 DOM 后再重跑 3 个失败场景；在修复前不宣称真实模型 Playwright 四场景全通过。
- Windows 下全量测试和 Playwright webServer 的进程树收尾仍可能挂起；不影响本次已观察到的页面结果，但需要单独处理测试基础设施。
- Lighthouse 的标题层级和 meta description 提示属于独立质量改进项，不属于 Issue 13 当前范围。

### 3.43 阶段 H/E 并行切片：父链注入、弱标记渲染、节点命名、逐次联网授权与本地运行记录（issues #15–#19，2026-07-31）

**用户可见结果**

- 研究节点的后续提问和从选区生长的首轮回答会携带有界的父链上下文，深层节点能够保留祖先主题、来源选区和当前路径；根节点、循环父链和超预算内容安全降级。
- 完成的 AI 回答会显示低注意力的术语内联弱标记，正文文字、手动选区、引用定位和原文返回不被标记结构扰动。
- 节点首条有效内容完成后可异步生成简洁名称；名称生成失败、无模型或输出无效时继续使用确定性名称，不阻塞进入节点和继续提问。
- Chat、研究节点、分支追问和文档阅读页的输入框提供默认关闭的“允许联网搜索”开关。每次提交保存本次选择；关闭时明确记录“未请求联网”且不产生搜索运行，开启时只展示实际获得的来源，供应商不支持或搜索失败时显示诚实状态。
- 主界面提供本地运行记录查看器，可按操作和关联任务查看模型、搜索、耗时、重试、错误和脱敏摘要；记录只从本机读取。

**实际改动与接口 / 数据变化**

- `ResearchTaskRecord`、研究消息提交、深度研究输入和子节点输入增加可选 `allowWebSearch`，服务端将每次选择保存到任务记录；旧任务按关闭处理，不新增 SQLite 表迁移。
- 研究生成服务在关闭时跳过原生联网和 Agent 搜索，在开启时记录真实 grounding 结果或 `grounding_unsupported` / `grounding_failed` 状态；HTTP、客户端 API、开始页、节点页和阅读页统一传递逐次选择。
- `TurnSubmitter` 在网络失败重试时沿用首次联网选择和幂等键，避免用户在重试前改变控件导致语义漂移。
- 父链上下文注入、H3b 术语渲染和 H6 名称回退分别由提交 `104e704`、`9aa6e63`、`7964807` 交付；H6 树标签回退兼容修复和逐次联网授权、界面、测试及文档同步收口于提交 `e5125f4`；本地运行记录查看器由提交 `4976ee0` 交付。

**验证证据**

- 本切片按四级风险选择验证：共享契约、后端任务持久化、HTTP 和用户可见入口发生跨端变化。
- `npm.cmd run build` 通过；受影响 Node 测试 23/23 通过；受影响 WebUI 测试 48/48 通过，联网重试新增测试 21/21 通过；确定性 Playwright Chromium 测试 `web-search-toggle.spec.ts` 2/2 通过，覆盖关闭和开启两条路径且不访问真实网站。
- Chrome DevTools MCP 在本轮连接返回 `Transport closed`，因此未执行人类拟真验收；按项目约定使用 Playwright 确定性浏览器验证替代。未触发“进行一次人类拟真测试”。
- 全量 `npm.cmd test` 已启动并观察到构建及前序测试持续通过，但 Windows 测试进程在本轮记录时仍未返回最终汇总，不能将其记为全量最终通过；相关进程收尾属于既有测试基础设施限制。

**未完成项与风险**

- H3c 悬停预览与点击生长、H5c 深层内容收敛和本地轨迹脱敏导出（issues #20–#22）因本轮前置票据已完成，现已解锁并交由下一批并行子代理实施；不将其提前记为已完成。
- 当前已配置供应商仍不支持原生联网，真实供应商联网验收保持停止；开启开关的确定性路径已覆盖不支持状态和无伪造来源。
- Vite 仍提示主 bundle 超过 500 kB；该提示未阻断构建，作为独立性能改进项保留。

### 3.44 阶段 H 后续收口：深层内容收敛与本地轨迹脱敏导出（issues #21/#22，2026-08-01）

**用户可见结果**

- 深层研究回答根据节点深度和内容长度进入完整、降密度或停止弱标记阶段；短内容即使处于深层也保留完整标记，刷新后按相同输入得到稳定结果。
- 本地运行记录页面支持导出当前筛选结果。导出为带格式版本、筛选条件和完整性尾行的 NDJSON 文件；服务端分页读取并统一脱敏，空筛选结果不生成空文件，浏览器仅触发本机下载。
- 运行记录错误按认证、网络、输入校验、模型服务、联网搜索、本地存储和其他分类展示，便于用户理解失败原因。

**实际改动与接口 / 数据变化**

- 共享契约新增 `ResearchConvergenceBounds` / `ResearchConvergenceDecision`、术语收敛结果字段、运行记录错误分类和导出行格式；不新增数据库迁移，历史轨迹继续通过现有读取与脱敏链路呈现。
- 术语检测服务按当前节点深度计算确定性收敛决策并从候选列表中稳定抽样；父链提示在收敛深度增加时注入“减少新概念 / 严格收敛”的回答引导。
- 新增 `GET /v1/run-records/export`，复用运行记录筛选和游标读取，响应为 `application/x-ndjson`；客户端和运行记录页面增加导出按钮、完成/空结果/失败状态。

**验证证据**

- `npm.cmd run build` 通过（Vite 仅保留主 bundle 超过 500 kB 的既有提示）。
- 受影响 Node 测试 27/27 通过，覆盖 H5c 阈值、父链提示、术语收敛、研究回归和运行记录 API / 导出脱敏 / 空结果。
- 受影响 WebUI 测试 16/16 通过，覆盖导出成功、空结果不创建文件、弱标记和联网重试回归。
- 确定性 Playwright Chromium 导出场景 1/1 通过；Windows Playwright webServer 收尾仍可能挂起，已按 PID 停止本轮残留服务进程。未执行人类拟真测试。

**未完成项与风险**

- H3c 悬停流式预览、一次生成复用和点击生长（issue #20）本轮子代理未产生实际代码或提交，仍是当前阶段唯一未完成的 H3 切片。
- GitHub 票据关闭同步被连接器返回 403，且本机 `gh auth status` 显示令牌失效；本地提交与记录已完成，但远端 #15–#19 的关闭状态未能自动更新。

### 3.45 阶段 H3c：悬停流式预览、一次生成复用与点击生长（issue #20，2026-08-01）

**用户可见结果**

- 完成回答中的术语弱标记在鼠标悬停约 400ms 后开始生成解释，弹层展示逐步到达的内容；鼠标移开只关闭弹层，后台任务继续运行，再次打开可恢复当前进度或最终内容。
- 同一节点中的同一术语只生成一次；点击术语或按 Enter / Space 后创建子节点，子节点首条 AI 内容与预览完全一致，并保留父节点、消息和选区来源关系。
- 术语弹层支持键盘聚焦、Escape 关闭、窄屏视口钳制和 `prefers-reduced-motion`；模型未配置或生成失败时保留已生成内容并提供重试，不丢失术语与来源关系。

**实际改动与接口 / 数据变化**

- 共享契约新增 `ResearchTermPreviewRecord`、错误类型和 `snapshot` / `delta` / `completed` / `failed` 事件；SQLite 迁移 v27 新增 `research_term_previews` 与 `research_term_preview_events`，记录任务、流式内容、关联选区和恢复状态。
- 后端新增术语预览任务服务、任务查询 / SSE / 重试接口，以及从已完成预览创建子节点的接口；提示词包含当前回答、当前术语、来源上下文和有界父链，预览生成不请求联网搜索。
- WebUI 新增 SSE 客户端、术语预览状态钩子和消息交互弹层；Markdown 术语标记补充可访问的键盘语义，子节点导航复用既有研究节点路径。
- 新增 API / 持久化 / 重启恢复测试、WebUI 交互测试和窄屏 Playwright 场景；迁移测试夹具同步覆盖 v27 回退与重放。

**验证证据**

- 选择四级验证范围：共享契约、SQLite 迁移、后台任务恢复、HTTP / SSE 和用户可见 WebUI 同时变化。
- `npm.cmd run build` 通过；完整 WebUI 测试 34 个文件、286 个测试通过；Issue #20 Node 测试 2/2 通过，迁移兼容测试 9/9 通过。
- 确定性 Playwright Chromium：Issue #20 窄屏场景 1/1 通过，覆盖悬停启动、离开后继续、重新打开恢复、重复悬停不重复生成、点击生长和预览原文复用；H3b 术语标记回归场景 1/1 通过。
- 构建保留 Vite 主 bundle 超过 500 kB 的既有提示。完整 Node 测试已执行并观察到新增与既有断言均通过，但 Windows 测试运行器在最终汇总前因既有未关闭句柄不退出，未将该次记为“完整汇总通过”；迁移、Issue #20 受影响测试和 WebUI 全量已单独复验通过。
- 未执行 Chrome DevTools MCP 人类拟真测试；本轮未触发用户指定的“进行一次人类拟真测试”。真实供应商验收继续按现有配置限制保持停止。

**未完成项与风险**

- Windows 下 Playwright webServer 和 Node 全量测试的进程收尾仍可能挂起；本轮已按端口 / 精确 PID 清理本轮残留进程，不影响已观察到的测试结果。
- Vite bundle 体积提示属于独立性能改进项，不阻断 Issue #20 功能交付。
- 相关实现提交：本轮实现提交（见 Git 历史最新提交）。

### 3.46 阶段 I 启动：类型化边图投影与语义切片（issues #24/#25，2026-08-02）

**用户可见结果**

- 全屏导航在既有节点树之外新增“关系列表”视图（顶栏按钮或快捷键 `g` 唤出）：当前会话的研究节点按关系类型分组呈现（父子关系、语义相关、融合来源），全部操作可纯键盘完成（↑↓/Home/End/Enter/Escape），屏幕阅读器获得等价语义；既有节点树（快捷键 `t`）保持不变。
- 节点内容在底层获得切片结构，但用户读到的仍是一篇连续长文：旧节点在首次打开时按既有段落边界惰性补齐临时切片，不重写历史；切片之间仅以细微分隔线提示边界，不做卡片碎片化改版。
- 选区与引用在切片化内容上保持可用：切片边界是装饰性元素，不进入可读文本投影，选区锚点与自愈未受扰动。

**实际改动与接口 / 数据变化**

- 共享契约新增类型化边模型（`ResearchEdgeKind`、`ResearchEdgeRecord`、`ResearchGraphProjection` / `ResearchGraphNodeSummary`）与纯函数 `deriveParentChildEdges` / `buildGraphProjection`（BFS 逐层外扩，成环 / 缺失节点 / 多根安全降级）、`researchEdgeId`；新增语义切片模型（`ResearchSliceRecord`）、`validateSliceSchema`、`deriveProvisionalSlices`（复用 `deriveMessageBlocks()` 段落边界，确定性幂等），`ResearchNodeView` 增加可选 `slices`。
- SQLite 迁移 v28 新建 `research_edges`（record_json + `UNIQUE(kind, from_node_id, to_node_id)` 幂等 + 三个状态索引），并从既有 `research_nodes.parentNodeId` 确定性派生父子边；迁移 v29 新建 `research_slices`（record_json + `UNIQUE(node_id, ordinal)` + node/message 双索引）。
- 后端：`CollectorStore` 新增边与切片 CRUD；创建子节点 / 分支事务内自动建立父子边，`clearAllData` 先删边再删节点；`NodeGrowthService.getGraphProjection` 提供单一图投影；新增 `GET /v1/research-sessions/:id/graph` 端点；`getResearchNodeView` 异步化并在首次访问惰性生成临时切片。
- WebUI：新增 `RelationshipList` 覆盖层与 `useRelationships` 钩子并接入 AppShell（快捷键 `g` + 顶栏按钮）；`MessageItem` 将切片按序号合成为连续长文，保留 `data-block-id` / `data-block-text`，边界为装饰性 `<hr>`（aria-hidden + data-decorative + 空文本 + pointer-events/user-select: none）。

**并行交付与历史整理**

- D1（#24）与 E1（#25）两张无阻塞票据并行实施。因两个实现代理共用同一工作目录，D1 的提交一度连带扫入 E1 的契约与迁移地基。随后做受控历史整理：以已验证的合并状态为基准，将共享文件（契约、store、http、样式、迁移测试）按归属拆回，重建为两笔干净且可独立回滚的提交 `7119700`（D1，v28）与 `bca6605`（E1，v29）；最终代码树与并行完成态一致，仅多出下述测试维护修复。D1 独立通过全量构建后方可提交，确保两笔提交各自可独立回滚。
- 测试维护：添加迁移 v28/v29 后，三个硬编码版本列表的旧迁移回滚测试（migrations 15–21、v24、v28 边迁移）暴露回归——删除版本未覆盖新最高版本，导致重迁移不触发、被删表不重建。已在两笔提交中分别纳入 v28 / v29：回滚时删除 `research_edges` / `research_slices` 并清除对应版本行。并行代理曾把这些失败误判为“预存”，实为添加迁移引入，本轮已修复。

**验证证据**

- 选择四级验证范围：共享契约、SQLite 迁移、跨端集成与用户可见 WebUI 同时变化。
- D1 独立状态：全量构建通过；Node 测试 344/344；WebUI 测试 297/297（35 文件）。
- D1+E1 合并状态：全量构建通过；Node 测试 366/366；WebUI 测试 301/301（35 文件）。
- 确定性 Playwright Chromium e2e：合并状态 56/62 通过。6 个失败经基线对照（检出 `904bfb6` 以同规格复跑，基线为 7 失败）确认全部为预存测试债——在 D1/E1 之前即同样失败，本轮零回归；预存失败集中于节点标签 / 面包屑呈现相关的研究会话、节点树、深入研究、运行记录导出与导入规格，疑似更早 H 阶段节点命名调整后 e2e 断言未同步，另立票据跟踪。
- 未执行 Chrome DevTools MCP 人类拟真测试；本轮未触发用户指定的“进行一次人类拟真测试”。

**未完成项与风险**

- 6 个预存 e2e 失败需单独排查（节点标签 / 面包屑截断与 e2e 断言不一致），不属于 D1/E1 范围。
- D2（#26，网状画布视图，依赖 D1）、E2（#27，切片感知生成，依赖 E1）、F1（#29，相似性检测与弱提示，依赖 E1）随 D1/E1 完成解除阻塞，可进入下一轮并行；F 系列最终仍依赖 D 与 E 全部完成。
- 相关实现提交：`7119700`（D1，迁移 v28）、`bca6605`（E1，迁移 v29）。

**下一步交接语**

- 已解除阻塞、可进入下一轮并行的票据：D2（#26）、E2（#27）、E3（#28，Blocked by 只有 #25/E1，虽处于 E1→E2→E3 叙事链但实际不依赖 E2）、F1（#29）。仍被挡：D3（#30←D2）、F2（#31←F1+D1+E2）、F3（#32←F2）。
- 推荐下一波并行 D2 + E2 + F1（画布前端 / 生成后端 / 相似性子系统，触及区域基本不相交）；E3 排在 E2 之后——既避开与 E2 同改切片/生成后端和 `service.ts` 的文件重叠，又能用上 E2 的原生切片（比 E1 临时切片粒度更好）。
- 关键教训：本轮 D1/E1 因两个实现代理共用同一工作目录，导致提交互相污染、需事后受控拆分。**下一轮并行必须使用隔离 worktree（或确保各票据文件不相交）**，并为并行迁移预分配版本号（D2 若加迁移用 v30 起），避免重演。
- 6 个预存 e2e 失败（issue #33，节点标签/面包屑截断与断言不一致）与阶段 I 无关，可在下一轮前或并行修复。

### 3.47 阶段 I 下一轮：网状画布、切片感知生成、相似性弱提示与上下文组装（issues #26/#27/#28/#29，2026-08-02）

**用户可见结果**

- 桌面端在关系列表之外提供网状画布入口：从当前节点和直接邻居开始，用户可以逐层展开关系、拖拽平移、滚轮或按键缩放、聚焦邻居、打开节点并回到当前节点；父子、语义相关和融合来源使用线型 / 形状与颜色的冗余编码。窄屏继续使用关系列表，Escape 关闭画布后焦点返回触发入口，减弱动效设置下不依赖过渡动画。
- 新生成回答在底层获得正式语义切片，但阅读界面仍保持连续长文。模型输出经过结构化校验和有界修复；修复耗尽时任务可重试且半有效内容不进入用户可见回答。运行记录显示本轮生成的切片数量。
- 节点之间出现相似性弱提示时，用户可以查看简短理由并接受或拒绝。接受只建立语义相关边，不创建融合节点；拒绝进入确定性冷却，同一节点对在刷新和服务重启后不会重复提示。
- 节点内追问、深入研究首轮和联网 Agent 生成都会获得同一份切片感知上下文：当前问题保留为最新用户消息，历史助手回答以当前节点及父链切片进入上下文，正式切片优先，旧消息以临时切片兜底；切片按相关性与节点来源稳定排序，在独立预算内整片装入，不截断单片。

**实际改动与接口 / 数据变化**

- D2 新增桌面网状画布覆盖层与交互状态 hook，复用 D1 图投影和既有关系列表；新增全屏入口、键盘快捷键、窄屏回落、焦点回归、减弱动效和边类型视觉编码。D2 不新增数据库迁移。
- E2 在 capture contracts、model gateway 和 research service 中增加原生切片生成契约与 `RESEARCH_SLICE_PROMPT_VERSION`；服务端统一分配切片 / 消息 / 节点身份，执行安全 JSON 解析、`validateSliceSchema` 和最多两次有界修复，并将正式切片写入既有 `research_slices`。运行记录补充 `sliceCount`。
- F1 新增 `research_fusion_proposals` 持久化表（迁移 v30）、关系类型与提议契约、确定性候选扫描、模型关系核验、列表和决策端点。提议支持 pending / accepted / rejected 生命周期、唯一节点对、接受后 `semantic-related` 边、拒绝冷却与重启幂等；`unrelated` 不呈现为可操作提议。
- E3 新增 `ResearchSliceContext` / `ResearchSliceContextItem` 契约和 `buildResearchSliceContext` 预算器。上下文保留切片身份、节点 / 消息身份、序号、来源引用、规范化概念、临时标记和父链距离；当前 token 预算独立于既有父链预算，`fusionSignals` 保留为空供 F2 接入。普通原生生成、深入研究原生生成、联网 Agent 及旧流式兼容路径统一传递该上下文。
- 阶段实现提交：`e3820a6`（E2）、`605e0bb`（F1，迁移 v30）、`d3d6fd0` 与 `55ceec4`（D2 及 Escape 回归修复）、`0b9dce8`（E3）。

**验证证据**

- 选择四级验证范围：本轮包含共享生成契约、迁移 v30、后台任务与模型网关、HTTP / WebUI 跨端接入，以及 D2 用户可见交互；E3 还改变了普通追问、深入研究和联网 Agent 的共同上下文边界。
- `npm run build` 通过；WebUI 全量测试 37 个文件、311/311 通过。
- E3 定向 Node 测试 20/20 通过，研究链路定向测试 20/20 通过。
- Node 全量测试首次汇总为 390 项中 389 通过、1 项失败；唯一失败为 Windows 并发临时目录清理的 `EBUSY`（`research-term-preview.test.js`），顺序单独复跑该文件为 2/2 通过，确认不是业务断言失败。
- 确定性 Playwright Chromium 定向回归 3/3 通过：节点生长与带方向生长路径覆盖子节点视图、来源返回、高亮、刷新保持和节点内追问；网状画布路径覆盖桌面画布、Escape 返回入口和窄屏关系列表回落。未执行 Chrome DevTools MCP 人类拟真测试，原因是本轮未触发用户指定的“进行一次人类拟真测试”。

**未完成项与风险**

- D3（#30）仍负责画布交互收口与按边类型筛选；F2（#31）仍负责确认式融合节点，F3（#32）仍负责自动融合模式。本轮 F1 只建立相似性提议和语义关系边，不提前实现融合节点。
- Windows 测试运行器在并发临时目录清理时仍可能出现句柄竞争；受影响测试顺序复跑通过，后续可独立改善测试清理，不阻断本轮功能。
- 真实供应商联网验收与 Chrome DevTools MCP 人类拟真测试均未执行：前者遵循阶段 E 已停止的当前约定，后者需用户主动触发。

**下一步交接语**

- 已完成并关闭：D2（#26）、E2（#27）、E3（#28）、F1（#29）；#33 的 6 个预存 e2e 失败已在阶段前修复并关闭。
- 当前仍待推进：D3（#30，依赖 D2）、F2（#31，依赖 F1 / D1 / E2）、F3（#32，依赖 F2）。推荐下一轮先推进 D3 与 F2 的边界设计和实现，再根据 F2 的融合节点契约安排 F3。
- 本轮没有新增 E3 数据库迁移；F1 独占迁移 v30，E2 / D2 / E3 均复用既有持久化结构。

## 8. 文档整理记录

2026-07-20，项目文档改按产品与工程里程碑、关键提交、验证证据和遗留限制组织；当前状态由本文、MVP 开发指导、产品与架构文档、源码和测试共同表达，详细变更可通过 Git 历史和本文列出的提交追溯。
