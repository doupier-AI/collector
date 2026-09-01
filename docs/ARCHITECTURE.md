# Collector 技术架构

本文件只记录稳定技术边界和代码导航，不复述产品功能状态。产品含义见 `docs/product/`；实际行为以源码、迁移和测试为准。

## 运行结构

```text
React WebUI
    ↓ loopback HTTP / progressive events
Node API and domain services
    ├─ SQLite and local artifacts
    ├─ model gateway and provider adapters
    └─ local or external search adapters
```

- 正式产品是 React 19 + Vite WebUI、Node.js 本机 API、SQLite 和外部模型/搜索适配。
- API 同源交付 `apps/web/dist`，并负责认证、业务写入、任务恢复和外部能力调用。
- 服务只监听 `127.0.0.1`；浏览器不拥有数据库、文件系统或凭证访问权。
- 启动器负责实例发现、版本核对、数据目录独占、动态端口和受控关闭。

## 依赖方向

```text
apps/web  ───────────────→ packages/capture-contracts
apps/web  ───────────────→ packages/markdown-projection
apps/api  ───────────────→ packages/capture-contracts
apps/api  ───────────────→ packages/markdown-projection
apps/api  ───────────────→ packages/model-gateway
packages/model-gateway ──→ packages/capture-contracts
```

不得反向依赖。`apps/api` 是运行时组合根；共享契约不能依赖 WebUI、API 服务实现或供应商 SDK。

## 代码导航

| 责任 | 主要入口 |
| --- | --- |
| Web 页面、交互与客户端状态 | `apps/web/src` |
| Web 到 API 的统一客户端 | `apps/web/src/api/client.ts` |
| 本机 HTTP、事件、静态资源与认证入口 | `apps/api/src/http.ts`、`apps/api/src/static-web.ts`、`apps/api/src/auth.ts` |
| 服务组合与供应商运行时解析 | `apps/api/src/service.ts` |
| 会话、消息、任务和回答生成 | `apps/api/src/research.ts` |
| 回答计划与确定性完成检查 | `apps/api/src/answer-planning.ts`、`apps/api/src/answer-completion.ts` |
| 联网证据准备、政策覆盖账本、资格与装箱 | `apps/api/src/evidence-preparation.ts`、`apps/api/src/web-search-agent.ts` |
| 深入研究和节点生长 | `apps/api/src/deep-research.ts` |
| 导入、解析与章节 | `apps/api/src/research-import.ts`、`apps/api/src/research-chapters.ts`、`apps/api/src/parsers.ts` |
| 选区、标记、术语与稍后处理的历史实现 | `apps/api/src/selection.ts`、`apps/api/src/research-later.ts`、`apps/api/src/term-preview.ts` |
| 地图关系、融合与关联提示 | `apps/api/src/fusion-proposals.ts`、`apps/api/src/association-hints.ts`、`apps/api/src/semantic-search` |
| SQLite、迁移、删除级联与派生索引清理 | `apps/api/src/store.ts` |
| 共享领域与传输契约 | `packages/capture-contracts/src/index.ts` |
| 共享 Markdown 解析、安全渲染与源码/可见范围投影 | `packages/markdown-projection/src/index.ts` |
| 模型供应商、模型路由和联网能力适配 | `packages/model-gateway/src/index.ts` |
| 服务端与共享测试 | `tests` |
| Web 组件与浏览器测试 | `apps/web/src/**/*.test.tsx`、`apps/web/e2e` |

目录名和现有大文件不代表产品模块边界。产品模块通过明确拥有的数据和行为协作；技术拆分可以逐步调整，但不得改变产品契约。

## 内容与数据事实

- 正文字符串是唯一可阅读、复制和普通导出的内容事实。
- 正文版本、内容快照、章节、语义范围、切片、搜索单元、引用定位和地图投影是派生或稳定定位数据。
- 派生数据必须可删除、可重建或诚实失效；不得反向覆盖正文。
- 数据库和文件通过稳定 ID 关联。永久删除必须在同一领域边界中处理数据库记录、文件和派生索引。
- 输入先持久化，再启动可恢复任务；任务使用稳定标识，取消、重试和恢复不得重复产生业务结果。

## 跨模块接缝

- 研究工作空间拥有会话、节点、消息容器和生命周期。
- AI 回答与生成消费经准入的上下文与证据，只由最终写作阶段写正文。
- 阅读与内容操作拥有正文呈现、导入内容、稳定位置和用户选区动作。
- 来源与证据拥有来源身份、健康、定位和候选证据；不决定最终答案。
- 研究地图与知识关系只投影节点与关系，不保存正文副本。
- 学习适应只提供低权重、用户可控的适应信息。
- 本地运行与控制拥有认证、凭证、模型配置、调度和观测，不拥有产品内容语义。

## 安全边界

- API Key、认证头、Cookie、会话令牌和启动控制凭据不得进入普通日志、URL、浏览器持久化、业务导出或 Agent 回传。
- 公网请求及每次重定向都必须重新校验目标；限制请求时间、响应字节、文件大小和解析资源。
- 普通运行记录可以保存脱敏后的调用与错误元数据，不保存秘密或未经授权的完整候选正文。
- 外部模型、搜索和抓取失败时必须诚实降级；不得把无来源结果伪装为可核验证据。

## 高影响区域

共享契约、SQLite 迁移与 `LATEST_SCHEMA_VERSION`、认证与凭证、构建配置、Playwright 基础设施、模型路由和删除级联属于高影响区域。修改前必须检查全部调用方，修改后按 `docs/ENGINEERING.md` 升级验证。
