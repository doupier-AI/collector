import { researchBodyVersionId } from "@collector/capture-contracts";
import { evaluateCapabilityFacts } from "./facts.js";
import { buildJudgeInput, type AnswerJudgeAdapter } from "./judge.js";
import type {
  AnswerQualityCase,
  AnswerQualityRun,
  EvaluatedRun,
  EvaluationFinding,
  ReplayFixture,
} from "./types.js";

export function evaluateReplay(testCase: AnswerQualityCase, fixture: ReplayFixture): EvaluatedRun {
  const inputMessageId = `replay-input:${testCase.id}`;
  const outputMessageId = `replay-output:${testCase.id}`;
  const run: AnswerQualityRun = {
    mode: "offline_replay",
    identity: {
      caseVersion: testCase.caseVersion,
      caseId: testCase.id,
      taskId: `replay-task:${testCase.id}`,
      inputMessageId,
      outputMessageId,
      bodyVersionId: researchBodyVersionId(outputMessageId, fixture.finalBody),
      generationAttempt: 1,
      model: fixture.model,
      thinking: fixture.thinking,
      buildFingerprint: fixture.buildFingerprint,
    },
    facts: fixture.facts,
    artifactBindings: fixture.artifactBindings.map((entry) => ({ ...entry })),
    trace: { toolCalls: [], providerRequests: [], finalBody: fixture.finalBody, productionRunRecords: [] },
    userRequest: testCase.user.request,
    explicitSettings: { ...testCase.user.explicitSettings },
    admittedEvidence: fixture.admittedEvidence.map((entry) => ({ ...entry })),
    validCitations: fixture.validCitations.map((entry) => ({ ...entry })),
  };
  return evaluateAnswerQualityRun(testCase, run);
}

export function evaluateAnswerQualityRun(testCase: AnswerQualityCase, run: AnswerQualityRun): EvaluatedRun {
  const findings: EvaluationFinding[] = [];
  const identityMissing = missingIdentityBindings(run);
  for (const missing of identityMissing) {
    findings.push({ code: "identity_missing", layer: "identity", verdict: "fail", reason: `缺少已支持且适用产物的身份绑定：${missing}` });
  }
  for (const capability of evaluateCapabilityFacts(run.facts)) {
    findings.push({
      code: `capability_${capability.outcome}`,
      layer: "capability",
      verdict: capability.outcome === "completed" ? "pass" : capability.outcome === "not_applicable" || capability.outcome === "not_executed_optional" ? "not_applicable" : "unverified",
      reason: `${capability.capabilityId}: ${capability.outcome}${capability.reason ? ` (${capability.reason})` : ""}`,
    });
  }
  findings.push(...hardConstraintFindings(testCase, run));
  findings.push(...caseExtensionFindings(testCase, run));
  findings.push({ code: "llm_judge_not_run", layer: "generic_semantic", verdict: "unverified", reason: "离线回放未配置真实 Judge；确定性门禁与案例扩展仍继续评估。" });
  return {
    ...run,
    scoringStatus: identityMissing.length ? "rejected_missing_identity" : "scored",
    findings,
  };
}

export async function evaluateAnswerQualityRunWithJudge(
  testCase: AnswerQualityCase,
  run: AnswerQualityRun,
  judge: AnswerJudgeAdapter,
): Promise<EvaluatedRun> {
  const deterministic = evaluateAnswerQualityRun(testCase, run);
  if (deterministic.scoringStatus === "rejected_missing_identity") return deterministic;
  const judged = await judge.judge(buildJudgeInput({
    userRequest: run.userRequest,
    explicitSettings: run.explicitSettings,
    finalBody: run.trace.finalBody,
    admittedEvidence: run.admittedEvidence,
    validCitations: run.validCitations,
  }));
  const findings = deterministic.findings.filter((finding) => finding.code !== "llm_judge_not_run");
  findings.push(...judged.dimensions.map((dimension) => ({
    code: `judge_${dimension.layer}_${dimension.dimension}`,
    layer: dimension.layer,
    verdict: dimension.verdict,
    reason: dimension.reason,
    evidenceLocations: dimension.evidenceLocations,
    confidence: dimension.confidence,
  } as const)));
  return { ...deterministic, findings };
}

function missingIdentityBindings(run: AnswerQualityRun): string[] {
  const builds = new Map(run.facts.buildCapabilities.map((entry) => [entry.capabilityId, entry]));
  const availability = new Map(run.facts.runAvailability.map((entry) => [entry.capabilityId, entry]));
  const execution = new Map(run.facts.runExecution.map((entry) => [entry.capabilityId, entry]));
  const bindings = new Map(run.artifactBindings.map((entry) => [entry.capabilityId, entry]));
  const missing: string[] = [];
  for (const [capabilityId, expectation] of Object.entries(run.facts.caseExpectation.capabilities)) {
    const id = capabilityId as keyof typeof run.facts.caseExpectation.capabilities;
    if (expectation === "not_applicable" || !builds.get(id)?.supported) continue;
    const executionState = execution.get(id)?.state;
    if (availability.get(id)?.state !== "available" || (executionState !== "completed" && executionState !== "failed")) continue;
    const binding = bindings.get(id);
    const expectedStatus = executionState === "failed" ? "failed" : "bound";
    if (!binding || binding.status !== expectedStatus || !binding.artifactId) missing.push(id);
  }
  const baseIdentity = run.identity;
  if (!baseIdentity.caseVersion || !baseIdentity.caseId || !baseIdentity.taskId || !baseIdentity.inputMessageId || !baseIdentity.outputMessageId || !baseIdentity.bodyVersionId || !baseIdentity.model || !baseIdentity.buildFingerprint || baseIdentity.generationAttempt < 1) missing.push("sample_identity");
  return missing;
}

function hardConstraintFindings(testCase: AnswerQualityCase, run: AnswerQualityRun): EvaluationFinding[] {
  const findings: EvaluationFinding[] = [];
  const body = run.trace.finalBody;
  if (!body.trim()) findings.push({ code: "body_empty", layer: "hard_constraint", verdict: "fail", reason: "最终正文为空。" });
  else if (body.trim().length < testCase.expectation.hardConstraints.minBodyCharacters) findings.push({ code: "body_too_short", layer: "hard_constraint", verdict: "fail", reason: "最终正文短于案例最低完整性阈值。" });
  else findings.push({ code: "body_present", layer: "hard_constraint", verdict: "pass", reason: "最终正文存在且达到最低长度。" });
  if (testCase.expectation.hardConstraints.forbidControlStrings) {
    const match = body.match(/\[\[|\[来源\d+\]|<think>|reasoning_content/i);
    findings.push(match
      ? { code: "control_string_leak", layer: "hard_constraint", verdict: "fail", reason: `正文含控制串：${match[0]}` }
      : { code: "control_string_clean", layer: "hard_constraint", verdict: "pass", reason: "正文未含评测禁止的控制串。" });
  }
  const paragraphs = body.split(/\n\s*\n/).map((entry) => entry.trim()).filter((entry) => entry.length >= 8);
  const repeated = paragraphs.find((entry, index) => paragraphs.indexOf(entry) !== index);
  if (repeated) findings.push({ code: "repeated_paragraph", layer: "hard_constraint", verdict: "fail", reason: "长文出现完全重复段落。" });
  if (testCase.expectation.expectedEvidenceApplicability === "required" && !run.admittedEvidence.length && /可靠来源|已有来源|证据充分|grounded/i.test(body)) {
    findings.push({ code: "unsupported_grounding_claim", layer: "hard_constraint", verdict: "fail", reason: "无已准入证据却声称已有可靠来源。" });
  }
  const format = testCase.expectation.hardConstraints.format;
  const formatPass = format === "natural"
    || format === "continuous_prose" && !/^#{1,6}\s/m.test(body)
    || format === "bullet_list" && /^\s*[-*]\s/m.test(body)
    || format === "table" && /^\s*\|.+\|\s*$/m.test(body)
    || format === "numbered_steps" && /^\s*\d+[.)、]\s*/m.test(body);
  findings.push({ code: formatPass ? "format_satisfied" : "format_missing", layer: "hard_constraint", verdict: formatPass ? "pass" : "fail", reason: formatPass ? "正文满足显式格式。" : `正文未满足显式格式：${format}` });
  return findings;
}

function caseExtensionFindings(testCase: AnswerQualityCase, run: AnswerQualityRun): EvaluationFinding[] {
  const body = run.trace.finalBody;
  const findings: EvaluationFinding[] = [];
  for (const required of testCase.expectation.mustCover) {
    const matched = coverageTerms(required).find((term) => body.includes(term));
    findings.push(matched
      ? { code: "case_coverage_present", layer: "case_extension", verdict: "pass", reason: matched === required ? `正文覆盖“${required}”。` : `正文以等价表述“${matched}”覆盖“${required}”。` }
      : { code: "case_coverage_missing", layer: "case_extension", verdict: "fail", reason: `正文未覆盖“${required}”。` });
  }
  for (const forbidden of testCase.expectation.mustAvoid) {
    if (body.includes(forbidden)) findings.push({ code: "case_forbidden_present", layer: "case_extension", verdict: "fail", reason: `正文出现禁止内容“${forbidden}”。` });
  }
  return findings;
}

/** Bounded, reviewable equivalents for lexical case criteria; semantic Judge scoring stays separate. */
function coverageTerms(required: string): readonly string[] {
  if (required === "结论") return [required, "总结"];
  return [required];
}
