# 长文生成的有界可靠性：断流续传、空节修复、截断续写与丝滑流式

2026-08-05 用户确认（#38）：研究长文生成（plan-then-write 逐节扩写 + 单轮逐字流式）在五个真实失败面上不可靠——①流式被整段总超时掐断（网关 `timeoutMs ?? 120_000` + 四 provider 各自固定总超时，token 持续到达也不重置）；②流式卡顿（token→SQLite 事务→SSE 端点 100ms 轮询成批捞走 + 前端对生长中 markdown 全量重渲染，无 rAF 批量）；③空节被 `.filter(Boolean)` 静默吞掉缺章；④单节截断（`finishReason==="length"`）不消费直接判失败；⑤重试不分类型、无退避。

**决策：**
- **只做契约安全解析与有界修复**：可检测的确定性失败面（空/纯空白正文、长度超限、截断、未解析的结构化输出、切断）做有界修复；**绝不引入任何运行时内容质量评分/门槛/覆盖度/连贯性判断**（延续 ADR-0004）。正文无条件展示与保存，质量由用户判断。
- **断点续传两条链路都做**：plan-then-write 节级 `partialContent`（保留式重试从首个未完成节续扩，已完成节不调模型秒级重建）；单轮流式新增 `streamCheckpoint`（content+updatedAt，2s/2000 字节节流落盘），流切断后保留已写部分、重试从断点续传。**修复产生的新正文永远走 `deriveBodyVersion` 新版本**（contentHash 变化即新 id）重派生切片，绝不在原地改被引用的稳定版本。
- **重试/续写循环只放在 service 层 `research.ts`，绝不下沉进网关 `complete`/`writeResearchBodyStream`**——保住网关 `emitCall` 每次物理模型调用恰好一次记账；每次重入是一次独立物理调用。
- **分类退避重试**：`ModelProviderTimeoutError` / 网络 `TypeError` / `HttpError{429||>=500}` → retryable（指数退避+抖动，base 1s、封顶 30s、最多 3 次）；`HttpError{4xx≠429}` → fatal（跳过重试直接进降级梯子）；未知 → retryable（有界兜底）。退避经 `retrySleep` 注入可测。
- **空节不静默丢**：`writeLongFormBody` 收尾去掉 `.filter(Boolean)`，节未完成时以 `[本节生成失败：<heading>]` 标记入正文并继续后续节；**零节完成才整任务失败**。节失败/降级只记计数类日志（纯计数，非质量评估）。
- **截断续写**：非流式节扩写消费 `finishReason`——`"length"` 或无果断信号或触字符上限（每节续写 ≤3 次、空重问 ≤2 次）时带 `continuation.priorSectionContent` 续写；超上限降级（`targetCharsOverride:floor(target/2)` 单次再试），仍败→节失败标记。
- **丝滑推送 = 后端 pub/sub 即推 + 前端 rAF 批渲**：`ResearchSessionService` 的 `EventEmitter` 在每次落库后发**裸唤醒信号**（无事件载荷），SSE 循环 check-then-wait：先注册 waiter 再 drain，无事件时 `await`（≤15s keep-alive）而非 100ms 固定轮询；SSE 仍按 `sequence>cursor` 从 DB 重读——**DB 是恰好一次来源**，前端 id 去重是第二层。轮询仅留断线兜底。
- **前端 rAF 批渲**：`createDeltaBatcher` 只缓冲高频 `delta`，首次 push 调度一次 `requestAnimationFrame` flush（单次 `setState` 折叠整帧事件）；`completed/failed/snapshot` 等低频终态同步提交（先把已缓冲 delta 同步 drain 再应用终态），终态翻转不被延迟。
- **闲时计时器取代固定总超时**（流式）：`createIdleTimer` 每收到一个 SSE 事件 reset，长文不再因总时长被掐断；非流式 `complete()` 保持固定总超时。abort 中断 `for await` 被包成 `AbortError.cause` 时解包重抛 `ModelProviderTimeoutError`。grounding 分支（`generateAgentGrounded`）保持单发不动。
- **联网搜索保持单发**：本决策只覆盖研究正文生成的两条链路；agent 循环中间文本非有效输出，不在续传范围内。

**Why:** 用户可见结果——长文生成从"超时必断、断后重来、空节缺章、卡顿成块蹦字"变为有界可靠：断流/截断/空节都有确定的修复路径，正文持续可见、逐字丝滑生长，失败面有清晰的可恢复语义与标记，不再静默丢内容。

**Consequences:** 传输层 `ModelProviderResponse`/`ModelProviderStreamDone` 增加 `finishReason?`，四 provider 解析透传各自终止信号；`expandBodySection`/`writeResearchBodyStream` 增断点续写与 `onDone` 参数。重试语义从"清空正文干净重启"改为"有已完成节/非空断点时保留部分正文与事件流"（改写 ADR-0009 的"任务重试清空 message.content"）。SSE 端点的保活节拍从 100ms 轮询改为"信号即推 + 15s keep-alive"；离线轮询兜底保留。API 层需要 `resumeFrom`/`onStreamDone` 等透传（服务适配器）。真实 e2e 假模型补 `generateOutline`/`expandSection`（长文模式）与 `STREAM_CUT_AFTER`（脚本化断流）。

**决策纪律：** ①trim 不变量恒成立：`concat(yielded) === concat(input).trim()`（流式与非流式派生偏移一致），续写拼接用精确字符重叠去重（`joinContinuation`，minOverlap=8，不做模糊/归一化——契约安全、确定）；②测试只断言结构（含尾部子串/节标题/调用计数），不断言提示词具体措辞；③退避/续写/重问计数均有界，绝无无限重试；④断流续传只在"物理调用失败"（切断/超时/截断）时触发，不在每次 yield 之间落全量断点（`appendResearchTaskDelta` 已逐 delta 落正文，断点只标定续传边界）。
