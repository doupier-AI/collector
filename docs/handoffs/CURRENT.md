# Collector 当前实施交接状态

状态版本：`5`

最后更新：2026-07-18

## 当前责任

| 项目 | 当前值 |
| --- | --- |
| 当前纵向切片 | WebUI 同源生产服务及浏览器测试收敛 |
| 当前责任角色 | KIMI 3 前端与浏览器测试 |
| 下一接收角色 | GPT-5.6（前端回交接收） |
| 协作状态 | `awaiting_frontend_acceptance` |
| 待消费交接 | `H-20260718-004` |
| 最近已消费交接 | `H-20260717-002`（由 H-004 替代当前作用） |

## 当前有效基线

| 基线 | 版本 | 本轮是否变化 |
| --- | --- | --- |
| 多模型协作协议 | `COLLAB-PROTOCOL 1.1.0` | 无变化 |
| WebUI 前端实施基线 | `FRONTEND-BASELINE 1.3.0` | 已记录生产同源服务与测试收敛任务 |
| 后端研究会话契约 | SQLite migration v14 / commit `e4ce72e` | 无变化 |
| WebUI 首个切片 | commit `5db1a85` + 界面调整 `9a3ad62` | 已接收；用户路径与 12 项浏览器场景断言成立 |
| WebUI 同源生产服务 | commit `709246b` | 已实现并通过单进程真实 Chromium 验证 |

## 本轮必读

KIMI 3 接收本轮前端测试收敛任务，按顺序读取：

1. 根目录 `AGENTS.md`；
2. 本文件；
3. `docs/handoffs/H-20260718-004-GPT56-TO-KIMI3.md`；
4. `docs/FRONTEND_IMPLEMENTATION_HANDOFF.md` 第 4、19 节；
5. `apps/web/e2e/api-harness.mjs` 与 `apps/web/playwright.config.ts`。

不要求重读 `H-001`、`H-002`、`H-003`、全部长期文档或前端基线其他章节；协作协议版本未变化。

## KIMI 3 可以立即开始

- 让 API 测试进程直接提供 `apps/web/dist`，Playwright 不再启动 Vite preview；
- 为 API 测试进程增加 SIGTERM/SIGINT 清理，关闭 server/store；
- 复跑 `npm.cmd run test:e2e`，要求 12 项场景通过且命令自然退出；
- 核对根页面、静态资源、`/v1` 和 SSE 都来自同一 origin，记录控制台和网络结果；
- 不修改产品页面、界面方向、API 契约或持久化逻辑。

## 当前阻塞与责任

- 生产同源静态服务阻塞已经解除；
- 当前唯一前端阻塞是 Playwright 在 12/12 场景完成后停在第一套 WebServer 终止阶段，不能自然退出；
- 启动器首次安全配对、动态端口与重复启动复用仍由 GPT-5.6 负责，不要求 KIMI 3 本轮处理；
- 当前未发现新的 HTTP/SSE 或 SQLite 契约缺口。

## KIMI 3 完成前提醒

- 创建 `H-20260718-005-KIMI3-TO-GPT56.md`；
- 更新本文件的当前责任角色、待消费交接和本轮必读；
- 更新 `INDEX.md`，把 `H-004` 标记为 `accepted` 或由 `H-005` 替代；
- 说明基线变化是 `none` 还是具体版本升级；
- 列出真实运行的命令、通过、失败和跳过项；
- 将代码、测试和交接文档一起提交，并报告提交哈希。
