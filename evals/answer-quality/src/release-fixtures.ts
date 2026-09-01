import { createCurrentBuildCapabilities, createEvaluationFacts } from "./facts.js";
import { evaluateReplay } from "./evaluator.js";
import { releaseEvidenceFromEvaluatedRun, type ReleaseRunEvidence } from "./release-profile.js";
import {
  ANSWER_QUALITY_CAPABILITIES,
  type AnswerQualityCase,
  type ArtifactBinding,
  type ReplayFixture,
  type RunAvailabilityFact,
  type RunExecutionFact,
} from "./types.js";

export function createPassingReplayFixture(testCase: AnswerQualityCase, buildFingerprint: string): ReplayFixture {
  const body = passingBody(testCase);
  const qualifiedEvidence = testCase.environment.fixedSearchResults.filter((entry) => entry.qualified);
  const admittedEvidence = qualifiedEvidence.map((entry) => ({ id: entry.id, text: entry.snippet }));
  const firstEvidence = admittedEvidence[0];
  const citationStart = firstEvidence ? body.indexOf(firstEvidence.text) : -1;
  const validCitations = testCase.expectation.capabilities.citation_attribution === "required" && firstEvidence && citationStart >= 0
    ? [{ sourceId: firstEvidence.id, startOffset: citationStart, endOffset: citationStart + firstEvidence.text.length }]
    : [];
  const capturedAt = "2026-09-01T00:00:00.000Z";
  const availability: RunAvailabilityFact[] = [];
  const execution: RunExecutionFact[] = [];
  const artifactBindings: ArtifactBinding[] = [];
  for (const capabilityId of ANSWER_QUALITY_CAPABILITIES) {
    if (testCase.expectation.capabilities[capabilityId] === "not_applicable") {
      artifactBindings.push({ capabilityId, status: "not_applicable" });
      continue;
    }
    const artifactId = `${testCase.id}:${capabilityId}:replay`;
    availability.push({ capabilityId, state: "available", capturedAt });
    execution.push({ capabilityId, state: "completed", artifactId });
    artifactBindings.push({ capabilityId, status: "bound", artifactId });
  }
  return {
    caseId: testCase.id,
    buildFingerprint,
    model: testCase.environment.model,
    thinking: testCase.environment.thinking,
    finalBody: body,
    admittedEvidence,
    validCitations,
    facts: createEvaluationFacts({
      caseExpectation: { capabilities: { ...testCase.expectation.capabilities } },
      buildCapabilities: createCurrentBuildCapabilities(),
      runAvailability: availability,
      runExecution: execution,
      releaseRequirement: { id: "offline-replay", capabilities: {} },
    }),
    artifactBindings,
  };
}

export function createPassingReleaseReplayEvidence(testCase: AnswerQualityCase, buildFingerprint: string): ReleaseRunEvidence {
  return releaseEvidenceFromEvaluatedRun(
    testCase,
    evaluateReplay(testCase, createPassingReplayFixture(testCase, buildFingerprint)),
    "offline_replay",
  );
}

export function passingBody(testCase: AnswerQualityCase): string {
  const coverage = `正文逐项覆盖：${testCase.expectation.mustCover.join("；")}。`;
  const evidence = testCase.environment.fixedSearchResults.find((entry) => entry.qualified)?.snippet;
  const limitation = testCase.coverage.evidencePattern === "search_without_qualified_evidence" ? "没有合格证据，因此保留限制并且不声明来源成立。" : "结论保留适用条件与不确定性。";
  const details = `${coverage}${evidence ? ` ${evidence}` : ""} ${limitation}`;
  switch (testCase.expectation.hardConstraints.format) {
    case "table": return `| 项目 | 说明 |\n| --- | --- |\n| 回答 | ${details.replaceAll("|", "／")} |`;
    case "bullet_list": return `- ${coverage}\n- ${evidence ?? limitation}\n- ${limitation}`;
    case "numbered_steps": return `1. ${coverage}\n2. ${evidence ?? "说明依据边界。"}\n3. ${limitation}`;
    case "continuous_prose": return details;
    default: return details;
  }
}
