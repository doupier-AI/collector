import { evaluateReplay } from "./evaluator.js";
import type { AnswerQualityCase, BaselineSummary, ReplayFixture } from "./types.js";

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
