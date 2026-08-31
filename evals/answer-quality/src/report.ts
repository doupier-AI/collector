import { evaluateReplay } from "./evaluator.js";
import type { AnswerQualityCase, BaselineSummary, CalibrationReport, ReferenceCalibration, ReplayFixture } from "./types.js";

export function summarizeBaseline(corpus: readonly AnswerQualityCase[], replays: readonly ReplayFixture[]): BaselineSummary {
  const evaluated = replays.map((replay) => {
    const testCase = corpus.find((entry) => entry.id === replay.caseId);
    if (!testCase) throw new Error(`Baseline replay references an unknown case: ${replay.caseId}`);
    return evaluateReplay(testCase, replay);
  });
  const classes = new Set<string>();
  for (const run of evaluated) {
    for (const finding of run.findings.filter((entry) => entry.verdict === "fail")) {
      if (finding.code === "case_coverage_missing") classes.add("multi_turn_or_completion_coverage");
      else if (finding.code === "body_empty") classes.add("thinking_body_incomplete");
      else if (finding.code === "repeated_paragraph") classes.add("long_form_repetition");
      else if (finding.code === "unsupported_grounding_claim") classes.add("evidence_integrity_failure");
      else if (finding.code === "format_missing") classes.add("explicit_format_failure");
    }
  }
  return {
    evaluatedCaseCount: evaluated.length,
    defectClasses: [...classes].sort(),
    hardFailureCount: evaluated.flatMap((run) => run.findings).filter((finding) => finding.layer === "hard_constraint" && finding.verdict === "fail").length,
    scoringRejectedCount: evaluated.filter((run) => run.scoringStatus === "rejected_missing_identity").length,
  };
}

export function calculateCalibrationReport(samples: readonly ReferenceCalibration[]): CalibrationReport {
  const agreements = samples.filter((entry) => entry.referenceVerdict === entry.evaluatorVerdict).length;
  const falsePositiveCount = samples.filter((entry) => entry.referenceVerdict === "fail" && entry.evaluatorVerdict === "pass").length;
  const falseNegativeCount = samples.filter((entry) => entry.referenceVerdict === "pass" && entry.evaluatorVerdict === "fail").length;
  const dimensions = [...new Set(samples.map((entry) => entry.dimension))];
  const dimensionBias = Object.fromEntries(dimensions.map((dimension) => {
    const entries = samples.filter((entry) => entry.dimension === dimension);
    const referencePassRate = entries.filter((entry) => entry.referenceVerdict === "pass").length / entries.length;
    const evaluatorPassRate = entries.filter((entry) => entry.evaluatorVerdict === "pass").length / entries.length;
    return [dimension, { sampleCount: entries.length, passRateDelta: evaluatorPassRate - referencePassRate }];
  }));
  return {
    sampleCount: samples.length,
    agreementRate: samples.length ? agreements / samples.length : 0,
    falsePositiveCount,
    falseNegativeCount,
    dimensionBias,
    status: "reference_only_pending_human_review",
  };
}
