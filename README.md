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
- 免费、无需用户单独申请搜索凭证的联网搜索路径；
- 本地产品事件、模型会话与搜索链路观测；
- 页面刷新和重新启动后的会话、阅读位置与任务恢复。

## 仓库状态

产品定义、交互、架构和人工验收基线已经形成，可以直接开始 WebUI 开发。

当前源码提供 Node API、SQLite 持久化、文件解析、模型供应商注册与调用、工作流、浏览器扩展和测试基础。新的产品界面进入 `apps/web`，并通过 HTTP 与流式接口连接本机服务。

开发入口与首个纵向切片见 [开发起点](docs/DEVELOPMENT_START.md)。

## 环境与验证

- Node.js 24+
- npm 11+
- Windows 10/11

```powershell
npm.cmd install --cache .npm-cache
npm.cmd run build
npm.cmd test
powershell -ExecutionPolicy Bypass -File .agents\skills\collector-engineering\scripts\check-project.ps1
```

构建后，可以直接双击根目录的 `Collector.cmd`。它会启动或复用本机服务，安全完成首次浏览器配对，并打开默认浏览器。命令行等价入口是：

```powershell
npm.cmd run launch
```

启动器由系统选择可用端口，地址形如 `http://127.0.0.1:<本次端口>`。重复启动时会核对实例身份和健康状态，然后复用同一进程与端口。一次性浏览器入口只通过 HttpOnly Cookie 交付会话，令牌不进入 URL、浏览器存储或日志。已构建时也可使用 `npm.cmd start`。

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
- 联网搜索通过可替换适配层接入，SearXNG 兼容接口是首选工程候选。

## 当前文档

- [领域语言](CONTEXT.md)
- [产品定义与范围](docs/PRODUCT_REFOUNDATION.md)
- [产品功能流程](docs/PRODUCT_FUNCTION_FLOW.md)
- [交互设计](docs/INTERACTION_DESIGN.md)
- [界面布局方向](docs/INTERFACE_DIRECTIONS.md)
- [输入来源可行性](docs/INPUT_SOURCE_FEASIBILITY.md)
- [技术架构](docs/ARCHITECTURE.md)
- [人工验收标准](docs/HUMAN_ACCEPTANCE_STANDARD.md)
- [开发起点](docs/DEVELOPMENT_START.md)

当前待确认事项集中记录在 [产品定义与范围](docs/PRODUCT_REFOUNDATION.md) 的“尚待确认”章节。
