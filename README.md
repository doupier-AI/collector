# Collector

Collector 是一个双入口知识采集 MVP：

- Chromium 扩展用于网页选区和整页链接采集；
- Windows Electron 悬浮窗用于手动粘贴文本、链接和拖放文件；
- 本地 API 统一处理 SQLite 持久化、来源解析、幂等去重、价值预检、模型抽取、审核提案和正式知识关系。

采集内容只进入 Capture Inbox，不会自动修改已有知识关系。

## 环境

- Node.js 24+
- npm 11+
- Windows 10/11（桌面悬浮窗）

## 安装与验证

```powershell
$env:ELECTRON_SKIP_BINARY_DOWNLOAD='1'
npm.cmd install --cache .npm-cache
npm.cmd test
npm.cmd run test:gui
```

跳过 Electron 二进制只适用于编译和测试。运行桌面端前，需要正常安装 Electron 二进制：

```powershell
npm.cmd rebuild electron
```

`test:gui` 使用隔离端口、用户目录和 SQLite 数据库，验证 Renderer、Preload、IPC、文本采集和文件上传。当前受管 Codex Windows 环境的 Chromium process sandbox 会使自动化 Renderer 崩溃，因此 smoke 子进程使用 `--no-sandbox`；正常桌面启动不使用该参数，窗口仍显式启用 sandbox、`contextIsolation` 和 CSP。

## 启动 API

```powershell
npm.cmd run dev:api
```

默认监听 `http://127.0.0.1:43110`，SQLite 数据和 Artifact 保存在 `.collector-data/`。首次启动会把旧 `store.json` 事务迁移到 `collector.sqlite`，成功后保留只读备份。可通过 `COLLECTOR_PORT` 和 `COLLECTOR_DATA_DIR` 修改。

正常使用桌面悬浮窗时不需要单独启动 API：Electron 会检测本地服务，并在服务不存在时自动启动嵌入式 API。

## 查看知识收件箱

通过 Collector 托盘菜单选择“打开知识收件箱”。工作台使用一次性配对码建立 HttpOnly 本地会话，不再允许任意网页直接访问数据接口。

```text
http://127.0.0.1:43110/
```

也可以右击 Collector 系统托盘图标，选择“打开知识收件箱”。页面展示采集正文、Fragment 定位、来源证据、DeepSeek 运行记录、成本和关系建议，并支持接受、拒绝、暂缓及撤销。主题页支持创建、重命名、归档和成员管理。

## 加载浏览器扩展

1. 运行 `npm.cmd run build`。
2. 打开 Chromium 扩展管理页并启用开发者模式。
3. 选择“加载已解压的扩展程序”。
4. 选择 `apps/browser-extension/build`。
5. 从 Collector 托盘选择“浏览器扩展配对”，再点击扩展图标输入六位配对码。
6. 在网页选中文字后右击“收集到知识库”，或在空白处右击“收集当前网页”。

API 不可用时，扩展将请求保存在 `chrome.storage.local`，并按分钟重试。相同 `clientCaptureId` 不会产生重复 Capture。

## 启动桌面悬浮窗

```powershell
npm.cmd run dev:desktop
```

默认快捷键为 `Ctrl+Shift+Space`。悬浮窗不会读取或监听剪贴板；用户需手动粘贴。支持拖放 TXT、Markdown、PDF、PNG、JPEG 和 WebP，单文件最大 20 MiB。

文件区域也可以直接点击打开系统文件选择器。提交成功后，文本或文件记录会出现在知识收件箱页面。

TXT 和 Markdown 按稳定行号生成 Fragment；文本 PDF 按页生成 Fragment。图片和扫描 PDF 只保存为 Artifact，不执行 OCR。

## DeepSeek 设置

在桌面悬浮窗的 AI 设置区输入新生成的 DeepSeek Key，并明确勾选云端处理授权。Key 通过受限 IPC 交给 Electron Main Process，并使用 `safeStorage` 加密保存；SQLite 只记录授权和配置状态。

标准抽取显式关闭思考模式，默认使用 `deepseek-v4-flash`。每条 Capture 可关闭 AI，此时仍会执行本地解析，但不会发送内容到云端。模型任务先持久化为 `queued AgentRun`，采集请求不会等待网络模型；后台执行后更新为 `succeeded` 或 `failed`，应用重启会恢复未完成任务。工作台可将带 Fragment 证据的 AI 主题建议显式创建为 Topic。`deepseek-v4-pro` 只通过单条 Capture 的“Run deep analysis (L3)”按钮显式触发，不会自动运行。开发和 CI 使用 Fake Provider，不需要真实 Key。

不要使用曾粘贴到聊天、日志或源码中的 Key。当前仓库不会读取或保存之前暴露的 Key。

## API

```text
GET  /health
POST /v1/artifacts
POST /v1/captures/preflight
POST /v1/captures
GET  /v1/captures/{id}
POST /v1/captures/{id}/deep-analysis
GET  /v1/inbox
GET  /
POST /v1/review-proposals/{id}/decision
GET  /v1/relations
POST /v1/relations/{id}/revoke
GET  /v1/topics
POST /v1/topics
POST /v1/topics/{id}
GET  /v1/topics/{id}/workspace
POST /v1/topics/{id}/members/{captureId}
DELETE /v1/topics/{id}/members/{captureId}
```

审核决定支持 `accepted`、`rejected`、`deferred`。接受建议会事务创建版本化正式 Relation 和 UserDecision，但不会覆盖原始 Capture、Fragment 或模型建议；撤销只更新 Relation 状态并追加审计记录。

## 当前边界

- 当前使用 Node 内置 SQLite，面向单用户本地部署；本阶段不引入 PostgreSQL。
- 本地确定性规则产生 `duplicate`、`related`、`independent`；经过本地 Schema 和 Fragment 引用校验的模型提案可表达全部六类关系。
- URL 抓取限制超时、体积和重定向，并阻止本机及私有网段。解析失败会保留 Capture，不会虚构正文或调用模型。
- 数据 API 要求配对 Token 或本地 HttpOnly 会话；健康检查、静态工作台壳和配对交换可以匿名访问。
- Electron 安装包、自动更新和代码签名尚未配置。
- 真实 DeepSeek 验收必须由用户在设置页提供已轮换 Key 并授权；自动化测试不会使用聊天中暴露的凭据。

产品范围见 `docs/PROGRAM_PLAN.md`，当前技术决策与已知偏离见 `docs/ARCHITECTURE.md`。
