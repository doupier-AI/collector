export const LONG_FORM_GATE_CANDIDATES = [
  "current_final_writing",
  "minimal_prompt_adjustment",
  "long_form_state_prototype",
] as const;

export type LongFormGateCandidateId = typeof LONG_FORM_GATE_CANDIDATES[number];

export const LONG_FORM_GATE_DIMENSIONS = [
  "cross_section_repetition",
  "cross_section_contradiction",
  "required_operation_coverage",
  "terminology_consistency",
  "completion_integrity",
] as const;

export type LongFormGateDimension = typeof LONG_FORM_GATE_DIMENSIONS[number];
export type LongFormGateVerdict = "pass" | "fail" | "unverified";

export interface LongFormGateDimensionResult {
  verdict: LongFormGateVerdict;
  reason: string;
  confidence?: number;
}

export interface LongFormGateRunMetrics {
  outputTokens: number;
  estimatedCostUsd: number;
  firstCharacterLatencyMs: number;
  completeLatencyMs: number;
}

export interface LongFormGateRunResult {
  candidateId: LongFormGateCandidateId;
  repetition: number;
  evidenceVerified: boolean;
  dimensions: Record<LongFormGateDimension, LongFormGateDimensionResult>;
  metrics: LongFormGateRunMetrics;
}

export interface LongFormGatePairwiseResult {
  repetition: number;
  canonicalWinner: "minimal_prompt_adjustment" | "long_form_state_prototype" | "tie" | "inconclusive";
}

export interface LongFormGateThresholds {
  stableDefectMinimumRuns: number;
  releaseLineMinimumFullyPassingRuns: number;
  minimumLongFormStateDimensionPassRateGain: number;
  minimumLongFormStatePairwiseWinsAgainstMinimal: number;
  maximumOutputTokenIncreaseRatio: number;
  maximumEstimatedCostIncreaseRatio: number;
  maximumFirstCharacterLatencyIncreaseRatio: number;
  maximumCompleteLatencyIncreaseRatio: number;
  noDimensionRegression: boolean;
}

export interface LongFormGateDecision {
  verdict: "activated" | "not_activated";
  stableCurrentDefects: LongFormGateDimension[];
  fullyPassingRuns: Record<LongFormGateCandidateId, number>;
  dimensionPassRates: Record<LongFormGateCandidateId, number>;
  longFormStatePassRateGain: number;
  pairwiseLongFormStateWins: number;
  dimensionRegressions: LongFormGateDimension[];
  resourceIncreaseRatios: LongFormGateRunMetrics;
  checks: {
    evidenceComplete: boolean;
    currentDefectStable: boolean;
    currentBelowReleaseLine: boolean;
    minimalBelowReleaseLine: boolean;
    longFormStateAtReleaseLine: boolean;
    passRateGainMet: boolean;
    pairwiseWinsMet: boolean;
    noDimensionRegression: boolean;
    resourcesWithinLimits: boolean;
  };
  reasons: string[];
}

export function findCrossSectionExactRepetitions(sections: readonly string[]): string[] {
  const owners = new Map<string, number>();
  const repeated = new Set<string>();
  sections.forEach((section, sectionIndex) => {
    const paragraphs = section
      .split(/\n\s*\n/)
      .map(normalizeParagraph)
      .filter((paragraph) => paragraph.length >= 40);
    for (const paragraph of new Set(paragraphs)) {
      const owner = owners.get(paragraph);
      if (owner !== undefined && owner !== sectionIndex) repeated.add(paragraph);
      else owners.set(paragraph, sectionIndex);
    }
  });
  return [...repeated].sort();
}

export function evaluateLongFormCompletion(input: {
  sections: readonly string[];
  expectedHeadings: readonly string[];
  finishReasons: readonly (string | undefined)[];
}): LongFormGateDimensionResult {
  if (input.sections.length !== input.expectedHeadings.length) {
    return { verdict: "fail", reason: `Expected ${input.expectedHeadings.length} completed sections but received ${input.sections.length}.` };
  }
  if (input.finishReasons.some((reason) => reason === "length")) {
    return { verdict: "fail", reason: "At least one section ended with finishReason=length." };
  }
  for (let index = 0; index < input.sections.length; index += 1) {
    const section = input.sections[index] ?? "";
    const heading = input.expectedHeadings[index] ?? "";
    if (!section.trim()) return { verdict: "fail", reason: `Section ${index + 1} is empty.` };
    if (section.includes("[本节生成失败")) return { verdict: "fail", reason: `Section ${index + 1} contains a generation-failure marker.` };
    if (!firstHeading(section).includes(heading)) return { verdict: "fail", reason: `Section ${index + 1} does not begin with its planned heading.` };
  }
  return { verdict: "pass", reason: "Every planned section completed with its stable heading and no truncation signal." };
}

export function decideLongFormGate(input: {
  runs: readonly LongFormGateRunResult[];
  pairwise: readonly LongFormGatePairwiseResult[];
  repetitions: number;
  thresholds: LongFormGateThresholds;
}): LongFormGateDecision {
  const grouped = Object.fromEntries(LONG_FORM_GATE_CANDIDATES.map((candidateId) => [
    candidateId,
    input.runs.filter((run) => run.candidateId === candidateId).sort((left, right) => left.repetition - right.repetition),
  ])) as Record<LongFormGateCandidateId, LongFormGateRunResult[]>;
  const evidenceComplete = LONG_FORM_GATE_CANDIDATES.every((candidateId) => {
    const runs = grouped[candidateId];
    return runs.length === input.repetitions
      && runs.every((run, index) => run.repetition === index + 1)
      && runs.every((run) => run.evidenceVerified)
      && runs.every((run) => LONG_FORM_GATE_DIMENSIONS.every((dimension) => run.dimensions[dimension]?.verdict !== "unverified"))
      && runs.every((run) => Object.values(run.metrics).every((value) => Number.isFinite(value) && value >= 0));
  }) && input.pairwise.length === input.repetitions
    && input.pairwise.every((entry, index) => entry.repetition === index + 1);

  const stableCurrentDefects = LONG_FORM_GATE_DIMENSIONS.filter((dimension) =>
    grouped.current_final_writing.filter((run) => run.dimensions[dimension].verdict === "fail").length >= input.thresholds.stableDefectMinimumRuns,
  );
  const fullyPassingRuns = Object.fromEntries(LONG_FORM_GATE_CANDIDATES.map((candidateId) => [
    candidateId,
    grouped[candidateId].filter(runFullyPasses).length,
  ])) as Record<LongFormGateCandidateId, number>;
  const dimensionPassRates = Object.fromEntries(LONG_FORM_GATE_CANDIDATES.map((candidateId) => [
    candidateId,
    dimensionPassRate(grouped[candidateId]),
  ])) as Record<LongFormGateCandidateId, number>;
  const longFormStatePassRateGain = dimensionPassRates.long_form_state_prototype - dimensionPassRates.minimal_prompt_adjustment;
  const pairwiseLongFormStateWins = input.pairwise.filter((entry) => entry.canonicalWinner === "long_form_state_prototype").length;
  const dimensionRegressions = input.thresholds.noDimensionRegression
    ? LONG_FORM_GATE_DIMENSIONS.filter((dimension) => passCount(grouped.long_form_state_prototype, dimension) < passCount(grouped.minimal_prompt_adjustment, dimension))
    : [];
  const resourceIncreaseRatios = resourceRatios(grouped.minimal_prompt_adjustment, grouped.long_form_state_prototype);
  const resourcesWithinLimits = resourceIncreaseRatios.outputTokens <= input.thresholds.maximumOutputTokenIncreaseRatio
    && resourceIncreaseRatios.estimatedCostUsd <= input.thresholds.maximumEstimatedCostIncreaseRatio
    && resourceIncreaseRatios.firstCharacterLatencyMs <= input.thresholds.maximumFirstCharacterLatencyIncreaseRatio
    && resourceIncreaseRatios.completeLatencyMs <= input.thresholds.maximumCompleteLatencyIncreaseRatio;
  const checks = {
    evidenceComplete,
    currentDefectStable: stableCurrentDefects.length > 0,
    currentBelowReleaseLine: fullyPassingRuns.current_final_writing < input.thresholds.releaseLineMinimumFullyPassingRuns,
    minimalBelowReleaseLine: fullyPassingRuns.minimal_prompt_adjustment < input.thresholds.releaseLineMinimumFullyPassingRuns,
    longFormStateAtReleaseLine: fullyPassingRuns.long_form_state_prototype >= input.thresholds.releaseLineMinimumFullyPassingRuns,
    passRateGainMet: longFormStatePassRateGain + Number.EPSILON >= input.thresholds.minimumLongFormStateDimensionPassRateGain,
    pairwiseWinsMet: pairwiseLongFormStateWins >= input.thresholds.minimumLongFormStatePairwiseWinsAgainstMinimal,
    noDimensionRegression: dimensionRegressions.length === 0,
    resourcesWithinLimits,
  };
  const activated = Object.values(checks).every(Boolean);
  const reasons = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => activationFailureReason(name as keyof typeof checks));
  return {
    verdict: activated ? "activated" : "not_activated",
    stableCurrentDefects,
    fullyPassingRuns,
    dimensionPassRates,
    longFormStatePassRateGain,
    pairwiseLongFormStateWins,
    dimensionRegressions,
    resourceIncreaseRatios,
    checks,
    reasons,
  };
}

function normalizeParagraph(value: string): string {
  return value.replace(/^#{1,6}\s+/, "").replace(/\s+/g, " ").trim().toLocaleLowerCase("zh-CN");
}

function firstHeading(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimStart().split("\n", 1)[0]?.replace(/^##(?!#)\s+/, "").trim() ?? "";
}

function runFullyPasses(run: LongFormGateRunResult): boolean {
  return LONG_FORM_GATE_DIMENSIONS.every((dimension) => run.dimensions[dimension].verdict === "pass");
}

function passCount(runs: readonly LongFormGateRunResult[], dimension: LongFormGateDimension): number {
  return runs.filter((run) => run.dimensions[dimension].verdict === "pass").length;
}

function dimensionPassRate(runs: readonly LongFormGateRunResult[]): number {
  const total = runs.length * LONG_FORM_GATE_DIMENSIONS.length;
  if (!total) return 0;
  return runs.reduce((count, run) => count + LONG_FORM_GATE_DIMENSIONS.filter((dimension) => run.dimensions[dimension].verdict === "pass").length, 0) / total;
}

function resourceRatios(minimal: readonly LongFormGateRunResult[], state: readonly LongFormGateRunResult[]): LongFormGateRunMetrics {
  return {
    outputTokens: increaseRatio(meanMetric(minimal, "outputTokens"), meanMetric(state, "outputTokens")),
    estimatedCostUsd: increaseRatio(meanMetric(minimal, "estimatedCostUsd"), meanMetric(state, "estimatedCostUsd")),
    firstCharacterLatencyMs: increaseRatio(meanMetric(minimal, "firstCharacterLatencyMs"), meanMetric(state, "firstCharacterLatencyMs")),
    completeLatencyMs: increaseRatio(meanMetric(minimal, "completeLatencyMs"), meanMetric(state, "completeLatencyMs")),
  };
}

function meanMetric(runs: readonly LongFormGateRunResult[], metric: keyof LongFormGateRunMetrics): number {
  if (!runs.length) return Number.NaN;
  return runs.reduce((sum, run) => sum + run.metrics[metric], 0) / runs.length;
}

function increaseRatio(baseline: number, candidate: number): number {
  if (baseline === 0) return candidate === 0 ? 0 : Number.POSITIVE_INFINITY;
  return (candidate - baseline) / baseline;
}

function activationFailureReason(check: keyof LongFormGateDecision["checks"]): string {
  const reasons: Record<typeof check, string> = {
    evidenceComplete: "The preregistered real-run or pairwise evidence packet is incomplete or unverified.",
    currentDefectStable: "The current Final Writing implementation did not reproduce one must-pass defect in the preregistered minimum number of runs.",
    currentBelowReleaseLine: "The current Final Writing implementation already reached the preregistered release line.",
    minimalBelowReleaseLine: "The minimal prompt adjustment reached the preregistered release line, so a deeper LongFormState module is not required.",
    longFormStateAtReleaseLine: "The LongFormState prototype did not reach the preregistered release line.",
    passRateGainMet: "The LongFormState dimension pass-rate gain was below the preregistered threshold.",
    pairwiseWinsMet: "The LongFormState prototype did not achieve enough stable blind pairwise wins.",
    noDimensionRegression: "The LongFormState prototype regressed at least one must-pass dimension.",
    resourcesWithinLimits: "The LongFormState prototype exceeded at least one preregistered token, cost, first-character, or complete-latency limit.",
  };
  return reasons[check];
}
