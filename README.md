# Collector

Collector 是一款面向个人学习者的本地优先内容收集与 AI 整理工具。

它希望缩短这条路径：

```text
随手收集零散材料
→ 看见近期关注方向
→ 将方向保存为专题
→ 生成可追溯、可持续更新的专题文档
```

Collector 只承诺两件事：低摩擦地保存内容，以及忠实地整理用户已经收集的材料。它不替用户规划学习路径，也不以知识图谱或永久语义关系为产品目标。

## 当前状态

项目正在按 [PRD 2.0](docs/PROGRAM_PLAN.md) 从早期的 Inbox/Relation 原型迁移到“原始材料、近期收集、专题、专题文档”闭环，目前仍属于开发阶段。

当前已经具备：

- Chromium 扩展的网页选区和整页采集；
- Windows Electron 单窗口应用、托盘和全局快捷键；
- 文本、URL、TXT、Markdown、文本 PDF 和常见图片采集；
- SQLite 与本地 Artifact 持久化、Fragment 来源定位和幂等采集；
- 全部材料的搜索、编辑修订、回收站、恢复和永久删除 API，桌面端已接入基础操作；
- 可恢复的近期整理任务、临时分组快照和未归类材料；
- 专题创建、成员管理、归档，以及专题文档和版本相关 API；
- DeepSeek 配置、`safeStorage` 凭据保存、调用记录和基础预算数据；
- 本地 API 配对鉴权、明确 CORS 和 URL 抓取安全限制。

仍在纠偏或尚未完成：

- 旧 Inbox、Relation、ReviewProposal 代码和接口尚未完全退出；
- 近期整理、专题文档、核验和增量更新仍需完成端到端产品验收；
- 生产级联网核验尚未接入；Fake Provider/FakeVerifier 只能视为测试替身；
- AI 用量与预算、数据位置、备份和导出尚未完整接入设置页面；
- 安装包签名、自动更新和正式发布流程尚未配置。

具体差距见 [实现纠偏计划](docs/IMPLEMENTATION_CORRECTION_PLAN.md)。

## 产品形态

用户可见的核心形态只有四种：

| 形态 | 说明 |
| --- | --- |
| 原始材料 | 用户采集的文本、网页、文件或链接，长期保存并保留来源 |
| 近期收集 | 对近期材料形成的动态临时分组，不会自动创建永久分类 |
| 专题 | 用户明确确认的长期材料容器 |
| 专题文档 | 基于专题材料生成、带引用且保留版本的整理成果 |

`Capture`、`Artifact`、`Fragment`、`WorkflowRun`、模型调用和核验记录属于内部实现或诊断概念，不应成为普通用户的主要操作对象。

## 技术结构

Collector 是 TypeScript 模块化单体：

- `apps/desktop-capture`：Electron 单窗口应用与快速采集；
- `apps/browser-extension`：Chromium 采集扩展；
- `apps/api`：本地 Node API、领域服务、工作流和 SQLite 存储；
- `packages/capture-contracts`：共享契约；
- `packages/capture-client`：采集客户端；
- `packages/model-gateway`：DeepSeek 与 Fake Provider 接入；
- `.collector-data/`：默认数据库和 Artifact 数据目录。

完整技术决策见 [技术架构](docs/ARCHITECTURE.md)。

## 环境

- Node.js 24+
- npm 11+
- Windows 10/11（运行 Electron 桌面端）

## 安装

```powershell
npm.cmd install --cache .npm-cache
```

如果当前环境只需要编译和运行非 GUI 测试，可以跳过 Electron 二进制下载：

```powershell
$env:ELECTRON_SKIP_BINARY_DOWNLOAD='1'
npm.cmd install --cache .npm-cache
```

之后若要运行桌面端或 GUI smoke，需要恢复 Electron 二进制：

```powershell
npm.cmd rebuild electron
```

## 开发与验证

```powershell
npm.cmd run build
npm.cmd test
powershell -ExecutionPolicy Bypass -File .agents\skills\collector-engineering\scripts\check-project.ps1
npm.cmd run test:gui
```

`test:gui` 使用隔离的端口、用户目录、实例 ID 和 SQLite 数据库，验证 Renderer、Preload、IPC 与真实持久化路径。受管 Windows 环境中的 smoke 子进程可能使用 `--no-sandbox`；正常桌面启动不会使用该参数，窗口仍启用 sandbox、`contextIsolation` 和 CSP。

## 启动

启动完整桌面应用：

```powershell
npm.cmd run dev:desktop
```

Electron 会连接已有本地 API；没有可用服务时，会启动属于当前应用实例的嵌入式 API。

只启动 API：

```powershell
npm.cmd run dev:api
```

默认监听 `http://127.0.0.1:43110`。可通过以下环境变量覆盖：

```powershell
$env:COLLECTOR_PORT='43111'
$env:COLLECTOR_DATA_DIR='D:\CollectorData'
```

## 使用

### 快速采集

默认快捷键为 `Ctrl+Shift+Space`。快捷键会唤起同一个主窗口并进入紧凑采集状态，不创建第二个窗口。

- 粘贴文本或 URL；
- 点击附件按钮或拖入 TXT、Markdown、PDF、PNG、JPEG、WebP；
- `Ctrl+Enter` 提交；
- `Esc` 隐藏并保留未提交草稿。

单文件最大 20 MiB。TXT 和 Markdown 按稳定行号生成引用片段，文本 PDF 按页生成片段；图片和扫描 PDF 只保存原文件，当前不执行 OCR。Collector 不会主动读取或监听剪贴板。

### 浏览器扩展

1. 运行 `npm.cmd run build`。
2. 在 Chromium 扩展管理页启用开发者模式。
3. 选择“加载已解压的扩展程序”。
4. 加载 `apps/browser-extension/build`。
5. 从 Collector 托盘选择“浏览器扩展配对”，在扩展中输入六位配对码。
6. 选中文字后右击“收集到 Collector”，或收集当前网页。

API 不可用时，扩展会把请求保存在 `chrome.storage.local` 并重试；相同 `clientCaptureId` 不会重复创建材料。

### 主窗口

当前主窗口提供：

- **近期收集**：触发近期整理、查看材料和未归类内容；
- **专题**：查看专题、管理成员和文档状态；
- **全部材料**：搜索、查看、编辑、回收站、恢复和删除；
- **设置**：快捷键、DeepSeek 授权和 Key 配置。

部分页面仍在从旧原型迁移，README 中列出的能力不代表 PRD 2.0 已完成验收。

## AI 与数据边界

- 原始保存、本地解析和基本来源提取不依赖云模型；
- 首次启用 DeepSeek 前必须明确授权；
- Key 只进入 Electron Main Process，并通过 `safeStorage` 保存；
- Renderer、SQLite、日志、导出和源码不得保存明文 Key；
- 云模型失败不得影响原始材料或已有正式文档版本；
- 开发和自动化测试默认使用 Fake Provider，不需要真实 Key；
- 真实 DeepSeek 验收必须使用用户新生成、仅在运行时提供的 Key。

默认数据保存在 `.collector-data/`。数据库使用 Node 内置 SQLite，Artifact 原文件单独保存在本地目录。数据 API 除健康检查和一次性配对交换外均要求配对 Token 或本地 HttpOnly 会话。

## 打包

生成 electron-builder 目录包或发行包：

```powershell
npm.cmd run pack
npm.cmd run dist
```

也可生成本地便携目录：

```powershell
npm.cmd run pack:local
```

当前产物尚未配置代码签名、自动更新或正式发布门禁。

## 项目文档

- [产品需求](docs/PROGRAM_PLAN.md)
- [技术架构](docs/ARCHITECTURE.md)
- [工作流契约](docs/WORKFLOW_CONTRACTS.md)
- [实现纠偏计划](docs/IMPLEMENTATION_CORRECTION_PLAN.md)
- [纠偏自检规范](docs/CORRECTION_SELF_CHECK.md)
