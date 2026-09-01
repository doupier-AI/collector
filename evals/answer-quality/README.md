# Answer Quality Evaluation

`@collector/answer-quality-evals` 是 Collector 的跨任务回答质量评测 Module。它依赖生产 Module 的公开 Interface；`apps/*` 与 `packages/*` 不得反向依赖本目录。

## 当前 Interface

- `ANSWER_QUALITY_CORPUS`：版本化跨任务案例集，当前包含 70 个案例、10 个任务族和 7 类鲁棒性切片。
- `productionScenarioFromCase`：以显式白名单从案例生成生产输入；案例期望、参考答案、Rubric 与 must-cover/must-avoid 不会进入生产调用。
- `runFixedProviderCase`、`evaluateReplay`、`runRealModelBlindAB`：分别执行固定 Provider、离线回放和注入式真实模型盲化 A/B。
- `evaluateCapabilityFacts`：分别连接 Case expectation、Build capability、Run availability、Run execution 与 Release requirement，不合并事实所有权。
- `buildJudgeInput`：只向 Judge 提供用户请求、显式设置、最终正文、已准入证据和有效引用。
- `ReleaseQualityModule.evaluate(...)`：在版本化 Release Profile 后连接五类事实，按固定优先级输出互斥 `primaryOutcome`，并保留全部次级 `findings[]`、不可平均切片、重复稳定性、成本和延迟。

现行 `aq-release-profile-v1` 包含三层 gate：

- `quick`：10 个快速代表案例，以 FakeProvider 穿过生产 Interface；
- `full_offline`：完整 70 案例离线可复评报告；
- `release_candidate`：固定真实模型、基线/候选相同案例与上下文条件、Profile 声明的两个不同 Prompt profile、三次新运行、A/B 顺序交换、人工校准、成本与延迟，以及 `aq-long-form-gate-v1=not_activated` 裁决。基线使用不含显式格式翻译的冻结 Final Writer profile，候选使用当前 profile；除此之外授权、上下文、证据和模型配置一致。

三次真实 A/B 至少形成 `2/3` 重复共识，展示顺序不一致最多允许 `1/3`；胜负与持平分别报告，同配置运行不要求虚构候选胜出。

每个受 Profile 判定的案例只产生一个 `primaryOutcome`：`not_applicable`、`build_capability_missing`、`run_unavailable`、`identity_missing`、`execution_failed`、`not_verified`、`semantic_quality_failed` 或 `passed`。Evaluator 按该顺序选择第一个成立的结果；并发问题继续保留在 `findings[]` 中。

## 运行

```powershell
npm.cmd run eval:answer-quality -- --mode=offline
npm.cmd run eval:answer-quality -- --mode=fixed
npm.cmd run eval:answer-quality -- --mode=real-ab
npm.cmd run eval:answer-quality:release
npm.cmd run eval:answer-quality:real
```

离线与固定 Provider 模式不需要 API Key。没有外部运行器或 Judge 凭据时，真实模型模式返回 `unverified`，不产生绿色结论。

`npm.cmd test` 会运行 quick Profile；修改 Prompt Envelope、预算、Conversation Context、Answer Plan、ContextAssembly、证据准备、引用归因、供应商 Adapter 或评测 Module 时，远端 gate 额外运行完整离线 Profile 和适用确定性探针。候选发布还必须运行真实模型 Release Profile 与完整 `npm.cmd run gate`，二者绑定同一候选 SHA。

长文跨节状态的真实模型强制裁决使用已冻结的预注册包，并只读消费指定数据库中的当前 Provider 配置：

```powershell
npm.cmd run eval:long-form-gate -- --database=<collector.sqlite 的绝对路径>
```

该命令固定执行三类候选各三次，并把 Answer Plan、ConversationContext、ContextAssembly、预算、usage、成本、首字/完整延迟、盲化对比和唯一 `activated` / `not_activated` 结论写入未存在的结果文件；不会保存 Provider 凭据，也不会在观察结果后追加样本。

当前冻结裁决 `aq-long-form-gate-v1` 为 `not_activated`，完整证据位于 `decisions/aq-long-form-gate-v1-result.json`。生产链不启用 LongFormState；候选发布通过现行 Answer Plan、ContextAssembly、Prompt Envelope、模型预算和 Final Writing 验证长文。Final Writing 把已准入的显式格式代码转换为具体正文结构，不向用户输出内部格式代码。

## 人工校准

人工复核文件位于 `reviews/aq-corpus-v1-human-review.json`。它包含 20 个盲化样本，覆盖 10 个任务族；每个样本只展示评分维度以及 Judge 可见的用户请求、显式设置、最终正文、已准入证据和有效引用，不展示评测器结论或案例期望。

复核人只修改以下字段：

- 根级 `reviewer`：填写可识别本次复核人的名字或代号。
- 根级 `reviewedAt`：填写 ISO 8601 时间，例如 `2026-08-31T20:00:00+08:00`。
- 每个样本的 `humanVerdict`：只针对该样本标明的 `layer` 和 `dimension` 判断，填 `pass` 或 `fail`，不要改成对整篇回答的综合评分。
- 每个样本的 `rationale`：填写仅基于当前可见输入的判断理由。

不要修改样本身份、评分层、评分维度或 `judgeInput`。完成全部 20 条后运行：

```powershell
npm.cmd run eval:answer-quality -- --mode=human-calibration --review=evals/answer-quality/reviews/aq-corpus-v1-human-review.json
```

工具只有在复核人、时间、全部标签和理由齐全，且样本内容未经改动时，才输出 `human_reviewed` 以及一致率、假阳性、假阴性和分维度偏差。在此之前，校准状态保持 `pending_human_review`。

当前语料版本的已完成人工判断保存在 `reviews/aq-corpus-v1-human-review.json`，可复算报告保存在 `reviews/aq-corpus-v1-human-calibration-report.json`。报告必须与上述命令的输出完全一致。

案例版本变化时可以生成新的盲化文件；输出路径必须不存在，避免覆盖已经填写的人工判断：

```powershell
npm.cmd run eval:answer-quality -- --mode=prepare-human-review --output=evals/answer-quality/reviews/<new-review-file>.json
```
