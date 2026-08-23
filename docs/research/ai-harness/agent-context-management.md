# Agent 上下文管理技术方案调研（#116）

> 状态：研究资料，不是产品决定或实现规格。
> 研究日期：2026-08-23；仅使用官方文档、官方仓库或官方维护的参考资料。
> 目标：以可验证的一手资料检验 #116 已确认的“按任务最小上下文、三语义通道、程序强制 + 提示引导、适应上限和有序预算降级”。

## 范围与方法

本次不是“市场份额排名”，也不声称涵盖全部 Agent 产品。样本选择标准是：在海外或中国大陆生态中具有代表性，并且其官方资料公开说明了至少一项上下文机制。覆盖八个系统：OpenAI Agents SDK、Claude Code、Google ADK、LangGraph、Microsoft AutoGen、AWS Strands Agents、AgentScope（阿里云 ModelScope 生态）和 Qwen-Agent（阿里云通义生态）。

同一框架的“Session”“Memory”“Context”名称并不等价。本文把**会话工作状态**、**跨会话长期记忆**、**检索/工具返回的证据**、**缓存**和**模型可见输入**分别记录；特别不把提示缓存当记忆，也不把检索命中当事实。文档中“事实”均有紧邻来源；“推断”只说明可迁移的设计含义。

## 逐项一手事实

### 1. OpenAI Agents SDK（海外 SDK）

- `RunContext` 是代码本地状态，不发送给模型；模型可见信息要通过 instructions、输入项、工具或检索/联网工具显式提供。这是本地权限状态与模型可见上下文分离的明确接口。[官方 Context Management](https://openai.github.io/openai-agents-js/guides/context/)
- `Session` 在每次运行前读出历史、与新输入合并，并在运行后持久化该轮输入/输出；可自定义存储，并可根据 `RunContext` 做租户分区。[官方 Sessions](https://openai.github.io/openai-agents-js/guides/sessions/)
- `OpenAIResponsesCompactionSession` 可在持久化后调用 `responses.compact`，以压缩项替换旧历史；默认触发条件可改为 token 或其他启发式。该机制压缩的是会话历史，不是长期用户画像，也不保证业务所需证据被保留。[同上](https://openai.github.io/openai-agents-js/guides/sessions/)
- Agent 可按任务选择模型，SDK 抽象为 `Model` / `ModelProvider`；工具还可按运行条件 `isEnabled`、要求人工批准，并在调用前后运行工具 guardrail。[官方 Models](https://openai.github.io/openai-agents-js/guides/models/)；[官方 Tools](https://openai.github.io/openai-agents-js/guides/tools/)
- 输入、输出和逐工具调用均有 guardrail；被拒绝的终态工具结果会被替换为占位内容进入 SDK 管理的历史，避免其再次被重放。[官方 Guardrails](https://openai.github.io/openai-agents-js/guides/guardrails/)
- 内置 tracing 覆盖模型、工具、handoff、guardrail 与 token 使用；默认服务端开启，但零数据保留策略下不可用。[官方 Tracing](https://openai.github.io/openai-agents-js/guides/tracing/)

### 2. Claude Code / Claude Agent SDK（海外产品与 SDK）

- Claude Code 会自动压缩接近窗口上限的会话历史；`/compact` 支持声明“压缩时应保留什么”。官方还建议在不相关任务之间 `clear`，说明压缩不是把所有旧内容永久可靠保留的替代品。[官方成本与上下文说明](https://code.claude.com/docs/en/costs)
- 项目 `CLAUDE.md` 在会话开始时进入上下文；更专用的 instructions 建议转为按需加载的 Skills。MCP 工具定义默认延迟加载，只有名称和服务器说明先进入上下文。两者都是“按用途/按需披露”，不是全量注入。[同上](https://code.claude.com/docs/en/costs)
- 长日志可由 hook 在模型读取前过滤；冗长研究/测试也可委托子 Agent，使完整输出留在子 Agent 的独立窗口、主会话只收摘要。[同上](https://code.claude.com/docs/en/costs)
- Prompt caching 用于重复静态内容的成本优化，与跨会话记忆是不同机制。[官方 Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- 官方资料可确认 token 用量、缓存读写、模型归因和 OpenTelemetry 导出，但本次查到的公开资料没有给应用开发者一个可移植的“为最终回答硬预留 N tokens”的 Claude Code 公共契约。[官方成本与可观测性](https://code.claude.com/docs/en/costs)

### 3. Google Agent Development Kit（ADK，海外框架）

- ADK 明确区分单个会话的 `Session` / `State` 与跨会话、可搜索的 `MemoryService`；后二者由不同服务管理。`MemoryService` 可摄入完成的 session 并按查询检索，故它是候选信息库，不是天然事实权威。[官方 Sessions](https://google.github.io/adk-docs/sessions/)
- ADK 的 `InvocationContext`、只读 Context、可读写 Context 和 ToolContext 具有不同能力；ToolContext 还包含认证流程、记忆搜索和 artifact 查找能力。这是按执行位置分配能力的明确设计。[官方 Context](https://google.github.io/adk-docs/context/)
- 会话事件的 `state_delta` 由 SessionService 持久化；`temp:` 前缀状态只在一次 invocation 内有效。它把运行临时状态与长期内容区分开。[官方 Runtime event loop](https://google.github.io/adk-docs/runtime/event-loop/)
- 本次阅读的公开 ADK 文档未确认一个框架默认的、统一的历史摘要/滑窗算法、输出空间保护策略或通用跨供应商缓存层；它们不应被当作 ADK 已提供的默认保证。

### 4. LangGraph（海外框架）

- LangGraph 的短期记忆是 thread-scoped state，由 checkpointer 持久化；长期记忆是跨线程、按自定义 namespace 保存与检索的 store。上传文件、检索文档和产物可以位于 thread state，但这不让它们自动获得指令或事实地位。[官方 Memory overview](https://docs.langchain.com/oss/javascript/concepts/memory)
- 官方建议在长对话中按 token 裁剪、删除或摘要较早消息，也明确指出长上下文即使装得下也可能被陈旧内容干扰。[官方 Add and manage memory](https://docs.langchain.com/oss/javascript/langgraph/add-memory)
- 长期 memory 可以是 profile 或文档集合；官方特别指出 profile 更新易出错、集合又增加更新与检索复杂度。这支持“推断记忆应受来源、时效、置信度与可撤销性约束”。[官方 Memory overview](https://docs.langchain.com/oss/javascript/concepts/memory)
- 图可以把确定性步骤和模型驱动步骤混合，持久化、人工介入与可观察性是其运行时能力。[官方 Overview](https://docs.langchain.com/oss/javascript/langgraph/overview)；其配套 LangSmith 可追踪、导出和比较 traces，并设置监控/告警。[官方 Observability](https://docs.langchain.com/langsmith/observability)

### 5. Microsoft AutoGen（海外框架）

- AutoGen 把模型消息存取抽象为 `ChatCompletionContext`；内置有完整历史、最近 N 条、首尾保留和 token 限制等策略，也允许实现自定义策略。[官方 Model context API](https://microsoft.github.io/autogen/stable/reference/python/autogen_core.model_context.html)
- `TokenLimitedChatCompletionContext` 依赖模型客户端的 token 计数或剩余 token 来限制**发送给模型的历史**；官方将其标为 experimental。它没有声明业务层面“先保护最终用户回答”的规则。[同上](https://microsoft.github.io/autogen/stable/reference/python/autogen_core.model_context.html)
- `AssistantAgent` 可各自配置 `model_context`；默认仍是完整历史。这意味着“存在可用裁剪组件”不等于应用天然采用最小上下文。[官方 Agents tutorial](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/agents.html)

### 6. AWS Strands Agents（海外框架）

- Strands 的 `SlidingWindowConversationManager` 与 `SummarizingConversationManager` 分别做滑窗和旧消息摘要；后者可以在窗口接近满时主动压缩，也会在溢出时作为安全网反应式压缩。[官方 Context Management](https://strandsagents.com/docs/user-guide/concepts/context-management/)
- 大工具结果可由 `ContextOffloader` 外置，只在上下文留预览，并注册检索完整内容的工具；这是“完整工具结果不应默认占满最终回答上下文”的直接实践。[同上](https://strandsagents.com/docs/user-guide/concepts/context-management/)
- Strands 可接入 AgentCore Memory；官方例子把 session/actor/memory ID 作为记忆作用域并批量刷写。这是持久化与会话压缩的分离，而不是把摘要当永久记忆。[AWS 官方集成文档](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/strands-sdk-memory.html)
- AWS 同时建议按需筛选或搜索 MCP 工具，减少工具 schema 占用窗口；这是“任务用途先决定可见工具”的证据。[AWS 官方 MCP 工具发现指南](https://docs.aws.amazon.com/prescriptive-guidance/latest/mcp-strategies/mcp-tool-strategy-discovery.html)

### 7. AgentScope（阿里云 ModelScope 生态，中国大陆框架）

- AgentScope memory 给消息加 mark，用 mark 分类、过滤与取回；memory 模块负责存储和管理，压缩算法由 agent 层实现。官方提供内存、SQL、Redis、Tablestore 等存储。[官方 Memory](https://doc.agentscope.io/tutorial/task_memory.html)
- `ReActAgent` 能在 token 阈值触发后保留最近消息，将旧消息生成结构化摘要并打为 `COMPRESSED`；官方说明原消息不会物理删除。摘要所保留的任务概览、当前状态、关键发现和下一步，适合工作续接，但不应替代原始可引用证据。[官方 Agent](https://doc.agentscope.io/tutorial/task_agent.html)
- 官方教程还说明 memory 可配合 State/Session 序列化与恢复；长期记忆可选 agent 自主管理、开发者显式管理或混合管理。它把记忆写入权当成可配置策略，而不是压缩的副作用。[官方 State/Session](https://doc.agentscope.io/tutorial/task_state.html)；[官方 Long-Term Memory](https://doc.agentscope.io/tutorial/task_long_term_memory.html)
- RAG 可作为让 Agent 自主调用的工具，或每轮自动检索并注入 prompt；这是两种不同的可见性策略，后者尤其需要应用自行加来源与权限边界。[官方 RAG](https://doc.agentscope.io/tutorial/task_rag.html)
- 官方提供多家模型的 token counter、formatter 截断，并以 OpenTelemetry 覆盖 LLM、工具、Agent、formatter 与异常。[官方 Token](https://doc.agentscope.io/tutorial/task_token.html)；[官方 Tracing](https://doc.agentscope.io/tutorial/task_tracing.html)
- 由此可推断：其 mark 是实用的来源/用途标签，但单靠标签不构成 Collector 所需的权限判定、证据质量判断或用户可解释采用记录；本次也未找到统一的按用户/角色过滤模型可见上下文的公共机制。

### 8. Qwen-Agent（阿里云通义生态，中国大陆框架）

- Qwen-Agent 官方仓库把指令遵循、工具、规划、记忆、MCP、代码解释器与 RAG 并列为框架能力。[官方仓库](https://github.com/QwenLM/Qwen-Agent)
- 超过 `max_input_tokens` 时，官方上下文策略依次删除最旧完整轮次、折叠最旧工具结果、删除最旧工具调用步骤、折叠较近工具结果，最后才可能截断当前用户问题或最终回答。官方也说明旧记忆和环境信息优先被丢弃。[官方 Context](https://qwenlm.github.io/Qwen-Agent/en/guide/core_moduls/context/)
- 这说明其对工具结果与旧历史有明确降级顺序，但其最后两步与 Collector 已确认的“当前问题与最低可用回答不能静默删除”相冲突；只能作为风险案例，不能照搬。公开资料也未确认统一权限可见性或 tracing 规则。

## 横向比较

| 系统 | 任务/调用分流 | 会话与长期记忆 | 裁剪、摘要、工具大结果 | 权限、来源、可见性 | 缓存与可观测性 | 对 #116 的直接启示 |
| --- | --- | --- | --- | --- | --- | --- |
| OpenAI Agents SDK | Agent/handoff/工具可按运行启用 | Session 明确；长期画像交给应用 | Responses 压缩 session | 本地 RunContext 不可见；工具审批与 guardrail | tracing 完整；缓存不是其 session | 先做准入，后做 provider 翻译 |
| Claude Code | Skills、MCP、子 Agent 按需 | 会话压缩；无通用应用记忆契约 | 自动/手动 compact；过滤日志、子 Agent 隔离 | instructions、工具定义可按需装载 | prompt cache 与 token/OTel | 静态规则、专用技能、冗长工作应分层 |
| Google ADK | 不同 Context/ToolContext | Session/State 与 MemoryService 分开 | 本次未确认默认统一算法 | Context 类型按能力区分 | 本次未确认完整统一层 | 用作用域模型限制服务/工具可见性 |
| LangGraph | 图中确定性节点 + LLM 节点 | thread state 与 namespace store 分开 | trim/delete/summarize 可选 | namespace 支持隔离，但质量规则由应用定 | LangSmith trace | 把必守规则写为确定性节点而非全交给模型 |
| AutoGen | 每个 agent 可有自己的 model context | 主要是模型消息 context | N 条、token、首尾策略 | 本次未确认完备策略 | 本次未作为重点确认 | token 限制只是输入上限，不是产品预算政策 |
| Strands | 按需发现/筛选工具 | session 与 AgentCore memory 可分离 | 滑窗、摘要、工具结果外置 | 工具注册可以缩小可见面 | 本次未确认通用 trace 契约 | 大工具结果应保引用/可回取，而非生硬截断 |
| AgentScope | agent/mark/middleware 可分流 | Session + 多后端 memory | 由 agent 层决定压缩 | mark 可表达用途，权限仍需应用强制 | 仓库列 OTel | 统一候选记录需要用途/来源标签，但标签不能代替授权 |
| Qwen-Agent | 规划、工具、RAG 等能力并列 | 裁剪策略区分旧轮次、工具步骤与当前轮；高级记忆模块仍待官方后续 | 明确 S1–S5 裁剪顺序，最后可能截断当前问题或最终回答 | 未确认统一权限可见性 | 未确认通用 tracing 契约 | 可借鉴工具结果优先降级，但禁止照抄最终截断当前问题/回答 |

## 本次样本中的共同模式与显著分歧

### 可证实的共同模式

在八个代表性系统中，至少七个公开提供或说明了会话历史的裁剪、摘要、滑窗、压缩或由应用自定义的等价机制（OpenAI、Claude Code、LangGraph、AutoGen、Strands、AgentScope、Qwen-Agent）。这证明“长会话必须管理”是普遍工程问题；**不**证明它们拥有同一套优先级或同一正确策略。

至少四个系统明确区分了短期会话状态与可跨会话召回的信息（Google ADK、LangGraph、Strands/AgentCore、AgentScope）。这支持 Collector 已确认的结论：会话历史、长期记忆和检索证据不应作为同一种可互相覆盖的消息。

多系统展示了“先缩小可见面，再让模型决定”的做法：OpenAI 工具条件启用与审批、Claude Code 的技能/MCP 延迟加载、Strands 的工具发现筛选、ADK 的 Context 类型。**推断**：Collector 的按调用用途最小准入是可迁移的架构模式，而不是某一家 provider 的消息格式。

### 不能抹平的分歧

- **压缩语义不同**：OpenAI 可使用 provider 的 opaque compaction item；LangGraph 与 AutoGen 暴露应用策略；Strands 提供摘要与工具结果外置；Claude Code 是产品级会话体验。它们不能直接互换，也不应成为 Collector 的共享契约。
- **长期记忆成熟度不同**：Google ADK / LangGraph / AgentScope 有显式长期记忆抽象；OpenAI Agents SDK 的 Session 主要是会话持久化；Claude Code 的 prompt cache 更不是用户记忆。
- **可观察性与隐私界线不同**：OpenAI tracing、LangSmith、Claude Code 的 OTel/usage 都能记录运行，但“记录越完整越好”并不成立。Collector 必须保留脱敏的采用类别/版本/理由，而非默认上传全文、密钥或敏感画像。
- **输出预算保护没有现成共识**：本次官方资料中，AutoGen 明确限制输入消息，Strands/Claude/OpenAI 明确做输入压缩，但没有一个可移植框架替 Collector 定义“当前问题、核心证据和最低回答空间”之间的业务优先级。这应由 #116 的装配策略与测试决定。

## 对 Collector #116 的可迁移建议

1. **坚持三语义通道，且在模型调用前做准入。** 参考 OpenAI 的本地/模型可见区分与 ADK 的不同 Context 能力：把行为规则、事实证据、用户适应表示为不同类别，使用用途配置决定可见范围；不要依赖“把所有东西塞进 system prompt 后让模型自觉区分”。

2. **把调用用途写成可审计契约。** 借鉴 Claude 的按需 Skills/MCP、Strands 的工具筛选和 OpenAI 条件工具：最终写作、材料解读、事实求证、标题、旁路增强、术语预览、搜索取证各自声明可读类别、可用工具、输出结构和是否允许写记忆。缺省拒绝。

3. **把会话压缩、长期记忆、工具结果外置分别建模。** 借鉴 LangGraph / ADK 的短长分离与 Strands 的 offload：原始正文仍是事实源；摘要只是派生工作状态；外置工具结果保留来源身份、完整回读入口和语义边界；长期记忆需独立的来源、置信度、范围、时效、删除与用户控制。

4. **预算先预留输出，再选择完整语义单元。** 这是结合样本得出的**推断**，不是任何一家现成 API 的承诺。使用模型/供应商适配层给出的窗口与输出能力估算，先固定不可删除项（硬边界、当前问题、本轮要求、用户明确选中的核心材料）和最低回答空间；再按任务必要性选择完整证据范围，最后舍弃低置信适应、重复与旧低相关历史。禁止中间截断证据。

5. **将权限和结构验证留在 Collector 程序中。** 参考 OpenAI 的审批/guardrail 与 LangGraph 的确定性节点：模型可辅助意图判定和语义取舍，但不能决定自己是否有权读记忆、是否能执行高影响工具、是否把网页文字升级成指令。供应商适配器只能转换请求/响应，不能重写这一权责。

6. **建立最小、脱敏的装配审计。** 参考 OpenAI tracing 与 LangSmith 的运行观测，但保留 Collector 的本地优先边界：记录用途、策略版本、候选类别计数、采用/排除原因、预算估算、模型与适配器版本、降级路径；不把 API key、会话令牌、原始敏感画像或无关完整正文写进普通日志。

## 不应照抄的做法

- 不把任一 provider 的 `system/user/tool` 消息布局写成共享领域契约；应由 Collector 的中立 `ContextCandidate` / `AssemblyPlan`（名称待实施设计确认）在最后一层翻译。
- 不把 `/compact`、滑窗或 token 截断误当作长期记忆，也不把压缩摘要当作可引用的原始证据。
- 不因 RAG、memory search 或向量相似度“命中”就提升材料的事实地位；求证任务仍需来源质量、直接性、时效与冲突处理。
- 不由模型自己决定高影响授权，或用“系统提示词说了不能”替代数据准入和工具权限。
- 不从框架默认 token 数、字符/token 估算、压缩比例复制具体阈值。Collector 的参数应按各模型窗口、正文长度、任务用途与测试夹具校准。

## 公开一手资料仍无法确认的未知项

- 上述产品的生产默认配置实际是否启用了每一种压缩/缓存/记忆插件；框架提供能力不代表某部署已启用。
- Claude Code、Google ADK、AgentScope、Qwen-Agent 是否有稳定且跨版本的“用户画像注入优先级”公共契约；本次资料不足以确认。
- 各 provider 对上下文缓存的精确保留、淘汰和隐私边界；这属于 provider 计费/服务策略，不能据此设计 Collector 的本地数据生命周期。
- 一个满足 Collector 全部正文路径的通用 token 预算数值、最小回答长度、相关性阈值和摘要格式；需要在 #116 后续实施切片以确定性夹具、真实供应商探针和用户路径测试确定。

## 结论

研究支持 #116 已确认的方向：统一的不是“一大段提示词”或“一份人人可见的上下文”，而是**调用前的准入、选择、预算、来源记录和供应商转换过程**。行为规则、事实证据和用户适应保持不同语义；任务用途决定最小必要可见面；程序负责权限和结构，模型负责在获准材料内的理解与生成。

同时，样本不支持把任一框架的压缩算法、默认阈值或缓存机制直接当作 Collector 决策。尤其“输出空间保护、材料解读/事实求证的证据语义、个性化上限和可解释的采用记录”仍是 Collector 需要自行明确并验证的产品/工程边界。
