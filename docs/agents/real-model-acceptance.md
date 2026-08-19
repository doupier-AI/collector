# 真实模型验收

真实模型验收使用真实模型配置验证回答质量与恢复行为，与确定性套件分工。配置与安全约束如下；快速失败约定、失败重跑粒度等执行纪律见 `docs/agents/testing.md`。

## 模型配置

- 真实模型验收默认读取本机 `.collector-data/collector.sqlite` 中已保存且可用的模型配置；当前验收优先复用 DeepSeek `deepseek-v4-flash` 配置（2026-08 当前环境状态，配置变化时更新本行）。
- API Key 只保存在本机持久化配置中，不写入 `AGENTS.md`、源码、Git 提交或对话；`AGENTS.md` 只记录读取规则，不作为运行时配置来源。
- `apps/web/e2e/acceptance-real-harness.mjs` 启动时会读取这份配置；Playwright 的每个测试场景各自创建临时数据目录、数据库和 harness 进程，场景重启只复用自己的目录，不共享业务数据。环境变量仅作为明确的临时覆盖。
- 在 worktree 或非主目录位置运行验收时，harness 默认找不到主目录 `.collector-data` 的已保存模型配置，需以 `COLLECTOR_REAL_MODEL_DATABASE` 指向主目录 `.collector-data/collector.sqlite`（只读配置；验收运行数据仍使用独立临时库）。
- 若本机尚未保存模型配置，先在 WebUI 的“AI 模型设置”中保存并启用，再运行真实模型验收。

## 并发与端口

- 验收默认 `fullyParallel` 且使用 2 个 worker；可用 `E2E_ACCEPTANCE_WORKERS=1..64` 调整。每个测试使用 `E2E_API_PORT + parallelIndex`，因此实际占用的是从基准端口开始、长度等于 worker 数的连续端口范围。
- 每个场景启动前同时校验端口可绑定、自身 readiness 文件中的进程号和 `/health`；已有健康服务不能冒充当前场景。结束和重启只停止本场景进程，进程退出与临时目录清理失败均会令测试失败。
- 无模型场景使用同一套 runtime fixture，但会清除所有模型凭证与供应商覆盖，不读取持久化模型档案，并核对数据库中没有模型档案、凭证、激活标志或模型调用。
- 弱标记场景五至九可跨 worker 并行；每个场景原子写入一份运行证据，依赖项目在全部主场景完成后汇总校验“五个场景恰各一份且总标记数大于零”。

## 模型行为改动探针先行

**条件性必须**：调整提示词、token 预算、模型参数等会改变真实模型行为的改动，必须先跑适用的直连探针（`scripts/probe-*.mjs`，分钟级出结果）确认原始输出符合预期，再进入真实模型验收（单场景十几分钟起）。

## 夹具前提自检

验收/探针的客观前提在启动期由代码保证，条件不满足即报错并说明原因，不靠运行期轮询停滞判死兜底：

- 夹具内容条件（长文阈值、场景必需片段）：`z-acceptance-real.spec.ts` 的 `test.beforeAll` 在服务启动前经 `helpers.ts` 的 `assertLongTextFixture` / `assertFixtureContains` 检查，阈值与服务端触发判定同源（`LONG_TEXT_CHAR_THRESHOLD`）；
- 模型配置 / 前端构建 / 端口：`acceptance-real-harness.mjs` 启动自检（缺配置即退出码 2 并说明原因），spec 侧对 harness 启动期退出即失败，不空等健康检查超时；
- 探针（`scripts/probe-*.mjs`）：读取不到模型档案或凭证即时报错并指出补救路径。

## 相关

- 验收长跑与日常确定性验证并行的端口分配：`docs/agents/parallel-development.md`。
- 快速失败约定与失败重跑粒度：`docs/agents/testing.md`。
