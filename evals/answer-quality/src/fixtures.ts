import { createCurrentBuildCapabilities, createEvaluationFacts } from "./facts.js";
import { ANSWER_QUALITY_CORPUS } from "./corpus.js";
import { ANSWER_QUALITY_CAPABILITIES, type AnswerQualityCase, type ArtifactBinding, type ReplayFixture, type RunAvailabilityFact, type RunExecutionFact } from "./types.js";

export const BASELINE_REPLAYS: readonly ReplayFixture[] = [
  replayFor("multi_turn_reference", "请重新描述你现在的问题，我无法判断上一轮的指代。"),
  replayFor("thinking_body_budget", ""),
  replayFor("long_form_coherence", "1. 第一节说明约束和风险。\n\n1. 第一节说明约束和风险。\n\n2. 结论与前文并不一致。"),
  replayFor("no_qualified_evidence", "- 已有可靠来源，因此这个结论已经确定。"),
  replayFor("completion_contract", "1. 已完成全部要求。"),
];

function replayFor(tag: AnswerQualityCase["coverage"]["robustness"][number], finalBody: string): ReplayFixture {
  const testCase = ANSWER_QUALITY_CORPUS.find((entry) => entry.coverage.robustness.includes(tag))!;
  const capturedAt = "2026-08-31T00:00:00.000Z";
  const availability: RunAvailabilityFact[] = [
    { capabilityId: "context_assembly", state: "available", capturedAt },
    { capabilityId: "final_writing", state: "available", capturedAt },
    { capabilityId: "production_run_record", state: "available", capturedAt },
  ];
  if (testCase.expectation.capabilities.citation_attribution !== "not_applicable") availability.push({ capabilityId: "citation_attribution", state: "unavailable", reason: "replay-has-no-valid-citations", capturedAt });
  const execution: RunExecutionFact[] = [
    { capabilityId: "context_assembly", state: "completed", artifactId: `${testCase.id}:context` },
    { capabilityId: "final_writing", state: "completed", artifactId: `${testCase.id}:body` },
    { capabilityId: "production_run_record", state: "completed", artifactId: `${testCase.id}:run-record` },
  ];
  return {
    caseId: testCase.id,
    buildFingerprint: "collector-baseline-6d8e894c",
    model: testCase.environment.model,
    thinking: testCase.environment.thinking,
    finalBody,
    admittedEvidence: [],
    validCitations: [],
    facts: createEvaluationFacts({
      caseExpectation: { capabilities: { ...testCase.expectation.capabilities } },
      buildCapabilities: createCurrentBuildCapabilities(),
      runAvailability: availability,
      runExecution: execution,
      releaseRequirement: { id: "historical-baseline", capabilities: {} },
    }),
    artifactBindings: bindings(testCase, availability, execution),
  };
}

function bindings(testCase: AnswerQualityCase, availability: readonly RunAvailabilityFact[], execution: readonly RunExecutionFact[]): ArtifactBinding[] {
  const builds = new Map(createCurrentBuildCapabilities().map((entry) => [entry.capabilityId, entry]));
  const available = new Map(availability.map((entry) => [entry.capabilityId, entry]));
  const executed = new Map(execution.map((entry) => [entry.capabilityId, entry]));
  return ANSWER_QUALITY_CAPABILITIES.map((capabilityId): ArtifactBinding => {
    if (testCase.expectation.capabilities[capabilityId] === "not_applicable") return { capabilityId, status: "not_applicable" };
    if (!builds.get(capabilityId)?.supported) return { capabilityId, status: "not_supported_by_build" };
    if (available.get(capabilityId)?.state === "unavailable") return { capabilityId, status: "unavailable", reason: available.get(capabilityId)?.reason };
    const result = executed.get(capabilityId);
    return result?.state === "completed" && result.artifactId
      ? { capabilityId, status: "bound", artifactId: result.artifactId }
      : { capabilityId, status: "unavailable", reason: "replay-artifact-missing" };
  });
}
