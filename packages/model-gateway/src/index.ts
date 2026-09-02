import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ASSOCIATION_HINT_BENEFITS, ASSOCIATION_HINT_EVALUATION_PROMPT_VERSION, FUSION_RELATION_TYPES, IMPORT_CHAPTER_PARSE_PROMPT_VERSION, IMPORT_CHAPTER_PARSE_TOKEN_BUDGET, RESEARCH_NATIVE_SLICE_MAX_CONCEPTS, RESEARCH_NATIVE_SLICE_MAX_CONCEPT_CHARACTERS, RESEARCH_NATIVE_SLICE_MAX_TITLE_CHARACTERS, SIMILARITY_VERIFICATION_PROMPT_VERSION, TEMPORARY_FUSION_DISCOVERY_PROMPT_VERSION, TEMPORARY_FUSION_DISCOVERY_TOKEN_BUDGET, TERM_IDENTITY_CONTEXT_MAX_CHARACTERS, TERM_IDENTITY_TEXT_MAX_CHARACTERS, TERM_IDENTITY_VERIFY_PROMPT_VERSION, observeContextAssembly, resolveResearchConvergence, validateProviderDefinition, type ActiveModelRoute, type ContextAssemblyObservation, type ContextAssemblyResult, type FusionRelationType, type GroundingEvidenceStatus, type ProviderDefinition, type ProviderModelDiscoveryResult, type ProviderProfile, type ResearchAssociationHintBenefit, type ResearchCitationCandidate, type ResearchCitationSourceIdentity, type ResearchGroundingRequest, type ResearchGroundingScopeStatus, type ResearchSliceContext, type TermIdentityVerificationRequest } from "@collector/capture-contracts";
import type { AppliedModelBudget, ModelBudgetLimits, PromptEnvelope, PromptEnvelopeObservation, RequestedModelBudget, ResolvedModelBudget } from "@collector/capture-contracts";
import type { ModelCapabilityMatrix } from "@collector/capture-contracts";
import {
  DEFAULT_MODEL_BUDGET_LIMITS,
  ModelBudgetReassemblyRequiredError,
  ModelBudgetUnsatisfiableError,
  appliedModelBudget,
  assertResolvedBudget,
  createPromptEnvelope,
  observePromptEnvelope,
  promptEnvelopeText,
  resolveModelBudget,
} from "./model-call.js";
import { declaredProviderCapabilities, mergeCapabilityMatrices, resolveCatalogCapabilities, resolveModelThinkingCapability } from "./model-capabilities.js";

export { MODEL_CAPABILITY_CATALOG, OFFICIAL_MIMO_OPENAI_BASE_URL, createCapabilityMatrix, declaredProviderCapabilities, isOfficialMimoEndpoint, mergeCapabilityMatrices, resolveCatalogCapabilities, resolveModelThinkingCapability } from "./model-capabilities.js";
export type { ModelCapabilityIdentity, ModelThinkingCapability, ThinkingProtocol } from "./model-capabilities.js";
export { probeModelCapabilities } from "./model-capability-probe.js";
export type { CapabilityProbeFailureCode, CapabilityProbeResult, ProbeModelCapabilitiesOptions } from "./model-capability-probe.js";

export {
  DEFAULT_MODEL_BUDGET_LIMITS,
  ModelBudgetReassemblyRequiredError,
  ModelBudgetUnsatisfiableError,
  appliedModelBudget,
  assertResolvedBudget,
  createPromptEnvelope,
  estimatePromptEnvelopeTokens,
  estimatePromptTokens,
  observePromptEnvelope,
  promptEnvelopeText,
  resolveModelBudget,
} from "./model-call.js";

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
  /** 生成终止原因（stop/length/…）；length 表示被 max_tokens 截断，供有界续写判断。 */
  finishReason?: string;
  /** 思考内容（ADR-0035）：供 FakeProvider 等测试替身模拟推理输出，不计入正文。 */
  reasoning?: string;
}

/** 供应商返回非 2xx：status 供分类重试（429/5xx 可退避重试，其余 4xx 立即失败）。 */
export class ModelProviderHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ModelProviderHttpError";
  }
}

/** 流式空闲超时（idle-reset 计时到点仍无新事件）；区别于固定总超时，长文不再因总时长被掐断。 */
export class ModelProviderTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelProviderTimeoutError";
  }
}

/** 外部中止（ADR-0035 暂停/停止）：调用方经 signal 请求中止物理流，属致命类错误、不重试。 */
export class ModelProviderAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelProviderAbortedError";
  }
}

export interface ModelProviderRequest {
  /** Provider-independent role-preserving input. Production gateway calls always supply this. */
  envelope?: PromptEnvelope;
  requestedBudget?: RequestedModelBudget;
  resolvedBudget?: ResolvedModelBudget;
  appliedBudget?: AppliedModelBudget;
  /** @deprecated Low-level Adapter tests only; business orchestration must use envelope. */
  prompt: string;
  model: string;
  /** 要求 JSON 输出时传入；自由正文（生成自由化）缺省，传输层不再强制 JSON。 */
  responseFormat?: { type: "json_object" };
  thinking?: boolean;
  /** 采样温度；事后抽取等确定性场景传 0。缺省由供应商默认。 */
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** 外部中止信号（暂停/停止）：与传输层内部超时信号组合，中止后抛 ModelProviderAbortedError。 */
  signal?: AbortSignal;
  /** Grounded final-writer sources used only to map provider-native citation metadata. */
  citationSources?: readonly ResearchCitationSourceIdentity[];
}

/**
 * 注入弱标记指令的正文生成路径默认输出预算（ADR-0031）。
 * thinking 模型的推理与正文共用该预算：密度/示例/去重指令使推理占用显著增加，
 * 8_000 在 thinking 模式下会被推理耗尽、正文为空（#86 真实探针两次复现），故提高。
 */
export const RESEARCH_BODY_DEFAULT_MAX_TOKENS = 16_000;

/** 业务模型入口只接收策略层已经准入的候选；rejected 结果不能继续转换成供应商输入。 */
export type AssembledModelContext = Extract<ContextAssemblyResult, { status: "assembled" }>;

/**
 * 唯一的已装配上下文到模型文本转换边界。服务层不得再自行拼接候选正文；
 * rejected 候选与审计元数据不会进入供应商提示，来源标签仅用于防止材料冒充规则。
 */
export function formatAssembledModelContext(assembly: AssembledModelContext): string {
  return JSON.stringify({
    purpose: assembly.purpose,
    context: assembly.adopted.map(({ candidate }) => ({
      channel: candidate.channel,
      category: candidate.channel === "factual_evidence"
        ? candidate.evidenceKind
        : candidate.channel === "behavior_rule"
          ? candidate.ruleKind
          : candidate.adaptationKind,
      sourceKind: candidate.source.kind,
      content: candidate.content,
    })),
  });
}

export interface ModelProvider {
  readonly name: string;
  readonly defaultModel?: string;
  readonly pricing?: Record<string, ModelPricing>;
  complete(request: ModelProviderRequest): Promise<ModelProviderResponse>;
  /** 只对集中能力解析器明确识别的实际模型返回 true。 */
  supportsThinking?(model: string): boolean;
  /**
   * 真实模型逐字流式（方案 B）：能流式的 provider 在 complete() 之外另实现本方法。
   * 逐字增量以 {type:"delta"} 事件产出；供应商确认的引用元数据以 {type:"citation"}
   * 旁路产出；usage/model 只在终帧到达，由 {type:"done"} 事件带外承载，供网关恰好一次
   * 记账。缺省本方法的 provider 由网关退回非流式 complete() 单发。
   */
  completeStream?(request: ModelProviderRequest): AsyncIterable<ModelProviderStreamEvent>;
}

/** 流式增量事件：正文逐字片段。 */
export interface ModelProviderStreamDelta { type: "delta"; text: string }
/** 流式思考增量事件（ADR-0035）：模型的推理过程逐字片段，不计入正文，与 delta 交错到达。 */
export interface ModelProviderStreamReasoning { type: "reasoning"; text: string }
/** Structured citation metadata; offsets are relative to this physical body stream. */
export type ModelProviderStreamCitation = { type: "citation"; text?: never } & ResearchCitationCandidate;
/** 流式终帧事件：模型名与 usage（token/成本记账依据，仅在流结束时可用）。 */
export interface ModelProviderStreamDone { type: "done"; model: string; usage?: ProviderUsage; finishReason?: string }
export type ModelProviderStreamEvent = ModelProviderStreamDelta | ModelProviderStreamReasoning | ModelProviderStreamCitation | ModelProviderStreamDone;

/** plan-then-write 大纲的节数边界，防止模型产出过多碎节。 */
export const RESEARCH_BODY_OUTLINE_MIN_SECTIONS = 1;
export const RESEARCH_BODY_OUTLINE_MAX_SECTIONS = 12;

/** plan-then-write 大纲的一节。 */
export interface ResearchBodyOutlineSection {
  heading: string;
  summary: string;
  targetChars: number;
}

/** plan-then-write 第一阶段产出：有序大纲。 */
export interface ResearchBodyOutline {
  sections: ResearchBodyOutlineSection[];
}

/** 单个段落块的事后语义标注（标题/概念），由小模型抽取或大纲提供。 */
export interface ResearchSliceAnnotation {
  title: string;
  concepts: string[];
}

/** 解析大纲 JSON 为有序、有界的节序列；非法结构抛错由调用方降级或重试。 */
export function parseBodyOutline(raw: string): ResearchBodyOutline {
  const parsed = JSON.parse(raw) as { sections?: unknown };
  if (!Array.isArray(parsed.sections) || parsed.sections.length === 0) throw new Error("Body outline must contain a non-empty sections array");
  const sections = parsed.sections.slice(0, RESEARCH_BODY_OUTLINE_MAX_SECTIONS).map((item, index) => {
    const section = item as Partial<ResearchBodyOutlineSection>;
    const heading = typeof section?.heading === "string" ? section.heading.trim() : "";
    const summary = typeof section?.summary === "string" ? section.summary.trim() : "";
    const targetChars = typeof section?.targetChars === "number" && Number.isFinite(section.targetChars) ? Math.max(0, Math.trunc(section.targetChars)) : 0;
    if (!heading) throw new Error(`Body outline section ${index + 1} must have a non-empty heading`);
    return { heading, summary, targetChars };
  });
  return { sections };
}

/** 解析单段语义标注 JSON；title 可空、concepts 可为空数组，非法结构抛错由调用方降级。 */
export function parseSliceAnnotation(raw: string): ResearchSliceAnnotation {
  const parsed = JSON.parse(raw) as { title?: unknown; concepts?: unknown };
  const title = typeof parsed.title === "string" ? parsed.title.trim().slice(0, RESEARCH_NATIVE_SLICE_MAX_TITLE_CHARACTERS) : "";
  const concepts = (Array.isArray(parsed.concepts) ? parsed.concepts : [])
    .map((concept) => (typeof concept === "string" ? concept.trim() : ""))
    .filter(Boolean)
    .slice(0, RESEARCH_NATIVE_SLICE_MAX_CONCEPTS)
    .map((concept) => concept.slice(0, RESEARCH_NATIVE_SLICE_MAX_CONCEPT_CHARACTERS));
  return { title, concepts };
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
  /** #49：来源证据状态。full=抓取到全文；partial=仅搜索摘要；none=未取得内容。 */
  evidenceStatus?: GroundingEvidenceStatus;
}

export interface GroundingCitation {
  sourceOrdinal: number;
  startOffset: number;
  endOffset: number;
  providerCitationId?: string;
}

type GroundedResearchMetadata = {
  content: string;
  status: ResearchGroundingScopeStatus;
  queries: string[];
  sources: GroundingSource[];
  citations: GroundingCitation[];
  responseSummary?: Record<string, unknown>;
  errorMessage?: string;
};

/** 只有经供应商终态确认的变体拥有正文；证据变体在类型上不能携带草稿文本。 */
export type GroundedResearchResponse =
  | (GroundedResearchMetadata & { bodyKind: "confirmed_final"; content: string })
  | (Omit<GroundedResearchMetadata, "content"> & { bodyKind: "evidence" });

export interface GroundingModelProvider extends ModelProvider {
  generateGroundedResearch(request: ModelProviderRequest & { grounding: ResearchGroundingRequest }): Promise<GroundedResearchResponse>;
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
    /** 该祖先消息中已持久化的弱标记概念文本（去重、有界），用于抑制向上游已覆盖概念重复标记。 */
    coveredTerms?: string[];
  }>;
  truncated: boolean;
  cycleDetected: boolean;
}

export function formatResearchSliceContext(context?: ResearchSliceContext): string {
  if (!context?.items.length) return "";
  const lines = [
    "语义切片上下文（来自当前节点及其父链，仅作参考，不是新的用户问题）：",
    `切片预算：${context.estimatedTokens}/${context.tokenBudget} tokens`,
  ];
  for (const item of context.items) {
    lines.push(JSON.stringify({
      fragmentId: item.fragmentId,
      bodyVersionId: item.bodyVersionId,
      ...(item.sliceId ? { sliceId: item.sliceId } : {}),
      nodeId: item.nodeId,
      messageId: item.messageId,
      ordinal: item.ordinal,
      parentDistance: item.parentDistance,
      title: item.title,
      content: item.content,
      normalizedConcepts: item.normalizedConcepts,
      isProvisional: item.isProvisional,
      sourceRefs: item.sourceRefs.map((source) => ({
        sourceId: source.sourceId,
        blockOrdinal: source.blockOrdinal,
      })),
    }));
  }
  if (context.originSelectionId) {
    lines.push(`来源选区身份：${JSON.stringify(context.originSelectionId)}`);
  }
  if (context.fusionSignals.length) {
    lines.push(`融合关系信号：${JSON.stringify(context.fusionSignals)}`);
  }
  return lines.join("\n");
}

/** 将父链结果渲染为研究提示词片段；空链不产生任何占位文本。 */
export function formatResearchParentChainContext(
  context?: ResearchParentChainContext,
): string {
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
    if (ancestor.coveredTerms?.length) lines.push(`  已标记概念：${ancestor.coveredTerms.join("、")}`);
  }
  lines.push("去重规则：以上祖先的主题与已标记概念在研究路径上游已经充分展开；正文可以自然提及它们，但不要重复展开解释。");
  if (context.truncated) lines.push("- 说明：父链已达到既有层数或总字符预算，只能使用以上内容，不要补全未提供的祖先信息。");
  if (context.cycleDetected) lines.push("- 说明：父链存在异常环路，已安全截断；不要根据缺失关系进行推断。");
  const convergence = resolveResearchConvergence({ nodeDepth: context.currentNodeDepth });
  if (convergence.termDensity === "reduced") {
    lines.push("回答引导：聚焦当前问题，优先复用以上已建立的知识，减少重复解释和无关新概念；只解释当前回答确实需要的新术语，保持来源事实与不确定性。");
  } else if (convergence.termDensity === "stopped") {
    lines.push("回答引导：严格收敛到当前问题，只使用以上已建立的知识回答；不要主动引入新的术语、分支或延伸主题，保持来源事实与不确定性。");
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
  capabilities: { structuredJson: true, reasoningOutput: "openai_reasoning_content", thinkingMode: "openai_compatible", modelDiscovery: true, webGrounding: "unsupported" },
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
  capabilities: { structuredJson: true, reasoningOutput: "none", thinkingMode: "none", modelDiscovery: true, webGrounding: "openai_web_search" },
}, {
  id: "gemini",
  label: "Google Gemini",
  apiMode: "gemini_generate_content",
  authMode: "api_key_header",
  defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
  defaultModel: "gemini-2.5-flash",
  models: ["gemini-2.5-flash", "gemini-2.5-pro"],
  capabilities: { structuredJson: false, reasoningOutput: "none", thinkingMode: "none", modelDiscovery: true, webGrounding: "gemini_google_search" },
}, {
  id: "anthropic",
  label: "Anthropic",
  apiMode: "anthropic_messages",
  authMode: "api_key_header",
  defaultBaseUrl: "https://api.anthropic.com/v1",
  defaultModel: "claude-sonnet-5",
  models: ["claude-sonnet-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  capabilities: { structuredJson: false, reasoningOutput: "none", thinkingMode: "none", modelDiscovery: true, webGrounding: "anthropic_web_search" },
}, {
  id: "openrouter",
  label: "OpenRouter",
  apiMode: "openai_chat_completions",
  authMode: "bearer",
  defaultBaseUrl: "https://openrouter.ai/api/v1",
  defaultModel: "openai/gpt-4.1-mini",
  models: ["openai/gpt-4.1-mini", "anthropic/claude-sonnet-4", "google/gemini-2.5-flash"],
  capabilities: { structuredJson: true, reasoningOutput: "none", thinkingMode: "none", modelDiscovery: true, webGrounding: "unsupported" },
}, {
  id: "dashscope",
  label: "Alibaba Cloud Model Studio",
  apiMode: "openai_chat_completions",
  authMode: "bearer",
  defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  defaultModel: "qwen-plus",
  models: ["qwen-plus", "qwen-max", "qwen-turbo"],
  capabilities: { structuredJson: true, reasoningOutput: "none", thinkingMode: "none", modelDiscovery: true, webGrounding: "unsupported" },
}, {
  id: "moonshot",
  label: "Kimi (Moonshot AI)",
  apiMode: "openai_chat_completions",
  authMode: "bearer",
  defaultBaseUrl: "https://api.moonshot.cn/v1",
  defaultModel: "kimi-k2.5",
  models: ["kimi-k2.5", "kimi-k2-0711-preview", "moonshot-v1-32k"],
  capabilities: { structuredJson: true, reasoningOutput: "none", thinkingMode: "none", modelDiscovery: true, webGrounding: "unsupported" },
}, {
  id: "zhipu",
  label: "Zhipu GLM",
  apiMode: "openai_chat_completions",
  authMode: "bearer",
  defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
  defaultModel: "glm-4.6",
  models: ["glm-4.6", "glm-4.5", "glm-4.5-flash"],
  capabilities: { structuredJson: true, reasoningOutput: "none", thinkingMode: "none", modelDiscovery: true, webGrounding: "unsupported" },
}, {
  id: "siliconflow",
  label: "SiliconFlow",
  apiMode: "openai_chat_completions",
  authMode: "bearer",
  defaultBaseUrl: "https://api.siliconflow.cn/v1",
  defaultModel: "deepseek-ai/DeepSeek-V3.2",
  models: ["deepseek-ai/DeepSeek-V3.2", "Qwen/Qwen3-235B-A22B", "Pro/deepseek-ai/DeepSeek-V3.2"],
  capabilities: { structuredJson: true, reasoningOutput: "none", thinkingMode: "none", modelDiscovery: true, webGrounding: "unsupported" },
}, {
  id: "custom",
  label: "Custom OpenAI-Compatible",
  apiMode: "openai_chat_completions",
  authMode: "bearer",
  defaultBaseUrl: "https://example.invalid/v1",
  defaultModel: "custom-model",
  models: [],
  capabilities: { structuredJson: true, reasoningOutput: "none", thinkingMode: "none", modelDiscovery: true, webGrounding: "unsupported" },
}, {
  id: "custom-anthropic",
  label: "Custom Anthropic-Compatible",
  apiMode: "anthropic_messages",
  authMode: "api_key_header",
  defaultBaseUrl: "https://example.invalid/v1",
  defaultModel: "custom-model",
  models: [],
  capabilities: { structuredJson: false, reasoningOutput: "none", thinkingMode: "none", modelDiscovery: true, webGrounding: "unsupported" },
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

  async resolve(profile: ProviderProfile, capabilities?: ModelCapabilityMatrix): Promise<ResolvedProviderRuntime> {
    if (!profile.enabled) throw new Error("Provider profile is disabled");
    const definition = this.registry.get(profile.providerId);
    const apiKey = await this.credential(profile.id);
    if (!apiKey) throw new Error(`Credential is unavailable for provider profile: ${profile.id}`);
    const gateway = new ModelGateway(createProvider(definition, {
      apiKey: () => apiKey,
      baseUrl: profile.baseUrl,
      ...(capabilities ? { thinkingSupported: () => capabilities.thinking.usable } : {}),
    }), {
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

export interface ModelCallContext {
  workflowRunId?: string;
  workflowStepId?: string;
  answerPlanId?: string;
  purpose?: string;
  promptVersion?: string;
  retryCount?: number;
  /** Only persist selected local slice IDs; prompt bodies stay out of local run records. */
  sourceSliceIds?: string[];
  /** #39：参与调用的语义片段 ID（与 sourceSliceIds 同为本地引用，不含正文内容）。 */
  sourceFragmentIds?: string[];
  /** Fixed output-token budget for explaining the call boundary in run records. */
  tokenBudget?: number;
  contextAssembly?: ContextAssemblyObservation;
  previousBudgetResolutionAttemptId?: string;
  buildFingerprint?: string;
}
export interface ModelCallEvent {
  context: ModelCallContext;
  provider: string;
  model: string;
  promptVersion: string;
  envelope: PromptEnvelopeObservation;
  availability: { status: "available" | "unavailable"; reason?: string };
  requestedBudget: RequestedModelBudget;
  resolvedBudget: ResolvedModelBudget;
  appliedBudget: AppliedModelBudget;
  status: "completed" | "failed";
  usage?: ProviderUsage;
  estimatedCostUsd?: number;
  latencyMs: number;
  retryCount: number;
  finishReason?: string;
  completionDiagnostic?: "length" | "empty_body" | "task_mismatch_truncation";
  toolCallCount: number;
  errorCategory?: "authentication" | "network" | "validation" | "provider" | "budget" | "unknown";
  buildFingerprint: string;
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
  queries: string[];
  sources: GroundingSource[];
  /** 仅供 API 最终写作阶段使用的、按来源编号关联的原始证据；消费方负责限额与脱敏。 */
  evidence: Array<{ sourceOrdinal: number; content: string }>;
}

/** Agent 搜索循环的默认系统提示。 */
const AGENT_SEARCH_SYSTEM_PROMPT = `你是 Collector 的研究助手。你可以使用以下工具完成联网研究任务。

工作流程：
1. 根据用户问题，先调用 web_search 进行搜索
2. 分析搜索结果，选择最相关的页面调用 web_fetch 抓取详细内容
3. 如果信息不够充足，可以换关键词重新搜索
4. 信息收集充分后停止；最终面向用户的正文由独立写作阶段生成

约束：
- 你只负责调用工具收集可追溯证据，不能把任何自然语言回答、草稿、总结或控制协议作为最终正文输出
- 必须经过搜索取证，不能凭记忆编造
- 中文优先，使用中文关键词搜索；英文术语保留原样
- 最多进行 5 轮搜索（web_search 调用次数），达到后停止工具循环`;

/** Agent 是匿名取证工作区，提示词不含任何正文或弱标记协议。 */
export function formatAgentSearchSystemPrompt(_nodeDepth = 0): string {
  return AGENT_SEARCH_SYSTEM_PROMPT;
}

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
  constructor(private readonly provider: ModelProvider, private readonly options: { model?: string; promptVersion?: string; thinking?: boolean; pricing?: Record<string, ModelPricing>; budgetLimits?: ModelBudgetLimits; buildFingerprint?: string; onCall?: (event: ModelCallEvent) => void | Promise<void> } = {}) { this.callListener = options.onCall; }

  get providerName(): string { return this.provider.name; }
  get modelName(): string { return this.options.model ?? this.provider.defaultModel ?? "default"; }
  get thinkingSupported(): boolean { return this.provider.supportsThinking?.(this.modelName) === true; }
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

  /** 成功记账：usage/成本/延迟，流式与非流式共用同一口径，恰好一次。 */
  private async emitCompleted(context: ModelCallContext, request: ModelProviderRequest, startedAt: number, createdAt: string, response: ModelProviderResponse, toolCallCount = 0): Promise<void> {
    if (!request.envelope || !request.requestedBudget || !request.resolvedBudget || !request.appliedBudget) throw new Error("Prepared model request metadata is missing");
    await this.emitCall({
      context, provider: this.providerName, model: response.model ?? request.model, promptVersion: context.promptVersion ?? this.promptVersion, status: "completed",
      envelope: observePromptEnvelope(request.envelope), availability: { status: "available" }, requestedBudget: request.requestedBudget,
      resolvedBudget: request.resolvedBudget, appliedBudget: request.appliedBudget,
      usage: response.usage, estimatedCostUsd: estimateCost(response.model ?? request.model, response.usage, this.options.pricing ?? this.provider.pricing),
      latencyMs: Date.now() - startedAt, retryCount: context.retryCount ?? 0, finishReason: response.finishReason, toolCallCount,
      ...((response.finishReason === "length" || !response.content.trim())
        ? { completionDiagnostic: response.finishReason === "length" ? "length" as const : "empty_body" as const }
        : {}),
      buildFingerprint: context.buildFingerprint ?? this.options.buildFingerprint ?? "development", createdAt, completedAt: new Date().toISOString(),
    });
  }

  /** 失败记账：脱敏错误信息，流式与非流式共用同一口径。 */
  private async emitFailed(context: ModelCallContext, request: ModelProviderRequest, startedAt: number, createdAt: string, error: unknown): Promise<void> {
    if (!request.envelope || !request.requestedBudget || !request.resolvedBudget || !request.appliedBudget) throw new Error("Prepared model request metadata is missing");
    await this.emitCall({
      context, provider: this.providerName, model: request.model, promptVersion: context.promptVersion ?? this.promptVersion, status: "failed",
      envelope: observePromptEnvelope(request.envelope), availability: { status: "available" }, requestedBudget: request.requestedBudget,
      resolvedBudget: request.resolvedBudget, appliedBudget: request.appliedBudget,
      latencyMs: Date.now() - startedAt, retryCount: context.retryCount ?? 0, errorMessage: redactError(error), createdAt, completedAt: new Date().toISOString(),
      toolCallCount: 0, errorCategory: modelCallErrorCategory(error), buildFingerprint: context.buildFingerprint ?? this.options.buildFingerprint ?? "development",
    });
  }

  private prepareRequest(request: ModelProviderRequest, context: ModelCallContext): ModelProviderRequest {
    const promptVersion = context.promptVersion ?? this.promptVersion;
    const maxOutputTokens = request.requestedBudget?.maxOutputTokens ?? request.maxTokens ?? RESEARCH_BODY_DEFAULT_MAX_TOKENS;
    const minimumBodyTokens = request.requestedBudget?.minimumBodyTokens
      ?? Math.min(maxOutputTokens, context.purpose === "research_body" || context.purpose === "research_body_section" ? 1_024 : 1);
    const envelope = request.envelope ?? createPromptEnvelope({
      purpose: context.purpose ?? "unknown",
      promptVersion,
      user: request.prompt,
      outputContract: {
        format: request.responseFormat?.type === "json_object" ? "json_object" : "text",
        contractVersion: `${promptVersion}:output`,
        minimumBodyTokens,
      },
    });
    const requestedBudget: RequestedModelBudget = request.requestedBudget ?? {
      maxInputTokens: context.contextAssembly?.budget?.maxInputTokens ?? DEFAULT_MODEL_BUDGET_LIMITS.contextWindowTokens,
      maxOutputTokens,
      minimumBodyTokens: envelope.outputContract.minimumBodyTokens,
      thinking: (request.thinking ?? this.options.thinking ?? false) && this.provider.supportsThinking?.(request.model) === true,
    };
    const resolvedBudget = request.resolvedBudget ?? assertResolvedBudget(resolveModelBudget({
      envelope,
      requested: requestedBudget,
      limits: this.options.budgetLimits ?? DEFAULT_MODEL_BUDGET_LIMITS,
      ...(context.previousBudgetResolutionAttemptId ? { previousBudgetResolutionAttemptId: context.previousBudgetResolutionAttemptId } : {}),
    }));
    const appliedBudget = request.appliedBudget ?? appliedModelBudget(resolvedBudget);
    return {
      ...request,
      envelope,
      requestedBudget,
      resolvedBudget,
      appliedBudget,
      prompt: promptEnvelopeText(envelope),
      responseFormat: envelope.outputContract.format === "json_object" ? { type: "json_object" } : undefined,
      thinking: appliedBudget.thinking,
      maxTokens: appliedBudget.maxOutputTokens,
    };
  }

  private async complete(request: ModelProviderRequest, context: ModelCallContext): Promise<ModelProviderResponse> {
    const prepared = this.prepareRequest(request, context);
    const createdAt = new Date().toISOString();
    const startedAt = Date.now();
    try {
      const response = await this.provider.complete(prepared);
      await this.emitCompleted(context, prepared, startedAt, createdAt, response);
      return response;
    } catch (error) {
      await this.emitFailed(context, prepared, startedAt, createdAt, error);
      throw error;
    }
  }

  get promptVersion(): string { return this.options.promptVersion ?? "knowledge-extraction-v1"; }

  private contextOptions<T extends { maxTokens?: number; context?: ModelCallContext }>(assembly: AssembledModelContext, options: T): T {
    const maxTokens = options.maxTokens;
    return {
      ...options,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      context: {
        ...(options.context ?? {}),
        purpose: options.context?.purpose ?? assembly.purpose,
        ...(maxTokens !== undefined ? { tokenBudget: maxTokens } : {}),
        contextAssembly: observeContextAssembly(assembly),
      },
    };
  }

  private contextPayload<T>(assembly: AssembledModelContext): T {
    const payload = assembly.adopted.map((item) => item.candidate.content).join("\n").trim();
    if (!payload) throw new Error(`Assembled context for ${assembly.purpose} contains no admitted material`);
    try { return JSON.parse(payload) as T; }
    catch { throw new Error(`Assembled context for ${assembly.purpose} does not contain a structured payload`); }
  }

  /** Context-native business entries: all user/business material has already passed ContextAssembly. */
  async generateGroundedResearchFromContext(
    assembly: AssembledModelContext,
    grounding: ResearchGroundingRequest,
    options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext; nodeDepth?: number } = {},
  ): Promise<GroundedResearchResponse> {
    return this.generateGroundedResearch(formatAssembledModelContext(assembly), grounding, this.contextOptions(assembly, options));
  }

  async answerResearchConversationFromContext(
    assembly: AssembledModelContext,
    options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext; nodeDepth?: number } = {},
  ): Promise<string> {
    return this.answerResearchConversation(
      [{ role: "user", content: formatAssembledModelContext(assembly) }],
      { ...this.contextOptions(assembly, options), parentChainContext: { currentNodeDepth: options.nodeDepth ?? 0, ancestors: [], truncated: false, cycleDetected: false } },
    );
  }

  async planAnswerFromContext(
    assembly: AssembledModelContext,
    options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {},
  ): Promise<string> {
    return this.planAnswer(formatAssembledModelContext(assembly), this.contextOptions(assembly, options));
  }

  async writeResearchBodyFromContext(
    assembly: AssembledModelContext,
    options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext; nodeDepth?: number } = {},
  ): Promise<string> {
    return this.writeResearchBody(
      [{ role: "user", content: formatAssembledModelContext(assembly) }],
      { ...this.contextOptions(assembly, options), parentChainContext: { currentNodeDepth: options.nodeDepth ?? 0, ancestors: [], truncated: false, cycleDetected: false } },
    );
  }

  async *writeResearchBodyStreamFromContext(
    assembly: AssembledModelContext,
    options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext; nodeDepth?: number; resumeFrom?: string; onDone?: (done: { finishReason?: string }) => void; onCitation?: (candidate: ResearchCitationCandidate) => void; citationSources?: readonly ResearchCitationSourceIdentity[]; signal?: AbortSignal } = {},
  ): AsyncIterable<string> {
    const admittedResume = options.resumeFrom ? "[续写正文见已准入 continuation_state]" : undefined;
    yield* this.writeResearchBodyStream(
      [{ role: "user", content: formatAssembledModelContext(assembly) }],
      {
        ...this.contextOptions(assembly, options),
        ...(admittedResume ? { resumeFrom: admittedResume } : {}),
        ...(options.resumeFrom ? { citationOffsetBase: options.resumeFrom.length } : {}),
        parentChainContext: { currentNodeDepth: options.nodeDepth ?? 0, ancestors: [], truncated: false, cycleDetected: false },
      },
    );
  }

  async generateBodyOutlineFromContext(
    assembly: AssembledModelContext,
    options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {},
  ): Promise<ResearchBodyOutline> {
    return this.generateBodyOutline([{ role: "user", content: formatAssembledModelContext(assembly) }], this.contextOptions(assembly, options));
  }

  async expandBodySectionFromContext(
    assembly: AssembledModelContext,
    input: Parameters<ModelGateway["expandBodySection"]>[0],
    options: Parameters<ModelGateway["expandBodySection"]>[1] = {},
  ): Promise<{ content: string; finishReason?: string }> {
    return this.expandBodySection({
      ...input,
      goal: formatAssembledModelContext(assembly),
      writtenSoFar: "",
      ...(input.continuation ? { continuation: { priorSectionContent: "" } } : {}),
      ...(input.repairHint ? { repairHint: "按已准入的修复状态重试" } : {}),
    }, this.contextOptions(assembly, options));
  }

  async generateDeepResearchRoundFromContext(
    assembly: AssembledModelContext,
    options: { mode: "branch" | "session"; nodeDepth?: number; model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext },
  ): Promise<string> {
    return this.generateDeepResearchRound({
      mode: options.mode,
      selectionText: formatAssembledModelContext(assembly),
      direction: "围绕已准入的当前问题和材料展开研究。",
      parentChainContext: { currentNodeDepth: options.nodeDepth ?? 0, ancestors: [], truncated: false, cycleDetected: false },
    }, this.contextOptions(assembly, options));
  }

  async runAgentSearchLoopFromContext(
    assembly: AssembledModelContext,
    tools: AgentSearchToolContext,
    options: { maxTurns?: number; maxTokens?: number; systemPrompt?: string; context?: ModelCallContext; nodeDepth?: number } = {},
  ): Promise<AgentSearchResult> {
    return this.runAgentSearchLoop(formatAssembledModelContext(assembly), tools, this.contextOptions(assembly, options));
  }

  async deriveSliceAnnotationsFromContext(assembly: AssembledModelContext, options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {}): Promise<ResearchSliceAnnotation> {
    return this.deriveSliceAnnotations(this.contextPayload(assembly), this.contextOptions(assembly, options));
  }

  async extractTermMarkersFromContext(assembly: AssembledModelContext, options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {}): Promise<string> {
    return this.extractTermMarkers(this.contextPayload(assembly), this.contextOptions(assembly, options));
  }

  async produceCitationAttributionsFromContext(assembly: AssembledModelContext, options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {}): Promise<string> {
    return this.produceCitationAttributions(this.contextPayload(assembly), this.contextOptions(assembly, options));
  }

  async verifyTermIdentityFromContext(assembly: AssembledModelContext, options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {}): Promise<boolean> {
    return this.verifyTermIdentity(this.contextPayload(assembly), this.contextOptions(assembly, options));
  }

  async generateSessionTitleFromContext(assembly: AssembledModelContext, options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {}): Promise<string> {
    return this.generateSessionTitle(this.contextPayload(assembly), this.contextOptions(assembly, options));
  }

  async generateNodeDisplayNameFromContext(assembly: AssembledModelContext, options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {}): Promise<string> {
    return this.generateNodeDisplayName(this.contextPayload(assembly), this.contextOptions(assembly, options));
  }

  async parseImportChaptersFromContext(assembly: AssembledModelContext, options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {}): Promise<string> {
    return this.parseImportChapters(this.contextPayload(assembly), this.contextOptions(assembly, options));
  }

  async evaluateAssociationHintFromContext(assembly: AssembledModelContext, options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {}): ReturnType<ModelGateway["evaluateAssociationHint"]> {
    return this.evaluateAssociationHint(this.contextPayload(assembly), this.contextOptions(assembly, options));
  }

  async verifyResearchSimilarityFromContext(assembly: AssembledModelContext, options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {}): ReturnType<ModelGateway["verifyResearchSimilarity"]> {
    return this.verifyResearchSimilarity(this.contextPayload(assembly), this.contextOptions(assembly, options));
  }

  async verifyTemporaryFusionDraftEvidenceFromContext(assembly: AssembledModelContext, options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {}): ReturnType<ModelGateway["verifyTemporaryFusionDraftEvidence"]> {
    return this.verifyTemporaryFusionDraftEvidence(this.contextPayload(assembly), this.contextOptions(assembly, options));
  }

  async discoverTemporaryFusionFromContext(assembly: AssembledModelContext, options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {}): ReturnType<ModelGateway["discoverTemporaryFusion"]> {
    return this.discoverTemporaryFusion(this.contextPayload(assembly), this.contextOptions(assembly, options));
  }

  async reformulateSearchQueryFromContext(assembly: AssembledModelContext, options: { model?: string; timeoutMs?: number; context?: ModelCallContext } = {}): Promise<string> {
    const input = this.contextPayload<{ query: string }>(assembly);
    return this.reformulateSearchQuery(input.query, this.contextOptions(assembly, options));
  }

  async clusterMaterialsFromContext(assembly: AssembledModelContext, options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {}): ReturnType<ModelGateway["clusterMaterials"]> {
    const input = this.contextPayload<{ materials: Array<{ id: string; content: string }> }>(assembly);
    return this.clusterMaterials(input.materials, this.contextOptions(assembly, options));
  }

  async generateDocumentOutlineFromContext(assembly: AssembledModelContext, options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {}): ReturnType<ModelGateway["generateDocumentOutline"]> {
    const input = this.contextPayload<{ materials: Array<{ id: string; content: string }>; topicTitle: string }>(assembly);
    return this.generateDocumentOutline(input.materials, input.topicTitle, this.contextOptions(assembly, options));
  }

  async generateDocumentSectionsFromContext(assembly: AssembledModelContext, options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {}): ReturnType<ModelGateway["generateDocumentSections"]> {
    const input = this.contextPayload<{ outline: { title: string; sections: Array<{ heading: string; keyPoints: string[] }> }; materials: Array<{ id: string; content: string; fragmentIds: string[] }> }>(assembly);
    return this.generateDocumentSections(input.outline, input.materials, this.contextOptions(assembly, options));
  }

  async generateDocumentUpdateAdditionsFromContext(assembly: AssembledModelContext, options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {}): ReturnType<ModelGateway["generateDocumentUpdateAdditions"]> {
    const input = this.contextPayload<{ materials: Array<{ id: string; content: string; fragmentIds: string[] }> }>(assembly);
    return this.generateDocumentUpdateAdditions(input.materials, this.contextOptions(assembly, options));
  }

  async testConnectionFromContext(assembly: AssembledModelContext, options: { model?: string; timeoutMs?: number; context?: ModelCallContext } = {}): ReturnType<ModelGateway["testConnection"]> {
    return this.testConnection(this.contextOptions(assembly, options));
  }

  /**
   * @internal
   * The typed methods below are prompt implementations retained for provider/unit compatibility.
   * API business orchestration must use the corresponding *FromContext entry; a source-boundary
   * test rejects direct legacy calls from the orchestration layer.
   */
  /** 供应商原生联网：只生成干净正文；引用与弱标记都通过独立旁路产生。 */
  async generateGroundedResearch(
    prompt: string,
    grounding: ResearchGroundingRequest,
    options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext; nodeDepth?: number } = {},
  ): Promise<GroundedResearchResponse> {
    const provider = this.provider as Partial<GroundingModelProvider>;
    if (typeof provider.generateGroundedResearch !== "function") {
      throw new Error("Configured provider does not support native web grounding");
    }
    const request: ModelProviderRequest = {
      envelope: createPromptEnvelope({
        purpose: options.context?.purpose ?? "research_grounding",
        promptVersion: options.context?.promptVersion ?? grounding.promptVersion,
        system: "Use the configured grounding capability. Return only a clean final body through the provider's confirmed final channel; citation metadata stays separate. 只输出干净正文，不要输出任何内部控制协议；引用与弱标记由独立旁路产生。",
        user: prompt,
        outputContract: { format: "text", contractVersion: "grounded-research-body-v1", minimumBodyTokens: 1_024 },
      }),
      prompt: `${prompt}\n\n只输出干净正文，不要输出任何内部控制协议；引用与弱标记由独立旁路产生。`,
      model: options.model ?? this.modelName,
      maxTokens: options.maxTokens ?? RESEARCH_BODY_DEFAULT_MAX_TOKENS,
      timeoutMs: options.timeoutMs ?? 120_000,
    };
    const context = options.context ?? { purpose: "research_grounding", promptVersion: grounding.promptVersion };
    const prepared = this.prepareRequest(request, context);
    const createdAt = new Date().toISOString();
    const startedAt = Date.now();
    try {
      const result = await provider.generateGroundedResearch({ ...prepared, grounding });
      // Evidence-only grounding is a valid non-empty physical result even though it is not yet user-visible body.
      await this.emitCompleted(context, prepared, startedAt, createdAt, {
        content: result.bodyKind === "confirmed_final" ? result.content : "grounding-evidence",
        model: prepared.model,
      });
      return result;
    } catch (error) {
      await this.emitFailed(context, prepared, startedAt, createdAt, error);
      throw error;
    }
  }

  async answerResearchConversation(
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext; parentChainContext?: ResearchParentChainContext; sliceContext?: ResearchSliceContext } = {},
  ): Promise<string> {
    if (!messages.length) throw new Error("Research conversation requires at least one message");
    const parentContext = formatResearchParentChainContext(options.parentChainContext);
    const sliceContext = formatResearchSliceContext(options.sliceContext);
    const system = "You are Collector's final writer. Answer the latest user request using only admitted context. Follow explicit user format and intent rules before any derived answer plan, and choose a natural structure for the actual task instead of forcing one universal style. Output clean Markdown only — no JSON wrapper, source numbering, internal control protocol, or claims that semantic checks passed. Preserve uncertainty and never invent sources.";
    const user = `Conversation:\n${JSON.stringify(messages)}${parentContext ? `\n\n${parentContext}` : ""}${sliceContext ? `\n\n${sliceContext}` : ""}`;
    const prompt = `${system}\n\n${user}`;
    const response = await this.complete({
      envelope: createPromptEnvelope({ purpose: options.context?.purpose ?? "research_chat", promptVersion: options.context?.promptVersion ?? this.promptVersion, system, user, outputContract: { format: "text", contractVersion: "research-conversation-text-v1", minimumBodyTokens: 512 } }),
      prompt,
      model: options.model ?? this.modelName,
      thinking: options.thinking ?? false,
      maxTokens: options.maxTokens ?? RESEARCH_BODY_DEFAULT_MAX_TOKENS,
      timeoutMs: options.timeoutMs ?? 120_000,
    }, options.context ?? { purpose: "research_chat" });
    const content = response.content.trim();
    if (!content) throw new Error("Research provider returned an empty answer");
    return content;
  }

  /**
   * Structured Answer Planning implementation. The API orchestration layer must enter through
   * planAnswerFromContext so only ContextAssembly-admitted production inputs reach this prompt.
   * Schema validation, authority preservation and fallback remain owned by AnswerPlanningModule.
   */
  async planAnswer(
    admittedContext: string,
    options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {},
  ): Promise<string> {
    const system = `You plan Collector answers across domains. Return one bounded JSON object and no prose.

The current user request and explicit user rules have higher authority than your proposal. Do not decide facts, infer identity, grant authorization, override safety, resolve ambiguous references to one meaning, or emit domain-specific template fields. External fact conflicts remain for the evidence chain.

Allowed shape:
{"taskFamily":"explanation|comparison|decision|planning|diagnosis|factual_query|research_synthesis|summarization|rewriting|mixed|direct_response","requiredOperations":["answer_directly|explain|compare|recommend|plan_steps|diagnose|propose_actions|verify_facts|synthesize|summarize|rewrite|state_assumptions|request_clarification"],"assumptions":[{"statement":"...","risk":"low|material"}],"semanticCriteria":["..."]}

Use only cross-domain operations. Semantic criteria are writing guidance, never claims that checks passed. Keep every array short.`;
    const user = `Production context admitted for answer planning:\n${admittedContext}`;
    const response = await this.complete({
      envelope: createPromptEnvelope({
        purpose: options.context?.purpose ?? "answer_planning",
        promptVersion: options.context?.promptVersion ?? this.promptVersion,
        system,
        user,
        outputContract: { format: "json_object", contractVersion: "answer-plan-proposal-v1", minimumBodyTokens: 1 },
      }),
      prompt: `${system}\n\n${user}`,
      model: options.model ?? this.modelName,
      responseFormat: { type: "json_object" },
      thinking: options.thinking ?? false,
      maxTokens: options.maxTokens ?? 1_500,
      timeoutMs: options.timeoutMs ?? 60_000,
      temperature: 0,
    }, options.context ?? { purpose: "answer_planning" });
    return response.content.trim();
  }

  /** Final writing stays free-form Markdown; task structure comes from admitted user rules and Answer Plan. */
  async writeResearchBody(
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext; parentChainContext?: ResearchParentChainContext; sliceContext?: ResearchSliceContext } = {},
  ): Promise<string> {
    if (!messages.length) throw new Error("Research body requires at least one message");
    const promptVersion = options.context?.promptVersion ?? this.promptVersion;
    const prompt = this.researchBodyPrompt(messages, options.parentChainContext, options.sliceContext, promptVersion);
    const response = await this.complete({
      envelope: this.researchBodyEnvelope(messages, options.parentChainContext, options.sliceContext, options.context),
      prompt,
      model: options.model ?? this.modelName,
      thinking: options.thinking ?? false,
      maxTokens: options.maxTokens ?? RESEARCH_BODY_DEFAULT_MAX_TOKENS,
      timeoutMs: options.timeoutMs ?? 120_000,
    }, options.context ?? { purpose: "research_body" });
    const content = response.content.trim();
    if (!content) throw new Error("Research body provider returned an empty body");
    return content;
  }

  /** 自由正文提示词：单轮 writeResearchBody 与流式 writeResearchBodyStream 共用同一来源。 */
  private researchBodyPrompt(
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    parentChainContext?: ResearchParentChainContext,
    sliceContext?: ResearchSliceContext,
    promptVersion = this.promptVersion,
  ): string {
    const parentContext = formatResearchParentChainContext(parentChainContext);
    const sliceContextText = formatResearchSliceContext(sliceContext);
    const explicitSettingsRule = promptVersion === "answer-quality-release-baseline-v1"
      ? ""
      : "\n- 已准入上下文中的显式回答设置必须落实到正文：format=numbered_steps 时每个主要步骤使用阿拉伯数字编号（1.、2.、3.）；format=bullet_list 时使用 Markdown 项目符号；format=table 时使用 Markdown 表格；format=continuous_prose 时不使用标题、列表或表格。不要把这些内部格式代码输出给用户。";
    return `你是 Collector 的最终写作阶段。请只根据已准入上下文回答当前用户请求，输出可直接给用户阅读的干净 Markdown 正文。

要求：
- 当前用户本轮的明确目标、格式和限制始终高于派生 Answer Plan；若二者冲突，遵循用户本轮要求。${explicitSettingsRule}
- 根据实际任务自然组织：解释重在机制，比较使用一致维度，规划给出可执行顺序，诊断区分现象、原因与证据，总结和改写忠于原意。标题、列表、表格、连续正文与长度都服从当前任务和用户明确要求，不套固定模板。
- Answer Plan 的 requiredOperations 和 semanticCriteria 只是写作候选，不是事实、授权或完成证据；不要在正文中复述计划，也不要自报“检查已通过”或完成比例。
- 若计划要求澄清，只询问会实质改变结果、授权或高风险事实的必要信息；低风险假设必须公开说明，不把 ambiguous/unresolved 引用强行解释成唯一含义。
- 保持来源事实与不确定性，不编造来源、链接或引用。
- 不要使用 Markdown 代码围栏包裹整篇回答，不要返回 JSON 或任何字段结构，只输出正文本身。
- 只输出干净正文，不要输出任何内部控制协议；弱标记由独立抽取任务产生。

对话：
${JSON.stringify(messages)}${parentContext ? `\n\n${parentContext}` : ""}${sliceContextText ? `\n\n${sliceContextText}` : ""}`;
  }

  private researchBodyEnvelope(
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    parentChainContext?: ResearchParentChainContext,
    sliceContext?: ResearchSliceContext,
    context?: ModelCallContext,
  ): PromptEnvelope {
    const prompt = this.researchBodyPrompt(messages, parentChainContext, sliceContext, context?.promptVersion ?? this.promptVersion);
    const separator = "\n\n对话：\n";
    const splitAt = prompt.indexOf(separator);
    const system = splitAt >= 0 ? prompt.slice(0, splitAt) : "Write the final Collector answer under the declared output contract.";
    const user = splitAt >= 0 ? prompt.slice(splitAt + separator.length) : prompt;
    return createPromptEnvelope({
      purpose: context?.purpose ?? "research_body",
      promptVersion: context?.promptVersion ?? this.promptVersion,
      system,
      user,
      outputContract: { format: "text", contractVersion: "research-body-markdown-v1", minimumBodyTokens: 1_024 },
    });
  }

  /**
   * 真实逐字流式正文（方案 B）：模型边生成边产出正文增量，对调用方只 yield 文本增量。
   * 与 writeResearchBody 同一提示词、同一记账口径；usage/model 在终帧由 done 事件捕获，
   * 循环结束后 emitCall 恰好一次。经 trimStream 过滤保证 concat(yielded) === 完整正文.trim()，
   * 与 finalizeDerivedSlices 从 trimmed 文本派生块的偏移严格一致。
   * provider 未实现 completeStream 时退回非流式 complete()，把 trimmed 正文作为单个增量产出。
   * 供应商 reasoning 事件在此边界丢弃：不返回、不持久化，也不进入正文或记账。
   */
  async *writeResearchBodyStream(
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext; parentChainContext?: ResearchParentChainContext; sliceContext?: ResearchSliceContext; resumeFrom?: string; citationOffsetBase?: number; onDone?: (done: { finishReason?: string }) => void; onCitation?: (candidate: ResearchCitationCandidate) => void; citationSources?: readonly ResearchCitationSourceIdentity[]; signal?: AbortSignal } = {},
  ): AsyncIterable<string> {
    if (!messages.length) throw new Error("Research body requires at least one message");
    const promptVersion = options.context?.promptVersion ?? this.promptVersion;
    const basePrompt = this.researchBodyPrompt(messages, options.parentChainContext, options.sliceContext, promptVersion);
    // 断点续写：把已写正文尾部作衔接，指令模型从断点继续、不要重复。
    const resumeTail = options.resumeFrom ? options.resumeFrom.slice(-500) : "";
    const prompt = options.resumeFrom
      ? `${basePrompt}\n\n正文已写到断点，请从断点处继续，不要重复已写内容：\n……${resumeTail}`
      : basePrompt;
    const baseEnvelope = this.researchBodyEnvelope(messages, options.parentChainContext, options.sliceContext, options.context);
    const envelope: PromptEnvelope = options.resumeFrom ? {
      ...baseEnvelope,
      messages: [...baseEnvelope.messages, { role: "user", content: `正文已写到断点，请从断点处继续，不要重复已写内容：\n……${resumeTail}` }],
    } : baseEnvelope;
    const request: ModelProviderRequest = {
      envelope,
      prompt,
      model: options.model ?? this.modelName,
      thinking: options.thinking ?? false,
      maxTokens: options.maxTokens ?? RESEARCH_BODY_DEFAULT_MAX_TOKENS,
      timeoutMs: options.timeoutMs ?? 120_000,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.citationSources?.length ? { citationSources: options.citationSources } : {}),
    };
    const context = options.context ?? { purpose: "research_body" };
    // 窄化 provider：非流式回退分支后，后续引用 guaranteed 有 completeStream。
    const provider = this.provider;
    if (!provider || typeof provider.completeStream !== "function") {
      // 非流式 provider 回退：complete() 自带记账，把 trimmed 正文作为单增量产出。
      const content = (await this.complete(request, context)).content.trim();
      if (!content) throw new Error("Research body provider returned an empty body");
      yield content;
      return;
    }
    const prepared = this.prepareRequest(request, context);
    const createdAt = new Date().toISOString();
    const startedAt = Date.now();
    // doneRef 由本调用局部持有（非实例字段），并发/交错调用互不干扰。
    const doneRef: { model: string; usage?: ProviderUsage; finishReason?: string } = { model: prepared.model };
    let assembled = "";
    let rawAssembled = "";
    const citationCandidates: ResearchCitationCandidate[] = [];
    const offsetBase = options.citationOffsetBase ?? 0;
    const emitCitation = (candidate: ResearchCitationCandidate): boolean => {
      if (candidate.startOffset === undefined || candidate.endOffset === undefined) {
        options.onCitation?.(candidate);
        return true;
      }
      const leadingTrim = rawAssembled.length - rawAssembled.trimStart().length;
      const startOffset = candidate.startOffset - leadingTrim;
      const endOffset = candidate.endOffset - leadingTrim;
      // Provider annotations may arrive before their cited text. Defer those until
      // enough visible body has passed the trim boundary; never guess a future range.
      if (startOffset < 0 || endOffset <= startOffset || endOffset > assembled.length) return false;
      options.onCitation?.({ ...candidate, startOffset: offsetBase + startOffset, endOffset: offsetBase + endOffset });
      return true;
    };
    const flushCitationCandidates = () => {
      while (citationCandidates[0] && emitCitation(citationCandidates[0])) citationCandidates.shift();
    };
    try {
      // 原始 reasoning 只在供应商协议解析层存在，到网关正文边界即丢弃。
      // completeStream 在窄化作用域内调用（async generator 惰性执行，调用本身不发起请求）。
      const streamEvents = provider.completeStream(prepared);
      const textEvents = (async function* () {
        for await (const event of streamEvents) {
          if (event.type === "reasoning") continue;
          if (event.type === "citation") {
            const candidate = {
              sourceOrdinal: event.sourceOrdinal,
              ...(event.startOffset !== undefined ? { startOffset: event.startOffset } : {}),
              ...(event.endOffset !== undefined ? { endOffset: event.endOffset } : {}),
              ...(event.providerCitationId ? { providerCitationId: event.providerCitationId } : {}),
            };
            citationCandidates.push(candidate);
            flushCitationCandidates();
            continue;
          }
          if (event.type === "delta") rawAssembled += event.text;
          yield event;
        }
      })();
      for await (const trimmed of trimStream(extractStreamDeltas(textEvents, doneRef))) {
        assembled += trimmed;
        yield trimmed;
        flushCitationCandidates();
      }
      await this.emitCompleted(context, prepared, startedAt, createdAt, { content: assembled, model: doneRef.model, usage: doneRef.usage, finishReason: doneRef.finishReason });
    } catch (error) {
      await this.emitFailed(context, prepared, startedAt, createdAt, error);
      throw error;
    }
    if (!assembled.trim()) throw new Error("Research body provider returned an empty body");
    for (const candidate of citationCandidates) emitCitation(candidate);
    citationCandidates.length = 0;
    // 回报终帧 finishReason，供调用方判断是否需要续写（length = 被 max_tokens 截断）。
    options.onDone?.({ ...(doneRef.finishReason !== undefined ? { finishReason: doneRef.finishReason } : {}) });
  }

  /**
   * plan-then-write 第一阶段：为长文生成有序大纲。大纲是给程序消费的结构数据，
   * 故此处保留 JSON 输出（结构化对"数据提取"有益）。节数有界，避免模型产出过多碎节。
   */
  async generateBodyOutline(
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext; parentChainContext?: ResearchParentChainContext; sliceContext?: ResearchSliceContext } = {},
  ): Promise<ResearchBodyOutline> {
    if (!messages.length) throw new Error("Body outline requires at least one message");
    const parentContext = formatResearchParentChainContext(options.parentChainContext);
    const sliceContext = formatResearchSliceContext(options.sliceContext);
    const prompt = `你是 Collector 的研究助手。用户的问题需要一篇较长的中文正文。请先只输出这份正文的写作大纲，不要写正文本身。

只返回合法 JSON，不要使用 Markdown 代码围栏，形式必须为：
{"sections":[{"heading":"节标题","summary":"该节要论述的主旨","targetChars":800}]}

大纲规则：
- 返回 ${RESEARCH_BODY_OUTLINE_MIN_SECTIONS} 至 ${RESEARCH_BODY_OUTLINE_MAX_SECTIONS} 节，按正文展开顺序排列；若内容只需一篇短文，可只返回 1 节。
- heading 简洁准确，将作为该节的标题；summary 用一句话说明该节要展开的内容；targetChars 是该节的目标字数（数字）。
- 不要返回正文字段、解释或 sections 以外的任何字段。

对话：
${JSON.stringify(messages)}${parentContext ? `\n\n${parentContext}` : ""}${sliceContext ? `\n\n${sliceContext}` : ""}`;
    const response = await this.complete({
      prompt,
      model: options.model ?? this.modelName,
      responseFormat: { type: "json_object" },
      thinking: options.thinking ?? false,
      maxTokens: options.maxTokens ?? 4_000,
      timeoutMs: options.timeoutMs ?? 120_000,
    }, options.context ?? { purpose: "research_body_outline" });
    return parseBodyOutline(response.content);
  }

  /**
   * plan-then-write 第二阶段：在给定大纲与已生成前文的前提下，串行扩写某一节。
   * 串行（每节条件于全部前文）保证长文连贯、避免主题漂移；输出自由正文片段。
   */
  /**
   * plan-then-write 第二阶段：在给定大纲与已生成前文的前提下，串行扩写某一节。
   * 串行（每节条件于全部前文）保证长文连贯、避免主题漂移；输出自由正文片段。
   * 返回 content 与 finishReason（length 表示被 max_tokens 截断），供调用方做有界续写/空节修复/降级。
   * continuation：从断点续写本节，不重复已写内容、不重发节标题；repairHint：写入上次失败原因（如空输出）；
   * targetCharsOverride：降级重试时下调的目标字数。措辞为有界修复指令，不做任何内容质量评估。
   */
  async expandBodySection(
    input: {
      goal: string;
      outline: ResearchBodyOutline;
      sectionIndex: number;
      writtenSoFar: string;
      /** 续写：从断点继续本节，不要重复已写内容、不要重发节标题。 */
      continuation?: { priorSectionContent: string };
      /** 修复提示：写入上次失败原因（如"上次输出为空"）。 */
      repairHint?: string;
      /** 降级重试时下调的目标字数。 */
      targetCharsOverride?: number;
    },
    options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext; nodeDepth?: number } = {},
  ): Promise<{ content: string; finishReason?: string }> {
    const section = input.outline.sections[input.sectionIndex];
    if (!section) throw new Error(`Body section ${input.sectionIndex} is out of range`);
    const outlineText = input.outline.sections
      .map((item, index) => `${index + 1}. ${item.heading}（${item.summary}）`)
      .join("\n");
    const targetChars = input.targetCharsOverride ?? section.targetChars;
    const continuation = input.continuation;
    // 断点前文只取尾部一段作衔接上下文，避免整节重复进入提示。
    const continuationTail = continuation ? continuation.priorSectionContent.slice(-500) : "";
    const prompt = `你是 Collector 的研究助手。你正在按大纲逐节撰写一篇连贯的中文长文，现在请只扩写其中一节。

写作目标：${input.goal}

完整大纲：
${outlineText}

本次要扩写的是第 ${input.sectionIndex + 1} 节「${section.heading}」：${section.summary}（目标约 ${targetChars} 字）。

${input.writtenSoFar.trim() ? `已生成的前文（仅供保持连贯，不要重复其内容）：\n${input.writtenSoFar}\n\n` : ""}${continuation ? `本节已写到断点，请从断点处继续，不要重复已写内容、不要重发节标题：\n……${continuationTail}\n\n` : ""}${input.repairHint ? `上次输出有问题：${input.repairHint}。这次请直接输出本节正文。\n\n` : ""}要求：
${continuation ? "- 直接从断点继续写正文，不要重复上面的内容，不要再输出节标题。\n" : `- 第一行输出该节标题，格式为 Markdown 二级标题：## ${section.heading}；标题后用一个空行接正文，正文由流畅段落组成、段落间用一个空行分隔。整节只出现这一次标题，正文内不要再重复该标题或另起同级标题。\n`}- 只输出第 ${input.sectionIndex + 1} 节，不要重复大纲或其它节，不要为正文内的小论点再起标题。
- 与前文自然衔接、保持同一主题与语气；内容详实，服从该节目标字数。
- 保持来源事实与不确定性，不编造来源、链接或引用。
- 不要使用 Markdown 代码围栏，不要返回 JSON 或大纲字段，只输出该节标题与正文。
- 只输出干净正文，不要输出任何内部控制协议；弱标记由独立抽取任务产生。`;
    const response = await this.complete({
      prompt,
      model: options.model ?? this.modelName,
      thinking: options.thinking ?? false,
      maxTokens: options.maxTokens ?? RESEARCH_BODY_DEFAULT_MAX_TOKENS,
      timeoutMs: options.timeoutMs ?? 120_000,
    }, options.context ?? { purpose: "research_body_section" });
    const content = response.content.trim();
    if (!content) throw new Error(`Body section ${input.sectionIndex + 1} expansion returned empty content`);
    return { content, ...(response.finishReason !== undefined ? { finishReason: response.finishReason } : {}) };
  }

  /**
   * 生成自由化后的事后语义标注：从一段已落库的正文段落抽取标题与概念（temperature=0，
   * 确定性、低成本、失败可重试）。绝不改写正文；失败或空结果由调用方降级（空标题/空概念）。
   */
  async deriveSliceAnnotations(
    input: { content: string },
    options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {},
  ): Promise<ResearchSliceAnnotation> {
    if (!input.content.trim()) return { title: "", concepts: [] };
    const prompt = `你是 Collector 的语义标注助手。下面是一段研究正文的段落。请为它抽取一个简洁标题和几个归一化概念，用于卡片导航与关联检索。

只返回合法 JSON，不要使用 Markdown 代码围栏，形式必须为：
{"title":"简洁标题","concepts":["归一化概念"]}

规则：
- title 一句话概括该段主旨，不要超过 ${RESEARCH_NATIVE_SLICE_MAX_TITLE_CHARACTERS} 字；若该段不适合起标题，返回空字符串。
- 该段若已含有自己的节标题（如以"## 标题"或整段加粗短行开头），title 返回空字符串——不要复述段内已有标题，由系统直接采用它。
- concepts 是该段涉及的核心概念/术语，最多 ${RESEARCH_NATIVE_SLICE_MAX_CONCEPTS} 个，每个不超过 ${RESEARCH_NATIVE_SLICE_MAX_CONCEPT_CHARACTERS} 字；没有合适概念时返回空数组。
- 只依据所给段落，不要补充外部事实；不要返回解释或其它字段。

段落：
${JSON.stringify(input.content)}`;
    const response = await this.complete({
      prompt,
      model: options.model ?? this.modelName,
      responseFormat: { type: "json_object" },
      temperature: 0,
      thinking: false,
      maxTokens: options.maxTokens ?? 1_000,
      timeoutMs: options.timeoutMs ?? 30_000,
    }, options.context ?? { purpose: "research_slice_annotation" });
    return parseSliceAnnotation(response.content);
  }

  /** 独立弱标记抽取：只返回候选范围 JSON；正文与最终范围资格由 API 服务验证。 */
  async extractTermMarkers(
    input: {
      phase: "paragraph" | "full";
      blocks: Array<{ ordinal: number; text: string }>;
      coveredTerms: string[];
      nodeDepth: number;
    },
    options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {},
  ): Promise<string> {
    const prompt = `你是 Collector 的弱标记抽取助手。请只从给定正文块中选择理解当前论述确实需要解释的重要对象。

只返回合法 JSON，不要使用 Markdown 代码围栏：
{"mentions":[{"blockOrdinal":0,"startOffset":0,"endOffset":4,"text":"原文切片","category":"concept","entityId":"answer-local-id"}]}

规则：
- category 只能是 concept、entity、abbreviation、notation。
- startOffset/endOffset 是相对对应 block.text 的 UTF-16 下标；text 必须与该切片逐字一致。
- entityId 只在当前回答内有效，使用 1–64 位英文字母、数字、连字符或下划线；同一对象复用身份，同名异义使用不同身份。
- 不标记 Markdown 标题、普通名词、日期、网址、引用编号、完整句子或已经充分解释的对象。
- coveredTerms 中的祖先对象已经展开，不得再次标记。
- 不要用关键词扫描补齐；不确定时省略。phase=paragraph 时只判断给定已闭合段落，phase=full 时复核整篇并返回最终集合。

输入：${JSON.stringify(input)}`;
    const response = await this.complete({
      prompt,
      model: options.model ?? this.modelName,
      responseFormat: { type: "json_object" },
      temperature: 0,
      thinking: false,
      maxTokens: options.maxTokens ?? 2_048,
      timeoutMs: options.timeoutMs ?? 30_000,
    }, options.context ?? { purpose: "term_marker_extraction" });
    return response.content;
  }

  /**
   * #207 citation producer: proposes support ranges only. The API-owned attribution Module
   * performs identity/range checks and the versioned acceptance decision.
   */
  async produceCitationAttributions(
    input: {
      batchId: string;
      mode: "verify_native" | "discover";
      body: { startOffset: number; endOffset: number; content: string };
      sources: Array<{ sourceOrdinal: number; content: string }>;
      nativeCandidates: Array<{ candidateId: string; sourceOrdinal: number; startOffset: number; endOffset: number; claimText: string }>;
    },
    options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {},
  ): Promise<string> {
    const prompt = `You are Collector's citation attribution producer. You propose claim-to-evidence support ranges; you do not accept citations and you do not decide whether a claim is objectively true.

Return valid JSON only, without Markdown fences:
{"attributions":[{"nativeCandidateId":"provider:1","sourceOrdinal":1,"claimText":"exact final-body text","evidenceText":"exact source text","support":true,"confidence":0.92}]}

Rules:
- claimText and evidenceText are exact text selectors, not summaries. Copy them verbatim from body.content and the selected source.content. The deterministic policy resolves their JavaScript UTF-16 ranges and rejects selectors that are missing, repeated, too broad, or ambiguous.
- support=true only when the evidence text directly supports the complete claim without relying on unstated assumptions. Otherwise return support=false or omit the proposal.
- confidence is from 0 to 1 and measures this exact claim/source support relation.
- Use only listed sourceOrdinal values. Never cite a title, URL, source number, or search presence as support by itself.
- Do not output broad paragraph ranges when a shorter complete claim is available.
- In verify_native mode, return exactly one proposal for each nativeCandidates item, preserve its candidateId as nativeCandidateId, sourceOrdinal, and claimText, and do not invent additional candidates. The native offsets are already owned and checked by the deterministic policy; do not recalculate them.
- In discover mode, omit nativeCandidateId and return only independently discovered supported claims. Writer self-reports are not evidence and are not present in this input.
- When no relation is supportable, return {"attributions":[]}.

Input: ${JSON.stringify(input)}`;
    const response = await this.complete({
      prompt,
      model: options.model ?? this.modelName,
      responseFormat: { type: "json_object" },
      temperature: 0,
      thinking: false,
      maxTokens: options.maxTokens ?? 4_096,
      timeoutMs: options.timeoutMs ?? 60_000,
    }, options.context ?? { purpose: "citation_attribution", promptVersion: "citation-attribution-producer-v1" });
    return response.content;
  }

  /**
   * 同一节点内的同名提及核验。输入只保留双方各 600 字局部语境（上限与请求
   * 结构由 @collector/capture-contracts 统一定义）；文本相同不构成充分条件，
   * 同形异义或无法确定时必须返回 false。
   */
  async verifyTermIdentity(
    input: TermIdentityVerificationRequest,
    options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {},
  ): Promise<boolean> {
    const boundMention = (mention: TermIdentityVerificationRequest["left"]) => ({
      ...mention,
      text: mention.text.slice(0, TERM_IDENTITY_TEXT_MAX_CHARACTERS),
      context: mention.context.slice(0, TERM_IDENTITY_CONTEXT_MAX_CHARACTERS),
    });
    const bounded = { left: boundMention(input.left), right: boundMention(input.right) };
    const prompt = `你是 Collector 的实体身份核验助手。判断同一研究节点内的两处提及是否指向同一个可解释对象。

只返回合法 JSON：{"sameEntity":true} 或 {"sameEntity":false}。

规则：
- 只有指向同一对象才返回 true；拼写相同、类别相同本身都不充分。
- 人物、组织、作品、概念、缩写或符号存在同名异义、不同展开、不同版本或不同指代时返回 false。
- 语境不足、结论不确定时返回 false；不要使用外部知识补全缺失信息。

提及 A：${JSON.stringify(bounded.left)}
提及 B：${JSON.stringify(bounded.right)}`;
    const response = await this.complete({
      prompt,
      model: options.model ?? this.modelName,
      responseFormat: { type: "json_object" },
      temperature: 0,
      thinking: false,
      maxTokens: options.maxTokens ?? 128,
      timeoutMs: options.timeoutMs ?? 30_000,
    }, options.context ?? { purpose: "term_entity_verification", promptVersion: TERM_IDENTITY_VERIFY_PROMPT_VERSION });
    const parsed = JSON.parse(response.content) as { sameEntity?: unknown };
    if (typeof parsed.sameEntity !== "boolean") throw new Error("Term identity verification returned an invalid result");
    return parsed.sameEntity;
  }

  /**
   * 会话标题提炼：为研究会话生成简洁中文标题。调用方负责长度/空值校验与确定性回退。
   * 与节点命名同构但允许更长（上限 40 字符），供会话列表展示。
   */
  async generateSessionTitle(
    input: { content: string },
    options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {},
  ): Promise<string> {
    const prompt = [
      "你是 Collector 的会话标题助手。请为下面的研究会话生成一个简洁、准确的中文标题。",
      "只返回合法 JSON：{\"name\":\"...\"}。标题不超过 40 个字符，不要添加引号、编号或解释。",
      `会话内容：${JSON.stringify(input.content.slice(0, 2000))}`,
    ].join("\n\n");
    const response = await this.complete({
      prompt,
      model: options.model ?? this.modelName,
      responseFormat: { type: "json_object" },
      thinking: false,
      maxTokens: options.maxTokens ?? 128,
      timeoutMs: options.timeoutMs ?? 30_000,
    }, options.context ?? { purpose: "research", promptVersion: "session-titling-v1" });
    const parsed = JSON.parse(response.content) as { name?: unknown };
    if (typeof parsed.name !== "string" || !parsed.name.trim()) throw new Error("Session titling provider returned an invalid title");
    return parsed.name.trim();
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
   * 统一章节解析：通读按 `[B<ordinal>]` 编号的导入材料或回答正文，输出章节起点块号与标题。
   * 返回模型原始 JSON 文本；合法性校验（块号范围/递增/标题）由调用方经
   * validateImportChapterPlan 完成，不合契约时调用方退化为规则锚点。
   * 给定材料的结构化整理任务，固定关闭思考模式（融合正文同源教训：thinking 耗尽预算）。
   */
  async parseImportChapters(
    input: { content: string },
    options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {},
  ): Promise<string> {
    const prompt = `你是 Collector 的长内容章节解析助手。下面是一份导入材料或回答正文，已按段落块编号（[B0]、[B1]……）。请通读全文，按内容真实结构划分章节，并为每章给出起始段落块编号与章节标题。

只返回合法 JSON：{"chapters":[{"block":0,"title":"第一章标题"}]}

规则：
- block 是该章起始段落块的编号（整数）；第一章必须从 0 开始。
- chapters 按 block 严格递增且不重复；章节数在 2 到 12 之间，不要逐段成章。
- title 概括该章内容，不超过 30 字，不要编号、引号、标点收尾或解释。
- 只依据所给文本划分，不要补充外部事实；不要输出任何 [[...]] 标记或额外字段。

文章：
${input.content}`;
    const response = await this.complete({
      prompt,
      model: options.model ?? this.modelName,
      responseFormat: { type: "json_object" },
      temperature: 0,
      thinking: false,
      maxTokens: options.maxTokens ?? IMPORT_CHAPTER_PARSE_TOKEN_BUDGET,
      timeoutMs: options.timeoutMs ?? 120_000,
    }, options.context ?? { purpose: "research", promptVersion: IMPORT_CHAPTER_PARSE_PROMPT_VERSION });
    return response.content;
  }

  /**
   * 普通临时关联提示的专用评估。关系成立不等于值得打扰用户：模型还必须判断
   * 此刻是否能帮助重新发现、补充、纠正、对比或扩展当前认识。该方法不触碰融合路径。
   */
  async evaluateAssociationHint(
    input: {
      left: { nodeId: string; content: string; currentContext: string };
      right: { nodeId: string; content: string; currentContext: string };
      terminalReasons: string[];
    },
    options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {},
  ): Promise<{ relationType: FusionRelationType; reason: string; hasValue: boolean; benefits: ResearchAssociationHintBenefit[]; priority: number; reasonSubstantiallyChanged: boolean }> {
    if (!input.left.nodeId || !input.right.nodeId || input.left.nodeId === input.right.nodeId) {
      throw new Error("Association hint evaluation requires two distinct nodes");
    }
    const prompt = `你是 Collector 的普通关联提示评估助手。只根据给出的两端可定位证据和各自当前稳定上下文判断；这不是融合任务，不得提出融合、建边、任务或新节点。

节点 A 的可定位证据（${input.left.nodeId}）：
${JSON.stringify(input.left.content.slice(0, 12_000))}

节点 A 的当前上下文：
${JSON.stringify(input.left.currentContext.slice(0, 12_000))}

节点 B 的可定位证据（${input.right.nodeId}）：
${JSON.stringify(input.right.content.slice(0, 12_000))}

节点 B 的当前上下文：
${JSON.stringify(input.right.currentContext.slice(0, 12_000))}

同一节点对已经终结的历史理由（可能为空）：
${JSON.stringify(input.terminalReasons.map((reason) => reason.slice(0, 160)))}

只返回合法 JSON：
{"relationType":"identity | shared-concept | analogy | contrast | unrelated","reason":"不超过160个中文字符的可回溯理由","hasValue":true|false,"benefits":["rediscovery | supplement | correction | comparison | expansion"],"priority":1-100,"reasonSubstantiallyChanged":true|false}

规则：
- relationType 和 reason 只说明两段可定位证据可见的关系，材料不足时为 unrelated；
- hasValue 只在这条提示确实能帮助用户重新发现、补充、纠正、对比或扩展当前认识时为 true；字面相似、重复已知信息或没有下一步认识价值时为 false；
- hasValue 为 true 时 relationType 不能是 unrelated，benefits 至少一个且去重，priority 为 1 到 100 的整数；
- hasValue 为 false 时 benefits 必须是 []，priority 必须是 0；
- 历史理由为空时 reasonSubstantiallyChanged 固定为 true；历史理由非空时，只有当前 reason 由新的实质证据支撑、能带来不同认识，且不是同义改写或仅替换 relationType 时才为 true；无法确定时为 false；
- reason 不得提及提示词、模型或系统，不得补充外部事实。`;
    const evaluationContext: ModelCallContext = {
      ...(options.context ?? {}),
      purpose: options.context?.purpose ?? "association_hint_evaluation",
      promptVersion: options.context?.promptVersion ?? ASSOCIATION_HINT_EVALUATION_PROMPT_VERSION,
    };
    const response = await this.complete({
      prompt,
      model: options.model ?? this.modelName,
      responseFormat: { type: "json_object" },
      temperature: 0,
      thinking: false,
      maxTokens: options.maxTokens ?? 900,
      timeoutMs: options.timeoutMs ?? 45_000,
    }, evaluationContext);
    let parsed: { relationType?: unknown; reason?: unknown; hasValue?: unknown; benefits?: unknown; priority?: unknown; reasonSubstantiallyChanged?: unknown };
    try {
      parsed = JSON.parse(response.content) as typeof parsed;
    } catch {
      throw new Error("Association hint evaluation provider returned invalid JSON");
    }
    if (!FUSION_RELATION_TYPES.includes(parsed.relationType as FusionRelationType)
      || typeof parsed.reason !== "string" || !parsed.reason.replace(/\s+/g, " ").trim() || parsed.reason.replace(/\s+/g, " ").trim().length > 160
      || typeof parsed.hasValue !== "boolean" || !Array.isArray(parsed.benefits)
      || !parsed.benefits.every((benefit): benefit is ResearchAssociationHintBenefit => typeof benefit === "string" && ASSOCIATION_HINT_BENEFITS.includes(benefit as ResearchAssociationHintBenefit))
      || new Set(parsed.benefits).size !== parsed.benefits.length
      || !Number.isSafeInteger(parsed.priority) || (parsed.priority as number) < 0 || (parsed.priority as number) > 100
      || typeof parsed.reasonSubstantiallyChanged !== "boolean") {
      throw new Error("Association hint evaluation provider returned an invalid result");
    }
    if (parsed.hasValue
      ? parsed.relationType === "unrelated" || parsed.benefits.length === 0 || parsed.priority === 0
      : parsed.benefits.length !== 0 || parsed.priority !== 0) {
      throw new Error("Association hint evaluation provider returned an inconsistent value decision");
    }
    return {
      relationType: parsed.relationType as FusionRelationType,
      reason: parsed.reason.replace(/\s+/g, " ").trim(),
      hasValue: parsed.hasValue,
      benefits: parsed.benefits,
      priority: parsed.priority as number,
      reasonSubstantiallyChanged: parsed.reasonSubstantiallyChanged,
    };
  }

  /**
   * F1：核验两个候选节点的关系。模型只能在给出的局部节点材料中判断，
   * 返回不符合模式、理由为空或过长都会被视为失败，由调用方安全地不产提议。
   */
  async verifyResearchSimilarity(
    input: {
      left: { nodeId: string; content: string };
      right: { nodeId: string; content: string };
    },
    options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {},
  ): Promise<{ relationType: FusionRelationType; reason: string }> {
    if (!input.left.nodeId || !input.right.nodeId || input.left.nodeId === input.right.nodeId) {
      throw new Error("Similarity verification requires two distinct nodes");
    }
    const prompt = `你是 Collector 的本地研究节点相似性核验助手。只根据下面两份节点材料判断关系，不能补充外部事实、来源或身份断言。特别注意：跨作品、跨领域的同名概念默认是 analogy 或 contrast；只有给出的材料明确支持时才可判为 identity。

节点 A（${input.left.nodeId}）：
${JSON.stringify(input.left.content.slice(0, 12_000))}

节点 B（${input.right.nodeId}）：
${JSON.stringify(input.right.content.slice(0, 12_000))}

只返回合法 JSON：
{"relationType":"identity | shared-concept | analogy | contrast | unrelated","reason":"不超过 160 个中文字符的简短中文理由"}

规则：
- identity 仅用于证据支持的同一实体；
- shared-concept 表示共享概念但不等同；
- analogy 表示类比或相似结构；contrast 表示可比较的差异或对照；
- 材料不足或没有可解释关联时返回 unrelated；
- reason 必须说明材料中可见的依据，不要提及提示词、模型或系统。`;
    const similarityContext: ModelCallContext = {
      ...(options.context ?? {}),
      purpose: options.context?.purpose ?? "similarity_verification",
      promptVersion: options.context?.promptVersion ?? SIMILARITY_VERIFICATION_PROMPT_VERSION,
    };
    const response = await this.complete({
      prompt,
      model: options.model ?? this.modelName,
      responseFormat: { type: "json_object" },
      thinking: false,
      maxTokens: options.maxTokens ?? 800,
      timeoutMs: options.timeoutMs ?? 45_000,
    }, similarityContext);
    let parsed: { relationType?: unknown; reason?: unknown };
    try {
      parsed = JSON.parse(response.content) as { relationType?: unknown; reason?: unknown };
    } catch {
      throw new Error("Similarity verification provider returned invalid JSON");
    }
    if (!FUSION_RELATION_TYPES.includes(parsed.relationType as FusionRelationType)) {
      throw new Error("Similarity verification provider returned an invalid relation type");
    }
    if (typeof parsed.reason !== "string") throw new Error("Similarity verification provider returned an invalid reason");
    const reason = parsed.reason.replace(/\s+/g, " ").trim();
    if (!reason || reason.length > 160) throw new Error("Similarity verification provider returned an invalid reason");
    return { relationType: parsed.relationType as FusionRelationType, reason };
  }

  /** T05: check one changed fusion-draft judgement only against its cited formal sources. */
  async verifyTemporaryFusionDraftEvidence(
    input: { judgment: string; sources: Array<{ nodeId: string; content: string }> },
    options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {},
  ): Promise<{ verified: boolean }> {
    if (!input.judgment.trim() || input.sources.length < 2) throw new Error("Draft evidence verification requires one judgment and two sources");
    const sources = input.sources.map((source, index) => `来源${index + 1}（节点 ${source.nodeId}）：\n${JSON.stringify(source.content.slice(0, 12_000))}`).join("\n\n");
    const response = await this.complete({
      prompt: `你是 Collector 的临时融合草案核验助手。只能根据给出的正式来源判断这一个草案判断是否被充分支持；不能补充外部事实。\n\n待核验判断：\n${JSON.stringify(input.judgment)}\n\n来源材料：\n${sources}\n\n只返回合法 JSON：{"verified":true} 或 {"verified":false}。如果判断缺少至少两个来源的可见支撑、引用与判断不相符或材料不足，必须返回 false。`,
      model: options.model ?? this.modelName,
      responseFormat: { type: "json_object" },
      thinking: false,
      maxTokens: options.maxTokens ?? 800,
      timeoutMs: options.timeoutMs ?? 45_000,
    }, {
      ...(options.context ?? {}),
      purpose: options.context?.purpose ?? "temporary_fusion_draft_revalidation",
      promptVersion: options.context?.promptVersion ?? "temporary-fusion-draft-revalidation-v1",
    });
    let parsed: { verified?: unknown };
    try { parsed = JSON.parse(response.content) as { verified?: unknown }; }
    catch { throw new Error("Draft evidence verification provider returned invalid JSON"); }
    if (typeof parsed.verified !== "boolean") throw new Error("Draft evidence verification provider returned an invalid result");
    return { verified: parsed.verified };
  }

  /**
   * 独立判断多份正式来源是否共同支持一项具体新增认识，并在成立时生成完整临时草案。
   * 相似或可比较本身不构成新增认识；返回结构不合规时调用方不得创建 B 面候选。
   */
  async discoverTemporaryFusion(
    input: {
      sources: Array<{ nodeId: string; title: string; excerpt: string }>;
      relationType: FusionRelationType;
    },
    options: { model?: string; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {},
  ): Promise<{ hasNovelInsight: boolean; body: string; usedSourceNodeIds: string[]; judgments: Array<{ startOffset: number; endOffset: number; sourceNodeIds: string[] }> }> {
    const sourceNodeIds = new Set(input.sources.map((source) => source.nodeId));
    if (input.sources.length < 2 || sourceNodeIds.size < 2) {
      throw new Error("Temporary fusion discovery requires two distinct sources");
    }
    const sourceLines = input.sources.map((source, index) =>
      `来源${index + 1}（${source.title}，节点 ${source.nodeId}）：\n${JSON.stringify(source.excerpt.slice(0, 8_000))}`,
    ).join("\n\n");
    const prompt = `你是 Collector 的临时融合发现助手。只根据给出的正式来源，判断它们是否共同支持一项具体、可证且有增量的新认识。

候选关系：${input.relationType}

来源材料：
${sourceLines}

只返回合法 JSON：
{"hasNovelInsight":true,"body":"完整中文 Markdown 草案","usedSourceNodeIds":["实际参与的节点 ID"],"judgments":[{"startOffset":0,"endOffset":12,"sourceNodeIds":["支持该判断的节点 ID"]}]}
或
{"hasNovelInsight":false,"body":"","usedSourceNodeIds":[],"judgments":[]}

规则：
- 相似、同名、共享主题、一般性比较或重复摘要本身不是新增认识；不能据此创建。
- 成立时必须由至少两个来源共同推出一项来源单独不能完整表达的具体认识。
- body 必须是完整、可独立阅读的中文 Markdown 草案，不得夹带来源序号或其他内部控制协议。
- judgments 用 UTF-16 字符偏移标出 body 中每项关键判断，并在 sourceNodeIds 中列出直接支持该判断的至少两个来源。
- usedSourceNodeIds 是 judgments 中实际来源 ID 的并集，至少两个且不得编造 ID。
- 关键证据不足、定位不清、判断不自洽或只有一份来源实际参与时返回 false。
- 不补充外部事实，不提及提示词、模型、系统或“用户要求融合”。`;
    const context: ModelCallContext = {
      ...(options.context ?? {}),
      purpose: options.context?.purpose ?? "temporary_fusion_discovery",
      promptVersion: options.context?.promptVersion ?? TEMPORARY_FUSION_DISCOVERY_PROMPT_VERSION,
    };
    const response = await this.complete({
      prompt,
      model: options.model ?? this.modelName,
      responseFormat: { type: "json_object" },
      thinking: false,
      maxTokens: options.maxTokens ?? TEMPORARY_FUSION_DISCOVERY_TOKEN_BUDGET,
      timeoutMs: options.timeoutMs ?? 120_000,
    }, context);
    let parsed: { hasNovelInsight?: unknown; body?: unknown; usedSourceNodeIds?: unknown; judgments?: unknown };
    try {
      parsed = JSON.parse(response.content) as typeof parsed;
    } catch {
      throw new Error("Temporary fusion discovery provider returned invalid JSON");
    }
    if (typeof parsed.hasNovelInsight !== "boolean" || typeof parsed.body !== "string"
      || !Array.isArray(parsed.usedSourceNodeIds)
      || parsed.usedSourceNodeIds.some((value) => typeof value !== "string")
      || !Array.isArray(parsed.judgments)) {
      throw new Error("Temporary fusion discovery provider returned an invalid result");
    }
    const body = parsed.body.trim();
    const usedSourceNodeIds = [...new Set(parsed.usedSourceNodeIds as string[])];
    const judgments = parsed.judgments as Array<Record<string, unknown>>;
    if (!parsed.hasNovelInsight) {
      if (body || usedSourceNodeIds.length > 0 || judgments.length > 0) throw new Error("Temporary fusion discovery returned an inconsistent negative result");
      return { hasNovelInsight: false, body: "", usedSourceNodeIds: [], judgments: [] };
    }
    if (!body || body.length > 24_000 || usedSourceNodeIds.length < 2
      || usedSourceNodeIds.some((nodeId) => !sourceNodeIds.has(nodeId))) {
      throw new Error("Temporary fusion discovery returned an invalid positive result");
    }
    const normalizedJudgments = judgments.map((judgment) => {
      const startOffset = judgment.startOffset;
      const endOffset = judgment.endOffset;
      const ids = judgment.sourceNodeIds;
      if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset)
        || (startOffset as number) < 0 || (endOffset as number) <= (startOffset as number) || (endOffset as number) > body.length
        || !body.slice(startOffset as number, endOffset as number).trim()
        || !Array.isArray(ids) || ids.some((value) => typeof value !== "string")) {
        throw new Error("Temporary fusion discovery returned invalid judgment ranges");
      }
      const sourceIds = [...new Set(ids as string[])];
      if (sourceIds.length < 2 || sourceIds.some((nodeId) => !sourceNodeIds.has(nodeId) || !usedSourceNodeIds.includes(nodeId))) {
        throw new Error("Temporary fusion discovery returned invalid judgment sources");
      }
      return { startOffset: startOffset as number, endOffset: endOffset as number, sourceNodeIds: sourceIds };
    });
    const judgmentSourceIds = new Set(normalizedJudgments.flatMap((judgment) => judgment.sourceNodeIds));
    if (!normalizedJudgments.length || judgmentSourceIds.size !== usedSourceNodeIds.length
      || usedSourceNodeIds.some((nodeId) => !judgmentSourceIds.has(nodeId))) {
      throw new Error("Temporary fusion discovery returned inconsistent judgment coverage");
    }
    return { hasNovelInsight: true, body, usedSourceNodeIds, judgments: normalizedJudgments };
  }

  /**
   * 深入研究第一轮：只使用提供的当前已有材料（来源内容 + 选区上下文 + 用户方向），
   * 不联网检索，不编造来源。自由正文：返回模型回答的连续文本，不再包 JSON。
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
      sliceContext?: ResearchSliceContext;
    },
    options: { model?: string; thinking?: boolean; maxTokens?: number; timeoutMs?: number; context?: ModelCallContext } = {},
  ): Promise<string> {
    if (!input.selectionText.trim()) throw new Error("Deep research requires the source selection text");
    if (!input.direction.trim()) throw new Error("Deep research requires a research direction");
    const parentContext = formatResearchParentChainContext(input.parentChainContext);
    const sliceContext = formatResearchSliceContext(input.sliceContext);
    // 自由正文：旧式流式深入研究复用此能力，输出连续文本而非 {"answer":...} JSON 包装。
    const prompt = `你是 Collector 的深入研究助手。用户从一段选区发起了深入研究第一轮。只使用下面提供的当前已有材料生成研究内容，不要联网检索，不要编造来源、链接或引用。只输出一段连贯的中文纯文本，不要返回 JSON、字段包装或 Markdown 代码围栏。

用户选区原文：
${JSON.stringify(input.selectionText)}
${input.contentTitle ? `\n来源内容标题：${JSON.stringify(input.contentTitle)}` : ""}
${input.contextBefore ? `\n选区前文（仅供上下文）：\n${JSON.stringify(input.contextBefore)}` : ""}
${input.contextAfter ? `\n选区后文（仅供上下文）：\n${JSON.stringify(input.contextAfter)}` : ""}
${input.mode === "branch" ? "\n研究沿当前内容展开。" : "\n研究在新的独立会话中展开。"}

用户的研究方向：
${JSON.stringify(input.direction)}
${parentContext ? `\n${parentContext}` : ""}${sliceContext ? `\n\n${sliceContext}` : ""}

要求：
- 围绕用户方向，基于选区与上下文展开解释、拆解或延伸；
- 只依据提供的材料，不编造外部事实、链接或来源；
- 材料不足以支撑时在回答中如实说明不确定性；
- 使用中文；
- 只输出干净正文，不要输出任何内部控制协议；弱标记由独立抽取任务产生。`;
    const response = await this.complete({
      prompt,
      model: options.model ?? this.modelName,
      thinking: options.thinking ?? false,
      maxTokens: options.maxTokens ?? RESEARCH_BODY_DEFAULT_MAX_TOKENS,
      timeoutMs: options.timeoutMs ?? 120_000,
    }, options.context ?? { purpose: "deep_research" });
    const content = response.content.trim();
    if (!content) throw new Error("Deep research provider returned an empty answer");
    return content;
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
        console.log(`[search-query] reformulated inputChars=${userMessage.length} outputChars=${reformulated.length}`);
        return reformulated;
      }
    } catch (error) {
      console.log(`[search-query] reformulation failed, using original query error=${error instanceof Error ? error.name : "unknown"}`);
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
      maxTokens?: number;
      systemPrompt?: string;
      context?: ModelCallContext;
      nodeDepth?: number;
    } = {},
  ): Promise<AgentSearchResult> {
    if (typeof (this.provider as any).agentChat !== "function") {
      throw new Error("Agent search loop requires a provider that supports agentChat (tool calling)");
    }
    const maxTurns = options.maxTurns ?? MAX_AGENT_TURNS;
    const loopStartedAt = Date.now();
    console.log(`[web-search] agentLoop start userMessageChars=${userMessage.length} maxTurns=${maxTurns}`);

    const provider = this.provider as ModelProvider & { agentChat?: OpenAiCompatibleProvider["agentChat"] };
    if (typeof provider.agentChat !== "function") {
      throw new Error("Agent search loop requires a provider that supports agentChat (tool calling)");
    }

    const messages: AgentChatMessage[] = [
      { role: "system", content: options.systemPrompt ?? formatAgentSearchSystemPrompt(options.nodeDepth ?? 0) },
      { role: "user", content: userMessage },
    ];

    const queries: string[] = [];
    const sources: GroundingSource[] = [];
    const evidenceBySource = new Map<number, string>();
    const sourceUrlSet = new Set<string>();
    let searchCallCount = 0;
    let fetchCallCount = 0;

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      console.log(`[web-search] agentLoop turn=${turn} messagesLen=${messages.length} searchCalls=${searchCallCount} fetchCalls=${fetchCallCount}`);
      const callContext: ModelCallContext = {
        ...(options.context ?? {}),
        purpose: options.context?.purpose ?? "agent_search",
        workflowStepId: `${options.context?.workflowStepId ?? "agent-search"}:turn:${turn}`,
      };
      const envelope = createPromptEnvelope({
        purpose: callContext.purpose ?? "agent_search",
        promptVersion: callContext.promptVersion ?? this.promptVersion,
        messages: messages.map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
          ...(message.tool_calls?.length ? { toolCalls: message.tool_calls.map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })) } : {}),
        })),
        outputContract: { format: "tool_calls", contractVersion: "agent-search-tools-v1", minimumBodyTokens: 1 },
      });
      const physicalRequest = this.prepareRequest({
        envelope,
        prompt: userMessage,
        model: this.modelName,
        maxTokens: options.maxTokens ?? 4096,
        thinking: false,
      }, callContext);
      const startedAt = Date.now();
      const createdAt = new Date().toISOString();
      let response: AgentChatResponse;
      try {
        response = await provider.agentChat(messages, AGENT_SEARCH_TOOLS, {
          model: physicalRequest.model,
          maxTokens: physicalRequest.appliedBudget?.maxOutputTokens,
          thinking: physicalRequest.appliedBudget?.thinking,
        });
        await this.emitCompleted(callContext, physicalRequest, startedAt, createdAt, {
          content: response.message.content ?? "",
          model: response.model,
          usage: response.usage,
          finishReason: response.finishReason,
        }, response.message.toolCalls?.length ?? 0);
      } catch (error) {
        await this.emitFailed(callContext, physicalRequest, startedAt, createdAt, error);
        throw error;
      }
      console.log(`[web-search] agentLoop turn=${turn} finishReason=${response.finishReason} latency=${Date.now() - startedAt}ms`);

      if (response.finishReason === "stop") {
        const workspaceContent = response.message.content ?? "";
        console.log(`[web-search] agentLoop completed turns=${turn} queries=${queries.length} fetchCount=${fetchCallCount} sourceCount=${sources.length} ignoredWorkspaceContentLen=${workspaceContent.length} latency=${Date.now() - loopStartedAt}ms`);
        // 工具调用循环只负责取证。供应商在该匿名工作区的 stop 文本不能获得研究正文写入权；
        // 上层必须在独立的最终写作阶段生成可展示的正文。
        return { queries, sources, evidence: [...evidenceBySource.entries()].map(([sourceOrdinal, content]) => ({ sourceOrdinal, content })) };
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
                content: "已达到搜索轮次上限(5次)。请停止工具调用；不要输出面向用户的回答或总结。",
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
            // #49：搜索摘要即部分证据（snippet 非空为 partial，空为 none），
            // 后续 web_fetch 成功后置为 full。
            const formatted: Array<{ ordinal: number; title: string; url: string; snippet: string }> = [];
            for (const r of result.results) {
              if (!sourceUrlSet.has(r.url)) {
                sourceUrlSet.add(r.url);
                sources.push({ title: r.title, url: r.url, snippet: r.snippet, evidenceStatus: r.snippet.trim() ? "partial" : "none" });
                if (r.snippet.trim()) evidenceBySource.set(sources.length, r.snippet.trim());
              }
              const ordinal = sources.findIndex((s) => s.url === r.url) + 1;
              formatted.push({ ordinal, title: r.title, url: r.url, snippet: r.snippet });
            }

            messages.push({
              role: "tool" as const,
              tool_call_id: tc.id,
              content: JSON.stringify({ query: result.query, total_results: result.total_results, results: formatted }),
            });

            console.log(`[web-search] agentLoop webSearch queryChars=${query.length} resultCount=${formatted.length} totalSources=${sources.length}`);
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
            let contentText: string;
            if (result.errorMessage) {
              // #49 部分证据兜底：抓取失败但来源列表中有该 URL 的搜索摘要时，
              // 把摘要作为明确标注的部分证据喂给模型（引用完整性：可基于摘要陈述）。
              const source = existingOrdinal > 0 ? sources[existingOrdinal - 1] : undefined;
              const snippet = source?.snippet?.trim() ?? "";
              if (source && snippet) {
                source.evidenceStatus = "partial";
                contentText = `抓取失败: ${result.errorMessage}\n\n来源 ${existingOrdinal} 的部分证据（搜索摘要）：\n${snippet}`;
              } else {
                contentText = `抓取失败: ${result.errorMessage}`;
              }
            } else {
              if (existingOrdinal > 0) sources[existingOrdinal - 1].evidenceStatus = "full";
              if (existingOrdinal > 0 && result.content.trim()) evidenceBySource.set(existingOrdinal, result.content.trim());
              contentText = `来源 ${existingOrdinal || "?"} 的完整内容：\n${result.content}`;
            }

            messages.push({ role: "tool" as const, tool_call_id: tc.id, content: contentText });

            console.log(`[web-search] agentLoop webFetch host=${safeLogHost(url)} contentLen=${result.content.length}${result.errorMessage ? " error=true" : ""}`);
          } else {
            messages.push({
              role: "tool" as const,
              tool_call_id: tc.id,
              content: JSON.stringify({ error: `Unknown tool: ${tc.function.name}` }),
            });
            console.log(`[web-search] agentLoop unknownTool nameChars=${tc.function.name.length}`);
          }
        }
        continue;
      }

      // 非正常终态只要求结束匿名取证工作区；任何自然语言收尾都不会获得正文写入权。
      messages.push({ role: "user", content: "请停止工具调用；不要输出面向用户的回答、总结或控制协议。" });
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
          thinking: options.thinking ?? false, maxTokens: options.maxTokens ?? 8000, timeoutMs: options.timeoutMs ?? 120000,
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
          thinking: options.thinking ?? false,
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

  /** 测试用确定逐字流：把响应按 80 字切片逐段产出，终帧带 usage/model（对齐真实供应商的流式语义）。 */
  async *completeStream(request: ModelProviderRequest): AsyncIterable<ModelProviderStreamEvent> {
    this.calls.push(request);
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    const resolved: ModelProviderResponse = typeof response === "string"
      ? { content: response, model: request.model, usage: { inputTokens: 10, outputTokens: 20 } }
      : response ?? { content: "", model: request.model };
    // ADR-0035：思考内容先于正文按 80 字切片产出 reasoning 事件，与真实供应商的流式语义对齐。
    for (let index = 0; index < (resolved.reasoning ?? "").length; index += 80) {
      yield { type: "reasoning", text: resolved.reasoning!.slice(index, index + 80) };
    }
    for (let index = 0; index < resolved.content.length; index += 80) {
      yield { type: "delta", text: resolved.content.slice(index, index + 80) };
    }
    yield { type: "done", model: resolved.model ?? request.model, usage: resolved.usage };
  }
}

export interface OpenAiCompatibleProviderOptions {
  definition: ProviderDefinition;
  apiKey: () => Promise<string | undefined> | string | undefined;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** 由当前配置版本的能力快照提供；省略时只使用 Collector 本地目录。 */
  thinkingSupported?: (model: string) => boolean | undefined;
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

  supportsThinking(model: string): boolean {
    const assessed = this.options.thinkingSupported?.(model);
    if (assessed !== undefined) return assessed;
    return resolveModelThinkingCapability({
      providerId: this.options.definition.id,
      apiMode: this.options.definition.apiMode,
      baseUrl: this.options.baseUrl ?? this.options.definition.defaultBaseUrl,
      model,
    }).thinkingSupported;
  }

  async complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const apiKey = await this.options.apiKey();
    if (!apiKey) throw new Error(`${this.options.definition.label} API key is not configured`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${this.options.definition.label} request timed out`)), request.timeoutMs ?? 75_000);
    let response: Response;
    let payload: any;
    try {
      const wantsJson = request.responseFormat?.type === "json_object";
      const messages = mapPromptEnvelopeToOpenAiMessages(request);
      const body: Record<string, unknown> = {
        model: request.model,
        messages,
        max_tokens: request.appliedBudget?.maxOutputTokens ?? request.maxTokens,
      };
      if (wantsJson) body.response_format = request.responseFormat;
      if (typeof request.temperature === "number") body.temperature = request.temperature;
      if (this.supportsThinking(request.model)) body.thinking = { type: (request.appliedBudget?.thinking ?? request.thinking) ? "enabled" : "disabled" };
      response = await this.fetchImpl(`${normalizeBaseUrl(this.options.baseUrl ?? this.options.definition.defaultBaseUrl)}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: combinedAbortSignal(request.signal, controller),
        redirect: "error",
        body: JSON.stringify(body),
      });
      payload = await response.json().catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new ModelProviderHttpError(`${this.options.definition.label} request failed (HTTP ${response.status})`, response.status);
    return {
      content: payload?.choices?.[0]?.message?.content ?? "",
      model: payload?.model ?? request.model,
      finishReason: payload?.choices?.[0]?.finish_reason ?? undefined,
      usage: {
        inputTokens: payload?.usage?.prompt_tokens,
        outputTokens: payload?.usage?.completion_tokens,
        inputCacheHitTokens: payload?.usage?.prompt_cache_hit_tokens,
        inputCacheMissTokens: payload?.usage?.prompt_cache_miss_tokens,
      },
    };
  }

  /**
   * 真实逐字流式（方案 B）：chat/completions + stream:true。
   * choices[].delta.content 逐字产出；usage 仅在请求 stream_options.include_usage 后的终帧到达。
   * deepseek 思考模式的 reasoning_content 不计入正文。
   */
  async *completeStream(request: ModelProviderRequest): AsyncIterable<ModelProviderStreamEvent> {
    const apiKey = await this.options.apiKey();
    if (!apiKey) throw new Error(`${this.options.definition.label} API key is not configured`);
    const controller = new AbortController();
    // 空闲重置计时：每收到一个 SSE 事件重置，只在超过 timeoutMs 无新事件时 abort。
    const idle = createIdleTimer(request.timeoutMs ?? 75_000, () => controller.abort(new ModelProviderTimeoutError(`${this.options.definition.label} stream idle timed out`)));
    let response: Response;
    try {
      const wantsJson = request.responseFormat?.type === "json_object";
      const messages = mapPromptEnvelopeToOpenAiMessages(request);
      const body: Record<string, unknown> = {
        model: request.model,
        messages,
        max_tokens: request.appliedBudget?.maxOutputTokens ?? request.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (wantsJson) body.response_format = request.responseFormat;
      if (typeof request.temperature === "number") body.temperature = request.temperature;
      if (this.supportsThinking(request.model)) body.thinking = { type: (request.appliedBudget?.thinking ?? request.thinking) ? "enabled" : "disabled" };
      response = await this.fetchImpl(`${normalizeBaseUrl(this.options.baseUrl ?? this.options.definition.defaultBaseUrl)}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: combinedAbortSignal(request.signal, controller),
        redirect: "error",
        body: JSON.stringify(body),
      });
    } catch (error) {
      idle.clear();
      rethrowStreamError(error);
    }
    if (!response.ok) {
      idle.clear();
      throw new ModelProviderHttpError(`${this.options.definition.label} request failed (HTTP ${response.status})`, response.status);
    }
    if (!response.body) {
      idle.clear();
      throw new Error(`${this.options.definition.label} streaming response has no body`);
    }
    let model = request.model;
    let usage: ProviderUsage | undefined;
    let finishReason: string | undefined;
    try {
      for await (const event of iterateServerSentEvents(response.body)) {
        idle.reset();
        if (event.data === "[DONE]") break;
        const payload = JSON.parse(event.data);
        if (typeof payload?.model === "string") model = payload.model;
        const choice = payload?.choices?.[0];
        // 只有供应商定义明确声明且适配器已验证的专用字段拥有 reasoning 资格；
        // 同一帧里先发 reasoning、再发正文，保证服务端持久化顺序与供应商语义一致。
        if (this.supportsThinking(request.model)) {
          const reasoning = choice?.delta?.reasoning_content;
          if (typeof reasoning === "string" && reasoning) yield { type: "reasoning", text: reasoning };
        }
        const text = choice?.delta?.content;
        if (typeof text === "string" && text) yield { type: "delta", text };
        for (const annotation of choice?.delta?.annotations ?? []) {
          const citation = citationCandidateFromAnnotation(annotation?.url_citation ?? annotation, request.citationSources);
          if (citation) yield { type: "citation", ...citation };
        }
        if (typeof choice?.finish_reason === "string" && choice.finish_reason) finishReason = choice.finish_reason;
        if (payload?.usage) {
          usage = {
            inputTokens: payload.usage.prompt_tokens,
            outputTokens: payload.usage.completion_tokens,
            inputCacheHitTokens: payload.usage.prompt_cache_hit_tokens,
            inputCacheMissTokens: payload.usage.prompt_cache_miss_tokens,
          };
        }
      }
    } catch (error) {
      idle.clear();
      rethrowStreamError(error);
    } finally {
      idle.clear();
    }
    yield { type: "done", model, usage, finishReason };
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
      if (this.supportsThinking(options.model ?? this.defaultModel)) {
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
    if (!response.ok) throw new ModelProviderHttpError(`${this.options.definition.label} request failed (HTTP ${response.status})`, response.status);
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
    const body: Record<string, unknown> = { model: request.model, input: mapPromptEnvelopeToOpenAiMessages(request), max_output_tokens: request.appliedBudget?.maxOutputTokens ?? request.maxTokens };
    if (typeof request.temperature === "number") body.temperature = request.temperature;
    const response = await this.request(body);
    const content = openAiOutputText(response);
    return { content, model: response?.model ?? request.model, usage: openAiUsage(response?.usage) };
  }

  /**
   * 真实逐字流式（方案 B）：responses + stream:true。
   * response.output_text.delta 事件的 .delta 逐字产出；usage 在 response.completed 帧的 response.usage。
   * response.failed / error 事件抛错。
   */
  async *completeStream(request: ModelProviderRequest): AsyncIterable<ModelProviderStreamEvent> {
    const apiKey = await this.options.apiKey();
    if (!apiKey) throw new Error(`${this.options.definition.label} API key is not configured`);
    const controller = new AbortController();
    const idle = createIdleTimer(request.timeoutMs ?? 75_000, () => controller.abort(new ModelProviderTimeoutError(`${this.options.definition.label} stream idle timed out`)));
    let response: Response;
    try {
      const body: Record<string, unknown> = { model: request.model, input: mapPromptEnvelopeToOpenAiMessages(request), max_output_tokens: request.appliedBudget?.maxOutputTokens ?? request.maxTokens, stream: true };
      if (typeof request.temperature === "number") body.temperature = request.temperature;
      response = await this.fetchImpl(`${normalizeBaseUrl(this.options.baseUrl ?? this.options.definition.defaultBaseUrl)}/responses`, {
        method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, signal: combinedAbortSignal(request.signal, controller), redirect: "error", body: JSON.stringify(body),
      });
    } catch (error) {
      idle.clear();
      rethrowStreamError(error);
    }
    if (!response.ok) {
      idle.clear();
      throw new ModelProviderHttpError(`${this.options.definition.label} request failed (HTTP ${response.status})`, response.status);
    }
    if (!response.body) {
      idle.clear();
      throw new Error(`${this.options.definition.label} streaming response has no body`);
    }
    let model = request.model;
    let usage: ProviderUsage | undefined;
    let finishReason: string | undefined;
    try {
      for await (const event of iterateServerSentEvents(response.body)) {
        idle.reset();
        const payload = JSON.parse(event.data);
        const type = payload?.type;
        if (type === "response.output_text.delta") {
          if (typeof payload.delta === "string" && payload.delta) yield { type: "delta", text: payload.delta };
        } else if (type === "response.output_text.annotation.added") {
          const citation = citationCandidateFromAnnotation(payload.annotation, request.citationSources);
          if (citation) yield { type: "citation", ...citation };
        } else if (type === "response.completed") {
          model = payload?.response?.model ?? model;
          usage = openAiUsage(payload?.response?.usage);
        } else if (type === "response.incomplete") {
          // 达到 max_output_tokens 等原因未完整：reason 供有界续写判断。
          finishReason = payload?.response?.incomplete_details?.reason === "max_output_tokens" ? "length" : (payload?.response?.incomplete_details?.reason ?? "length");
        } else if (type === "response.failed" || type === "error") {
          // 供应商错误载荷可能回显请求正文或凭证；它没有进入上层日志/任务错误的资格。
          throw new Error(`${this.options.definition.label} streaming failed`);
        }
      }
    } catch (error) {
      idle.clear();
      rethrowStreamError(error);
    } finally {
      idle.clear();
    }
    yield { type: "done", model, usage, finishReason };
  }

  async generateGroundedResearch(request: ModelProviderRequest & { grounding: ResearchGroundingRequest }): Promise<GroundedResearchResponse> {
    const payload = await this.request({
      model: request.model,
      input: mapPromptEnvelopeToOpenAiMessages(request),
      max_output_tokens: request.appliedBudget?.maxOutputTokens ?? request.maxTokens,
      tools: [{ type: "web_search" }],
      tool_choice: "required",
    }, request.timeoutMs);
    // 原生联网的确认依据与正文取值必须来自同一个结构化 output_text 通道；
    // 顶层便捷字段可能混入供应商工作区文本，不能在此获得正文资格。
    const content = openAiStructuredOutputText(payload);
    const annotations = openAiAnnotations(payload);
    const sources = uniqueSources(annotations.flatMap((citation) => {
      const url = safeHttpUrl(citation.url);
      return url ? [{ title: citation.title || url, url }] : [];
    }));
    const citations = annotations.flatMap((citation) => {
      const url = safeHttpUrl(citation.url);
      const sourceOrdinal = sources.findIndex((source) => source.url === url) + 1;
      return sourceOrdinal > 0 ? [{ sourceOrdinal, startOffset: citation.start_index ?? 0, endOffset: citation.end_index ?? citation.start_index ?? 0 }] : [];
    });
    const queries = extractOpenAiQueries(payload);
    const confirmedFinal = payload?.status === "completed" && Boolean(content) && sources.length > 0;
    const metadata = {
      // Responses 只有明确 completed 的结构化 output_text 才拥有最终正文资格。
      // 其它状态即使携带文本，也只能作为取证阶段的非正文输出。
      status: (sources.length ? "grounded" : "no_verifiable_sources") as ResearchGroundingScopeStatus,
      queries,
      sources,
      citations,
      responseSummary: { outputItemCount: Array.isArray(payload?.output) ? payload.output.length : 0 },
    };
    return confirmedFinal ? { bodyKind: "confirmed_final", content, ...metadata } : { bodyKind: "evidence", ...metadata };
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
      if (!response.ok) throw new ModelProviderHttpError(`${this.options.definition.label} request failed (HTTP ${response.status})`, response.status);
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
    const wantsJson = request.responseFormat?.type === "json_object";
    const generationConfig: Record<string, unknown> = { maxOutputTokens: request.appliedBudget?.maxOutputTokens ?? request.maxTokens };
    if (wantsJson) generationConfig.responseMimeType = "application/json";
    if (typeof request.temperature === "number") generationConfig.temperature = request.temperature;
    const payload = await this.request(request.model, { ...mapPromptEnvelopeToGeminiRequest(request), generationConfig }, request.timeoutMs);
    return { content: geminiText(payload), model: request.model, usage: geminiUsage(payload?.usageMetadata) };
  }

  /**
   * 真实逐字流式（方案 B）：:streamGenerateContent?alt=sse。
   * 每个 data 帧的 candidates[0].content.parts[].text 逐字产出；usageMetadata 在终帧。
   */
  async *completeStream(request: ModelProviderRequest): AsyncIterable<ModelProviderStreamEvent> {
    const apiKey = await this.options.apiKey();
    if (!apiKey) throw new Error(`${this.options.definition.label} API key is not configured`);
    const wantsJson = request.responseFormat?.type === "json_object";
    const generationConfig: Record<string, unknown> = { maxOutputTokens: request.appliedBudget?.maxOutputTokens ?? request.maxTokens };
    if (wantsJson) generationConfig.responseMimeType = "application/json";
    if (typeof request.temperature === "number") generationConfig.temperature = request.temperature;
    const controller = new AbortController();
    const idle = createIdleTimer(request.timeoutMs ?? 75_000, () => controller.abort(new ModelProviderTimeoutError(`${this.options.definition.label} stream idle timed out`)));
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${normalizeBaseUrl(this.options.baseUrl ?? this.options.definition.defaultBaseUrl)}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`,
        { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey }, signal: combinedAbortSignal(request.signal, controller), redirect: "error", body: JSON.stringify({ ...mapPromptEnvelopeToGeminiRequest(request), generationConfig }) },
      );
    } catch (error) {
      idle.clear();
      rethrowStreamError(error);
    }
    if (!response.ok) {
      idle.clear();
      throw new ModelProviderHttpError(`${this.options.definition.label} request failed (HTTP ${response.status})`, response.status);
    }
    if (!response.body) {
      idle.clear();
      throw new Error(`${this.options.definition.label} streaming response has no body`);
    }
    let usage: ProviderUsage | undefined;
    let finishReason: string | undefined;
    const emittedCitations = new Set<string>();
    try {
      for await (const event of iterateServerSentEvents(response.body)) {
        idle.reset();
        const payload = JSON.parse(event.data);
        const text = geminiText(payload);
        if (text) yield { type: "delta", text };
        const metadata = payload?.candidates?.[0]?.groundingMetadata;
        const chunks = Array.isArray(metadata?.groundingChunks) ? metadata.groundingChunks : [];
        for (const support of metadata?.groundingSupports ?? []) {
          for (const index of support?.groundingChunkIndices ?? []) {
            const annotation = {
              url: chunks[index]?.web?.uri,
              start_index: support?.segment?.startIndex,
              end_index: support?.segment?.endIndex,
            };
            const citation = citationCandidateFromAnnotation(annotation, request.citationSources);
            if (!citation) continue;
            const key = `${citation.sourceOrdinal}:${citation.startOffset ?? ""}:${citation.endOffset ?? ""}`;
            if (emittedCitations.has(key)) continue;
            emittedCitations.add(key);
            yield { type: "citation", ...citation };
          }
        }
        const candidateFinish = payload?.candidates?.[0]?.finishReason;
        if (typeof candidateFinish === "string" && candidateFinish) finishReason = candidateFinish === "MAX_TOKENS" ? "length" : candidateFinish;
        if (payload?.usageMetadata) usage = geminiUsage(payload.usageMetadata);
      }
    } catch (error) {
      idle.clear();
      rethrowStreamError(error);
    } finally {
      idle.clear();
    }
    yield { type: "done", model: request.model, usage, finishReason };
  }

  async generateGroundedResearch(request: ModelProviderRequest & { grounding: ResearchGroundingRequest }): Promise<GroundedResearchResponse> {
    const payload = await this.request(request.model, {
      ...mapPromptEnvelopeToGeminiRequest(request),
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: request.appliedBudget?.maxOutputTokens ?? request.maxTokens },
    }, request.timeoutMs);
    const candidate = payload?.candidates?.[0];
    const metadata = candidate?.groundingMetadata ?? {};
    const groundingChunks = Array.isArray(metadata.groundingChunks) ? metadata.groundingChunks : [];
    const sources = uniqueSources(groundingChunks.flatMap((chunk: any) => {
      const url = safeHttpUrl(chunk?.web?.uri);
      return url ? [{ title: chunk?.web?.title || url, url, snippet: chunk?.web?.snippet }] : [];
    }));
    const citations = (metadata.groundingSupports ?? []).flatMap((support: any) => (support?.groundingChunkIndices ?? []).flatMap((index: number) => {
      const url = safeHttpUrl(groundingChunks[index]?.web?.uri);
      const sourceOrdinal = sources.findIndex((source) => source.url === url) + 1;
      return sourceOrdinal > 0 ? [{ sourceOrdinal, startOffset: support?.segment?.startIndex ?? 0, endOffset: support?.segment?.endIndex ?? support?.segment?.startIndex ?? 0 }] : [];
    }));
    const content = geminiFinalText(payload);
    const confirmedFinal = candidate?.finishReason === "STOP" && Boolean(content) && sources.length > 0;
    const responseMetadata = {
      status: (sources.length ? "grounded" : "no_verifiable_sources") as ResearchGroundingScopeStatus, queries: stringArray(metadata.webSearchQueries), sources, citations,
      responseSummary: { groundingChunkCount: Array.isArray(metadata.groundingChunks) ? metadata.groundingChunks.length : 0 },
    };
    return confirmedFinal ? { bodyKind: "confirmed_final", content, ...responseMetadata } : { bodyKind: "evidence", ...responseMetadata };
  }

  private async request(model: string, body: Record<string, unknown>, timeoutMs = 75_000): Promise<any> {
    const apiKey = await this.options.apiKey();
    if (!apiKey) throw new Error(`${this.options.definition.label} API key is not configured`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${this.options.definition.label} request timed out`)), timeoutMs);
    try {
      const response = await this.fetchImpl(`${normalizeBaseUrl(this.options.baseUrl ?? this.options.definition.defaultBaseUrl)}/models/${encodeURIComponent(model)}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey }, signal: controller.signal, redirect: "error", body: JSON.stringify(body) });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) throw new ModelProviderHttpError(`${this.options.definition.label} request failed (HTTP ${response.status})`, response.status);
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

  async generateGroundedResearch(request: ModelProviderRequest & { grounding: ResearchGroundingRequest }): Promise<GroundedResearchResponse> {
    const apiKey = await this.options.apiKey();
    if (!apiKey) throw new Error(`${this.options.definition.label} API key is not configured`);
    const deadline = Date.now() + (request.timeoutMs ?? 120_000);
    const mappedEnvelope = mapPromptEnvelopeToAnthropicRequest(request);
    const messages: Array<Record<string, unknown>> = mappedEnvelope.messages.map((message) => ({ ...message }));
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
            max_tokens: request.appliedBudget?.maxOutputTokens ?? request.maxTokens ?? 8_000,
            system: [mappedEnvelope.system, "Answer the research request. Use the web search tool before answering and cite only its returned sources."].filter(Boolean).join("\n\n"),
            messages,
            tools: [{ type: "web_search_20260209", name: "web_search" }, { type: "web_fetch_20260209", name: "web_fetch" }],
          }),
        });
        payload = await response.json().catch(() => undefined);
        if (!response.ok) throw new ModelProviderHttpError(`${this.options.definition.label} request failed (HTTP ${response.status})`, response.status);
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
    const confirmedFinal = payload?.stop_reason === "end_turn" && textBlocks.length > 0 && Boolean(content) && sources.length > 0;
    const responseMetadata = {
      status: (sources.length ? "grounded" : "no_verifiable_sources") as ResearchGroundingScopeStatus,
      queries: [],
      sources,
      citations,
      responseSummary: { contentBlockCount: Array.isArray(payload?.content) ? payload.content.length : 0, continuationCount: messages.length - 1 },
    };
    return confirmedFinal ? { bodyKind: "confirmed_final", content, ...responseMetadata } : { bodyKind: "evidence", ...responseMetadata };
  }

  async complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const apiKey = await this.options.apiKey();
    if (!apiKey) throw new Error(`${this.options.definition.label} API key is not configured`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${this.options.definition.label} request timed out`)), request.timeoutMs ?? 75_000);
    let response: Response;
    let payload: any;
    const wantsJson = request.responseFormat?.type === "json_object";
    const mappedEnvelope = mapPromptEnvelopeToAnthropicRequest(request);
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.appliedBudget?.maxOutputTokens ?? request.maxTokens ?? 4000,
      messages: mappedEnvelope.messages,
    };
    const system = [mappedEnvelope.system, wantsJson ? "Return valid JSON only. Fragment IDs and capture IDs are different identifier types and must never be interchanged." : undefined].filter(Boolean).join("\n\n");
    if (system) body.system = system;
    if (typeof request.temperature === "number") body.temperature = request.temperature;
    try {
      response = await this.fetchImpl(`${normalizeBaseUrl(this.options.baseUrl ?? this.options.definition.defaultBaseUrl)}/messages`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        signal: controller.signal,
        redirect: "error",
        body: JSON.stringify(body),
      });
      payload = await response.json().catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new ModelProviderHttpError(`${this.options.definition.label} request failed (HTTP ${response.status})`, response.status);
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

  /**
   * 真实逐字流式（方案 B）：messages + stream:true。
   * content_block_delta（text_delta）事件的 delta.text 逐字产出；message_start 给输入/缓存 token，
   * message_delta 给输出 token；message_stop 结束；error 事件抛错。
   */
  async *completeStream(request: ModelProviderRequest): AsyncIterable<ModelProviderStreamEvent> {
    const apiKey = await this.options.apiKey();
    if (!apiKey) throw new Error(`${this.options.definition.label} API key is not configured`);
    const controller = new AbortController();
    const idle = createIdleTimer(request.timeoutMs ?? 75_000, () => controller.abort(new ModelProviderTimeoutError(`${this.options.definition.label} stream idle timed out`)));
    const wantsJson = request.responseFormat?.type === "json_object";
    const mappedEnvelope = mapPromptEnvelopeToAnthropicRequest(request);
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.appliedBudget?.maxOutputTokens ?? request.maxTokens ?? 4000,
      messages: mappedEnvelope.messages,
      stream: true,
    };
    const system = [mappedEnvelope.system, wantsJson ? "Return valid JSON only. Fragment IDs and capture IDs are different identifier types and must never be interchanged." : undefined].filter(Boolean).join("\n\n");
    if (system) body.system = system;
    if (typeof request.temperature === "number") body.temperature = request.temperature;
    let response: Response;
    try {
      response = await this.fetchImpl(`${normalizeBaseUrl(this.options.baseUrl ?? this.options.definition.defaultBaseUrl)}/messages`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        signal: combinedAbortSignal(request.signal, controller),
        redirect: "error",
        body: JSON.stringify(body),
      });
    } catch (error) {
      idle.clear();
      rethrowStreamError(error);
    }
    if (!response.ok) {
      idle.clear();
      throw new ModelProviderHttpError(`${this.options.definition.label} request failed (HTTP ${response.status})`, response.status);
    }
    if (!response.body) {
      idle.clear();
      throw new Error(`${this.options.definition.label} streaming response has no body`);
    }
    let model = request.model;
    let cacheHitTokens = 0;
    let cacheCreationTokens = 0;
    let uncachedInputTokens = 0;
    let outputTokens: number | undefined;
    let finishReason: string | undefined;
    try {
      for await (const event of iterateServerSentEvents(response.body)) {
        idle.reset();
        const payload = JSON.parse(event.data);
        const type = payload?.type;
        if (type === "content_block_delta" && payload?.delta?.type === "text_delta" && typeof payload.delta.text === "string" && payload.delta.text) {
          yield { type: "delta", text: payload.delta.text };
        } else if (type === "message_start") {
          model = payload?.message?.model ?? model;
          cacheHitTokens = Number(payload?.message?.usage?.cache_read_input_tokens ?? 0);
          cacheCreationTokens = Number(payload?.message?.usage?.cache_creation_input_tokens ?? 0);
          uncachedInputTokens = Number(payload?.message?.usage?.input_tokens ?? 0);
        } else if (type === "message_delta") {
          outputTokens = payload?.usage?.output_tokens ?? outputTokens;
          const stopReason = payload?.delta?.stop_reason;
          if (typeof stopReason === "string" && stopReason) finishReason = stopReason === "max_tokens" ? "length" : stopReason;
        } else if (type === "error") {
          // 错误事件正文不可信，可能含请求回显；上层只接收稳定错误类别。
          throw new Error(`${this.options.definition.label} streaming failed`);
        }
      }
    } catch (error) {
      idle.clear();
      rethrowStreamError(error);
    } finally {
      idle.clear();
    }
    yield {
      type: "done",
      model,
      finishReason,
      usage: {
        inputTokens: uncachedInputTokens + cacheHitTokens + cacheCreationTokens,
        outputTokens,
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
    if (response.status === 401 || response.status === 403) return { ok: false, error: "认证失败：请检查 API Key 是否正确", errorCode: "authentication" };
    if (response.status === 404 || response.status === 405) return {
      ok: true,
      models: [],
      modelCapabilities: {},
      listSource: "unavailable",
      partial: true,
      warning: "该供应商未提供模型列表端点，请手动填写模型名称",
    };
    if (response.status === 429) return { ok: false, error: "模型列表请求受到限流，请稍后重试", errorCode: "rate_limited" };
    if (!response.ok) return { ok: false, error: `模型列表请求失败（HTTP ${response.status}）`, errorCode: "provider" };
    const payload = await response.json().catch(() => undefined);
    const raw: unknown[] | undefined = definition.apiMode === "gemini_generate_content"
      ? (Array.isArray(payload?.models) ? payload.models.map((entry: any) => typeof entry?.name === "string" ? entry.name.replace(/^models\//, "") : undefined) : undefined)
      : (Array.isArray(payload?.data) ? payload.data.map((entry: any) => typeof entry?.id === "string" ? entry.id : undefined) : undefined);
    const models = raw ? [...new Set(raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))] : [];
    if (!models.length) return { ok: false, error: "模型列表解析失败：返回内容不符合预期格式，请手动填写模型名称", errorCode: "invalid_response" };
    const modelCapabilities = Object.fromEntries(models.map((model) => {
      const identity = { providerId: definition.id, apiMode: definition.apiMode, baseUrl, model };
      return [model, mergeCapabilityMatrices(declaredProviderCapabilities(definition, identity), resolveCatalogCapabilities(identity))];
    }));
    return { ok: true, models, modelCapabilities, listSource: "provider", partial: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/timed out|timeout|abort/i.test(message)) return { ok: false, error: "模型列表请求超时，请稍后重试或检查网络", errorCode: "timeout" };
    return { ok: false, error: "模型列表请求失败，请检查网络后重试", errorCode: "network" };
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

/** 原生联网只读取 Responses wire format 的结构化 output_text。 */
function openAiStructuredOutputText(payload: any): string {
  return (payload?.output ?? [])
    .flatMap((item: any) => item?.content ?? [])
    .filter((part: any) => part?.type === "output_text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("");
}

/** Gemini 原生联网只有非 thought 文本块才是结构化确认的最终回答。 */
function geminiFinalText(payload: any): string {
  return (payload?.candidates?.[0]?.content?.parts ?? [])
    .map((part: any) => typeof part?.text === "string" && part.thought !== true ? part.text : "")
    .join("");
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

function citationCandidateFromAnnotation(
  annotation: any,
  sources: readonly ResearchCitationSourceIdentity[] | undefined,
): ResearchCitationCandidate | undefined {
  if (!sources?.length) return undefined;
  const url = safeHttpUrl(annotation?.url ?? annotation?.uri);
  const providerSourceId = typeof annotation?.provider_source_id === "string" ? annotation.provider_source_id : undefined;
  const source = sources.find((candidate) =>
    (url && safeHttpUrl(candidate.url) === url)
      || (providerSourceId && candidate.providerSourceId === providerSourceId),
  );
  if (!source) return undefined;
  const startOffset = annotation?.start_index ?? annotation?.startIndex;
  const endOffset = annotation?.end_index ?? annotation?.endIndex;
  const exact = Number.isSafeInteger(startOffset) && Number.isSafeInteger(endOffset) && startOffset >= 0 && endOffset > startOffset;
  return {
    sourceOrdinal: source.sourceOrdinal,
    ...(exact ? { startOffset, endOffset } : {}),
    ...(typeof annotation?.id === "string" ? { providerCitationId: annotation.id } : {}),
  };
}

/** 日志只保留净化后的 host，绝不输出带查询参数/凭证的原始 URL。 */
function safeLogHost(value: string): string {
  const normalized = safeHttpUrl(value);
  if (!normalized) return "invalid";
  try { return new URL(normalized).hostname; } catch { return "invalid"; }
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
  // 任意错误正文都可能由远端供应商控制并回显用户输入。运行记录只保存稳定类别，
  // 不尝试用关键词替换把不可信正文变成“可记录”文本。
  if (error instanceof ModelProviderHttpError) return `模型供应商请求失败（HTTP ${error.status}）`;
  if (error instanceof ModelProviderTimeoutError) return "模型供应商请求超时";
  if (error instanceof ModelProviderAbortedError) return "模型供应商请求已中止";
  return safeProviderErrorSummary(error);
}

function requestEnvelopeMessages(request: ModelProviderRequest): PromptEnvelope["messages"] {
  return request.envelope?.messages ?? [{ role: "user", content: request.prompt }];
}

export function mapPromptEnvelopeToOpenAiMessages(request: ModelProviderRequest): Array<Record<string, unknown>> {
  return requestEnvelopeMessages(request).map((message) => ({
    role: message.role,
    ...(message.content !== null ? { content: message.content } : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) } : {}),
  }));
}

export function mapPromptEnvelopeToGeminiRequest(request: ModelProviderRequest): { systemInstruction?: { parts: Array<{ text: string }> }; contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> } {
  const system = requestEnvelopeMessages(request).filter((message) => message.role === "system" && message.content).map((message) => message.content).join("\n\n");
  const contents = requestEnvelopeMessages(request).filter((message) => message.role !== "system").map((message) => ({
    role: message.role === "assistant" ? "model" as const : "user" as const,
    parts: [{ text: message.role === "tool" ? `[tool${message.toolCallId ? `:${message.toolCallId}` : ""}]\n${message.content ?? ""}` : (message.content ?? "") }],
  }));
  return { ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents };
}

export function mapPromptEnvelopeToAnthropicRequest(request: ModelProviderRequest): { system?: string; messages: Array<{ role: "user" | "assistant"; content: string }> } {
  const system = requestEnvelopeMessages(request).filter((message) => message.role === "system" && message.content).map((message) => message.content).join("\n\n");
  const messages = requestEnvelopeMessages(request).filter((message) => message.role !== "system").map((message) => ({
    role: message.role === "assistant" ? "assistant" as const : "user" as const,
    content: message.role === "tool" ? `[tool${message.toolCallId ? `:${message.toolCallId}` : ""}]\n${message.content ?? ""}` : (message.content ?? ""),
  }));
  return { ...(system ? { system } : {}), messages };
}

function modelCallErrorCategory(error: unknown): ModelCallEvent["errorCategory"] {
  if (error instanceof ModelBudgetReassemblyRequiredError || error instanceof ModelBudgetUnsatisfiableError) return "budget";
  if (error instanceof ModelProviderTimeoutError || error instanceof TypeError) return "network";
  if (error instanceof ModelProviderHttpError) return error.status === 401 || error.status === 403 ? "authentication" : "provider";
  if (error instanceof SyntaxError || error instanceof RangeError) return "validation";
  return "unknown";
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Provider base URL must be an absolute URL"); }
  if (url.protocol !== "https:") throw new Error("Provider base URL must use HTTPS");
  if (url.username || url.password) throw new Error("Provider base URL cannot contain credentials");
  if (url.search || url.hash) throw new Error("Provider base URL cannot contain query parameters or fragments");
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${pathname}`;
}

/**
 * 解析 SSE（Server-Sent Events）响应体为事件流，供四家真实供应商的流式 completeStream 复用。
 * 只处理信封（空行分事件、多 data: 行 \n 拼接、捕获 event: 字段、忽略 : 注释），不解释 payload；
 * data: [DONE] 这类终止哨兵由调用方判断。TextDecoder 流式缓冲保证跨块的多字节字符不被截断。
 */
/**
 * 空闲重置计时器：每次 reset() 重新计时，clear() 终止。
 * 用于流式空闲超时——长文持续到达 token 时不断重置，只在「超过 ms 无新事件」时触发，
 * 取代固定总超时，避免长文因总时长到点被掐断。onTimeout 由调用方决定（通常 abort）。
 */
export function createIdleTimer(ms: number, onTimeout: () => void): { reset(): void; clear(): void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    if (handle !== undefined) clearTimeout(handle);
    handle = setTimeout(onTimeout, ms);
    // 不阻止进程退出（测试/短生命周期进程）。
    if (typeof handle === "object" && handle && typeof (handle as { unref?: () => void }).unref === "function") (handle as { unref: () => void }).unref();
  };
  reset();
  return {
    reset,
    clear() {
      if (handle !== undefined) clearTimeout(handle);
      handle = undefined;
    },
  };
}

/**
 * 从可能包裹的 abort 错误中还原流式空闲超时：Node fetch 在 for await 途中 abort 时，
 * 常把 abort(reason) 的 reason 包成 AbortError.cause。若是空闲超时则原样抛出，否则抛原错误。
 */
function rethrowStreamError(error: unknown): never {
  if (error instanceof ModelProviderTimeoutError) throw error;
  const cause = (error as { cause?: unknown })?.cause;
  if (cause instanceof ModelProviderTimeoutError) throw cause;
  // 外部中止（暂停/停止）：AbortSignal.any 无 reason 中止表现为 AbortError，映射为致命类、不重试。
  if ((error as { name?: string })?.name === "AbortError") throw new ModelProviderAbortedError("provider stream aborted");
  throw error;
}

/** 组合外部中止信号与内部超时控制器：任一侧触发都中止 fetch；无外部信号时直接用内部控制器。 */
function combinedAbortSignal(external: AbortSignal | undefined, internal: AbortController): AbortSignal {
  return external ? AbortSignal.any([external, internal.signal]) : internal.signal;
}

export async function* iterateServerSentEvents(body: ReadableStream<Uint8Array>): AsyncIterable<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flushEvent = function* (rawEvent: string): Generator<{ event?: string; data: string }> {
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of rawEvent.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") dataLines.push(value);
    }
    if (dataLines.length) yield { event, data: dataLines.join("\n") };
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let sepIndex: number;
      // 事件以空行（\n\n 或 \r\n\r\n）分隔；逐段取出完整事件，残余留在缓冲。
      while ((sepIndex = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const rawEvent = buffer.slice(0, sepIndex);
        const sepMatch = buffer.slice(sepIndex).match(/^\r?\n\r?\n/);
        buffer = buffer.slice(sepIndex + (sepMatch?.[0].length ?? 2));
        yield* flushEvent(rawEvent);
      }
      if (done) break;
    }
    if (buffer.trim()) yield* flushEvent(buffer);
  } finally {
    reader.releaseLock();
  }
}

export function fingerprintBaseUrl(value: string): string {
  return createHash("sha256").update(normalizeBaseUrl(value).toLocaleLowerCase()).digest("hex");
}

/**
 * 取出 completeStream 事件的 delta 文本逐个产出；done 帧的 model/usage 写入调用方持有的 doneRef。
 * 纯函数模块级（非实例方法），doneRef 由调用方按调用局部持有，交错调用互不干扰。
 */
export async function* extractStreamDeltas(
  events: AsyncIterable<ModelProviderStreamEvent>,
  doneRef: { model: string; usage?: ProviderUsage; finishReason?: string },
): AsyncIterable<string> {
  for await (const event of events) {
    if (event.type === "delta") yield event.text;
    else if (event.type === "done") { doneRef.model = event.model; doneRef.usage = event.usage; doneRef.finishReason = event.finishReason; }
  }
}

/**
 * 把正文增量流整体 trim：抑制前导空白，暂存尾随空白串（仅在后续非空块到达时冲刷，流末丢弃）。
 * 保证 concat(输出) === concat(输入).trim()，是流式正文与非流式 writeResearchBody 偏移一致的关键不变量。
 * 内部空白（含段落间的 \n\n）原样保留。
 */
export async function* trimStream(chunks: AsyncIterable<string>): AsyncIterable<string> {
  let pendingWhitespace = "";
  let seenContent = false;
  for await (const chunk of chunks) {
    if (!chunk) continue;
    let text = chunk;
    if (!seenContent) {
      text = text.replace(/^\s+/, "");
      if (!text) continue; // 整块都是前导空白
      seenContent = true;
    }
    // 拆出本块尾随的空白串，连同之前暂存的一起挂起，等下一个非空块到达再冲刷。
    const trailingMatch = text.match(/\s+$/);
    const trailing = trailingMatch?.[0] ?? "";
    const core = trailing ? text.slice(0, text.length - trailing.length) : text;
    if (core) {
      const out = pendingWhitespace + core;
      pendingWhitespace = trailing;
      yield out;
    } else {
      // 整块都是尾随空白（例如段落分隔块），全部暂存。
      pendingWhitespace += trailing;
    }
  }
  // 流末丢弃暂存的尾随空白，等效于整体 .trim()。
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
  if (url.search || url.hash) throw new Error("Provider base URL cannot contain query parameters or fragments");
  const hostname = url.hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) throw new Error("Provider base URL must use a public host");
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookupImpl(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIpAddress(address))) throw new Error("Provider base URL resolved to a non-public address");
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
