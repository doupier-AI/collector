# 正文流、旁路增强、推理隔离与富内容协议研究

> Wayfinder 研究票据：[研究正文流、旁路增强、推理隔离与富内容协议](https://github.com/doupier-AI/collector/issues/111)
> 调研日期：2026-08-23。本文只整理候选模式与待验证风险，不构成产品或架构决定。

## 要回答的问题与结论摘要

这张票据要判断的是：模型输出能否保持自然、自由的 Markdown 正文，同时让导航、弱标记、联网引用、图片和运行状态可靠工作，而不是把这些功能的控制语法塞回模型正文。

结论是**可以，且应优先采用“正文流为主，段落级旁路增强，完成后全篇校验”的供应商无关协议**：

1. 可读正文只接收供应商明确标为最终文本/模型输出的内容块；它是唯一可读事实源，可自然使用 Markdown，绝不承载 `<think>`、工具 JSON、搜索草稿或弱标记控制串。
2. reasoning、工具调用/结果、引用、图片及章节/概念候选分别进入有类型的旁路事件或完成后产物。旁路失败只减少增强，不能回写、改写或阻塞正文。
3. 以“已关闭段落”而不是逐 token 作为稳定定位单位：正文每关闭一个段落就记录版本、块号和 UTF-16 范围；引用/标记/导航候选先绑定该版本与范围，最终完成后统一重算、校验或丢弃不能证明对齐的定位。
4. 原始 chain-of-thought（CoT）不是正文，也不是通用持久化对象。若供应商提供可展示摘要，只把它当可关闭、可清除的“推理摘要/状态”旁路；为续轮所需的加密 reasoning/thought signature 只保存为不可展示的供应商续轮令牌。

这保留了 Collector 已有的“正文唯一事实源”和 `reasoning` 旁路基础，但把“模型在正文嵌入弱标记”和“联网最终轮次 `content` 原样作为正文”从协议原则上拆开。当前代码审计也验证后一风险存在：`runAgentSearchLoop` 在 `finishReason === "stop"` 时直接返回 `response.message.content`；其测试夹具只提供干净最终回答，尚未覆盖“工具轮含工作草稿、最终轮含可见正文”的分离边界。

## 一手资料观察

### 海外 API

- **OpenAI Responses** 把文本增量、生命周期完成和错误作为不同 SSE 事件（例如 `response.output_text.delta`、`response.completed`、`error`），不是要求应用从一个混合字符串猜测语义。[官方流式指南](https://developers.openai.com/api/docs/guides/streaming-responses)
  推理摘要须显式请求，作为 `reasoning` 输出项的 `summary` 返回；无状态续轮的 reasoning 则可携带 `encrypted_content` 供后续调用，不等价于可读正文。[官方 reasoning 指南](https://developers.openai.com/api/docs/guides/reasoning)
- **Anthropic Messages** 用带 index 的 content block 事件流分离 `text_delta` 与 `input_json_delta`（工具参数）；工具调用、服务端工具结果与文本可在同一轮依序成为不同内容块。[官方流式事件规范](https://platform.claude.com/docs/en/build-with-claude/streaming)
  启用 citations 后，响应内每个 text block 可带来源位置，如文档字符范围；自定义 document content 让调用方保留自己的分块粒度。[官方 citations 文档](https://platform.claude.com/docs/en/build-with-claude/citations)
- **Gemini Interactions** 是最接近目标形态的显式 step 流：`model_output`、`thought`、`function_call` 和服务端工具步骤各自有 `step.start/delta/stop`；完成事件还报告总输出、工具和 thought token 用量。[官方 streaming 文档](https://ai.google.dev/gemini-api/docs/streaming)
  它可在 `model_output` 步骤中发送 text、image、audio；thinking summary 和不可读的 thought signature 又是独立 delta。续轮时，状态模式由服务端管理；无状态模式必须原样回传 thought/tool signature，不能修改它们。[官方 thinking 文档](https://ai.google.dev/gemini-api/docs/thinking)
- **Gemini 结构化输出** 能流式传送可拼接为完整 JSON 的片段，但这仍是面向提取、分类和工具输入的模式；把用户阅读正文也锁为 JSON 会牺牲 Markdown 自由度，因而适合作为“完成后注释/计划”调用，而非默认正文调用。[官方 structured output 文档](https://ai.google.dev/gemini-api/docs/structured-output)

### 大陆模型与开源实践

- **Qwen3** 的混合模型使用 `<think>…</think>` 区隔思考和普通回答；旧版模型可通过 chat template 的 `enable_thinking` 或 `/think`、`/no_think` 切换。官方同时说明推理解析为 `reasoning_content` 的方法与 OpenAI 兼容 API 并不完全兼容。[Qwen3 官方推理文档](https://github.com/QwenLM/Qwen3/blob/main/docs/source/inference/transformers.md) [Qwen3 官方 vLLM 部署文档](https://github.com/QwenLM/Qwen3/blob/main/docs/source/deployment/vllm.md)
  因此 `<think>` 只能被适配器识别为供应商传输格式，不能成为 Collector 正文格式或靠字符串删除的安全边界；应优先请求非思考模式或使用可配置的供应商 reasoning parser，把 reasoning 与 final content 分开产出。
- **RAGFlow（Infiniflow）** 是来自大陆的开源 RAG 实践。其官方快速开始文档把文档解析、可检查/可人工修改的 chunk、检索测试与“truthful citations”组织成独立层；同一问答可基于一个或多个数据集。[RAGFlow 官方 quickstart](https://github.com/infiniflow/ragflow/blob/main/docs/quickstart.mdx)
  其官方 retrieval tool 代码同时输出供模型使用的格式化内容和结构化 JSON chunk 列表，并把引用记录交给 canvas；这说明“给模型的上下文”和“给界面/追溯用的结构化证据”可并存，而无需把二者混入用户正文。[RAGFlow 官方 retrieval tool](https://github.com/infiniflow/ragflow/blob/main/agent/tools/retrieval.py)

## 模式比较

| 维度 | OpenAI Responses | Anthropic Messages | Gemini Interactions | Qwen3 / 自托管 | RAGFlow 开源实践 | 对 Collector 的含义 |
| --- | --- | --- | --- | --- | --- | --- |
| 用户可见正文 | `output_text` 事件/内容项 | `text` content block | `model_output` step 的 text/image/audio | 取决于 chat template；可能混入 `<think>` | LLM 输出与检索结果分层 | 只接受明确的 final-text 类型，不把整轮对象转字符串 |
| 推理/摘要 | 可选 summary；续轮可有 encrypted reasoning | thinking block；可请求 summarized display | thought summary 与 signature 独立 | `<think>` 或 `reasoning_content` 依部署而异 | Agent/工作流运行记录，不规定模型 CoT | 统一成 `reasoning-summary` 与不可展示 `continuation-token` 两类 |
| 工具事件 | Responses output/工具项 | content block 的 `tool_use` / result | `function_call`、服务端工具 step | 工具格式/解析器依实现 | retrieval 输出 JSON chunks 与格式化上下文 | 工具调用和工具结果永不写进 `body` |
| 引用/注释 | 输出文本 annotations（供应商能力不同） | text block citations，支持来源字符范围 | grounding metadata/segment（适配器已消费旧 API 形态） | 无统一标准 | chunk/source 可追溯 | 存为正文版本 + 块/范围 + 来源 ID；无法校验即不显示精确标记 |
| 结构化元数据 | 输出项/工具参数可类型化 | block index 和 typed delta | step/event 有类型；JSON schema 可流式 | 多依赖模板、vLLM/SGLang parser | chunk JSON、工作流产物 | 用独立 sidecar schema，不把正文强制为 JSON |
| Markdown/图片 | 文本可承载 Markdown；图片为独立响应能力 | text 可含 Markdown；图片是 content block 输入/输出能力 | text 与 image delta 同一 model-output step | 模板文本为主，媒体协议随 serving stack | 文档快照/chunk 另存 | Markdown 是正文语法；图片是具 MIME/来源/生命周期的内容块 |
| 流式与完成 | SSE 生命周期清晰 | block index + start/delta/stop | interaction/step 生命周期最完整 | 常为 OpenAI 兼容 SSE，语义不保证 | 支持流式产品能力，具体链路框架自定 | Collector 需自己的事件归一化与最终快照，不能透传供应商事件 |
| 重启/续轮 | 可依 response state 或 encrypted item 重放 | 需保留合法 message/block 历史 | stateful ID 或无状态完整 thought/signature 重放 | 依服务端/模板，移植风险高 | 有自己的任务/文档状态 | 正文、旁路快照与供应商续轮物分开持久化；后者不可跨供应商假定可用 |
| 成本/延迟 | reasoning token 与正文不同预算 | thinking/工具会延后最终文本 | usage 显示 thought/tool/output token，thought 另计费 | 本地推理时间与 parser/上下文配置强相关 | 解析/检索与生成分开成本 | 首字时间、正文 token、reasoning token、工具时间、增强时间分别观测 |
| 锁定风险 | 事件名与 output item 形状专有 | content block/citation 形状专有 | step、signature、schema 方言专有 | 模板与推理解析器版本耦合 | Python/Docker/检索栈耦合 | 适配器归一化为内部事件；原始 payload 只做脱敏诊断，不做业务契约 |

## 推荐的候选协议：body-first paragraph-sidecar

以下为供后续原型验证的**候选**内部形状，不是本票据作出的公共 API 决定。

```text
provider event
  ├─ final text/image delta ────────> body stream / media sidecar
  ├─ reasoning or summary ──────────> reasoning-summary sidecar
  ├─ tool call/result/status ───────> run-event sidecar
  ├─ provider citation/annotation ──> evidence sidecar
  └─ unknown/malformed ─────────────> redacted diagnostic; never body

body stream closes a paragraph
  └─> bodyVersion + blockOrdinal + [start, end)
        ├─ incremental safe-to-render text
        └─ pending annotations keyed by version/range

completed
  └─> normalize → validate boundaries/Markdown projection → persist final body
        └─> accept valid sidecars; drop or downgrade invalid precision
```

### 1. 正文通道

- `body.delta` 只容纳适配器已经分类为 final textual output 的 Unicode 文本；聚合后仅做现有确定性首尾空白策略，不做“移除思考”“删除搜索字样”等关键词清洗。
- 每次形成空行、标题闭合或流结束时，切出候选段落块。块记录 `bodyVersionId`、`blockOrdinal`、UTF-16 `[start,end)` 与完整性状态（`open`/`closed`/`final`）。正文依然允许表格、代码块、列表、普通标题和图片 Markdown；它们不是导航或弱标记的控制协议。
- 恢复时先重放已确认正文/块；正在生成的未闭合块可作为临时显示，断流后由任务状态决定续写或保留部分正文。任何旁路缺失都不应使正文消失。

### 2. 旁路通道

- `reasoning-summary.delta`：只接受供应商明确提供且产品允许展示的摘要。原始 CoT、加密 reasoning 和 thought signature 进入 `continuation` 私有存储或根本不存，绝不进入消息 `content`、弱标记、搜索索引、导出或普通诊断日志。
- `run-event`：统一记录工具请求、工具完成/失败、重试、provider 状态和非敏感用量；界面最多显示“正在检索/已找到 N 个来源”等状态。工具结果是模型上下文和审计证据，不是用户答案。
- `evidence`：保留 `sourceId`、供应商 ID（若有）、正文版本、块号、范围、定位可信度和来源状态。供应商仅给最终范围时先挂起到完成后；范围跨越 Markdown 投影、越界或无法映射时降级为“该回答有来源”而非错误的精确角标。
- `annotation`：章节候选、弱标记候选、可读摘要、图片说明都与 `bodyVersionId` 绑定。对首段可在段落闭合后异步产生；对全文质量问题只在完成后校验。失败时保存明确空结果/失败原因，不能回落到词法猜测并污染正文。
- `media`：图片应有独立 `mediaId`、MIME、来源/授权、可复取位置、文本替代描述和生命周期；文本 Markdown 内的远程图片链接只是一种展示引用，不能被当作已托管的二进制媒体。

### 3. 最终校验与降级

完成帧不是“把任意本轮 `content` 交给界面”的许可，而是一次提交点：聚合 final body，冻结 body version，校验所有 range、来源和模型元数据，再写入可恢复快照。失败策略应按信息价值降级：

| 失败 | 正文 | 引用/导航/弱标记 | 运行与恢复 |
| --- | --- | --- | --- |
| 旁路模型标注超时或 JSON 无效 | 保留 | 标记该块无增强；不改写正文 | 记录可重试的注释任务 |
| 提供商引用范围无法映射 | 保留 | 丢弃精确范围，可保留经验证的来源列表 | 保存 provider citation ID 与原因 |
| 工具轮次有 `content` | 不显示为最终正文 | 无 | 作为受限 run event/诊断，必要时脱敏 |
| 模型将 `<think>` 混入 final text | 不靠关键词剥离后继续展示 | 无 | 标记适配器协议失败，切换/禁用该 provider 模式并保留安全诊断 |
| 流中断/重启 | 保留已确认块 | 未确认范围先 pending 或清除 | 通过任务断点及 provider-specific continuation 恢复；不把 token 串当跨供应商断点 |

## 反例、代价与边界

1. **“一个结构化 JSON 同时装正文、标题、弱标记、引用和图片”。** 它给解析带来表面确定性，却限制表格/长文/自然 Markdown，流中 JSON 常不完整，任一字段错误都可能拖住正文。只应在小型后处理任务中使用 JSON schema。
2. **在正文嵌入弱标记或引用控制串并靠清洗器还原。** 这将模型表现、正文偏移和 UI 功能耦合；任何漏闭合、模型模仿、代码块/转义和多供应商格式变化都会破坏定位。它可以是迁移期输入兼容器，不能是目标正文协议。
3. **把提供商/Agent “结束轮次”的任意 `content` 当作 final answer。** 工具中间解释、搜索草稿和推理都可能合法存在于该字段；仅 `finishReason` 不是可展示性的证明。必须由适配器根据事件/块类型、结束原因和任务状态建立 allowlist。
4. **把原始 CoT 当作学习说明或永久记忆。** 即使供应商技术上发送 thinking 文本，也可能包含工具参数、检索片段、脆弱推理或供应商约束，且续轮可能依赖不可修改的签名。面向用户的解释应由“解释/依据摘要”产品字段承接，而不是原始 reasoning 的副本。
5. **将 provider 的恢复 token 归一化为共享历史。** OpenAI encrypted reasoning、Gemini thought signatures、Anthropic block history、Qwen 模板 token 都有不同语义。需要同时保存可读的 Collector 正文/消息历史和受版本、供应商、模型绑定的 continuation artifact；切换提供商时只复用前者。

## 给 #114 的待决定事项

本研究不替用户作决定；后续“决定正文、联网证据、章节导航与弱标记的责任边界”至少需要逐项决定：

1. **正文与即时性**：章节导航、弱标记是否仅在段落关闭后出现，还是允许 open 块显示“待校验”的临时增强？推荐前者作为默认，后者只在能稳定锚定时增强。
2. **推理可见性**：现有 ADR-0035 的“思考过程可回看”是否保留为原始文本展示、改为供应商摘要、改为工具状态，还是按供应商能力分别关闭？这是用户可见行为变化，不能由本研究静默决定。
3. **联网 agent 的最终正文准入规则**：哪些事件/消息类型可以成为 final body；工具轮 `content` 是否永远不可见；没有可靠 provider final-text 事件时是请求一次专门的定稿轮，还是呈现明确失败？推荐 allowlist + 专门定稿轮，禁止关键词删除。
4. **引用精度与降级文案**：范围不可校验时显示来源列表、块级来源还是完全不显示？来源清单与正文的关系如何让用户理解而不制造虚假精确性？
5. **弱标记职责**：现有流内标记是否过渡到事后/段落级 sidecar；过渡期间旧控制串如何兼容、何时删除；标记失败是否允许任何词法回退？推荐新正文零控制串、旧数据只读兼容。
6. **图片阶段边界**：第一阶段只支持 Markdown 和可追溯来源图片，还是同时接受生成图像二进制流？推荐先前者；后二者需另定存储、许可、配额和恢复协议。
7. **持久化与隐私**：reasoning summary、工具结果、原始 provider payload、加密 continuation artifact 各自的保留期、导出规则、删除行为与脱敏边界。
8. **跨供应商能力基线**：内部适配器最小必须提供哪些事件（final body、done、failure、usage、tool status），各供应商特有能力如何作为可选 sidecar 暴露而不污染共享契约。

## 原型前必须验证的风险

- 用同一组普通回答、长文、深入研究、供应商原生联网、Agent 联网、融合、暂停/继续/停止和重启恢复夹具，验证 `concat(body.delta) === finalBody`，且 finalBody 为零思考控制串、零工具 JSON、零工作草稿。
- 对中文、英文、Emoji、组合字符、Markdown 表格、代码块、链接和流内图片分别检查 UTF-16 范围、渲染投影范围与重启后范围；供应商 offset 的单位不同或范围只在最终帧出现时不得猜测。
- 注入“工具轮含自然语言草稿”“最终轮空文本”“tool call 与文本同轮”“reasoning 与 final text 同 SSE 包”“错误 annotation”和“Qwen `<think>` 残留”六类夹具，验证 body allowlist 和降级行为。
- 独立记录首字时间、首段关闭时间、完成时间、正文/推理/工具 token、旁路标注延迟和失败率；否则无法判断旁路是否真的改善体验而非仅把等待移到后台。
- 验证恢复：Collector 重启后正文及已确认旁路一致；供应商续轮令牌仅对原 provider/model/版本使用；切换模型时诚实降级为重新生成或仅使用可读历史。

## 对当前实现的最小影响判断

当前项目已有相符基础：正文版本与语义片段由正文确定性派生，引用使用正文块/偏移，`onReasoning` 不进入正文流；OpenAI、Anthropic 和现有 Gemini grounding 适配也已经分别抽取引用范围。它们应被当作未来旁路协议的迁移基础，而不是要求模型继续按流内控制标记写作的理由。

本票据没有建议立即修改代码、共享契约或 ADR。真正实施前应先由 #114 明确上面的用户可见边界，再以原型验证决定是否需要新事件类型、迁移和历史数据策略。
