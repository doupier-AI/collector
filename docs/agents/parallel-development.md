# 并行开发

同一父 Issue 多子票据并行分派、或验收长跑与日常验证并行时的共享规则。共享上下文包规则经 2026-08-18 用户确认（#93/#94 复盘）。

## 并行分派共享上下文包

同一父 Issue 的并行子票据分派时，父会话生成 `docs/agents/<迭代>-agents-context.md`（环境前提清单：worktree 数据目录覆盖变量、图片渲染限制、并行端口分配；假模型响应清单引用；已读 ADR/契约摘要；共享契约包最小增量改动边界），随迭代归档。分派简报要求代理先读共享上下文包再开工，并把新发现的环境前提回写后补充分派。

## 并行轨道端口

确定性套件四个 harness 的端口基准可用 `E2E_PORT_BASE` 整体平移（占用 base+0..base+3，缺省 43211）。真实模型验收以 `E2E_API_PORT` 为基准，按 `base + parallelIndex` 占用连续端口；范围长度等于 `E2E_ACCEPTANCE_WORKERS`（缺省 2，可设 1–64）。并行安排时必须避开两套完整端口范围，而不是只避开各自基准端口；配置会在端口范围越过 65535 时启动失败。

## worktree 中的真实模型验收

worktree 或非主目录运行真实模型验收时的模型配置覆盖（`COLLECTOR_REAL_MODEL_DATABASE`）见 `docs/agents/real-model-acceptance.md`。
