# Collector

Collector 是一个双入口知识采集 MVP：

- Chromium 扩展用于网页选区和整页链接采集；
- Windows Electron 悬浮窗用于手动粘贴文本、链接和拖放文件；
- 本地 API 统一处理持久化、幂等、去重、价值预检、证据等级和审核提案。

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
```

跳过 Electron 二进制只适用于编译和测试。运行桌面端前，需要正常安装 Electron 二进制：

```powershell
npm.cmd rebuild electron
```

## 启动 API

```powershell
npm.cmd run dev:api
```

默认监听 `http://127.0.0.1:43110`，数据保存在 `.collector-data/`。可通过 `COLLECTOR_PORT` 和 `COLLECTOR_DATA_DIR` 修改。

正常使用桌面悬浮窗时不需要单独启动 API：Electron 会检测本地服务，并在服务不存在时自动启动嵌入式 API。

## 查看知识收件箱

浏览器打开：

```text
http://127.0.0.1:43110/
```

也可以右击 Collector 系统托盘图标，选择“打开知识收件箱”。页面展示采集正文、来源、证据等级、处理级别和关系建议，并支持接受、拒绝或暂缓建议。

## 加载浏览器扩展

1. 运行 `npm.cmd run build`。
2. 打开 Chromium 扩展管理页并启用开发者模式。
3. 选择“加载已解压的扩展程序”。
4. 选择 `apps/browser-extension/build`。
5. 在网页选中文字后右击“收集到知识库”，或在空白处右击“收集当前网页”。

API 不可用时，扩展将请求保存在 `chrome.storage.local`，并按分钟重试。相同 `clientCaptureId` 不会产生重复 Capture。

## 启动桌面悬浮窗

```powershell
npm.cmd run dev:desktop
```

默认快捷键为 `Ctrl+Shift+Space`。悬浮窗不会读取或监听剪贴板；用户需手动粘贴。支持拖放 TXT、Markdown、PDF、PNG、JPEG 和 WebP，单文件最大 20 MiB。

文件区域也可以直接点击打开系统文件选择器。提交成功后，文本或文件记录会出现在知识收件箱页面。

图片只保存为 Artifact，不执行 OCR。TXT/Markdown/PDF 的深度解析器尚未接入，当前文件会进入预检和待处理流程。

## API

```text
GET  /health
POST /v1/artifacts
POST /v1/captures/preflight
POST /v1/captures
GET  /v1/captures/{id}
GET  /v1/inbox
POST /v1/review-proposals/{id}/decision
```

审核决定支持 `accepted`、`rejected`、`deferred`。接受建议只记录决策，不会覆盖原始 Capture 或 Fragment。

## 当前边界

- JSON 文件存储用于本地 MVP；生产阶段应替换为 PostgreSQL/pgvector。
- 关系规则只自动产生 `duplicate`、`related`、`independent`。
- `extends`、`supports`、`contradicts` 需要接入可评测的模型工作流后启用。
- 当前没有用户认证；API 仅绑定本机回环地址。
- Electron 安装包、自动更新和代码签名尚未配置。
