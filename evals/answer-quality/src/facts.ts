import {
  ANSWER_QUALITY_CAPABILITIES,
  type AnswerQualityCapabilityId,
  type BuildCapabilityFact,
  type CapabilityFinding,
  type EvaluationFacts,
} from "./types.js";

export function createCurrentBuildCapabilities(): BuildCapabilityFact[] {
  return [
    { capabilityId: "conversation_context", supported: true, version: "conversation-context-resolver-v1" },
    { capabilityId: "answer_plan", supported: false },
    { capabilityId: "prompt_envelope", supported: false },
    { capabilityId: "context_assembly", supported: true, version: "context-assembly-v1" },
    { capabilityId: "evidence_preparation", supported: false },
    { capabilityId: "citation_attribution", supported: true, version: "citation-sidecar-v1" },
    { capabilityId: "final_writing", supported: true, version: "research-body-context-v1" },
    { capabilityId: "production_run_record", supported: true, version: "model-call-record-v1" },
  ];
}

export function createEvaluationFacts(facts: EvaluationFacts): EvaluationFacts {
  return {
    caseExpectation: { capabilities: { ...facts.caseExpectation.capabilities } },
    buildCapabilities: facts.buildCapabilities.map((entry) => ({ ...entry })),
    runAvailability: facts.runAvailability.map((entry) => ({ ...entry })),
    runExecution: facts.runExecution.map((entry) => ({ ...entry })),
    releaseRequirement: {
      id: facts.releaseRequirement.id,
      capabilities: Object.fromEntries(Object.entries(facts.releaseRequirement.capabilities).map(([id, requirement]) => [id, { ...requirement }])),
    },
  };
}

export function evaluateCapabilityFacts(facts: EvaluationFacts): CapabilityFinding[] {
  const builds = new Map(facts.buildCapabilities.map((entry) => [entry.capabilityId, entry]));
  const availability = new Map(facts.runAvailability.map((entry) => [entry.capabilityId, entry]));
  const execution = new Map(facts.runExecution.map((entry) => [entry.capabilityId, entry]));
  return ANSWER_QUALITY_CAPABILITIES.map((capabilityId) => {
    const expectation = facts.caseExpectation.capabilities[capabilityId];
    const build = builds.get(capabilityId);
    const available = availability.get(capabilityId);
    const executed = execution.get(capabilityId);
    let outcome: CapabilityFinding["outcome"];
    let reason: string | undefined;
    if (expectation === "not_applicable") outcome = "not_applicable";
    else if (!build?.supported) outcome = "not_supported_by_build";
    else if (available?.state === "unavailable") {
      outcome = "unavailable";
      reason = available.reason;
    } else if (executed?.state === "failed") {
      outcome = "execution_failed";
      reason = executed.errorCategory;
    } else if (executed?.state === "completed") outcome = "completed";
    else if (expectation === "optional") outcome = "not_executed_optional";
    else outcome = "missing_execution";
    return {
      capabilityId,
      outcome,
      releaseBlocking: isReleaseBlocking(capabilityId, outcome, facts),
      ...(reason ? { reason } : {}),
    };
  });
}

function isReleaseBlocking(capabilityId: AnswerQualityCapabilityId, outcome: CapabilityFinding["outcome"], facts: EvaluationFacts): boolean {
  const requirement = facts.releaseRequirement.capabilities[capabilityId];
  if (!requirement) return false;
  if (requirement.mustImplement && outcome === "not_supported_by_build") return true;
  if (requirement.mustBeAvailable && outcome === "unavailable") return true;
  if (requirement.mustSucceed && ["execution_failed", "missing_execution"].includes(outcome)) return true;
  return false;
}
