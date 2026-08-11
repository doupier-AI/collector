# Collector

Collector 是一款本地优先的 AI 学习与研究 Web 应用。用户通过 Chat 或导入文档开始研究，在阅读过程中选择局部内容，引用这段文字就地追问或深入研究，并随时返回来源位置。

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

- Chat 输入与 TXT、Markdown、DOCX、文本型 PDF 导入；
- 连续正文阅读；选中后通过选区上方浮动胶囊明确【引用】，再在此追问或深入研究生长节点，也可直接标记并添加笔记；
- 统一研究节点与来源返回；`t` 打开父子树，`g` 打开桌面网状画布或窄屏关系列表，呈现父子、语义相关和融合来源三类边；
- 后台正式 / 兼容语义切片，用于相关上下文选择、来源定位和后续增强，不打断正文阅读；
- AI 弱标记的流式预览与点击生长；
- 外部模型设置、模型发现、按任务分配、渐进生成与失败恢复；
- 用户逐次控制的联网开关，默认关闭；关闭时不执行供应商原生联网或 Agent 搜索；
- 本地运行记录，查看模型、搜索、耗时、重试、错误和脱敏摘要，并导出当前筛选范围；
- 页面刷新和重新启动后的会话、阅读位置、关系、标记与任务恢复。

## 仓库状态

当前源码已经提供本地 WebUI、Node API、SQLite 持久化、统一研究节点与三类关系边、会话内统一研究地图、正文唯一事实源与派生语义卡片、确认式融合、默认关闭的自动融合、研究恢复、文件导入与阅读、模型设置、运行记录、联网双路径、浏览器扩展及自动化测试。跨会话全局图谱、新专注查询和融合长期维护仍处于产品设计阶段；当前能力状态、基线、活动父 Issue 与待产品决定见 [项目现状](docs/PROJECT.md)。


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

快速演示时使用 `npm.cmd run launch:mvp`。该命令复用真实 WebUI、研究会话、SQLite、文件导入、阅读和刷新恢复，仅把研究回答切换为无需网络与密钥的确定性本地模拟；每条模拟回答都永久显示“本地演示回答｜非真实 AI｜未联网检索”。正式真实模型验收使用本机已保存的模型配置；真实模型路径的最新验证限制见 [项目现状](docs/PROJECT.md)。演示模式与正式模式具有不同运行指纹，切换命令时启动器会安全更换服务，不会误复用另一种模式。

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
- 模型供应商凭证保存在专用凭证边界，业务数据、普通日志、浏览器存储和导出内容只保存配置状态；
- 模型会话轨迹记录实际提示、上下文、回复、流式片段、工具调用、耗时、用量、费用、重试和错误，并清除凭证、认证头与本地会话令牌；
- 联网搜索同时支持两条路径：（1）模型供应商原生联网能力（OpenAI/Gemini/Anthropic），由用户在输入框主动开启；（2）Agent 自主搜索循环（Bing/DuckDuckGo/Tavily/SearXNG），支持运行时切换和故障回退。

## 当前文档

- [项目现状（唯一事实入口）](docs/PROJECT.md)
- [领域词汇表](CONTEXT.md)
- [决策记录 ADR](docs/adr/)
- [技术架构](docs/ARCHITECTURE.md)
- [人工验收标准](docs/HUMAN_ACCEPTANCE_STANDARD.md)

当前待产品决定集中记录在 [项目现状](docs/PROJECT.md) 的"当前限制与待产品决定"章节；历史开发过程从 Git 提交与 GitHub Issues 追溯。
