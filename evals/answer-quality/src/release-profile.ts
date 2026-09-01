import { createHash } from "node:crypto";
import { evaluateCapabilityFacts } from "./facts.js";
import { comparePairwiseJudgments } from "./judge.js";
import type {
  AnswerQualityCapabilityId,
  AnswerQualityCase,
  AnswerQualityRun,
  AnswerQualityRunIdentity,
  ArtifactBinding,
  CalibrationReport,
  CapabilityFinding,
  EvaluatedRun,
  EvaluationFinding,
  PairwiseDiagnostic,
  PairwiseJudgment,
  ReleaseCapabilityRequirement,
  TaskFamily,
} from "./types.js";

export const RELEASE_PRIMARY_OUTCOMES = [
  "not_applicable",
  "build_capability_missing",
  "run_unavailable",
  "identity_missing",
  "execution_failed",
  "not_verified",
  "semantic_quality_failed",
  "passed",
] as const;

export type ReleasePrimaryOutcome = typeof RELEASE_PRIMARY_OUTCOMES[number];
export type ReleaseGateId = "quick" | "full_offline" | "release_candidate";
export type ReleaseVerificationMethod = "deterministic" | "offline_replay" | "real_model_judge" | "human_review";
export type ReleaseVerdict = "passed" | "failed" | "not_verified";

export interface ReleaseGateRequirement {
  caseIds: readonly string[];
  runModes: readonly AnswerQualityRun["mode"][];
  verificationMethods: readonly ReleaseVerificationMethod[];
  repetitions: number;
  requireBaseline: boolean;
  requirePairwise: boolean;
  requireMetrics: boolean;
}

export interface AnswerQualityReleaseProfile {
  schemaVersion: 1;
  version: string;
  targetVersion: string;
  corpusVersion: string;
  releaseRequirement: {
    id: string;
    capabilities: Partial<Record<AnswerQualityCapabilityId, ReleaseCapabilityRequirement>>;
  };
  gates: Record<ReleaseGateId, ReleaseGateRequirement>;
  calibration: {
    corpusVersion: string;
    minimumSamples: number;
    minimumTaskFamilies: number;
    minimumAgreementRate: number;
    maximumFalsePositiveRate: number;
    maximumFalseNegativeRate: number;
  };
  thresholds: {
    maximumTaskFamilyPassRateRegression: number;
    minimumRepeatAgreementRate: number;
    maximumOrderFlipRate: number;
    maximumMetricCoefficientOfVariation: number;
  };
  longFormDecision: { decisionId: string; verdict: "activated" | "not_activated" };
}

export type ReleaseRunMetrics = NonNullable<AnswerQualityRun["metrics"]>;

export interface ReleaseSemanticVerification {
  status: "verified" | "not_verified";
  method: ReleaseVerificationMethod;
  findings: readonly EvaluationFinding[];
  reason?: string;
}

export interface ReleaseRunEvidence {
  testCase: AnswerQualityCase;
  run: AnswerQualityRun;
  repetition: number;
  conditionFingerprint: string;
  semantic: ReleaseSemanticVerification;
  metrics?: ReleaseRunMetrics;
}

export interface ReleasePairwiseJudgment extends PairwiseJudgment {
  caseId: string;
}

export interface ReleaseEvaluationInput {
  gateId: ReleaseGateId;
  candidateBuildFingerprint: string;
  candidateRuns: readonly ReleaseRunEvidence[];
  baselineRuns?: readonly ReleaseRunEvidence[];
  pairwise?: readonly ReleasePairwiseJudgment[];
  calibration?: CalibrationReport;
  longFormDecision?: { decisionId: string; verdict: "activated" | "not_activated" };
}

export interface ReleaseFinding {
  code: string;
  stage: Exclude<ReleasePrimaryOutcome, "passed"> | "semantic_diagnostic";
  status: "pass" | "fail" | "not_applicable" | "not_verified";
  releaseBlocking: boolean;
  reason: string;
  capabilityId?: AnswerQualityCapabilityId;
  sourceFindingCode?: string;
  sourceLayer?: EvaluationFinding["layer"];
}

export interface ReleaseCaseResult {
  lane: "baseline" | "candidate";
  caseId: string;
  caseVersion: string;
  taskFamily: TaskFamily;
  repetition: number;
  mode: AnswerQualityRun["mode"];
  buildFingerprint: string;
  identity: AnswerQualityRunIdentity;
  artifactBindings: readonly ArtifactBinding[];
  primaryOutcome: ReleasePrimaryOutcome;
  findings: readonly ReleaseFinding[];
  metrics?: ReleaseRunMetrics;
}

export interface ReleaseSliceSummary {
  caseCount: number;
  runCount: number;
  primaryOutcomes: Partial<Record<ReleasePrimaryOutcome, number>>;
  passedRate: number;
  hardFailureCount: number;
}

export interface ReleaseMetricSummary {
  sampleCount: number;
  mean: number | null;
  variance: number | null;
  coefficientOfVariation: number | null;
}

export interface ReleasePairwiseSummary extends PairwiseDiagnostic {
  candidateWinRate: number;
  candidateNonLossRate: number;
  baselineWinRate: number;
  tieRate: number;
  inconclusiveRate: number;
}

export interface ReleaseReport {
  schemaVersion: 1;
  profileVersion: string;
  targetVersion: string;
  corpusVersion: string;
  gateId: ReleaseGateId;
  candidateBuildFingerprint: string;
  verdict: ReleaseVerdict;
  reportFindings: readonly ReleaseFinding[];
  missingEvidence: readonly string[];
  cases: readonly ReleaseCaseResult[];
  slices: {
    hardFailures: ReleaseSliceSummary;
    taskFamilies: Partial<Record<TaskFamily, ReleaseSliceSummary & { baselinePassedRate: number | null; passRateDelta: number | null }>>;
    multiTurnContext: ReleaseSliceSummary;
    thinkingBodyCompletion: ReleaseSliceSummary;
    longFormCoherence: ReleaseSliceSummary;
    evidencePolicyAndAttribution: ReleaseSliceSummary;
    robustnessCalibrationAndCost: {
      summary: ReleaseSliceSummary;
      robustness: Record<string, ReleaseSliceSummary>;
      calibration: { status: "passed" | "failed" | "not_verified"; sampleCount: number; agreementRate: number | null };
      pairwise: Record<string, ReleasePairwiseSummary>;
      metrics: Record<keyof ReleaseRunMetrics, ReleaseMetricSummary>;
    };
  };
}

/**
 * Release Profile is the only external seam. It connects the five fact owners,
 * classifies every run once, and keeps slice/variance policy out of callers.
 */
export class ReleaseQualityModule {
  constructor(private readonly profile: AnswerQualityReleaseProfile) {
    validateReleaseProfile(profile);
  }

  evaluate(input: ReleaseEvaluationInput): ReleaseReport {
    const gate = this.profile.gates[input.gateId];
    const reportFindings: ReleaseFinding[] = [];
    const candidate = input.candidateRuns.map((evidence) => this.evaluateCase("candidate", gate, evidence, input.candidateBuildFingerprint));
    const baseline = (input.baselineRuns ?? []).map((evidence) => this.evaluateCase("baseline", gate, evidence));
    const missingEvidence = expectedEvidenceGaps(gate, input.candidateRuns, input.baselineRuns ?? [], input.pairwise ?? []);
    const conditionProblems = releaseConditionProblems(gate, input.candidateRuns, input.baselineRuns ?? []);
    missingEvidence.push(...conditionProblems);

    const calibration = evaluateCalibration(this.profile, input.calibration, gate);
    if (calibration.status === "failed") reportFindings.push(failedFinding("semantic_quality_failed", "human_calibration_failed", "人工校准未达到 Release Profile 阈值。"));
    if (calibration.status === "not_verified") reportFindings.push(unverifiedFinding("human_calibration_not_verified", "Release Profile 要求的人工校准证据不存在。"));

    if (gate.requireMetrics) {
      missingEvidence.push(...metricEvidenceProblems("candidate", input.candidateRuns));
      if (gate.requireBaseline) missingEvidence.push(...metricEvidenceProblems("baseline", input.baselineRuns ?? []));
    }

    if (input.gateId === "release_candidate") {
      if (!input.longFormDecision
        || input.longFormDecision.decisionId !== this.profile.longFormDecision.decisionId
        || input.longFormDecision.verdict !== this.profile.longFormDecision.verdict) {
        missingEvidence.push(`long-form-decision:${this.profile.longFormDecision.decisionId}:${this.profile.longFormDecision.verdict}`);
      }
    }

    const pairwise = pairwiseDiagnostics(gate, input.pairwise ?? []);
    if (gate.requirePairwise) {
      for (const [caseId, diagnostic] of Object.entries(pairwise)) {
        const caseJudgments = (input.pairwise ?? []).filter((entry) => entry.caseId === caseId);
        if (caseJudgments.length !== gate.repetitions * 2) continue;
        if (diagnostic.orderFlipRate > this.profile.thresholds.maximumOrderFlipRate
          || diagnostic.repeatAgreementRate < this.profile.thresholds.minimumRepeatAgreementRate) {
          reportFindings.push(failedFinding("semantic_quality_failed", "pairwise_instability", `${caseId} 的顺序交换或重复一致性未达到 Release Profile。`));
        }
      }
    }

    const taskFamilies = taskFamilySlices(candidate, baseline);
    for (const [family, summary] of Object.entries(taskFamilies)) {
      if (summary.passRateDelta !== null && summary.passRateDelta < -this.profile.thresholds.maximumTaskFamilyPassRateRegression) {
        reportFindings.push(failedFinding("semantic_quality_failed", "task_family_regression", `${family} 任务族相对基线退化。`));
      }
    }

    const metrics = metricSummaries(input.candidateRuns);
    if (gate.requireMetrics) {
      for (const [metric, summary] of Object.entries(metrics)) {
        if (summary.coefficientOfVariation !== null
          && summary.coefficientOfVariation > this.profile.thresholds.maximumMetricCoefficientOfVariation) {
          reportFindings.push(failedFinding("semantic_quality_failed", "metric_variance_exceeded", `${metric} 方差超过 Release Profile。`));
        }
      }
    }

    const cases = [...baseline, ...candidate];
    const failed = candidate.some((entry) => [
      "build_capability_missing",
      "run_unavailable",
      "identity_missing",
      "execution_failed",
      "semantic_quality_failed",
    ].includes(entry.primaryOutcome)) || reportFindings.some((entry) => entry.status === "fail");
    const notVerified = candidate.some((entry) => entry.primaryOutcome === "not_verified")
      || missingEvidence.length > 0
      || reportFindings.some((entry) => entry.status === "not_verified");
    const verdict: ReleaseVerdict = failed ? "failed" : notVerified ? "not_verified" : "passed";
    const candidateEvidence = input.candidateRuns;

    return {
      schemaVersion: 1,
      profileVersion: this.profile.version,
      targetVersion: this.profile.targetVersion,
      corpusVersion: this.profile.corpusVersion,
      gateId: input.gateId,
      candidateBuildFingerprint: input.candidateBuildFingerprint,
      verdict,
      reportFindings,
      missingEvidence: [...new Set(missingEvidence)].sort(),
      cases,
      slices: {
        hardFailures: summarizeSlice(candidate),
        taskFamilies,
        multiTurnContext: summarizeSlice(candidate.filter((entry) => caseFor(candidateEvidence, entry)?.coverage.multiTurn)),
        thinkingBodyCompletion: summarizeSlice(candidate.filter((entry) => caseFor(candidateEvidence, entry)?.coverage.robustness.includes("thinking_body_budget"))),
        longFormCoherence: summarizeSlice(candidate.filter((entry) => caseFor(candidateEvidence, entry)?.coverage.robustness.includes("long_form_coherence"))),
        evidencePolicyAndAttribution: summarizeSlice(candidate.filter((entry) => {
          const testCase = caseFor(candidateEvidence, entry);
          return testCase && (testCase.coverage.evidencePattern !== "none" || testCase.expectation.capabilities.citation_attribution === "required");
        })),
        robustnessCalibrationAndCost: {
          summary: summarizeSlice(candidate),
          robustness: robustnessSlices(candidate, candidateEvidence),
          calibration,
          pairwise,
          metrics,
        },
      },
    };
  }

  private evaluateCase(
    lane: ReleaseCaseResult["lane"],
    gate: ReleaseGateRequirement,
    evidence: ReleaseRunEvidence,
    candidateBuildFingerprint?: string,
  ): ReleaseCaseResult {
    const applicable = gate.caseIds.includes(evidence.testCase.id);
    const findings: ReleaseFinding[] = [];
    if (!applicable) {
      findings.push({ code: "case_not_in_gate", stage: "not_applicable", status: "not_applicable", releaseBlocking: false, reason: "案例不属于当前 Release Profile gate。" });
      return result(evidence, lane, "not_applicable", findings);
    }

    const capabilities = evaluateCapabilityFacts({
      ...evidence.run.facts,
      releaseRequirement: {
        id: this.profile.releaseRequirement.id,
        capabilities: this.profile.releaseRequirement.capabilities,
      },
    });
    findings.push(...capabilityFindings(capabilities));

    const requiredCapabilities = requiredCapabilitiesFor(this.profile, evidence.testCase);
    for (const capabilityId of requiredCapabilities.implementation) {
      const build = evidence.run.facts.buildCapabilities.find((entry) => entry.capabilityId === capabilityId);
      if (!build?.supported) findings.push(failedCapabilityFinding("build_capability_missing", "build_capability_missing", capabilityId, "目标构建未实现 Release Profile 要求的能力。"));
    }
    for (const capabilityId of requiredCapabilities.availability) {
      const availability = evidence.run.facts.runAvailability.find((entry) => entry.capabilityId === capabilityId);
      if (availability?.state !== "available") findings.push(failedCapabilityFinding("run_unavailable", "run_unavailable", capabilityId, availability?.reason ?? "运行前可用性事实缺失。"));
    }

    for (const issue of identityProblems(evidence, requiredCapabilities.execution, candidateBuildFingerprint)) {
      findings.push(failedFinding("identity_missing", "identity_missing", issue));
    }

    for (const capabilityId of requiredCapabilities.execution) {
      const execution = evidence.run.facts.runExecution.find((entry) => entry.capabilityId === capabilityId);
      if (execution?.state !== "completed") {
        findings.push(failedCapabilityFinding("execution_failed", execution?.state === "failed" ? "execution_failed" : "execution_missing", capabilityId, execution?.errorCategory ?? execution?.state ?? "执行事实缺失。"));
      }
    }

    if (!gate.runModes.includes(evidence.run.mode)) findings.push(unverifiedFinding("run_mode_not_verified", `当前 gate 不接受 ${evidence.run.mode} 作为运行证据。`));
    if (evidence.semantic.status !== "verified" || !gate.verificationMethods.includes(evidence.semantic.method)) {
      findings.push(unverifiedFinding("semantic_verification_missing", evidence.semantic.reason ?? `当前 gate 不接受 ${evidence.semantic.method} 作为语义验证。`));
    }
    for (const semantic of evidence.semantic.findings) {
      findings.push({
        code: semantic.code,
        stage: "semantic_diagnostic",
        status: semantic.verdict === "unverified" ? "not_verified" : semantic.verdict,
        releaseBlocking: semantic.verdict === "fail",
        reason: semantic.reason,
        sourceFindingCode: semantic.code,
        sourceLayer: semantic.layer,
      });
    }

    const primaryOutcome = primaryOutcomeFor(findings);
    return result(evidence, lane, primaryOutcome, findings);
  }
}

export function releaseConditionFingerprint(testCase: AnswerQualityCase): string {
  const productionConditions = {
    caseVersion: testCase.caseVersion,
    user: testCase.user,
    environment: testCase.environment,
  };
  return createHash("sha256").update(canonicalJson(productionConditions)).digest("hex");
}

export function releaseEvidenceFromEvaluatedRun(
  testCase: AnswerQualityCase,
  run: EvaluatedRun,
  method: ReleaseVerificationMethod,
  repetition = 1,
  metrics?: ReleaseRunMetrics,
): ReleaseRunEvidence {
  const findings = run.findings.filter((finding) => finding.layer !== "capability" && finding.layer !== "identity")
    .filter((finding) => method === "real_model_judge" || finding.code !== "llm_judge_not_run");
  const verifiedJudgeLayers = new Set(findings
    .filter((finding) => finding.verdict !== "unverified")
    .map((finding) => finding.layer));
  const missingJudgeLayers = method === "real_model_judge"
    ? (["generic_semantic", "task_family"] as const).filter((layer) => !verifiedJudgeLayers.has(layer))
    : [];
  return {
    testCase,
    run,
    repetition,
    conditionFingerprint: releaseConditionFingerprint(testCase),
    semantic: {
      status: findings.some((finding) => finding.verdict === "unverified") || missingJudgeLayers.length ? "not_verified" : "verified",
      method,
      findings,
      ...(missingJudgeLayers.length ? { reason: `Judge 缺少逐维结果：${missingJudgeLayers.join(", ")}` } : {}),
    },
    ...(metrics ? { metrics: { ...metrics } } : {}),
  };
}

function validateReleaseProfile(profile: AnswerQualityReleaseProfile): void {
  if (profile.schemaVersion !== 1 || !profile.version || !profile.targetVersion || !profile.corpusVersion) throw new Error("Release Profile identity is invalid");
  for (const [gateId, gate] of Object.entries(profile.gates)) {
    if (!gate.caseIds.length || new Set(gate.caseIds).size !== gate.caseIds.length) throw new Error(`${gateId} gate case identities must be non-empty and unique`);
    if (!Number.isSafeInteger(gate.repetitions) || gate.repetitions < 1) throw new Error(`${gateId} gate repetitions must be positive`);
    if (!gate.runModes.length || !gate.verificationMethods.length) throw new Error(`${gateId} gate must declare accepted run and verification modes`);
  }
  const thresholdValues = [
    profile.calibration.minimumAgreementRate,
    profile.calibration.maximumFalsePositiveRate,
    profile.calibration.maximumFalseNegativeRate,
    profile.thresholds.maximumTaskFamilyPassRateRegression,
    profile.thresholds.minimumRepeatAgreementRate,
    profile.thresholds.maximumOrderFlipRate,
    profile.thresholds.maximumMetricCoefficientOfVariation,
  ];
  if (thresholdValues.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error("Release Profile rates must be within [0, 1]");
}

function requiredCapabilitiesFor(profile: AnswerQualityReleaseProfile, testCase: AnswerQualityCase) {
  const implementation: AnswerQualityCapabilityId[] = [];
  const availability: AnswerQualityCapabilityId[] = [];
  const execution: AnswerQualityCapabilityId[] = [];
  for (const [rawId, requirement] of Object.entries(profile.releaseRequirement.capabilities)) {
    const capabilityId = rawId as AnswerQualityCapabilityId;
    if (requirement?.mustImplement) implementation.push(capabilityId);
    if (testCase.expectation.capabilities[capabilityId] !== "required") continue;
    if (requirement?.mustBeAvailable) availability.push(capabilityId);
    if (requirement?.mustSucceed) execution.push(capabilityId);
  }
  return { implementation, availability, execution };
}

function identityProblems(evidence: ReleaseRunEvidence, required: readonly AnswerQualityCapabilityId[], candidateBuildFingerprint?: string): string[] {
  const problems: string[] = [];
  const identity = evidence.run.identity;
  if (identity.caseId !== evidence.testCase.id || identity.caseVersion !== evidence.testCase.caseVersion) problems.push("案例身份与运行身份不一致。");
  if (!identity.taskId || !identity.inputMessageId || !identity.outputMessageId || !identity.bodyVersionId || !identity.model || !identity.buildFingerprint || identity.generationAttempt < 1) problems.push("样本生产身份不完整。");
  if (candidateBuildFingerprint && identity.buildFingerprint !== candidateBuildFingerprint) problems.push("候选运行未绑定当前候选构建指纹。");
  if (evidence.conditionFingerprint !== releaseConditionFingerprint(evidence.testCase)) problems.push("运行条件指纹不匹配案例的生产输入。");
  const bindings = new Map(evidence.run.artifactBindings.map((entry) => [entry.capabilityId, entry]));
  const executions = new Map(evidence.run.facts.runExecution.map((entry) => [entry.capabilityId, entry]));
  for (const capabilityId of required) {
    const execution = executions.get(capabilityId);
    if (execution?.state !== "completed" && execution?.state !== "failed") continue;
    const binding = bindings.get(capabilityId);
    const expectedStatus = execution.state === "completed" ? "bound" : "failed";
    if (!binding?.artifactId || binding.status !== expectedStatus) problems.push(`${capabilityId} 的${execution.state === "failed" ? "失败" : "完成"}执行缺少可绑定身份。`);
  }
  return problems;
}

function capabilityFindings(capabilities: readonly CapabilityFinding[]): ReleaseFinding[] {
  return capabilities.map((finding) => ({
    code: `capability_${finding.outcome}`,
    stage: finding.outcome === "not_applicable" ? "not_applicable"
      : finding.outcome === "not_supported_by_build" ? "build_capability_missing"
        : finding.outcome === "unavailable" ? "run_unavailable"
          : finding.outcome === "execution_failed" || finding.outcome === "missing_execution" ? "execution_failed"
            : "semantic_diagnostic",
    status: finding.outcome === "completed" ? "pass"
      : finding.outcome === "not_applicable" || finding.outcome === "not_executed_optional" ? "not_applicable"
        : finding.releaseBlocking ? "fail" : "not_verified",
    releaseBlocking: finding.releaseBlocking,
    reason: `${finding.capabilityId}: ${finding.outcome}${finding.reason ? ` (${finding.reason})` : ""}`,
    capabilityId: finding.capabilityId,
  }));
}

function primaryOutcomeFor(findings: readonly ReleaseFinding[]): ReleasePrimaryOutcome {
  const blocking = new Set(findings.filter((finding) => finding.releaseBlocking || finding.stage === "not_verified").map((finding) => finding.stage));
  for (const outcome of RELEASE_PRIMARY_OUTCOMES) {
    if (outcome === "passed") continue;
    if (blocking.has(outcome)) return outcome;
  }
  if (findings.some((finding) => finding.stage === "semantic_diagnostic" && finding.status === "fail")) return "semantic_quality_failed";
  return "passed";
}

function expectedEvidenceGaps(
  gate: ReleaseGateRequirement,
  candidate: readonly ReleaseRunEvidence[],
  baseline: readonly ReleaseRunEvidence[],
  pairwise: readonly ReleasePairwiseJudgment[],
): string[] {
  const gaps: string[] = [];
  for (const caseId of gate.caseIds) {
    for (let repetition = 1; repetition <= gate.repetitions; repetition += 1) {
      evidenceCardinalityGap(gaps, candidate, caseId, repetition, "candidate");
      if (gate.requireBaseline) evidenceCardinalityGap(gaps, baseline, caseId, repetition, "baseline");
      if (gate.requirePairwise) {
        for (const order of ["ab", "ba"] as const) {
          const count = pairwise.filter((entry) => entry.caseId === caseId && entry.repetition === repetition && entry.order === order).length;
          if (count !== 1) gaps.push(`${caseId}:pairwise:${repetition}:${order}:${count ? "duplicate" : "missing"}`);
        }
      }
    }
  }
  return gaps;
}

function evidenceCardinalityGap(
  gaps: string[],
  evidence: readonly ReleaseRunEvidence[],
  caseId: string,
  repetition: number,
  lane: "candidate" | "baseline",
): void {
  const count = evidence.filter((entry) => entry.testCase.id === caseId && entry.repetition === repetition).length;
  if (count !== 1) gaps.push(`${caseId}:${lane}:${repetition}:${count ? "duplicate" : "missing"}`);
}

function metricEvidenceProblems(lane: "candidate" | "baseline", runs: readonly ReleaseRunEvidence[]): string[] {
  return runs.flatMap((entry) => {
    const prefix = `${entry.testCase.id}:${lane}:${entry.repetition}:metrics`;
    if (!entry.metrics) return [prefix];
    return validMetrics(entry.metrics) ? [] : [`${prefix}:invalid`];
  });
}

function validMetrics(metrics: ReleaseRunMetrics): boolean {
  return Number.isSafeInteger(metrics.outputTokens)
    && metrics.outputTokens > 0
    && Number.isFinite(metrics.estimatedCostUsd)
    && metrics.estimatedCostUsd >= 0
    && Number.isFinite(metrics.firstCharacterLatencyMs)
    && metrics.firstCharacterLatencyMs >= 0
    && Number.isFinite(metrics.completeLatencyMs)
    && metrics.completeLatencyMs >= metrics.firstCharacterLatencyMs;
}

function releaseConditionProblems(gate: ReleaseGateRequirement, candidate: readonly ReleaseRunEvidence[], baseline: readonly ReleaseRunEvidence[]): string[] {
  if (!gate.requireBaseline) return [];
  const problems: string[] = [];
  for (const candidateRun of candidate) {
    const baselineRun = baseline.find((entry) => entry.testCase.id === candidateRun.testCase.id && entry.repetition === candidateRun.repetition);
    if (baselineRun && baselineRun.conditionFingerprint !== candidateRun.conditionFingerprint) problems.push(`${candidateRun.testCase.id}:${candidateRun.repetition}:condition-mismatch`);
  }
  return problems;
}

function evaluateCalibration(profile: AnswerQualityReleaseProfile, report: CalibrationReport | undefined, gate: ReleaseGateRequirement) {
  if (!gate.requirePairwise && !gate.requireMetrics) return { status: "passed" as const, sampleCount: report?.sampleCount ?? 0, agreementRate: report?.agreementRate ?? null };
  if (!report || report.status !== "human_reviewed" || report.corpusVersion !== profile.calibration.corpusVersion) return { status: "not_verified" as const, sampleCount: report?.sampleCount ?? 0, agreementRate: report?.agreementRate ?? null };
  const falsePositiveRate = report.sampleCount ? report.falsePositiveCount / report.sampleCount : 1;
  const falseNegativeRate = report.sampleCount ? report.falseNegativeCount / report.sampleCount : 1;
  const passed = report.sampleCount >= profile.calibration.minimumSamples
    && report.taskFamilyCount >= profile.calibration.minimumTaskFamilies
    && report.agreementRate >= profile.calibration.minimumAgreementRate
    && falsePositiveRate <= profile.calibration.maximumFalsePositiveRate
    && falseNegativeRate <= profile.calibration.maximumFalseNegativeRate;
  return { status: passed ? "passed" as const : "failed" as const, sampleCount: report.sampleCount, agreementRate: report.agreementRate };
}

function pairwiseDiagnostics(gate: ReleaseGateRequirement, judgments: readonly ReleasePairwiseJudgment[]): Record<string, ReleasePairwiseSummary> {
  return Object.fromEntries(gate.caseIds.map((caseId) => {
    const caseJudgments = judgments.filter((entry) => entry.caseId === caseId);
    const diagnostic = comparePairwiseJudgments(caseJudgments);
    const winners = [...new Set(caseJudgments.map((entry) => entry.repetition))].map((repetition) => {
      const normalized = caseJudgments.filter((entry) => entry.repetition === repetition).map(canonicalPairwiseWinner);
      return normalized.length === 2 && normalized[0] === normalized[1] ? normalized[0]! : "inconclusive" as const;
    });
    const rate = (winner: "a" | "b" | "tie" | "inconclusive") => winners.length ? winners.filter((entry) => entry === winner).length / winners.length : 0;
    return [caseId, {
      ...diagnostic,
      candidateWinRate: rate("b"),
      candidateNonLossRate: rate("b") + rate("tie"),
      baselineWinRate: rate("a"),
      tieRate: rate("tie"),
      inconclusiveRate: rate("inconclusive"),
    }];
  }));
}

function canonicalPairwiseWinner(entry: ReleasePairwiseJudgment): "a" | "b" | "tie" {
  if (entry.winner === "tie") return "tie";
  if (entry.order === "ab") return entry.winner;
  return entry.winner === "a" ? "b" : "a";
}

function taskFamilySlices(candidate: readonly ReleaseCaseResult[], baseline: readonly ReleaseCaseResult[]): ReleaseReport["slices"]["taskFamilies"] {
  const families = [...new Set(candidate.map((entry) => entry.taskFamily))];
  return Object.fromEntries(families.map((family) => {
    const current = summarizeSlice(candidate.filter((entry) => entry.taskFamily === family));
    const historical = baseline.filter((entry) => entry.taskFamily === family);
    const baselinePassedRate = historical.length ? summarizeSlice(historical).passedRate : null;
    return [family, { ...current, baselinePassedRate, passRateDelta: baselinePassedRate === null ? null : current.passedRate - baselinePassedRate }];
  }));
}

function summarizeSlice(results: readonly ReleaseCaseResult[]): ReleaseSliceSummary {
  const caseCount = new Set(results.map((entry) => entry.caseId)).size;
  const outcomes: Partial<Record<ReleasePrimaryOutcome, number>> = {};
  for (const entry of results) outcomes[entry.primaryOutcome] = (outcomes[entry.primaryOutcome] ?? 0) + 1;
  return {
    caseCount,
    runCount: results.length,
    primaryOutcomes: outcomes,
    passedRate: results.length ? results.filter((entry) => entry.primaryOutcome === "passed").length / results.length : 0,
    hardFailureCount: results.reduce((count, entry) => count + entry.findings.filter((finding) => finding.sourceLayer === "hard_constraint" && finding.status === "fail").length, 0),
  };
}

function robustnessSlices(results: readonly ReleaseCaseResult[], evidence: readonly ReleaseRunEvidence[]): Record<string, ReleaseSliceSummary> {
  const tags = [...new Set(evidence.flatMap((entry) => entry.testCase.coverage.robustness))].sort();
  return Object.fromEntries(tags.map((tag) => [tag, summarizeSlice(results.filter((result) => caseFor(evidence, result)?.coverage.robustness.includes(tag)))]));
}

function metricSummaries(runs: readonly ReleaseRunEvidence[]): Record<keyof ReleaseRunMetrics, ReleaseMetricSummary> {
  const keys: Array<keyof ReleaseRunMetrics> = ["outputTokens", "estimatedCostUsd", "firstCharacterLatencyMs", "completeLatencyMs"];
  return Object.fromEntries(keys.map((key) => [key, metricSummary(runs.flatMap((entry) => entry.metrics && validMetrics(entry.metrics) ? [entry.metrics[key]] : []))])) as Record<keyof ReleaseRunMetrics, ReleaseMetricSummary>;
}

function metricSummary(values: readonly number[]): ReleaseMetricSummary {
  if (!values.length) return { sampleCount: 0, mean: null, variance: null, coefficientOfVariation: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { sampleCount: values.length, mean, variance, coefficientOfVariation: mean === 0 ? (variance === 0 ? 0 : null) : Math.sqrt(variance) / mean };
}

function caseFor(evidence: readonly ReleaseRunEvidence[], result: ReleaseCaseResult): AnswerQualityCase | undefined {
  return evidence.find((entry) => entry.testCase.id === result.caseId && entry.repetition === result.repetition)?.testCase;
}

function result(evidence: ReleaseRunEvidence, lane: ReleaseCaseResult["lane"], primaryOutcome: ReleasePrimaryOutcome, findings: readonly ReleaseFinding[]): ReleaseCaseResult {
  return {
    lane,
    caseId: evidence.testCase.id,
    caseVersion: evidence.testCase.caseVersion,
    taskFamily: evidence.testCase.coverage.taskFamily,
    repetition: evidence.repetition,
    mode: evidence.run.mode,
    buildFingerprint: evidence.run.identity.buildFingerprint,
    identity: { ...evidence.run.identity },
    artifactBindings: evidence.run.artifactBindings.map((entry) => ({ ...entry })),
    primaryOutcome,
    findings,
    ...(evidence.metrics ? { metrics: { ...evidence.metrics } } : {}),
  };
}

function failedCapabilityFinding(stage: Exclude<ReleasePrimaryOutcome, "passed">, code: string, capabilityId: AnswerQualityCapabilityId, reason: string): ReleaseFinding {
  return { code, stage, status: "fail", releaseBlocking: true, reason, capabilityId };
}

function failedFinding(stage: Exclude<ReleasePrimaryOutcome, "passed">, code: string, reason: string): ReleaseFinding {
  return { code, stage, status: "fail", releaseBlocking: true, reason };
}

function unverifiedFinding(code: string, reason: string): ReleaseFinding {
  return { code, stage: "not_verified", status: "not_verified", releaseBlocking: true, reason };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonicalValue(entry)]));
}
