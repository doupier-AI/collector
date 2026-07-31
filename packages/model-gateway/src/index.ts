import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { parseResearchSelectionInsight, validateProviderDefinition, type ActiveModelRoute, type ProviderDefinition, type ProviderModelDiscoveryResult, type ProviderProfile, type ResearchGroundingRequest, type ResearchGroundingScopeStatus, type ResearchSelectionInsight } from "@collector/capture-contracts";

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputCacheHitTokens?: number;
  inputCacheMissTokens?: number;
}

export interface ModelPricing {
  inputCacheHitPerMillion: number;
  inputCacheMissPerMillion: number;
  outputPerMillion: number;
}

export interface ModelProviderResponse {
  content: string;
  model: string;
  usage?: ProviderUsage;
}

export interface ModelProviderRequest {
  prompt: string;
  model: string;
  responseFormat: { type: "json_object" };
  thinking?: boolean;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ModelProvider {
  readonly name: string;
  readonly defaultModel?: string;
  readonly pricing?: Record<string, ModelPricing>;
  complete(request: ModelProviderRequest): Promise<ModelProviderResponse>;
}

/** Agent 工具调用循环中的单条消息。对齐 OpenAI Chat Completions messages 数组。 */
export interface AgentChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

/** 可被 Agent 调用的工具定义。对齐 OpenAI function tool 格式。 */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Agent 聊天调用的结构化返回。区分 stop（模型直接回答）与 tool_calls（模型请求调用工具）。 */
export interface AgentChatResponse {
  finishReason: "stop" | "tool_calls" | "length" | "content_filter";
  message: {
    role: "assistant";
    content: string | null;
    toolCalls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  };
  model: string;
  usage?: ProviderUsage;
}

/** 网关归一的供应商联网结果；研究服务不读取供应商 HTTP 响应。 */
export interface GroundingSource {
  providerSourceId?: string;
  title: string;
  url?: string;
  snippet?: string;
  publishedAt?: string;
  locator?: string;
}

export interface GroundingCitation {
  sourceOrdinal: number;
  startOffset: number;
  endOffset: number;
  providerCitationId?: string;
}

export interface GroundedResearchResponse {
  content: string;
  status: ResearchGroundingScopeStatus;
  queries: string[];
  sources: GroundingSource[];
  citations: GroundingCitation[];
  responseSummary?: Record<string, unknown>;
  errorMessage?: string;
}

export interface GroundingModelProvider extends ModelProvider {
  generateGroundedResearch(request: { prompt: string; model: string; grounding: ResearchGroundingRequest; maxTokens?: number; timeoutMs?: number }): Promise<GroundedResearchResponse>;
}

/** 研究节点提示词可消费的有界父链结果。由 API 层的 ParentChainContextService 提供。 */
export interface ResearchParentChainContext {
  currentNodeDepth: number;
  ancestors: Array<{
    depth: number;
    isRoot: boolean;
    label: string;
    originText?: string;
    firstUserMessage?: string;
  }>;
  truncated: boolean;
  cycleDetected: boolean;
}

/** 将父链结果渲染为研究提示词片段；空链不产生任何占位文本。 */
export function formatResearchParentChainContext(context?: ResearchParentChainContext): string {
  if (!context?.ancestors.length) return "";

  const lines = [
    "研究路径背景（来自已建立的父节点，仅作上下文，不是新的用户问题）：",
    `当前节点深度：${context.currentNodeDepth}`,
    "以下为有界父链摘要，最近祖先优先：",
  ];
  for (const ancestor of [...context.ancestors].sort((left, right) => left.depth - right.depth)) {
    lines.push(`- 祖先（距当前 ${ancestor.depth} 层${ancestor.depth === 1 ? "，最近" : ""}）主题：${JSON.stringify(ancestor.label)}`);
    if (ancestor.originText) lines.push(`  来源选区：${JSON.stringify(ancestor.originText)}`);
    if (ancestor.firstUserMessage) lines.push(`  首条问题摘要：${JSON.stringify(ancestor.firstUserMessage)}`);
  }
  if (context.truncated) lines.push("- 说明：父链已达到既有层数或总字符预算，只能使用以上内容，不要补全未提供的祖先信息。");
  if (context.cycleDetected) lines.push("- 说明：父链存在异常环路，已安全截断；不要根据缺失关系进行推断。");
  if (context.currentNodeDepth >= 2) {
    lines.push("回答引导：聚焦当前问题，优先基于以上已建立的知识，减少重复解释和无关新概念，保持简洁。");
  }
  return lines.join("\n");
}

export class ProviderRegistry {
  private readonly definitions = new Map<string, ProviderDefinition>();

  constructor(definitions: ProviderDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: ProviderDefinition): void {
    validateProviderDefinition(definition);
    if (this.definitions.has(definition.id)) throw new Error(`Provider already registered: ${definition.id}`);
    this.definitions.set(definition.id, structuredClone(definition));
  }

  get(id: string): ProviderDefinition {
    const definition = this.definitions.get(id);
    if (!definition) throw new Error(`Unknown provider: ${id}`);
    return structuredClone(definition);
  }

  list(): ProviderDefinition[] {
    return [...this.definitions.values()].map((definition) => structuredClone(definition));
  }
}

export const BUILTIN_PROVIDER_DEFINITIONS: ProviderDefinition[] = [{
  id: "deepseek",
  label: "DeepSeek",
  apiMode: "openai_chat_completions",
  authMode: "bearer",
  defaultBaseUrl: "https://api.deepseek.com",
  defaultModel: "deepseek-v4-flash",
  models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  capabilities: { structuredJson: true, thinkingMode: "deepseek", modelDiscovery: true, webGrounding: "unsupported" },
  pricing: {
    "deepseek-v4-flash": { inputCacheHitPerMillion: 0.0028, inputCacheMissPerMillion: 0.14, outputPerMillion: 0.28 },
    "deepseek-v4-pro": { inputCacheHitPerMillion: 0.003625, inputCacheMissPerMillion: 0.435, outputPerMillion: 0.87 },
  },
}, {
  id: "openai",
  label: "OpenAI",
  apiMode: "openai_responses",
  authMode: "bearer",
  defaultBaseUrl: "https://api.openai.com/v1",
  defaultModel: "gpt-4.1-mini",
  models: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
  capabilities: { structuredJson: true, thinkingMode: "none", modelDiscovery: true, webGrounding: "openai_web_search" },
}, {
  id: "gemini",
  label: "Google Gemini",
  apiMode: "gemini_generate_content",
  authMode: "api_key_header",
  defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
  defaultModel: "gemini-2.5-flash",
  models: ["gemini-2.5-flash", "gemini-2.5-pro"],
  capabilities: { structuredJson: false, thinkingMode: "none", modelDiscovery: true, webGrounding: "gemini_google_search" },
}, {
  id: "anthropic",
  label: "Anthropic",
  apiMode: "anthropic_messages",
  authMode: "api_key_header",
  defaultBaseUrl: "https://api.anthropic.com/v1",
  defaultModel: "claude-sonnet-5",
  models: ["claude-sonnet-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  capabilities: { structuredJson: false, thinkingMode: "none", modelDiscovery: true, webGrounding: "anthropic_web_search" },
}, {
  id: "openrouter",
  label: "OpenRouter",
  apiMode: "openai_chat_completions",
  authMode: "bearer",
  defaultBaseUrl: "https://openrouter.ai/api/v1",
  defaultModel: "openai/gpt-4.1-mini",
  models: ["openai/gpt-4.1-mini", "anthropic/claude-sonnet-4", "google/gemini-2.5-flash"],
  capabilities: { structuredJson: true, thinkingMode: "none", modelDiscovery: true, webGrounding: "unsupported" },
}, {
  id: "dashscope",
  label: "Alibaba Cloud Model Studio",
  apiMode: "openai_chat_completions",
  authMode: "bearer",
  defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  defaultModel: "qwen-plus",
  models: ["qwen-plus", "qwen-max", "qwen-turbo"],
  capabilities: { structuredJson: true, thinkingMode: "none", modelDiscovery: true, webGrounding: "unsupported" },
}, {
  id: "moonshot",
  label: "Kimi (Moonshot AI)",
  apiMode: "openai_chat_completions",
  authMode: "bearer",
  defaultBaseUrl: "https://api.moonshot.cn/v1",
  defaultModel: "kimi-k2.5",
  models: ["kimi-k2.5", "kimi-k2-0711-preview", "moonshot-v1-32k"],
  capabilities: { structuredJson: true, thinkingMode: "none", modelDiscovery: true, webGrounding: "unsupported" },
}, {
  id: "zhipu",
  label: "Zhipu GLM",
  apiMode: "openai_chat_completions",
  authMode: "bearer",
  defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
  defaultModel: "glm-4.6",
  models: ["glm-4.6", "glm-4.5", "glm-4.5-flash"],
  capabilities: { structuredJson: true, thinkingMode: "none", modelDiscovery: true, webGrounding: "unsupported" },
}, {
  id: "siliconflow",
  label: "SiliconFlow",
  apiMode: "openai_chat_completions",
  authMode: "bearer",
  defaultBaseUrl: "https://api.siliconflow.cn/v1",
  defaultModel: "deepseek-ai/DeepSeek-V3.2",
  models: ["deepseek-ai/DeepSeek-V3.2", "Qwen/Qwen3-235B-A22B", "Pro/deepseek-ai/DeepSeek-V3.2"],
  capabilities: { structuredJson: true, thinkingMode: "none", modelDiscovery: true, webGrounding: "unsupported" },
}, {
  id: "custom",
  label: "Custom OpenAI-Compatible",
  apiMode: "openai_chat_completions",
  authMode: "bearer",
  defaultBaseUrl: "https://example.invalid/v1",
  defaultModel: "custom-model",
  models: [],
  capabilities: { structuredJson: true, thinkingMode: "none", modelDiscovery: true, webGrounding: "unsupported" },
}, {
  id: "custom-anthropic",
  label: "Custom Anthropic-Compatible",
  apiMode: "anthropic_messages",
  authMode: "api_key_header",
  defaultBaseUrl: "https://example.invalid/v1",
  defaultModel: "custom-model",
  models: [],
  capabilities: { structuredJson: false, thinkingMode: "none", modelDiscovery: true, webGrounding: "unsupported" },
}];

export const DEFAULT_PROVIDER_REGISTRY = new ProviderRegistry(BUILTIN_PROVIDER_DEFINITIONS);

export interface ResolvedProviderRuntime {
  gateway: ModelGateway;
  route: ActiveModelRoute;
}

export class ProviderRuntimeResolver {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly credential: (profileId: string) => Promise<string | undefined>,
    private readonly pricing?: Record<string, ModelPricing>,
  ) {}

  async resolve(profile: ProviderProfile): Promise<ResolvedProviderRuntime> {
    if (!profile.enabled) throw new Error("Provider profile is disabled");
    const definition = this.registry.get(profile.providerId);
    const apiKey = await this.credential(profile.id);
    if (!apiKey) throw new Error(`Credential is unavailable for provider profile: ${profile.id}`);
    const gateway = new ModelGateway(createProvider(definition, { apiKey: () => apiKey, baseUrl: profile.baseUrl }), {
      model: profile.model,
      pricing: this.pricing,
    });
    return {
      gateway,
      route: {
        providerProfileId: profile.id,
        providerId: profile.providerId,
        apiMode: definition.apiMode,
        baseUrlFingerprint: fingerprintBaseUrl(profile.baseUrl),
        model: profile.model,
        configurationVersion: profile.configurationVersion,
      },
    };
  }
}

export interface ModelCallContext { workflowRunId?: string; workflowStepId?: string; purpose?: string; promptVersion?: string; }
export interface ModelCallEvent {
  context: ModelCallContext;
  provider: string;
  model: string;
  promptVersion: string;
  status: "completed" | "failed";
  usage?: ProviderUsage;
  estimatedCostUsd?: number;
  latencyMs: number;
  errorMessage?: string;
  createdAt: string;
  completedAt: string;
}

/** Agent 搜索循环所需的工具实现（由调用方注入，保持 model-gateway 与 Bing/Readability 解耦）。 */
export interface AgentSearchToolContext {
  webSearch: (query: string, maxResults: number) => Promise<{
    query: string;
    total_results: number;
    results: Array<{ title: string; url: string; snippet: string }>;
    errorMessage?: string;
  }>;
  webFetch: (url: string) => Promise<{
    url: string;
    content: string;
    errorMessage?: string;
  }>;
}

/** Agent 搜索循环的最终输出。 */
export interface AgentSearchResult {
  content: string;
  queries: string[];
  sources: GroundingSource[];
}

/** Agent 搜索循环的默认系统提示。 */
const AGENT_SEARCH_SYSTEM_PROMPT = `你是 Collector 的研究助手。你可以使用以下工具完成联网研究任务。

工作流程：
1. 根据用户问题，先调用 web_search 进行搜索
2. 分析搜索结果，选择最相关的页面调用 web_fetch 抓取详细内容
3. 如果信息不够充足，可以换关键词重新搜索
4. 信息收集充分后，给出完整回答

引用规则：
- 回答中引用来源时在陈述后标注 [来源n]（n 为搜索结果列表中该项的序号）
- 只在确实有依据的陈述后标注
- 没有依据时如实说明不确定性

约束：
- 必须经过搜索再回答，不能凭记忆编造
- 中文优先，使用中文关键词搜索；英文术语保留原样
- 最多进行 5 轮搜索（web_search 调用次数），达到后请基于已有信息给出最佳回答`;

/** web_search 和 web_fetch 工具的 OpenAI function tool 定义。 */
const AGENT_SEARCH_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "搜索互联网获取当前信息。返回标题、URL 和摘要。中文关键词搜索效果更好。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索查询关键词。中文关键词在前，英文术语原样保留。" },
          maxResults: { type: "integer", description: "期望返回的最大结果数（默认 5）" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "抓取指定 URL 的网页正文内容。用于获取搜索结果中某个页面的完整详情。使用 web_search 返回的 URL。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "要抓取的网页 URL（来自 web_search 结果）" },
        },
        required: ["url"],
      },
    },
  },
];

const MAX_SEARCH_CALLS = 5;
const MAX_AGENT_TURNS = 10;

export class ModelGateway {
  private callListener?: (event: ModelCallEvent) => void | Promise<void>;
  constructor(private readonly provider: ModelProvider, private readonly options: { model?: string; promptVersion?: string; thinking?: boolean; pricing?: Record<string, ModelPricing>; onCall?: (event: ModelCallEvent) => void | Promise<void> } = {}) { this.callListener = options.onCall; }

  get providerName(): string { return this.provider.name; }
  get modelName(): string { return this.options.model ?? this.provider.defaultModel ?? "default"; }
  get providerGroundingCapability(): import("@collector/capture-contracts").ProviderWebGrounding {
    return this.provider instanceof OpenAiResponsesProvider ? "openai_web_search"
      : this.provider instanceof GeminiGroundingProvider ? "gemini_google_search"
        : this.provider instanceof AnthropicMessagesProvider ? "anthropic_web_search" : "unsupported";
  }
  setCallListener(listener: ((event: ModelCallEvent) => void | Promise<void>) | undefined): void { this.callListener = listener; }

  private async emitCall(event: ModelCallEvent): Promise<void> {
    try { await this.callListener?.(event); }
    catch (error) { console.error("Model call listener failed", error); }
  }

  private async complete(request: ModelProviderRequest, context: ModelCallContext): Promise<ModelProviderResponse> {
    const createdAt = new Date().toISOString();
    const startedAt = Date.now();
    try {
      const response = await this.provider.complete(request);
      await this.emitCall({
        context, provider: this.providerName, model: response.model ?? request.model, promptVersion: context.promptVersion ?? this.promptVersion, status: "completed",
        usage: response.usage, estimatedCostUsd: estimateCost(response.model ?? request.model, response.usage, this.options.pricing ?? this.provider.pricing),
        latencyMs: Date.now() - startedAt, createdAt, completedAt: new Date().toISOString(),
      });
      return response;
    } catch (error) {
      await this.emitCall({
        context, provider: this.providerName, model: request.model, promptVersion: context.promptVersion ?? this.promptVersion, status: "failed",
        latencyMs: Date.now() - startedAt, errorMessage: redactError(error), createdAt, completedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  get promptVersion(): string { return this.options.promptVersion ?? "knowledge-extraction-v1"; }

  async generateGroundedResearch(
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    grounding: ResearchGroundingRequest,
    options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext; parentChainContext?: ResearchParentChainContext } = {},
  ): Promise<GroundedResearchResponse> {
    if (!messages.length) throw new Error("Research conversation requires at least one message");
    const parentContext = formatResearchParentChainContext(options.parentChainContext);
    const prompt = `You are Collector's research assistant. Answer the latest user message using the conversation context. Use web research when available, preserve uncertainty, and only cite sources returned by the provider.\n\nConversation:\n${JSON.stringify(messages)}${parentContext ? `\n\n${parentContext}` : ""}`;
    const request = { prompt, model: options.model ?? this.modelName, grounding, maxTokens: options.maxTokens ?? 8_000, timeoutMs: options.timeoutMs ?? 120_000 };
    if (!("generateGroundedResearch" in this.provider)) {
      const content = await this.answerResearchConversation(messages, options);
      return { content, status: "grounding_unsupported", queries: [], sources: [], citations: [] };
    }
    const startedAt = Date.now();
    const createdAt = new Date().toISOString();
    try {
      const response = await (this.provider as GroundingModelProvider).generateGroundedResearch(request);
      await this.emitCall({
        context: options.context ?? { purpose: "research_grounding" }, provider: this.providerName, model: request.model,
        promptVersion: grounding.promptVersion, status: "completed", latencyMs: Date.now() - startedAt, createdAt, completedAt: new Date().toISOString(),
      });
      return response;
    } catch (error) {
      await this.emitCall({
        context: options.context ?? { purpose: "research_grounding" }, provider: this.providerName, model: request.model,
        promptVersion: grounding.promptVersion, status: "failed", latencyMs: Date.now() - startedAt, errorMessage: redactError(error), createdAt, completedAt: new Date().toISOString(),
      });
      try {
        const content = await this.answerResearchConversation(messages, options);
        return { content, status: "grounding_failed", queries: [], sources: [], citations: [], errorMessage: redactError(error) };
      } catch { throw error; }
    }
  }

  async answerResearchConversation(
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext; parentChainContext?: ResearchParentChainContext } = {},
  ): Promise<string> {
    if (!messages.length) throw new Error("Research conversation requires at least one message");
    const parentContext = formatResearchParentChainContext(options.parentChainContext);
    const prompt = `You are Collector's research assistant. Answer the latest user message using the conversation context. Return valid JSON only in the form {"answer":"..."}. Preserve uncertainty and never invent sources.\n\nConversation:\n${JSON.stringify(messages)}${parentContext ? `\n\n${parentContext}` : ""}`;
    const response = await this.complete({
      prompt,
      model: options.model ?? this.modelName,
      responseFormat: { type: "json_object" },
      thinking: this.options.thinking ?? true,
      maxTokens: options.maxTokens ?? 8_000,
      timeoutMs: options.timeoutMs ?? 120_000,
    }, options.context ?? { purpose: "research_chat" });
    const parsed = JSON.parse(response.content) as { answer?: unknown };
    if (typeof parsed.answer !== "string" || !parsed.answer.trim()) throw new Error("Research provider returned an invalid answer");
    return parsed.answer;
  }

  /** H6：为节点生成简洁显示名称；调用方负责做长度与空值校验和确定性回退。 */
  async generateNodeDisplayName(
    input: { content: string; parentChainContext?: ResearchParentChainContext },
    options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {},
  ): Promise<string> {
    const parentContext = formatResearchParentChainContext(input.parentChainContext);
    const prompt = [
      "你是 Collector 的节点命名助手。请为下面的研究节点生成一个简洁、准确的中文显示名称。",
      "只返回合法 JSON：{\"name\":\"...\"}。名称不超过 20 个字符，不要添加引号、编号或解释。",
      `节点内容：${JSON.stringify(input.content.slice(0, 2000))}`,
      parentContext,
    ].filter(Boolean).join("\n\n");
    const response = await this.complete({
      prompt,
      model: options.model ?? this.modelName,
      responseFormat: { type: "json_object" },
      thinking: false,
      maxTokens: options.maxTokens ?? 128,
      timeoutMs: options.timeoutMs ?? 30_000,
    }, options.context ?? { purpose: "research", promptVersion: "node-naming-v1" });
    const parsed = JSON.parse(response.content) as { name?: unknown };
    if (typeof parsed.name !== "string" || !parsed.name.trim()) throw new Error("Node naming provider returned an invalid name");
    return parsed.name.trim();
  }

  /**
   * 深入研究第一轮：只使用提供的当前已有材料（来源内容 + 选区上下文 + 用户方向），
   * 不联网检索，不编造来源。返回模型回答文本。
   */
  async generateDeepResearchRound(
    input: {
      mode: "branch" | "session";
      selectionText: string;
      direction: string;
      contentTitle?: string;
      contextBefore?: string;
      contextAfter?: string;
      parentChainContext?: ResearchParentChainContext;
    },
    options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {},
  ): Promise<string> {
    if (!input.selectionText.trim()) throw new Error("Deep research requires the source selection text");
    if (!input.direction.trim()) throw new Error("Deep research requires a research direction");
    const parentContext = formatResearchParentChainContext(input.parentChainContext);
    const prompt = `你是 Collector 的深入研究助手。用户从一段选区发起了深入研究第一轮。只使用下面提供的当前已有材料生成研究内容，不要联网检索，不要编造来源、链接或引用。只返回合法 JSON，形式为 {"answer":"..."}，不要使用 Markdown 代码围栏。

用户选区原文：
${JSON.stringify(input.selectionText)}
${input.contentTitle ? `\n来源内容标题：${JSON.stringify(input.contentTitle)}` : ""}
${input.contextBefore ? `\n选区前文（仅供上下文）：\n${JSON.stringify(input.contextBefore)}` : ""}
${input.contextAfter ? `\n选区后文（仅供上下文）：\n${JSON.stringify(input.contextAfter)}` : ""}
${input.mode === "branch" ? "\n研究沿当前内容展开。" : "\n研究在新的独立会话中展开。"}

用户的研究方向：
${JSON.stringify(input.direction)}
${parentContext ? `\n${parentContext}` : ""}

要求：
- 围绕用户方向，基于选区与上下文展开解释、拆解或延伸；
- 只依据提供的材料，不编造外部事实、链接或来源；
- 材料不足以支撑时在回答中如实说明不确定性；
- answer 使用中文。`;
    const response = await this.complete({
      prompt,
      model: options.model ?? this.modelName,
      responseFormat: { type: "json_object" },
      thinking: this.options.thinking ?? true,
      maxTokens: options.maxTokens ?? 8_000,
      timeoutMs: options.timeoutMs ?? 120_000,
    }, options.context ?? { purpose: "deep_research" });
    const parsed = JSON.parse(response.content) as { answer?: unknown };
    if (typeof parsed.answer !== "string" || !parsed.answer.trim()) throw new Error("Deep research provider returned an invalid answer");
    return parsed.answer;
  }

  async analyzeSelection(
    input: {
      text: string;
      contextBefore?: string;
      contextAfter?: string;
      contentTitle?: string;
      recentUserMessages?: string[];
    },
    options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {},
  ): Promise<ResearchSelectionInsight> {
    if (!input.text.trim()) throw new Error("Selection analysis requires selected text");
    const prompt = `你是 Collector 的选区分析助手。用户在本地研究应用中手动选中了一段内容，需要你给出一段忠实、克制、不编造来源的分析。只返回合法 JSON，不要使用 Markdown 代码围栏。

选区原文：
${JSON.stringify(input.text)}
${input.contextBefore ? `\n选区前文（仅供上下文）：\n${JSON.stringify(input.contextBefore)}` : ""}
${input.contextAfter ? `\n选区后文（仅供上下文）：\n${JSON.stringify(input.contextAfter)}` : ""}
${input.contentTitle ? `\n所在内容标题：${JSON.stringify(input.contentTitle)}` : ""}
${input.recentUserMessages?.length ? `\n用户最近关注的问题：\n${input.recentUserMessages.map((message) => `- ${message}`).join("\n")}` : ""}

返回一个 JSON 对象，字段如下：
- "summary": 用一两句话说明这段在说什么（中文）
- "difficulty": "低" | "中" | "高"，表示理解难度
- "quickReadMinutes": 快速了解大约需要的分钟数（整数）
- "deepStudyMinutes": 深入研究大约需要的分钟数（整数）
- "prerequisites": 可能需要的前置知识，字符串数组，最多 6 条，没有则为 []
- "relationToContent": 这段与当前内容的关系（中文，一两句话）
- "relationToFocus": 这段与用户当前关注方向的关系（中文，一两句话；无法判断时省略该字段）
- "rationale": 判断依据与不确定性（中文，如实说明哪些判断不确定）

规则：
- 只依据提供的选区与上下文，不编造外部事实、链接或来源；
- 不确定时在 rationale 中如实说明，而不是给出肯定结论。`;
    const response = await this.complete({
      prompt,
      model: options.model ?? this.modelName,
      responseFormat: { type: "json_object" },
      thinking: this.options.thinking ?? false,
      maxTokens: options.maxTokens ?? 2_000,
      timeoutMs: options.timeoutMs ?? 60_000,
    }, options.context ?? { purpose: "selection_analysis" });
    let raw: unknown;
    try {
      raw = JSON.parse(response.content);
    } catch {
      throw new Error("Selection analysis provider returned invalid JSON");
    }
    return parseResearchSelectionInsight(raw);
  }

  /**
   * 将用户自然语言问题改写为适合搜索引擎的查询关键词。
   * 轻量调用，不做深层语义理解，只做中英文分词优化。
   */
  async reformulateSearchQuery(
    userMessage: string,
    options: { model?: string; timeoutMs?: number; context?: ModelCallContext } = {},
  ): Promise<string> {
    if (!userMessage.trim()) return userMessage;
    const prompt = `将以下用户问题改写为适合搜索引擎的查询关键词。规则：
- 中文关键词在前，英文术语原样保留（仅词级，不要整句翻译）
- 提取核心实体和概念，去掉疑问词、语气词（如"什么是""怎么""吗""呢"）
- 返回空格分隔的关键词，不要句子，不要解释

用户问题：${userMessage}

关键词：`;
    try {
      const response = await this.complete({
        prompt,
        model: options.model ?? this.modelName,
        responseFormat: { type: "json_object" },
        thinking: false,
        maxTokens: 200,
        timeoutMs: options.timeoutMs ?? 10_000,
      }, options.context ?? { purpose: "query_reformulation" });
      const parsed = JSON.parse(response.content) as { keywords?: unknown };
      if (typeof parsed.keywords === "string" && parsed.keywords.trim()) {
        const reformulated = parsed.keywords.trim();
        console.log(`[search-query] reformulated "${userMessage.slice(0, 80)}" → "${reformulated}"`);
        return reformulated;
      }
    } catch (error) {
      console.log(`[search-query] reformulation failed, using original query: ${error instanceof Error ? error.message : "unknown"}`);
    }
    // 失败时返回原文，不阻塞搜索
    return userMessage.trim();
  }

  /**
   * Agent 式多轮搜索：让模型通过 web_search/web_fetch 工具自主完成搜索过程。
   * 模型可以搜索 → 看结果 → 决定抓取哪些页面 → 信息不够则换词重搜 → 循环直到满意。
   * 工具实现由调用方注入（model-gateway 不依赖 Bing/Readability）。
   */
  async runAgentSearchLoop(
    userMessage: string,
    tools: AgentSearchToolContext,
    options: {
      maxTurns?: number;
      systemPrompt?: string;
      context?: ModelCallContext;
    } = {},
  ): Promise<AgentSearchResult> {
    if (typeof (this.provider as any).agentChat !== "function") {
      throw new Error("Agent search loop requires a provider that supports agentChat (tool calling)");
    }
    const maxTurns = options.maxTurns ?? MAX_AGENT_TURNS;
    const loopStartedAt = Date.now();
    console.log(`[web-search] agentLoop start userMessage="${userMessage.slice(0, 80)}" maxTurns=${maxTurns}`);

    const provider = this.provider as ModelProvider & { agentChat?: OpenAiCompatibleProvider["agentChat"] };
    if (typeof provider.agentChat !== "function") {
      throw new Error("Agent search loop requires a provider that supports agentChat (tool calling)");
    }

    const messages: AgentChatMessage[] = [
      { role: "system", content: options.systemPrompt ?? AGENT_SEARCH_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ];

    const queries: string[] = [];
    const sources: GroundingSource[] = [];
    const sourceUrlSet = new Set<string>();
    let searchCallCount = 0;
    let fetchCallCount = 0;

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      console.log(`[web-search] agentLoop turn=${turn} messagesLen=${messages.length} searchCalls=${searchCallCount} fetchCalls=${fetchCallCount}`);
      const startedAt = Date.now();
      const response = await provider.agentChat(messages, AGENT_SEARCH_TOOLS, {
        model: this.modelName,
        maxTokens: 4096,
        thinking: this.options.thinking ?? true,
      });
      console.log(`[web-search] agentLoop turn=${turn} finishReason=${response.finishReason} latency=${Date.now() - startedAt}ms`);

      if (response.finishReason === "stop") {
        const content = response.message.content ?? "";
        console.log(`[web-search] agentLoop completed turns=${turn} queries=${queries.length} fetchCount=${fetchCallCount} sourceCount=${sources.length} contentLen=${content.length} latency=${Date.now() - loopStartedAt}ms`);
        return { content, queries, sources };
      }

      if (response.finishReason === "tool_calls" && response.message.toolCalls?.length) {
        // Append assistant message with tool_calls to conversation history
        messages.push({
          role: "assistant",
          content: response.message.content,
          tool_calls: response.message.toolCalls.map((tc) => ({
            id: tc.id,
            type: tc.type,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        });

        for (const tc of response.message.toolCalls) {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
          } catch {
            args = {};
          }

          if (tc.function.name === "web_search") {
            searchCallCount += 1;
            if (searchCallCount > MAX_SEARCH_CALLS) {
              console.log(`[web-search] agentLoop searchCapReached searchCalls=${searchCallCount}`);
              messages.push({
                role: "tool" as const,
                tool_call_id: tc.id,
                content: "已达到搜索轮次上限(5次)。请基于已有信息给出回答，不要继续搜索。",
              });
              continue;
            }

            const query = typeof args.query === "string" ? args.query.trim() : "";
            if (!query) {
              messages.push({ role: "tool" as const, tool_call_id: tc.id, content: JSON.stringify({ error: "query is required" }) });
              continue;
            }
            const maxResults = typeof args.maxResults === "number" ? Math.max(1, Math.min(args.maxResults, 10)) : 5;
            const result = await tools.webSearch(query, maxResults);
            queries.push(query);

            // Format results with global ordinals, dedup by URL
            const formatted: Array<{ ordinal: number; title: string; url: string; snippet: string }> = [];
            for (const r of result.results) {
              if (!sourceUrlSet.has(r.url)) {
                sourceUrlSet.add(r.url);
                sources.push({ title: r.title, url: r.url, snippet: r.snippet });
              }
              const ordinal = sources.findIndex((s) => s.url === r.url) + 1;
              formatted.push({ ordinal, title: r.title, url: r.url, snippet: r.snippet });
            }

            messages.push({
              role: "tool" as const,
              tool_call_id: tc.id,
              content: JSON.stringify({ query: result.query, total_results: result.total_results, results: formatted }),
            });

            console.log(`[web-search] agentLoop webSearch query="${query}" resultCount=${formatted.length} totalSources=${sources.length}`);
          } else if (tc.function.name === "web_fetch") {
            fetchCallCount += 1;
            const url = typeof args.url === "string" ? args.url.trim() : "";
            if (!url) {
              messages.push({ role: "tool" as const, tool_call_id: tc.id, content: JSON.stringify({ error: "url is required" }) });
              continue;
            }
            const result = await tools.webFetch(url);

            // Try to find existing source by URL to include its ordinal
            const existingOrdinal = sources.findIndex((s) => s.url === url) + 1;
            const contentText = result.errorMessage
              ? `抓取失败: ${result.errorMessage}`
              : `[来源${existingOrdinal || "?"} 完整内容]\n${result.content}`;

            messages.push({ role: "tool" as const, tool_call_id: tc.id, content: contentText });

            console.log(`[web-search] agentLoop webFetch url="${url}" contentLen=${result.content.length}${result.errorMessage ? ` error="${result.errorMessage}"` : ""}`);
          } else {
            messages.push({
              role: "tool" as const,
              tool_call_id: tc.id,
              content: JSON.stringify({ error: `Unknown tool: ${tc.function.name}` }),
            });
            console.log(`[web-search] agentLoop unknownTool name="${tc.function.name}"`);
          }
        }
        continue;
      }

      // finishReason was "length" or "content_filter" — push the model to wrap up
      messages.push({ role: "user", content: "请基于已有信息给出简要回答（标注[来源n]引用），不要继续搜索。" });
    }

    throw new Error(`Agent search loop exceeded ${maxTurns} turns without producing a response`);
  }

  async clusterMaterials(materials: Array<{ id: string; content: string }>, options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {}): Promise<{ clusters: Array<{ name: string; summary: string; materialIds: string[] }>; unclusteredMaterialIds: string[] }> {
    if (materials.length <= 1) return { clusters: [], unclusteredMaterialIds: materials.map((m) => m.id) };
    const requestedModel = options.model ?? this.modelName;
    const validIds = new Set(materials.map((m) => m.id));
    const materialList = materials.map((m) => "[MATERIAL " + m.id + "] " + m.content.slice(0, 800)).join("\n\n");
    const prompt = `You are a knowledge organizer. Group related materials into topic clusters. Return valid JSON only.\n\nMaterials:\n${materialList}\n\nReturn a JSON object with:\n- "clusters": array of { "name": string, "summary": string (one sentence), "materialIds": string[] }\n- "unclusteredMaterialIds": string[] for materials that do not fit any cluster\n\nRULES:\n- Every materialId must appear exactly once across all clusters and unclusteredMaterialIds.\n- Do not invent new IDs.\n- If materials are unrelated, put all in unclusteredMaterialIds.\n- Clusters should be meaningful, not forced.`;
    const request: ModelProviderRequest = {
      prompt, model: requestedModel, responseFormat: { type: "json_object" } as const,
      thinking: options.thinking ?? false, maxTokens: options.maxTokens ?? 4000, timeoutMs: options.timeoutMs ?? 30000,
    };
    try {
      const response = await this.complete(request, options.context ?? { purpose: "cluster_materials" });
      if (!response.content?.trim()) return { clusters: [], unclusteredMaterialIds: materials.map((m) => m.id) };
      const parsed: Record<string, unknown> = JSON.parse(response.content.trim());
      const clusters: Array<{ name: string; summary: string; materialIds: string[] }> = [];
      const seenIds = new Set<string>();
      if (Array.isArray(parsed.clusters)) {
        for (const c of parsed.clusters as Array<Record<string, unknown>>) {
          if (typeof c.name !== "string" || !c.name.trim()) continue;
          if (typeof c.summary !== "string" || !c.summary.trim()) continue;
          if (!Array.isArray(c.materialIds)) continue;
          const materialIds: string[] = (c.materialIds as unknown[]).filter((id: unknown) => typeof id === "string" && validIds.has(id as string)) as string[];
          if (!materialIds.length) continue;
          for (const id of materialIds) seenIds.add(id);
          clusters.push({ name: (c.name as string).trim(), summary: (c.summary as string).trim(), materialIds });
        }
      }
      const unclusteredMaterialIds = materials.map((m) => m.id).filter((id) => !seenIds.has(id));
      return { clusters, unclusteredMaterialIds };
    } catch {
      return { clusters: [], unclusteredMaterialIds: materials.map((m) => m.id) };
    }
  }
  async generateDocumentOutline(materials: Array<{ id: string; content: string }>, topicTitle: string, options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {}): Promise<{ title: string; sections: Array<{ heading: string; keyPoints: string[] }> } | { errorCode: string; errorMessage: string }> {
    if (!materials.length) return { errorCode: "empty_response", errorMessage: "No materials for outline generation" };
    const requestedModel = options.model ?? this.modelName;
    try {
      let title = topicTitle;
      const sectionsByHeading = new Map<string, { heading: string; keyPoints: string[] }>();
      for (const batch of buildMaterialBatches(materials)) {
        const materialText = batch.map((material) => `[MATERIAL ${material.id}]\n${material.content}`).join("\n\n---\n\n");
        const prompt = "You are a technical writer. Create a document outline based on the provided materials about \"" + topicTitle + "\". Return valid JSON only.\n\nMaterials:\n" + materialText + "\n\nReturn JSON:\n{\n  \"title\": string (descriptive document title),\n  \"sections\": [\n    { \"heading\": string, \"keyPoints\": string[] (2-4 key points per section) }\n  ]\n}\n\nRULES:\n- Create coherent sections that organize only this material batch.\n- Each keyPoint must be a complete sentence.\n- Do not invent content not present in the materials.";
        const response = await this.complete({
          prompt, model: requestedModel, responseFormat: { type: "json_object" } as const,
          thinking: options.thinking ?? false, maxTokens: options.maxTokens ?? 3000, timeoutMs: options.timeoutMs ?? 60000,
        }, options.context ?? { purpose: "document_outline" });
        if (!response.content?.trim()) return { errorCode: "empty_response", errorMessage: "Empty outline response" };
        const parsed = JSON.parse(response.content.trim());
        if (title === topicTitle && typeof parsed.title === "string" && parsed.title.trim()) title = parsed.title.trim();
        if (!Array.isArray(parsed.sections)) continue;
        for (const s of parsed.sections) {
          if (typeof s?.heading !== "string" || !s.heading.trim()) continue;
          const keyPoints = Array.isArray(s.keyPoints) ? s.keyPoints.filter((kp: unknown) => typeof kp === "string" && kp.trim()).map((kp: string) => kp.trim()).slice(0, 6) : [];
          if (!keyPoints.length) continue;
          const key = s.heading.trim().toLocaleLowerCase();
          const existing = sectionsByHeading.get(key);
          if (existing) existing.keyPoints = [...new Set([...existing.keyPoints, ...keyPoints])].slice(0, 12);
          else sectionsByHeading.set(key, { heading: s.heading.trim(), keyPoints });
        }
      }
      const sections = [...sectionsByHeading.values()];
      if (!sections.length) return { errorCode: "invalid_schema", errorMessage: "No valid sections in outline" };
      return { title, sections };
    } catch (err) {
      return { errorCode: "provider_error", errorMessage: safeProviderErrorSummary(err) };
    }
  }

  async generateDocumentSections(outline: { title: string; sections: Array<{ heading: string; keyPoints: string[] }> }, materials: Array<{ id: string; content: string; fragmentIds: string[] }>, options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {}): Promise<{ sections: Array<{ heading: string; markdown: string; citationIds: string[] }> } | { errorCode: string; errorMessage: string }> {
    if (!outline.sections.length || !materials.length) return { errorCode: "empty_response", errorMessage: "No sections or materials" };
    const requestedModel = options.model ?? this.modelName;
    const sectionSpecs = outline.sections.map((s, i) => "SECTION " + (i + 1) + ": \"" + s.heading + "\"\nKey Points: " + s.keyPoints.join("; ")).join("\n\n");
    try {
      const sectionsByHeading = new Map<string, { heading: string; markdown: string; citationIds: string[] }>();
      for (const batch of buildMaterialBatches(materials)) {
        const materialText = batch.map((material) => `[MATERIAL ${material.id}]\n${material.content}`).join("\n\n---\n\n");
        const prompt = "You are a technical writer. Draft full sections for a learning document titled \"" + outline.title + "\". Return valid JSON only.\n\nOutline:\n" + sectionSpecs + "\n\nSource Materials:\n" + materialText + "\n\nReturn JSON:\n{\n  \"sections\": [\n    {\n      \"heading\": string (matches outline heading),\n      \"markdown\": string (2-4 paragraph markdown section),\n      \"citationMaterialIds\": string[] (MATERIAL ids you cited)\n    }\n  ]\n}\n\nRULES:\n- Draft only claims supported by this source batch.\n- Cite materials by their MATERIAL id when you use specific information.\n- Only use material IDs from the provided list.\n- Do not invent content beyond what the materials contain.";
        const response = await this.complete({
          prompt, model: requestedModel, responseFormat: { type: "json_object" } as const,
          thinking: options.thinking ?? true, maxTokens: options.maxTokens ?? 8000, timeoutMs: options.timeoutMs ?? 120000,
        }, options.context ?? { purpose: "document_sections" });
        if (!response.content?.trim()) return { errorCode: "empty_response", errorMessage: "Empty sections response" };
        const parsed = JSON.parse(response.content.trim());
        const validMaterialIds = new Set(batch.map((material) => material.id));
        if (!Array.isArray(parsed.sections)) continue;
        for (const s of parsed.sections) {
          if (typeof s?.heading !== "string" || !s.heading.trim()) continue;
          if (typeof s?.markdown !== "string" || !s.markdown.trim()) continue;
          const rawIds = Array.isArray(s.citationMaterialIds) ? s.citationMaterialIds.filter((id: unknown) => typeof id === "string" && validMaterialIds.has(id)) : [];
          const citationIds: string[] = [];
          for (const mid of rawIds) {
            const mat = materials.find((m) => m.id === mid);
            if (mat) citationIds.push(...mat.fragmentIds);
          }
          const uniqueCitations = [...new Set(citationIds)];
          const key = s.heading.trim().toLocaleLowerCase();
          const existing = sectionsByHeading.get(key);
          if (existing) {
            existing.markdown = `${existing.markdown}\n\n${s.markdown.trim()}`;
            existing.citationIds = [...new Set([...existing.citationIds, ...uniqueCitations])];
          } else {
            sectionsByHeading.set(key, { heading: s.heading.trim(), markdown: s.markdown.trim(), citationIds: uniqueCitations });
          }
        }
      }
      const sections = [...sectionsByHeading.values()];
      if (!sections.length) return { errorCode: "invalid_schema", errorMessage: "No valid sections generated" };
      return { sections };
    } catch (err) {
      return { errorCode: "provider_error", errorMessage: safeProviderErrorSummary(err) };
    }
  }

  async generateDocumentUpdateAdditions(materials: Array<{ id: string; content: string; fragmentIds: string[] }>, options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {}): Promise<{ additions: Array<{ heading: string; markdown: string; citationIds: string[] }> } | { errorCode: string; errorMessage: string }> {
    if (!materials.length) return { additions: [] };
    const additions: Array<{ heading: string; markdown: string; citationIds: string[] }> = [];
    try {
      for (const batch of buildMaterialBatches(materials)) {
        const materialText = batch.map((material) => `[MATERIAL ${material.id}]\n${material.content}`).join("\n\n---\n\n");
        const prompt = `You are updating an existing topic document with newly confirmed materials. Organize only the new material into readable additions. Return valid JSON only.\n\nNew materials:\n${materialText}\n\nReturn JSON:\n{\n  "additions": [{ "heading": string, "markdown": string, "citationMaterialIds": string[] }]\n}\n\nRULES:\n- Every factual addition must cite one or more provided MATERIAL ids.\n- Do not copy raw source text as a substitute for synthesis.\n- Do not invent facts or material IDs.`;
        const response = await this.complete({
          prompt,
          model: options.model ?? this.modelName,
          responseFormat: { type: "json_object" } as const,
          thinking: options.thinking ?? true,
          maxTokens: options.maxTokens ?? 5000,
          timeoutMs: options.timeoutMs ?? 120000,
        }, options.context ?? { purpose: "incremental_document_update" });
        if (!response.content?.trim()) return { errorCode: "empty_response", errorMessage: "Empty document update response" };
        const parsed = JSON.parse(response.content.trim());
        if (!Array.isArray(parsed.additions)) continue;
        const validIds = new Set(batch.map((material) => material.id));
        for (const addition of parsed.additions) {
          if (typeof addition?.heading !== "string" || !addition.heading.trim()) continue;
          if (typeof addition?.markdown !== "string" || !addition.markdown.trim()) continue;
          const materialIds: string[] = Array.isArray(addition.citationMaterialIds)
            ? (addition.citationMaterialIds as unknown[]).filter((id): id is string => typeof id === "string" && validIds.has(id))
            : [];
          const citationIds: string[] = [...new Set(materialIds.flatMap((id) => materials.find((material) => material.id === id)?.fragmentIds ?? []))];
          if (!citationIds.length) continue;
          additions.push({ heading: addition.heading.trim(), markdown: addition.markdown.trim(), citationIds });
        }
      }
      if (!additions.length) return { errorCode: "invalid_schema", errorMessage: "No cited additions in document update" };
      return { additions };
    } catch (error) {
      return { errorCode: "provider_error", errorMessage: safeProviderErrorSummary(error) };
    }
  }


  async testConnection(options: { model?: string; timeoutMs?: number; context?: ModelCallContext } = {}): Promise<{ ok: true; model: string } | { ok: false; error: string }> {
    try {
      const response = await this.complete({
        prompt: "Say 'ok'",
        model: options.model ?? this.modelName,
        maxTokens: 10,
        timeoutMs: options.timeoutMs ?? 15000,
        responseFormat: { type: "json_object" } as const,
        thinking: false,
      }, options.context ?? { purpose: "connection_test" });
      return { ok: true, model: response.model ?? (options.model ?? this.modelName) };
    } catch (e) {
      return { ok: false, error: safeProviderErrorSummary(e) };
    }
  }
}

export class FakeProvider implements ModelProvider {
  readonly name = "fake";
  readonly defaultModel = "fake-model";
  readonly pricing = { "fake-model": { inputCacheHitPerMillion: 0, inputCacheMissPerMillion: 0, outputPerMillion: 0 } };
  calls: ModelProviderRequest[] = [];
  constructor(private readonly responses: Array<string | Error | ModelProviderResponse>) {}
  async complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    this.calls.push(request);
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    if (typeof response === "string") return { content: response, model: request.model, usage: { inputTokens: 10, outputTokens: 20 } };
    return response ?? { content: "", model: request.model };
  }
}

export interface OpenAiCompatibleProviderOptions {
  definition: ProviderDefinition;
  apiKey: () => Promise<string | undefined> | string | undefined;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly name: string;
  readonly defaultModel: string;
  readonly pricing?: Record<string, ModelPricing>;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: OpenAiCompatibleProviderOptions) {
    validateProviderDefinition(options.definition);
    if (options.definition.apiMode !== "openai_chat_completions") throw new Error(`Provider ${options.definition.id} does not use the OpenAI chat completions protocol`);
    this.name = options.definition.id;
    this.defaultModel = options.definition.defaultModel;
    this.pricing = options.definition.pricing;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const apiKey = await this.options.apiKey();
    if (!apiKey) throw new Error(`${this.options.definition.label} API key is not configured`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${this.options.definition.label} request timed out`)), request.timeoutMs ?? 75_000);
    let response: Response;
    let payload: any;
    try {
      const body: Record<string, unknown> = {
        model: request.model,
        messages: [{ role: "system", content: "Return valid json only. Fragment IDs and capture IDs are different identifier types and must never be interchanged." }, { role: "user", content: request.prompt }],
        response_format: request.responseFormat,
        max_tokens: request.maxTokens,
      };
      if (this.options.definition.capabilities.thinkingMode === "deepseek") body.thinking = { type: request.thinking ? "enabled" : "disabled" };
      response = await this.fetchImpl(`${normalizeBaseUrl(this.options.baseUrl ?? this.options.definition.defaultBaseUrl)}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: controller.signal,
        redirect: "error",
        body: JSON.stringify(body),
      });
      payload = await response.json().catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`${this.options.definition.label} request failed (HTTP ${response.status})`);
    return {
      content: payload?.choices?.[0]?.message?.content ?? "",
      model: payload?.model ?? request.model,
      usage: {
        inputTokens: payload?.usage?.prompt_tokens,
        outputTokens: payload?.usage?.completion_tokens,
        inputCacheHitTokens: payload?.usage?.prompt_cache_hit_tokens,
        inputCacheMissTokens: payload?.usage?.prompt_cache_miss_tokens,
      },
    };
  }

  /**
   * Agent 工具调用聊天（OpenAI Chat Completions 协议的 tools 扩展）。
   * 与 complete() 的关键区别：发送完整 messages[] 数组、附带 tools 定义、
   * 不发送 response_format（tool calls 与 JSON mode 互斥）、解析 finish_reason 与 tool_calls。
   * 此方法不在 ModelProvider 接口上，只在 OpenAiCompatibleProvider 类上。
   */
  async agentChat(
    messages: AgentChatMessage[],
    tools: ToolDefinition[],
    options: { model?: string; maxTokens?: number; timeoutMs?: number; thinking?: boolean } = {},
  ): Promise<AgentChatResponse> {
    const apiKey = await this.options.apiKey();
    if (!apiKey) throw new Error(`${this.options.definition.label} API key is not configured`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${this.options.definition.label} request timed out`)), options.timeoutMs ?? 120_000);
    let response: Response;
    let payload: any;
    try {
      const body: Record<string, unknown> = {
        model: options.model ?? this.defaultModel,
        messages: messages.map((m) => {
          const entry: Record<string, unknown> = { role: m.role };
          if (m.content !== null) entry.content = m.content;
          if (m.tool_calls) entry.tool_calls = m.tool_calls;
          if (m.tool_call_id) entry.tool_call_id = m.tool_call_id;
          return entry;
        }),
        tools: tools.map((t) => ({
          type: t.type,
          function: {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          },
        })),
        tool_choice: "auto",
        max_tokens: options.maxTokens ?? 4096,
      };
      if (this.options.definition.capabilities.thinkingMode === "deepseek") {
        body.thinking = { type: options.thinking ?? true ? "enabled" : "disabled" };
      }
      response = await this.fetchImpl(`${normalizeBaseUrl(this.options.baseUrl ?? this.options.definition.defaultBaseUrl)}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: controller.signal,
        redirect: "error",
        body: JSON.stringify(body),
      });
      payload = await response.json().catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`${this.options.definition.label} request failed (HTTP ${response.status})`);
    const choice = payload?.choices?.[0];
    const finishReason: AgentChatResponse["finishReason"] = choice?.finish_reason ?? "stop";
    const message = choice?.message;
    const rawCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    const toolCalls: AgentChatResponse["message"]["toolCalls"] = [];
    for (const tc of rawCalls) {
      if (tc?.type === "function" && tc?.function?.name) {
        toolCalls.push({
          id: tc.id ?? "",
          type: "function" as const,
          function: {
            name: tc.function.name,
            arguments: typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments ?? {}),
          },
        });
      }
    }
    return {
      finishReason,
      message: {
        role: "assistant",
        content: message?.content ?? null,
        ...(toolCalls.length ? { toolCalls } : {}),
      },
      model: payload?.model ?? (options.model ?? this.defaultModel),
      usage: {
        inputTokens: payload?.usage?.prompt_tokens,
        outputTokens: payload?.usage?.completion_tokens,
        inputCacheHitTokens: payload?.usage?.prompt_cache_hit_tokens,
        inputCacheMissTokens: payload?.usage?.prompt_cache_miss_tokens,
      },
    };
  }
}

export class OpenAiResponsesProvider implements GroundingModelProvider {
  readonly name: string;
  readonly defaultModel: string;
  readonly pricing?: Record<string, ModelPricing>;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAiCompatibleProviderOptions) {
    validateProviderDefinition(options.definition);
    if (options.definition.apiMode !== "openai_responses") throw new Error(`Provider ${options.definition.id} does not use the OpenAI Responses protocol`);
    this.name = options.definition.id;
    this.defaultModel = options.definition.defaultModel;
    this.pricing = options.definition.pricing;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const response = await this.request({ model: request.model, input: request.prompt, max_output_tokens: request.maxTokens });
    const content = openAiOutputText(response);
    return { content, model: response?.model ?? request.model, usage: openAiUsage(response?.usage) };
  }

  async generateGroundedResearch(request: { prompt: string; model: string; grounding: ResearchGroundingRequest; maxTokens?: number; timeoutMs?: number }): Promise<GroundedResearchResponse> {
    const payload = await this.request({
      model: request.model,
      input: request.prompt,
      max_output_tokens: request.maxTokens,
      tools: [{ type: "web_search" }],
      tool_choice: "required",
    }, request.timeoutMs);
    const content = openAiOutputText(payload);
    const annotations = openAiAnnotations(payload);
    const sources = uniqueSources(annotations.map((citation) => ({ title: citation.title || citation.url || "OpenAI 联网来源", url: citation.url })));
    const citations = annotations.flatMap((citation) => {
      const sourceOrdinal = sources.findIndex((source) => source.url === citation.url) + 1;
      return sourceOrdinal > 0 ? [{ sourceOrdinal, startOffset: citation.start_index ?? 0, endOffset: citation.end_index ?? citation.start_index ?? 0 }] : [];
    });
    const queries = extractOpenAiQueries(payload);
    return {
      content,
      status: sources.length ? "grounded" : "no_verifiable_sources",
      queries,
      sources,
      citations,
      responseSummary: { outputItemCount: Array.isArray(payload?.output) ? payload.output.length : 0 },
    };
  }

  private async request(body: Record<string, unknown>, timeoutMs = 75_000): Promise<any> {
    const apiKey = await this.options.apiKey();
    if (!apiKey) throw new Error(`${this.options.definition.label} API key is not configured`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${this.options.definition.label} request timed out`)), timeoutMs);
    try {
      const response = await this.fetchImpl(`${normalizeBaseUrl(this.options.baseUrl ?? this.options.definition.defaultBaseUrl)}/responses`, {
        method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, signal: controller.signal, redirect: "error", body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(`${this.options.definition.label} request failed (HTTP ${response.status})`);
      return payload;
    } finally { clearTimeout(timer); }
  }
}

export class GeminiGroundingProvider implements GroundingModelProvider {
  readonly name: string;
  readonly defaultModel: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAiCompatibleProviderOptions) {
    validateProviderDefinition(options.definition);
    if (options.definition.apiMode !== "gemini_generate_content") throw new Error(`Provider ${options.definition.id} does not use the Gemini GenerateContent protocol`);
    this.name = options.definition.id;
    this.defaultModel = options.definition.defaultModel;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const payload = await this.request(request.model, { contents: [{ role: "user", parts: [{ text: request.prompt }] }], generationConfig: { responseMimeType: "application/json", maxOutputTokens: request.maxTokens } }, request.timeoutMs);
    return { content: geminiText(payload), model: request.model, usage: geminiUsage(payload?.usageMetadata) };
  }

  async generateGroundedResearch(request: { prompt: string; model: string; grounding: ResearchGroundingRequest; maxTokens?: number; timeoutMs?: number }): Promise<GroundedResearchResponse> {
    const payload = await this.request(request.model, {
      contents: [{ role: "user", parts: [{ text: request.prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: request.maxTokens },
    }, request.timeoutMs);
    const candidate = payload?.candidates?.[0];
    const metadata = candidate?.groundingMetadata ?? {};
    const sources = uniqueSources((metadata.groundingChunks ?? []).map((chunk: any) => ({ title: chunk?.web?.title || chunk?.web?.uri || "Google 联网来源", url: chunk?.web?.uri, snippet: chunk?.web?.snippet })));
    const citations = (metadata.groundingSupports ?? []).flatMap((support: any) => (support?.groundingChunkIndices ?? []).map((index: number) => ({ sourceOrdinal: index + 1, startOffset: support?.segment?.startIndex ?? 0, endOffset: support?.segment?.endIndex ?? support?.segment?.startIndex ?? 0 })));
    return {
      content: geminiText(payload), status: sources.length ? "grounded" : "no_verifiable_sources", queries: stringArray(metadata.webSearchQueries), sources, citations,
      responseSummary: { groundingChunkCount: Array.isArray(metadata.groundingChunks) ? metadata.groundingChunks.length : 0 },
    };
  }

  private async request(model: string, body: Record<string, unknown>, timeoutMs = 75_000): Promise<any> {
    const apiKey = await this.options.apiKey();
    if (!apiKey) throw new Error(`${this.options.definition.label} API key is not configured`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${this.options.definition.label} request timed out`)), timeoutMs);
    try {
      const response = await this.fetchImpl(`${normalizeBaseUrl(this.options.baseUrl ?? this.options.definition.defaultBaseUrl)}/models/${encodeURIComponent(model)}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey }, signal: controller.signal, redirect: "error", body: JSON.stringify(body) });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(`${this.options.definition.label} request failed (HTTP ${response.status})`);
      return payload;
    } finally { clearTimeout(timer); }
  }
}

export class AnthropicMessagesProvider implements GroundingModelProvider {
  readonly name: string;
  readonly defaultModel: string;
  readonly pricing?: Record<string, ModelPricing>;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: OpenAiCompatibleProviderOptions) {
    validateProviderDefinition(options.definition);
    if (options.definition.apiMode !== "anthropic_messages") throw new Error(`Provider ${options.definition.id} does not use the Anthropic Messages protocol`);
    this.name = options.definition.id;
    this.defaultModel = options.definition.defaultModel;
    this.pricing = options.definition.pricing;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generateGroundedResearch(request: { prompt: string; model: string; grounding: ResearchGroundingRequest; maxTokens?: number; timeoutMs?: number }): Promise<GroundedResearchResponse> {
    const apiKey = await this.options.apiKey();
    if (!apiKey) throw new Error(`${this.options.definition.label} API key is not configured`);
    const deadline = Date.now() + (request.timeoutMs ?? 120_000);
    const messages: Array<Record<string, unknown>> = [{ role: "user", content: request.prompt }];
    let payload: any;
    for (let continuation = 0; continuation <= MAX_ANTHROPIC_SERVER_TOOL_CONTINUATIONS; continuation += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error(`${this.options.definition.label} request timed out`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`${this.options.definition.label} request timed out`)), remainingMs);
      try {
        const response = await this.fetchImpl(`${normalizeBaseUrl(this.options.baseUrl ?? this.options.definition.defaultBaseUrl)}/messages`, {
          method: "POST",
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
          signal: controller.signal,
          redirect: "error",
          body: JSON.stringify({
            model: request.model,
            max_tokens: request.maxTokens ?? 8_000,
            system: "Answer the research request. Use the web search tool before answering and cite only its returned sources.",
            messages,
            tools: [{ type: "web_search_20260209", name: "web_search" }, { type: "web_fetch_20260209", name: "web_fetch" }],
          }),
        });
        payload = await response.json().catch(() => undefined);
        if (!response.ok) throw new Error(`${this.options.definition.label} request failed (HTTP ${response.status})`);
      } finally {
        clearTimeout(timer);
      }
      if (payload?.stop_reason !== "pause_turn") break;
      if (continuation === MAX_ANTHROPIC_SERVER_TOOL_CONTINUATIONS) {
        throw new Error("Anthropic server-tool continuation limit exceeded");
      }
      // server-side tool blocks must stay verbatim in the history for the platform to resume them.
      messages.push({ role: "assistant", content: Array.isArray(payload?.content) ? payload.content : [] });
    }
    const textBlocks = Array.isArray(payload?.content)
      ? payload.content.filter((block: any) => block?.type === "text" && typeof block.text === "string")
      : [];
    const content = textBlocks.map((block: any) => block.text).join("");
    const candidates = textBlocks.flatMap((block: any) => (Array.isArray(block.citations) ? block.citations : []));
    const sources = uniqueSources(candidates.flatMap((citation: any) => {
      const url = safeHttpUrl(citation?.url);
      return url ? [{ title: typeof citation?.title === "string" ? citation.title : url, url, snippet: typeof citation?.cited_text === "string" ? citation.cited_text : undefined }] : [];
    }));
    let offset = 0;
    const citations = textBlocks.flatMap((block: any) => {
      const startOffset = offset;
      offset += block.text.length;
      return (Array.isArray(block.citations) ? block.citations : []).flatMap((citation: any) => {
        const url = safeHttpUrl(citation?.url);
        const sourceOrdinal = sources.findIndex((source) => source.url === url) + 1;
        return sourceOrdinal > 0 ? [{ sourceOrdinal, startOffset, endOffset: offset, ...(typeof citation?.id === "string" ? { providerCitationId: citation.id } : {}) }] : [];
      });
    });
    return {
      content,
      status: sources.length ? "grounded" : "no_verifiable_sources",
      queries: [],
      sources,
      citations,
      responseSummary: { contentBlockCount: Array.isArray(payload?.content) ? payload.content.length : 0, continuationCount: messages.length - 1 },
    };
  }

  async complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const apiKey = await this.options.apiKey();
    if (!apiKey) throw new Error(`${this.options.definition.label} API key is not configured`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${this.options.definition.label} request timed out`)), request.timeoutMs ?? 75_000);
    let response: Response;
    let payload: any;
    try {
      response = await this.fetchImpl(`${normalizeBaseUrl(this.options.baseUrl ?? this.options.definition.defaultBaseUrl)}/messages`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        signal: controller.signal,
        redirect: "error",
        body: JSON.stringify({
          model: request.model,
          max_tokens: request.maxTokens ?? 4000,
          system: "Return valid JSON only. Fragment IDs and capture IDs are different identifier types and must never be interchanged.",
          messages: [{ role: "user", content: request.prompt }],
        }),
      });
      payload = await response.json().catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`${this.options.definition.label} request failed (HTTP ${response.status})`);
    const cacheHitTokens = Number(payload?.usage?.cache_read_input_tokens ?? 0);
    const cacheCreationTokens = Number(payload?.usage?.cache_creation_input_tokens ?? 0);
    const uncachedInputTokens = Number(payload?.usage?.input_tokens ?? 0);
    return {
      content: Array.isArray(payload?.content) ? payload.content.filter((block: any) => block?.type === "text" && typeof block.text === "string").map((block: any) => block.text).join("") : "",
      model: payload?.model ?? request.model,
      usage: {
        inputTokens: uncachedInputTokens + cacheHitTokens + cacheCreationTokens,
        outputTokens: payload?.usage?.output_tokens,
        inputCacheHitTokens: cacheHitTokens,
        inputCacheMissTokens: uncachedInputTokens + cacheCreationTokens,
      },
    };
  }
}

export function createProvider(definition: ProviderDefinition, options: Omit<OpenAiCompatibleProviderOptions, "definition">): ModelProvider {
  if (definition.apiMode === "openai_chat_completions") return new OpenAiCompatibleProvider({ ...options, definition });
  if (definition.apiMode === "openai_responses") return new OpenAiResponsesProvider({ ...options, definition });
  if (definition.apiMode === "gemini_generate_content") return new GeminiGroundingProvider({ ...options, definition });
  if (definition.apiMode === "anthropic_messages") return new AnthropicMessagesProvider({ ...options, definition });
  throw new Error(`Unsupported provider API mode: ${definition.apiMode}`);
}

export interface DiscoverProviderModelsOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * 从供应商端点发现可调用模型列表（对齐 CC Switch「获取模型」）。
 * 按 apiMode 选择协议：OpenAI 兼容与 Anthropic 均为 GET {baseUrl}/models 解析 data[].id；
 * Gemini 为 GET {baseUrl}/models 解析 models[].name 并去掉 models/ 前缀。
 * 错误按认证失败 / 端点不支持 / 解析失败 / 超时分类，文案面向用户，不包含凭证。
 */
export async function discoverProviderModels(
  definition: ProviderDefinition,
  baseUrl: string,
  apiKey: string,
  options: DiscoverProviderModelsOptions = {},
): Promise<ProviderModelDiscoveryResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("model discovery timed out")), options.timeoutMs ?? 10_000);
  try {
    const root = normalizeBaseUrl(baseUrl);
    const headers: Record<string, string> = definition.apiMode === "anthropic_messages"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : definition.apiMode === "gemini_generate_content"
        ? { "x-goog-api-key": apiKey }
        : { Authorization: `Bearer ${apiKey}` };
    const response = await fetchImpl(`${root}/models`, { method: "GET", headers, signal: controller.signal, redirect: "error" });
    if (response.status === 401 || response.status === 403) return { ok: false, error: "认证失败：请检查 API Key 是否正确" };
    if (response.status === 404 || response.status === 405) return { ok: false, error: "该供应商未提供模型列表端点，请手动填写模型名称" };
    if (!response.ok) return { ok: false, error: `模型列表请求失败（HTTP ${response.status}）` };
    const payload = await response.json().catch(() => undefined);
    const raw: unknown[] | undefined = definition.apiMode === "gemini_generate_content"
      ? (Array.isArray(payload?.models) ? payload.models.map((entry: any) => typeof entry?.name === "string" ? entry.name.replace(/^models\//, "") : undefined) : undefined)
      : (Array.isArray(payload?.data) ? payload.data.map((entry: any) => typeof entry?.id === "string" ? entry.id : undefined) : undefined);
    const models = raw ? [...new Set(raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))] : [];
    if (!models.length) return { ok: false, error: "模型列表解析失败：返回内容不符合预期格式，请手动填写模型名称" };
    return { ok: true, models };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/timed out|timeout|abort/i.test(message)) return { ok: false, error: "模型列表请求超时，请稍后重试或检查网络" };
    return { ok: false, error: "模型列表请求失败，请检查网络后重试" };
  } finally {
    clearTimeout(timer);
  }
}

function openAiOutputText(payload: any): string {
  if (typeof payload?.output_text === "string") return payload.output_text;
  return (payload?.output ?? []).flatMap((item: any) => item?.content ?? []).filter((part: any) => part?.type === "output_text" && typeof part.text === "string").map((part: any) => part.text).join("");
}

function openAiAnnotations(payload: any): Array<{ url?: string; title?: string; start_index?: number; end_index?: number }> {
  return (payload?.output ?? []).flatMap((item: any) => item?.content ?? []).flatMap((part: any) => part?.annotations ?? []).filter((annotation: any) => annotation?.type === "url_citation" && typeof annotation.url === "string");
}

function extractOpenAiQueries(payload: any): string[] {
  return (payload?.output ?? []).filter((item: any) => item?.type === "web_search_call").map((item: any) => item?.action?.query ?? item?.query).filter((query: unknown): query is string => typeof query === "string");
}

function openAiUsage(usage: any): ProviderUsage | undefined {
  if (!usage) return undefined;
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, inputCacheHitTokens: usage.input_tokens_details?.cached_tokens, inputCacheMissTokens: usage.input_tokens };
}

function geminiText(payload: any): string {
  return (payload?.candidates?.[0]?.content?.parts ?? []).map((part: any) => typeof part?.text === "string" ? part.text : "").join("");
}

function geminiUsage(usage: any): ProviderUsage | undefined {
  if (!usage) return undefined;
  return { inputTokens: usage.promptTokenCount, outputTokens: usage.candidatesTokenCount };
}

function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }

function uniqueSources(sources: GroundingSource[]): GroundingSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = source.url ?? `${source.title}:${source.providerSourceId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch { return undefined; }
}

const MAX_ANTHROPIC_SERVER_TOOL_CONTINUATIONS = 5;

function buildMaterialBatches<T extends { id: string; content: string }>(materials: T[], maxBatchChars = 24_000): T[][] {
  const segments: T[] = [];
  for (const material of materials) {
    const content = material.content || " ";
    for (let offset = 0; offset < content.length; offset += maxBatchChars) {
      segments.push({ ...material, content: content.slice(offset, offset + maxBatchChars) });
    }
  }
  const batches: T[][] = [];
  let batch: T[] = [];
  let size = 0;
  for (const segment of segments) {
    if (batch.length && size + segment.content.length > maxBatchChars) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(segment);
    size += segment.content.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function safeProviderErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/timed out|timeout|aborted/i.test(message)) return "模型供应商请求超时";
  const status = message.match(/HTTP\s+(\d{3})/i)?.[1];
  return status ? `模型供应商请求失败（HTTP ${status}）` : "模型供应商请求失败";
}

function redactError(error: unknown): string {
  return (error instanceof Error ? error.message : "Model provider failed")
    .replace(/(authorization|api[-_]?key|token|secret|cookie|signature|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b(?:sk|AIza)[-_A-Za-z0-9]{12,}\b/g, "[REDACTED]")
    .slice(0, 500);
}

function normalizeBaseUrl(value: string): string { return value.replace(/\/+$/, ""); }

export function fingerprintBaseUrl(value: string): string {
  return createHash("sha256").update(normalizeBaseUrl(value).toLocaleLowerCase()).digest("hex");
}

export async function validateExternalProviderBaseUrl(
  value: string,
  lookupImpl: typeof lookup = lookup,
): Promise<string> {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Provider base URL must be an absolute URL"); }
  if (url.protocol !== "https:") throw new Error("Provider base URL must use HTTPS");
  if (url.username || url.password) throw new Error("Provider base URL cannot contain credentials");
  const hostname = url.hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) throw new Error("Provider base URL must use a public host");
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookupImpl(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIpAddress(address))) throw new Error("Provider base URL resolved to a non-public address");
  url.hash = "";
  url.search = "";
  return normalizeBaseUrl(url.toString());
}

function isPublicIpAddress(address: string): boolean {
  const normalized = address.toLocaleLowerCase();
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized)) return false;
  if (normalized.startsWith("::ffff:")) return isPublicIpAddress(normalized.slice(7));
  if (isIP(normalized) === 6) return true;
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)));
}

function addUsage(left: ProviderUsage | undefined, right: ProviderUsage | undefined): ProviderUsage | undefined {
  if (!left && !right) return undefined;
  return {
    inputTokens: sumOptional(left?.inputTokens, right?.inputTokens),
    outputTokens: sumOptional(left?.outputTokens, right?.outputTokens),
    inputCacheHitTokens: sumOptional(left?.inputCacheHitTokens, right?.inputCacheHitTokens),
    inputCacheMissTokens: sumOptional(left?.inputCacheMissTokens, right?.inputCacheMissTokens),
  };
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}

function estimateCost(model: string, usage: ProviderUsage | undefined, pricingOverride: Record<string, ModelPricing> | undefined): number | undefined {
  if (!usage) return undefined;
  const pricing = pricingOverride?.[model];
  if (!pricing) return undefined;
  const input = usage.inputTokens ?? 0;
  const cacheHit = usage.inputCacheHitTokens ?? 0;
  const cacheMiss = usage.inputCacheMissTokens ?? Math.max(0, input - cacheHit);
  const output = usage.outputTokens ?? 0;
  const cost = (cacheHit * pricing.inputCacheHitPerMillion + cacheMiss * pricing.inputCacheMissPerMillion + output * pricing.outputPerMillion) / 1_000_000;
  return Math.round(cost * 1_000_000_000_000) / 1_000_000_000_000;
}
