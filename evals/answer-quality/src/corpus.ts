import {
  ANSWER_QUALITY_CAPABILITIES,
  ANSWER_QUALITY_CORPUS_VERSION,
  type AnswerQualityCase,
  type AnswerQualityCapabilityId,
  type CapabilityExpectation,
  type EvidencePattern,
  type ExplicitFormat,
  type FactRisk,
  type FixedSearchResult,
  type HumanCalibrationCandidate,
  type ProviderSlice,
  type RobustnessTag,
  type TaskFamily,
} from "./types.js";

interface FamilyBlueprint {
  family: TaskFamily;
  code: string;
  request: string;
  priorUser: string;
  priorAssistant: string;
  mustCover: readonly string[];
  mustAvoid: readonly string[];
  taskDimensions: readonly string[];
  risk: FactRisk;
}

interface ScenarioBlueprint {
  tag: RobustnessTag;
  requestSuffix: string;
  evidencePattern: EvidencePattern;
  format: ExplicitFormat;
  providerSlice: ProviderSlice;
  thinking: boolean;
  webAuthorized: boolean;
  multiTurn: boolean;
  extraMustCover: readonly string[];
}

const FAMILY_BLUEPRINTS: readonly FamilyBlueprint[] = [
  { family: "explanation", code: "EXP", request: "解释向量检索为什么会出现语义相近但事实错误的结果", priorUser: "我正在理解检索系统。", priorAssistant: "可以从召回和证据资格两层分析。", mustCover: ["语义相似", "事实核验"], mustAvoid: ["相似度等于真实性"], taskDimensions: ["概念准确", "因果清楚"], risk: "medium" },
  { family: "comparison", code: "CMP", request: "比较全文检索与向量检索在企业知识库中的适用边界", priorUser: "我们要给内部文档做检索。", priorAssistant: "需要结合查询类型和维护成本。", mustCover: ["全文检索", "向量检索"], mustAvoid: ["任何场景都只用向量"], taskDimensions: ["比较维度对称", "差异可决策"], risk: "medium" },
  { family: "decision", code: "DEC", request: "根据给定约束判断本季度应先做检索质量还是个性化", priorUser: "团队只有两名工程师。", priorAssistant: "需要先明确业务损失和依赖。", mustCover: ["约束", "优先级"], mustAvoid: ["同时全面推进"], taskDimensions: ["权衡透明", "结论有条件"], risk: "high" },
  { family: "planning", code: "PLN", request: "为转型 AI 产品经理制定一个十二周行动计划", priorUser: "我有企业软件经验，但没有算法岗位经历。", priorAssistant: "可以围绕作品、业务理解和面试证据规划。", mustCover: ["十二周", "可验证成果"], mustAvoid: ["保证拿到 offer"], taskDimensions: ["步骤可执行", "里程碑可验证"], risk: "medium" },
  { family: "diagnosis", code: "DIA", request: "诊断搜索有结果但最终回答没有可靠来源的原因", priorUser: "搜索接口返回了五条链接。", priorAssistant: "返回链接不等于形成合格证据。", mustCover: ["候选", "合格证据"], mustAvoid: ["有链接就算 grounded"], taskDimensions: ["原因分层", "验证路径明确"], risk: "high" },
  { family: "factual_query", code: "FAC", request: "说明当前材料中产品发布门禁包含哪些状态", priorUser: "只按我提供的材料回答。", priorAssistant: "我会区分能力、可用性和执行结果。", mustCover: ["能力", "可用性", "执行"], mustAvoid: ["未经材料支持的日期"], taskDimensions: ["事实可追溯", "不确定性诚实"], risk: "high" },
  { family: "research_synthesis", code: "SYN", request: "综合三份材料，说明企业 RAG 评测最容易被忽略的风险", priorUser: "材料之间有部分冲突。", priorAssistant: "综合时会保留冲突而不是强行统一。", mustCover: ["证据泄漏", "弱势切片"], mustAvoid: ["材料完全一致"], taskDimensions: ["跨来源综合", "冲突保留"], risk: "high" },
  { family: "summarization", code: "SUM", request: "把长文压缩成面向管理层的摘要，同时保留限制条件", priorUser: "管理层只会读两分钟。", priorAssistant: "摘要不能把限制条件删掉。", mustCover: ["核心结论", "限制条件"], mustAvoid: ["绝对保证"], taskDimensions: ["压缩有效", "关键信息保留"], risk: "medium" },
  { family: "rewriting", code: "REW", request: "把这段技术说明改写成自然、克制的产品语言", priorUser: "不要增加原文没有的能力。", priorAssistant: "会只改表达，不扩写事实。", mustCover: ["原意", "产品语言"], mustAvoid: ["行业领先", "革命性"], taskDimensions: ["忠实改写", "语气符合"], risk: "low" },
  { family: "mixed", code: "MIX", request: "先诊断当前方案，再比较两种修复路径并给出执行顺序", priorUser: "需要本周开始行动。", priorAssistant: "会把诊断、比较和排序分开完成。", mustCover: ["诊断", "比较", "执行顺序"], mustAvoid: ["只给单一结论"], taskDimensions: ["多操作齐全", "操作间衔接"], risk: "high" },
];

const SCENARIO_BLUEPRINTS: readonly ScenarioBlueprint[] = [
  { tag: "multi_turn_reference", requestSuffix: "。结合上一轮所说的限制，说明“它”具体指什么", evidencePattern: "local", format: "natural", providerSlice: "fixed_non_thinking", thinking: false, webAuthorized: false, multiTurn: true, extraMustCover: ["上一轮"] },
  { tag: "correction_and_negation", requestSuffix: "。注意：我撤回上一轮的默认假设，也不要采用助手刚才的结论", evidencePattern: "local", format: "continuous_prose", providerSlice: "fixed_non_thinking", thinking: false, webAuthorized: false, multiTurn: true, extraMustCover: ["撤回"] },
  { tag: "thinking_body_budget", requestSuffix: "。开启深度思考，但正文必须完整回答，不得只留下推理或空白", evidencePattern: "none", format: "natural", providerSlice: "fixed_thinking", thinking: true, webAuthorized: false, multiTurn: false, extraMustCover: ["完整"] },
  { tag: "long_form_coherence", requestSuffix: "。写成长文，跨节不得重复、矛盾或漏掉结论", evidencePattern: "mixed", format: "numbered_steps", providerSlice: "fixed_non_thinking", thinking: false, webAuthorized: false, multiTurn: false, extraMustCover: ["结论"] },
  { tag: "source_order", requestSuffix: "。联网证据顺序可能变化，结论不得依赖返回顺序", evidencePattern: "web", format: "table", providerSlice: "native_grounding", thinking: false, webAuthorized: true, multiTurn: false, extraMustCover: ["来源"] },
  { tag: "no_qualified_evidence", requestSuffix: "。即使搜索有结果，没有合格证据时也要明确停止原因", evidencePattern: "search_without_qualified_evidence", format: "bullet_list", providerSlice: "capability_unavailable", thinking: false, webAuthorized: true, multiTurn: false, extraMustCover: ["没有合格证据"] },
  { tag: "completion_contract", requestSuffix: "。逐项覆盖用户要求，不能用“已完成”替代正文里的实际内容", evidencePattern: "none", format: "numbered_steps", providerSlice: "fixed_non_thinking", thinking: false, webAuthorized: false, multiTurn: false, extraMustCover: ["逐项"] },
];

const QUALIFIED_SEARCH_RESULTS: readonly FixedSearchResult[] = [
  { id: "source-a", title: "一手规范", url: "https://example.test/primary", snippet: "规范说明能力、可用性和执行是不同状态。", qualified: true },
  { id: "source-b", title: "独立验证", url: "https://example.test/verification", snippet: "验证报告说明来源顺序不应改变证据结论。", qualified: true },
];

const UNQUALIFIED_SEARCH_RESULTS: readonly FixedSearchResult[] = [
  { id: "source-noise", title: "无关摘要", url: "https://example.test/noise", snippet: "标题相似，但正文不覆盖当前声明。", qualified: false },
  { id: "source-failed", title: "抓取失败", url: "https://example.test/failed", snippet: "只有搜索摘要，无法回读正文。", qualified: false },
];

const GENERIC_DIMENSIONS = ["任务相关性", "显式指令遵循", "覆盖完整性", "事实克制", "正文连贯性"] as const;

export const ANSWER_QUALITY_CORPUS: readonly AnswerQualityCase[] = FAMILY_BLUEPRINTS.flatMap((family, familyIndex) =>
  SCENARIO_BLUEPRINTS.map((scenario, scenarioIndex) => createCase(family, scenario, familyIndex, scenarioIndex)),
);

export const HUMAN_CALIBRATION_CANDIDATES: readonly HumanCalibrationCandidate[] = FAMILY_BLUEPRINTS.flatMap((family, familyIndex) => {
  return [4, 6].map((scenarioIndex, offset) => {
    const index = familyIndex * SCENARIO_BLUEPRINTS.length + scenarioIndex;
    const testCase = ANSWER_QUALITY_CORPUS[index]!;
    const layer = offset === 0 ? "generic_semantic" as const : "task_family" as const;
    const dimension = offset === 0 ? "任务相关性" : family.taskDimensions[0]!;
    const evaluatorVerdict = (familyIndex + offset) % 2 === 0 ? "pass" : "fail";
    return {
      sampleId: `${ANSWER_QUALITY_CORPUS_VERSION}:${String(familyIndex + 1).padStart(2, "0")}:${offset + 1}`,
      caseId: testCase.id,
      caseVersion: testCase.caseVersion,
      taskFamily: family.family,
      layer,
      dimension,
      evaluatorVerdict,
      judgeInput: {
        userRequest: testCase.user.request,
        explicitSettings: { ...testCase.user.explicitSettings },
        finalBody: calibrationBody(testCase, dimension, evaluatorVerdict),
        admittedEvidence: testCase.environment.fixedSearchResults
          .filter((entry) => entry.qualified)
          .map((entry) => ({ id: entry.id, text: entry.snippet })),
        validCitations: [],
      },
    };
  });
});

function calibrationBody(testCase: AnswerQualityCase, dimension: string, verdict: "pass" | "fail"): string {
  if (dimension === "任务相关性") {
    return verdict === "pass"
      ? `围绕用户问题，回答重点是${testCase.expectation.mustCover.join("、")}，并结合显式限制给出结论。`
      : "建议先安排一次团队聚餐，菜单和座位可以下周再讨论。";
  }
  return verdict === "pass"
    ? `完整回答包括：${testCase.expectation.mustCover.join("；")}。`
    : `只回答其中一项：${testCase.expectation.mustCover[0]}。其他要求暂不说明。`;
}

function createCase(family: FamilyBlueprint, scenario: ScenarioBlueprint, familyIndex: number, scenarioIndex: number): AnswerQualityCase {
  const isCareerRegression = family.family === "planning" && scenarioIndex === 0;
  const id = isCareerRegression ? "AQ-REG-CAREER-001" : `AQ-${family.code}-${String(scenarioIndex + 1).padStart(3, "0")}`;
  const searchResults = scenario.tag === "no_qualified_evidence"
    ? UNQUALIFIED_SEARCH_RESULTS
    : scenario.webAuthorized || isCareerRegression
      ? (familyIndex % 2 === 0 ? QUALIFIED_SEARCH_RESULTS : [...QUALIFIED_SEARCH_RESULTS].reverse())
      : [];
  const webAuthorized = scenario.webAuthorized || isCareerRegression;
  const evidencePattern = isCareerRegression ? "web" : scenario.evidencePattern;
  const robustness = isCareerRegression ? [scenario.tag, "source_order"] as const : [scenario.tag] as const;
  const mustCover = [...family.mustCover, ...scenario.extraMustCover];
  return {
    schemaVersion: 1,
    caseVersion: `${ANSWER_QUALITY_CORPUS_VERSION}.${familyIndex + 1}.${scenarioIndex + 1}`,
    id,
    user: {
      conversation: scenario.multiTurn || isCareerRegression
        ? [{ role: "user", content: family.priorUser }, { role: "assistant", content: family.priorAssistant }]
        : [],
      request: `${family.request}${scenario.requestSuffix}`,
      explicitSettings: { format: scenario.format, language: "zh-CN", preserveUncertainty: true },
    },
    environment: {
      model: scenario.thinking ? "fixed-thinking-model" : "fixed-standard-model",
      thinking: scenario.thinking,
      webAuthorized,
      outputBudgetTokens: scenario.tag === "thinking_body_budget" ? 1_024 : 4_096,
      fixedSearchResults: searchResults,
    },
    coverage: {
      taskFamily: family.family,
      evidencePattern,
      explicitFormat: scenario.format,
      multiTurn: scenario.multiTurn || isCareerRegression,
      factRisk: family.risk,
      providerSlice: scenario.providerSlice,
      robustness,
    },
    expectation: {
      capabilities: capabilityExpectations(scenario, webAuthorized),
      expectedTaskFamily: family.family,
      expectedEvidenceApplicability: evidencePattern === "none" ? "not_applicable" : "required",
      ...(webAuthorized ? { expectedSourceCount: { min: scenario.tag === "no_qualified_evidence" ? 0 : 1, max: 4 } } : {}),
      mustCover,
      mustAvoid: family.mustAvoid,
      ...(familyIndex < 3 && scenarioIndex < 2 ? { referenceAnswer: `回答需要明确覆盖：${mustCover.join("、")}。` } : {}),
      hardConstraints: { minBodyCharacters: 24, format: scenario.format, forbidControlStrings: true },
    },
    rubric: {
      genericDimensions: GENERIC_DIMENSIONS,
      taskFamilyDimensions: family.taskDimensions,
      caseCriteria: mustCover.map((value) => `正文明确覆盖“${value}”`),
    },
  };
}

function capabilityExpectations(scenario: ScenarioBlueprint, webAuthorized: boolean): Record<AnswerQualityCapabilityId, CapabilityExpectation> {
  const values = Object.fromEntries(ANSWER_QUALITY_CAPABILITIES.map((id) => [id, "optional"])) as Record<AnswerQualityCapabilityId, CapabilityExpectation>;
  values.conversation_context = scenario.multiTurn || scenario.tag === "correction_and_negation" ? "required" : "optional";
  values.answer_plan = "required";
  values.prompt_envelope = scenario.thinking ? "required" : "optional";
  values.context_assembly = "required";
  values.evidence_preparation = webAuthorized ? "required" : "not_applicable";
  values.citation_attribution = scenario.tag === "source_order" ? "required" : "not_applicable";
  values.final_writing = "required";
  values.production_run_record = "required";
  return values;
}
