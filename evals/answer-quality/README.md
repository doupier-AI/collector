# Answer Quality Evaluation

`@collector/answer-quality-evals` 是 Collector 的跨任务回答质量评测 Module。它依赖生产 Module 的公开 Interface；`apps/*` 与 `packages/*` 不得反向依赖本目录。

## 当前 Interface

- `ANSWER_QUALITY_CORPUS`：版本化跨任务案例集，当前包含 70 个案例、10 个任务族和 7 类鲁棒性切片。
- `productionScenarioFromCase`：以显式白名单从案例生成生产输入；案例期望、参考答案、Rubric 与 must-cover/must-avoid 不会进入生产调用。
- `runFixedProviderCase`、`evaluateReplay`、`runRealModelBlindAB`：分别执行固定 Provider、离线回放和注入式真实模型盲化 A/B。
- `evaluateCapabilityFacts`：分别连接 Case expectation、Build capability、Run availability、Run execution 与 Release requirement，不合并事实所有权。
- `buildJudgeInput`：只向 Judge 提供用户请求、显式设置、最终正文、已准入证据和有效引用。

## 运行

```powershell
npm.cmd run eval:answer-quality -- --mode=offline
npm.cmd run eval:answer-quality -- --mode=fixed
npm.cmd run eval:answer-quality -- --mode=real-ab
```

离线与固定 Provider 模式不需要 API Key。没有外部运行器或 Judge 凭据时，真实模型模式返回 `unverified`，不产生绿色结论。

`REFERENCE_CALIBRATIONS` 当前是 20 个静态参考标签，覆盖 10 个任务族；报告状态固定为 `reference_only_pending_human_review`。在独立人工复核前，不得把它表述为人类校准证据。
