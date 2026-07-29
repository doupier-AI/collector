# Collector

Collector 是一款本地优先的 AI 学习与研究 Web 应用。用户通过 Chat 或导入文档开始研究，在阅读过程中选择局部内容，继续深入研究、保存“稍后再学”，并随时返回来源位置。

## 当前产品形态

Collector 以本地 WebUI 作为产品界面：

```text
双击 Collector 启动器
        ↓
启动或复用本机服务
        ↓
默认浏览器打开 127.0.0.1:<动态端口>
        ↓
WebUI ↔ HTTP / 流式连接 ↔ Node 服务 ↔ SQLite / 文件 / 模型 / 搜索
```

当前 MVP 包含：

- Chat 输入与文件导入；
- 当前内容阅读与选区智能窗口；
- 沿当前内容研究和独立研究会话；
- “稍后再学”与来源位置返回；
- 外部模型供应商配置、流式生成与失败恢复；
- 用户可控的联网搜索开关（默认关闭），关闭时 AI 只基于已有材料回答；
- 本地产品事件、模型会话与搜索链路观测；
- 页面刷新和重新启动后的会话、阅读位置与任务恢复。

## 仓库状态

当前源码已经提供本地 WebUI、Node API、SQLite 持久化、研究会话与恢复、会话内文件导入和阅读视图、模型供应商注册与调用、工作流、浏览器扩展及自动化测试。当前实现状态、已完成里程碑、验证证据和遗留限制见 [项目开发记录](docs/PROJECT_DEVELOPMENT_RECORD.md)；产品核心闭环和实施计划见 [MVP 实施计划](docs/MVP_IMPLEMENTATION_PLAN.md)。


## 环境与验证

- Node.js 24+
- npm 11+
- Windows 10/11

```powershell
npm.cmd install --cache .npm-cache
npm.cmd run build
npm.cmd test
powershell -ExecutionPolicy Bypass -File scripts\check-project.ps1
```

构建后，可以直接双击根目录的 `Collector.cmd`。它会启动或复用本机服务，安全完成首次浏览器配对，并打开默认浏览器。命令行等价入口是：

```powershell
npm.cmd run launch
```

快速演示时使用 `npm.cmd run launch:mvp`。该命令复用真实 WebUI、研究会话、SQLite、文件导入、阅读和刷新恢复，仅把研究回答切换为无需网络与密钥的确定性本地模拟；每条模拟回答都永久显示“本地演示回答｜非真实 AI｜未联网检索”。TODO（正式版本）：演示验收完成后使用真实模型配置和来源检索验证回答质量，不把模拟回答作为产品能力证据。演示模式与正式模式具有不同运行指纹，切换命令时启动器会安全更换服务，不会误复用另一种模式。

启动器由系统选择可用端口，地址形如 `http://127.0.0.1:<本次端口>`。当前实现会核对实例身份、运行构建指纹和健康状态：当前运行构建与锁定依赖未变化时复用同一进程与端口；支持受控关闭的既有实例在构建产物或锁定依赖变化后先安全关闭，再打开当前版本。更早、不支持受控关闭的服务需要用户先关闭后重试；启动器不会强行结束无法验证身份的进程，也不会并行启动第二个服务。服务在整个运行期间独占数据目录，不能有两个服务同时读写同一份 SQLite 和用户文件。这组替换与独占能力已通过自动化测试，真实旧服务替换和异常退出验收仍为待验证项。一次性浏览器入口只通过 HttpOnly Cookie 交付会话，令牌不进入 URL、浏览器存储或日志。已构建时也可使用 `npm.cmd start`。

开发时直接运行 `npm.cmd run dev:api` 保留 `http://127.0.0.1:43110`，便于 Vite 代理和浏览器扩展调试；`COLLECTOR_PORT` 可以覆盖端口。正式启动时，已配对扩展继续通过 `43110` 本机适配入口访问同一服务；可用 `COLLECTOR_EXTENSION_PORT` 覆盖，设为 `0` 则停用。打包或隔离测试时可以用 `COLLECTOR_WEB_ROOT` 指向另一份 WebUI 生产构建目录。缺少 `index.html` 时服务会在启动阶段明确报错。

WebUI（`apps/web`）开发与测试命令：

```powershell
npm.cmd run dev:web    # 启动 WebUI 开发服务器（默认 http://localhost:5173，/v1 代理到本机 API）
npm.cmd run test:web   # 运行 WebUI 客户端单元测试
```

`npm.cmd run build` 会一并完成 `apps/web` 的类型检查与生产构建。`npm.cmd run dev:api` 会先构建，再以单进程同源方式启动 WebUI 与 API。只有修改前端并需要热更新时，才额外运行 `npm.cmd run dev:web`；开发代理目标可用 `COLLECTOR_API_ORIGIN` 覆盖（默认 `http://127.0.0.1:43110`）。

端到端验证（真实 Chromium + 确定性假模型，不调用真实云模型）：

```powershell
npm.cmd run test:e2e    # 先完整构建，再运行 apps/web 的 Playwright 用例
```

## 数据、模型与联网边界

- 研究会话、内容、来源关系、任务和观测轨迹保存在本机；
- 新 WebUI 首次切换使用全新的数据空间，并执行一次性现有用户数据清理；
- 模型供应商凭证保存在专用凭证边界，业务数据、普通日志、浏览器存储和导出内容只保存配置状态；
- 模型会话轨迹记录实际提示、上下文、回复、流式片段、工具调用、耗时、用量、费用、重试和错误，并清除凭证、认证头与本地会话令牌；
- 联网搜索同时支持两条路径：（1）模型供应商原生联网能力（OpenAI/Gemini/Anthropic），由用户在输入框主动开启；（2）Agent 自主搜索循环（Bing/DuckDuckGo/Tavily/SearXNG），支持运行时切换和故障回退。

## 当前文档

- [领域语言](CONTEXT.md)
- [产品指南](docs/PRODUCT.md)
- [技术架构](docs/ARCHITECTURE.md)
- [人工验收标准](docs/HUMAN_ACCEPTANCE_STANDARD.md)
- [MVP 实施计划](docs/MVP_IMPLEMENTATION_PLAN.md)
- [项目开发记录](docs/PROJECT_DEVELOPMENT_RECORD.md)

当前待确认事项集中记录在 [MVP 实施计划](docs/MVP_IMPLEMENTATION_PLAN.md) 的”待确认事项”章节。
