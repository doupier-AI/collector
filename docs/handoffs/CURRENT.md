# Collector 当前实施交接状态

状态版本：`18`

最后更新：2026-07-19

## 当前责任

| 项目 | 当前值 |
| --- | --- |
| 当前纵向切片 | 文件导入进入研究会话（WebUI 接入与阅读恢复） |
| 当前责任角色 | KIMI 3（等待接收 H-010） |
| 下一接收角色 | GPT-5.6 |
| 协作状态 | `handoff_pending` |
| 待消费交接 | `H-20260719-010` |
| 最近已消费交接 | `H-20260719-009`（2026-07-19 已接收） |

## 当前有效基线

| 基线 | 版本 | 本轮是否变化 |
| --- | --- | --- |
| 多模型协作协议 | `COLLAB-PROTOCOL 1.3.0` | 无变化 |
| WebUI 前端实施基线 | `FRONTEND-BASELINE 1.6.0` | 已变化：增加文件导入、任务、SSE、内容快照与阅读恢复契约 |
| 后端研究会话契约 | SQLite migration v16 | 已变化：新增研究附件、导入任务、内容快照和持久事件 |
| WebUI 首个切片 | commit `5db1a85` + 界面调整 `9a3ad62` | 无变化 |
| WebUI 同源生产服务 | commit `709246b` | 无变化 |
| 浏览器测试收敛 | commit `07ae609` | 已实现：Playwright 直连 API 同源，既有 14/14 场景通过且命令自然退出 |
| 文件导入后端 | commit `15f2f48` + 安全补强 `ee01685` + Markdown 结构补强 `fe562aa` | 已实现并达到 `frontend-ready` |

## 本轮必读

KIMI 3 接收 H-010 时按顺序读取：

1. 当前对话上下文；
2. 根目录 `AGENTS.md`；
3. 本文件；
4. `docs/handoffs/H-20260719-010-GPT56-TO-KIMI3.md`（当前 `pending`）；
5. `docs/FRONTEND_IMPLEMENTATION_HANDOFF.md` 第 10.3、10.4、16、19 节。

只有出现契约差异、迁移问题或恢复语义不明确时，再读取实现提交 `15f2f48`、安全补强提交 `ee01685`、Markdown 结构补强提交 `fe562aa`、`docs/ARCHITECTURE.md` 对应文件导入章节和 `docs/IMPLEMENTATION_COLLABORATION_PROTOCOL.md` 第 3、4、7.1、7.2、7.4、8、10、12 节。不要求默认重读 H-001 至 H-009、全部长期文档或前端基线其他章节。

## 本轮边界

后端真实接口和恢复条件已经就绪。KIMI 3 接收 H-010 后负责完成当前 WebUI 切片：

- 文件选择与拖放：只允许 TXT、Markdown、DOCX、PDF，显示 20 MiB 上限并以服务端校验为准；
- 真实上传：发送原始 `File` body、编码后的 `X-File-Name`、浏览器 MIME 和会话内独立 `Idempotency-Key`，响应不确定时复用同一键；
- 任务体验：显示 queued/running/completed/failed/cancelled、解析阶段和进度，连接 SSE，支持取消、失败重试和 GET 回退；
- 阅读恢复：以稳定 `contentSnapshotId` 读取内容块，在同一 `/research/:sessionId` 画布打开阅读视图，按锚点联合类型渲染；
- 联调与验证：覆盖刷新、关闭重开、响应丢失、服务重启、多视口、键盘、焦点、可访问名称、动态通知、控制台、网络和 API/SQLite 一致性；
- 完成后创建 H-011 回交 GPT-5.6，不调用真实云模型。

当前附件按钮继续保留占位，直到真实上传和状态体验完成；不伪造本地上传成功，不读取内部对象路径，不改写旧 `/v1/artifacts` 或 Capture 链路。

## 当前阻塞与责任

- H-010 已 `pending`；KIMI 3 接收后开始 WebUI 接入，接收状态未更新前不宣称责任已正式消费；
- 后端无代码阻塞：共享契约、HTTP/SSE、SQLite v16、原文件与快照持久化、会话内幂等、取消、重试、服务重启和孤立对象恢复均可直接联调；
- DOCX 在 Mammoth 解析前限制 ZIP 条目数、单条目大小、总解压量和压缩比；超限任务稳定失败，不让压缩文件绕过内存边界；
- PDF 当前范围是文本型 PDF 的按页文本快照与页码锚点，不包含页面渲染、扫描件 OCR 或像素级高亮；
- 启动器、自动配对、动态端口、重复启动复用、Cookie 和会话/消息幂等边界保持不变；
- Chrome DevTools MCP 未配置，现有 Playwright 控制台和网络检查仍为正式自动化证据。

## 最近完成切片的验证

- 验证级别：四级；原因是本轮修改共享契约、SQLite migration、文件持久化、HTTP/SSE、后台恢复、依赖和后续用户阅读入口；
- 安全补强后 `npm test`：构建成功，133/133 项 Node 单元与集成测试通过；
- 安全补强后 `npm run test:web`：62/62 项 WebUI 测试通过；
- 安全补强后 `npm run test:e2e`：14/14 项 Chromium 场景通过并自然退出；
- 安全补强后 `powershell -File .agents/skills/collector-engineering/scripts/check-project.ps1`：通过；
- 受影响定向验证：研究导入 5/5 通过，覆盖 DOCX 解压上限、畸形文件名 400、SSE 单调状态和紧邻列表 Markdown；
- 测试全部使用本地确定性 fixture 和既有假模型，没有真实云模型调用；
- 已知测试警告：pdfjs 在无可选 canvas 原生绑定时输出渲染警告，文本提取、页码锚点和当前后端范围仍通过；
- 未执行项：没有真实浏览器上传交互和阅读视图验收，因为该界面尚未实现，属于 KIMI 3 当前切片。

## KIMI 3 回交门槛

- 文件选择、拖放、进度、取消、失败/重试和阅读入口全部使用真实后端接口，不保留占位或伪状态；
- 刷新、响应丢失、关闭重开与服务重启均能通过稳定 ID 和幂等键恢复，不重复创建附件或任务；
- 完成二级前端验证；由于当前切片跨端且包含用户完整路径，浏览器、API/SQLite 联调失败或契约变化时提升到四级；
- H-011 记录浏览器、多视口、键盘、可访问性、控制台、网络、API/SQLite 和未执行项；
- H-011、`CURRENT.md`、`INDEX.md` 和相关接收状态合并为同一交接边界，不分别提交。
