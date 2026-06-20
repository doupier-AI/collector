# AGENTS.md

This file provides guidance to Qoder (qoder.com) when working with code in this repository.

## 项目概述

Collector 是本地优先的内容收集与 AI 整理工具（Windows 桌面端）。单用户、TypeScript 模块化单体，Electron 42 + Node 24 + SQLite（`node:sqlite`）。正处于 PRD 2.0 迁移阶段，从旧 Inbox/Relation 原型向"原始材料→近期收集→专题→专题文档"闭环过渡。

## 常用命令

```powershell
# 安装（跳过 Electron 二进制可用于纯测试环境）
npm.cmd install --cache .npm-cache
$env:ELECTRON_SKIP_BINARY_DOWNLOAD='1'; npm.cmd install --cache .npm-cache

# 构建（TypeScript 增量编译 + 静态资源）
npm.cmd run build

# 全量测试（构建 + node --test）
npm.cmd test

# 运行单个测试文件
npx tsx --test tests/e2e.test.ts

# GUI smoke 测试（需要 Electron 二进制）
npm.cmd run test:gui

# 启动本地 API（默认 127.0.0.1:43110）
npm.cmd run dev:api

# 启动桌面应用（构建 → Electron）
npm.cmd run dev:desktop

# 打包
npm.cmd run pack          # electron-builder --dir
npm.cmd run dist          # electron-builder 发行包
npm.cmd run pack:local    # 本地便携目录

# 清理构建产物
npm.cmd run clean
```

## 架构

### 模块依赖图

```
capture-contracts (共享类型/契约)
    ↑           ↑           ↑
capture-client  model-gateway  api
    ↑                ↑         ↑
    └────────── desktop-capture ─┘
                    ↑
            browser-extension (仅引用 contracts)
```

### 各 workspace 职责

| 包 | 说明 | 关键文件 |
|---|---|---|
| `@collector/capture-contracts` | 所有共享类型、枚举、校验函数 | `packages/capture-contracts/src/index.ts` — `CaptureInput`、`CaptureRecord`、`TopicRecord`、`WorkflowRunRecord`、`CAPTURE_TYPES`（5种：`browser_selection/browser_page/pasted_text/pasted_url/local_file`） |
| `@collector/api` | 领域服务 + HTTP API + 持久化 | `apps/api/src/service.ts` — `CaptureService`（核心业务逻辑，~1050行）；`http.ts` — 原生 `node:http` 路由（非 Express）；`store.ts` — `CollectorStore` 接口 + `SqliteStore`/`MemoryStore`/`JsonStore` 实现 |
| `@collector/model-gateway` | 模型供应商抽象层 | `packages/model-gateway/src/index.ts` — `ModelGateway`、`DeepSeekProvider`、`FakeProvider` |
| `@collector/capture-client` | HTTP 采集客户端 | `packages/capture-client/src/index.ts` — `CaptureClient` |
| `@collector/desktop-capture` | Electron 应用壳 | `main.ts` — 主进程（生命周期/托盘/快捷键/嵌入式 API）；`preload.cts` — 类型化 IPC 桥；`shell-renderer.ts` — 外壳导航；`workspace-renderer.ts` — 主工作台 |
| `@collector/browser-extension` | Chromium 扩展 | `apps/browser-extension/src/` — content script + background |
| `@collector/tests` | 集成测试 | `tests/` — `e2e.test.ts`（自建服务器）、`e2e-live.test.ts`（对运行中的应用）、其余按功能切片 |

### 关键架构模式

**HTTP API（原生 node:http，非框架）**
`apps/api/src/http.ts` 使用 `createServer` + URL pathname 正则匹配。路由模式：
```ts
const match = url.pathname.match(/^\/v1\/materials\/([^/]+)$/);
if (request.method === "GET" && match) return json(response, 200, service.getMaterial(decodeURIComponent(match[1])));
```
新增端点时在 `http.ts` 的路由链中添加匹配分支。所有认证路由在 `auth.isAuthorized(requestToken(request))` 检查之后。

**Store 接口（三种实现共享同一契约）**
`apps/api/src/store.ts` 定义 `CollectorStore` 接口（~70 个方法）。三种实现：
- `SqliteStore` — 生产用，SQLite WAL + `node:sqlite` 的 `DatabaseSync`
- `MemoryStore` — 测试用，纯内存
- `JsonStore` — 旧版 JSON 文件，仅用于迁移

迁移通过 `migrateIfNeeded()` 在 `init()` 时执行。Schema 版本号在 `capture-contracts` 中定义。

**Electron IPC（typed preload bridge）**
`preload.cts` 通过 `contextBridge.exposeInMainWorld("collector", {...})` 暴露分组 API。Renderer 通过 `window.collector.capture.submit()` / `window.collector.material.list()` 调用。新增 IPC 需要：
1. `preload.cts` 中添加暴露方法
2. `main.ts` 中注册 `ipcMain.handle()` 或 `ipcMain.on()` 处理器
3. `desktop-bridge.d.ts` 中更新类型声明

**工作流状态机**
`WorkflowRun` 有状态链：`queued → processing → completed | failed | cancelled`。SQLite 保存 `WorkflowRun` + `WorkflowStep`。步骤执行通过 `claimWorkflowStep()` 原子领取（防重复）。当前已实现：`RecentOrganizationWorkflow`（近期整理）和 `TopicDocumentWorkflow`（专题文档生成）的骨架，但**进程内自动调度器尚未贯通**（纠偏计划阶段 3/5 的核心任务）。

**认证模型**
- API 仅监听 `127.0.0.1`，但所有数据路由要求 `Authorization: Bearer <token>`
- 扩展通过一次性配对码（`POST /v1/pairings/exchange`）获取独立 token
- DeepSeek Key 通过 Electron `safeStorage` 保存，不进入 Renderer/SQLite/日志
- `LocalAuth` 管理 token 注册和验证，支持 `registerTrustedToken`（测试）和 `exchangePairingCode`（生产）

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `COLLECTOR_API_URL` | `http://127.0.0.1:43110` | API 地址 |
| `COLLECTOR_PORT` | `43110` | API 端口 |
| `COLLECTOR_DATA_DIR` | `.collector-data/` | 数据目录 |
| `COLLECTOR_INSTANCE_ID` | `default` | 实例隔离 ID |
| `COLLECTOR_DISABLE_GPU` | — | 设为 `1` 禁用 GPU 加速 |
| `ELECTRON_SKIP_BINARY_DOWNLOAD` | — | 设为 `1` 跳过 Electron 下载 |

### 测试约定

- 测试使用 Node 内置 `node:test` 运行器（`node --test`），不使用 Jest/Vitest
- 集成测试自建服务器：`new MemoryStore()` + `LocalAuth` + `createApiServer`，`registerTrustedToken` 获取测试 token
- `e2e.test.ts` 完全自包含，不需要 Electron 或运行中的应用
- `e2e-live.test.ts` 对运行中的 Electron 应用测试，需通过配对码获取 token
- GUI smoke（`scripts/gui-smoke.mjs`）使用隔离的端口、profile、instance ID 和 SQLite 数据库
- 测试文件在 `tests/` 目录，编译输出到 `dist-tests/`

### Agent 自治开发

- Issues 和 PRD 使用 `.scratch/` 下的本地 Markdown 文件管理（详见 `docs/agents/issue-tracker.md`）
- Triage 五阶段标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`（详见 `docs/agents/triage-labels.md`）
- 域文档：根目录 `CONTEXT.md` + `docs/adr/`（详见 `docs/agents/domain.md`）
- `scripts/ralph/` 自主开发调度器：每轮执行一个满足条件的 AFK Issue，为实施与验证分别启动全新上下文。实施 Agent 不得更新 Issue、提交或推送（详见 `scripts/ralph/README.md`）

### 关键文档索引

| 文档 | 路径 | 内容 |
|---|---|---|
| 产品需求 | `docs/PROGRAM_PLAN.md` | PRD 2.0 功能边界 |
| 技术架构 | `docs/ARCHITECTURE.md` | 决策摘要、数据模型、工作流设计 |
| 工作流契约 | `docs/WORKFLOW_CONTRACTS.md` | 四类工作流的 Schema 定义 |
| 实现纠偏 | `docs/IMPLEMENTATION_CORRECTION_PLAN.md` | 8 阶段纠偏方案（当前状态基线） |
| 差距审计 | `docs/IMPLEMENTATION_GAP_AUDIT.md` | 已实现 vs 未实现功能清单 |

### 当前未完成项（纠偏计划核心断点）

1. **工作流调度器**：`queued` 状态的 WorkflowRun 不会被进程内执行器自动领取和执行
2. **专题文档生成**：`POST /v1/topics/:id/documents` 的 JSON 解析存在缺陷（空 body 时报错），且工作流未真正调度
3. **近期整理聚类**：无 Model Gateway 时 `cluster_materials` 步骤被跳过，产出 0 clusters
4. **UI 专题详情**：专题详情页缺少成员管理、文档生成入口、版本历史展示
5. **旧模型退出**：`KnowledgeItem`、`ReviewProposal`、`Relation` 仍存在于 Store 接口和 SQLite 中，待阶段 8 清理

## 编码规范

以下规则源自本项目多次真实 bug 的排查。**新增或修改代码时必须逐条检查。**

### 规则 1：safeStorage 必须降级处理

`safeStorage.isEncryptionAvailable()` 可能返回 false 或抛异常。

- 读写 safeStorage 时必须 try/catch + fallback（明文存储 / 返回 undefined）
- 读写 safeStorage 管理的文件时，必须处理四种组合：文件是否加密 × safeStorage 是否可用
- 禁止 `if (!isEncryptionAvailable()) throw`，这会导致应用崩溃

### 规则 2：IPC 变更三步同步 + 重启验证

新增或修改 IPC 通道时，必须同时修改三个文件：
1. `preload.cts` — 暴露方法
2. `main.ts` — 注册 `ipcMain.handle()` / `ipcMain.on()` 处理器
3. `desktop-bridge.d.ts` — 更新类型声明

遗漏任何一步 = 前端调用静默失败。修改后必须**完全退出 Electron 再重启**（`npm run dev:desktop`），热重载不会加载新的 preload / main 代码。

### 规则 3：禁止静默 catch

```typescript
// ❌ 禁止：catch { /* 注释 */ } — 这是 bug 温床
try {
  const data = await fetchData();
  if (data) render(data);
} catch { /* no data yet */ }  // ← 真正的"无数据"走这里，但什么都没做

// ✅ catch 块必须有明确的降级处理
try {
  const data = await fetchData();
  render(data);
} catch {
  renderEmptyState();  // ← 显式重置
}
```

**为什么**：本项目后端 API（如 `getLatestRecentClusterSnapshot`）在"无数据"时抛 `NotFoundError`（HTTP 404），而不是返回 `null`。所以 `if/else` 的 `else` 分支是死代码，真正的无数据路径在 `catch` 里。静默 catch = UI 保留旧状态。

### 规则 4：条件 UI 元素必须幂等 + 每次进入时重检

```
"先删旧的，再按当前状态决定是否加新的" — 每次 tab 切换、数据刷新时都执行
```

- 检查函数提升为模块级 `export`，不放在 `setupXxx()` 内部
- `shell-renderer` 的 `switchTab` 中，已初始化的 tab 也要调检查函数
- 禁止依赖 `shell.initialized[tab]` 作为"不需要再检查"的依据

### 规则 5：clearAllData 存储层一致性

清除数据时，所有存储位置必须保持一致。

- 如果 API Key 文件（safeStorage）被保留 → SQLite 中的 `ai_consent`、`deepseek_configured` 也必须保留
- 如果凭证 token 被保留 → 相关配置标志也必须保留
- `DELETE FROM settings` 全量删除 = 制造矛盾状态

### 规则 6：代码变更生效验证协议

当"改了和没改一样"时，按顺序逐层排查：

1. **源码确认**：`grep` 搜索修改内容，确认源文件确实改了
2. **产物确认**：`grep` 搜索 `dist/` 目录，确认构建产物包含修改
3. **路径确认**：检查 Electron `loadFile` 指向的目录是否是 `dist/`
4. **编译缓存**：若 `dist/` 仍是旧代码 → `Remove-Item tsconfig.tsbuildinfo` 后重新 `npm run build`
5. **执行确认**：修改的代码路径是否真的会执行？（重点检查 catch/throw 路径、初始化标记、条件分支）
6. **后端确认**：被调用的后端 API 在边界情况下实际返回什么？（读后端源码，不要猜）

> 80% 的"改了没效果"问题出在第 5 步——代码改了但运行时根本没走到那个分支。

### 规则 7：Electron Renderer 约束

- **CSP**：禁止内联事件处理器（`onclick="..."`），必须用 `addEventListener`
- **DOM 空值**：`querySelector` 结果可能为 `null`，必须先判空再操作
- **表单三态语义**：保存接口必须区分 `undefined`（保留旧值）、`""`（清除）、有值（保存新值）。前端用 `.trim()` 而非 `|| undefined` 传值

