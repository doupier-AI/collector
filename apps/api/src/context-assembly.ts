import {
  CONTEXT_CHANNELS,
  CONTEXT_PURPOSES,
  MODEL_PURPOSES,
  type ContextChannel,
  type ContextAdoptedCandidate,
  type ContextAdoptionReason,
  type ContextAssemblyAudit,
  type ContextAssemblyRequest,
  type ContextAssemblyResult,
  type ContextBudget,
  type ContextCandidate,
  type ContextCandidatePriority,
  type ContextCandidateProtection,
  type ContextPurpose,
  type ContextPurposePolicy,
  type ContextPurposeResolution,
  type ContextSensitivity,
  type ContextRejectedCandidate,
  type ContextRedaction,
  type ModelPurpose,
} from "@collector/capture-contracts";

const ANSWER_BUDGET = { maxInputTokens: 16_000, reservedOutputTokens: 4_000 } as const;
const RESEARCH_BUDGET = { maxInputTokens: 24_000, reservedOutputTokens: 6_000 } as const;
const SEARCH_BUDGET = { maxInputTokens: 12_000, reservedOutputTokens: 2_000 } as const;
const DOCUMENT_BUDGET = { maxInputTokens: 24_000, reservedOutputTokens: 6_000 } as const;
const EXTRACTION_BUDGET = { maxInputTokens: 8_000, reservedOutputTokens: 1_000 } as const;
const SMALL_EXTRACTION_BUDGET = { maxInputTokens: 4_000, reservedOutputTokens: 512 } as const;
const PROBE_BUDGET = { maxInputTokens: 256, reservedOutputTokens: 16 } as const;

const ALL_CHANNELS = [...CONTEXT_CHANNELS] as const;
const RULES_AND_EVIDENCE = ["behavior_rule", "factual_evidence"] as const;
const RULES_ONLY = ["behavior_rule"] as const;

function policy(
  purpose: ContextPurpose,
  modelPurpose: ModelPurpose,
  allowedChannels: readonly ContextChannel[],
  defaultBudget: ContextPurposePolicy["defaultBudget"],
  maximumSensitivity: Exclude<ContextSensitivity, "secret"> = "sensitive",
): ContextPurposePolicy {
  return { purpose, modelPurpose, allowedChannels, maximumSensitivity, defaultBudget };
}

/** 现行调用用途的完整注册表；新增模型用途必须在迁移调用方前先登记。 */
export const DEFAULT_CONTEXT_PURPOSE_POLICIES: readonly ContextPurposePolicy[] = [
  policy("chat", "chat", ALL_CHANNELS, ANSWER_BUDGET),
  policy("research", "research", ALL_CHANNELS, RESEARCH_BUDGET),
  policy("search", "search", RULES_AND_EVIDENCE, SEARCH_BUDGET),
  policy("document", "document", ALL_CHANNELS, DOCUMENT_BUDGET),
  policy("extraction", "extraction", RULES_AND_EVIDENCE, EXTRACTION_BUDGET),
  policy("connection_test", "chat", RULES_ONLY, PROBE_BUDGET, "standard"),
  policy("research_chat", "chat", ALL_CHANNELS, ANSWER_BUDGET),
  policy("deep_research", "research", ALL_CHANNELS, RESEARCH_BUDGET),
  policy("research_grounding", "search", RULES_AND_EVIDENCE, SEARCH_BUDGET),
  policy("research_body", "research", ALL_CHANNELS, RESEARCH_BUDGET),
  policy("research_body_outline", "research", RULES_AND_EVIDENCE, EXTRACTION_BUDGET),
  policy("research_body_section", "research", ALL_CHANNELS, RESEARCH_BUDGET),
  policy("research_slice_annotation", "extraction", RULES_AND_EVIDENCE, SMALL_EXTRACTION_BUDGET),
  policy("term_preview", "chat", RULES_AND_EVIDENCE, ANSWER_BUDGET),
  policy("term_entity_verification", "extraction", RULES_AND_EVIDENCE, SMALL_EXTRACTION_BUDGET),
  policy("session_titling", "extraction", RULES_AND_EVIDENCE, SMALL_EXTRACTION_BUDGET),
  policy("node_naming", "extraction", RULES_AND_EVIDENCE, SMALL_EXTRACTION_BUDGET),
  policy("import_chapter_parsing", "extraction", RULES_AND_EVIDENCE, EXTRACTION_BUDGET),
  policy("association_hint_evaluation", "extraction", RULES_AND_EVIDENCE, EXTRACTION_BUDGET),
  policy("similarity_verification", "extraction", RULES_AND_EVIDENCE, SMALL_EXTRACTION_BUDGET),
  policy("temporary_fusion_discovery", "research", RULES_AND_EVIDENCE, EXTRACTION_BUDGET),
  policy("temporary_fusion_conversation", "chat", ALL_CHANNELS, ANSWER_BUDGET),
  policy("temporary_fusion_draft_revalidation", "extraction", RULES_AND_EVIDENCE, EXTRACTION_BUDGET),
  policy("query_reformulation", "search", RULES_AND_EVIDENCE, SMALL_EXTRACTION_BUDGET),
  policy("agent_search", "search", RULES_AND_EVIDENCE, SEARCH_BUDGET),
  policy("cluster_materials", "document", RULES_AND_EVIDENCE, EXTRACTION_BUDGET),
  policy("document_outline", "document", RULES_AND_EVIDENCE, EXTRACTION_BUDGET),
  policy("document_sections", "document", ALL_CHANNELS, DOCUMENT_BUDGET),
  policy("incremental_document_update", "document", ALL_CHANNELS, DOCUMENT_BUDGET),
];

function clonePolicy(value: ContextPurposePolicy): ContextPurposePolicy {
  return {
    ...value,
    allowedChannels: [...value.allowedChannels],
    defaultBudget: {
      ...value.defaultBudget,
      ...(value.defaultBudget.channelLimits ? { channelLimits: { ...value.defaultBudget.channelLimits } } : {}),
    },
  };
}

/** API 领域注册表负责在任何提示装配前做用途白名单判定。 */
export class ContextPurposeRegistry {
  private readonly policies = new Map<ContextPurpose, ContextPurposePolicy>();

  constructor(policies: readonly ContextPurposePolicy[] = DEFAULT_CONTEXT_PURPOSE_POLICIES) {
    for (const entry of policies) {
      if (!CONTEXT_PURPOSES.includes(entry.purpose)) throw new Error(`Unknown context purpose policy: ${entry.purpose}`);
      if (!MODEL_PURPOSES.includes(entry.modelPurpose)) throw new Error(`Unknown model purpose route: ${entry.modelPurpose}`);
      if (this.policies.has(entry.purpose)) throw new Error(`Context purpose already registered: ${entry.purpose}`);
      if (entry.defaultBudget.maxInputTokens <= 0 || entry.defaultBudget.reservedOutputTokens <= 0) {
        throw new Error(`Context purpose budget must be positive: ${entry.purpose}`);
      }
      if (entry.maximumSensitivity === ("secret" as ContextSensitivity)) {
        throw new Error(`Context purpose cannot admit secret candidates: ${entry.purpose}`);
      }
      if (new Set(entry.allowedChannels).size !== entry.allowedChannels.length) {
        throw new Error(`Context purpose channels must be unique: ${entry.purpose}`);
      }
      this.policies.set(entry.purpose, clonePolicy(entry));
    }
  }

  resolve(purpose: string): ContextPurposeResolution {
    const registered = this.policies.get(purpose as ContextPurpose);
    return registered
      ? { allowed: true, policy: clonePolicy(registered) }
      : { allowed: false, purpose, reason: "unknown_purpose" };
  }

  list(): ContextPurposePolicy[] {
    return [...this.policies.values()].map(clonePolicy);
  }
}

export const DEFAULT_CONTEXT_PURPOSE_REGISTRY = new ContextPurposeRegistry();

const PRIORITY_WEIGHT: Record<ContextCandidatePriority, number> = {
  hard_boundary: 600,
  task_required: 500,
  turn: 400,
  project: 300,
  global: 200,
  low_weight: 100,
};
const PROTECTION_WEIGHT: Record<ContextCandidateProtection, number> = { required: 3, preferred: 2, optional: 1 };
const CHANNEL_ORDER: Record<ContextChannel, number> = { behavior_rule: 0, factual_evidence: 1, user_adaptation: 2 };
const SENSITIVITY_WEIGHT: Record<ContextSensitivity, number> = { standard: 0, private: 1, sensitive: 2, secret: 3 };
const CONTEXT_CANDIDATE_TOKEN_OVERHEAD = 12;
const SENSITIVE_ASSIGNMENT = /((?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|x[-_]?api[-_]?key|api[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?token|control[-_]?token|launcher[-_]?token|pairing[-_]?code|idempotency[-_]?key|password|credential|secret)\s*[:=]\s*)[^\s,;]+/gi;
const BEARER_VALUE = /\b(bearer|basic)\s+[^\s,;]+/gi;
const SECRET_VALUE = /\b(?:sk|AIza|ghp|xox[baprs]-)[-_A-Za-z0-9]{8,}\b/gi;
const SENSITIVE_URL_PARAMETER = /([?&](?:api[-_]?key|x[-_]?api[-_]?key|key|token|access[-_]?token|refresh[-_]?token|session|session[-_]?id|sid|auth|authorization|cookie|secret|signature|sig|credential|password|code|state|nonce|ticket)=)[^&#\s]*/gi;

/** 稳定的本地粗估：ASCII 约四字符一个 token，其他字符按一个 token 计；不冒充供应商 tokenizer。 */
export function estimateContextTokens(value: string): number {
  let estimate = 0;
  for (const character of value) estimate += character.codePointAt(0)! > 0x7f ? 1 : 0.25;
  return Math.max(1, Math.ceil(estimate));
}

function effectiveBudget(requested: ContextBudget | undefined, policyBudget: ContextBudget): ContextBudget {
  const candidate = requested ?? policyBudget;
  if (!Number.isFinite(candidate.maxInputTokens) || candidate.maxInputTokens <= 0
    || !Number.isFinite(candidate.reservedOutputTokens) || candidate.reservedOutputTokens <= 0) {
    throw new RangeError("Context budget must contain positive finite token limits");
  }
  const maxInputTokens = Math.min(Math.trunc(candidate.maxInputTokens), policyBudget.maxInputTokens);
  const channelLimits = candidate.channelLimits
    ? Object.fromEntries(Object.entries(candidate.channelLimits).map(([channel, limit]) => {
      if (!Number.isFinite(limit) || Number(limit) < 0) throw new RangeError(`Context channel budget must be non-negative: ${channel}`);
      return [channel, Math.min(Math.trunc(Number(limit)), maxInputTokens)];
    })) as ContextBudget["channelLimits"]
    : undefined;
  return {
    maxInputTokens,
    reservedOutputTokens: Math.trunc(candidate.reservedOutputTokens),
    ...(channelLimits ? { channelLimits } : {}),
  };
}

function rejectedCandidate(candidate: ContextCandidate, reason: ContextRejectedCandidate["reason"]): ContextRejectedCandidate {
  return { candidateId: candidate.id, channel: candidate.channel, source: { ...candidate.source }, reason };
}

function normalizeCandidate(candidate: ContextCandidate): ContextCandidate {
  let priority = candidate.priority;
  let protection = candidate.protection;
  if (candidate.channel === "behavior_rule") {
    priority = candidate.ruleKind === "product_boundary" || candidate.ruleKind === "safety"
      ? "hard_boundary"
      : candidate.ruleKind === "task_contract"
        ? "task_required"
        : candidate.ruleKind === "turn_instruction"
          ? "turn"
          : candidate.ruleKind === "project_instruction"
            ? "project"
            : "global";
    if (priority === "hard_boundary" || priority === "task_required") protection = "required";
  } else if (candidate.channel === "factual_evidence") {
    if (candidate.evidenceKind === "current_question" || candidate.evidenceKind === "continuation_state") {
      priority = "task_required";
      protection = "required";
    } else if (candidate.evidenceKind === "explicit_material") {
      priority = "turn";
      protection = "required";
    } else if (priority === "hard_boundary" || priority === "task_required") {
      priority = "turn";
    }
  } else {
    priority = "low_weight";
    protection = "optional";
  }
  return {
    ...candidate,
    priority,
    protection,
    source: { ...candidate.source },
    permission: {
      ...candidate.permission,
      ...(candidate.permission.allowedPurposes ? { allowedPurposes: [...candidate.permission.allowedPurposes] } : {}),
    },
  };
}

function redactCandidate(candidate: ContextCandidate): { candidate: ContextCandidate; redactions: ContextRedaction[] } {
  const reasons = new Set<ContextRedaction["reason"]>();
  const replace = (pattern: RegExp, replacement: string, reason: ContextRedaction["reason"]) => {
    pattern.lastIndex = 0;
    if (pattern.test(candidate.content)) reasons.add(reason);
    pattern.lastIndex = 0;
    content = content.replace(pattern, replacement);
  };
  let content = candidate.content;
  replace(SENSITIVE_ASSIGNMENT, "$1[REDACTED]", "credential");
  replace(BEARER_VALUE, "$1 [REDACTED]", "credential");
  replace(SECRET_VALUE, "[REDACTED]", "secret");
  replace(SENSITIVE_URL_PARAMETER, "$1[REDACTED]", "credential");
  return {
    candidate: { ...candidate, content },
    redactions: [...reasons].map((reason) => ({ field: "content", reason })),
  };
}

function candidateIsValid(candidate: ContextCandidate): boolean {
  return Boolean(candidate.id.trim() && candidate.content.trim() && candidate.source.id.trim())
    && (candidate.channel !== "factual_evidence"
      || !candidate.upstreamRank
      || (Number.isFinite(candidate.upstreamRank.rank) && candidate.upstreamRank.rank >= 0));
}

function sourceKey(candidate: ContextCandidate): string {
  return [candidate.channel, candidate.source.kind, candidate.source.id, candidate.source.version ?? ""].join("\u0000");
}

function contentKey(candidate: ContextCandidate): string {
  return `${candidate.channel}\u0000${candidate.content.trim().replace(/\s+/g, " ").toLocaleLowerCase()}`;
}

function compareCandidates(left: ContextCandidate, right: ContextCandidate): number {
  const leftRank = left.channel === "factual_evidence" ? left.upstreamRank : undefined;
  const rightRank = right.channel === "factual_evidence" ? right.upstreamRank : undefined;
  const upstreamOrder = (leftRank?.source ?? "").localeCompare(rightRank?.source ?? "");
  const withinUpstreamRank = leftRank?.source === rightRank?.source ? (leftRank?.rank ?? 0) - (rightRank?.rank ?? 0) : 0;
  return PRIORITY_WEIGHT[right.priority] - PRIORITY_WEIGHT[left.priority]
    || PROTECTION_WEIGHT[right.protection] - PROTECTION_WEIGHT[left.protection]
    || CHANNEL_ORDER[left.channel] - CHANNEL_ORDER[right.channel]
    || upstreamOrder
    || withinUpstreamRank
    || left.source.kind.localeCompare(right.source.kind)
    || left.source.id.localeCompare(right.source.id)
    || (left.source.version ?? "").localeCompare(right.source.version ?? "")
    || left.id.localeCompare(right.id);
}

function adoptionReason(candidate: ContextCandidate, conflictingFactKeys: ReadonlySet<string>): ContextAdoptionReason {
  if (candidate.channel === "factual_evidence" && candidate.conflictKey && conflictingFactKeys.has(candidate.conflictKey)) return "conflict_preserved";
  if (candidate.channel === "factual_evidence" && candidate.evidenceKind === "explicit_material") return "explicit_selection";
  if (candidate.channel === "factual_evidence" && candidate.evidenceKind === "continuation_state") return "supports_continuation";
  if (candidate.channel === "user_adaptation") return "user_adaptation_enabled";
  if (candidate.protection === "required" || candidate.permission.status === "required") return "required";
  return candidate.priority === "turn" || candidate.priority === "project" ? "ranked_for_task" : "within_scope";
}

/** 纯函数策略核心：权限、作用域、脱敏、优先级、去重、冲突和预算均在供应商转换前完成。 */
export function assembleContext(
  request: ContextAssemblyRequest,
  registry: ContextPurposeRegistry = DEFAULT_CONTEXT_PURPOSE_REGISTRY,
): ContextAssemblyResult {
  const resolution = registry.resolve(request.purpose);
  if (!resolution.allowed) {
    return {
      status: "rejected",
      purpose: request.purpose,
      reason: "unknown_purpose",
      adopted: [],
      rejected: request.candidates.map((candidate) => rejectedCandidate(candidate, "unknown_purpose")),
    };
  }
  const { policy } = resolution;
  const budget = effectiveBudget(request.budget, policy.defaultBudget);
  const rejected: ContextRejectedCandidate[] = [];
  const normalized: Array<{ candidate: ContextCandidate; redactions: ContextRedaction[] }> = [];

  for (const input of request.candidates) {
    const candidate = normalizeCandidate(input);
    let reason: ContextRejectedCandidate["reason"] | undefined;
    if (!candidateIsValid(candidate)) reason = "invalid_candidate";
    else if (!policy.allowedChannels.includes(candidate.channel)) reason = "channel_not_allowed";
    else if (candidate.permission.status === "denied") reason = "permission_denied";
    else if (candidate.permission.allowedPurposes && !candidate.permission.allowedPurposes.includes(policy.purpose)) reason = "purpose_not_allowed";
    else if (candidate.source.scope === "project" && (!candidate.source.projectId || candidate.source.projectId !== request.projectId)) reason = "scope_mismatch";
    else if (candidate.sensitivity === "secret") reason = "secret";
    else if (SENSITIVITY_WEIGHT[candidate.sensitivity] > SENSITIVITY_WEIGHT[policy.maximumSensitivity]) reason = "sensitivity_not_allowed";
    if (reason) rejected.push(rejectedCandidate(candidate, reason));
    else normalized.push(redactCandidate(candidate));
  }

  normalized.sort((left, right) => compareCandidates(left.candidate, right.candidate));
  const deduplicated: typeof normalized = [];
  const seenSources = new Set<string>();
  const seenContent = new Set<string>();
  for (const item of normalized) {
    const source = sourceKey(item.candidate);
    const content = contentKey(item.candidate);
    if (seenSources.has(source) || seenContent.has(content)) rejected.push(rejectedCandidate(item.candidate, "duplicate"));
    else {
      seenSources.add(source);
      seenContent.add(content);
      deduplicated.push(item);
    }
  }

  const conflictWinner = new Map<string, string>();
  const filtered: typeof normalized = [];
  const factualConflictValues = new Map<string, Set<string>>();
  for (const item of deduplicated) {
    const { candidate } = item;
    if (!candidate.conflictKey) {
      filtered.push(item);
      continue;
    }
    if (candidate.channel === "factual_evidence") {
      const values = factualConflictValues.get(candidate.conflictKey) ?? new Set<string>();
      values.add(contentKey(candidate));
      factualConflictValues.set(candidate.conflictKey, values);
      filtered.push(item);
      continue;
    }
    const key = `${candidate.channel}\u0000${candidate.conflictKey}`;
    if (conflictWinner.has(key)) rejected.push(rejectedCandidate(candidate, "conflict"));
    else {
      conflictWinner.set(key, candidate.id);
      filtered.push(item);
    }
  }
  const conflictingFactKeys = new Set([...factualConflictValues].filter(([, values]) => values.size > 1).map(([key]) => key));

  const adopted: ContextAdoptedCandidate[] = [];
  let usedInputTokens = 0;
  const channelUsage: Partial<Record<ContextChannel, number>> = {};
  for (const item of filtered) {
    const estimatedTokens = estimateContextTokens(item.candidate.content) + CONTEXT_CANDIDATE_TOKEN_OVERHEAD;
    const channelLimit = budget.channelLimits?.[item.candidate.channel] ?? budget.maxInputTokens;
    const fits = usedInputTokens + estimatedTokens <= budget.maxInputTokens
      && (channelUsage[item.candidate.channel] ?? 0) + estimatedTokens <= channelLimit;
    if (!fits) {
      rejected.push(rejectedCandidate(item.candidate, "budget_exhausted"));
      if (item.candidate.protection === "required") {
        return {
          status: "rejected",
          purpose: policy.purpose,
          modelPurpose: policy.modelPurpose,
          reason: "required_candidate_exceeds_budget",
          budget: { ...budget, usedInputTokens: 0, remainingInputTokens: budget.maxInputTokens },
          adopted: [],
          rejected,
        };
      }
      continue;
    }
    usedInputTokens += estimatedTokens;
    channelUsage[item.candidate.channel] = (channelUsage[item.candidate.channel] ?? 0) + estimatedTokens;
    adopted.push({
      candidate: item.candidate,
      reason: adoptionReason(item.candidate, conflictingFactKeys),
      estimatedTokens,
      redactions: item.redactions,
    });
  }

  return {
    status: "assembled",
    purpose: policy.purpose,
    modelPurpose: policy.modelPurpose,
    budget: { ...budget, usedInputTokens, remainingInputTokens: budget.maxInputTokens - usedInputTokens },
    adopted,
    rejected,
  };
}

/** 运行记录只接收这个无正文投影，不能序列化 ContextAssemblyResult 本身。 */
export function contextAssemblyAudit(result: ContextAssemblyResult): ContextAssemblyAudit {
  return {
    status: result.status,
    purpose: result.purpose,
    ...(result.modelPurpose ? { modelPurpose: result.modelPurpose } : {}),
    ...(result.budget ? { budget: { ...result.budget, ...(result.budget.channelLimits ? { channelLimits: { ...result.budget.channelLimits } } : {}) } } : {}),
    adopted: result.adopted.map((item) => ({
      candidateId: item.candidate.id,
      channel: item.candidate.channel,
      sourceKind: item.candidate.source.kind,
      sourceId: item.candidate.source.id,
      ...(item.candidate.source.version ? { sourceVersion: item.candidate.source.version } : {}),
      reason: item.reason,
      estimatedTokens: item.estimatedTokens,
      redactionReasons: item.redactions.map(({ reason }) => reason),
    })),
    rejected: result.rejected.map((item) => ({
      candidateId: item.candidateId,
      channel: item.channel,
      sourceKind: item.source.kind,
      sourceId: item.source.id,
      ...(item.source.version ? { sourceVersion: item.source.version } : {}),
      reason: item.reason,
    })),
  };
}
