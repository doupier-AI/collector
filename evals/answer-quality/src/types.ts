export const ANSWER_QUALITY_CORPUS_VERSION = "aq-corpus-v1" as const;

export const ANSWER_QUALITY_CAPABILITIES = [
  "conversation_context",
  "answer_plan",
  "prompt_envelope",
  "context_assembly",
  "evidence_preparation",
  "citation_attribution",
  "final_writing",
  "production_run_record",
] as const;

export type AnswerQualityCapabilityId = typeof ANSWER_QUALITY_CAPABILITIES[number];
export type CapabilityExpectation = "required" | "optional" | "not_applicable";
export type TaskFamily = "explanation" | "comparison" | "decision" | "planning" | "diagnosis" | "factual_query" | "research_synthesis" | "summarization" | "rewriting" | "mixed";
export type EvidencePattern = "none" | "local" | "web" | "mixed" | "search_without_qualified_evidence";
export type ExplicitFormat = "natural" | "continuous_prose" | "bullet_list" | "table" | "numbered_steps";
export type FactRisk = "low" | "medium" | "high";
export type ProviderSlice = "fixed_non_thinking" | "fixed_thinking" | "native_grounding" | "capability_unavailable";
export type RobustnessTag =
  | "multi_turn_reference"
  | "correction_and_negation"
  | "thinking_body_budget"
  | "long_form_coherence"
  | "source_order"
  | "no_qualified_evidence"
  | "completion_contract"
  | "capability_unavailable";

export interface AnswerQualityConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface FixedSearchResult {
  id: string;
  title: string;
  url: string;
  snippet: string;
  qualified: boolean;
}

export interface AnswerQualityCaseExpectation {
  capabilities: Record<AnswerQualityCapabilityId, CapabilityExpectation>;
  expectedTaskFamily: TaskFamily;
  expectedEvidenceApplicability: CapabilityExpectation;
  expectedSourceCount?: { min: number; max?: number };
  mustCover: readonly string[];
  mustAvoid: readonly string[];
  referenceAnswer?: string;
  hardConstraints: {
    minBodyCharacters: number;
    format: ExplicitFormat;
    forbidControlStrings: boolean;
  };
}

export interface AnswerQualityCase {
  schemaVersion: 1;
  caseVersion: string;
  id: string;
  user: {
    conversation: readonly AnswerQualityConversationTurn[];
    request: string;
    explicitSettings: Readonly<Record<string, string | boolean | number>>;
  };
  environment: {
    model: string;
    thinking: boolean;
    webAuthorized: boolean;
    outputBudgetTokens: number;
    fixedSearchResults: readonly FixedSearchResult[];
  };
  coverage: {
    taskFamily: TaskFamily;
    evidencePattern: EvidencePattern;
    explicitFormat: ExplicitFormat;
    multiTurn: boolean;
    factRisk: FactRisk;
    providerSlice: ProviderSlice;
    robustness: readonly RobustnessTag[];
  };
  expectation: AnswerQualityCaseExpectation;
  rubric: {
    genericDimensions: readonly string[];
    taskFamilyDimensions: readonly string[];
    caseCriteria: readonly string[];
  };
}

export interface CaseExpectationFact {
  capabilities: Record<AnswerQualityCapabilityId, CapabilityExpectation>;
}

export interface BuildCapabilityFact {
  capabilityId: AnswerQualityCapabilityId;
  supported: boolean;
  version?: string;
}

export interface RunAvailabilityFact {
  capabilityId: AnswerQualityCapabilityId;
  state: "available" | "unavailable";
  reason?: string;
  capturedAt: string;
}

export interface RunExecutionFact {
  capabilityId: AnswerQualityCapabilityId;
  state: "completed" | "failed" | "not_executed";
  artifactId?: string;
  errorCategory?: string;
}

export interface ReleaseCapabilityRequirement {
  mustImplement?: boolean;
  mustBeAvailable?: boolean;
  mustSucceed?: boolean;
}

export interface ReleaseRequirementFact {
  id: string;
  capabilities: Partial<Record<AnswerQualityCapabilityId, ReleaseCapabilityRequirement>>;
}

export interface EvaluationFacts {
  caseExpectation: CaseExpectationFact;
  buildCapabilities: readonly BuildCapabilityFact[];
  runAvailability: readonly RunAvailabilityFact[];
  runExecution: readonly RunExecutionFact[];
  releaseRequirement: ReleaseRequirementFact;
}

export type CapabilityOutcome =
  | "not_applicable"
  | "not_supported_by_build"
  | "unavailable"
  | "execution_failed"
  | "missing_execution"
  | "not_executed_optional"
  | "completed";

export interface CapabilityFinding {
  capabilityId: AnswerQualityCapabilityId;
  outcome: CapabilityOutcome;
  releaseBlocking: boolean;
  reason?: string;
}

export interface ProductionScenario {
  userRequest: string;
  conversation: readonly AnswerQualityConversationTurn[];
  explicitSettings: Readonly<Record<string, string | boolean | number>>;
  environment: {
    model: string;
    thinking: boolean;
    webAuthorized: boolean;
    outputBudgetTokens: number;
    fixedSearchResults: readonly FixedSearchResult[];
  };
}

export interface EvidenceForJudge {
  id: string;
  text: string;
}

export interface CitationForJudge {
  sourceId: string;
  startOffset: number;
  endOffset: number;
}

export interface ProductionTrace {
  conversationContext?: unknown;
  answerPlanInput?: unknown;
  evidencePreparationRequest?: unknown;
  contextAssembly?: unknown;
  promptEnvelope?: unknown;
  toolCalls: readonly unknown[];
  providerRequests: readonly unknown[];
  finalBody: string;
  productionRunRecords: readonly unknown[];
}

export interface AnswerQualityRunIdentity {
  caseVersion: string;
  caseId: string;
  taskId: string;
  inputMessageId: string;
  outputMessageId: string;
  bodyVersionId: string;
  generationAttempt: number;
  model: string;
  thinking: boolean;
  buildFingerprint: string;
}

export interface ArtifactBinding {
  capabilityId: AnswerQualityCapabilityId;
  status: "bound" | "not_applicable" | "not_supported_by_build" | "unavailable" | "failed";
  artifactId?: string;
  reason?: string;
}

export interface AnswerQualityRun {
  mode: "offline_replay" | "fixed_provider" | "real_model_blind_ab";
  identity: AnswerQualityRunIdentity;
  facts: EvaluationFacts;
  artifactBindings: readonly ArtifactBinding[];
  trace: ProductionTrace;
  userRequest: string;
  explicitSettings: Readonly<Record<string, string | boolean | number>>;
  admittedEvidence: readonly EvidenceForJudge[];
  validCitations: readonly CitationForJudge[];
  error?: { category: string; message: string };
}

export interface EvaluationFinding {
  code: string;
  layer: "identity" | "capability" | "hard_constraint" | "generic_semantic" | "task_family" | "case_extension";
  verdict: "pass" | "fail" | "not_applicable" | "unverified";
  reason: string;
  evidenceLocations?: ReadonlyArray<{ startOffset: number; endOffset: number }>;
  confidence?: number;
}

export interface EvaluatedRun extends AnswerQualityRun {
  scoringStatus: "scored" | "rejected_missing_identity";
  findings: readonly EvaluationFinding[];
}

export interface ReplayFixture {
  caseId: string;
  buildFingerprint: string;
  model: string;
  thinking: boolean;
  finalBody: string;
  admittedEvidence: readonly EvidenceForJudge[];
  validCitations: readonly CitationForJudge[];
  facts: EvaluationFacts;
  artifactBindings: readonly ArtifactBinding[];
}

export interface JudgeInput {
  userRequest: string;
  explicitSettings: Readonly<Record<string, string | boolean | number>>;
  finalBody: string;
  admittedEvidence: readonly EvidenceForJudge[];
  validCitations: readonly CitationForJudge[];
}

export interface JudgeSourceRun extends JudgeInput {}

export interface JudgeDimensionResult {
  layer: "generic_semantic" | "task_family";
  dimension: string;
  verdict: "pass" | "fail" | "not_applicable";
  reason: string;
  evidenceLocations: ReadonlyArray<{ startOffset: number; endOffset: number }>;
  confidence: number;
}

export interface JudgeResult {
  dimensions: readonly JudgeDimensionResult[];
}

export interface PairwiseJudgment {
  repetition: number;
  order: "ab" | "ba";
  /** Winner is expressed in the displayed order, then normalized by the report. */
  winner: "a" | "b" | "tie";
  reason: string;
  confidence: number;
}

export interface PairwiseDiagnostic {
  canonicalWinner: "a" | "b" | "tie" | "inconclusive";
  orderFlipRate: number;
  repeatAgreementRate: number;
  reasons: readonly string[];
}

export interface ReferenceCalibration {
  caseId: string;
  taskFamily: TaskFamily;
  dimension: string;
  referenceVerdict: "pass" | "fail";
  evaluatorVerdict: "pass" | "fail";
  note: string;
}

export interface CalibrationReport {
  sampleCount: number;
  agreementRate: number;
  falsePositiveCount: number;
  falseNegativeCount: number;
  dimensionBias: Record<string, { sampleCount: number; passRateDelta: number }>;
  status: "reference_only_pending_human_review";
}

export interface BaselineSummary {
  evaluatedCaseCount: number;
  defectClasses: string[];
  hardFailureCount: number;
  scoringRejectedCount: number;
}

export interface RealModelUnavailableReport {
  status: "unverified";
  reason: string;
}
