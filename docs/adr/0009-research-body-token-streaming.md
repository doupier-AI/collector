# 真实模型逐字流式生成：事件联合 provider 契约 + 网关 trim 不变量

2026-08-04 用户确认（方案 B）：借 ADR-0008 生成自由化移除"模型返回 `slices[]` JSON"旧契约的契机，**第一次**给真实模型加真正的 token 级逐字流式。此前 Collector 从未存在过真流式：旧真实模型路径拿到完整正文后一次性落库；旧 `generate` 桥接只是把一段**已完整**的答案切成 80 字小块"伪流式"回放。生成自由化让模型不再被"必须返回完整 JSON"绑死，真流式才成为可能（#14）。

**决策：**
- **provider 流式契约 = 可区分联合事件的 async generator**（不是纯 string、不是回调）。`ModelProvider` 新增可选 `completeStream(request): AsyncIterable<ModelProviderStreamEvent>`，事件为 `{type:"delta",text} | {type:"done",model,usage?}`。理由：token usage 只在各厂商**终帧**到达（OpenAI 兼容在 `stream_options.include_usage` 的最后一帧、Responses 在 `response.completed`、Gemini 在终帧 `usageMetadata`、Anthropic 在 `message_delta`），`done` 事件把 usage 带外承载，保住网关 `emitCall` **恰好一次**的成本记账；async generator 契合仓库既有惯例（`provider.generate` 已是 `AsyncIterable<string>`），背压与错误传播自然。
- **共享 SSE 解析器只解信封**：`iterateServerSentEvents` 处理空行分帧、多 `data:` 行 `\n` 拼接、`event:` 捕获、`:` 注释、TextDecoder 流式缓冲（多字节字符不被切断）；`data:[DONE]` 等厂商终止标记留给各 provider 判断。
- **能力检测用结构守卫**，不加 `canStream` 标志：`typeof provider.completeStream === "function"`。缺 `completeStream` 时网关退回非流式 `complete()` 并 yield 单个 trimmed delta——API 层因此只有**一条**代码路径。
- **trim 不变量由纯函数 `trimStream` 保证**：`writeResearchBody` 对终稿 `.trim()`、`finalizeDerivedSlices` 从 trimmed 文本派生块；流式若 yield 原始 delta，`concat(deltas) ≠ trimmed(content)` 会使持久化正文与派生偏移分叉。`trimStream` 抑制前导空白、暂存尾随空白串（仅在后续非空块到达时冲刷、末尾丢弃），保证 `concat(yielded) === concat(input).trim()`，段落间 `\n\n` 完整保留。
- **网关 `writeResearchBodyStream`**：对 API 层只 yield **text delta**；内部捕获 `done` 的 usage/model，循环结束后 `emitCall` 恰好一次，拼装 trimmed 正文为空则抛与 `writeResearchBody` 相同的错误。
- **范围刻意收敛**：plan-then-write 长文保持**节级** append（节级粒度足够，逐节 token 流列为后续）；grounding 分支（`generateAgentGrounded`）保持**单发**（agent 循环中间文本非有效输出）；完成语义不变（delta 循环 → `finalizeDerivedSlices` 跑在全量累计正文上 → `completeResearchTask`）。

**Why:** 用户可见结果——AI 回答在研究节点页**逐字生长**（而非一次性出现），长文写作过程可视，刷新/中断恢复仍完整。前端本就流式就绪（SSE `delta` → `upsertMessage` 整体替换；`GeneratingBody` 渲染生长中的 `message.content` 为 Markdown + "正在生成"），零重设计。后端只需反复调既有 `appendResearchTaskDelta`（置 streaming 状态 + 插 delta 事件 + 追加正文）即可驱动渐进 UI。

**Consequences:** 传输层 4 个真实 provider（OpenAI 兼容/DeepSeek、OpenAI Responses、Gemini、Anthropic）与 FakeProvider 各实现 `completeStream`，按各自 SSE 协议解析 delta + 终帧 usage；AbortController 总超时横跨整流（沿用 `timeoutMs ?? 120_000`，idle-reset 列后续）。任务重试清空 `message.content`，流式中失败+重试从空正文干净重启。e2e 假模型 `writeBodyStream` 与 `writeBody` 拼接结果逐字节一致，派生块/卡片不变。旧 `generate` 伪流式回放被真流式取代。

**决策纪律：** 流式与完成态渲染的**段落分隔差异**必须由测试显式归一化再比较——中段 `GeneratingBody` 是单一 Markdown 容器（`\n\n` 在 `textContent` 里保留为 `\n`），完成态各切片卡片是独立 `message__content`（拼接不含换行）；e2e 断言两侧都 `replace(/\n+/g,"")` 后比对，禁止只 `trim()`（去不掉正文中间的 `\n`）。
