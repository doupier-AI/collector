import { createHash } from "node:crypto";
import {
  ANSWER_PLAN_OPERATIONS,
  ANSWER_PLAN_SCHEMA_VERSION,
  ANSWER_PLANNER_VERSION,
  ANSWER_TASK_FAMILIES,
  type AnswerPlan,
  type AnswerPlanAssumption,
  type AnswerPlanConstraint,
  type AnswerPlanOperation,
  type AnswerPresentationBlock,
  type AnswerTaskFamily,
  type BehaviorRuleContextCandidate,
  type ContextAssemblyResult,
  type ContextCandidate,
  type ConversationContext,
  type ResearchExecutionIntent,
} from "@collector/capture-contracts";
import { assembleContext } from "./context-assembly.js";
import { conversationContextCandidate } from "./conversation-context.js";

export interface AnswerPlanningInput {
  taskId: string;
  generationAttempt: number;
  inputMessageId: string;
  outputMessageId?: string;
  currentQuestion: string;
  conversationContext: ConversationContext;
  explicitAnswerSettings?: Readonly<Record<string, string | number | boolean>>;
  adoptedAdaptationCategories?: readonly string[];
  capabilities: {
    structuredPlanning: "available" | "unavailable";
    webSearch: "authorized" | "not_authorized" | "unavailable";
  };
  /** 本任务入队时已经按实际路由归一化的思考有效值。 */
  thinkingEnabled?: boolean;
  /** 深入研究任务使用 research 路由，其余任务使用 chat 路由。 */
  deepResearch?: boolean;
  executionIntent?: ResearchExecutionIntent;
  existing?: AnswerPlan;
}

export interface AnswerPlanningResult {
  plan: AnswerPlan;
  candidate: BehaviorRuleContextCandidate;
}

export interface AnswerPlanningModelAdapter {
  plan(
    assembly: Extract<ContextAssemblyResult, { status: "assembled" }>,
    context: { taskId: string; promptVersion: string; thinkingEnabled: boolean; deepResearch: boolean; executionIntent?: ResearchExecutionIntent },
  ): Promise<string>;
}

export interface AnswerPlanningModuleOptions {
  model?: AnswerPlanningModelAdapter;
  buildFingerprint?: string;
  plannerVersion?: string;
}

type ModelProposal = {
  taskFamily?: AnswerTaskFamily;
  requiredOperations?: AnswerPlanOperation[];
  assumptions?: AnswerPlanAssumption[];
  semanticCriteria?: string[];
};

const CURRENT_FACT_PATTERN = /(?:最新|现在|当前|今天|本周|本月|实时|价格|汇率|股价|比分|任职|法规|法律|政策|版本|发布|available|latest|current|today|price|law|version)/i;
const HIGH_RISK_PATTERN = /(?:医疗|诊断|药物|法律|诉讼|合规|投资|交易|财务|安全|权限|授权|删除|公开|发布|密钥|凭证|medical|legal|financial|investment|security|permission|delete|publish|credential)/i;
const COMPLEX_PATTERN = /(?:深入|全面|综合|权衡|论证|研究|调研|多方案|分阶段|逐步|详细计划|根因|trade-?off|comprehensive|synthesize|research)/i;
const MATERIAL_ASSUMPTION_PATTERN = /(?:用户|对方|本人|其)(?:是|为|拥有|已经|已获|同意|批准)|(?:身份|权限|授权|批准|同意|安全规则|密钥|凭证|事实为真|已经核实)|(?:the user|they) (?:is|has|approved|authorized)|identity|permission|authori[sz]ation|credential|safety rule/i;
const FORBIDDEN_CRITERION_PATTERN = /(?:忽略|绕过|覆盖|改写|授予|假定).{0,24}(?:用户要求|安全|权限|授权|身份|事实)|(?:自报|声称).{0,16}(?:已通过|已完成|完成比例)|ignore.{0,24}(?:user|safety|permission|authori[sz]ation)|grant.{0,16}(?:permission|authori[sz]ation)|all checks passed|completion percentage/i;
const FORMAT_PATTERNS: ReadonlyArray<{ expected: string; pattern: RegExp }> = [
  { expected: "continuous_prose", pattern: /(?:连续正文|连续行文|不要标题|不用标题|无标题|不分节|continuous prose|no headings?)/i },
  { expected: "table", pattern: /(?:表格|用表|table)/i },
  { expected: "numbered_steps", pattern: /(?:编号步骤|分步骤|步骤列表|numbered steps?)/i },
  { expected: "bullet_list", pattern: /(?:项目符号|要点列表|列表|bullet(?:ed)? list)/i },
];

const FAMILY_PATTERNS: ReadonlyArray<{ family: AnswerTaskFamily; pattern: RegExp }> = [
  { family: "rewriting", pattern: /(?:改写|润色|重写|翻译|校对|rewrite|polish|translate)/i },
  { family: "summarization", pattern: /(?:总结|摘要|概括|提炼|summari[sz]e|summary)/i },
  { family: "diagnosis", pattern: /(?:诊断|排查|报错|故障|为什么失败|根因|debug|diagnos|error|broken)/i },
  { family: "planning", pattern: /(?:规划|计划|路线图|实施步骤|行动方案|roadmap|plan)/i },
  { family: "decision", pattern: /(?:推荐|选择|选哪个|哪个好|决策|取舍|recommend|choose|decision)/i },
  { family: "comparison", pattern: /(?:比较|对比|区别|异同|优缺点|\bvs\.?\b|compare|difference)/i },
  { family: "research_synthesis", pattern: /(?:研究综合|综合分析|调研|文献|多来源|research|synthesis)/i },
  { family: "factual_query", pattern: /(?:谁是|何时|什么时候|多少|哪一年|最新|当前|事实|who|when|where|how many|latest|current)/i },
  { family: "explanation", pattern: /(?:解释|说明|是什么|为什么|原理|如何理解|explain|what is|why)/i },
];

const FAMILY_OPERATIONS: Record<AnswerTaskFamily, readonly AnswerPlanOperation[]> = {
  explanation: ["explain"],
  comparison: ["compare"],
  decision: ["compare", "recommend"],
  planning: ["plan_steps"],
  diagnosis: ["diagnose", "propose_actions"],
  factual_query: ["verify_facts", "answer_directly"],
  research_synthesis: ["verify_facts", "synthesize"],
  summarization: ["summarize"],
  rewriting: ["rewrite"],
  mixed: ["answer_directly"],
  direct_response: ["answer_directly"],
};

/** Deep Module: callers make one plan call; classification, model use, validation and fallback stay inside. */
export class AnswerPlanningModule {
  private readonly model?: AnswerPlanningModelAdapter;
  private readonly buildFingerprint: string;
  private readonly plannerVersion: string;

  constructor(options: AnswerPlanningModuleOptions = {}) {
    this.model = options.model;
    this.buildFingerprint = options.buildFingerprint ?? "development";
    this.plannerVersion = options.plannerVersion ?? ANSWER_PLANNER_VERSION;
  }

  async plan(input: AnswerPlanningInput): Promise<AnswerPlanningResult> {
    if (this.canReuse(input)) return this.result(input.existing!);
    const base = this.deterministicPlan(input);
    if (!this.needsModel(input, base)) return this.result(this.finish(input, {
      ...base,
      planning: { mode: "deterministic", modelCall: "not_needed", reason: "simple_clear_task" },
    }));

    if (!this.model || input.capabilities.structuredPlanning !== "available") {
      return this.result(this.finish(input, {
        ...base,
        planning: {
          mode: "fallback",
          modelCall: "unavailable",
          reason: "model_unavailable",
        },
      }));
    }

    try {
      const assembly = this.assembleModelInput(input);
      if (assembly.status !== "assembled") throw new Error(`Answer planning context rejected: ${assembly.reason}`);
      const raw = await this.model.plan(assembly, {
        taskId: input.taskId,
        promptVersion: this.plannerVersion,
        thinkingEnabled: input.thinkingEnabled === true,
        deepResearch: input.deepResearch === true,
        ...(input.executionIntent ? { executionIntent: input.executionIntent } : {}),
      });
      const proposal = parseModelProposal(raw);
      if (!proposal) {
        return this.result(this.finish(input, {
          ...base,
          planning: { mode: "fallback", modelCall: "failed", reason: "invalid_model_output" },
        }));
      }
      return this.result(this.finish(input, this.mergeProposal(base, proposal)));
    } catch {
      return this.result(this.finish(input, {
        ...base,
        planning: { mode: "fallback", modelCall: "failed", reason: "internal_error" },
      }));
    }
  }

  private canReuse(input: AnswerPlanningInput): boolean {
    const current = input.existing;
    return Boolean(current
      && current.schemaVersion === ANSWER_PLAN_SCHEMA_VERSION
      && current.plannerVersion === this.plannerVersion
      && current.buildFingerprint === this.buildFingerprint
      && current.taskId === input.taskId
      && current.generationAttempt === input.generationAttempt
      && current.inputMessageId === input.inputMessageId
      && current.outputMessageId === input.outputMessageId
      && current.conversationContextId === input.conversationContext.contextId);
  }

  private deterministicPlan(input: AnswerPlanningInput): Omit<AnswerPlan, "schemaVersion" | "planId" | "plannerVersion" | "buildFingerprint" | "taskId" | "generationAttempt" | "inputMessageId" | "outputMessageId" | "conversationContextId"> {
    const taskFamily = classifyTaskFamily(input.currentQuestion);
    const explicitConstraints = deriveExplicitConstraints(input);
    const materialRelations = input.conversationContext.relations.filter((relation) =>
      relation.status !== "resolved" && relation.kind !== "external_fact_conflict");
    const factConflicts = input.conversationContext.relations.filter((relation) => relation.kind === "external_fact_conflict");
    const materialAmbiguity = materialRelations.length > 0;
    const highRisk = HIGH_RISK_PATTERN.test(input.currentQuestion);
    const needsCurrentFacts = CURRENT_FACT_PATTERN.test(input.currentQuestion) || taskFamily === "factual_query" || taskFamily === "research_synthesis";
    const requestClarification = materialAmbiguity && highRisk;
    const assumptions: AnswerPlanAssumption[] = materialAmbiguity && !requestClarification
      ? materialRelations.slice(0, 3).map((relation) => ({
        statement: `保留未唯一解析的“${bounded(relation.expression, 120)}”，按公开假设继续。`,
        risk: "low",
        source: "conversation_context",
      }))
      : [];
    const requiredOperations = uniqueOperations([
      ...FAMILY_OPERATIONS[taskFamily],
      ...(assumptions.length ? ["state_assumptions" as const] : []),
      ...(requestClarification ? ["request_clarification" as const] : []),
    ]);
    const format = formatConstraint(explicitConstraints);
    const presentation = presentationFor(input.currentQuestion, taskFamily, explicitConstraints);
    const machineChecks = [
      { id: "body:not-empty", kind: "non_empty" as const, source: "product" as const },
      { id: "body:no-control-strings", kind: "forbidden_string" as const, expected: "internal_control_protocol", source: "product" as const },
      { id: "body:not-truncated", kind: "truncation" as const, source: "product" as const },
      ...(format ? [{ id: "body:explicit-format", kind: "format" as const, expected: format, source: "explicit_constraint" as const }] : []),
      ...lengthMachineChecks(explicitConstraints),
    ];
    const semanticCriteria = semanticCriteriaFor(requiredOperations);
    // "authorized" means the frozen task mode is required. The planner may choose queries,
    // but may never downgrade the obligation to execute at least one real backend call.
    const authorization = input.capabilities.webSearch === "authorized" ? "authorized" as const
      : needsCurrentFacts
        ? input.capabilities.webSearch === "not_authorized" ? "not_authorized" as const : "unavailable" as const
        : "not_required" as const;
    const mode = authorization === "authorized" ? "web_if_authorized" as const
      : !needsCurrentFacts ? "none" as const
        : authorization === "not_authorized" ? "clarify_authorization" as const
          : "available_context" as const;
    const uncertaintyReasons = [
      ...materialRelations.map((relation) => `${relation.kind}:${relation.status}`),
      ...factConflicts.map(() => "external_fact_conflict_deferred_to_evidence"),
      ...(needsCurrentFacts && authorization === "unavailable" ? ["current_fact_capability_unavailable"] : []),
    ];
    return {
      planning: { mode: "deterministic", modelCall: "not_needed", reason: "simple_clear_task" },
      taskFamily,
      userGoal: bounded(input.currentQuestion.trim(), 1_000),
      audience: explicitAudience(input.currentQuestion),
      explicitConstraints,
      requiredOperations,
      assumptions,
      evidencePolicy: {
        mode,
        requiresCurrentFacts: needsCurrentFacts,
        access: authorization,
        conflictHandling: "preserve_for_evidence_chain",
      },
      uncertaintyHandling: {
        action: requestClarification ? "request_clarification"
          : materialAmbiguity ? "proceed_with_disclosed_assumptions"
            : needsCurrentFacts && authorization === "unavailable" ? "state_limitations"
              : factConflicts.length ? "preserve_ambiguity" : "proceed",
        reasons: uncertaintyReasons,
      },
      presentation,
      completionContract: { machineChecks, semanticCriteria },
    };
  }

  private needsModel(input: AnswerPlanningInput, base: ReturnType<AnswerPlanningModule["deterministicPlan"]>): boolean {
    const unresolved = input.conversationContext.relations.some((relation) => relation.status !== "resolved");
    return unresolved
      || base.taskFamily === "mixed"
      || input.currentQuestion.length > 180
      || COMPLEX_PATTERN.test(input.currentQuestion);
  }

  private assembleModelInput(input: AnswerPlanningInput): ContextAssemblyResult {
    const candidates: ContextCandidate[] = [{
      id: `answer-plan-question:${input.inputMessageId}`,
      channel: "factual_evidence",
      evidenceKind: "current_question",
      content: input.currentQuestion,
      source: { kind: "conversation", id: input.inputMessageId, scope: "turn" },
      permission: { status: "required", basis: "task_contract", allowedPurposes: ["answer_planning"] },
      sensitivity: "private",
      priority: "task_required",
      protection: "required",
      upstreamRank: { source: "conversation", rank: 0 },
    }];
    const history = conversationContextCandidate(input.conversationContext);
    if (history) candidates.push({
      ...history,
      permission: { ...history.permission, allowedPurposes: ["answer_planning"] },
    });
    if (input.explicitAnswerSettings && Object.keys(input.explicitAnswerSettings).length) candidates.push({
      id: `answer-plan-settings:${input.taskId}`,
      channel: "behavior_rule",
      ruleKind: "turn_instruction",
      content: JSON.stringify(input.explicitAnswerSettings),
      source: { kind: "user_instruction", id: `answer-settings:${input.taskId}`, scope: "turn" },
      permission: { status: "required", basis: "user_choice", allowedPurposes: ["answer_planning"] },
      sensitivity: "standard",
      priority: "turn",
      protection: "required",
    });
    if (input.adoptedAdaptationCategories?.length) candidates.push({
      id: `answer-plan-adaptation:${input.taskId}`,
      channel: "user_adaptation",
      adaptationKind: "user_profile",
      content: JSON.stringify({ adoptedCategories: [...input.adoptedAdaptationCategories].sort() }),
      source: { kind: "user_profile", id: `adopted-categories:${input.taskId}`, scope: "turn" },
      permission: { status: "eligible", basis: "user_choice", allowedPurposes: ["answer_planning"] },
      sensitivity: "private",
      priority: "low_weight",
      protection: "optional",
    });
    candidates.push({
      id: `answer-plan-capabilities:${input.taskId}`,
      channel: "behavior_rule",
      ruleKind: "task_contract",
      content: JSON.stringify(input.capabilities),
      source: { kind: "task_rule", id: "answer-planning-capabilities-v1", scope: "turn" },
      permission: { status: "required", basis: "task_contract", allowedPurposes: ["answer_planning"] },
      sensitivity: "standard",
      priority: "task_required",
      protection: "required",
    });
    return assembleContext({
      purpose: "answer_planning",
      workflowRunId: input.taskId,
      workflowStepId: "answer-planning",
      candidates,
    });
  }

  private mergeProposal(base: ReturnType<AnswerPlanningModule["deterministicPlan"]>, proposal: ModelProposal): ReturnType<AnswerPlanningModule["deterministicPlan"]> {
    const taskFamily = proposal.taskFamily ?? base.taskFamily;
    const materialAssumptions = (proposal.assumptions ?? []).filter((assumption) => assumption.risk === "material");
    const lowRiskAssumptions = (proposal.assumptions ?? []).filter((assumption) => assumption.risk === "low");
    const requestClarification = base.uncertaintyHandling.action === "request_clarification" || materialAssumptions.length > 0;
    const requiredOperations = uniqueOperations([
      ...base.requiredOperations,
      ...(proposal.requiredOperations ?? []).filter((operation) => operation !== "request_clarification" && operation !== "state_assumptions"),
      ...FAMILY_OPERATIONS[taskFamily],
      ...(lowRiskAssumptions.length && !requestClarification ? ["state_assumptions" as const] : []),
      ...(requestClarification ? ["request_clarification" as const] : []),
    ]);
    const assumptions = requestClarification
      ? base.assumptions
      : uniqueAssumptions([
        ...base.assumptions,
        ...lowRiskAssumptions,
      ]).slice(0, 5);
    const semanticCriteria = uniqueStrings([
      ...semanticCriteriaFor(requiredOperations),
      ...(proposal.semanticCriteria ?? []),
    ]).slice(0, 12);
    return {
      ...base,
      planning: {
        mode: "model_assisted",
        modelCall: "completed",
        reason: requestClarification ? "material_ambiguity" : "complex_task",
      },
      taskFamily,
      requiredOperations,
      assumptions,
      uncertaintyHandling: requestClarification
        ? {
          action: "request_clarification",
          reasons: uniqueStrings([
            ...base.uncertaintyHandling.reasons,
            ...materialAssumptions.map(() => "planner_identified_material_ambiguity"),
          ]),
        }
        : base.uncertaintyHandling,
      completionContract: { ...base.completionContract, semanticCriteria },
    };
  }

  private finish(input: AnswerPlanningInput, body: ReturnType<AnswerPlanningModule["deterministicPlan"]>): AnswerPlan {
    const identity = {
      schemaVersion: ANSWER_PLAN_SCHEMA_VERSION,
      plannerVersion: this.plannerVersion,
      buildFingerprint: this.buildFingerprint,
      taskId: input.taskId,
      generationAttempt: input.generationAttempt,
      inputMessageId: input.inputMessageId,
      ...(input.outputMessageId ? { outputMessageId: input.outputMessageId } : {}),
      conversationContextId: input.conversationContext.contextId,
    };
    const planId = `answer-plan:${createHash("sha256").update(JSON.stringify({ identity, body })).digest("hex")}`;
    return { ...identity, planId, ...body };
  }

  private result(plan: AnswerPlan): AnswerPlanningResult {
    return {
      plan,
      candidate: {
        id: `answer-plan-context:${plan.planId}`,
        channel: "behavior_rule",
        ruleKind: "answer_plan",
        content: JSON.stringify(plan),
        source: { kind: "task_rule", id: plan.planId, version: plan.plannerVersion, scope: "turn" },
        permission: {
          status: "eligible",
          basis: "task_contract",
          allowedPurposes: ["research_grounding", "research_body", "research_body_outline", "research_body_section"],
        },
        sensitivity: "private",
        priority: "low_weight",
        protection: "optional",
      },
    };
  }
}

function presentationFor(
  question: string,
  family: AnswerTaskFamily,
  constraints: readonly AnswerPlanConstraint[],
): { mode: "compact" | "structured"; preferredBlocks: readonly AnswerPresentationBlock[] } {
  const explicit = formatConstraint(constraints);
  if (explicit === "continuous_prose") return { mode: "compact", preferredBlocks: [] };
  if (explicit === "table") return { mode: "structured", preferredBlocks: ["table"] };
  if (explicit === "numbered_steps") return { mode: "structured", preferredBlocks: ["numbered_list"] };
  if (explicit === "bullet_list") return { mode: "structured", preferredBlocks: ["bullet_list"] };

  const structuredFamilies = new Set<AnswerTaskFamily>([
    "comparison", "decision", "planning", "diagnosis", "research_synthesis", "mixed",
  ]);
  const longOrMultiStep = question.length > 240 || COMPLEX_PATTERN.test(question)
    || /(?:长文|报告|多步骤|逐步|详细|全面|long-form|multi-step|detailed)/i.test(question);
  const mode = structuredFamilies.has(family) || longOrMultiStep ? "structured" : "compact";
  if (mode === "compact") return { mode, preferredBlocks: [] };

  const blocks: AnswerPresentationBlock[] = ["heading"];
  if (family === "planning") blocks.push("numbered_list");
  else if (family === "comparison" || family === "decision") blocks.push("table");
  else blocks.push("bullet_list");
  if (/(?:代码|实现|脚本|函数|组件|\bAPI\b|\bSQL\b|\bcode\b|\bimplementation\b|\bscript\b)/i.test(question)) blocks.push("code");
  if (/(?:流程|状态机|层级|时间线|关系图|flow|state machine|hierarchy|timeline)/i.test(question)) blocks.push("mermaid");
  if (/(?:公式|方程|证明|math|equation)/i.test(question)) blocks.push("math");
  return { mode, preferredBlocks: [...new Set(blocks)] };
}

function classifyTaskFamily(question: string): AnswerTaskFamily {
  const matches = FAMILY_PATTERNS.filter(({ pattern }) => pattern.test(question)).map(({ family }) => family);
  const unique = [...new Set(matches)];
  if (unique.length === 0) return "direct_response";
  if (unique.length === 1) return unique[0]!;
  if (unique.includes("decision") && unique.includes("comparison") && unique.length === 2) return "decision";
  return "mixed";
}

function deriveExplicitConstraints(input: AnswerPlanningInput): AnswerPlanConstraint[] {
  const constraints: AnswerPlanConstraint[] = [];
  const current = input.currentQuestion.trim();
  const currentFormat = FORMAT_PATTERNS.find(({ pattern }) => pattern.test(current));
  if (currentFormat) constraints.push({ kind: "format", value: currentFormat.expected, source: "current_turn", sourceMessageId: input.inputMessageId });
  if (/(?:简短|精简|一句话|不超过(?:写)?\s*\d+|至少(?:写)?\s*\d+|不少于(?:写)?\s*\d+|约(?:写)?\s*\d+|\d+\s*字|short|concise|at least\s+\d+|no more than\s+\d+|\d+\s*words?)/i.test(current)) constraints.push({ kind: "length", value: bounded(current, 240), source: "current_turn", sourceMessageId: input.inputMessageId });
  if (/(?:详细|详实|深入展开|long|detailed)/i.test(current)) constraints.push({ kind: "length", value: bounded(current, 240), source: "current_turn", sourceMessageId: input.inputMessageId });
  if (/(?:中文|英文|中英|英语|用\s*[A-Za-z]+\s*回答|in (?:Chinese|English))/i.test(current)) constraints.push({ kind: "language", value: bounded(current, 240), source: "current_turn", sourceMessageId: input.inputMessageId });
  if (/(?:语气|口吻|正式|轻松|专业|tone|formal|casual)/i.test(current)) constraints.push({ kind: "tone", value: bounded(current, 240), source: "current_turn", sourceMessageId: input.inputMessageId });
  if (/(?:^|[，,；;。])\s*(?:只|仅|不要|不得|别|不需要|不讨论|only|do not|don't)/i.test(current)) constraints.push({ kind: "scope", value: bounded(current, 320), source: "current_turn", sourceMessageId: input.inputMessageId });

  const settings = input.explicitAnswerSettings ?? {};
  for (const [key, value] of Object.entries(settings).sort(([left], [right]) => left.localeCompare(right))) {
    constraints.push({ kind: settingKind(key), value: `${key}=${String(value)}`, source: "explicit_setting" });
  }

  const authoritativeKinds = new Set(constraints.map((constraint) => constraint.kind));
  for (const item of input.conversationContext.items) {
    if (item.selection !== "selected" || item.semanticCategory !== "explicit_constraint") continue;
    const priorKind = FORMAT_PATTERNS.some(({ pattern }) => pattern.test(item.content)) ? "format" : inferredConstraintKind(item.content);
    if (authoritativeKinds.has(priorKind)) continue;
    constraints.push({
      kind: priorKind,
      value: bounded(item.content, 320),
      source: "conversation_context",
      sourceMessageId: item.source.messageId,
    });
  }
  return uniqueConstraints(constraints);
}

function settingKind(key: string): AnswerPlanConstraint["kind"] {
  if (/format|structure|heading|list|table/i.test(key)) return "format";
  if (/length|size|detail/i.test(key)) return "length";
  if (/language|locale/i.test(key)) return "language";
  if (/tone|voice|style/i.test(key)) return "tone";
  if (/scope|exclude|include/i.test(key)) return "scope";
  return "other";
}

function inferredConstraintKind(value: string): AnswerPlanConstraint["kind"] {
  if (/(?:简短|精简|一句话|不超过|\d+\s*字|详细|详实|深入展开|short|concise|long|detailed)/i.test(value)) return "length";
  if (/(?:中文|英文|中英|英语|in (?:Chinese|English))/i.test(value)) return "language";
  if (/(?:语气|口吻|正式|轻松|专业|tone|formal|casual)/i.test(value)) return "tone";
  if (/(?:只|仅|不要|不得|别|不需要|不讨论|only|do not|don't)/i.test(value)) return "scope";
  return "other";
}

function explicitAudience(question: string): AnswerPlan["audience"] {
  const match = question.match(/(?:面向|写给|给|针对|适合)\s*([^，,。；;]{1,40})(?:看|阅读|使用|解释|，|,|。|；|;|$)/);
  return match?.[1]?.trim()
    ? { description: bounded(match[1].trim(), 80), source: "explicit" }
    : { description: "unspecified", source: "unspecified" };
}

function formatConstraint(constraints: readonly AnswerPlanConstraint[]): string | undefined {
  const explicit = constraints.find((constraint) => constraint.kind === "format" && constraint.source !== "conversation_context")
    ?? constraints.find((constraint) => constraint.kind === "format");
  if (!explicit) return undefined;
  if (["continuous_prose", "table", "numbered_steps", "bullet_list"].includes(explicit.value)) return explicit.value;
  return FORMAT_PATTERNS.find(({ pattern }) => pattern.test(explicit.value))?.expected;
}

function lengthMachineChecks(constraints: readonly AnswerPlanConstraint[]): AnswerPlan["completionContract"]["machineChecks"] {
  const constraint = constraints.find((item) => item.kind === "length" && item.source !== "conversation_context")
    ?? constraints.find((item) => item.kind === "length");
  if (!constraint) return [];
  const value = constraint.value;
  const chineseMax = value.match(/不超过(?:写)?\s*(\d{1,7})\s*字/);
  const chineseMin = value.match(/(?:至少|不少于)(?:写)?\s*(\d{1,7})\s*字/);
  const englishMax = value.match(/no more than\s+(\d{1,7})\s+words?/i);
  const englishMin = value.match(/at least\s+(\d{1,7})\s+words?/i);
  if (chineseMax) return [{ id: "body:explicit-max-length", kind: "max_length", expected: `characters:${chineseMax[1]}`, source: "explicit_constraint" }];
  if (chineseMin) return [{ id: "body:explicit-min-length", kind: "min_length", expected: `characters:${chineseMin[1]}`, source: "explicit_constraint" }];
  if (englishMax) return [{ id: "body:explicit-max-length", kind: "max_length", expected: `words:${englishMax[1]}`, source: "explicit_constraint" }];
  if (englishMin) return [{ id: "body:explicit-min-length", kind: "min_length", expected: `words:${englishMin[1]}`, source: "explicit_constraint" }];
  return [];
}

function semanticCriteriaFor(operations: readonly AnswerPlanOperation[]): string[] {
  const criteria = new Set<string>();
  for (const operation of operations) {
    if (operation === "answer_directly") criteria.add("直接回应当前用户目标，不把派生计划当成事实。 ".trim());
    if (operation === "explain") criteria.add("解释关键概念及其因果或工作机制。 ".trim());
    if (operation === "compare") criteria.add("使用一致维度比较相关选项并说明差异。 ".trim());
    if (operation === "recommend") criteria.add("给出与已说明约束一致的结论及理由。 ".trim());
    if (operation === "plan_steps") criteria.add("给出可执行、有顺序且边界明确的行动。 ".trim());
    if (operation === "diagnose") criteria.add("区分已确认现象、可能原因与证据缺口。 ".trim());
    if (operation === "propose_actions") criteria.add("给出与诊断相匹配的验证或处理动作。 ".trim());
    if (operation === "verify_facts") criteria.add("事实结论与已准入证据及其时效边界一致。 ".trim());
    if (operation === "synthesize") criteria.add("综合相关材料并保留冲突、不确定性与来源边界。 ".trim());
    if (operation === "summarize") criteria.add("保留原材料主旨、重要限定和结论。 ".trim());
    if (operation === "rewrite") criteria.add("保持原意，同时满足用户明确的改写要求。 ".trim());
    if (operation === "state_assumptions") criteria.add("公开说明继续作答所依赖的低风险假设。 ".trim());
    if (operation === "request_clarification") criteria.add("只询问会实质改变用户结果、授权或高风险事实的缺失信息。 ".trim());
  }
  return [...criteria];
}

function parseModelProposal(raw: string): ModelProposal | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const taskFamily = typeof input.taskFamily === "string" && ANSWER_TASK_FAMILIES.includes(input.taskFamily as AnswerTaskFamily)
    ? input.taskFamily as AnswerTaskFamily
    : undefined;
  const requiredOperations = Array.isArray(input.requiredOperations)
    ? input.requiredOperations.filter((entry): entry is AnswerPlanOperation => typeof entry === "string" && ANSWER_PLAN_OPERATIONS.includes(entry as AnswerPlanOperation)).slice(0, 12)
    : undefined;
  const assumptions = Array.isArray(input.assumptions)
    ? input.assumptions.flatMap((entry): AnswerPlanAssumption[] => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as Record<string, unknown>;
      if (typeof item.statement !== "string" || !item.statement.trim()) return [];
      const statement = bounded(item.statement.trim(), 320);
      return [{ statement, risk: item.risk === "material" || MATERIAL_ASSUMPTION_PATTERN.test(statement) ? "material" : "low", source: "planner" }];
    }).slice(0, 5)
    : undefined;
  const semanticCriteria = Array.isArray(input.semanticCriteria)
    ? input.semanticCriteria
      .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()) && !FORBIDDEN_CRITERION_PATTERN.test(entry))
      .map((entry) => bounded(entry.trim(), 320)).slice(0, 8)
    : undefined;
  if (!taskFamily && !requiredOperations?.length && !assumptions?.length && !semanticCriteria?.length) return undefined;
  return {
    ...(taskFamily ? { taskFamily } : {}),
    ...(requiredOperations?.length ? { requiredOperations } : {}),
    ...(assumptions?.length ? { assumptions } : {}),
    ...(semanticCriteria?.length ? { semanticCriteria } : {}),
  };
}

function uniqueOperations(values: readonly AnswerPlanOperation[]): AnswerPlanOperation[] {
  return [...new Set(values)].filter((entry) => ANSWER_PLAN_OPERATIONS.includes(entry));
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((entry) => {
    const normalized = entry.trim().replace(/\s+/g, " ").toLocaleLowerCase();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function uniqueAssumptions(values: readonly AnswerPlanAssumption[]): AnswerPlanAssumption[] {
  const seen = new Set<string>();
  return values.filter((entry) => {
    const key = entry.statement.trim().replace(/\s+/g, " ").toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueConstraints(values: readonly AnswerPlanConstraint[]): AnswerPlanConstraint[] {
  const seen = new Set<string>();
  return values.filter((entry) => {
    const key = `${entry.kind}\u0000${entry.value.trim().replace(/\s+/g, " ").toLocaleLowerCase()}\u0000${entry.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}
