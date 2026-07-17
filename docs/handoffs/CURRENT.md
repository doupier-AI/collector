# Collector 当前实施交接状态

状态版本：`1`

最后更新：2026-07-17

## 当前责任

| 项目 | 当前值 |
| --- | --- |
| 当前纵向切片 | 启动并恢复一场研究会话 |
| 当前责任角色 | KIMI 3 前端 |
| 下一接收角色 | GPT-5.6 后端与产品框架 |
| 协作状态 | `awaiting_frontend_acceptance` |
| 待消费交接 | `H-20260717-001` |
| 最近已消费交接 | 无 |

## 当前有效基线

| 基线 | 版本 | 本轮是否变化 |
| --- | --- | --- |
| 多模型协作协议 | `COLLAB-PROTOCOL 1.0.0` | 首次建立 |
| WebUI 前端实施基线 | `FRONTEND-BASELINE 1.0.0` | 首次建立版本标记并增加回交要求 |
| 后端研究会话契约 | SQLite migration v14 / commit `e4ce72e` | 已实现，等待前端接入 |

## 本轮必读

KIMI 3 首次接手本角色，按顺序读取：

1. 根目录 `AGENTS.md`；
2. 本文件；
3. `docs/IMPLEMENTATION_COLLABORATION_PROTOCOL.md`；
4. `docs/FRONTEND_IMPLEMENTATION_HANDOFF.md`；
5. `docs/handoffs/H-20260717-001-GPT56-TO-KIMI3.md`；
6. 最新共享 Research 类型和 `tests/research-session.test.ts`。

本轮不要求顺序重读全部历史文档。需要确认具体产品细节时，再读取前端基线中对应的文档链接。

## KIMI 3 可以立即开始

- 创建 `apps/web` React、TypeScript、Vite 工程；
- 建立 AppShell、路由、设计令牌和响应式布局；
- 使用共享 Research 类型建立 API/SSE 客户端；
- 使用隔离请求替身编写会话、任务和事件客户端测试；
- 实现空、加载、失败、键盘、焦点和减少动态效果状态；
- 建立 Playwright 用例骨架。

## 当前阻塞与责任

以下事项由 GPT-5.6 继续负责，KIMI 3 不自行绕过：

- WebUI 生产构建的同源静态资源服务；
- 启动器到首次 WebUI 的安全 Cookie 引导；
- 统一开发代理、隔离数据目录、测试端口和假模型启动命令；
- 会话创建幂等；
- 文件导入进入研究会话的正式契约；
- 真实模型供应商原生流式输出。

KIMI 3 发现新增后端阻塞时，立即把复现步骤和期望契约写入本文件，并在回交中单列。

## 接收动作

KIMI 3 开始实质开发时：

1. 核对提交 `e4ce72e` 和研究会话集成测试；
2. 将 `H-20260717-001` 状态改为 `accepted`；
3. 将本文件协作状态改为 `frontend_in_progress`；
4. 同步更新 `docs/handoffs/INDEX.md`；
5. 状态更新可与第一笔前端相关提交一起提交。

## KIMI 3 完成前提醒

- 创建下一份递增编号的 `KIMI3-TO-GPT56` 增量交接；
- 按协作协议第 9 节提供完整回交证据；
- 更新本文件的当前责任角色、待消费交接和本轮必读；
- 更新 `INDEX.md`；
- 说明基线变化是 `none` 还是具体版本升级；
- 列出真实运行的命令、通过、失败和跳过项；
- 说明浏览器、视口、键盘、可访问性、控制台和网络结果；
- 说明 WebUI 操作对应的 API/SQLite 结果；
- 说明是否调用真实云模型；
- 将代码、测试和交接文档一起提交，并报告提交哈希。
