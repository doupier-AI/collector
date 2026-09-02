export type ProviderApiMode = "openai_chat_completions" | "openai_responses" | "gemini_generate_content" | "anthropic_messages";
export type ProviderAuthMode = "bearer" | "api_key_header";
export type ProviderThinkingMode = "none" | "openai_compatible";
export type ProviderReasoningOutput = "none" | "openai_reasoning_content";
export type ProviderWebGrounding = "unsupported" | "openai_web_search" | "gemini_google_search" | "anthropic_web_search";

export interface ProviderCapabilities {
  structuredJson: boolean;
  /** 当前供应商适配器已验证、可与回答正文分离的 reasoning 输出通道。 */
  reasoningOutput: ProviderReasoningOutput;
  thinkingMode: ProviderThinkingMode;
  modelDiscovery: boolean;
  /** 当前供应商协议已验证的联网能力；自定义兼容端点必须显式保持 unsupported。 */
  webGrounding: ProviderWebGrounding;
}

export interface ProviderModelPricing {
  inputCacheHitPerMillion: number;
  inputCacheMissPerMillion: number;
  outputPerMillion: number;
}

export interface ProviderDefinition {
  id: string;
  label: string;
  apiMode: ProviderApiMode;
  authMode: ProviderAuthMode;
  defaultBaseUrl: string;
  defaultModel: string;
  models: string[];
  capabilities: ProviderCapabilities;
  pricing?: Record<string, ProviderModelPricing>;
}

export interface ProviderProfile {
  id: string;
  providerId: string;
  displayName: string;
  baseUrl: string;
  model: string;
  credentialConfigured: boolean;
  enabled: boolean;
  configurationVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderProfileInput {
  id?: string;
  providerId: string;
  displayName: string;
  baseUrl?: string;
  model: string;
  enabled?: boolean;
  /** 真实 API Key：仅创建/更新时提交。列表与详情读取响应不含 Key；只有专用凭证读取端点向已认证的本地客户端回传，用于设置页回填暗文显示。 */
  apiKey?: string;
}

/** 已保存凭证的读取视图：只由专用凭证端点返回给已认证的本地客户端，永不写入日志或其他响应。 */
export interface ProviderCredentialView {
  apiKey: string;
}

export interface ProviderProfileTestInput {
  providerId: string;
  model: string;
  baseUrl?: string;
  apiKey: string;
}

export type ProviderTestResult = { ok: true; model: string; durationMs?: number } | { ok: false; error: string };

/** Collector 对单个模型统一识别的能力。thinking 与 reasoningOutput 分开，避免把请求开关与独立响应通道混为一谈。 */
export const MODEL_CAPABILITY_NAMES = [
  "thinking",
  "reasoningOutput",
  "collectorWebSearch",
  "nativeWebSearch",
  "structuredOutput",
  "toolCalling",
  "visionInput",
  "streamingOutput",
] as const;
export type ModelCapabilityName = (typeof MODEL_CAPABILITY_NAMES)[number];
export type CapabilityStatus = "supported" | "unsupported" | "unknown" | "probing" | "probe_failed";
export type CapabilityEvidenceSource = "provider_metadata" | "collector_catalog" | "active_probe";

export interface ModelCapabilityEvidence {
  source: CapabilityEvidenceSource;
  /** 不含凭证、请求正文或供应商原始错误的稳定证据代码。 */
  code: string;
  observedAt?: string;
}

export interface ModelCapabilityAssessment {
  name: ModelCapabilityName;
  /** 供应商能力判断；unknown 绝不等价于 unsupported。 */
  status: CapabilityStatus;
  /** 供应商支持且 Collector 当前适配器已实现时才为 true。 */
  usable: boolean;
  protocol: ProviderApiMode | "none";
  evidence: ModelCapabilityEvidence[];
  reasonCode: string;
  /** 本次评估形成时间；目录与供应商声明同样记录评估时刻。 */
  checkedAt: string;
}

export type ModelCapabilityMatrix = Record<ModelCapabilityName, ModelCapabilityAssessment>;

export interface ModelCapabilitySnapshot {
  profileId: string;
  configurationVersion: number;
  modelId: string;
  assessments: ModelCapabilityMatrix;
  updatedAt: string;
}

export type ModelCapabilityProbeTaskStatus = "queued" | "running" | "completed" | "failed";
export interface ModelCapabilityProbeTask {
  id: string;
  profileId: string;
  configurationVersion: number;
  modelId: string;
  status: ModelCapabilityProbeTaskStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  errorCode?: string;
}

export interface ModelCapabilityStatusView {
  profileId: string;
  configurationVersion: number;
  modelId: string;
  task?: ModelCapabilityProbeTask;
  capabilities: ModelCapabilityMatrix;
}

/** 从供应商端点发现可调用模型列表的输入。apiKey 仅用于本次请求，响应永不回传。 */
export interface ProviderModelDiscoveryInput {
  providerId: string;
  baseUrl?: string;
  /** 省略且提供 profileId 时使用该配置已保存的凭证。 */
  apiKey?: string;
  profileId?: string;
}

export type ProviderModelListSource = "provider" | "unavailable";
export type ProviderModelDiscoveryResult =
  | {
      ok: true;
      /** 兼容既有客户端。供应商没有列表端点时为空数组，用户仍可手填模型。 */
      models: string[];
      modelCapabilities?: Record<string, ModelCapabilityMatrix>;
      listSource?: ProviderModelListSource;
      partial?: boolean;
      warning?: string;
    }
  | { ok: false; error: string; errorCode?: "authentication" | "rate_limited" | "timeout" | "provider" | "network" | "invalid_response" };

/** 可按任务类型分配模型的用途；未分配时跟随当前激活配置。 */
export const MODEL_PURPOSES = ["chat", "research", "search", "document", "extraction"] as const;
export type ModelPurpose = (typeof MODEL_PURPOSES)[number];

/** 每次模型调用都必须声明的装配用途；粗粒度用途同时作为模型路由的公开入口。 */
export const CONTEXT_PURPOSES = [
  "chat",
  "research",
  "search",
  "document",
  "extraction",
  "connection_test",
  "research_chat",
  "deep_research",
  "answer_planning",
  "research_grounding",
  "research_body",
  "citation_attribution",
  "research_body_outline",
  "research_body_section",
  "research_slice_annotation",
  "term_marker_extraction",
  "term_preview",
  "term_entity_verification",
  "session_titling",
  "node_naming",
  "import_chapter_parsing",
  "association_hint_evaluation",
  "similarity_verification",
  "temporary_fusion_discovery",
  "temporary_fusion_conversation",
  "temporary_fusion_draft_revalidation",
  "query_reformulation",
  "agent_search",
  "cluster_materials",
  "document_outline",
  "document_sections",
  "incremental_document_update",
] as const;
export type ContextPurpose = (typeof CONTEXT_PURPOSES)[number];

export const CONTEXT_CHANNELS = ["behavior_rule", "factual_evidence", "user_adaptation"] as const;
export type ContextChannel = (typeof CONTEXT_CHANNELS)[number];

export type ContextSourceKind =
  | "product_rule"
  | "task_rule"
  | "user_instruction"
  | "conversation"
  | "research_content"
  | "imported_material"
  | "web_source"
  | "tool_result"
  | "continuation"
  | "user_profile"
  | "long_term_memory"
  | "mastered_knowledge"
  | "system_probe";

/** 只保存稳定身份与作用域；候选正文不进入运行记录。 */
export interface ContextSourceIdentity {
  kind: ContextSourceKind;
  id: string;
  version?: string;
  scope: "turn" | "project" | "user" | "global" | "system";
  projectId?: string;
}

export interface ContextCandidatePermission {
  status: "required" | "eligible" | "denied";
  basis: "product_boundary" | "task_contract" | "user_choice" | "source_authorization";
  allowedPurposes?: readonly ContextPurpose[];
}

export type ContextSensitivity = "standard" | "private" | "sensitive" | "secret";
export type ContextCandidatePriority = "hard_boundary" | "task_required" | "turn" | "project" | "global" | "low_weight";
export type ContextCandidateProtection = "required" | "preferred" | "optional";

interface ContextCandidateBase {
  id: string;
  content: string;
  source: ContextSourceIdentity;
  permission: ContextCandidatePermission;
  sensitivity: ContextSensitivity;
  priority: ContextCandidatePriority;
  protection: ContextCandidateProtection;
  /** 同一语义槽的候选可以声明冲突键；事实冲突保留，规则与适应冲突按优先级裁决。 */
  conflictKey?: string;
}

export interface BehaviorRuleContextCandidate extends ContextCandidateBase {
  channel: "behavior_rule";
  ruleKind: "product_boundary" | "task_contract" | "safety" | "turn_instruction" | "project_instruction" | "global_instruction" | "answer_plan";
}

export interface FactualEvidenceContextCandidate extends ContextCandidateBase {
  channel: "factual_evidence";
  evidenceKind: "current_question" | "explicit_material" | "conversation_history" | "research_context" | "imported_material" | "web_evidence" | "tool_result" | "continuation_state";
  /** 只允许在同一上游内解释次序，不允许跨搜索、RAG 或工具横向比较。 */
  upstreamRank?: { source: "conversation" | "research" | "selection" | "web" | "rag" | "tool"; rank: number };
}

export interface UserAdaptationContextCandidate extends ContextCandidateBase {
  channel: "user_adaptation";
  adaptationKind: "user_profile" | "long_term_memory" | "mastered_knowledge";
}

export type ContextCandidate = BehaviorRuleContextCandidate | FactualEvidenceContextCandidate | UserAdaptationContextCandidate;

export interface ContextBudget {
  maxInputTokens: number;
  reservedOutputTokens: number;
  channelLimits?: Partial<Record<ContextChannel, number>>;
}

export const CONVERSATION_CONTEXT_SCHEMA_VERSION = 1 as const;
export const CONVERSATION_CONTEXT_RESOLVER_VERSION = "conversation-context-resolver-v1" as const;

export type ConversationContextAuthority = "current_user" | "user_source" | "assistant_body" | "derived_summary";
export type ConversationContextSemanticCategory = "current_request" | "explicit_constraint" | "user_turn" | "assistant_body" | "summary_statement";
export type ConversationContextSelectionReason =
  | "current_request"
  | "explicit_correction"
  | "active_constraint"
  | "reference_candidate"
  | "relevant_history"
  | "recent_user_fallback"
  | "summary_recall"
  | "not_relevant"
  | "budget_exhausted"
  | "incomplete_assistant";

export interface ConversationContextMessageRange {
  startMessageId: string;
  endMessageId: string;
  startIndex: number;
  endIndex: number;
}

export interface ConversationContextMessageReference {
  messageId: string;
  nodeId: string;
  messageVersionId: string;
  bodyVersionId?: string;
  originalRole: "user" | "assistant";
  sourceMessageRange: ConversationContextMessageRange;
}

export interface ConversationContextItem {
  id: string;
  content: string;
  source: ConversationContextMessageReference;
  semanticCategory: ConversationContextSemanticCategory;
  authority: ConversationContextAuthority;
  selection: "selected" | "omitted";
  selectionReason: ConversationContextSelectionReason;
  estimatedTokens: number;
}

export interface ConversationContextSummaryStatement {
  content: string;
  source: ConversationContextMessageReference;
  semanticCategory: "summary_statement";
  authority: "derived_summary";
}

export interface ConversationContextSummary {
  id: string;
  summaryVersion: string;
  resolutionStatus: "deterministic" | "degraded";
  sourceMessageRange: ConversationContextMessageRange;
  selection: "selected" | "omitted";
  selectionReason: "summary_recall" | "not_relevant" | "budget_exhausted";
  statements: readonly ConversationContextSummaryStatement[];
  estimatedTokens: number;
}

export type ConversationContextRelationKind =
  | "ordinal_reference"
  | "pronoun_reference"
  | "user_intent_correction"
  | "external_fact_conflict"
  | "constraint_carryover"
  | "constraint_replacement"
  | "instruction_retraction"
  | "assistant_conclusion_rejected";

export interface ConversationContextRelationCandidate {
  source: ConversationContextMessageReference;
  excerpt: string;
}

export interface ConversationContextRelation {
  id: string;
  kind: ConversationContextRelationKind;
  status: "resolved" | "ambiguous" | "unresolved";
  expression: string;
  candidates: readonly ConversationContextRelationCandidate[];
  resolvedMessageId?: string;
  fromValue?: string;
  toValue?: string;
}

/**
 * Versioned conversation-only semantic snapshot. It records resolver selection separately from
 * ContextAssembly admission; parent-chain, RAG, web evidence and user adaptation never enter it.
 */
export interface ConversationContext {
  schemaVersion: typeof CONVERSATION_CONTEXT_SCHEMA_VERSION;
  contextId: string;
  resolverVersion: string;
  buildFingerprint: string;
  taskId: string;
  generationAttempt: number;
  inputMessageId: string;
  outputMessageId?: string;
  nodeId: string;
  sourceFingerprint: string;
  resolution: {
    status: "resolved" | "degraded";
    mode: "deterministic";
    reason?: "invalid_history" | "invalid_budget" | "budget_exhausted" | "internal_error";
  };
  budget: {
    maxInputTokens: number;
    usedInputTokens: number;
    remainingInputTokens: number;
  };
  items: readonly ConversationContextItem[];
  summaries: readonly ConversationContextSummary[];
  relations: readonly ConversationContextRelation[];
}

export const ANSWER_PLAN_SCHEMA_VERSION = 2 as const;
export const ANSWER_PLANNER_VERSION = "answer-planner-v1" as const;

export const ANSWER_TASK_FAMILIES = [
  "explanation",
  "comparison",
  "decision",
  "planning",
  "diagnosis",
  "factual_query",
  "research_synthesis",
  "summarization",
  "rewriting",
  "mixed",
  "direct_response",
] as const;
export type AnswerTaskFamily = (typeof ANSWER_TASK_FAMILIES)[number];

export const ANSWER_PLAN_OPERATIONS = [
  "answer_directly",
  "explain",
  "compare",
  "recommend",
  "plan_steps",
  "diagnose",
  "propose_actions",
  "verify_facts",
  "synthesize",
  "summarize",
  "rewrite",
  "state_assumptions",
  "request_clarification",
] as const;
export type AnswerPlanOperation = (typeof ANSWER_PLAN_OPERATIONS)[number];

export interface AnswerPlanConstraint {
  kind: "format" | "length" | "language" | "tone" | "scope" | "intent" | "other";
  value: string;
  source: "current_turn" | "conversation_context" | "explicit_setting";
  sourceMessageId?: string;
}

export interface AnswerPlanAssumption {
  statement: string;
  risk: "low" | "material";
  source: "planner" | "conversation_context";
}

export interface AnswerEvidencePolicy {
  mode: "none" | "available_context" | "provided_only" | "web_if_authorized" | "clarify_authorization";
  requiresCurrentFacts: boolean;
  access: "not_required" | "authorized" | "not_authorized" | "unavailable";
  conflictHandling: "preserve_for_evidence_chain";
}

export interface AnswerUncertaintyHandling {
  action: "proceed" | "proceed_with_disclosed_assumptions" | "preserve_ambiguity" | "request_clarification" | "state_limitations";
  reasons: readonly string[];
}

export interface AnswerPlanMachineCheck {
  id: string;
  kind: "non_empty" | "format" | "min_length" | "max_length" | "required_heading" | "forbidden_string" | "truncation" | "body_version" | "citation_range";
  expected?: string;
  source: "product" | "explicit_constraint" | "plan";
}

export interface AnswerCompletionContract {
  machineChecks: readonly AnswerPlanMachineCheck[];
  semanticCriteria: readonly string[];
}

export const ANSWER_PRESENTATION_BLOCKS = [
  "heading",
  "bullet_list",
  "numbered_list",
  "table",
  "code",
  "blockquote",
  "math",
  "mermaid",
] as const;
export type AnswerPresentationBlock = (typeof ANSWER_PRESENTATION_BLOCKS)[number];

export interface AnswerPresentationPlan {
  mode: "compact" | "structured";
  preferredBlocks: readonly AnswerPresentationBlock[];
}

/**
 * Versioned, cross-domain writing plan. It is derived behaviour context only: it never owns facts,
 * identity, authorization or safety decisions and it is not a user-visible body or evaluation rubric.
 */
export interface AnswerPlan {
  schemaVersion: typeof ANSWER_PLAN_SCHEMA_VERSION;
  planId: string;
  plannerVersion: string;
  buildFingerprint: string;
  taskId: string;
  generationAttempt: number;
  inputMessageId: string;
  outputMessageId?: string;
  conversationContextId: string;
  planning: {
    mode: "deterministic" | "model_assisted" | "fallback";
    modelCall: "not_needed" | "completed" | "unavailable" | "failed";
    reason?: "simple_clear_task" | "complex_task" | "material_ambiguity" | "model_unavailable" | "invalid_model_output" | "internal_error";
  };
  taskFamily: AnswerTaskFamily;
  userGoal: string;
  audience: { description: string; source: "explicit" | "unspecified" };
  explicitConstraints: readonly AnswerPlanConstraint[];
  requiredOperations: readonly AnswerPlanOperation[];
  assumptions: readonly AnswerPlanAssumption[];
  evidencePolicy: AnswerEvidencePolicy;
  uncertaintyHandling: AnswerUncertaintyHandling;
  /** Derived expression guidance only. Explicit user formatting remains authoritative. */
  presentation: AnswerPresentationPlan;
  completionContract: AnswerCompletionContract;
}

export const EVIDENCE_BUNDLE_SCHEMA_VERSION = "evidence-bundle-v1" as const;
export const EVIDENCE_POLICY_VERSION = "evidence-policy-v1" as const;

/** Policy coverage is deliberately narrower than truth, use, attribution, or grounded state. */
export type EvidencePolicyStatus = "not_satisfied" | "partially_satisfied" | "policy_satisfied" | "conflicting";
export type EvidencePreparationStopReason = "not_required" | "policy_satisfied" | "budget_exhausted" | "no_more_candidates" | "provider_failed";
export type EvidenceContentAvailability = "full" | "partial" | "none";
export type EvidenceAuthorityClass = "authoritative" | "primary" | "secondary" | "unknown";
export type EvidenceFreshness = "current" | "stale" | "unknown";

export interface EvidenceDecisionProvenance {
  producer: "evidence-preparation";
  producerVersion: string;
  policyVersion: typeof EVIDENCE_POLICY_VERSION;
  inputSourceIds: readonly string[];
  outcome: string;
  reason: string;
  proposalProducer?: string;
  proposalVersion?: string;
}

export interface EvidenceNeedLedgerEntry {
  id: string;
  description: string;
  required: boolean;
  searched: boolean;
  candidateSourceIds: readonly string[];
  qualifiedEvidenceIds: readonly string[];
  policyStatus: EvidencePolicyStatus;
  stopReason: EvidencePreparationStopReason;
  decision: EvidenceDecisionProvenance;
}

export interface PreparedEvidenceItem {
  id: string;
  title: string;
  canonicalUrl: string;
  finalUrl: string;
  contentDigest?: string;
  excerpt: string;
  availability: EvidenceContentAvailability;
  authorityClass: EvidenceAuthorityClass;
  freshness: EvidenceFreshness;
  publishedAt?: string;
  coveredNeedIds: readonly string[];
  tokenCost: number;
  decisions: {
    relevance: EvidenceDecisionProvenance;
    authority: EvidenceDecisionProvenance;
    freshness: EvidenceDecisionProvenance;
    coverage: EvidenceDecisionProvenance;
    conflict: EvidenceDecisionProvenance;
    qualification: EvidenceDecisionProvenance;
    packing: EvidenceDecisionProvenance;
  };
  conflictKey?: string;
  conflictStance?: string;
}

/**
 * Versioned evidence-policy result. It intentionally has no grounded boolean or status: policy
 * coverage cannot prove factual correctness, writer use, attribution, or the final body.
 */
export interface EvidenceBundle {
  schemaVersion: typeof EVIDENCE_BUNDLE_SCHEMA_VERSION;
  bundleId: string;
  taskId: string;
  answerPlanId: string;
  policyVersion: typeof EVIDENCE_POLICY_VERSION;
  preparedAt: string;
  evidencePolicyStatus: EvidencePolicyStatus;
  stopReason: EvidencePreparationStopReason;
  queries: readonly string[];
  needs: readonly EvidenceNeedLedgerEntry[];
  evidence: readonly PreparedEvidenceItem[];
  packedEvidenceIds: readonly string[];
  budget: {
    maxQueries: number;
    maxCandidates: number;
    maxFetches: number;
    maxPackedTokens: number;
    usedQueries: number;
    consideredCandidates: number;
    usedFetches: number;
    packedTokens: number;
  };
}

export function validateEvidenceBundle(bundle: EvidenceBundle): void {
  if (bundle.schemaVersion !== EVIDENCE_BUNDLE_SCHEMA_VERSION || bundle.policyVersion !== EVIDENCE_POLICY_VERSION) {
    throw new Error("Evidence bundle version is unsupported");
  }
  if (!bundle.bundleId || !bundle.taskId || !bundle.answerPlanId) throw new Error("Evidence bundle identity is required");
  if (Object.hasOwn(bundle, "grounded")) throw new Error("Evidence bundle must not own grounded state");
  const statuses = new Set<EvidencePolicyStatus>(["not_satisfied", "partially_satisfied", "policy_satisfied", "conflicting"]);
  const stops = new Set<EvidencePreparationStopReason>(["not_required", "policy_satisfied", "budget_exhausted", "no_more_candidates", "provider_failed"]);
  if (!statuses.has(bundle.evidencePolicyStatus) || !stops.has(bundle.stopReason)) throw new Error("Evidence bundle policy state is invalid");
  if (bundle.stopReason === "policy_satisfied" && bundle.evidencePolicyStatus !== "policy_satisfied") {
    throw new Error("Evidence bundle policy_satisfied stop requires policy_satisfied coverage");
  }
  const needIds = new Set(bundle.needs.map((need) => need.id));
  if (needIds.size !== bundle.needs.length) throw new Error("Evidence bundle need identities must be unique");
  const evidenceIds = new Set(bundle.evidence.map((item) => item.id));
  if (evidenceIds.size !== bundle.evidence.length) throw new Error("Evidence bundle item identities must be unique");
  if (bundle.packedEvidenceIds.length !== bundle.evidence.length
    || bundle.packedEvidenceIds.some((id, index) => id !== bundle.evidence[index]?.id)) {
    throw new Error("Evidence bundle packed identities must match its ordered evidence items");
  }
  for (const need of bundle.needs) {
    if (!statuses.has(need.policyStatus) || !stops.has(need.stopReason)) throw new Error("Evidence need policy state is invalid");
    if (need.qualifiedEvidenceIds.some((id) => !evidenceIds.has(id))) throw new Error("Evidence need references an unpacked item");
  }
  for (const item of bundle.evidence) {
    if (item.coveredNeedIds.some((id) => !needIds.has(id))) throw new Error("Prepared evidence references an unknown need");
    if (!item.finalUrl || !item.canonicalUrl || !item.title || !item.excerpt) throw new Error("Prepared evidence identity and content are required");
    if (!Number.isSafeInteger(item.tokenCost) || item.tokenCost < 1) throw new Error("Prepared evidence token cost must be positive");
  }
  const budgetValues = Object.values(bundle.budget);
  if (budgetValues.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error("Evidence preparation budget must be non-negative integers");
  if (bundle.budget.usedQueries > bundle.budget.maxQueries || bundle.budget.consideredCandidates > bundle.budget.maxCandidates
    || bundle.budget.usedFetches > bundle.budget.maxFetches || bundle.budget.packedTokens > bundle.budget.maxPackedTokens) {
    throw new Error("Evidence preparation usage exceeds its resource budget");
  }
}

export const PROMPT_ENVELOPE_VERSION = "prompt-envelope-v1" as const;

export type PromptEnvelopeRole = "system" | "user" | "assistant" | "tool";
export type PromptEnvelopeOutputFormat = "text" | "json_object" | "tool_calls";

export interface PromptEnvelopeMessage {
  role: PromptEnvelopeRole;
  content: string | null;
  toolCallId?: string;
  toolCalls?: ReadonlyArray<{
    id: string;
    name: string;
    arguments: string;
  }>;
}

export interface PromptEnvelopeOutputContract {
  format: PromptEnvelopeOutputFormat;
  contractVersion: string;
  /** The minimum visible-body space required for a useful result. */
  minimumBodyTokens: number;
}

/**
 * Provider-independent physical-call input. Rules, user material, assistant history and tool
 * results retain their roles until the concrete provider Adapter maps them to its wire format.
 */
export interface PromptEnvelope {
  version: typeof PROMPT_ENVELOPE_VERSION;
  purpose: string;
  promptVersion: string;
  messages: readonly PromptEnvelopeMessage[];
  outputContract: PromptEnvelopeOutputContract;
}

/** Run-record projection: roles and sizing only; never message or tool content. */
export interface PromptEnvelopeObservation {
  version: typeof PROMPT_ENVELOPE_VERSION;
  purpose: string;
  promptVersion: string;
  messageCount: number;
  roleCounts: Partial<Record<PromptEnvelopeRole, number>>;
  estimatedInputTokens: number;
  outputContract: PromptEnvelopeOutputContract;
}

export interface RequestedModelBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  minimumBodyTokens: number;
  thinking: boolean;
}

export interface ModelBudgetLimits {
  contextWindowTokens: number;
  maxOutputTokens: number;
  reasoningBudgetMode: "none" | "shared_output" | "separate";
}

export interface ResolvedModelBudget {
  status: "resolved";
  budgetResolutionAttemptId: string;
  previousBudgetResolutionAttemptId?: string;
  estimatedInputTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  minimumBodyTokens: number;
  thinking: boolean;
  reasoningBudgetMode: ModelBudgetLimits["reasoningBudgetMode"];
}

export interface ModelBudgetReassemblyRequired {
  status: "reassembly_required";
  budgetResolutionAttemptId: string;
  previousBudgetResolutionAttemptId?: string;
  estimatedInputTokens: number;
  maximumInputTokens: number;
  minimumBodyTokens: number;
  reason: "context_window_requires_smaller_input";
}

export interface UnsatisfiableModelBudget {
  status: "unsatisfiable";
  budgetResolutionAttemptId: string;
  previousBudgetResolutionAttemptId?: string;
  estimatedInputTokens: number;
  minimumBodyTokens: number;
  reason: "provider_output_limit_below_minimum" | "context_window_below_minimum";
}

export type ModelBudgetResolution = ResolvedModelBudget | ModelBudgetReassemblyRequired | UnsatisfiableModelBudget;

/** Exact physical parameters after provider-independent resolution and before Adapter mapping. */
export interface AppliedModelBudget {
  maxOutputTokens: number;
  thinking: boolean;
}

export interface ContextAssemblyRequest {
  /** 运行时保持 string，确保未知用途经过默认拒绝而不是绕过注册表。 */
  purpose: string;
  workflowRunId?: string;
  workflowStepId?: string;
  assemblyAttemptId?: string;
  previousAssemblyAttemptId?: string;
  projectId?: string;
  budget?: ContextBudget;
  candidates: readonly ContextCandidate[];
}

export type ContextAdoptionReason = "required" | "explicit_selection" | "within_scope" | "ranked_for_task" | "supports_continuation" | "user_adaptation_enabled" | "conflict_preserved";
export type ContextRejectionReason =
  | "unknown_purpose"
  | "channel_not_allowed"
  | "purpose_not_allowed"
  | "permission_denied"
  | "scope_mismatch"
  | "source_revoked"
  | "secret"
  | "sensitivity_not_allowed"
  | "duplicate"
  | "conflict"
  | "budget_exhausted"
  | "lower_priority"
  | "invalid_candidate";

export interface ContextRedaction {
  field: string;
  reason: "credential" | "secret" | "sensitive_value" | "personal_data";
}

export interface ContextAdoptedCandidate {
  candidate: ContextCandidate;
  reason: ContextAdoptionReason;
  estimatedTokens: number;
  redactions: readonly ContextRedaction[];
}

export interface ContextRejectedCandidate {
  candidateId: string;
  channel: ContextChannel;
  category: string;
  source: ContextSourceIdentity;
  reason: ContextRejectionReason;
}

export interface ContextBudgetUsage extends ContextBudget {
  usedInputTokens: number;
  remainingInputTokens: number;
}

export type ContextAssemblyResult =
  | {
    status: "assembled";
    assemblyAttemptId: string;
    previousAssemblyAttemptId?: string;
    purpose: ContextPurpose;
    modelPurpose: ModelPurpose;
    budget: ContextBudgetUsage;
    adopted: readonly ContextAdoptedCandidate[];
    rejected: readonly ContextRejectedCandidate[];
  }
  | {
    status: "rejected";
    assemblyAttemptId: string;
    previousAssemblyAttemptId?: string;
    purpose: string;
    reason: "unknown_purpose" | "required_candidate_exceeds_budget";
    modelPurpose?: ModelPurpose;
    budget?: ContextBudgetUsage;
    adopted: readonly [];
    rejected: readonly ContextRejectedCandidate[];
  };

export interface ContextAssemblyAuditAdoption {
  candidateId: string;
  channel: ContextChannel;
  category: string;
  sourceKind: ContextSourceKind;
  sourceId: string;
  sourceVersion?: string;
  reason: ContextAdoptionReason;
  estimatedTokens: number;
  redactionReasons: readonly ContextRedaction["reason"][];
}

export interface ContextAssemblyAuditRejection {
  candidateId: string;
  channel: ContextChannel;
  category: string;
  sourceKind: ContextSourceKind;
  sourceId: string;
  sourceVersion?: string;
  reason: ContextRejectionReason;
}

/** 可进入运行记录的无正文视图。 */
export interface ContextAssemblyAudit {
  status: ContextAssemblyResult["status"];
  /** Missing only on persisted records created before prompt-envelope-v1. */
  assemblyAttemptId?: string;
  previousAssemblyAttemptId?: string;
  purpose: string;
  modelPurpose?: ModelPurpose;
  budget?: ContextBudgetUsage;
  adopted: readonly ContextAssemblyAuditAdoption[];
  rejected: readonly ContextAssemblyAuditRejection[];
}

export interface ContextAssemblyCategoryCount {
  channel: ContextChannel;
  category?: string;
  sourceKind: ContextSourceKind;
  count: number;
}

export interface ContextAssemblyRejectionCount extends ContextAssemblyCategoryCount {
  reason: ContextRejectionReason;
}

/** Run-record projection: counts and categories only; never candidate IDs, source IDs or content. */
export interface ContextAssemblyObservation {
  status: ContextAssemblyResult["status"];
  /** Missing only on persisted records created before prompt-envelope-v1. */
  assemblyAttemptId?: string;
  previousAssemblyAttemptId?: string;
  purpose: string;
  modelPurpose?: ModelPurpose;
  budget?: ContextBudgetUsage;
  adoptedCount: number;
  rejectedCount: number;
  adoptedCategories: readonly ContextAssemblyCategoryCount[];
  rejectedCategories: readonly ContextAssemblyRejectionCount[];
}

export type ContextExplanationCode =
  | "imported_material_used"
  | "history_used"
  | "personalization_used"
  | "personalization_not_used"
  | "context_reduced"
  | "retrieval_degraded";

export function contextCandidateCategory(candidate: ContextCandidate): string {
  return candidate.channel === "factual_evidence"
    ? candidate.evidenceKind
    : candidate.channel === "behavior_rule"
      ? candidate.ruleKind
      : candidate.adaptationKind;
}

function countContextCategories(entries: ReadonlyArray<{ channel: ContextChannel; category?: string; sourceKind: ContextSourceKind }>): ContextAssemblyCategoryCount[] {
  const counts = new Map<string, ContextAssemblyCategoryCount>();
  for (const entry of entries) {
    const key = `${entry.channel}\u0000${entry.category ?? ""}\u0000${entry.sourceKind}`;
    const current = counts.get(key);
    if (current) current.count += 1;
    else counts.set(key, { ...entry, count: 1 });
  }
  return [...counts.values()].sort((left, right) => left.channel.localeCompare(right.channel)
    || (left.category ?? "").localeCompare(right.category ?? "")
    || left.sourceKind.localeCompare(right.sourceKind));
}

export function observeContextAssembly(input: ContextAssemblyResult | ContextAssemblyAudit): ContextAssemblyObservation {
  const adopted = input.adopted.map((item) => "candidate" in item
    ? { channel: item.candidate.channel, category: contextCandidateCategory(item.candidate), sourceKind: item.candidate.source.kind }
    : { channel: item.channel, category: item.category, sourceKind: item.sourceKind });
  const rejected = input.rejected.map((item) => ({
    channel: item.channel,
    category: item.category,
    sourceKind: "source" in item ? item.source.kind : item.sourceKind,
    reason: item.reason,
  }));
  const rejectedCounts = new Map<string, ContextAssemblyRejectionCount>();
  for (const entry of rejected) {
    const key = `${entry.channel}\u0000${entry.category}\u0000${entry.sourceKind}\u0000${entry.reason}`;
    const current = rejectedCounts.get(key);
    if (current) current.count += 1;
    else rejectedCounts.set(key, { ...entry, count: 1 });
  }
  return {
    status: input.status,
    assemblyAttemptId: input.assemblyAttemptId,
    ...(input.previousAssemblyAttemptId ? { previousAssemblyAttemptId: input.previousAssemblyAttemptId } : {}),
    purpose: input.purpose,
    ...(input.modelPurpose ? { modelPurpose: input.modelPurpose } : {}),
    ...(input.budget ? { budget: { ...input.budget, ...(input.budget.channelLimits ? { channelLimits: { ...input.budget.channelLimits } } : {}) } } : {}),
    adoptedCount: input.adopted.length,
    rejectedCount: input.rejected.length,
    adoptedCategories: countContextCategories(adopted),
    rejectedCategories: [...rejectedCounts.values()].sort((left, right) => left.channel.localeCompare(right.channel)
      || left.reason.localeCompare(right.reason)
      || left.sourceKind.localeCompare(right.sourceKind)),
  };
}

export function contextExplanationCodes(observations: readonly ContextAssemblyObservation[], retrievalDegraded = false): ContextExplanationCode[] {
  const adopted = observations.flatMap((item) => item.adoptedCategories);
  const rejected = observations.flatMap((item) => item.rejectedCategories);
  const codes: ContextExplanationCode[] = [];
  if (adopted.some((item) => item.sourceKind === "imported_material" || item.category === "imported_material")) codes.push("imported_material_used");
  if (adopted.some((item) => item.category === "conversation_history")) codes.push("history_used");
  if (adopted.some((item) => item.channel === "user_adaptation")) codes.push("personalization_used");
  else if (rejected.some((item) => item.channel === "user_adaptation")) codes.push("personalization_not_used");
  if (rejected.some((item) => item.reason === "budget_exhausted") || observations.some((item) => item.status === "rejected")) codes.push("context_reduced");
  if (retrievalDegraded) codes.push("retrieval_degraded");
  return codes;
}

/** 主研究任务保存的无正文上下文来源快照；正文始终从消息、选区与正文版本事实源重建。 */
export interface ResearchContextSourceSnapshot {
  candidateId: string;
  channel: ContextChannel;
  sourceKind: ContextSourceKind;
  sourceId: string;
  sourceVersion?: string;
}

/**
 * 暂停/恢复的上下文稳定边界。同一 generationAttempt 必须解析到完全相同的基础来源；
 * 新生成尝试允许按现行来源重装配。续写正文是该基础快照之外唯一允许增量重装配的状态。
 */
export interface ResearchContextAssemblySnapshot {
  schemaVersion: 1;
  generationAttempt: number;
  reassemblyRule: "same_attempt_same_sources;new_attempt_reassemble;continuation_incremental";
  sourceFingerprint: string;
  sources: readonly ResearchContextSourceSnapshot[];
  /** 每次装配尝试的无正文准入审计；重装配追加记录，不覆盖首次尝试。 */
  assemblies: ReadonlyArray<{
    workflowStepId: string;
    recordedAt: string;
    audit: ContextAssemblyAudit;
  }>;
}

export interface ContextPurposePolicy {
  purpose: ContextPurpose;
  modelPurpose: ModelPurpose;
  allowedChannels: readonly ContextChannel[];
  maximumSensitivity: Exclude<ContextSensitivity, "secret">;
  defaultBudget: ContextBudget;
}

export type ContextPurposeResolution =
  | { allowed: true; policy: ContextPurposePolicy }
  | { allowed: false; purpose: string; reason: "unknown_purpose" };

export interface ModelPurposeRoute {
  purpose: ModelPurpose;
  profileId: string;
}

export interface ModelRoutingView {
  routes: ModelPurposeRoute[];
}

export interface ActiveModelRoute {
  providerProfileId: string;
  providerId: string;
  apiMode: ProviderApiMode;
  baseUrlFingerprint: string;
  model: string;
  configurationVersion: number;
}

export const LEGACY_DEEPSEEK_PROFILE_ID = "provider-deepseek-default";

export interface BrowserLocator {
  kind: "browser";
  pageUrl: string;
  startPath?: string;
  endPath?: string;
  startOffset?: number;
  endOffset?: number;
}

export interface UserSuppliedLocator {
  kind: "user_supplied";
  sourceLabel?: string;
}

export interface FileLocator {
  kind: "file";
  fileName: string;
  mimeType: string;
  checksum: string;
  pageNumber?: number;
  startLine?: number;
  endLine?: number;
  heading?: string;
  blockType?: "heading" | "paragraph" | "list" | "code";
}

export interface TextLocator {
  kind: "text";
  startLine: number;
  endLine: number;
  heading?: string;
  blockType?: "heading" | "paragraph" | "list" | "code";
}

export type CaptureLocator = BrowserLocator | UserSuppliedLocator | FileLocator | TextLocator;

export interface ArtifactRecord {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  checksum: string;
  objectPath: string;
  status: "stored" | "needs_processing";
  createdAt: string;
}

export interface ModelCallRecord {
  id: string;
  workflowRunId?: string;
  workflowStepId?: string;
  answerPlanId?: string;
  provider: string;
  model: string;
  purpose: string;
  promptVersion: string;
  envelope?: PromptEnvelopeObservation;
  availability?: { status: "available" | "unavailable"; reason?: string };
  requestedBudget?: RequestedModelBudget;
  resolvedBudget?: ResolvedModelBudget;
  appliedBudget?: AppliedModelBudget;
  /** F1 等切片感知调用记录实际送入核验的本地切片，不保存提示词正文。 */
  sourceSliceIds?: string[];
  /** #39 起片段感知调用同时记录语义片段 ID；与 sourceSliceIds 同为本地引用。 */
  sourceFragmentIds?: string[];
  /** 调用时固定的输出令牌预算；缺省表示旧记录未提供此审计字段。 */
  tokenBudget?: number;
  contextAssembly?: ContextAssemblyObservation;
  finishReason?: string;
  completionDiagnostic?: "length" | "empty_body" | "task_mismatch_truncation";
  toolCallCount?: number;
  errorCategory?: "authentication" | "network" | "validation" | "provider" | "budget" | "unknown";
  buildFingerprint?: string;
  status: "completed" | "failed";
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  estimatedCostUsd: number;
  costStatus?: "estimated" | "unknown";
  latencyMs: number;
  retryCount: number;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
}

// ── Local run records (issue #19) ────────────────────────────────

export type RunRecordSource = "research" | "import" | "fusion" | "chapter";
export type RunRecordOperationType = "research" | "document_import" | "similarity_verification" | "chapter_parse";
export type RunRecordStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "corrupt";
export type RunRecordOutcome = "success" | "failure" | "active" | "cancelled" | "unavailable";
export type RunRecordErrorCategory = "authentication" | "network" | "validation" | "provider" | "search" | "storage" | "unknown";

export interface RunRecordSummary {
  id: string;
  source: RunRecordSource;
  operationType: RunRecordOperationType;
  title?: string;
  status: RunRecordStatus;
  outcome: RunRecordOutcome;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  modelCallCount: number;
  searchCount: number;
  retryCount: number;
}

export interface RunRecordModelCallView {
  id: string;
  provider: string;
  model: string;
  purpose: string;
  promptVersion: string;
  answerPlanId?: string;
  envelope?: PromptEnvelopeObservation;
  availability?: { status: "available" | "unavailable"; reason?: string };
  requestedBudget?: RequestedModelBudget;
  resolvedBudget?: ResolvedModelBudget;
  appliedBudget?: AppliedModelBudget;
  sourceSliceIds?: string[];
  tokenBudget?: number;
  contextAssembly?: ContextAssemblyObservation;
  finishReason?: string;
  completionDiagnostic?: ModelCallRecord["completionDiagnostic"];
  toolCallCount?: number;
  errorCategory?: ModelCallRecord["errorCategory"];
  buildFingerprint?: string;
  status: "completed" | "failed" | "corrupt";
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  estimatedCostUsd?: number;
  costStatus?: "estimated" | "unknown";
  latencyMs: number;
  retryCount: number;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
}

/**
 * Sanitized attribution trace exposed by local Run Records. Exact claim and
 * evidence text remain in the canonical grounding record and are deliberately
 * omitted here so an observability export cannot duplicate research content.
 */
export interface RunRecordCitationAttributionView {
  schemaVersion: string;
  id: string;
  messageId: string;
  groundingRunId: string;
  bodyVersionId: string;
  generationAttempt: number;
  status: string;
  acceptancePolicyVersion: string;
  invalidProposalCount: number;
  producerCalls: Array<{
    batchId: string;
    mode: string;
    provider?: string;
    model?: string;
    producerVersion: string;
    status: string;
    errorCode?: string;
  }>;
  attributions: Array<{
    id: string;
    candidateId: string;
    status: string;
    rejectionReasons: string[];
    candidateProducer: { kind: string; provider: string; model: string; version: string };
    evidenceIdentity: {
      sourceId?: string;
      sourceOrdinal: number;
      providerSourceId?: string;
      preparedEvidenceId?: string;
      sourceVersion?: string;
    };
    claimRange?: { startOffset: number; endOffset: number };
    evidenceRange?: { startOffset: number; endOffset: number };
    supportCandidate?: {
      support: boolean;
      confidence: number;
      producer: { kind: string; provider: string; model: string; version: string };
    };
    providerCitationId?: string;
    createdAt: string;
  }>;
  createdAt: string;
  completedAt: string;
}

export interface RunRecordSearchView {
  id: string;
  provider: string;
  model: string;
  scenario: string;
  status: string;
  attempt: number;
  queries: string[];
  sourceCount: number;
  citationCount: number;
  responseSummary?: Record<string, unknown>;
  /** #49：搜索/抓取各阶段失败留痕（脱敏）。 */
  trace?: ResearchGroundingTraceEntry[];
  /** #207：accepted/rejected 归因决策的脱敏投影；不重复正文或证据原文。 */
  citationAttribution?: RunRecordCitationAttributionView;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
  sources: Array<{ title: string; url?: string; snippet?: string; evidenceStatus?: GroundingEvidenceStatus }>;
}

export interface RunRecordErrorView {
  source: "task" | "model" | "search" | "record";
  category: RunRecordErrorCategory;
  message: string;
}

export interface RunRecordTaskView {
  id: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  promptVersion?: string;
  /** E2：已完成研究任务实际持久化的正式切片数量。 */
  sliceCount?: number;
  retryable?: boolean;
  contextExplanations?: ContextExplanationCode[];
}

export interface RunRecordDetail extends RunRecordSummary {
  task?: RunRecordTaskView;
  modelCalls: RunRecordModelCallView[];
  searches: RunRecordSearchView[];
  errors: RunRecordErrorView[];
  contextExplanations?: ContextExplanationCode[];
}

export interface RunRecordPage {
  items: RunRecordSummary[];
  nextCursor?: string;
}

/** 本地运行记录导出的筛选条件；导出只覆盖当前筛选结果，不隐式读取全量业务数据。 */
export interface RunRecordExportFilters {
  from?: string;
  to?: string;
  operationType?: RunRecordOperationType;
  outcome?: RunRecordOutcome;
  status?: RunRecordStatus;
}

/** NDJSON 导出格式版本；头尾行使大文件中断时可以识别是否完整。 */
export const RUN_RECORD_EXPORT_FORMAT_VERSION = "collector.run-records.v1" as const;

export interface RunRecordExportHeader {
  type: "header";
  formatVersion: typeof RUN_RECORD_EXPORT_FORMAT_VERSION;
  generatedAt: string;
  filters: RunRecordExportFilters;
}

export interface RunRecordExportRecord {
  type: "record";
  record: RunRecordDetail;
}

export interface RunRecordExportSummary {
  type: "summary";
  formatVersion: typeof RUN_RECORD_EXPORT_FORMAT_VERSION;
  recordCount: number;
  complete: true;
}

export type RunRecordExportLine = RunRecordExportHeader | RunRecordExportRecord | RunRecordExportSummary;

export type ResearchMessageRole = "user" | "assistant";
export type ResearchMessageStatus = "pending" | "streaming" | "paused" | "completed" | "failed" | "stopped";
export type ResearchTaskStatus = "queued" | "running" | "paused" | "completed" | "failed" | "stopped";

/** AI 弱标记预览任务状态（H3c）。预览独立于节点消息，点击后才会转成子节点。 */
export type ResearchTermPreviewStatus = "queued" | "running" | "completed" | "failed";

export interface ResearchTermPreviewError {
  code: "model_not_configured" | "provider_error" | "service_restarted";
  message: string;
}

/** 单个消息术语在当前节点中的一次正式解释生成。内容会持续写入，便于刷新后恢复。 */
export interface ResearchTermPreviewRecord {
  id: string;
  sessionId: string;
  nodeId: string;
  messageId: string;
  marker: TermMarker;
  /** node + message + marker offsets 的确定性缓存键。 */
  markerKey: string;
  /** 用于网络重试与重复点击的幂等键。 */
  idempotencyKey: string;
  selectionId: string;
  status: ResearchTermPreviewStatus;
  content: string;
  retryable: boolean;
  provider?: string;
  model?: string;
  promptVersion: string;
  error?: ResearchTermPreviewError;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ResearchTermPreviewInput {
  messageId: string;
  marker: TermMarker;
}

/**
 * 术语预览生长请求体。mention 是用户实际点击生长的那次提及；
 * 缺省时子节点来源回落为预览最初生成时的提及位置（ADR-0029）。
 */
export interface ResearchTermPreviewGrowthInput {
  mention?: ResearchTermPreviewInput;
}

export type ResearchTermPreviewEvent =
  | { id?: number; type: "snapshot"; preview: ResearchTermPreviewRecord; createdAt: string }
  | { id: number; type: "delta"; delta: string; preview: ResearchTermPreviewRecord; createdAt: string }
  | { id: number; type: "completed"; preview: ResearchTermPreviewRecord; createdAt: string }
  | { id: number; type: "failed"; preview: ResearchTermPreviewRecord; createdAt: string };

export const RESEARCH_IMPORT_MAX_BYTES = 20 * 1024 * 1024;
export const RESEARCH_IMPORT_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/pdf",
] as const;

export type ResearchImportMimeType = typeof RESEARCH_IMPORT_MIME_TYPES[number];
export type ResearchAttachmentStatus = "processing" | "ready" | "failed" | "cancelled";
export type ResearchImportTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ResearchImportPhase = "queued" | "parsing" | "persisting" | "completed";
export type ResearchImportErrorCode =
  | "unsupported_file_type"
  | "file_too_large"
  | "empty_file"
  | "parse_failed"
  | "service_restarted";

export interface ResearchAttachmentRecord {
  id: string;
  sessionId: string;
  fileName: string;
  mimeType: ResearchImportMimeType;
  size: number;
  checksum: string;
  status: ResearchAttachmentStatus;
  importTaskId: string;
  contentSnapshotId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchImportProgress {
  phase: ResearchImportPhase;
  completedUnits: number;
  totalUnits: number;
}

export interface ResearchImportError {
  code: ResearchImportErrorCode;
  message: string;
}

export interface ResearchImportTaskRecord {
  id: string;
  sessionId: string;
  attachmentId: string;
  idempotencyKey: string;
  status: ResearchImportTaskStatus;
  progress: ResearchImportProgress;
  retryable: boolean;
  error?: ResearchImportError;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export type ResearchContentAnchor =
  | { kind: "text"; startLine: number; endLine: number; exact: string; prefix?: string; suffix?: string }
  | { kind: "markdown"; startLine: number; endLine: number; blockType: "heading" | "paragraph" | "list" | "code"; heading?: string; exact: string; prefix?: string; suffix?: string }
  | { kind: "docx"; paragraphIndex: number; blockType: "heading" | "paragraph" | "list" | "table"; heading?: string; exact: string; prefix?: string; suffix?: string }
  | { kind: "pdf"; pageNumber: number; exact: string; prefix?: string; suffix?: string };

export interface ResearchContentBlock {
  id: string;
  ordinal: number;
  text: string;
  anchor: ResearchContentAnchor;
}

export interface ResearchContentSnapshotRecord {
  id: string;
  sessionId: string;
  attachmentId: string;
  mimeType: ResearchImportMimeType;
  title: string;
  blocks: ResearchContentBlock[];
  createdAt: string;
}

export interface ResearchImportAccepted {
  attachment: ResearchAttachmentRecord;
  task: ResearchImportTaskRecord;
}

export type ResearchImportTaskEvent =
  | { id?: number; type: "snapshot"; task: ResearchImportTaskRecord; attachment: ResearchAttachmentRecord; createdAt: string }
  | { id: number; type: "progress"; task: ResearchImportTaskRecord; attachment: ResearchAttachmentRecord; createdAt: string }
  | { id: number; type: "completed"; task: ResearchImportTaskRecord; attachment: ResearchAttachmentRecord; createdAt: string }
  | { id: number; type: "failed"; task: ResearchImportTaskRecord; attachment: ResearchAttachmentRecord; createdAt: string }
  | { id: number; type: "cancelled"; task: ResearchImportTaskRecord; attachment: ResearchAttachmentRecord; createdAt: string };

// ── 导入章节解析（T03，ADR-0032）────────────────────────────────
// 导入主流程保持纯本地解析、完成即可阅读；超过长文阈值（LONG_TEXT_CHAR_THRESHOLD 同源）
// 的快照另起独立异步任务：有模型时 AI 通读全文产出章节划分，无模型/失败/输出不合契约时
// 退化为规则锚点。章节锚点一律落在既有内容块（ResearchContentBlock.ordinal）上，
// 不另立第二套锚点事实；界面按 source/fallbackReason 诚实呈现锚点来源。

/** 导入材料与回答正文共用的章节解析提示版本。 */
export const IMPORT_CHAPTER_PARSE_PROMPT_VERSION = "research-chapter-parse-v2";
/** 章节解析输出预算；JSON 结构有界，2048 足够覆盖上限章节数。 */
export const IMPORT_CHAPTER_PARSE_TOKEN_BUDGET = 2_048;
/** 送入模型的正文上限（字符）；超出部分按块边界截断，锚点仍只落在被送入的既有块上。 */
export const IMPORT_CHAPTER_PARSE_MAX_INPUT_CHARS = 60_000;
/** AI 与规则锚点共同的章节数上限（导航有界性）。 */
export const IMPORT_CHAPTER_MAX_COUNT = 24;
/** 章节标题长度上限（AI 输出与规则首句共用）。 */
export const IMPORT_CHAPTER_TITLE_MAX_CHARACTERS = 40;

export type ResearchChapterSource = "ai" | "rule";
export type ResearchChapterFallbackReason = "no_model" | "ai_failed" | "ai_invalid";
export type ResearchChapterTaskStatus = "queued" | "running" | "completed" | "failed";
export type ResearchChapterErrorCode =
  | "model_not_configured"
  | "provider_error"
  | "invalid_output"
  | "content_missing"
  | "snapshot_missing"
  | "service_restarted";

export type ResearchChapterTarget =
  | { kind: "import"; snapshotId: string }
  | { kind: "answer"; messageId: string; bodyVersionId: string; nodeId: string };

/** 章节锚点：节标题 + 既有内容块下标。标题由 AI 理解生成或规则派生（原文标题/段落首句）。 */
export interface ResearchChapterAnchor {
  /** 章节顺序号，从 0 连续编号。 */
  ordinal: number;
  title: string;
  /** 章节起始内容块在快照 blocks 中的 ordinal（导航跳转目标恒存在于既有块）。 */
  blockOrdinal: number;
  /** 新记录指向快照中的既有块；旧记录缺省时仍按 blockOrdinal 粗粒度导航。 */
  location?: ResearchStableLocation;
}

export interface ResearchChapterTaskRecord {
  id: string;
  sessionId: string;
  target?: ResearchChapterTarget;
  /** 旧记录兼容字段；新导入任务的目标只写 target。 */
  snapshotId?: string;
  /** 运行记录列表标题（导入文件名）。 */
  title: string;
  status: ResearchChapterTaskStatus;
  /** 失败或规则降级后可重试；AI 成功后为 false。 */
  retryable: boolean;
  /** 已产出锚点的来源；尚未产出时缺省。 */
  source?: ResearchChapterSource;
  /** 规则锚点的降级原因；AI 成功时缺省。 */
  fallbackReason?: ResearchChapterFallbackReason;
  chapters: ResearchChapterAnchor[];
  provider?: string;
  model?: string;
  promptVersion?: string;
  attempts: number;
  error?: { code: ResearchChapterErrorCode; message: string };
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

/** 阅读内容 HTTP 视图附带的章节解析状态（视图字段，不入库）。 */
export interface ResearchChapterParseView {
  taskId: string;
  status: ResearchChapterTaskStatus;
  retryable: boolean;
  source?: ResearchChapterSource;
  fallbackReason?: ResearchChapterFallbackReason;
  chapters: ResearchChapterAnchor[];
  error?: { code: string; message: string };
  updatedAt: string;
}

export function researchChapterTargetKey(target: ResearchChapterTarget): string {
  return target.kind === "import" ? `import:${target.snapshotId}` : `answer:${target.bodyVersionId}`;
}

/** 旧导入任务惰性适配到统一目标，不改写历史 record_json。 */
export function resolveResearchChapterTarget(
  task: Pick<ResearchChapterTaskRecord, "target" | "snapshotId">,
): ResearchChapterTarget {
  if (task.target) return task.target;
  if (task.snapshotId) return { kind: "import", snapshotId: task.snapshotId };
  throw new Error("Research chapter task target is missing");
}

/** 阅读内容 HTTP 视图：快照 + 章节解析状态（只有达到长文阈值的快照携带 chapterParse）。 */
export interface ResearchContentView extends ResearchContentSnapshotRecord {
  chapterParse?: ResearchChapterParseView;
}

/** 为新旧章节结果派生同一稳定位置；不复制、改写或持久化块正文。 */
export function attachResearchChapterLocations(
  snapshot: Pick<ResearchContentSnapshotRecord, "id" | "blocks">,
  chapters: readonly ResearchChapterAnchor[],
): ResearchChapterAnchor[] {
  return chapters.map((chapter) => {
    const block = snapshot.blocks.find((candidate) => candidate.ordinal === chapter.blockOrdinal);
    const { location: _oldLocation, ...base } = chapter;
    if (!block?.text) return base;
    return {
      ...base,
      location: {
        contentId: block.id,
        bodyVersionId: snapshot.id,
        sourceRange: { startOffset: 0, endOffset: block.text.length },
        exact: block.text,
      },
    };
  });
}

/** 导入快照是否需要章节解析：全文超过长文阈值才触发（与 T01 阈值常量同源）。 */
export function importSnapshotNeedsChapterParse(blocks: readonly Pick<ResearchContentBlock, "text">[]): boolean {
  return isLongText(blocks.map((block) => block.text).join("\n\n"));
}

/** 截断为带上限的标题；超长以省略号收口，长度恒 ≤ max。 */
function truncateChapterTitle(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * 规则章节锚点（确定性降级路径）：
 * - 原文带标题（markdown/docx heading 块）且 ≥2 个时，以标题块为章节起点，标题取原文标题；
 *   标题过多时均匀抽样保留首尾，章节数不超过上限。
 * - 否则按段落结构均分：目标章数随全文长度在 2–8 间取值，每章起点取该段首句。
 * 幂等、不依赖 AI、不修改块内容；空快照返回空数组。
 */
export function deriveImportRuleChapters(blocks: readonly ResearchContentBlock[]): ResearchChapterAnchor[] {
  const meaningful = blocks.filter((block) => block.text.trim());
  if (meaningful.length === 0) return [];
  const headingBlocks = meaningful.filter((block) => {
    const anchor = block.anchor;
    return (anchor.kind === "markdown" || anchor.kind === "docx") && anchor.blockType === "heading" && block.text.trim();
  });
  if (headingBlocks.length >= 2) {
    const selected: ResearchContentBlock[] = [];
    const seen = new Set<number>();
    const max = Math.min(IMPORT_CHAPTER_MAX_COUNT, headingBlocks.length);
    for (let index = 0; index < max; index += 1) {
      const sourceIndex = max === 1 ? 0 : Math.round((index * (headingBlocks.length - 1)) / (max - 1));
      const candidate = headingBlocks[sourceIndex];
      if (!seen.has(candidate.ordinal)) {
        seen.add(candidate.ordinal);
        selected.push(candidate);
      }
    }
    return selected.map((block, ordinal) => {
      const split = splitBlockHeading(block.text);
      const title = (split?.title ?? block.text).trim().replace(/\s+/g, " ");
      return { ordinal, title: truncateChapterTitle(title, IMPORT_CHAPTER_TITLE_MAX_CHARACTERS), blockOrdinal: block.ordinal };
    });
  }
  const totalChars = meaningful.reduce((sum, block) => sum + block.text.length, 0);
  const target = Math.min(meaningful.length, Math.max(2, Math.min(8, Math.round(totalChars / LONG_TEXT_CHAR_THRESHOLD))));
  const budget = totalChars / target;
  const anchors: ResearchChapterAnchor[] = [];
  let accumulated = 0;
  for (const block of meaningful) {
    if (anchors.length === 0 || (anchors.length < target && accumulated >= budget)) {
      anchors.push({ ordinal: anchors.length, title: ruleChapterTitle(block.text), blockOrdinal: block.ordinal });
      accumulated = 0;
    }
    accumulated += block.text.length;
  }
  return anchors;
}

/** 规则章节标题：段落首句（剥离 ATX/引用/加粗等弱格式），收口到标题长度上限。 */
function ruleChapterTitle(blockText: string): string {
  const cleaned = blockText
    .trim()
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*>+\s*/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1");
  const match = cleaned.match(/^[^。！？!?；;\n]+[。！？!?；;]?/);
  const sentence = (match?.[0] ?? cleaned).trim().replace(/\s+/g, " ");
  return truncateChapterTitle(sentence || "开始", IMPORT_CHAPTER_TITLE_MAX_CHARACTERS);
}

/** 回答章节的确定性降级路径；只保存当前正文版本的真实范围与标题。 */
export function deriveAnswerRuleChapters(
  version: Pick<ResearchBodyVersionRecord, "id" | "messageId" | "content">,
  slices: readonly ResearchSliceRecord[] = [],
): ResearchChapterAnchor[] {
  if (!isLongText(version.content)) return [];
  const blocks = deriveMessageBlocks(version.content);
  const units = composeSectionUnits(blocks);
  const formal = slices.filter((slice) => !slice.isProvisional).sort((a, b) => a.ordinal - b.ordinal);
  return units.slice(0, IMPORT_CHAPTER_MAX_COUNT).map((unit, ordinal) => {
    const first = blocks[unit.firstBlockOrdinal];
    const startOffset = first?.startOffset ?? 0;
    const exact = version.content.slice(startOffset, startOffset + unit.content.length);
    const title = unit.title || formal[ordinal]?.title || ruleChapterTitle(unit.content);
    return {
      ordinal,
      title: truncateChapterTitle(title.trim().replace(/\s+/g, " "), IMPORT_CHAPTER_TITLE_MAX_CHARACTERS),
      blockOrdinal: unit.firstBlockOrdinal,
      location: {
        contentId: version.messageId,
        bodyVersionId: version.id,
        sourceRange: { startOffset, endOffset: startOffset + exact.length },
        exact,
      },
    };
  });
}

/** 把 AI 返回的块起点适配为回答正文版本的真实节范围。 */
export function attachAnswerChapterLocations(
  version: Pick<ResearchBodyVersionRecord, "id" | "messageId" | "content">,
  chapters: readonly ResearchChapterAnchor[],
): ResearchChapterAnchor[] {
  const blocks = deriveMessageBlocks(version.content);
  const units = composeSectionUnits(blocks);
  return chapters.flatMap((chapter) => {
    if (chapter.location?.bodyVersionId === version.id && chapter.location.contentId === version.messageId) {
      return [chapter];
    }
    const unit = units.find((candidate) => candidate.firstBlockOrdinal === chapter.blockOrdinal)
      ?? units.find((candidate) => chapter.blockOrdinal >= candidate.firstBlockOrdinal
        && chapter.blockOrdinal < candidate.firstBlockOrdinal + candidate.blockCount);
    if (!unit) return [];
    const first = blocks[unit.firstBlockOrdinal];
    if (!first) return [];
    const startOffset = first.startOffset;
    const exact = version.content.slice(startOffset, startOffset + unit.content.length);
    return [{
      ...chapter,
      location: {
        contentId: version.messageId,
        bodyVersionId: version.id,
        sourceRange: { startOffset, endOffset: startOffset + exact.length },
        exact,
      },
    }];
  }).map((chapter, ordinal) => ({ ...chapter, ordinal }));
}

/**
 * 章节解析模型输入：既有块按 `[B<ordinal>]` 编号拼接，按块边界截断到上限内。
 * blockCount 是被送入的块数（ordinal 0..blockCount-1），供输出校验约束章节起点范围。
 */
export function formatImportChapterParseInput(
  blocks: readonly ResearchContentBlock[],
  maxChars: number = IMPORT_CHAPTER_PARSE_MAX_INPUT_CHARS,
): { content: string; blockCount: number } {
  const parts: string[] = [];
  let length = 0;
  for (const block of blocks) {
    const part = `[B${block.ordinal}] ${block.text}`.slice(0, maxChars);
    if (parts.length > 0 && length + part.length + 2 > maxChars) break;
    parts.push(part);
    length += part.length + 2;
  }
  return { content: parts.join("\n\n"), blockCount: parts.length };
}

/**
 * 校验 AI 章节解析输出：只接受 `{chapters:[{block,title}]}`，block 为合法、严格递增的块下标，
 * title 非空；章节数在 1..上限之间。任何不合规返回 null，由调用方退化为规则锚点。
 */
export function validateImportChapterPlan(raw: string, blockCount: number): ResearchChapterAnchor[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const list = (parsed as { chapters?: unknown }).chapters;
  if (!Array.isArray(list) || list.length === 0 || list.length > IMPORT_CHAPTER_MAX_COUNT) return null;
  const anchors: ResearchChapterAnchor[] = [];
  let previousBlock = -1;
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const block = (item as { block?: unknown }).block;
    const title = (item as { title?: unknown }).title;
    if (typeof block !== "number" || !Number.isInteger(block) || block < 0 || block >= blockCount || block <= previousBlock) return null;
    if (typeof title !== "string" || !title.trim()) return null;
    previousBlock = block;
    anchors.push({
      ordinal: anchors.length,
      blockOrdinal: block,
      title: truncateChapterTitle(title.trim().replace(/\s+/g, " "), IMPORT_CHAPTER_TITLE_MAX_CHARACTERS),
    });
  }
  return anchors;
}

export interface ResearchSessionRecord {
  id: string;
  title: string;
  status: "active" | "archived";
  /** 用户收藏；收藏会话在客户端列表中置顶，不改变归档或回收站语义。 */
  isFavorite: boolean;
  /** 由选区开启的独立研究会话保留来源选区与来源会话，用于来源返回。 */
  originSelectionId?: string;
  originSessionId?: string;
  /** 所属项目 ID；缺失时会话处于"未分类"（存独立列，可索引过滤）。 */
  projectId?: string;
  /** 软删除时间（回收站）；存 record_json，对齐素材软删除先例。 */
  trashedAt?: string;
  /** 用户显式改过名；置位后自动标题（确定性派生与模型提炼）永久让位。 */
  titleEdited?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 项目：会话的第一层分组容器。项目不嵌套；无归属会话处于"未分类"。 */
export const PROJECT_COLOR_ROLES = ["amber", "violet", "blue", "teal", "rose"] as const;
export type ProjectColorRole = (typeof PROJECT_COLOR_ROLES)[number];

export interface ProjectRecord {
  id: string;
  name: string;
  /** 稳定色板角色；实际浅/深颜色由主题令牌解释，项目改名不改变。 */
  colorRole?: ProjectColorRole;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInput {
  name: string;
}

export function nextProjectColorRole(projects: readonly ProjectRecord[]): ProjectColorRole {
  const counts = new Map<ProjectColorRole, number>(PROJECT_COLOR_ROLES.map((role) => [role, 0]));
  for (const project of projects) {
    if (project.colorRole) counts.set(project.colorRole, (counts.get(project.colorRole) ?? 0) + 1);
  }
  return PROJECT_COLOR_ROLES.reduce((least, role) =>
    (counts.get(role) ?? 0) < (counts.get(least) ?? 0) ? role : least,
  PROJECT_COLOR_ROLES[0]);
}

export interface ResearchSessionUpdateInput {
  title?: string;
  /** null 表示移回未分类。 */
  projectId?: string | null;
  status?: "active" | "archived";
  isFavorite?: boolean;
}

/**
 * 研究节点（阶段 H 统一节点树）。
 * 一次对话或一篇导入文档成为根节点；每个节点可包含多轮消息，也可通过 parentNodeId 生长子节点。
 * sessionId 仍作为顶层物理容器（附件/导入/最近列表），树关系由 parentNodeId 表达。
 */
export interface ResearchNodeRecord {
  id: string;
  sessionId: string;
  parentNodeId?: string;
  originSelectionId?: string;
  /** H6：模型生成的稳定显示名称；缺失时使用确定性回退。 */
  displayName?: string;
  /** #31：确认式融合创建的融合节点标记（存 record_json，零迁移）；无父链，来源关系由 fused-from 边表达。 */
  isFusionNode?: boolean;
  /** 本节点输入区偏好；旧记录缺省为两个开关均关闭。 */
  composerPreferences?: ComposerPreferences;
  status: "active";
  createdAt: string;
  updatedAt: string;
}

export interface ResearchMessageRecord {
  id: string;
  sessionId: string;
  /** 研究节点 ID（阶段 H）。根节点与会话 ID 相同，子节点为独立 ID。 */
  nodeId?: string;
  /** 研究分支消息带分支 ID；普通会话主线消息不带。 */
  branchId?: string;
  role: ResearchMessageRole;
  content: string;
  /** HTTP/事件视图字段：由 reasoningRecordId 指向的独立记录组装，不写入消息 record_json。 */
  reasoning?: string;
  /** 当前生成尝试的独立 reasoning 记录；缺失表示供应商没有返回可展示内容。 */
  reasoningRecordId?: string;
  /** 旧版本快照按时间倒序；reasoning 只作为组装视图，持久化关联见 reasoningRecordId。 */
  versions?: ResearchMessageVersion[];
  status: ResearchMessageStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * 正文消费者专用的当前消息投影。字段采用显式白名单，刻意不暴露 reasoning、
 * reasoning 关联或历史版本；复制、搜索、派生正文、证据与模型上下文只能接收此形态。
 */
export interface ResearchMessageBodyRecord {
  id: string;
  sessionId: string;
  nodeId?: string;
  branchId?: string;
  role: ResearchMessageRole;
  content: string;
  status: ResearchMessageStatus;
  createdAt: string;
  updatedAt: string;
}

export function toResearchMessageBody(message: ResearchMessageRecord): ResearchMessageBodyRecord {
  return {
    id: message.id,
    sessionId: message.sessionId,
    ...(message.nodeId ? { nodeId: message.nodeId } : {}),
    ...(message.branchId ? { branchId: message.branchId } : {}),
    role: message.role,
    content: message.content,
    status: message.status,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

/** 消息旧版本快照：只读历史，不参与选区/弱标记/切片派生。 */
export interface ResearchMessageVersion {
  content: string;
  /** HTTP/事件视图字段：由 reasoningRecordId 组装，不写入消息 record_json。 */
  reasoning?: string;
  reasoningRecordId?: string;
  createdAt: string;
}

/**
 * 供应商独立通道返回的思考过程记录。它与一条回答消息和一次生成尝试绑定，
 * 不是正文、证据、搜索材料或后续模型上下文。
 */
export interface ResearchReasoningRecord {
  id: string;
  messageId: string;
  taskId: string;
  generationAttempt: number;
  content: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 消息内容的确定性段落块。块是派生值，不持久化；
 * 稳定块 ID 由消费方用 `messageContentBlockId(messageId, ordinal)` 派生。
 * 选区锚点以后端可重新派生的块结构为准，不使用浏览器 DOM 路径。
 */
export interface MessageContentBlock {
  ordinal: number;
  text: string;
  startOffset: number;
}

/**
 * 节级组合单元：把若干连续段落块合成一个"节切片"的骨架。
 * 标题块（见 splitBlockHeading）并入下一正文块；标题提升为 title、其后正文为 content。
 * 只描述组合关系，绝不复制/改写正文——content 恒等于被合并块文本用 "\n\n" 原样拼接，
 * 选区锚点与片段偏移仍以未改动的 deriveMessageBlocks 段落块为基线。
 *
 * #43：本结构是**瞬态派生结构**（卡片正文与片段范围的确定性来源），不是持久化契约——
 * 切片不再保存正文副本，正文唯一事实源是消息正文与正文版本。
 */
export interface MessageSectionUnit {
  /** 该节第一个块（含标题块）的 ordinal，即节起始块下标。 */
  firstBlockOrdinal: number;
  /** 节标题；首块是标题行时为其文字，否则为空串。 */
  title: string;
  /**
   * 节正文：被合并块文本按 "\n\n" 原样拼接（含标题块时含标题行），逐字等于对应正文片段。
   * 选区锚点与片段偏移仍以未改动的 deriveMessageBlocks 段落块为基线，正文一字不改。
   */
  content: string;
  /** 该节合并的块数（≥1）。 */
  blockCount: number;
}

/**
 * 长文判定长度阈值（可调产品常量，ADR-0032）：正文长度（UTF-16 code unit，与选区/
 * 片段偏移单位一致）超过该值即视为长文。服务端（plan-then-write 阈值与切片标注策略）
 * 与 Web 端（轮次卡片呈现）同源消费本常量与 `isLongText`，禁止各自另写判定。
 */
export const LONG_TEXT_CHAR_THRESHOLD = 2_000;

/** 长文判定唯一入口：内容长度超过阈值即视为长文。服务端与 Web 端共用。 */
export function isLongText(content: string): boolean {
  return content.length > LONG_TEXT_CHAR_THRESHOLD;
}

/**
 * 把消息纯文本确定性切分为段落块。规则（前后端必须只使用本实现，禁止另写切分逻辑）：
 * 1. 先把 CRLF / CR 归一为 LF；
 * 2. 按一个或多个空行（只含空白字符的行）切分段落；
 * 3. 每段 trim 首尾空白，空段丢弃；
 * 4. ordinal 从 0 连续编号；startOffset 是该段文本在归一化后全文中的字符偏移。
 */
export function deriveMessageBlocks(content: string): MessageContentBlock[] {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks: MessageContentBlock[] = [];
  const segmentPattern = /\S(?:[^\n]|\n(?!\s*\n))*/g;
  for (const match of normalized.matchAll(segmentPattern)) {
    const raw = match[0];
    const text = raw.trim();
    if (!text) continue;
    const startOffset = match.index + raw.indexOf(text);
    blocks.push({ ordinal: blocks.length, text, startOffset });
  }
  return blocks;
}

/** 消息内容块的稳定派生 ID，用于 DOM 锚点与选区记录，不入库。 */
export function messageContentBlockId(messageId: string, ordinal: number): string {
  return `${messageId}#p${ordinal}`;
}

/** 仅含一个加粗短行的整段标题（模型常用 `**标题**` 代替 ATX 标题）。 */
const BOLD_HEADING_MAX_CHARS = 60;

/**
 * 把单个段落块拆成"节标题 + 节正文"。返回 null 表示该块不含可提取标题。
 * 识别两类模型常用的标题形态（与正文唯一事实源一致，只在展示层提升标题，不改文本）：
 * - ATX 标题行：`#{1,6} 标题`（块首行；该块可能紧跟正文行，取首行为标题、其余为正文）；
 * - 整段加粗短行：`**标题**`（仅当整块只有一行且全部加粗、且足够短时才当作标题，
 *   避免把正文里的加粗句误判成标题）。
 */
export function splitBlockHeading(blockText: string): { title: string; body: string } | null {
  const atx = blockText.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*(?:\n([\s\S]*))?$/);
  if (atx) {
    const title = (atx[1] ?? "").trim();
    const body = (atx[2] ?? "").trim();
    if (title) return { title, body };
  }
  const trimmed = blockText.trim();
  if (!trimmed.includes("\n") && trimmed.length <= BOLD_HEADING_MAX_CHARS) {
    const bold = trimmed.match(/^\*\*(.+?)\*\*$/);
    if (bold && bold[1]?.trim()) return { title: bold[1].trim(), body: "" };
  }
  return null;
}

/**
 * 把段落块序列组合成节级单元（生成自由化后切片/卡片/导航的粒度）。
 * 规则：标题块并入紧随其后的正文块——标题提升为节 title，正文为节 content；
 * 连续的裸标题（无正文）合并取最后一个标题；普通段落块各自成节（title 为空）。
 * 输出节数 ≤ 输入块数；content 恒由被合并块文本按 "\n\n" 原样拼接，正文一字不改。
 * 幂等、不依赖 AI、不修改源文本。
 */
export function composeSectionUnits(blocks: readonly MessageContentBlock[]): MessageSectionUnit[] {
  const units: MessageSectionUnit[] = [];
  // 节以标题为界：标题块开启一个新节，其后连续的普通正文块并入该节；一旦遇到无标题的普通
  // 段落且当前节还没有标题，则每个普通段落各自成节（保持无标题正文"一段一卡"的现状）。
  // content 是被合并块文本按 "\n\n" 原样拼接（标题块含标题行），逐字等于对应正文片段。
  let title = "";
  let firstOrdinal = -1;
  let partTexts: string[] = [];
  const flush = () => {
    if (firstOrdinal < 0) return;
    units.push({
      firstBlockOrdinal: firstOrdinal,
      title,
      content: partTexts.join("\n\n"),
      blockCount: partTexts.length,
    });
    title = "";
    firstOrdinal = -1;
    partTexts = [];
  };
  for (const block of blocks) {
    const heading = splitBlockHeading(block.text);
    if (heading && !heading.body) {
      // 标题块：先收束上一节，再以它为标题开启新节（标题行作为节正文首段，逐字保留）。
      flush();
      title = heading.title;
      firstOrdinal = block.ordinal;
      partTexts = [block.text];
      continue;
    }
    if (heading && heading.body) {
      // 同块内"标题 + 正文"：收束上一节，本块独立成节（整块逐字保留）。
      flush();
      units.push({ firstBlockOrdinal: block.ordinal, title: heading.title, content: block.text, blockCount: 1 });
      continue;
    }
    // 普通正文块：仅当正处于一个"有标题的节"里才并入；否则自成无标题节（一段一卡）。
    if (firstOrdinal >= 0 && title) {
      partTexts.push(block.text);
    } else {
      flush();
      units.push({ firstBlockOrdinal: block.ordinal, title: "", content: block.text, blockCount: 1 });
    }
  }
  flush();
  return units;
}

/**
 * 判定一条消息是否按节级卡片呈现（#91 呈现契约，ADR-0032）：
 * 仅当内容为长文（`isLongText`）且存在正式切片时才派生节卡；普通回答渲染为一张
 * 轮次卡片的连续正文。呈现层、选区恢复与 `?fragment=` 深链定位共用本判定，
 * 避免多处手写同一规则产生错位（切片/片段派生契约本身不变）。
 */
export function messageUsesSectionCards(
  content: string,
  slices: readonly ResearchSliceRecord[] | undefined,
): boolean {
  return isLongText(content) && (slices ?? []).some((slice) => !slice.isProvisional);
}

export type AiConfigurationMode = "real" | "demo" | "unconfigured";

export interface ComposerPreferences {
  webSearchMode?: WebSearchMode;
  /** @deprecated persisted/input compatibility only; normalized views emit webSearchMode. */
  allowWebSearch?: boolean;
  thinkingEnabled: boolean;
}

export const DEFAULT_COMPOSER_PREFERENCES: Readonly<ComposerPreferences> & { webSearchMode: WebSearchMode } = Object.freeze({
  webSearchMode: "off",
  thinkingEnabled: false,
});

export type WebSearchMode = "off" | "required";

/** Legacy booleans are accepted only at input boundaries. New and legacy fields may not conflict. */
export function normalizeWebSearchModeInput(value: {
  webSearchMode?: unknown;
  allowWebSearch?: unknown;
}, fallback: WebSearchMode = "off"): WebSearchMode {
  if (value.webSearchMode !== undefined && value.webSearchMode !== "off" && value.webSearchMode !== "required") {
    throw new Error('webSearchMode must be "off" or "required" when provided');
  }
  if (value.allowWebSearch !== undefined && typeof value.allowWebSearch !== "boolean") {
    throw new Error("allowWebSearch must be a boolean when provided");
  }
  const legacy = value.allowWebSearch === undefined ? undefined : value.allowWebSearch ? "required" : "off";
  if (value.webSearchMode !== undefined && legacy !== undefined && value.webSearchMode !== legacy) {
    throw new Error("webSearchMode conflicts with legacy allowWebSearch");
  }
  return (value.webSearchMode as WebSearchMode | undefined) ?? legacy ?? fallback;
}

export function normalizeComposerPreferences(value: unknown, fallback: ComposerPreferences = DEFAULT_COMPOSER_PREFERENCES): ComposerPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...fallback };
  const input = value as { webSearchMode?: unknown; allowWebSearch?: unknown; thinkingEnabled?: unknown };
  return {
    webSearchMode: normalizeWebSearchModeInput(input, fallback.webSearchMode ?? "off"),
    thinkingEnabled: typeof input.thinkingEnabled === "boolean" ? input.thinkingEnabled : fallback.thinkingEnabled,
  };
}

export interface AiRouteConfigurationView {
  provider?: string;
  model?: string;
  providerProfileId?: string;
  /** 只由集中式能力解析器根据实际端点与模型身份给出；未知身份恒为 false。 */
  thinkingSupported: boolean;
  /** 实际用途路由的完整能力矩阵；旧档案缺少快照时返回 unknown 矩阵。 */
  capabilities?: ModelCapabilityMatrix;
  /** 路由配置或能力读取失败时提供克制的用户可见原因。 */
  unavailableReason?: string;
}

export interface AiConfigurationView {
  consent: boolean;
  configured: boolean;
  mode: AiConfigurationMode;
  provider?: string;
  model?: string;
  /** 当前激活的 ProviderProfile ID；未使用持久化配置时缺省。 */
  providerProfileId?: string;
  /** 当前模型供应商的联网搜索能力；unsupported 时界面不显示联网状态。 */
  webGrounding?: ProviderWebGrounding;
  /** 当前活跃的搜索后端 */
  searchBackend?: string;
  /** 可用搜索后端列表 */
  availableSearchBackends?: string[];
  /** 网关重建失败的具体原因（配置停用/凭证缺失/解析失败）；网关可用时缺省。 */
  modelError?: string;
  /** 普通发送与深入研究各自实际解析出的路由。 */
  routes: {
    chat: AiRouteConfigurationView;
    research: AiRouteConfigurationView;
  };
}

// ── Research Selection ─────────────────────────────────────────────

/** UTF-16 code-unit range over one canonical content body. */
export interface ResearchTextRange {
  startOffset: number;
  endOffset: number;
}

/**
 * Stable pointer into an existing canonical body version.
 *
 * `exact` is a validation witness, not another writable body. For plain text it
 * equals the source slice. Markdown locations may additionally carry a visible
 * range; then `exact` equals that projected visible slice while `sourceRange`
 * still points at the canonical Markdown source.
 */
export interface ResearchStableLocation {
  contentId: string;
  bodyVersionId: string;
  sourceRange: ResearchTextRange;
  exact: string;
  visibleRange?: ResearchTextRange;
}

export type ResearchStableLocationFailureReason =
  | "content-mismatch"
  | "version-mismatch"
  | "source-range-invalid"
  | "visible-range-invalid"
  | "exact-mismatch";

export type ResearchStableLocationResolution =
  | { kind: "found"; location: ResearchStableLocation }
  | {
      kind: "degraded";
      reason: ResearchStableLocationFailureReason;
      contentId: string;
      bodyVersionId: string;
    };

export interface ResearchStableLocationCandidate {
  contentId: string;
  bodyVersionId: string;
  source: string;
  /** Current visible projection. Required only when the location has visibleRange. */
  visibleText?: string;
  /** Projects the source range through the current renderer; required with visibleRange. */
  projectSourceRange?: (sourceRange: ResearchTextRange) => ResearchTextRange | undefined;
}

/** Structural validation shared by HTTP contracts and persisted derived records. */
export function validateResearchStableLocation(value: unknown): asserts value is ResearchStableLocation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stable location must be an object");
  const location = value as Record<string, unknown>;
  if (typeof location.contentId !== "string" || !location.contentId.trim()) throw new Error("location.contentId is required");
  if (typeof location.bodyVersionId !== "string" || !location.bodyVersionId.trim()) throw new Error("location.bodyVersionId is required");
  validateResearchTextRange(location.sourceRange, "location.sourceRange");
  if (typeof location.exact !== "string" || !location.exact) throw new Error("location.exact is required");
  if (location.visibleRange !== undefined) validateResearchTextRange(location.visibleRange, "location.visibleRange");
}

function validateResearchTextRange(value: unknown, field: string): asserts value is ResearchTextRange {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} is required`);
  const range = value as Record<string, unknown>;
  if (!Number.isSafeInteger(range.startOffset) || (range.startOffset as number) < 0) {
    throw new Error(`${field}.startOffset must be a non-negative integer`);
  }
  if (!Number.isSafeInteger(range.endOffset) || (range.endOffset as number) <= (range.startOffset as number)) {
    throw new Error(`${field}.endOffset must be greater than startOffset`);
  }
}

/**
 * Resolve without fuzzy search. A mismatch returns a coarse-grained degradation
 * reason so callers can keep the content identity while refusing a wrong exact
 * location, including repeated-text cases.
 */
export function resolveResearchStableLocation(
  location: ResearchStableLocation,
  candidate: ResearchStableLocationCandidate,
): ResearchStableLocationResolution {
  const degraded = (reason: ResearchStableLocationFailureReason): ResearchStableLocationResolution => ({
    kind: "degraded",
    reason,
    contentId: location.contentId,
    bodyVersionId: location.bodyVersionId,
  });
  if (candidate.contentId !== location.contentId) return degraded("content-mismatch");
  if (candidate.bodyVersionId !== location.bodyVersionId) return degraded("version-mismatch");
  const sourceRange = location.sourceRange;
  if (!validResearchTextRange(sourceRange, candidate.source.length)) return degraded("source-range-invalid");
  if (location.visibleRange) {
    if (candidate.visibleText === undefined || !validResearchTextRange(location.visibleRange, candidate.visibleText.length)) {
      return degraded("visible-range-invalid");
    }
    const projected = candidate.projectSourceRange?.(sourceRange);
    if (!projected
      || projected.startOffset !== location.visibleRange.startOffset
      || projected.endOffset !== location.visibleRange.endOffset) {
      return degraded("visible-range-invalid");
    }
    if (candidate.visibleText.slice(location.visibleRange.startOffset, location.visibleRange.endOffset) !== location.exact) {
      return degraded("exact-mismatch");
    }
  } else if (candidate.source.slice(sourceRange.startOffset, sourceRange.endOffset) !== location.exact) {
    return degraded("exact-mismatch");
  }
  return { kind: "found", location };
}

function validResearchTextRange(range: ResearchTextRange, length: number): boolean {
  return Number.isSafeInteger(range.startOffset)
    && Number.isSafeInteger(range.endOffset)
    && range.startOffset >= 0
    && range.endOffset > range.startOffset
    && range.endOffset <= length;
}

// ── Versioned sidecar enhancements ─────────────────────────────────────

/**
 * Shared identity and lifecycle for derived reading enhancements.
 *
 * This record intentionally contains no citation, term-marker, or chapter payload.
 * Each enhancement family keeps its own typed data and references this header, so
 * the shared store cannot become an untyped JSON content container.
 */
export type ResearchSidecarKind = "citation" | "term-marker" | "chapter";
export type ResearchSidecarStatus = "pending" | "ready" | "invalid";
export type ResearchSidecarPrecision = "exact" | "block" | "content";
export type ResearchSidecarSource =
  | { kind: "model"; referenceId?: string }
  | { kind: "provider"; referenceId?: string }
  | { kind: "rule"; referenceId?: string };

export type ResearchSidecarInvalidReason =
  | "body-version-superseded"
  | "content-deleted"
  | "range-invalid"
  | "generation-failed"
  | "service-restarted"
  | "source-unavailable";

export interface ResearchSidecarRecord {
  id: string;
  kind: ResearchSidecarKind;
  bodyVersionId: string;
  location: ResearchStableLocation;
  generationAttempt: number;
  status: ResearchSidecarStatus;
  source: ResearchSidecarSource;
  precision: ResearchSidecarPrecision;
  invalidReason?: ResearchSidecarInvalidReason;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchSidecarRecordQuery {
  bodyVersionId?: string;
  contentId?: string;
  kind?: ResearchSidecarKind;
  statuses?: readonly ResearchSidecarStatus[];
}

/**
 * 选区锚点统一两种内容来源。offsets 是相对该锚定块文本的字符偏移
 * （UTF-16 code unit，与浏览器 Selection / String.prototype.slice 一致）。
 * exact 是创建时刻的选区原文；prefix / suffix 是块内上下文摘录，用于
 * 内容变化后的自愈重定位。
 */
export type ResearchSelectionAnchor =
  | {
      kind: "message";
      messageId: string;
      blockOrdinal: number;
      startOffset: number;
      endOffset: number;
      exact: string;
      /** Service-resolved stable location; omitted by legacy clients and stale records. */
      location?: ResearchStableLocation;
      prefix?: string;
      suffix?: string;
    }
  | {
      kind: "snapshot";
      contentSnapshotId: string;
      blockId: string;
      startOffset: number;
      endOffset: number;
      exact: string;
      /** Service-resolved stable location; omitted by legacy clients and stale records. */
      location?: ResearchStableLocation;
      prefix?: string;
      suffix?: string;
    };

export type ResearchSelectionStatus = "active" | "stale";

/**
 * 选区记录。text 是创建时刻的原文副本，永远不因内容变化或 AI 失败而删除；
 * anchor 保存服务端校验（必要时自愈重定位）后的位置；stale 表示原文已变化，
 * 选区仍保留，按粗粒度位置降级展示。
 */
export interface ResearchSelectionRecord {
  id: string;
  sessionId: string;
  /** 研究节点 ID（阶段 H）。选区所属的节点。 */
  nodeId?: string;
  anchor: ResearchSelectionAnchor;
  text: string;
  contextBefore?: string;
  contextAfter?: string;
  status: ResearchSelectionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchSelectionAccepted {
  selection: ResearchSelectionRecord;
}

export interface ResearchSelectionInput {
  anchor: ResearchSelectionAnchor;
  /**
   * 选区归属的节点（用户创建选区时所在的节点）。可选：
   * 提供时服务端校验该节点存在且属于当前会话，选区归属到它；
   * 未提供时归属会话根节点（兼容旧客户端与阅读页路径）。
   */
  nodeId?: string;
  contextBefore?: string;
  contextAfter?: string;
}

/** 选区质量阈值。前后端同源，只允许引用本常量，不得另写数值。 */
export const RESEARCH_SELECTION_MAX_CHARACTERS = 4000;
/** 选区上下文摘录的最大长度（锚点 prefix/suffix 与 record contextBefore/After 共用）。 */
export const RESEARCH_SELECTION_CONTEXT_CHARACTERS = 120;

const RESEARCH_SELECTION_ANCHOR_CONTEXT_FIELDS = ["prefix", "suffix"] as const;

export function validateResearchSelectionInput(value: unknown): asserts value is ResearchSelectionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Research selection input must be an object");
  const input = value as { anchor?: unknown; nodeId?: unknown; contextBefore?: unknown; contextAfter?: unknown };
  if (input.nodeId !== undefined && (typeof input.nodeId !== "string" || !input.nodeId.trim())) {
    throw new Error("nodeId must be a non-empty string when provided");
  }
  const anchor = input.anchor;
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) throw new Error("anchor is required");
  const candidate = anchor as Record<string, unknown>;
  if (candidate.kind === "message") {
    if (typeof candidate.messageId !== "string" || !candidate.messageId.trim()) throw new Error("anchor.messageId is required");
    if (!Number.isSafeInteger(candidate.blockOrdinal) || (candidate.blockOrdinal as number) < 0) {
      throw new Error("anchor.blockOrdinal must be a non-negative integer");
    }
  } else if (candidate.kind === "snapshot") {
    if (typeof candidate.contentSnapshotId !== "string" || !candidate.contentSnapshotId.trim()) throw new Error("anchor.contentSnapshotId is required");
    if (typeof candidate.blockId !== "string" || !candidate.blockId.trim()) throw new Error("anchor.blockId is required");
  } else {
    throw new Error("anchor.kind must be message or snapshot");
  }
  if (!Number.isSafeInteger(candidate.startOffset) || (candidate.startOffset as number) < 0) {
    throw new Error("anchor.startOffset must be a non-negative integer");
  }
  if (!Number.isSafeInteger(candidate.endOffset) || (candidate.endOffset as number) <= (candidate.startOffset as number)) {
    throw new Error("anchor.endOffset must be greater than anchor.startOffset");
  }
  if (typeof candidate.exact !== "string" || candidate.exact !== (candidate.exact as string).trim() || !candidate.exact) {
    throw new Error("anchor.exact must be the trimmed selection text");
  }
  if (candidate.exact.length > RESEARCH_SELECTION_MAX_CHARACTERS) {
    throw new Error(`Selection must not exceed ${RESEARCH_SELECTION_MAX_CHARACTERS} characters`);
  }
  if (candidate.location !== undefined) {
    validateResearchStableLocation(candidate.location);
    const location = candidate.location as ResearchStableLocation;
    const expectedContentId = candidate.kind === "message" ? candidate.messageId : candidate.blockId;
    if (location.contentId !== expectedContentId) throw new Error("anchor.location.contentId must match the anchored content");
    if (location.exact !== candidate.exact) throw new Error("anchor.location.exact must match anchor.exact");
  }
  for (const field of RESEARCH_SELECTION_ANCHOR_CONTEXT_FIELDS) {
    const excerpt = candidate[field];
    if (excerpt === undefined) continue;
    if (typeof excerpt !== "string" || excerpt.length > RESEARCH_SELECTION_CONTEXT_CHARACTERS) {
      throw new Error(`anchor.${field} must not exceed ${RESEARCH_SELECTION_CONTEXT_CHARACTERS} characters`);
    }
  }
  for (const field of ["contextBefore", "contextAfter"] as const) {
    const context = input[field];
    if (context === undefined) continue;
    if (typeof context !== "string" || context.length > RESEARCH_SELECTION_CONTEXT_CHARACTERS) {
      throw new Error(`${field} must not exceed ${RESEARCH_SELECTION_CONTEXT_CHARACTERS} characters`);
    }
  }
}

export type ResearchSelectionQuality =
  | { level: "ok" }
  | { level: "too_long"; maxCharacters: number }
  | { level: "cross_block" };

/**
 * 选区质量评估（纯函数，前后端同一实现）。返回调整建议而不阻止创建；
 * 服务端仍按 validateResearchSelectionInput 拒绝结构不合法的请求。
 *
 * 修订一·B（issue #10）：非空即有效——最短字符限制全层退役，单字选区同样 ok；
 * "非空"的结构保证由 validateResearchSelectionInput 的 exact 校验承担
 * （exact 必须为非空的修剪后文本），本函数不再检查字数下限，字数上限不变。
 */
export function evaluateSelectionQuality(input: { text: string; blockCount: number }): ResearchSelectionQuality {
  if (input.blockCount > 1) return { level: "cross_block" };
  const length = input.text.trim().length;
  if (length > RESEARCH_SELECTION_MAX_CHARACTERS) return { level: "too_long", maxCharacters: RESEARCH_SELECTION_MAX_CHARACTERS };
  return { level: "ok" };
}

export interface ResearchTaskError {
  code:
    | "model_not_configured"
    | "provider_error"
    | "service_restarted"
    | "model_route_unavailable"
    | "thinking_unavailable"
    | "web_search_unavailable"
    | "deep_research_context_unavailable"
    | "user_intent_unsatisfied";
  message: string;
}

export type ResearchTaskMode = "chat" | "deep_research";
export type WebSearchFallbackPolicy = "enabled" | "disabled";
export type WebSearchFailureClassification =
  | "backend_unavailable"
  | "backend_error"
  | "timeout"
  | "zero_results"
  | "no_qualified_sources"
  | "fetch_failed";

export interface ResearchExecutionIntent {
  schemaVersion: 1;
  frozenAt: string;
  taskMode: ResearchTaskMode;
  deepResearch?: {
    mode: DeepResearchMode;
    selectionId: string;
    sourceMessageId: string;
    context: DeepResearchContext;
    contextFingerprint: string;
  };
  model: {
    purpose: "chat" | "research";
    configurationSource: "purpose_route" | "active_profile" | "injected_provider";
    configurationVersion: number;
    providerProfileId?: string;
    provider: string;
    model: string;
    apiMode: ProviderApiMode;
    baseUrlFingerprint?: string;
  };
  webSearch: {
    mode: WebSearchMode;
    requestedBackend: string;
    fallbackPolicy: WebSearchFallbackPolicy;
    availableAtSubmission: boolean;
    unavailableReasonCode?: string;
  };
  thinking: { requested: boolean; applied: boolean };
}

export interface ResearchWebSearchAudit {
  requestedBackend: string;
  attemptedBackends: string[];
  usedFallback: boolean;
  queryCount: number;
  resultCount: number;
  sourceCount: number;
  failureClassification?: WebSearchFailureClassification;
  /** Sanitized public reason. Never contains response bodies, URLs, prompts, or credentials. */
  failureReason?: string;
}

export const RESEARCH_EXECUTION_STAGES = [
  "planning",
  "web_search",
  "source_reading",
  "model_analysis",
  "drafting",
  "finalizing",
  "degradation",
] as const;
export type ResearchExecutionStage = (typeof RESEARCH_EXECUTION_STAGES)[number];
export type ResearchExecutionStatus = "started" | "completed" | "failed";
export interface ResearchExecutionEventRecord {
  stage: ResearchExecutionStage;
  status: ResearchExecutionStatus;
  query?: string;
  requestedBackend?: string;
  actualBackend?: string;
  usedFallback?: boolean;
  resultCount?: number;
  sourceCount?: number;
  reasonCode?: string;
}

export type ResearchGroundingScopeStatus =
  | "evidence_prepared" | "evidence_incomplete" | "evidence_conflicting"
  | "grounded" | "grounding_failed" | "grounding_unsupported" | "no_verifiable_sources" | "not_requested";

/** 提供给任务视图和界面的联网结果摘要；不包含任何供应商原始响应或凭证。 */
export interface ResearchGroundingScope {
  status: ResearchGroundingScopeStatus;
  /** Number of distinct sources with accepted attribution in this final body; zero otherwise. */
  sourceCount: number;
  /** Number of accepted attribution records projected as citations in this final body. */
  citationCount: number;
  runId?: string;
  /** Evidence-policy coverage only; never a factual-verification or grounded projection. */
  evidencePolicyStatus?: EvidencePolicyStatus;
}

/**
 * plan-then-write 长文任务的单节计划与进度。
 * content 仅在该节扩写完成后写入；恢复时已完成节直接重放、不重调模型。
 */
export interface ResearchBodyPlanSection {
  /** 节标题；同时作为该节首个派生切片的卡片标题来源。 */
  heading: string;
  /** 该节主旨（扩写时的写作指引）。 */
  summary: string;
  /** 目标字数（提示用，非硬约束）。 */
  targetChars: number;
  status: "pending" | "completed" | "failed";
  /** 扩写完成的节正文；pending 时缺省。 */
  content?: string;
  /** 节内续写断点：本节已接受但尚未完成的部分正文（截断续写/空节修复中途落盘），恢复时从断点续写。 */
  partialContent?: string;
  /** 节最终失败原因（截断续写耗尽 / 空输出重问耗尽 / 供应商错误）；仅 status="failed" 时写入。 */
  failureReason?: string;
}

/**
 * 续写拼接去重：剔除 next 与 prior 尾部最长重叠前缀后拼接。
 * 截断续写/断点续传时模型可能重述断点附近的文字；精确字符匹配（不做模糊/归一化），
 * 仅当重叠长度 ≥ minOverlap 才认定为重复，避免短巧合重叠误删正文。契约安全、确定。
 */
export function joinContinuation(prior: string, next: string, maxOverlap = 2_000, minOverlap = 8): string {
  if (!prior) return next;
  if (!next) return prior;
  const upper = Math.min(maxOverlap, prior.length, next.length);
  for (let k = upper; k >= minOverlap; k -= 1) {
    if (prior.endsWith(next.slice(0, k))) return prior + next.slice(k);
  }
  return prior + next;
}

/** plan-then-write 长文任务的大纲与逐节进度，持久化于任务 record_json 以支持断点续扩。 */
export interface ResearchBodyPlan {
  sections: ResearchBodyPlanSection[];
}

export interface ResearchTaskRecord {
  id: string;
  sessionId: string;
  /** 研究节点 ID（阶段 H）。任务归属的节点。 */
  nodeId?: string;
  inputMessageId: string;
  outputMessageId: string;
  idempotencyKey: string;
  status: ResearchTaskStatus;
  retryable: boolean;
  provider?: string;
  model?: string;
  promptVersion: string;
  /** 当前生成尝试序号；暂停/继续和保留式断流续传不递增，新的生成尝试递增。 */
  generationAttempt?: number;
  /** E2：只有完整正式切片落库后才写入；存于既有 research_tasks.record_json。 */
  sliceCount?: number;
  /** 入队时冻结的联网模式；旧任务缺省按 off 读取。 */
  webSearchMode?: WebSearchMode;
  /** @deprecated read-only compatibility for historical records. New tasks do not write it. */
  allowWebSearch?: boolean;
  /** 提交时冻结的完整执行意图；恢复与自动重试必须复用。 */
  executionIntent?: ResearchExecutionIntent;
  /** 联网后端真实尝试的公开审计摘要。 */
  webSearchAudit?: ResearchWebSearchAudit;
  /** Runtime-produced public execution events for the current generation attempt. */
  executionEvents?: ResearchExecutionEventRecord[];
  /** 本任务入队时按实际 chat/research 路由归一化后的有效值；旧任务缺省为 false。 */
  thinkingEnabled?: boolean;
  groundingScope?: ResearchGroundingScope;
  /** plan-then-write 长文任务的逐节计划与进度；仅存于 record_json，用于断点续扩。 */
  bodyPlan?: ResearchBodyPlan;
  /** 单轮流式断点：周期性落盘的已接收正文前缀；流被切断/重启后从断点续传，不整篇重来。 */
  streamCheckpoint?: { content: string; updatedAt: string; protocolPrefix?: string };
  /** 主回答上下文的无正文来源快照与准入审计；用于暂停/恢复稳定性校验。 */
  contextAssemblySnapshot?: ResearchContextAssemblySnapshot;
  /** 当前生成尝试使用的版本化对话语义快照；暂停/恢复复用，新生成尝试重新解析。 */
  conversationContextSnapshot?: ConversationContext;
  /** 当前生成尝试使用的版本化派生回答计划；不属于正文、事实、搜索或普通导出。 */
  answerPlanSnapshot?: AnswerPlan;
  /** Category-only explanation for the current answer; never contains candidate text or hidden prompts. */
  contextExplanations?: ContextExplanationCode[];
  error?: ResearchTaskError;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ResearchSessionView {
  session: ResearchSessionRecord;
  /** 只包含会话主线消息；研究分支消息通过研究分支视图获取。 */
  messages: ResearchMessageRecord[];
  tasks: ResearchTaskRecord[];
  groundingSources?: ResearchGroundingSourceRecord[];
  citations?: ResearchCitationRecord[];
  attachments?: ResearchAttachmentRecord[];
  importTasks?: ResearchImportTaskRecord[];
  branches?: ResearchBranchRecord[];
}

/** 节点视图（阶段 H）：一个节点内的完整消息、任务与来源。 */
export interface ResearchNodeView {
  node: ResearchNodeRecord;
  session: ResearchSessionRecord;
  messages: ResearchMessageRecord[];
  tasks: ResearchTaskRecord[];
  /** H3b：按消息 ID 返回已校验的术语位置；缺失时客户端按原文渲染。 */
  termDetections?: Record<string, TermDetectionResult>;
  childNodes?: ResearchNodeRecord[];
  groundingSources?: ResearchGroundingSourceRecord[];
  citations?: ResearchCitationRecord[];
  attachments?: ResearchAttachmentRecord[];
  importTasks?: ResearchImportTaskRecord[];
  /** E1：按消息 ID 返回切片列表（#43 起为卡片骨架，不含正文副本；正文由客户端从消息正文派生）；缺失时客户端按原消息块渲染。 */
  slices?: Record<string, ResearchSliceRecord[]>;
  /** F1：该节点相关的融合提议列表；缺失时客户端不呈现弱提示。 */
  fusionProposals?: ResearchFusionProposalRecord[];
  /** #35：按消息 ID 返回正文版本；可选字段，缺失时前端按消息正文渲染。 */
  bodyVersions?: Record<string, ResearchBodyVersionRecord>;
  /** 长回答按消息 ID 返回与当前正文版本绑定的统一章节旁路视图。 */
  chapters?: Record<string, ResearchChapterParseView>;
  /** 正式融合确认稿是独立于可继续对话消息的不可变正文。 */
  confirmedFusion?: ResearchConfirmedFusionSnapshotRecord;
  /** 正式融合直接来源的当前健康投影；快照本身仍只保存确认时的固定事实。 */
  confirmedFusionSources?: ResearchFusionSource[];
}

export interface ResearchTurnAccepted {
  session: ResearchSessionRecord;
  inputMessage: ResearchMessageRecord;
  outputMessage: ResearchMessageRecord;
  task: ResearchTaskRecord;
}

export type ResearchTaskEvent =
  | { id?: number; type: "snapshot"; task: ResearchTaskRecord; message: ResearchMessageRecord; createdAt: string }
  | { id: number; type: "delta"; delta: string; message: ResearchMessageRecord; createdAt: string }
  | { id: number; type: "citation_candidate"; candidate: ResearchCitationCandidate; message: ResearchMessageRecord; createdAt: string }
  | { id: number; type: "execution"; taskId: string; execution: ResearchExecutionEventRecord; message?: ResearchMessageRecord; createdAt: string }
  | { id: number; type: "completed"; task: ResearchTaskRecord; message: ResearchMessageRecord; createdAt: string }
  | { id: number; type: "failed"; task: ResearchTaskRecord; message: ResearchMessageRecord; createdAt: string }
  | { id: number; type: "stopped"; task: ResearchTaskRecord; message: ResearchMessageRecord; createdAt: string };

export function validateResearchSessionInput(value: unknown): asserts value is { title?: string } {
  if (value === undefined || value === null) return;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Research session input must be an object");
  const title = (value as { title?: unknown }).title;
  if (title !== undefined && (typeof title !== "string" || !title.trim() || title.trim().length > 200)) {
    throw new Error("title must contain 1 to 200 characters");
  }
}

export function validateProjectInput(value: unknown): asserts value is ProjectInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Project input must be an object");
  const name = (value as { name?: unknown }).name;
  if (typeof name !== "string" || !name.trim()) throw new Error("name is required");
  if (name.trim().length > RESEARCH_TITLE_MAX_CHARACTERS) throw new Error(`name must not exceed ${RESEARCH_TITLE_MAX_CHARACTERS} characters`);
}

export function validateResearchSessionUpdateInput(value: unknown): asserts value is ResearchSessionUpdateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Research session update must be an object");
  const input = value as { title?: unknown; projectId?: unknown; status?: unknown; isFavorite?: unknown };
  if (input.title !== undefined) {
    if (typeof input.title !== "string" || !input.title.trim()) throw new Error("title must contain 1 to 40 characters");
    if (input.title.trim().length > RESEARCH_TITLE_MAX_CHARACTERS) throw new Error(`title must not exceed ${RESEARCH_TITLE_MAX_CHARACTERS} characters`);
  }
  if (input.projectId !== undefined && input.projectId !== null && typeof input.projectId !== "string") {
    throw new Error("projectId must be a string or null");
  }
  if (input.status !== undefined && input.status !== "active" && input.status !== "archived") {
    throw new Error('status must be "active" or "archived"');
  }
  if (input.isFavorite !== undefined && typeof input.isFavorite !== "boolean") {
    throw new Error("isFavorite must be a boolean");
  }
  if (input.title === undefined && input.projectId === undefined && input.status === undefined && input.isFavorite === undefined) {
    throw new Error("At least one of title, projectId, status, or isFavorite is required");
  }
}

export function validateResearchImportHeaders(fileName: unknown, mimeType: unknown): asserts mimeType is ResearchImportMimeType {
  if (typeof fileName !== "string" || !fileName.trim()) throw new Error("X-File-Name is required");
  if (fileName.trim().length > 255) throw new Error("File name must not exceed 255 characters");
  if (/[\0-\x1f\x7f]/.test(fileName)) throw new Error("File name contains unsupported control characters");
  if (typeof mimeType !== "string" || !RESEARCH_IMPORT_MIME_TYPES.includes(mimeType as ResearchImportMimeType)) {
    throw new Error("Unsupported file type. Use TXT, Markdown, DOCX, or PDF");
  }
}

export function validateResearchMessageInput(value: unknown): asserts value is { content: string; webSearchMode?: WebSearchMode; allowWebSearch?: boolean; thinkingEnabled?: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Research message input must be an object");
  const input = value as { content?: unknown; webSearchMode?: unknown; allowWebSearch?: unknown; thinkingEnabled?: unknown };
  const content = input.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("content is required");
  if (content.length > 200_000) throw new Error("content must not exceed 200000 characters");
  normalizeWebSearchModeInput(input);
  if (input.thinkingEnabled !== undefined && typeof input.thinkingEnabled !== "boolean") throw new Error("thinkingEnabled must be a boolean when provided");
}

export function validateComposerPreferences(value: unknown): asserts value is ComposerPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Composer preferences must be an object");
  const preferences = value as { webSearchMode?: unknown; allowWebSearch?: unknown; thinkingEnabled?: unknown };
  normalizeWebSearchModeInput(preferences);
  if (preferences.webSearchMode === undefined && preferences.allowWebSearch === undefined) throw new Error("webSearchMode is required");
  if (typeof preferences.thinkingEnabled !== "boolean") throw new Error("thinkingEnabled must be a boolean");
}

// ── Deep Research (MVP 阶段 C) ─────────────────────────────

/** 深入研究去向：沿当前内容建立研究分支，或以当前选区开启独立研究会话。 */
export type DeepResearchMode = "branch" | "session";

/**
 * 研究分支记录。分支挂在选区所属会话内，分支消息通过
 * `ResearchMessageRecord.branchId` 与会话主线消息区分。
 * `selectionId` 是来源关系的唯一依据：先于第一轮生成任务保存，
 * 生成失败、重试或服务重启都不删除。
 */
export interface ResearchBranchRecord {
  id: string;
  sessionId: string;
  selectionId: string;
  status: "active";
  createdAt: string;
  updatedAt: string;
}

export interface DeepResearchInput {
  mode: DeepResearchMode;
  /** 用户的研究方向；独立会话由界面提供输入框，分支模式可省略。 */
  direction?: string;
  /** 独立研究会话标题；省略时按选区原文确定性派生，不依赖 AI。 */
  title?: string;
  /** 本次第一轮联网模式，默认关闭。 */
  webSearchMode?: WebSearchMode;
  /** @deprecated input-only compatibility alias. */
  allowWebSearch?: boolean;
  /** 本次任务是否偏好深度思考；服务端仍按 research 实际路由归一化。 */
  thinkingEnabled?: boolean;
}

/** 从选区/弱标记生长子节点的输入（阶段 H）。 */
export interface CreateChildNodeInput {
  /** 用户补充的研究问题；省略时由系统根据选区原文生成默认追问。 */
  query?: string;
  /** 本次首轮联网模式，默认关闭。 */
  webSearchMode?: WebSearchMode;
  /** @deprecated input-only compatibility alias. */
  allowWebSearch?: boolean;
  /** 新节点继承父偏好后，本次首轮提交可携带当前思考偏好。 */
  thinkingEnabled?: boolean;
}

export const CHILD_NODE_QUERY_MAX_CHARACTERS = 2000;

export function validateCreateChildNodeInput(value: unknown): asserts value is CreateChildNodeInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Child node input must be an object");
  const input = value as { query?: unknown; webSearchMode?: unknown; allowWebSearch?: unknown; thinkingEnabled?: unknown };
  if (input.query !== undefined) {
    if (typeof input.query !== "string" || !input.query.trim()) {
      throw new Error("query must be a non-empty string when provided");
    }
    if (input.query.length > CHILD_NODE_QUERY_MAX_CHARACTERS) {
      throw new Error(`query must not exceed ${CHILD_NODE_QUERY_MAX_CHARACTERS} characters`);
    }
  }
  normalizeWebSearchModeInput(input);
  if (input.thinkingEnabled !== undefined && typeof input.thinkingEnabled !== "boolean") throw new Error("thinkingEnabled must be a boolean when provided");
}

export function validateResearchTermPreviewInput(value: unknown): asserts value is ResearchTermPreviewInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Term preview input must be an object");
  const input = value as { messageId?: unknown; marker?: unknown };
  if (typeof input.messageId !== "string" || !input.messageId.trim()) throw new Error("messageId is required");
  if (!input.marker || typeof input.marker !== "object" || Array.isArray(input.marker)) throw new Error("marker is required");
  const marker = input.marker as Partial<TermMarker>;
  if (typeof marker.text !== "string" || !marker.text.trim()) throw new Error("marker.text is required");
  const blockOrdinal = marker.blockOrdinal;
  const startOffset = marker.startOffset;
  const endOffset = marker.endOffset;
  if (typeof blockOrdinal !== "number" || !Number.isSafeInteger(blockOrdinal) || blockOrdinal < 0) throw new Error("marker.blockOrdinal must be a non-negative integer");
  if (typeof startOffset !== "number" || !Number.isSafeInteger(startOffset) || startOffset < 0) throw new Error("marker.startOffset must be a non-negative integer");
  if (typeof endOffset !== "number" || !Number.isSafeInteger(endOffset) || endOffset <= startOffset) throw new Error("marker.endOffset must be greater than marker.startOffset");
  if (endOffset - startOffset !== marker.text.length) throw new Error("marker offsets must match marker.text");
  const categories: TermCategory[] = ["concept", "entity", "abbreviation", "notation"];
  if (!categories.includes(marker.category as TermCategory)) {
    throw new Error("marker.category is invalid");
  }
  if (marker.location !== undefined) {
    validateResearchStableLocation(marker.location);
    if (marker.location.contentId !== input.messageId) throw new Error("marker.location must reference messageId");
  }
}

/** 生长请求体验证：整个 body 可为空对象；mention 存在时复用预览输入的完整校验。 */
export function validateResearchTermPreviewGrowthInput(value: unknown): asserts value is ResearchTermPreviewGrowthInput {
  if (value === undefined || value === null) return;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Term preview growth input must be an object");
  const input = value as { mention?: unknown };
  if (input.mention !== undefined) validateResearchTermPreviewInput(input.mention);
}

export const RESEARCH_DIRECTION_MAX_CHARACTERS = 2000;

export function validateDeepResearchInput(value: unknown): asserts value is DeepResearchInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Deep research input must be an object");
  const input = value as { mode?: unknown; direction?: unknown; title?: unknown; webSearchMode?: unknown; allowWebSearch?: unknown; thinkingEnabled?: unknown };
  if (input.mode !== "branch" && input.mode !== "session") throw new Error("mode must be branch or session");
  if (input.direction !== undefined) {
    if (typeof input.direction !== "string" || !input.direction.trim()) {
      throw new Error("direction must be a non-empty string when provided");
    }
    if (input.direction.length > RESEARCH_DIRECTION_MAX_CHARACTERS) {
      throw new Error(`direction must not exceed ${RESEARCH_DIRECTION_MAX_CHARACTERS} characters`);
    }
  }
  if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 200)) {
    throw new Error("title must contain 1 to 200 characters when provided");
  }
  normalizeWebSearchModeInput(input);
  if (input.thinkingEnabled !== undefined && typeof input.thinkingEnabled !== "boolean") throw new Error("thinkingEnabled must be a boolean when provided");
}

export const RESEARCH_TITLE_MAX_CHARACTERS = 40;

/**
 * 深入研究标题的确定性默认值：取选区原文第一句（到首个句末标点或换行为止）；
 * 没有句末标点时截取前 40 个字符。不依赖 AI，前后端可复用。
 */
export function deriveDefaultResearchTitle(selectionText: string): string {
  const text = selectionText.trim();
  if (!text) return "深入研究";
  let end = -1;
  for (const terminator of ["。", "！", "？", "!", "?", "．", ".", "\n"]) {
    const index = text.indexOf(terminator);
    if (index > 0 && (end < 0 || index < end)) end = index;
  }
  const base = (end > 0 ? text.slice(0, end) : text).trim() || text;
  return base.length > RESEARCH_TITLE_MAX_CHARACTERS ? `${base.slice(0, RESEARCH_TITLE_MAX_CHARACTERS)}…` : base;
}

/**
 * 深入研究第一轮生成上下文：只包含当前已有材料（来源内容 + 选区上下文），
 * 不包含联网检索结果。界面按固定文案如实说明材料范围。
 */
export interface DeepResearchContext {
  mode: DeepResearchMode;
  selectionText: string;
  contentTitle?: string;
  contextBefore?: string;
  contextAfter?: string;
}

/**
 * 深入研究创建结果。分支或带来源的新会话与第一轮任务在同一事务中创建；
 * `session` 始终是研究去向会话，`branch` 仅在分支模式出现。
 */
export interface DeepResearchAccepted {
  mode: DeepResearchMode;
  session: ResearchSessionRecord;
  branch?: ResearchBranchRecord;
  selection: ResearchSelectionRecord;
  inputMessage: ResearchMessageRecord;
  outputMessage: ResearchMessageRecord;
  task: ResearchTaskRecord;
}

/**
 * 子节点创建结果（阶段 H）。
 * 新节点与第一轮任务在同一事务中创建；生成失败不删除节点与来源关系。
 */
export interface NodeGrowthAccepted {
  node: ResearchNodeRecord;
  session: ResearchSessionRecord;
  /** 来源选区；确认式融合节点无选区（#31），该字段可为空。 */
  selection?: ResearchSelectionRecord;
  inputMessage: ResearchMessageRecord;
  outputMessage: ResearchMessageRecord;
  task: ResearchTaskRecord;
}

/** 术语预览创建结果；selection 保存原消息与术语位置，供点击生长时建立来源关系。 */
export interface ResearchTermPreviewAccepted {
  preview: ResearchTermPreviewRecord;
  selection: ResearchSelectionRecord;
}

/**
 * 会话节点树的扁平条目（阶段 H2 全屏树导航）。
 * 一次性返回整个会话的全部节点，客户端按 parentNodeId 自行构建树。
 * label 是 H6 节点命名落地前的确定性临时标签，不依赖 AI。
 */
export interface ResearchSessionNodeTreeItem {
  node: ResearchNodeRecord;
  /** 根节点为会话标题；子节点优先来源选区摘要，其次首条用户消息摘要。 */
  label: string;
  /** 来源选区原文摘要（存在来源选区时）。 */
  originText?: string;
  /** 首条用户消息摘要（无来源选区时作为标签回退）。 */
  firstMessage?: string;
}

// ── Research Edge Model & Graph Projection (D1) ───────────────────

/** 边的类型：父子（节点血统）、语义相关、融合来源。 */
export const RESEARCH_EDGE_KINDS = ["parent-child", "semantic-related", "fused-from"] as const;
export type ResearchEdgeKind = (typeof RESEARCH_EDGE_KINDS)[number];

/**
 * 节点系统目标模型中的永久关系。`semantic-related` 仅属于迁移期旧实现，
 * 不得通过新的永久事实接口写入或返回。
 */
export const RESEARCH_PERMANENT_EDGE_KINDS = ["parent-child", "fused-from"] as const;
export type ResearchPermanentEdgeKind = (typeof RESEARCH_PERMANENT_EDGE_KINDS)[number];

/** 边的状态。active 为正常可用，deleted 为软删除保留。 */
export type ResearchEdgeStatus = "active" | "deleted";

/**
 * 类型化边记录（D1）。连接两个研究节点，携带类型、创建时间和状态。
 * 边创建幂等：UNIQUE(kind, fromNodeId, toNodeId) 保证刷新与重试不重复建边。
 */
export interface ResearchEdgeRecord {
  id: string;
  kind: ResearchEdgeKind;
  fromNodeId: string;
  toNodeId: string;
  createdAt: string;
  status: ResearchEdgeStatus;
  /** #31：融合来源边携带该来源贡献的语义片段 ID 并集（存 record_json，画布读取不受影响）。 */
  sourceFragmentIds?: string[];
}

/**
 * 图投影（D1）：以当前节点为中心的关系视图。
 * 由契约层纯函数从节点集合与边集合确定性派生，
 * 非血统边成环、缺失节点、多根情形均可复算且安全降级。
 */
export interface ResearchGraphProjection {
  /** 投影包含的节点摘要。 */
  nodes: ResearchGraphNodeSummary[];
  /** 投影包含的类型化边。 */
  edges: ResearchEdgeRecord[];
  /** 当前焦点节点 ID。 */
  focusNodeId: string;
}

/**
 * 图投影中的节点摘要：节点记录 + 确定性标签 + 深度（相对焦点）。
 * 标签规则与 ResearchSessionNodeTreeItem 一致：
 * displayName > 来源选区摘要 > 首条用户消息摘要 > 节点 ID 前 8 字符。
 */
export interface ResearchGraphNodeSummary {
  node: ResearchNodeRecord;
  /** 节点在投影中的标签（导航呈现用）。 */
  label: string;
  /** 相对焦点节点的深度；焦点为 0，邻居为 ±1，逐层外扩。 */
  depth: number;
}

/**
 * 从节点血统确定性派生父子边。
 * 遍历节点列表，对每个有 parentNodeId 的节点生成一条 parent-child 边。
 * 边的 ID 由 kind + fromNodeId + toNodeId 确定性派生（FNV-1a），保证幂等。
 * 缺失父节点（parentNodeId 指向不存在的节点）时跳过该边，不抛错。
 */
export function deriveParentChildEdges(
  nodes: readonly ResearchNodeRecord[],
): ResearchEdgeRecord[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: ResearchEdgeRecord[] = [];
  for (const node of nodes) {
    if (!node.parentNodeId) continue;
    if (!nodeIds.has(node.parentNodeId)) continue;
    const id = researchEdgeId("parent-child", node.parentNodeId, node.id);
    edges.push({
      id,
      kind: "parent-child",
      fromNodeId: node.parentNodeId,
      toNodeId: node.id,
      createdAt: node.createdAt,
      status: "active",
    });
  }
  return edges;
}

/**
 * 边 ID 的确定性派生：FNV-1a(kind + ":" + fromNodeId + ":" + toNodeId)。
 * 与选区幂等键同源规则，保证同一三元组始终生成同一 ID。
 */
export function researchEdgeId(kind: ResearchEdgeKind, fromNodeId: string, toNodeId: string): string {
  const input = `${kind}:${fromNodeId}:${toNodeId}`;
  return `edge:${fnv1a32(input)}`;
}

/**
 * 构建图投影：以 focusNodeId 为中心，逐层邻居扩展。
 * - 焦点节点 depth=0；
 * - 父子边连接的直接邻居 depth=±1（父 -1、子 +1）；
 * - 非血统边（semantic-related / fused-from）的邻居 depth 按最短路径；
 * - 成环边安全跳过（visited 集合防无限循环）；
 * - 缺失节点（边指向不在节点集合中的 ID）安全跳过；
 * - 多根（多个无父节点）不影响投影：焦点可达的全部节点均进入投影。
 *
 * maxDepth 控制扩展层数，默认 2（焦点 ± 2 层）。
 */
export function buildGraphProjection(
  allNodes: readonly ResearchNodeRecord[],
  allEdges: readonly ResearchEdgeRecord[],
  focusNodeId: string,
  options: { maxDepth?: number; nodeLabel?: (node: ResearchNodeRecord) => string } = {},
): ResearchGraphProjection {
  const maxDepth = options.maxDepth ?? 2;
  const nodeMap = new Map<string, ResearchNodeRecord>();
  for (const node of allNodes) nodeMap.set(node.id, node);

  const focusNode = nodeMap.get(focusNodeId);
  if (!focusNode) {
    return { nodes: [], edges: [], focusNodeId };
  }

  // 构建邻接表（无向图，边权重=1）
  const adjacency = new Map<string, Array<{ neighborId: string; edge: ResearchEdgeRecord }>>();
  const activeEdges = allEdges.filter((edge) => edge.status === "active");
  for (const edge of activeEdges) {
    if (!nodeMap.has(edge.fromNodeId) || !nodeMap.has(edge.toNodeId)) continue;
    if (!adjacency.has(edge.fromNodeId)) adjacency.set(edge.fromNodeId, []);
    if (!adjacency.has(edge.toNodeId)) adjacency.set(edge.toNodeId, []);
    adjacency.get(edge.fromNodeId)!.push({ neighborId: edge.toNodeId, edge });
    adjacency.get(edge.toNodeId)!.push({ neighborId: edge.fromNodeId, edge });
  }

  // BFS 从焦点扩展
  const visited = new Map<string, number>(); // nodeId → depth
  const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: focusNodeId, depth: 0 }];
  visited.set(focusNodeId, 0);
  const projectedNodeIds = new Set<string>();
  const projectedEdgeIds = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth > maxDepth) continue;
    projectedNodeIds.add(current.nodeId);
    const neighbors = adjacency.get(current.nodeId) ?? [];
    for (const { neighborId, edge } of neighbors) {
      if (visited.has(neighborId)) {
        // 成环：仍把边加入投影（如果两端都在投影中），但不重复入队
        if (projectedNodeIds.has(neighborId)) projectedEdgeIds.add(edge.id);
        continue;
      }
      visited.set(neighborId, current.depth + 1);
      queue.push({ nodeId: neighborId, depth: current.depth + 1 });
    }
  }

  // 第二轮：把投影节点之间的所有边都加入（包括 BFS 未走过的跨层边）
  for (const edge of activeEdges) {
    if (projectedNodeIds.has(edge.fromNodeId) && projectedNodeIds.has(edge.toNodeId)) {
      projectedEdgeIds.add(edge.id);
    }
  }

  const labelFn = options.nodeLabel ?? defaultGraphNodeLabel;
  const nodes: ResearchGraphNodeSummary[] = [];
  for (const nodeId of projectedNodeIds) {
    const node = nodeMap.get(nodeId)!;
    const depth = visited.get(nodeId) ?? 0;
    nodes.push({
      node,
      label: labelFn(node),
      depth,
    });
  }
  // 按 depth 绝对值排序，同层按创建时间
  nodes.sort((a, b) => {
    const depthDiff = Math.abs(a.depth) - Math.abs(b.depth);
    if (depthDiff !== 0) return depthDiff;
    return a.node.createdAt.localeCompare(b.node.createdAt);
  });

  // 只返回两个端点都在本次深度投影中的边，避免 maxDepth=0/1 泄漏层外关系。
  const edges = activeEdges.filter(
    (edge) => projectedEdgeIds.has(edge.id)
      && projectedNodeIds.has(edge.fromNodeId)
      && projectedNodeIds.has(edge.toNodeId),
  );

  return { nodes, edges, focusNodeId };
}

/** 图投影节点的默认标签：displayName > "node-" + id 前 8 字符。 */
function defaultGraphNodeLabel(node: ResearchNodeRecord): string {
  if (node.displayName) return node.displayName;
  return `node-${node.id.slice(0, 8)}`;
}

/** FNV-1a 32-bit 确定性摘要（与选区幂等键同源）。 */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface ResearchBranchView {
  branch: ResearchBranchRecord;
  session: ResearchSessionRecord;
  selection: ResearchSelectionRecord;
  /** 分支内消息，按创建顺序。 */
  messages: ResearchMessageRecord[];
  /** 输入消息属于该分支的任务。 */
  tasks: ResearchTaskRecord[];
  groundingSources?: ResearchGroundingSourceRecord[];
  citations?: ResearchCitationRecord[];
}

// ── Research Later (MVP 阶段 D) ─────────────────────────────

/** 兼容旧数据的项目状态；当前用户路径统一呈现为标记，不再展示状态切换。 */
export type ResearchLaterItemStatus = "pending" | "done";

/** 用户优先级为一至五星；省略时默认三星。 */
export const RESEARCH_LATER_PRIORITY_MIN = 1;
export const RESEARCH_LATER_PRIORITY_MAX = 5;
export const RESEARCH_LATER_DEFAULT_PRIORITY = 3;
/** 用户概括的最大长度；默认值由确定性派生函数生成，不超过 80 字符。 */
export const RESEARCH_LATER_SUMMARY_MAX_CHARACTERS = 200;
export const RESEARCH_LATER_DEFAULT_SUMMARY_CHARACTERS = 80;
/** 用户笔记的最大长度（修订二：标记与笔记）。空笔记等价于无笔记（纯标记）。 */
export const RESEARCH_LATER_NOTE_MAX_CHARACTERS = 2_000;

/**
 * 标记项目（沿用旧 research_later_items 存储名）。保存、展示和返回来源不依赖 AI：
 * `selectionId` 是来源关系的唯一依据，选区原文与位置由选区记录保留；
 * `summary` 默认值确定性派生，`priority` 由用户设置的一至五星表达；
 * 修订二的标记流程只用 `note`（用户笔记，缺省为纯标记），星级 / 概括 / 状态字段闲置保留。
 */
export interface ResearchLaterItemRecord {
  id: string;
  sessionId: string;
  /** 研究节点 ID（阶段 H）。稍后再学项目所属的节点。 */
  nodeId?: string;
  selectionId: string;
  summary: string;
  priority: number;
  status: ResearchLaterItemStatus;
  /** 用户笔记（修订二）。undefined 或空表示纯标记、无笔记。 */
  note?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 标记列表视图：联接来源选区原文、节点和内容标题，
 * 前端可直接呈现选区、笔记、来源节点与时间，无需再次查询来源。
 */
export interface ResearchLaterSourceNode {
  id: string;
  label: string;
}

export interface ResearchLaterItemView {
  item: ResearchLaterItemRecord;
  selection: ResearchSelectionRecord;
  /** 消息选区为所属会话标题，快照选区为内容快照标题。 */
  sourceTitle: string;
  /** 标记所在的研究节点；旧记录按选区节点或会话根节点补齐。 */
  sourceNode: ResearchLaterSourceNode;
}

export interface ResearchLaterItemInput {
  selectionId: string;
  /** 一至五星；省略时默认三星。 */
  priority?: number;
  /** 用户概括；省略时使用确定性默认值（选区首句 / 前 80 字符）。 */
  summary?: string;
}

export interface ResearchLaterItemUpdate {
  priority?: number;
  summary?: string;
  status?: ResearchLaterItemStatus;
  /** 用户笔记（修订二）；空字符串 / 纯空白视为清除笔记（纯标记）。 */
  note?: string;
}

export function validateResearchLaterItemInput(value: unknown): asserts value is ResearchLaterItemInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Research later item input must be an object");
  const input = value as { selectionId?: unknown; priority?: unknown; summary?: unknown };
  if (typeof input.selectionId !== "string" || !input.selectionId.trim()) throw new Error("selectionId is required");
  validateResearchLaterPriority(input.priority);
  validateResearchLaterSummary(input.summary);
}

export function validateResearchLaterItemUpdate(value: unknown): asserts value is ResearchLaterItemUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Research later item update must be an object");
  const update = value as { priority?: unknown; summary?: unknown; status?: unknown; note?: unknown };
  if (update.priority === undefined && update.summary === undefined && update.status === undefined && update.note === undefined) {
    throw new Error("Update requires at least one of priority, summary, status, or note");
  }
  validateResearchLaterPriority(update.priority);
  validateResearchLaterSummary(update.summary);
  validateResearchLaterNote(update.note);
  if (update.status !== undefined && update.status !== "pending" && update.status !== "done") {
    throw new Error("status must be pending or done");
  }
}

function validateResearchLaterPriority(value: unknown): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || (value as number) < RESEARCH_LATER_PRIORITY_MIN || (value as number) > RESEARCH_LATER_PRIORITY_MAX) {
    throw new Error(`priority must be an integer between ${RESEARCH_LATER_PRIORITY_MIN} and ${RESEARCH_LATER_PRIORITY_MAX}`);
  }
}

function validateResearchLaterSummary(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !value.trim()) throw new Error("summary must be a non-empty string when provided");
  if (value.length > RESEARCH_LATER_SUMMARY_MAX_CHARACTERS) {
    throw new Error(`summary must not exceed ${RESEARCH_LATER_SUMMARY_MAX_CHARACTERS} characters`);
  }
}

/** 笔记允许空字符串（语义为清除笔记、纯标记），只要求类型为字符串且不超过上限。 */
function validateResearchLaterNote(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "string") throw new Error("note must be a string when provided");
  if (value.length > RESEARCH_LATER_NOTE_MAX_CHARACTERS) {
    throw new Error(`note must not exceed ${RESEARCH_LATER_NOTE_MAX_CHARACTERS} characters`);
  }
}

/**
 * 稍后再学概括的确定性默认值：取选区原文第一句（到首个句末标点或换行为止）；
 * 首句过长或没有句末标点时截取前 80 个字符。不依赖 AI，前后端可复用。
 */
export function deriveDefaultLaterSummary(selectionText: string): string {
  const text = selectionText.trim();
  if (!text) return "稍后再学";
  let end = -1;
  for (const terminator of ["。", "！", "？", "!", "?", "．", ".", "\n"]) {
    const index = text.indexOf(terminator);
    if (index > 0 && (end < 0 || index < end)) end = index;
  }
  const base = (end > 0 ? text.slice(0, end) : text).trim() || text;
  return base.length > RESEARCH_LATER_DEFAULT_SUMMARY_CHARACTERS
    ? `${base.slice(0, RESEARCH_LATER_DEFAULT_SUMMARY_CHARACTERS)}…`
    : base;
}

// ── Provider Grounding & Citations (MVP 阶段 E) ──────────────────────

export const RESEARCH_GROUNDING_MAX_SOURCES = 20;
export const RESEARCH_GROUNDING_TEXT_MAX_CHARACTERS = 2_000;
export const RESEARCH_GROUNDING_QUERY_MAX_CHARACTERS = 400;

export type ResearchGroundingScenario = "chat" | "deep_research_first_round" | "branch_follow_up";

/** 来源证据状态：full=抓取到全文，partial=仅搜索摘要等部分证据，none=无任何内容取得。 */
export type GroundingEvidenceStatus = "full" | "partial" | "none";

/** 抓取失败分类：#49 证据管线。瞬时失败可重试，永久失败不重试。 */
export type FetchErrorCategory =
  | "timeout" | "http_status" | "network" | "dns"
  | "private_address" | "too_large" | "content_type" | "redirect"
  | "protocol" | "content" | "blocked"
  | "circuit_open" | "backend";

/** 一次搜索/抓取阶段的失败留痕条目（#49 证据管线）。持久化前经脱敏。 */
export interface ResearchGroundingTraceEntry {
  stage: "search" | "fetch" | "qualify" | "pack";
  domain: string;
  url?: string;
  status:
    | "completed" | "partial" | "permanent_failed" | "retry_exhausted"
    | "circuit_open" | "no_results" | "backend_error"
    | "qualified" | "rejected" | "packed" | "omitted";
  /** 实际尝试次数（1 起；重试耗尽时 = 总尝试数）。 */
  attempts?: number;
  latencyMs: number;
  errorCategory?: FetchErrorCategory;
  httpStatus?: number;
  /** 重试/回退触发原因（脱敏后）。 */
  retryReason?: string;
  fallbackReason?: string;
  evidenceStatus?: GroundingEvidenceStatus;
}

/** 研究层只表达联网意图，不接触供应商工具协议或原始响应。 */
export interface ResearchGroundingRequest {
  taskId: string;
  scenario: ResearchGroundingScenario;
  requireGrounding: true;
  promptVersion: string;
}

/** 一次供应商联网尝试的净化本地轨迹。responseSummary 只能包含白名单摘要。 */
export interface ResearchGroundingRunRecord {
  id: string;
  taskId: string;
  sessionId: string;
  provider: string;
  model: string;
  capability: ProviderWebGrounding;
  scenario: ResearchGroundingScenario;
  status: ResearchGroundingScopeStatus;
  queries: string[];
  responseSummary?: Record<string, unknown>;
  /** #49：搜索/抓取各阶段失败留痕（脱敏）。 */
  trace?: ResearchGroundingTraceEntry[];
  /** #206 policy ledger and packed qualified evidence. This object has no grounded truth field. */
  evidenceBundle?: EvidenceBundle;
  /** #207 provider-independent accepted/rejected attribution decisions for the final body version. */
  citationAttribution?: CitationAttributionRunRecord;
  errorMessage?: string;
  attempt: number;
  createdAt: string;
  completedAt?: string;
}

/** 不保存供应商 HTTP 响应、认证头、Cookie 或带敏感查询参数的 URL。 */
export interface ResearchGroundingSourceRecord {
  id: string;
  runId: string;
  providerSourceId?: string;
  ordinal: number;
  title: string;
  url?: string;
  snippet?: string;
  publishedAt?: string;
  locator?: string;
  /** #49：full=抓取到全文；partial=仅搜索摘要；none=未取得内容。缺失视为未标记。 */
  evidenceStatus?: GroundingEvidenceStatus;
  createdAt: string;
}

/** 引用偏移基于最终保存的干净消息文本，与 deriveMessageBlocks 使用同一派生规则。 */
export interface ResearchCitationRecord {
  id: string;
  messageId: string;
  runId: string;
  sourceId: string;
  blockOrdinal: number;
  markerOffset: number;
  /** 新记录直接指向最终保存回答中的引用原文；旧记录保留 markerOffset 降级。 */
  location?: ResearchStableLocation;
  providerCitationId?: string;
  /** Present on #207 records; older persisted citations can omit it. */
  attributionId?: string;
  /** Present on #207 records; accepted means only this named policy accepted the attribution. */
  acceptancePolicyVersion?: typeof CITATION_SUPPORT_ACCEPTANCE_POLICY_VERSION;
  createdAt: string;
}

/**
 * Final-writer citation side-channel. A candidate without offsets only claims that
 * the source participated in the answer; consumers must not trust it or invent a placement.
 * Exact offsets are UTF-16 ranges in the final writer's raw body stream and are
 * mapped through the same cleaning boundary as visible text before persistence.
 */
export interface ResearchCitationCandidate {
  sourceOrdinal: number;
  startOffset?: number;
  endOffset?: number;
  providerCitationId?: string;
}

export const CITATION_ATTRIBUTION_SCHEMA_VERSION = "citation-attribution-run-v1" as const;
export const CITATION_ATTRIBUTION_PRODUCER_VERSION = "citation-attribution-producer-v1" as const;
export const CITATION_SUPPORT_ACCEPTANCE_POLICY_VERSION = "citation-support-acceptance-v1" as const;
export const CITATION_SUPPORT_ACCEPTANCE_MIN_CONFIDENCE = 0.8;

export type CitationAttributionStatus = "accepted" | "rejected";
export type CitationAttributionRunStatus = "completed" | "partial" | "failed" | "not_required";
export type CitationAttributionRejectionReason =
  | "source_not_found"
  | "source_not_admitted"
  | "source_content_unavailable"
  | "claim_range_missing"
  | "claim_range_invalid"
  | "claim_text_mismatch"
  | "claim_text_not_found"
  | "claim_text_ambiguous"
  | "evidence_range_invalid"
  | "evidence_text_mismatch"
  | "evidence_text_not_found"
  | "evidence_text_ambiguous"
  | "native_candidate_mismatch"
  | "support_not_confirmed"
  | "confidence_below_threshold"
  | "duplicate"
  | "producer_unavailable"
  | "producer_failed"
  | "invalid_producer_output";

export interface CitationAttributionProducerIdentity {
  kind: "provider_native" | "independent_model";
  provider: string;
  model: string;
  version: string;
}

export interface CitationAttributionTextRange {
  startOffset: number;
  endOffset: number;
  exact: string;
}

export interface CitationAttributionEvidenceIdentity {
  /** Missing only when a rejected candidate referenced no source in this grounding run. */
  sourceId?: string;
  sourceOrdinal: number;
  providerSourceId?: string;
  preparedEvidenceId?: string;
  sourceVersion?: string;
}

export interface CitationAttributionSupportCandidate {
  support: boolean;
  confidence: number;
  producer: CitationAttributionProducerIdentity;
}

/** One immutable attribution decision. It does not claim objective truth. */
export interface ResearchCitationAttributionRecord {
  id: string;
  candidateId: string;
  taskId: string;
  messageId: string;
  runId: string;
  bodyVersionId: string;
  generationAttempt: number;
  candidateProducer: CitationAttributionProducerIdentity;
  evidenceIdentity: CitationAttributionEvidenceIdentity;
  claimRange?: CitationAttributionTextRange;
  evidenceRange?: CitationAttributionTextRange;
  supportCandidate?: CitationAttributionSupportCandidate;
  acceptancePolicyVersion: typeof CITATION_SUPPORT_ACCEPTANCE_POLICY_VERSION;
  status: CitationAttributionStatus;
  rejectionReasons: readonly CitationAttributionRejectionReason[];
  providerCitationId?: string;
  /** Optional, untrusted diagnostics only; never participates in acceptance. */
  writerUsageClaimIds?: readonly string[];
  createdAt: string;
}

export interface CitationAttributionProducerCallRecord {
  batchId: string;
  mode: "verify_native" | "discover";
  provider?: string;
  model?: string;
  producerVersion: typeof CITATION_ATTRIBUTION_PRODUCER_VERSION;
  status: "completed" | "unavailable" | "failed" | "invalid_output";
  errorCode?: "producer_unavailable" | "producer_failed" | "invalid_producer_output";
}

/** Durable #207 run record stored beside, but separate from, evidence preparation facts. */
export interface CitationAttributionRunRecord {
  schemaVersion: typeof CITATION_ATTRIBUTION_SCHEMA_VERSION;
  id: string;
  taskId: string;
  messageId: string;
  groundingRunId: string;
  bodyVersionId: string;
  generationAttempt: number;
  status: CitationAttributionRunStatus;
  acceptancePolicyVersion: typeof CITATION_SUPPORT_ACCEPTANCE_POLICY_VERSION;
  producerCalls: readonly CitationAttributionProducerCallRecord[];
  invalidProposalCount: number;
  attributions: readonly ResearchCitationAttributionRecord[];
  createdAt: string;
  completedAt: string;
}

/** Structured source identity supplied to a grounded final writer. */
export interface ResearchCitationSourceIdentity {
  sourceOrdinal: number;
  providerSourceId?: string;
  title: string;
  url?: string;
  evidenceStatus?: GroundingEvidenceStatus;
}

export interface ResearchGroundingResult {
  content: string;
  scope: ResearchGroundingScope;
  run: ResearchGroundingRunRecord;
  sources: ResearchGroundingSourceRecord[];
  citations: ResearchCitationRecord[];
}

/**
 * 删除 URL 用户信息和常见凭证参数。无法解析或非 http(s) URL 时返回 undefined，
 * 防止来源预览将供应商内部标识或敏感链接暴露给用户。
 */
export function sanitizeGroundingUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:api[-_]?key|key|token|secret|signature|credential|authorization|session)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch { return undefined; }
}

/** 递归净化可保存的供应商摘要和错误；未知对象必须先经此函数。 */
export function redactGroundingValue(value: unknown, maxCharacters = RESEARCH_GROUNDING_TEXT_MAX_CHARACTERS): unknown {
  if (typeof value === "string") {
    const redacted = value
      .replace(/(authorization|api[-_]?key|token|secret|cookie|signature|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
      .replace(/\b(?:sk|AIza)[-_A-Za-z0-9]{12,}\b/g, "[REDACTED]");
    return redacted.length > maxCharacters ? `${redacted.slice(0, maxCharacters)}…` : redacted;
  }
  if (Array.isArray(value)) return value.slice(0, RESEARCH_GROUNDING_MAX_SOURCES).map((item) => redactGroundingValue(item, maxCharacters));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /(?:api[-_]?key|token|secret|authorization|cookie|credential)/i.test(key) ? "[REDACTED]" : redactGroundingValue(item, maxCharacters),
    ]));
  }
  return value;
}

/** 统一限制可记录查询；供应商未披露查询时保存空数组而不是猜测。 */
export function sanitizeGroundingQueries(queries: readonly string[]): string[] {
  return [...new Set(queries.map((query) => query.trim()).filter(Boolean).map((query) => query.slice(0, RESEARCH_GROUNDING_QUERY_MAX_CHARACTERS)))];
}

/** 验证引用只能关联同一次联网运行的来源，且锚点可映射到最终回答块。 */
export function validateResearchGroundingResult(result: ResearchGroundingResult): void {
  const evidenceBundle = result.run.evidenceBundle;
  if (evidenceBundle) {
    const bundle = evidenceBundle;
    validateEvidenceBundle(bundle);
    if (bundle.taskId !== result.run.taskId) throw new Error("Evidence bundle must reference its grounding task");
    if (result.run.status === "grounded") throw new Error("Evidence policy coverage must not be mapped to a grounded run");
    const expectedScopeStatus: ResearchGroundingScopeStatus = bundle.evidencePolicyStatus === "policy_satisfied"
      ? "evidence_prepared"
      : bundle.evidencePolicyStatus === "conflicting" ? "evidence_conflicting" : "evidence_incomplete";
    if (result.run.status !== expectedScopeStatus || (result.scope.status !== expectedScopeStatus && result.scope.status !== "grounded")) {
      throw new Error("Evidence policy coverage must keep its named run status until accepted attribution derives grounded");
    }
    if (result.scope.evidencePolicyStatus !== bundle.evidencePolicyStatus) {
      throw new Error("Grounding scope evidencePolicyStatus must match its evidence bundle");
    }
  }
  const sourceIds = new Set(result.sources.map((source) => source.id));
  if (sourceIds.size !== result.sources.length) throw new Error("Grounding source identities must be unique");
  const sourceById = new Map(result.sources.map((source) => [source.id, source]));
  if (result.sources.some((source, index) => source.runId !== result.run.id || source.ordinal !== index + 1)) throw new Error("Grounding sources must be densely ordered for their run");
  const validEvidence = new Set<GroundingEvidenceStatus>(["full", "partial", "none"]);
  if (result.sources.some((source) => source.evidenceStatus !== undefined && !validEvidence.has(source.evidenceStatus))) {
    throw new Error("Grounding source evidenceStatus must be one of full, partial, none");
  }
  const attribution = result.run.citationAttribution;
  if (attribution) {
    if (attribution.schemaVersion !== CITATION_ATTRIBUTION_SCHEMA_VERSION
      || attribution.acceptancePolicyVersion !== CITATION_SUPPORT_ACCEPTANCE_POLICY_VERSION) {
      throw new Error("Citation attribution version is unsupported");
    }
    const validRunStatuses = new Set<CitationAttributionRunStatus>(["completed", "partial", "failed", "not_required"]);
    const validAttributionStatuses = new Set<CitationAttributionStatus>(["accepted", "rejected"]);
    const validRejectionReasons = new Set<CitationAttributionRejectionReason>([
      "source_not_found", "source_not_admitted", "source_content_unavailable", "claim_range_missing",
      "claim_range_invalid", "claim_text_mismatch", "claim_text_not_found", "claim_text_ambiguous",
      "evidence_range_invalid", "evidence_text_mismatch", "evidence_text_not_found", "evidence_text_ambiguous",
      "native_candidate_mismatch", "support_not_confirmed", "confidence_below_threshold", "duplicate",
      "producer_unavailable", "producer_failed", "invalid_producer_output",
    ]);
    if (!validRunStatuses.has(attribution.status)
      || !Number.isSafeInteger(attribution.generationAttempt) || attribution.generationAttempt < 1
      || !Number.isSafeInteger(attribution.invalidProposalCount) || attribution.invalidProposalCount < 0
      || attribution.producerCalls.some((call) => (call.mode !== "verify_native" && call.mode !== "discover")
        || !["completed", "unavailable", "failed", "invalid_output"].includes(call.status)
        || call.producerVersion !== CITATION_ATTRIBUTION_PRODUCER_VERSION
        || !call.batchId.trim()
        || ((call.status === "completed" || call.status === "invalid_output") && (!call.provider?.trim() || !call.model?.trim())))) {
      throw new Error("Citation attribution run metadata is invalid");
    }
    if (attribution.taskId !== result.run.taskId || attribution.groundingRunId !== result.run.id
      || (result.citations.length > 0 && attribution.messageId !== result.citations[0]?.messageId)
      || attribution.bodyVersionId !== researchBodyVersionId(attribution.messageId, result.content)) {
      throw new Error("Citation attribution identity must match its grounding result");
    }
    const attributionIds = new Set(attribution.attributions.map((item) => item.id));
    const candidateIds = new Set(attribution.attributions.map((item) => item.candidateId));
    if (attributionIds.size !== attribution.attributions.length || candidateIds.size !== attribution.attributions.length) {
      throw new Error("Citation attribution identities must be unique");
    }
    const accepted = attribution.attributions.filter((item) => item.status === "accepted");
    for (const item of attribution.attributions) {
      if (item.taskId !== attribution.taskId || item.messageId !== attribution.messageId || item.runId !== attribution.groundingRunId
        || item.bodyVersionId !== attribution.bodyVersionId || item.generationAttempt !== attribution.generationAttempt
        || item.acceptancePolicyVersion !== attribution.acceptancePolicyVersion) {
        throw new Error("Citation attribution record identity is inconsistent");
      }
      if (!validAttributionStatuses.has(item.status)
        || !item.id.trim() || !item.candidateId.trim()
        || !Number.isSafeInteger(item.evidenceIdentity.sourceOrdinal) || item.evidenceIdentity.sourceOrdinal < 1
        || !validCitationAttributionProducer(item.candidateProducer)
        || item.rejectionReasons.some((reason) => !validRejectionReasons.has(reason))
        || (item.supportCandidate && (!validCitationAttributionProducer(item.supportCandidate.producer, "independent_model")
          || typeof item.supportCandidate.support !== "boolean"
          || !Number.isFinite(item.supportCandidate.confidence)
          || item.supportCandidate.confidence < 0 || item.supportCandidate.confidence > 1))) {
        throw new Error("Citation attribution record metadata is invalid");
      }
      for (const range of [item.claimRange, item.evidenceRange]) {
        if (range && (!Number.isSafeInteger(range.startOffset) || !Number.isSafeInteger(range.endOffset)
          || range.startOffset < 0 || range.endOffset <= range.startOffset
          || range.exact.length !== range.endOffset - range.startOffset)) {
          throw new Error("Citation attribution range is invalid");
        }
      }
      if (item.evidenceIdentity.sourceId) {
        const identifiedSource = sourceById.get(item.evidenceIdentity.sourceId);
        if (!identifiedSource || identifiedSource.ordinal !== item.evidenceIdentity.sourceOrdinal) {
          throw new Error("Citation attribution evidence identity is inconsistent");
        }
      }
      if (item.status === "accepted") {
        const source = item.evidenceIdentity.sourceId ? sourceById.get(item.evidenceIdentity.sourceId) : undefined;
        const preparedEvidence = evidenceBundle && item.evidenceIdentity.preparedEvidenceId
          ? evidenceBundle.evidence.find((evidence) => evidence.id === item.evidenceIdentity.preparedEvidenceId)
          : undefined;
        const canonicalEvidence = preparedEvidence?.excerpt ?? source?.snippet;
        if (item.rejectionReasons.length || !source
          || source.ordinal !== item.evidenceIdentity.sourceOrdinal || source.evidenceStatus === "none"
          || !item.evidenceIdentity.sourceVersion
          || !item.claimRange || !item.evidenceRange || item.supportCandidate?.support !== true
          || item.supportCandidate.producer.kind !== "independent_model"
          || !Number.isFinite(item.supportCandidate.confidence)
          || item.supportCandidate.confidence < CITATION_SUPPORT_ACCEPTANCE_MIN_CONFIDENCE
          || item.supportCandidate.confidence > 1) {
          throw new Error("Accepted citation attribution is incomplete");
        }
        if ((evidenceBundle && (!preparedEvidence
          || source.providerSourceId !== preparedEvidence.id
          || item.evidenceIdentity.sourceVersion !== preparedEvidence.contentDigest))
          || !canonicalEvidence
          || item.evidenceRange.endOffset > canonicalEvidence.length
          || canonicalEvidence.slice(item.evidenceRange.startOffset, item.evidenceRange.endOffset) !== item.evidenceRange.exact) {
          throw new Error("Accepted citation attribution evidence range is stale");
        }
        if (result.content.slice(item.claimRange.startOffset, item.claimRange.endOffset) !== item.claimRange.exact) {
          throw new Error("Accepted citation attribution claim range is stale");
        }
      } else if (!item.rejectionReasons.length) {
        throw new Error("Rejected citation attribution requires a reason");
      }
    }
    if ((attribution.status === "failed" || attribution.status === "not_required") && accepted.length > 0) {
      throw new Error("Citation attribution run status is inconsistent with accepted records");
    }
    const citedAttributionIds = new Set(result.citations.flatMap((citation) => citation.attributionId ? [citation.attributionId] : []));
    if (accepted.length !== result.citations.length || citedAttributionIds.size !== accepted.length
      || accepted.some((item) => !citedAttributionIds.has(item.id))) {
      throw new Error("Only accepted citation attributions may become citations");
    }
    const acceptedById = new Map(accepted.map((item) => [item.id, item]));
    for (const citation of result.citations) {
      const acceptedAttribution = citation.attributionId ? acceptedById.get(citation.attributionId) : undefined;
      if (!acceptedAttribution || acceptedAttribution.messageId !== citation.messageId
        || acceptedAttribution.evidenceIdentity.sourceId !== citation.sourceId
        || !citation.location
        || citation.location.bodyVersionId !== acceptedAttribution.bodyVersionId
        || citation.location.sourceRange.startOffset !== acceptedAttribution.claimRange?.startOffset
        || citation.location.sourceRange.endOffset !== acceptedAttribution.claimRange?.endOffset
        || citation.location.exact !== acceptedAttribution.claimRange?.exact) {
        throw new Error("Citation must preserve its accepted attribution source and claim range");
      }
    }
    const expectedGrounded = accepted.length > 0;
    if ((result.scope.status === "grounded") !== expectedGrounded) throw new Error("Grounded scope must be derived from accepted attribution");
    if (result.scope.citationCount !== result.citations.length
      || result.scope.sourceCount !== new Set(result.citations.map((citation) => citation.sourceId)).size) {
      throw new Error("Grounding scope counts must describe accepted citations only");
    }
  }
  const blocks = deriveMessageBlocks(result.content);
  for (const citation of result.citations) {
    if (citation.runId !== result.run.id || !sourceIds.has(citation.sourceId)) throw new Error("Citation must reference a source from the same grounding run");
    const block = blocks[citation.blockOrdinal];
    if (!block || citation.markerOffset < 0 || citation.markerOffset > block.text.length) throw new Error("Citation marker must be positioned in the final message text");
    if (citation.location) {
      validateResearchStableLocation(citation.location);
      if (citation.location.contentId !== citation.messageId) throw new Error("Citation location must reference its final message");
      const resolved = resolveResearchStableLocation(citation.location, {
        contentId: citation.messageId,
        bodyVersionId: researchBodyVersionId(citation.messageId, result.content),
        source: result.content,
      });
      if (resolved.kind === "degraded") throw new Error(`Citation stable location is invalid: ${resolved.reason}`);
    }
    if (attribution && (!citation.attributionId || citation.acceptancePolicyVersion !== attribution.acceptancePolicyVersion)) {
      throw new Error("Citation must retain its accepted attribution identity and policy version");
    }
  }
}

function validCitationAttributionProducer(
  producer: CitationAttributionProducerIdentity,
  expectedKind?: CitationAttributionProducerIdentity["kind"],
): boolean {
  return (producer.kind === "provider_native" || producer.kind === "independent_model")
    && (!expectedKind || producer.kind === expectedKind)
    && Boolean(producer.provider.trim() && producer.model.trim() && producer.version.trim());
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}


// ── Semantic Slices (E1 / E2) ─────────────────────────────────────

/**
 * 语义切片记录（#43 收缩后为「卡片骨架 + 派生元数据」）。一条助手消息可被切分为
 * 多个语义切片，每片携带标题、归一化概念与片内来源引用。切片**不保存正文副本**：
 * 正文是唯一事实源，经正文版本（`ResearchBodyVersionRecord`）与语义片段
 * （`ResearchSemanticFragmentRecord`）或消息正文确定性派生回读。
 *
 * - id：稳定唯一标识，格式 `slice:{nodeId}:{messageId}:{ordinal}`；
 * - ordinal：从 0 连续编号，同一消息内单调递增；
 * - isProvisional：true 表示由确定性规则从消息块边界派生的临时切片（历史兼容读取），
 *   false 表示由 AI 在回答生成阶段产生的正式切片。
 */
export interface ResearchSliceRecord {
  id: string;
  nodeId: string;
  messageId: string;
  ordinal: number;
  title: string;
  normalizedConcepts: string[];
  sourceRefs: ResearchCitationRecord[];
  isProvisional: boolean;
  createdAt: string;
}

/**
 * E3：送入下一轮生成的有界上下文条目；与父链上下文分别预算。
 *
 * #39 起条目经语义片段 Interface 选择：`bodyVersionId` + `fragmentId` 是稳定引用，
 * `content` 是 `resolveFragmentExcerpt` 从正文版本范围运行时派生的摘录（正文是唯一
 * 事实源，不再以独立切片内容副本为源）。正式片段可回指对应切片（`sliceId`）；
 * 按块派生的临时片段没有对应切片，`sliceId` 缺省。
 */
export interface ResearchSliceContextItem {
  fragmentId: string;
  bodyVersionId: string;
  sliceId?: string;
  nodeId: string;
  messageId: string;
  ordinal: number;
  title: string;
  content: string;
  normalizedConcepts: string[];
  sourceRefs: ResearchCitationRecord[];
  isProvisional: boolean;
  parentDistance: number;
}

export interface ResearchSliceContext {
  items: ResearchSliceContextItem[];
  tokenBudget: number;
  estimatedTokens: number;
  /** F2 接入融合语义的预留位置；E3 当前保持为空。 */
  fusionSignals: string[];
  originSelectionId?: string;
}

export const RESEARCH_NATIVE_SLICE_MAX_TITLE_CHARACTERS = 200;
export const RESEARCH_NATIVE_SLICE_MAX_CONCEPTS = 12;
export const RESEARCH_NATIVE_SLICE_MAX_CONCEPT_CHARACTERS = 160;

/**
 * 校验确定性派生切片序列的结构合法性（生成自由化后的权威切片）。
 * 其余不变量（稳定 ID、ordinal 严格递增、标题/概念/来源引用结构）与正式切片一致。
 * #43 起切片不再携带 content 字段（正文经正文版本与片段派生回读）。
 *
 * 校验失败时抛错；通过时返回 void。
 */
export function validateDerivedSlices(slices: ResearchSliceRecord[], nodeId: string, messageId: string): void {
  if (!Array.isArray(slices)) throw new Error("Slices must be an array");
  let previousOrdinal = -1;
  for (const slice of slices) {
    if (!slice || typeof slice !== "object" || Array.isArray(slice)) throw new Error("Slice must be an object");
    if (slice.nodeId !== nodeId) throw new Error(`Slice nodeId must be ${nodeId}`);
    if (slice.messageId !== messageId) throw new Error(`Slice messageId must be ${messageId}`);
    if (!Number.isSafeInteger(slice.ordinal) || slice.ordinal < 0) throw new Error(`Slice ordinal must be a non-negative integer, got ${slice.ordinal}`);
    const expectedId = `slice:${nodeId}:${messageId}:${slice.ordinal}`;
    if (slice.id !== expectedId) throw new Error(`Slice id must be ${expectedId}, got ${slice.id}`);
    if (slice.ordinal <= previousOrdinal) throw new Error(`Slice ordinals must be strictly increasing; got ${slice.ordinal} after ${previousOrdinal}`);
    previousOrdinal = slice.ordinal;
    if (typeof slice.title !== "string") throw new Error(`Slice ${slice.ordinal} title must be a string`);
    if (!Array.isArray(slice.normalizedConcepts) || slice.normalizedConcepts.some((concept) => typeof concept !== "string" || !concept.trim())) {
      throw new Error(`Slice ${slice.ordinal} normalizedConcepts must be an array of non-empty strings`);
    }
    if (!Array.isArray(slice.sourceRefs) || slice.sourceRefs.some((ref) => !ref || typeof ref !== "object" || ref.messageId !== messageId)) {
      throw new Error(`Slice ${slice.ordinal} sourceRefs must reference this message`);
    }
    if (typeof slice.isProvisional !== "boolean") throw new Error(`Slice ${slice.ordinal} isProvisional must be a boolean`);
    if (typeof slice.createdAt !== "string" || Number.isNaN(Date.parse(slice.createdAt))) throw new Error(`Slice ${slice.ordinal} createdAt must be an ISO date`);
  }
}

/**
 * 单个段落块的外部语义标注（标题/概念），由小模型事后抽取或 plan-then-write 大纲提供。
 * 缺省或字段为空时，对应切片标题给空串、概念给空数组，前端按正文摘要降级。
 */
export interface ResearchSliceAnnotation {
  title?: string;
  concepts?: string[];
}

/**
 * 确定性派生切片（生成自由化后的唯一切片来源）。正文是唯一事实源：
 * 按 `deriveMessageBlocks` 的段落边界逐块派生一个切片，**不复制正文副本**——
 * 正文经正文版本与语义片段派生回读（#43 收缩），切片只携带定位与派生元数据。
 *
 * - 两次调用结果完全一致（幂等），不修改源文本，不依赖 AI，不入库（由服务层决定持久化）。
 * - ordinalOffset 为该节点已有切片的最大 ordinal + 1（无切片时为 0），保证节点范围内 ordinal 连续唯一。
 * - 标题/概念来自 `annotations`（按块下标对齐）：plan-then-write 用大纲节标题，否则用小模型
 *   事后抽取；缺省或抽取失败时标题为空串（前端退回正文摘要）、概念为空数组（融合退回术语/分词）。
 * - isProvisional 恒为 false：在生成自由化契约下，派生切片即权威结构，不再是"临时兜底"。
 */
export function deriveMessageSlices(
  nodeId: string,
  messageId: string,
  messageContent: string,
  ordinalOffset: number = 0,
  citations: ResearchCitationRecord[] = [],
  annotations: readonly (ResearchSliceAnnotation | undefined)[] = [],
  createdAt?: string,
): ResearchSliceRecord[] {
  const blocks = deriveMessageBlocks(messageContent);
  if (blocks.length === 0) return [];
  const timestamp = createdAt ?? new Date().toISOString();
  const units = composeSectionUnits(blocks);
  // annotations 按块下标对齐：节的标注取自节起始块——有标题节该块即标题块（plan-then-write
  // 的 hint 落此），无标题节该块即被抽取的正文段。
  return units.map((unit, index) => {
    const ordinal = ordinalOffset + index;
    const annotation = annotations[unit.firstBlockOrdinal];
    const extractedTitle = (annotation?.title ?? "").trim();
    // 节标题（来自正文里的标题行）优先；抽取标题仅作无标题段的补充，且不与节标题重复。
    const title = unit.title || (extractedTitle && extractedTitle !== unit.title ? extractedTitle : "");
    const normalizedConcepts = (annotation?.concepts ?? [])
      .map((concept) => (typeof concept === "string" ? concept.trim() : ""))
      .filter(Boolean);
    const sliceCitations = citations.filter(
      (citation) => citation.blockOrdinal >= unit.firstBlockOrdinal && citation.blockOrdinal < unit.firstBlockOrdinal + unit.blockCount,
    );
    return {
      id: `slice:${nodeId}:${messageId}:${ordinal}`,
      nodeId,
      messageId,
      ordinal,
      title,
      normalizedConcepts,
      sourceRefs: sliceCitations,
      isProvisional: false,
      createdAt: timestamp,
    };
  });
}


// ── Body Version & Semantic Fragment (Issue #35) ─────────────────────

/**
 * 正文版本记录。一份研究正文的不可变版本，由正文内容确定性派生。
 *
 * - id：`body:{messageId}:{hash16}`，由归一化正文的确定性摘要决定；
 *   同一消息、同一正文反复派生得到同一 ID（幂等）。
 * - content：归一化后的正文（CRLF/CR 已归一为 LF），是片段偏移的基准。
 * - contentHash：归一化正文的确定性摘要，用于一致性校验。
 * - version：当前恒为 1；保留字段，支持未来的多版本演进。
 * - origin：`generation`=生成时由模型路径写入；`backfill`=历史回填写入。
 *
 * 正文是内容的唯一事实源；本记录不复制正文之外的新内容，仅为正文加稳定版本锚点。
 */
export interface ResearchBodyVersionRecord {
  id: string;
  messageId: string;
  nodeId: string;
  version: number;
  content: string;
  contentHash: string;
  origin: "generation" | "backfill";
  taskId?: string;
  createdAt: string;
}

/**
 * 语义片段记录。引用正文版本的一个连续范围，是上下文选择与融合引用的最小单位。
 *
 * - 片段**不存正文内容副本**，只存 `[startOffset, endOffset)` 范围；
 *   摘录由 `resolveFragmentExcerpt` 从正文版本运行时派生（验收 3）。
 * - 偏移单位是 UTF-16 code unit，与 `deriveMessageBlocks` 及选区锚点一致。
 * - `excerptChecksum` 是该范围文本的确定性摘要，作为校验值，不替代正文。
 * - `granularity`：当前恒为 `"paragraph"`（按段落/切片边界）。
 * - `isProvisional`：true 表示按消息块边界确定性派生的临时片段；
 *   false 表示按已校验的正式切片边界派生的正式片段。
 */
export interface ResearchSemanticFragmentRecord {
  id: string;
  bodyVersionId: string;
  messageId: string;
  nodeId: string;
  ordinal: number;
  startOffset: number;
  endOffset: number;
  granularity: "paragraph";
  sourceRefs: ResearchCitationRecord[];
  isProvisional: boolean;
  excerptChecksum: string;
  createdAt: string;
}

/** 片段 HTTP 视图：在记录上附运行时派生的摘录（不入库）。 */
export interface ResearchSemanticFragmentView extends ResearchSemanticFragmentRecord {
  excerpt: string;
}

/** 正文版本 HTTP 视图：版本 + 带摘录的片段。 */
export interface ResearchBodyVersionView {
  version: ResearchBodyVersionRecord;
  fragments: ResearchSemanticFragmentView[];
}

/** 正文版本/片段一致性错误的稳定码（验收 6：明确错误，不静默关联）。 */
export type BodyIntegrityErrorCode =
  | "body_version_mismatch"
  | "fragment_range_invalid"
  | "fragment_checksum_mismatch";

/** 带稳定 `code` 的一致性错误，供调用方分类处理。 */
export class BodyIntegrityError extends Error {
  readonly code: BodyIntegrityErrorCode;
  constructor(code: BodyIntegrityErrorCode, message: string) {
    super(message);
    this.name = "BodyIntegrityError";
    this.code = code;
  }
}

/** 归一化正文：CRLF / CR 归一为 LF。与 deriveMessageBlocks 的基准一致。 */
export function normalizeBodyContent(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** 归一化正文的确定性摘要（FNV-1a 32，纯 JS，前后端共用，无 node:crypto）。 */
export function hashBodyContent(content: string): string {
  let hash = 0x811c9dc5;
  const normalized = normalizeBodyContent(content);
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Shared constructor for the canonical identity of one message body revision. */
export function researchBodyVersionId(messageId: string, content: string): string {
  return `body:${messageId}:${hashBodyContent(content)}`;
}

/**
 * Prove that a body identity belongs to an exact prefix of the current content.
 * This is used only for append-only streaming handoff; it never searches by text.
 */
export function researchBodyVersionIsContentPrefix(
  messageId: string,
  bodyVersionId: string,
  currentContent: string,
  minimumSourceEnd = 0,
): boolean {
  if (!Number.isSafeInteger(minimumSourceEnd) || minimumSourceEnd < 0 || minimumSourceEnd > currentContent.length) return false;
  const idPrefix = `body:${messageId}:`;
  if (!bodyVersionId.startsWith(idPrefix)) return false;
  const hashText = bodyVersionId.slice(idPrefix.length);
  if (!/^[0-9a-f]{8}$/.test(hashText)) return false;
  const targetHash = Number.parseInt(hashText, 16) >>> 0;
  const normalized = normalizeBodyContent(currentContent);
  const minimumLength = normalizeBodyContent(currentContent.slice(0, minimumSourceEnd)).length;
  let hash = 0x811c9dc5;
  if (minimumLength === 0 && (hash >>> 0) === targetHash) return true;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
    if (index + 1 >= minimumLength && (hash >>> 0) === targetHash) return true;
  }
  return false;
}

/**
 * 确定性派生正文版本（纯函数）。同一 messageId + 同一归一化正文恒得同一记录，
 * 不依赖时钟之外的任何可变状态；createdAt 由调用方注入以保证可复现。
 */
export function deriveBodyVersion(input: {
  messageId: string;
  nodeId: string;
  content: string;
  origin: "generation" | "backfill";
  taskId?: string;
  createdAt: string;
  version?: number;
}): ResearchBodyVersionRecord {
  const content = normalizeBodyContent(input.content);
  const contentHash = hashBodyContent(content);
  const version = input.version ?? 1;
  return {
    id: researchBodyVersionId(input.messageId, content),
    messageId: input.messageId,
    nodeId: input.nodeId,
    version,
    content,
    contentHash,
    origin: input.origin,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    createdAt: input.createdAt,
  };
}

function fragmentExcerptChecksum(excerpt: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < excerpt.length; i++) {
    hash ^= excerpt.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function makeFragment(
  version: ResearchBodyVersionRecord,
  ordinal: number,
  startOffset: number,
  endOffset: number,
  sourceRefs: ResearchCitationRecord[],
  isProvisional: boolean,
): ResearchSemanticFragmentRecord {
  const excerpt = version.content.slice(startOffset, endOffset);
  return {
    id: `fragment:${version.id}:${ordinal}`,
    bodyVersionId: version.id,
    messageId: version.messageId,
    nodeId: version.nodeId,
    ordinal,
    startOffset,
    endOffset,
    granularity: "paragraph",
    sourceRefs,
    isProvisional,
    excerptChecksum: fragmentExcerptChecksum(excerpt),
    createdAt: version.createdAt,
  };
}

/**
 * 从已校验的正式切片派生正式片段。写库时 deriveMessageSlices 已按节派生（标题块并入正文），
 * 故此处复用同一 composeSectionUnits 组合，按节单元映射到块范围。
 *
 * #43 收缩后切片不再携带正文副本，对齐门从"逐字内容相等"改为结构性门：
 * 切片与节单元同源于正文的确定性派生，故数量一致（且无旧 provisional 行）即视为同源对齐；
 * 片段范围始终来自正文版本的块/节派生，摘录永远是正文版本的精确子串，绝不伪造范围。
 * 对齐门失败（旧数据或数量不一致）时退化为按块派生的临时片段。
 */
export function deriveFragmentsFromSlices(
  version: ResearchBodyVersionRecord,
  slices: ResearchSliceRecord[],
  citations: ResearchCitationRecord[] = [],
): ResearchSemanticFragmentRecord[] {
  const blocks = deriveMessageBlocks(version.content);
  const units = composeSectionUnits(blocks);
  const usable =
    slices.length > 0 &&
    slices.every((s) => !s.isProvisional) &&
    slices.length === units.length;
  if (!usable) return deriveFragmentsFromBlocks(version, citations);
  return slices.map((slice, index) => {
    const unit = units[index]!;
    const firstBlock = blocks[unit.firstBlockOrdinal];
    const lastBlock = blocks[unit.firstBlockOrdinal + unit.blockCount - 1] ?? firstBlock;
    const startOffset = firstBlock?.startOffset ?? 0;
    const endOffset = lastBlock ? lastBlock.startOffset + lastBlock.text.length : startOffset;
    const sourceRefs = citations.filter(
      (c) => c.blockOrdinal >= unit.firstBlockOrdinal && c.blockOrdinal < unit.firstBlockOrdinal + unit.blockCount,
    );
    return makeFragment(version, index, startOffset, endOffset, sourceRefs, false);
  });
}

/** 按消息块边界确定性派生临时片段（无正式切片或旧数据的兜底路径）。 */
export function deriveFragmentsFromBlocks(
  version: ResearchBodyVersionRecord,
  citations: ResearchCitationRecord[] = [],
): ResearchSemanticFragmentRecord[] {
  return deriveMessageBlocks(version.content).map((block) => {
    const sourceRefs = citations.filter((c) => c.blockOrdinal === block.ordinal);
    return makeFragment(version, block.ordinal, block.startOffset, block.startOffset + block.text.length, sourceRefs, true);
  });
}

/**
 * 从正文版本派生片段摘录（运行时唯一入口）。任何版本/范围/校验和不一致都抛出
 * 带稳定 code 的 BodyIntegrityError，绝不静默关联到其他文本（验收 6）。
 */
export function resolveFragmentExcerpt(
  version: ResearchBodyVersionRecord,
  fragment: ResearchSemanticFragmentRecord,
): string {
  if (fragment.bodyVersionId !== version.id) {
    throw new BodyIntegrityError("body_version_mismatch", `Fragment ${fragment.id} does not belong to body version ${version.id}`);
  }
  if (
    !Number.isSafeInteger(fragment.startOffset) ||
    !Number.isSafeInteger(fragment.endOffset) ||
    fragment.startOffset < 0 ||
    fragment.endOffset > version.content.length ||
    fragment.endOffset <= fragment.startOffset
  ) {
    throw new BodyIntegrityError("fragment_range_invalid", `Fragment ${fragment.id} has invalid range [${fragment.startOffset}, ${fragment.endOffset})`);
  }
  const excerpt = version.content.slice(fragment.startOffset, fragment.endOffset);
  if (fragmentExcerptChecksum(excerpt) !== fragment.excerptChecksum) {
    throw new BodyIntegrityError("fragment_checksum_mismatch", `Fragment ${fragment.id} excerpt checksum mismatch`);
  }
  return excerpt;
}


export function validateProviderDefinition(value: unknown): asserts value is ProviderDefinition {
  if (!value || typeof value !== "object") throw new Error("Provider definition must be an object");
  const definition = value as Partial<ProviderDefinition>;
  if (!definition.id?.match(/^[a-z0-9][a-z0-9_-]{1,63}$/)) throw new Error("Invalid provider id");
  if (!definition.label?.trim()) throw new Error("Provider label is required");
  if (!("openai_chat_completions" === definition.apiMode || "openai_responses" === definition.apiMode || "gemini_generate_content" === definition.apiMode || "anthropic_messages" === definition.apiMode)) throw new Error("Invalid provider apiMode");
  if (!(["bearer", "api_key_header"] as ProviderAuthMode[]).includes(definition.authMode as ProviderAuthMode)) throw new Error("Invalid provider authMode");
  const baseUrl = parseProviderBaseUrl(definition.defaultBaseUrl);
  if (baseUrl.protocol !== "https:") throw new Error("Provider base URL must use HTTPS");
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error("Provider base URL cannot contain credentials, query parameters, or fragments");
  if (!definition.defaultModel?.trim()) throw new Error("Provider defaultModel is required");
  if (!Array.isArray(definition.models) || definition.models.some((model) => typeof model !== "string" || !model.trim())) throw new Error("Provider models must be non-empty strings");
  if (!definition.capabilities || typeof definition.capabilities.structuredJson !== "boolean" || typeof definition.capabilities.modelDiscovery !== "boolean") throw new Error("Provider capabilities are required");
  if (!(["none", "openai_reasoning_content"] as ProviderReasoningOutput[]).includes(definition.capabilities.reasoningOutput)) throw new Error("Invalid provider reasoningOutput");
  if (!(["none", "openai_compatible"] as ProviderThinkingMode[]).includes(definition.capabilities.thinkingMode)) throw new Error("Invalid provider thinkingMode");
  if (!(["unsupported", "openai_web_search", "gemini_google_search", "anthropic_web_search"] as ProviderWebGrounding[]).includes(definition.capabilities.webGrounding)) throw new Error("Invalid provider webGrounding");
}

function parseProviderBaseUrl(value: unknown): URL {
  if (typeof value !== "string" || !value.trim()) throw new Error("Provider base URL is required");
  try { return new URL(value); }
  catch { throw new Error("Provider base URL must be an absolute URL"); }
}

// ── Term Detection (H3a) ──────────────────────────────────────────

/** 概念术语的分类。 */
export type TermCategory = "concept" | "entity" | "abbreviation" | "notation";

/**
 * 单个检测到的术语及其在消息块内的精确位置。
 * 偏移相对块文本（与 deriveMessageBlocks 产出的 MessageContentBlock.text 对齐），
 * 消费方通过 blockOrdinal 定位块、用 startOffset/endOffset 切片块文本。
 */
export interface TermMarker {
  /** 一次具体提及的稳定身份；同一实体的不同出现位置各不相同。 */
  mentionId?: string;
  /** 当前回答内的实体身份；同一对象的多个提及共享，不跨回答继承。 */
  entityId?: string;
  /** 术语原文（来自消息块文本的切片）。 */
  text: string;
  /** 消息块序号（与 deriveMessageBlocks 对齐）。 */
  blockOrdinal: number;
  /** 术语在块文本中的起始偏移（UTF-16 code unit，与 String.prototype.slice 一致）。 */
  startOffset: number;
  /** 术语在块文本中的结束偏移（exclusive）。 */
  endOffset: number;
  /** 术语分类。 */
  category: TermCategory;
  /** 新检测结果指向消息规范正文；旧结果仍可按块内偏移验证后使用。 */
  location?: ResearchStableLocation;
}

export const TERM_MARKER_EXTRACTION_PROMPT_VERSION = "term-marker-extraction-v1";

export type ResearchTermMarkerTaskStatus = "queued" | "running" | "completed" | "failed";
export type ResearchTermMarkerTaskErrorCode =
  | "model_not_configured"
  | "provider_error"
  | "invalid_output"
  | "message_missing"
  | "service_restarted";

/** 模型抽取的窄候选；服务必须用正文块逐字复核后才能提升为 TermMarker。 */
export interface ResearchTermMarkerCandidate {
  blockOrdinal: number;
  startOffset: number;
  endOffset: number;
  text: string;
  category: TermCategory;
  /** 只在当前回答内有效；服务会验证字符集与长度。 */
  entityId: string;
}

/**
 * 独立弱标记任务。正文不复制进记录；bodyVersionId 指向当前观察到的规范正文。
 * processedBlockKeys 只用于避免对同一已闭合段落重复发起模型调用。
 */
export interface ResearchTermMarkerTaskRecord {
  id: string;
  sessionId: string;
  nodeId: string;
  messageId: string;
  bodyVersionId: string;
  generationAttempt: number;
  status: ResearchTermMarkerTaskStatus;
  retryable: boolean;
  fullReviewRequested: boolean;
  processedBlockKeys: string[];
  markers: TermMarker[];
  provider?: string;
  model?: string;
  promptVersion?: string;
  attempts: number;
  error?: { code: ResearchTermMarkerTaskErrorCode; message: string };
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export type ResearchPermanentEdgeRecord = Omit<ResearchEdgeRecord, "kind"> & {
  kind: ResearchPermanentEdgeKind;
};

export function isResearchPermanentEdge(edge: ResearchEdgeRecord): edge is ResearchPermanentEdgeRecord {
  return (RESEARCH_PERMANENT_EDGE_KINDS as readonly ResearchEdgeKind[]).includes(edge.kind);
}

// ── Global research observation (node system T03 / #62) ─────────

/**
 * 全局观察查询的稳定输入。布局、缩放与画布坐标不属于该契约。
 * 省略范围时包含全部未进入回收站的现存节点（含归档与孤立节点）。
 */
export type ResearchGraphLifecycle = "active" | "archived";

export interface ResearchGraphObservationInput {
  focusNodeId?: string;
  projectIds?: string[];
  /** 明确把没有项目归属的节点加入项目范围；省略时仅在未筛选项目时包含它们。 */
  includeUncategorized?: true;
  /** 省略时同时包含活跃与已归档；显式值必须是去重后的非空集合。 */
  lifecycles?: ResearchGraphLifecycle[];
  /** 节点创建时间的含下界。 */
  createdFrom?: string;
  /** 节点创建时间的不含上界。 */
  createdBefore?: string;
  relationshipKinds?: ResearchPermanentEdgeKind[];
  /** 候选详情默认不随地图摘要返回；仅候选观察主动请求时带回。 */
  includeAssociationHints?: true;
  /** 只返回触及该节点的候选详情；总数与卫星计数同步限定为该子集。 */
  associationCandidateNodeId?: string;
  /** 临时融合只在用户明确开启 B 面观察时投影；默认地图不携带候选正文或来源连接。 */
  includeTemporaryFusions?: true;
}

export type ResearchGraphObservationConnectivity = "default" | "focus" | "connected" | "unconnected";
export type ResearchGraphObservationScope = "inside-current-filter" | "outside-boundary" | "outside-bridge";
/** 融合来源健康是当前投影，不改写确认时固定的正文、快照或来源身份。 */
export type ResearchGraphFusionEvidenceHealth = "not-applicable" | "available" | "temporarily-unavailable" | "deleted" | "incomplete";

/** 图谱扫读所需的最小节点摘要；不携带正文、候选详情或语义范围正文。 */
export interface ResearchGraphObservationNode {
  node: ResearchNodeRecord;
  label: string;
  sessionTitle: string;
  projectId?: string;
  /** 扫读与无障碍解码所需的项目名称；未分类节点省略。 */
  projectName?: string;
  projectColorRole?: ProjectColorRole;
  lifecycle: "active" | "archived";
  role: "research" | "fusion";
  scope: ResearchGraphObservationScope;
  connectivity: ResearchGraphObservationConnectivity;
  candidateCount: number;
  fusionEvidenceHealth: ResearchGraphFusionEvidenceHealth;
}

export interface ResearchGraphObservationEdge {
  edge: ResearchPermanentEdgeRecord;
  connectivity: ResearchGraphObservationConnectivity;
}

/** 服务端统一产出的观察结果；画布、窄屏列表与键盘导航消费同一份 nodes/edges。 */
export interface ResearchGraphObservation {
  nodes: ResearchGraphObservationNode[];
  edges: ResearchGraphObservationEdge[];
  focusNodeId?: string;
  appliedRelationshipKinds: ResearchPermanentEdgeKind[];
  /** 当前可见节点之间的活跃候选唯一数；服务端已完成范围与节点筛选。 */
  activeCandidateCount: number;
  /** 仅 includeAssociationHints=true 时返回，避免普通地图观察携带候选证据详情。 */
  associationHints?: ResearchAssociationHintRecord[];
  /** 全局待核验候选数；关闭临时层时只提供这个数量，不返回 B 面投影。 */
  temporaryFusionCount?: number;
  /** 仅 includeTemporaryFusions=true 时返回，与 A 面共享同一坐标系但不属于永久连通图。 */
  temporaryFusions?: ResearchTemporaryFusionMapNode[];
}

// ── Cross-session research search (Issue #67) ─────────────────────

/** 搜索请求的查询文本上限；与模型输入预算无关。 */
export const RESEARCH_SEARCH_QUERY_MAX_CHARACTERS = 400;
/** 单次搜索返回的节点结果上限。 */
export const RESEARCH_SEARCH_MAX_LIMIT = 50;
/** 当前地图主要范围节点上限；只用于结果分组，不改变搜索事实范围。 */
export const RESEARCH_SEARCH_MAX_SCOPE_NODE_IDS = 10_000;

export interface ResearchSearchInput {
  query: string;
  limit?: number;
  insideNodeIds?: string[];
}

/** 搜索单元的字段身份；不得把不同来源揉成一个无来源的节点文本。 */
export type ResearchSearchField =
  | "node-title"
  | "user-question"
  | "ai-body"
  | "import-body"
  | "formal-fusion-body";

/** 命中标题时可直接打开节点；标题本身不需要复制为另一份正文。 */
export interface ResearchSearchNodeTitleLocator {
  kind: "node-title";
  nodeId: string;
}

/** 消息正文命中始终回到既有正文版本及其稳定语义范围。 */
export interface ResearchSearchMessageSemanticRangeLocator {
  kind: "message-semantic-range";
  nodeId: string;
  messageId: string;
  bodyVersionId: string;
  fragmentId: string;
  startOffset: number;
  endOffset: number;
  location?: ResearchStableLocation;
}

/** 用户问题没有正文版本副本；定位使用当前消息及其确定性字符范围。 */
export interface ResearchSearchMessageTextRangeLocator {
  kind: "message-text-range";
  nodeId: string;
  messageId: string;
  /** 当前用户问题全文摘要；原地重新编辑后旧定位必须失效。 */
  contentHash: string;
  startOffset: number;
  endOffset: number;
  location?: ResearchStableLocation;
}

/** 导入正文命中始终回到既有内容快照的一个 block。 */
export interface ResearchSearchImportBlockLocator {
  kind: "import-block";
  nodeId: string;
  contentSnapshotId: string;
  blockId: string;
  startOffset: number;
  endOffset: number;
  location?: ResearchStableLocation;
}

/** 正式融合正文以确认快照为不可变事实源，并保留窗口在该快照中的字符范围。 */
export interface ResearchSearchFusionSnapshotRangeLocator {
  kind: "fusion-snapshot-range";
  nodeId: string;
  confirmedDraftVersionId: string;
  startOffset: number;
  endOffset: number;
  location?: ResearchStableLocation;
}

export type ResearchSearchLocator =
  | ResearchSearchNodeTitleLocator
  | ResearchSearchMessageTextRangeLocator
  | ResearchSearchMessageSemanticRangeLocator
  | ResearchSearchImportBlockLocator
  | ResearchSearchFusionSnapshotRangeLocator;

interface ResearchSearchUnitBase {
  id: string;
  nodeId: string;
}

/** 当前正文派生的一个可检索单位；不携带正文副本、向量或模型细节。 */
export type ResearchSearchUnit =
  | (ResearchSearchUnitBase & { field: "node-title"; locator: ResearchSearchNodeTitleLocator })
  | (ResearchSearchUnitBase & {
    field: "user-question";
    locator: ResearchSearchMessageTextRangeLocator;
  })
  | (ResearchSearchUnitBase & {
    field: "ai-body";
    locator: ResearchSearchMessageSemanticRangeLocator;
  })
  | (ResearchSearchUnitBase & { field: "import-body"; locator: ResearchSearchImportBlockLocator })
  | (ResearchSearchUnitBase & {
    field: "formal-fusion-body";
    locator: ResearchSearchFusionSnapshotRangeLocator | ResearchSearchMessageSemanticRangeLocator;
  });

export type ResearchSearchScope = "inside-current-scope" | "outside-current-scope";
export type ResearchSearchMode = "hybrid" | "keyword-only";
export type ResearchSearchDegradationReason =
  | "model-not-installed"
  | "model-downloading"
  | "model-unavailable"
  | "index-unavailable";

export type ResearchSearchMatch = ({ preview: string } & (
  | { field: "node-title"; locator: ResearchSearchNodeTitleLocator }
  | {
    field: "user-question";
    locator: ResearchSearchMessageTextRangeLocator;
  }
  | {
    field: "ai-body";
    locator: ResearchSearchMessageSemanticRangeLocator;
  }
  | { field: "import-body"; locator: ResearchSearchImportBlockLocator }
  | {
    field: "formal-fusion-body";
    locator: ResearchSearchFusionSnapshotRangeLocator | ResearchSearchMessageSemanticRangeLocator;
  }
));

/** 同一节点下最多保留有限、可定位的相关命中；preview 是有界派生摘录，不取得正文事实权。 */
export interface ResearchSearchNodeResult {
  nodeId: string;
  nodeLabel: string;
  matches: ResearchSearchMatch[];
}

/** scope 在协议层分组，避免调用方把范围外结果伪装成当前范围命中。 */
export interface ResearchSearchResultGroup {
  scope: ResearchSearchScope;
  nodes: ResearchSearchNodeResult[];
}

export type ResearchSearchResponse = {
  query: string;
  groups: ResearchSearchResultGroup[];
} & (
  | { mode: "hybrid"; degradationReason?: never }
  | { mode: "keyword-only"; degradationReason: ResearchSearchDegradationReason }
);

/** 语义搜索模型档位独立于生成模型供应商配置，且不得静默切换。 */
export type SemanticSearchProfile = "standard" | "lightweight";
export type SemanticSearchRuntimeState =
  | "model-missing"
  | "model-downloading"
  | "model-corrupt"
  | "index-absent"
  | "index-stale"
  | "index-building"
  | "ready"
  | "resource-insufficient"
  | "failed";

export type SemanticSearchInstallationState =
  | "not-installed"
  | "downloading"
  | "installed"
  | "corrupt"
  | "failed";

export interface SemanticSearchProfileInstallationView {
  profile: SemanticSearchProfile;
  state: SemanticSearchInstallationState;
  downloadedBytes: number;
  totalBytes: number;
  canCancel: boolean;
  canRetry: boolean;
  errorCode?: string;
}

export interface SemanticSearchStatusView {
  configuredProfile: SemanticSearchProfile;
  runtimeState: SemanticSearchRuntimeState;
  installations: SemanticSearchProfileInstallationView[];
  indexProgress?: { completedUnits: number; totalUnits: number };
  errorCode?: string;
  /** 已配置下载代理时为 true；preview 隐藏凭据，只显示出口形态。 */
  downloadProxy?: { configured: boolean; preview?: string };
}

export type SemanticSearchCommand =
  | { type: "select-profile"; profile: SemanticSearchProfile }
  | { type: "download-profile"; profile: SemanticSearchProfile }
  | { type: "cancel-download"; profile: SemanticSearchProfile }
  | { type: "retry-download"; profile: SemanticSearchProfile }
  | { type: "delete-profile"; profile: SemanticSearchProfile }
  | { type: "rebuild-index" }
  /** 仅作用于模型下载的网络出口（ADR-0040）；清除时不带 proxyUrl 字段。 */
  | { type: "set-download-proxy"; proxyUrl?: string };

/** 下载代理的取值上限；仅允许 http/https 且不带路径与查询。 */
export const SEMANTIC_DOWNLOAD_PROXY_MAX_CHARACTERS = 500;

/** 校验并归一化下载代理；返回 undefined 表示清除。 */
export function normalizeSemanticDownloadProxyUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Download proxy must be a string or absent");
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > SEMANTIC_DOWNLOAD_PROXY_MAX_CHARACTERS) throw new Error("Download proxy is too long");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Download proxy must be a valid absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Download proxy must use http or https");
  if (!parsed.hostname) throw new Error("Download proxy must include a host");
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("Download proxy must be an origin URL without a path or query");
  return parsed.toString();
}

const SEMANTIC_SEARCH_PROFILE_COMMANDS = new Set<SemanticSearchCommand["type"]>([
  "select-profile",
  "download-profile",
  "cancel-download",
  "retry-download",
  "delete-profile",
]);

/** 显式模型安装与索引命令的结构校验；未知字段一律拒绝。 */
export function validateSemanticSearchCommand(value: unknown): asserts value is SemanticSearchCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Semantic search command must be an object");
  const command = value as { type?: unknown; profile?: unknown };
  if (typeof command.type !== "string") throw new Error("Semantic search command type is required");
  const keys = Object.keys(value);
  if (command.type === "rebuild-index") {
    if (keys.length !== 1 || keys[0] !== "type") throw new Error("rebuild-index command has unexpected fields");
    return;
  }
  if (command.type === "set-download-proxy") {
    if (keys.some((key) => key !== "type" && key !== "proxyUrl")) throw new Error("set-download-proxy command has unexpected fields");
    normalizeSemanticDownloadProxyUrl((value as { proxyUrl?: unknown }).proxyUrl);
    return;
  }
  if (!SEMANTIC_SEARCH_PROFILE_COMMANDS.has(command.type as SemanticSearchCommand["type"])) {
    throw new Error("Unknown semantic search command type");
  }
  if (keys.some((key) => key !== "type" && key !== "profile") || keys.length !== 2) {
    throw new Error("Semantic search profile command has unexpected fields");
  }
  if (command.profile !== "standard" && command.profile !== "lightweight") {
    throw new Error("Semantic search profile must be standard or lightweight");
  }
}

/** 共享搜索入口的结构校验；调用方仍负责参数化查询，不可把 query 拼入 SQL。 */
export function validateResearchSearchInput(value: unknown): asserts value is ResearchSearchInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Research search input must be an object");
  const input = value as { query?: unknown; limit?: unknown; insideNodeIds?: unknown };
  if (typeof input.query !== "string" || !input.query.trim() || input.query.length > RESEARCH_SEARCH_QUERY_MAX_CHARACTERS) {
    throw new Error(`query must be a non-empty string no longer than ${RESEARCH_SEARCH_QUERY_MAX_CHARACTERS} characters`);
  }
  // Control characters never reach the keyword index through the search box and
  // would flow verbatim into FTS phrase matching; reject them explicitly.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(input.query)) {
    throw new Error("query must not contain control characters");
  }
  if (input.limit !== undefined && (typeof input.limit !== "number" || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > RESEARCH_SEARCH_MAX_LIMIT)) {
    throw new Error(`limit must be an integer between 1 and ${RESEARCH_SEARCH_MAX_LIMIT}`);
  }
  if (input.insideNodeIds !== undefined && (!Array.isArray(input.insideNodeIds)
    || input.insideNodeIds.length > RESEARCH_SEARCH_MAX_SCOPE_NODE_IDS
    || input.insideNodeIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 256)
    || new Set(input.insideNodeIds).size !== input.insideNodeIds.length)) {
    throw new Error(`insideNodeIds must contain at most ${RESEARCH_SEARCH_MAX_SCOPE_NODE_IDS} unique node IDs`);
  }
}

export interface ResearchGraphObservationDerivations {
  nodeLabel?: (node: ResearchNodeRecord, session: ResearchSessionRecord) => string;
  /** 活跃临时提示由统一观察构建器在可见节点确定后筛选、计数和按需展开。 */
  activeAssociationHints?: readonly ResearchAssociationHintRecord[];
  evidenceHealthByFusionNodeId?: ReadonlyMap<string, Exclude<ResearchGraphFusionEvidenceHealth, "not-applicable">>;
}

/**
 * 从正式节点、会话与永久边确定性派生统一全局观察结果。
 * - 回收站会话首先退出普通全局范围；归档默认保留；
 * - `semantic-related` 即使仍存在于迁移期存储也不会进入目标观察；
 * - 焦点连通不接受深度参数，沿启用的永久关系遍历完整分量；
 * - 范围筛选时保留焦点到范围内节点的最短路径外部节点作为桥接节点。
 */
export function buildResearchGraphObservation(
  allNodes: readonly ResearchNodeRecord[],
  allEdges: readonly ResearchEdgeRecord[],
  sessions: readonly ResearchSessionRecord[],
  projects: readonly ProjectRecord[],
  input: ResearchGraphObservationInput = {},
  derivations: ResearchGraphObservationDerivations = {},
): ResearchGraphObservation {
  const sessionById = new Map(sessions.filter((session) => !session.trashedAt).map((session) => [session.id, session]));
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const nodeById = new Map(allNodes.filter((node) => sessionById.has(node.sessionId)).map((node) => [node.id, node]));
  const enabledKinds = input.relationshipKinds === undefined
    ? [...RESEARCH_PERMANENT_EDGE_KINDS]
    : RESEARCH_PERMANENT_EDGE_KINDS.filter((kind) => input.relationshipKinds!.includes(kind));
  const enabledKindSet = new Set<ResearchEdgeKind>(enabledKinds);
  const compareEdges = (left: ResearchPermanentEdgeRecord, right: ResearchPermanentEdgeRecord) =>
    left.kind.localeCompare(right.kind)
      || left.fromNodeId.localeCompare(right.fromNodeId)
      || left.toNodeId.localeCompare(right.toNodeId)
      || left.id.localeCompare(right.id);
  const permanentEdges = allEdges
    .filter((edge): edge is ResearchPermanentEdgeRecord =>
      edge.status === "active" && isResearchPermanentEdge(edge)
        && nodeById.has(edge.fromNodeId) && nodeById.has(edge.toNodeId))
    .sort(compareEdges);
  const traversableEdges = permanentEdges.filter((edge) => enabledKindSet.has(edge.kind));
  const projectFilter = input.projectIds?.length ? new Set(input.projectIds) : undefined;
  const filtersByProjectScope = projectFilter !== undefined || input.includeUncategorized === true;
  const lifecycleValues = input.lifecycles ?? ["active", "archived"];
  if (input.lifecycles !== undefined && (
    lifecycleValues.length === 0
    || new Set(lifecycleValues).size !== lifecycleValues.length
    || lifecycleValues.some((lifecycle) => lifecycle !== "active" && lifecycle !== "archived")
  )) {
    throw new Error("Research graph lifecycles must be a non-empty, non-duplicated active or archived set");
  }
  const lifecycleSet = new Set(lifecycleValues);
  const hasRangeFilter = filtersByProjectScope || lifecycleSet.size !== 2
    || input.createdFrom !== undefined || input.createdBefore !== undefined;

  const inScope = (node: ResearchNodeRecord): boolean => {
    const session = sessionById.get(node.sessionId);
    if (!session) return false;
    if (!lifecycleSet.has(session.status)) return false;
    if (filtersByProjectScope) {
      const matchesProject = session.projectId !== undefined && projectFilter?.has(session.projectId) === true;
      const matchesUncategorized = session.projectId === undefined && input.includeUncategorized === true;
      if (!matchesProject && !matchesUncategorized) return false;
    }
    if (input.createdFrom && node.createdAt < input.createdFrom) return false;
    if (input.createdBefore && node.createdAt >= input.createdBefore) return false;
    return true;
  };

  const inScopeIds = new Set([...nodeById.values()].filter(inScope).map((node) => node.id));
  const includedIds = new Set(inScopeIds);
  const connectedIds = new Set<string>();

  if (input.focusNodeId && nodeById.has(input.focusNodeId)) {
    const adjacency = new Map<string, string[]>();
    const addNeighbor = (nodeId: string, neighborId: string) => {
      const neighbors = adjacency.get(nodeId) ?? [];
      neighbors.push(neighborId);
      adjacency.set(nodeId, neighbors);
    };
    for (const edge of traversableEdges) {
      addNeighbor(edge.fromNodeId, edge.toNodeId);
      addNeighbor(edge.toNodeId, edge.fromNodeId);
    }
    for (const neighbors of adjacency.values()) neighbors.sort((left, right) => left.localeCompare(right));
    const parent = new Map<string, string | undefined>([[input.focusNodeId, undefined]]);
    const queue = [input.focusNodeId];
    while (queue.length) {
      const current = queue.shift()!;
      connectedIds.add(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (parent.has(neighbor)) continue;
        parent.set(neighbor, current);
        queue.push(neighbor);
      }
    }
    includedIds.add(input.focusNodeId);
    for (const nodeId of inScopeIds) {
      if (!connectedIds.has(nodeId)) continue;
      let cursor: string | undefined = nodeId;
      while (cursor !== undefined) {
        includedIds.add(cursor);
        cursor = parent.get(cursor);
      }
    }
    if (enabledKindSet.has("fused-from") && nodeById.get(input.focusNodeId)?.isFusionNode) {
      for (const edge of traversableEdges) {
        if (edge.kind === "fused-from" && edge.toNodeId === input.focusNodeId) includedIds.add(edge.fromNodeId);
      }
    }
  } else if (hasRangeFilter) {
    for (const edge of traversableEdges) {
      const fromIsInScope = inScopeIds.has(edge.fromNodeId);
      const toIsInScope = inScopeIds.has(edge.toNodeId);
      if (fromIsInScope !== toIsInScope) includedIds.add(fromIsInScope ? edge.toNodeId : edge.fromNodeId);
    }
  }

  const connectivityFor = (nodeId: string): ResearchGraphObservationConnectivity => {
    if (!input.focusNodeId) return "default";
    if (nodeId === input.focusNodeId) return "focus";
    return connectedIds.has(nodeId) ? "connected" : "unconnected";
  };
  const labelFor = derivations.nodeLabel ?? ((node: ResearchNodeRecord, session: ResearchSessionRecord) =>
    node.displayName ?? (node.id === session.id ? session.title : `节点 ${node.id.slice(0, 8)}`));

  const nodes = [...nodeById.values()]
    .filter((node) => includedIds.has(node.id))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .map((node): ResearchGraphObservationNode => {
      const session = sessionById.get(node.sessionId)!;
      const project = session.projectId ? projectById.get(session.projectId) : undefined;
      return {
        node,
        label: labelFor(node, session),
        sessionTitle: session.title,
        ...(session.projectId ? { projectId: session.projectId } : {}),
        ...(project ? { projectName: project.name } : {}),
        ...(project?.colorRole ? { projectColorRole: project.colorRole } : {}),
        lifecycle: session.status,
        role: node.isFusionNode ? "fusion" : "research",
        scope: inScopeIds.has(node.id)
          ? "inside-current-filter"
          : input.focusNodeId
            ? "outside-bridge"
            : "outside-boundary",
        connectivity: connectivityFor(node.id),
        candidateCount: 0,
        fusionEvidenceHealth: node.isFusionNode
          ? derivations.evidenceHealthByFusionNodeId?.get(node.id) ?? "incomplete"
          : "not-applicable",
      };
    });
  const visibleIds = new Set(nodes.map((summary) => summary.node.id));
  const seenHintIds = new Set<string>();
  const activeAssociationHints = (derivations.activeAssociationHints ?? [])
    .filter((hint) => hint.status === "active"
      && visibleIds.has(hint.anchorNodeId)
      && visibleIds.has(hint.relatedNodeId)
      && (!input.associationCandidateNodeId
        || hint.anchorNodeId === input.associationCandidateNodeId
        || hint.relatedNodeId === input.associationCandidateNodeId))
    .filter((hint) => {
      if (seenHintIds.has(hint.id)) return false;
      seenHintIds.add(hint.id);
      return true;
    })
    .sort(compareAssociationHintsByValue);
  const candidateCountByNodeId = new Map<string, number>();
  for (const hint of activeAssociationHints) {
    candidateCountByNodeId.set(hint.anchorNodeId, (candidateCountByNodeId.get(hint.anchorNodeId) ?? 0) + 1);
    candidateCountByNodeId.set(hint.relatedNodeId, (candidateCountByNodeId.get(hint.relatedNodeId) ?? 0) + 1);
  }
  for (const summary of nodes) summary.candidateCount = candidateCountByNodeId.get(summary.node.id) ?? 0;
  const edges = permanentEdges
    .filter((edge) => visibleIds.has(edge.fromNodeId) && visibleIds.has(edge.toNodeId))
    .sort(compareEdges)
    .map((edge): ResearchGraphObservationEdge => ({
      edge,
      connectivity: !input.focusNodeId
        ? "default"
        : enabledKindSet.has(edge.kind)
            && connectedIds.has(edge.fromNodeId)
            && connectedIds.has(edge.toNodeId)
          ? "connected"
          : "unconnected",
    }));

  return {
    nodes,
    edges,
    ...(input.focusNodeId && nodeById.has(input.focusNodeId) ? { focusNodeId: input.focusNodeId } : {}),
    appliedRelationshipKinds: enabledKinds,
    activeCandidateCount: activeAssociationHints.length,
    ...(input.includeAssociationHints ? { associationHints: activeAssociationHints } : {}),
  };
}

/** 正文中的稳定语义范围引用；搜索、提示与融合都依赖它，而不依赖弱标记。 */
export interface ResearchSemanticRangeReference {
  nodeId: string;
  bodyVersionId: string;
  fragmentId: string;
}

export interface ResearchNodeSearchResult {
  nodeId: string;
  matchedRanges: ResearchSemanticRangeReference[];
  scope: "inside-current-filter" | "outside-current-filter";
}

export type ResearchAssociationHintStatus = "active" | "ignored" | "expired";

/** 临时提示对当前学习的实际帮助类型；只供内部评估与稳定排序，不向用户呈现分数。 */
export const ASSOCIATION_HINT_BENEFITS = ["rediscovery", "supplement", "correction", "comparison", "expansion"] as const;
export type ResearchAssociationHintBenefit = (typeof ASSOCIATION_HINT_BENEFITS)[number];
export const ASSOCIATION_HINT_EVALUATION_PROMPT_VERSION = "association-hint-evaluation-v1";

/**
 * 与可定位证据分开的内部价值判断。contextKey 随两端当前稳定内容变化，
 * 使后台可以重评而不会把检索召回权重误当成产品价值。
 */
export interface ResearchAssociationHintValueAssessment {
  promptVersion: string;
  benefits: ResearchAssociationHintBenefit[];
  /** 仅用于内部排序的正整数；界面不得展示。 */
  priority: number;
  assessedAt: string;
  contextKey: string;
}

/** 临时关联提示不是边，也没有转为永久关系的状态。 */
export interface ResearchAssociationHintRecord {
  id: string;
  anchorNodeId: string;
  relatedNodeId: string;
  /** 关系核验的结构化结果；临时提示永远不接受 unrelated。 */
  relationType: Exclude<FusionRelationType, "unrelated">;
  reason: string;
  anchorRanges: ResearchSemanticRangeReference[];
  relatedRanges: ResearchSemanticRangeReference[];
  /** 两端稳定证据正文的指纹；不依赖正文版本或片段 ID。 */
  evidenceContentKey: string;
  /** 节点对 + 证据正文 + 关系类型 + 规范化理由的稳定指纹，用于幂等写入与忽略抑制。 */
  evidenceKey: string;
  /** 已通过价值判断的提示留下内部判断，以便正文上下文变化后重新评估。 */
  valueAssessment?: ResearchAssociationHintValueAssessment;
  status: ResearchAssociationHintStatus;
  createdAt: string;
  updatedAt: string;
  ignoredAt?: string;
  expiredAt?: string;
}

/**
 * 关联提示唯一的产品排序：先看重新发现、补充、纠正、对比或扩展当前认识的价值，
 * 再用稳定键消除并列抖动。检索分数不进入这里。
 */
export function compareAssociationHintsByValue(
  left: Pick<ResearchAssociationHintRecord, "id" | "valueAssessment">,
  right: Pick<ResearchAssociationHintRecord, "id" | "valueAssessment">,
): number {
  const leftPriority = left.valueAssessment?.priority;
  const rightPriority = right.valueAssessment?.priority;
  if (leftPriority !== rightPriority) {
    if (leftPriority === undefined) return 1;
    if (rightPriority === undefined) return -1;
    return rightPriority - leftPriority;
  }
  const benefitCount = (right.valueAssessment?.benefits.length ?? 0) - (left.valueAssessment?.benefits.length ?? 0);
  if (benefitCount !== 0) return benefitCount;
  return left.id.localeCompare(right.id);
}

export type ResearchSourceHealth = "available" | "temporarily-unavailable" | "deleted";
export type ResearchFusionEvidenceStatus = "pending" | "verified" | "invalid";

/** B 面中的稳定候选身份；它不属于 ResearchNodeRecord，因此不能成为永久边端点。 */
export interface ResearchTemporaryFusionNodeRecord {
  id: string;
  creationKey: string;
  /** 触发本候选的内部核验记录；只用于本机审计与确定性去重。 */
  triggerProposalId: string;
  activeDraftVersionId: string;
  status: "active";
  /** 已确认的聚合根保留审计事实，但不再属于临时观察层或可编辑草案。 */
  confirmedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchFusionDraftVersionRecord {
  id: string;
  temporaryFusionNodeId: string;
  version: number;
  body: string;
  contentHash: string;
  evidenceStatus: ResearchFusionEvidenceStatus;
  /** T05: judgement ranges are stable per body-and-citation content, not per mutable draft ordinal. */
  judgments?: ResearchFusionDraftJudgmentRecord[];
  createdAt: string;
}

/** A claim-sized, cited Markdown range inside one immutable draft body version. */
export interface ResearchFusionDraftJudgmentRecord {
  id: string;
  startOffset: number;
  endOffset: number;
  contentHash: string;
  sourceNodeIds: string[];
  evidenceStatus: ResearchFusionEvidenceStatus;
}

/** Revalidation is persisted so an interrupted local process never silently treats a new draft as verified. */
export interface ResearchFusionDraftRevalidationTaskRecord {
  id: string;
  temporaryFusionNodeId: string;
  draftVersionId: string;
  judgmentId: string;
  status: "queued" | "running" | "completed" | "failed";
  retryable: boolean;
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
}

export interface ResearchTemporaryFusionDraftHistory {
  versions: ResearchFusionDraftVersionRecord[];
  revalidationTasks: ResearchFusionDraftRevalidationTaskRecord[];
}

export interface UpdateTemporaryFusionDraftInput {
  body: string;
  expectedDraftVersionId: string;
}

export interface UpdateTemporaryFusionDraftResult {
  bundle: ResearchTemporaryFusionBundle;
  previousDraftVersionId: string;
  revalidationTasks: ResearchFusionDraftRevalidationTaskRecord[];
}

/** B 面候选来源连接；仅确认时最终采用且核验通过的连接可转换为 fused-from。 */
export interface ResearchCandidateSourceConnectionRecord {
  id: string;
  temporaryFusionNodeId: string;
  sourceNodeId: string;
  sourceKind: "formal";
  bodyVersionId: string;
  fragmentIds: string[];
  sourceHealth: ResearchSourceHealth;
  createdAt: string;
}

/** 正式融合确认时固定的正文、直接来源与证据对应。 */
export interface ResearchConfirmedFusionSnapshotRecord {
  fusionNodeId: string;
  confirmedDraftVersionId: string;
  body: string;
  contentHash: string;
  directSources: Array<Pick<ResearchCandidateSourceConnectionRecord,
    "sourceNodeId" | "bodyVersionId" | "fragmentIds">>;
  confirmedAt: string;
}

/** 确认必须绑定当前草案版本，避免旧页面把已经变化的版本正式化。 */
export interface ConfirmTemporaryFusionInput {
  expectedDraftVersionId: string;
}

/** 原位确认的稳定结果；session 仅提供正式地图投影所需的根容器。 */
export interface ConfirmTemporaryFusionResult {
  fusionNode: ResearchNodeRecord;
  session: ResearchSessionRecord;
  snapshot: ResearchConfirmedFusionSnapshotRecord;
}

export interface ResearchTemporaryFusionBundle {
  node: ResearchTemporaryFusionNodeRecord;
  activeDraft: ResearchFusionDraftVersionRecord;
  candidateSources: ResearchCandidateSourceConnectionRecord[];
}

/** 临时融合在列表、地图和搜索中共用的只读摘要；正文只经详情接口读取。 */
export interface ResearchTemporaryFusionListItem {
  node: ResearchTemporaryFusionNodeRecord;
  label: string;
  evidenceStatus: ResearchFusionEvidenceStatus;
  candidateSources: ResearchCandidateSourceConnectionRecord[];
}

/** B 面地图投影。它不是 ResearchNodeRecord，不能作为永久边或正式连通路径的端点。 */
export interface ResearchTemporaryFusionMapNode extends ResearchTemporaryFusionListItem {}

export interface ResearchTemporaryFusionSearchInput {
  query: string;
  limit?: number;
}

export interface ResearchTemporaryFusionSearchMatch extends ResearchTemporaryFusionListItem {
  preview: string;
}

export interface ResearchTemporaryFusionSearchResponse {
  matches: ResearchTemporaryFusionSearchMatch[];
}

/** 单项删除保持幂等：目标已经不存在时 deleted 为 false，而不是把重试视为失败。 */
export interface ResearchTemporaryFusionDeleteResult {
  id: string;
  deleted: boolean;
}

/** 批量删除只接受调用方明确给出的候选身份，绝不按搜索词或当前筛选范围扩展对象。 */
export interface ResearchTemporaryFusionBatchDeleteInput {
  ids: string[];
}

/** 不存在的 ID 不阻断同批其他删除，结果明确区分实际删除与本已不存在的项。 */
export interface ResearchTemporaryFusionBatchDeleteResult {
  deletedIds: string[];
  missingIds: string[];
}

/** 清空操作只作用于临时融合聚合根；不包含正式节点、正文或永久关系。 */
export interface ResearchTemporaryFusionClearResult {
  deletedCount: number;
}

/** 临时融合专属消息；它不属于正式会话或节点消息集合。 */
export interface ResearchTemporaryFusionMessageRecord {
  id: string;
  temporaryFusionNodeId: string;
  role: "user" | "assistant";
  content: string;
  status: "pending" | "streaming" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

/** 临时融合专属生成任务；输入先持久化，重启后可安全恢复。 */
export interface ResearchTemporaryFusionTaskRecord {
  id: string;
  temporaryFusionNodeId: string;
  inputMessageId: string;
  outputMessageId: string;
  idempotencyKey: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  retryable: boolean;
  provider?: string;
  model?: string;
  promptVersion: string;
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ResearchTemporaryFusionConversationView {
  bundle: ResearchTemporaryFusionBundle;
  messages: ResearchTemporaryFusionMessageRecord[];
  tasks: ResearchTemporaryFusionTaskRecord[];
}

export interface ResearchTemporaryFusionTurnAccepted {
  inputMessage: ResearchTemporaryFusionMessageRecord;
  outputMessage: ResearchTemporaryFusionMessageRecord;
  task: ResearchTemporaryFusionTaskRecord;
}

/** 统一客户端可消费的目标模型快照；不代表对应 HTTP 路径已在 T01 开放。 */
export interface NodeSystemTargetClientPayload {
  permanentEdges: ResearchPermanentEdgeRecord[];
  associationHints: ResearchAssociationHintRecord[];
  temporaryFusions: ResearchTemporaryFusionBundle[];
  confirmedFusions: ResearchConfirmedFusionSnapshotRecord[];
}

/**
 * 校验自动创建 B 面候选所需的最低事实门槛。这里只校验契约，不触发模型、搜索或弱标记服务。
 */
export function validateTemporaryFusionBundle(
  node: ResearchTemporaryFusionNodeRecord,
  draft: ResearchFusionDraftVersionRecord,
  candidateSources: readonly ResearchCandidateSourceConnectionRecord[],
): void {
  if (!node.id.trim() || !node.creationKey.trim() || !node.triggerProposalId.trim() || !node.activeDraftVersionId.trim()) {
    throw new Error("Temporary fusion identity and creation key are required");
  }
  if (draft.temporaryFusionNodeId !== node.id || draft.id !== node.activeDraftVersionId) {
    throw new Error("Temporary fusion active draft does not match its node");
  }
  if (!Number.isInteger(draft.version) || draft.version < 1 || !draft.body.trim() || !draft.contentHash.trim()) {
    throw new Error("Temporary fusion draft must have a positive version, body, and content hash");
  }
  const sourceNodeIds = new Set(candidateSources.map((source) => source.sourceNodeId));
  if (candidateSources.length < 2 || sourceNodeIds.size < 2) {
    throw new Error("Temporary fusion requires two distinct formal sources");
  }
  for (const source of candidateSources) {
    if (source.temporaryFusionNodeId !== node.id || source.sourceKind !== "formal") {
      throw new Error("Candidate source must reference the same temporary fusion and a formal source");
    }
    if (!source.bodyVersionId.trim() || source.fragmentIds.length === 0) {
      throw new Error("Candidate source evidence must be locatable");
    }
  }
}

/** 同形候选查找键；它不是实体身份，跨内容复用前仍需语境核验。 */
export function termEntityCandidateKey(marker: Pick<TermMarker, "category" | "text">): string {
  return `${marker.category}:${marker.text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()}`;
}

// ── 节点内跨回答实体核验（ADR-0027） ─────────────────────────────

/** 送往核验模型的每侧局部语境上限（字）；两侧各自适用。 */
export const TERM_IDENTITY_CONTEXT_MAX_CHARACTERS = 600;
/** 送往核验模型的单侧提及文字上限（字）。 */
export const TERM_IDENTITY_TEXT_MAX_CHARACTERS = 200;
/** 实体核验提示词版本；研究任务与模型网关留痕共用这一稳定版本。 */
export const TERM_IDENTITY_VERIFY_PROMPT_VERSION = "term-entity-verify-v1";

/** 实体核验的一侧提及：可见文字、类别与有界局部语境。 */
export interface TermIdentityMention {
  text: string;
  category: TermCategory;
  context: string;
}

/**
 * 同一研究节点跨回答实体核验的统一请求结构（ADR-0027）。研究任务与模型
 * 网关共同使用这一份定义，不各自维护重复结构；两侧文字与语境在发送前
 * 分别按上限截断。
 */
export interface TermIdentityVerificationRequest {
  left: TermIdentityMention;
  right: TermIdentityMention;
}

/** 消息术语检测结果。检测失败或无需检测时 terms 为空数组。 */
export interface TermDetectionResult {
  messageId: string;
  terms: TermMarker[];
  detectedAt: string;
  /** H5c：服务端确定性收敛决策，客户端不需要自行推断密度。 */
  convergence: import("./research-convergence.js").ResearchConvergenceDecision;
  /** 被收敛策略抑制的候选术语数量。 */
  suppressedCount: number;
}

export {
  DEFAULT_RESEARCH_CONVERGENCE_BOUNDS,
  RESEARCH_CONVERGENCE_REDUCED_MARKER_MAX_COUNT,
  RESEARCH_CONVERGENCE_REDUCED_MARKER_RATIO,
  RESEARCH_CONVERGENCE_REDUCE_AT_CONTENT_CHARACTERS,
  RESEARCH_CONVERGENCE_REDUCE_AT_DEPTH,
  RESEARCH_CONVERGENCE_SHORT_CONTENT_MAX_CHARACTERS,
  RESEARCH_CONVERGENCE_STOP_AT_CONTENT_CHARACTERS,
  RESEARCH_CONVERGENCE_STOP_AT_DEPTH,
  measureResearchContentLength,
  normalizeResearchNodeDepth,
  resolveResearchConvergence,
  selectResearchTermMarkers,
} from "./research-convergence.js";
export type {
  ResearchConvergenceBounds,
  ResearchConvergenceDecision,
  ResearchConvergenceReason,
  ResearchTermDensity,
} from "./research-convergence.js";

// ── Fusion Proposal (F1) ──────────────────────────────────────────

/** 相似性核验提示词版本；模型调用与本地提议留痕都使用这一稳定版本。 */
export const SIMILARITY_VERIFICATION_PROMPT_VERSION = "similarity-verify-v1";

/** B 面临时融合发现提示词版本；独立于相似性核验与正式融合写作。 */
export const TEMPORARY_FUSION_DISCOVERY_PROMPT_VERSION = "temporary-fusion-discovery-v2";

/** 临时融合完整草案的固定输出预算。 */
export const TEMPORARY_FUSION_DISCOVERY_TOKEN_BUDGET = 4_096;

/** 融合关系类型；identity 为同一实体，unrelated 为无关。 */
export const FUSION_RELATION_TYPES = ["identity", "shared-concept", "analogy", "contrast", "unrelated"] as const;
export type FusionRelationType = (typeof FUSION_RELATION_TYPES)[number];

/** 相似性核验记录只作为临时融合发现的审计锚点，不承载用户决策。 */
export type ResearchFusionProposalStatus = "pending";

/**
 * 触发来源：哪个语义片段命中触发此提议。
 *
 * #39 起每条来源至少携带原始节点（`nodeId`）、正文版本（`bodyVersionId`）与稳定片段
 * 标识（`fragmentId`），摘录可经 `resolveFragmentExcerpt` 回读到正确原文；需要精确
 * 说明时附带对应切片（`sliceId`）或触发术语（`termText`）。历史旧切片产生的来源可
 * 由服务层兼容映射补齐正文版本与片段引用（#43 起为序数对齐映射：切片与片段同源于
 * 正文的确定性派生，按消息内数组下标对齐，不再做正文内容相等匹配）。
 */
export interface FusionProposalTriggerSource {
  /** 触发节点 ID。 */
  nodeId: string;
  /** 触发正文版本 ID（如有；新扫描必带）。 */
  bodyVersionId?: string;
  /** 触发语义片段 ID（如有；新扫描必带）。 */
  fragmentId?: string;
  /** 触发切片 ID（如有）。 */
  sliceId?: string;
  /** 触发术语文本（如有）。 */
  termText?: string;
}

/**
 * 相似性核验的可审计输入摘要。仅保留本机 slice/fragment ID、令牌预算和提示词版本，
 * 不保存模型原始回答或额外的外部传输数据。
 */
export interface SimilarityVerificationAudit {
  promptVersion: typeof SIMILARITY_VERIFICATION_PROMPT_VERSION;
  sourceSliceIds: string[];
  /** 参与核验的语义片段 ID 并集（#39 起随扫描写入）。 */
  sourceFragmentIds?: string[];
  tokenBudget: number;
}

/**
 * 融合提议记录（F1）。确定性候选索引产出宽候选，模型核验关系类型与简短理由。
 * 节点对按 id 字典序规范化（loNodeId / hiNodeId），使方向无关。
 * UNIQUE(loNodeId, hiNodeId) 保证刷新与重启不为同一对重复提议。
 */
export interface ResearchFusionProposalRecord {
  id: string;
  loNodeId: string;
  hiNodeId: string;
  relationType: FusionRelationType;
  reason: string;
  status: ResearchFusionProposalStatus;
  /** 触发来源信息。 */
  triggerSources: FusionProposalTriggerSource[];
  /** 模型核验的版本、所选切片和固定令牌预算，供本地审计。 */
  verification: SimilarityVerificationAudit;
  createdAt: string;
  updatedAt: string;
}

/**
 * 扫描响应只向当前阅读面暴露 B 面总数。临时节点身份、草案与来源连接
 * 留在临时层，不作为正式节点地址或永久关系返回。
 */
export interface ResearchFusionScanResult {
  proposals: ResearchFusionProposalRecord[];
  temporaryFusionCount: number;
}

/** 将节点对统一为无方向的字典序键。 */
export function normalizeResearchFusionProposalPair(nodeAId: string, nodeBId: string): { loNodeId: string; hiNodeId: string } {
  if (!nodeAId.trim() || !nodeBId.trim()) throw new Error("Fusion proposal node IDs are required");
  if (nodeAId === nodeBId) throw new Error("Fusion proposal requires two distinct nodes");
  return nodeAId < nodeBId
    ? { loNodeId: nodeAId, hiNodeId: nodeBId }
    : { loNodeId: nodeBId, hiNodeId: nodeAId };
}

/**
 * 融合提议 ID 的确定性派生：FNV-1a(loNodeId + ":" + hiNodeId)。
 * 节点对按字典序规范化，保证同一对无论输入顺序都生成同一 ID。
 */
export function researchFusionProposalId(nodeAId: string, nodeBId: string): string {
  const { loNodeId, hiNodeId } = normalizeResearchFusionProposalPair(nodeAId, nodeBId);
  return `fusion:${fusionFnv1a32(`${loNodeId}:${hiNodeId}`)}`;
}

/** FNV-1a 32-bit 确定性摘要（与选区幂等键同源）。 */
function fusionFnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** 正式融合直接来源的稳定身份与当前健康投影。 */
export interface ResearchFusionSource {
  /** 来源节点 ID。 */
  nodeId: string;
  /** 贡献片段的正文版本 ID。 */
  bodyVersionId: string;
  /** 贡献语义片段 ID。 */
  fragmentId: string;
  /** 来源节点标签（displayName/选区摘要回退），供 UI 展示。 */
  label: string;
  /** 当前来源可用性；缺失时兼容既有来源条并按 available 呈现。 */
  health?: ResearchSourceHealth;
  /** 对应切片 ID（如有）。 */
  sliceId?: string;
}

/** 唯一可跨打开保存的研究图谱偏好；地图现场始终只存在于当前组件实例。 */
export interface ResearchMapSettings {
  defaultFocusFromNode: boolean;
}
