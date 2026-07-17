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

当前源码提供 Node API、SQLite 持久化、文件解析、模型供应商注册与调用、工作流和测试基础。`apps/desktop-capture` 与 `apps/browser-extension` 是迁移期间可复用的代码基线；新的产品界面进入 `apps/web`，并通过 HTTP 与流式接口连接本机服务。

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

现有 API 基线可通过以下命令启动：

```powershell
npm.cmd run dev:api
```

WebUI 开发命令随 `apps/web` 首个切片一并加入。

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
