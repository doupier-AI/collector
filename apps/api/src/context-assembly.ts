import {
  CONTEXT_CHANNELS,
  CONTEXT_PURPOSES,
  MODEL_PURPOSES,
  type ContextChannel,
  type ContextPurpose,
  type ContextPurposePolicy,
  type ContextPurposeResolution,
  type ContextSensitivity,
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
