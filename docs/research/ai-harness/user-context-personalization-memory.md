# 用户指令、画像、风格与记忆分层：研究结论

> 研究票据：[#112 研究用户指令、画像、风格与记忆分层](https://github.com/doupier-AI/collector/issues/112)；范围：为 Collector 的“统一上下文装配层”准备事实与待裁决问题，不构成实现设计、数据库设计或产品决策；方法：只采用产品官方文档、官方 API / 仓库和一手研究资料，覆盖海外产品（OpenAI、Anthropic、Google）与大陆产品（阿里云百炼 / Qwen）。访问日期：2026-08-23。

## 结论摘要

1. **“让模型记住用户”不是一个功能，而是至少七类来源。** 产品规则、用户长期指令、身份/兴趣画像、表达风格、节点与项目材料、保存记忆、聊天历史，以及当前问题的权威性、可见性和删除语义都不同。把它们合成一个“大提示词”会使用户无法知道哪条信息影响了回答，也无法可靠地停止影响。
2. **用户可配置提示词应是受边界保护的“用户指令层”，不是可编辑 system prompt。** OpenAI 的 API 明确区分并赋予 developer/system 高于 user 的指令优先级；Qwen 的官方 API 同样将系统消息用于角色、行为规则、风格与任务约束。这支持 Collector 保留产品安全、来源和工具规则的优先权，同时给用户可见、可关闭、可编辑的指令入口。[OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses-streaming/response/web_search_call)；[阿里云百炼 Chat API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)
3. **画像、风格与记忆必须分开。** 画像是相对稳定的自述属性（例如职业、兴趣）；风格只改变表达方式，不应改写事实、来源或工具行为；保存记忆是可管理的跨会话事实/偏好；聊天历史是可检索但不保证永久的证据库。OpenAI 明确区分 saved memories 与 reference chat history，且说明前者类似可持续使用的指令、后者不会记住每件事；阿里云也区分“记忆片段”和结构化“用户画像”。[OpenAI Memory FAQ](https://help.openai.com/en/articles/8590148-personalization-in-chatgpt)；[阿里云长期记忆 API](https://help.aliyun.com/zh/model-studio/long-term-memory-2-0)
4. **知识掌握假设不能写入普通长期记忆。** “用户会/不会某知识”是可过期、可被本轮表现推翻的学习推断，必须保留产生依据、置信度和复核规则；它既不是用户明确保存的偏好，也不是图谱节点关系。此结论与本路线图已确认的“长期记忆和知识掌握分离”一致。
5. **统一装配层应统一选择与审计，不统一存储含义。** 每次调用只在预算内选择最相关、最允许、作用域匹配的条目；回答侧拥有最终选择权，未来 RAG 只提交带来源的候选证据。当前代码已有父链与切片上下文的有界装箱、promptVersion 记录和模型调用运行记录，可作为迁移入口；它不等于已经有个性化或长期记忆能力。

## 一手产品证据：外部实践比较

| 产品 / 一手来源 | 明确区分的层 | 用户检查、编辑、删除与停用 | 对 Collector 的可迁移事实（不是照抄产品） |
| --- | --- | --- | --- |
| [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses-streaming/response/web_search_call) | developer/system 指令高于 user；输入还可含历史 assistant、工具输出和多模态内容。`previous_response_id` 不会自动继承上一轮 instructions。 | API 调用者可在每次请求提供 instructions；会话状态与 instructions 不是同一持久层。 | 产品规则必须与用户内容分层；每轮装配要显式，不能假设上一轮的系统规则或上下文自然延续。 |
| [ChatGPT Custom Instructions](https://help.openai.com/en/articles/8096356-chat-preferences-for-chatgpt) 与 [Characteristics](https://help.openai.com/en/articles/20001038-characteristics-in-chatgpt) | 长期自定义指令和“简洁度、语气、格式、emoji”等表达特征并存。 | 两者可随时编辑、删除或关闭；改动面向未来对话。 | “请按我的规则回答”和“活泼/务实”应是可单独关闭的不同控制项；风格不应伪装成任务约束。 |
| [ChatGPT Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq) 与 [Memory Sources](https://help.openai.com/en/articles/8590148-personalization-in-chatgpt) | saved memory、past chat、custom instructions、文件和连接应用是不同来源；产品明确称聊天历史不是每件事的永久记忆。 | 可查看/删除单项或全部 saved memories、关闭 memory；Temporary Chat 不读写个性化记忆。Memory Sources 可解释部分影响来源，但不保证列出所有因素。 | “关闭记忆”必须同时决定读和写；“删除聊天”与“删除从聊天提炼的记忆”是不同动作；应提供本轮不读且不写的临时模式，并呈现足够的来源说明。 |
| [Anthropic Claude Code memory](https://docs.anthropic.com/zh-CN/docs/claude-code/memory) | 项目共享记忆、用户级偏好、项目本地偏好按作用域分开，并在启动时加载。 | 记忆是可直接编辑的文件；文档建议具体、结构化并定期审阅。 | 作用域需要先于内容合并：项目/节点上下文不能泄漏为所有研究的个人偏好；可编辑、可审阅优于隐式黑箱。 |
| [Google Gemini 提示词策略](https://ai.google.dev/gemini-api/docs/prompting-strategies) 与 [Gemini 文本生成 API](https://ai.google.dev/gemini-api/docs/text-generation) | system instruction 用于行为；官方建议把关键规则、角色/人格和输出格式放在系统指令或用户提示开头，并要求为长上下文留出清晰锚点。 | API 调用方逐请求配置 system instruction；文档强调长会话会增长上下文。 | 指令来源、材料与当前问题必须带清晰边界；预算策略不能把“历史越多越好”当默认。 |
| [Qwen 官方仓库的对话模板](https://github.com/QwenLM/Qwen3/blob/main/docs/source/getting_started/concepts.md) 与 [百炼文本生成](https://help.aliyun.com/zh/model-studio/text-generation) | ChatML 以 system/user/assistant 区分轮次；system 用于角色、语气、任务目标与约束，Qwen3 不再强制默认 system message。 | 应用方控制消息数组；官方提示 system 可选但建议明确。 | 多供应商层必须先归一“来源和优先级”，再转换为供应商消息格式；不能把某一家默认提示词视为产品事实。 |
| [百炼记忆库](https://help.aliyun.com/zh/model-studio/memory-library) 与 [长期记忆 API](https://help.aliyun.com/zh/model-studio/long-term-memory-2-0) | 记忆片段记录事件/信息；画像记录职业、兴趣等结构化属性；检索后注入 prompt。 | 以 memory entity（如 user_id）隔离；可经控制台/API 删除；默认可能无失效期，但可配置过期时间。 | 画像、记忆片段、检索与用户隔离是独立问题。永久保存不应成为默认；Collector 需要先决定过期、纠错和删除传播。 |

补充的预算事实：OpenAI 的 `max_output_tokens` 包含可见输出与 reasoning tokens；因此把更多长期背景、结构指令和推理要求堆入同一调用，会直接挤压用户可见回答预算。[OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses-streaming/response/web_search_call) 当前 ADR-0031 已在 Collector 的弱标记/思考组合上实测过这种挤压，故统一装配层应把预算看成用户体验与正确性约束，而不是仅计费指标。

## Collector 应保持的概念边界

下表是**装配时的概念分类**，不是建议的数据表、字段或接口。每类条目都应能说明：来自哪里、为何本轮可用、作用域、是否可撤销、敏感性、过期条件和消耗的上下文预算。

| 层 | 来源与用途 | 合法作用域 | 与冲突的关系 | 检查 / 修改 / 删除 / 退出 |
| --- | --- | --- | --- |
| 系统 / 产品规则 | Collector 的安全、隐私、来源诚实性、工具与正文协议。 | 全部适用调用；可因能力路径不同而有任务专属规则。 | 最高；不能由用户提示词、记忆或检索材料覆盖。 | 不是普通用户可编辑项；版本与实际调用应可审计。 |
| 操作任务规则 | 普通回答、深入研究、联网、融合、章节解析等路径的有限任务要求。 | 单次操作或工作流。 | 高于用户个性化；不得偷偷升级为全局人格。 | 应随 promptVersion / 调用记录可追踪。 |
| 用户自定义指令 | 用户明确写下的回答偏好、目标或约束。 | 默认跨对话，除非用户指定项目/会话范围。 | 低于产品与任务规则；应让当前问题能显式临时覆盖它。 | 用户可见、可编辑、可删除、可关闭；不开放原始 system prompt。 |
| 画像 / 身份 / 兴趣 | 用户明确选择或确认的职业、兴趣、熟悉领域等稳定背景。 | 用户级或明确指定的项目范围。 | 是低权重背景，不能把“标签”当作本轮事实或能力证明。 | 首次引导可跳过、日后可补；逐项可编辑/删除/关闭。 |
| 风格 / persona | 例如活泼、务实、简洁；只改变表达方式。 | 用户级、项目级或单次回答。 | 不得覆盖真实性、来源、风险提示或用户当前明确格式要求。 | 独立于指令和画像开关；临时选择不自动升级为记忆。 |
| 项目 / 节点 / 当前材料 | 用户正在研究的节点、选区、导入材料、父链和未来 RAG 证据。 | 当前项目、节点或操作；材料必须带稳定来源定位。 | 对本题相关性通常高，但它是证据/上下文而不是行为规则。 | 随项目/节点权限和删除状态失效；用户可看见被引用的材料。 |
| 显式保存记忆 | 用户直接要求“记住”的长期偏好、事实或工作方式。 | 跨会话，但不自动跨用户/跨项目泄漏。 | 可辅助当前回答，不应抵消当前用户的明确更正。 | 可逐项查看、改写、删除；关闭时既不读取也不写入。 |
| 推断记忆 | 从互动中候选提炼的、尚未由用户明确确认的信息。 | 仅在明确同意的记忆策略与范围内。 | 权重低于显式记忆；不得以推断替代用户表述。 | 应标明推断来源和复核时间；敏感项默认不自动保存。 |
| 聊天历史 | 过去对话及附件的可检索证据。 | 关联会话/项目或用户授权的历史范围。 | 不是永久偏好；旧内容不能压过当前更正。 | 与保存记忆独立管理；临时对话不读也不写个性化历史。 |
| 当前轮上下文 | 当前提问、显式附件、即时选区和用户本轮临时要求。 | 本轮。 | 在同一用户指令层中，对本轮任务最直接；仍不得突破产品规则。 | 本轮完成后不自动成为记忆或画像。 |
| 知识掌握假设 | 从练习、解释、纠错等观察得到的“用户可能已经掌握/尚待巩固”。 | 学习支持场景，且只在足够证据期内。 | 不可与画像、偏好或知识图谱节点混用；必须允许当前表现推翻。 | 需保留证据、时间和置信度；用户可查看、纠正、停用；未决定前不自动长期注入。 |

### 候选优先级（供 #116 裁决，不是已确认规则）

一条可讨论的默认次序是：**产品安全/来源/工具规则 → 当前操作的任务规则 → 当前轮用户的明确要求 → 作用域更窄且仍适用的用户指令 → 长期用户指令 → 表达风格与画像 → 显式保存记忆 → 已获准检索的推断记忆与聊天历史 → RAG 候选证据。**

这不是简单的“越新越高”：材料和 RAG 证据回答“根据什么回答”，而不是“如何违反规则回答”；风格回答“怎样说”，而不是“说什么是真的”。发生冲突时装配层应能够报告“哪一类信息未被采用及原因”，而不是静默拼接。

## 对已确认“统一上下文装配层”的含义

1. **装配层应成为唯一的选择点。** 它接收上述来源的候选，不让各生成路径分别拼接“用户背景”。当前普通回答、长文、深入研究、联网、融合和预览已有不同 prompt 路径；若个性化直接散落在这些路径，关闭、审计和冲突处理必然不一致。
2. **它只组装本轮，不拥有第二份正文。** Collector 已确认正文是唯一内容事实源，切片/语义范围和章节导航为派生定位。个性化层只能选择输入上下文，不能复制、改写或用记忆替换研究正文；未来 RAG 也只能交付可定位的候选证据。
3. **每个候选都要能被解释和拒绝。** 至少要能回答“来源是什么、授权范围是什么、为什么本轮相关、为什么未超过预算、是否敏感、何时失效、用户如何撤销”。这与 ChatGPT Memory Sources 所展示的来源可解释方向一致，但 Collector 不应承诺展示模型内部所有影响因素。[OpenAI Memory Sources](https://help.openai.com/en/articles/8590148-personalization-in-chatgpt)
4. **预算须分层而非无限追加。** 先保留产品与当前任务的必要空间，再按作用域、相关性、用户控制和风险选择长期内容；命中缓存可降低成本，但不是扩大可注入内容的授权。Qwen 的 context cache 可缓存 system、user、assistant 与工具消息，说明缓存是传输/成本能力，不是记忆的产品语义。[Qwen Context Cache](https://help.aliyun.com/zh/model-studio/context-cache)
5. **供应商适配必须保持后置。** Qwen、OpenAI 和 Gemini 都能承载 system/instruction；阿里云也提供托管记忆检索，但它们不能决定 Collector 的用户控制、删除语义或跨供应商可移植性。装配层先产出供应商无关的“已选上下文及理由”，模型网关再转换成消息/参数。

## 风险与必须避免的捷径

| 风险 | 为什么会伤害用户 | 需要的防线 |
| --- | --- | --- |
| 指令注入 / 权限倒置 | 导入文档、网页、聊天历史或记忆中的文字若被当作高权重指令，会覆盖用户意图或产品规则。 | 将“行为规则”和“证据材料”以不同来源类别装配；外部材料永远不获得 system/product 优先级。 |
| 隐性画像与敏感推断 | 职业、健康、政治观点、未成年人信息或能力判断被自动长期保存，会造成意外暴露和错误个性化。 | 敏感内容默认不自动保存；明确同意、来源记录、按项删除、全局关闭和临时不读不写模式。OpenAI 同样把 memory 视为隐私/安全议题，并提供关停与 Temporary Chat。[OpenAI Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq) |
| 删除不完全 | 删除原聊天但保留提炼记忆，或删除记忆但历史仍会被检索，用户会误以为已经“忘记”。 | 将聊天、保存记忆、推断记忆、导入材料和连接数据分开说明与联动删除；OpenAI 也明确说明完整删除需删除各来源。[OpenAI Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq) |
| 过期知识与错误掌握假设 | “用户已会”可能让回答跳过关键解释；过时偏好也会持续污染回答。 | 记忆要有复核/失效策略；知识掌握必须保留证据、置信度和可推翻性，而非永久事实。 |
| 上下文膨胀与回答退化 | 长历史、长指令、父链、弱标记和 RAG 同时注入会挤占输出预算、提高成本，并增大推理泄漏或格式失控概率。 | 统一预算、逐层限额、相关性选择和调用记录；保持正文与旁路增强/推理分离。 |
| 供应商锁定 | 使用某家的托管 memory 后，用户控制和数据迁移会被其 API 能力限制。 | 产品语义、用户控制和 provenance 归 Collector；供应商 memory 仅是将来可评估的实现候选。 |

## 请 #116 与 #117 明确裁决的问题

### #116「定义统一上下文装配层与指令优先级」

1. 上述候选优先级中，**当前轮显式要求、会话/项目指令和长期自定义指令**冲突时，谁优先？是否允许用户在单轮临时覆写风格、长度和格式？
2. 哪些来源可以进入哪些操作：普通回答、深入研究、联网、融合、术语预览、标题/章节等辅助任务是否共用同一最小上下文，还是按任务白名单？
3. 用户是否可看到“本轮采用了哪些来源/未采用什么原因”的简明说明；说明显示到什么粒度，才能既可解释又不泄漏产品规则、其他会话或敏感数据？
4. 全局、项目、节点、会话、单轮五种作用域中，哪些是第一阶段真正需要的，哪些应留作候选，避免一次把所有偏好入口做成复杂设置？
5. 每类来源的预算上限、相关性门槛与降级顺序是什么；当预算不足时是否宁可不使用低权重个性化，也不压缩当前问题/来源证据？

### #117「定义长期记忆与知识掌握生命周期」

1. 第一阶段是否只允许用户**显式保存**记忆，还是允许把模型提炼的内容作为“待确认候选”？两者的写入、审阅和删除体验分别是什么？
2. “关闭记忆”是否同时禁止读取与写入；临时对话是否还遵循用户自定义指令和画像，还是完全不个性化？这两个开关的语义必须分开写清。
3. 聊天、导入材料、保存记忆、推断记忆和知识掌握假设的删除如何联动：用户选择“忘记 X”时，要删除哪几处、显示哪些仍可能保留的来源？
4. 画像字段（职业、兴趣、目标）是用户直接填写、引导标签、还是从对话中建议？哪些敏感类别一律不自动提取或保存？
5. 知识掌握假设以哪些行为作为证据（例如用户解释、练习、纠错），何时失效，何时只影响回答深浅而绝不成为对用户能力的永久标签？在这些规则未定前，是否禁止将它注入模型？
6. 记忆是否严格本机、用户隔离、项目隔离；未来多设备同步或外部供应商托管是否另开决策，避免在本票中默认为既定能力？

## 与当前 Collector 的交接事实

- 当前实现已经有：正文唯一事实源；有界父链/切片上下文；运行记录中的 `promptVersion`、token budget、provider/model 和调用上下文；推理流与正文分离。它们是装配层可复用的边界，并不表示已实现个性化、可配置用户指令或长期记忆。
- 当前普通回答提示词仍要求“plain text only”，并会按路径加入弱标记和父链/切片上下文；这正说明个性化若直接继续追加到各路径，会扩大提示词耦合。正文、旁路增强与个性化应在后续决定中拆开治理，而不是把所有约束写入同一段自然语言提示。
- 本研究不修改 `CONTEXT.md`、ADR、`docs/PROJECT.md` 或任何代码：上述内容是后续 Grilling 票据用于做产品裁决的输入。`docs/PROJECT.md` 四态能力表不需要改动，因为没有产品能力状态变化。

## 参考来源

- [OpenAI Responses API — streaming response and instruction hierarchy](https://platform.openai.com/docs/api-reference/responses-streaming/response/web_search_call)
- [OpenAI — Custom Instructions](https://help.openai.com/en/articles/8096356-chat-preferences-for-chatgpt)
- [OpenAI — Characteristics in ChatGPT](https://help.openai.com/en/articles/20001038-characteristics-in-chatgpt)
- [OpenAI — Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)
- [OpenAI — Personalization / Memory Sources](https://help.openai.com/en/articles/8590148-personalization-in-chatgpt)
- [OpenAI — Temporary Chat FAQ](https://help.openai.com/en/articles/8914046-temporary-chat-faq)
- [Anthropic — Manage Claude Code memory](https://docs.anthropic.com/zh-CN/docs/claude-code/memory)
- [Google — Gemini prompt design strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies)
- [Google — Gemini text generation and system instructions](https://ai.google.dev/gemini-api/docs/text-generation)
- [Qwen — Qwen3 conversation concepts / ChatML](https://github.com/QwenLM/Qwen3/blob/main/docs/source/getting_started/concepts.md)
- [阿里云百炼 — OpenAI 兼容 Chat API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)
- [阿里云百炼 — 文本生成](https://help.aliyun.com/zh/model-studio/text-generation)
- [阿里云百炼 — 长期记忆 API](https://help.aliyun.com/zh/model-studio/long-term-memory-2-0)
- [阿里云百炼 — 记忆库](https://help.aliyun.com/zh/model-studio/memory-library)
- [阿里云百炼 — Qwen Context Cache](https://help.aliyun.com/zh/model-studio/context-cache)
