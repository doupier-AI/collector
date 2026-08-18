# 真实模型验收

真实模型验收使用真实模型配置验证回答质量与恢复行为，与确定性套件分工。配置与安全约束如下；快速失败约定、失败重跑粒度等执行纪律见 `docs/agents/testing.md`。

## 模型配置

- 真实模型验收默认读取本机 `.collector-data/collector.sqlite` 中已保存且可用的模型配置；当前验收优先复用 DeepSeek `deepseek-v4-flash` 配置（2026-08 当前环境状态，配置变化时更新本行）。
- API Key 只保存在本机持久化配置中，不写入 `AGENTS.md`、源码、Git 提交或对话；`AGENTS.md` 只记录读取规则，不作为运行时配置来源。
- `apps/web/e2e/acceptance-real-harness.mjs` 启动时会读取这份配置，并为每次验收创建独立临时数据库；环境变量仅作为明确的临时覆盖。
- 在 worktree 或非主目录位置运行验收时，harness 默认找不到主目录 `.collector-data` 的已保存模型配置，需以 `COLLECTOR_REAL_MODEL_DATABASE` 指向主目录 `.collector-data/collector.sqlite`（只读配置；验收运行数据仍使用独立临时库）。
- 若本机尚未保存模型配置，先在 WebUI 的“AI 模型设置”中保存并启用，再运行真实模型验收。

## 模型行为改动探针先行

**条件性必须**：调整提示词、token 预算、模型参数等会改变真实模型行为的改动，必须先跑适用的直连探针（`scripts/probe-*.mjs`，分钟级出结果）确认原始输出符合预期，再进入真实模型验收（单场景十几分钟起）。

## 夹具前提自检

验收/探针夹具在启动期自检触发条件（导入内容是否达到长文阈值、模型配置是否就绪等），条件不满足立即报错并说明原因；不靠运行期轮询停滞判死兜底。

## 相关

- 验收长跑与日常确定性验证并行的端口分配：`docs/agents/parallel-development.md`。
- 快速失败约定与失败重跑粒度：`docs/agents/testing.md`。
