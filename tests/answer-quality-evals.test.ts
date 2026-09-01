import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ANSWER_QUALITY_CAPABILITIES,
  ANSWER_QUALITY_CORPUS,
  ANSWER_QUALITY_CORPUS_VERSION,
  BASELINE_REPLAYS,
  HUMAN_CALIBRATION_CANDIDATES,
  buildJudgeInput,
  calculateHumanCalibrationReport,
  comparePairwiseJudgments,
  createCurrentBuildCapabilities,
  createEvaluationFacts,
  createHumanCalibrationReviewPacket,
  createRequiredMetamorphicVariants,
  createUnavailableRealModelReport,
  evaluateCapabilityFacts,
  evaluateAnswerQualityRun,
  evaluateLongFormCompletion,
  evaluateReplay,
  findCrossSectionExactRepetitions,
  injectEvaluationCanaries,
  normalizeProductionTrace,
  normalizedQualifiedEvidenceIdentities,
  productionScenarioFromCase,
  decideLongFormGate,
  runRealModelBlindAB,
  runFixedProviderCase,
  summarizeHumanCalibrationPreparation,
  summarizeBaseline,
  type AnswerQualityCapabilityId,
  type AnswerQualityRun,
  type PairwiseJudgment,
  type LongFormGateCandidateId,
  type LongFormGateDimension,
  type LongFormGateRunResult,
} from "@collector/answer-quality-evals";
import type { AnswerPlan, ConversationContext, EvidenceBundle } from "@collector/capture-contracts";

test("versioned corpus covers the required cross-task matrix", () => {
  assert.match(ANSWER_QUALITY_CORPUS_VERSION, /^aq-corpus-v\d+$/);
  assert.ok(ANSWER_QUALITY_CORPUS.length >= 60);
  assert.equal(new Set(ANSWER_QUALITY_CORPUS.map((entry) => entry.id)).size, ANSWER_QUALITY_CORPUS.length);
  assert.ok(ANSWER_QUALITY_CORPUS.some((entry) => entry.id === "AQ-REG-CAREER-001"));
  assert.ok(new Set(ANSWER_QUALITY_CORPUS.map((entry) => entry.coverage.taskFamily)).size >= 10);
  for (const tag of [
    "multi_turn_reference",
    "correction_and_negation",
    "thinking_body_budget",
    "long_form_coherence",
    "source_order",
    "no_qualified_evidence",
    "completion_contract",
  ]) assert.ok(ANSWER_QUALITY_CORPUS.some((entry) => entry.coverage.robustness.includes(tag as never)), tag);
});

test("five fact owners preserve unsupported, unavailable, failed and missing as different outcomes", () => {
  const required = Object.fromEntries(ANSWER_QUALITY_CAPABILITIES.map((id) => [id, "required"])) as Record<AnswerQualityCapabilityId, "required">;
  const facts = createEvaluationFacts({
    caseExpectation: { capabilities: required },
    buildCapabilities: createCurrentBuildCapabilities(),
    runAvailability: [
      { capabilityId: "context_assembly", state: "available", capturedAt: "2026-01-01T00:00:00.000Z" },
      { capabilityId: "final_writing", state: "available", capturedAt: "2026-01-01T00:00:00.000Z" },
      { capabilityId: "citation_attribution", state: "unavailable", reason: "no-qualified-evidence", capturedAt: "2026-01-01T00:00:00.000Z" },
    ],
    runExecution: [
      { capabilityId: "context_assembly", state: "failed", errorCategory: "validation" },
      { capabilityId: "citation_attribution", state: "not_executed" },
    ],
    releaseRequirement: { id: "future-release", capabilities: { final_writing: { mustImplement: true, mustBeAvailable: true, mustSucceed: true } } },
  });
  const byId = new Map(evaluateCapabilityFacts(facts).map((finding) => [finding.capabilityId, finding.outcome]));
  assert.equal(byId.get("answer_plan"), "missing_execution");
  assert.equal(byId.get("citation_attribution"), "unavailable");
  assert.equal(byId.get("context_assembly"), "execution_failed");
  assert.equal(byId.get("final_writing"), "missing_execution");
});

test("release requirements can fail a candidate while a historical baseline continues other dimensions", () => {
  const required = Object.fromEntries(ANSWER_QUALITY_CAPABILITIES.map((id) => [id, "required"])) as Record<AnswerQualityCapabilityId, "required">;
  const facts = createEvaluationFacts({
    caseExpectation: { capabilities: required },
    buildCapabilities: createCurrentBuildCapabilities(),
    runAvailability: [{ capabilityId: "final_writing", state: "unavailable", reason: "profile-disabled", capturedAt: "2026-01-01T00:00:00.000Z" }],
    runExecution: [],
    releaseRequirement: {
      id: "release-target",
      capabilities: {
        answer_plan: { mustImplement: true },
        evidence_preparation: { mustImplement: true },
        final_writing: { mustBeAvailable: true, mustSucceed: true },
      },
    },
  });
  const findings = evaluateCapabilityFacts(facts);
  assert.equal(findings.find((entry) => entry.capabilityId === "answer_plan")?.releaseBlocking, false);
  assert.equal(findings.find((entry) => entry.capabilityId === "evidence_preparation")?.releaseBlocking, false);
  assert.equal(findings.find((entry) => entry.capabilityId === "final_writing")?.releaseBlocking, true);
  assert.ok(findings.some((entry) => entry.capabilityId === "context_assembly" && entry.outcome === "missing_execution"));
});

test("a post-start provider failure remains available plus execution failed", async () => {
  const target = ANSWER_QUALITY_CORPUS[0]!;
  const run = await runFixedProviderCase(target, { response: new Error("provider 503"), buildFingerprint: "build:test" });
  const availability = run.facts.runAvailability.find((entry) => entry.capabilityId === "final_writing");
  const execution = run.facts.runExecution.find((entry) => entry.capabilityId === "final_writing");
  assert.equal(availability?.state, "available");
  assert.equal(execution?.state, "failed");
});

test("fixed-provider mode binds the complete sample identity and uses production interfaces", async () => {
  const target = ANSWER_QUALITY_CORPUS.find((entry) => entry.id === "AQ-REG-CAREER-001")!;
  const run = await runFixedProviderCase(target, { response: "先澄清目标，再比较两条职业路径。", buildFingerprint: "build:test" });
  assert.equal(run.mode, "fixed_provider");
  assert.equal(run.identity.caseVersion, target.caseVersion);
  assert.equal(run.identity.caseId, target.id);
  assert.ok(run.identity.taskId && run.identity.inputMessageId && run.identity.outputMessageId);
  assert.ok(run.identity.bodyVersionId && run.identity.generationAttempt === 1);
  assert.equal(run.identity.model, target.environment.model);
  assert.equal(run.identity.thinking, target.environment.thinking);
  assert.equal(run.identity.buildFingerprint, "build:test");
  assert.equal(run.trace.providerRequests.length, 1);
  assert.ok(run.trace.conversationContext);
  assert.ok(run.trace.contextAssembly);
  assert.ok(run.trace.evidencePreparationRequest);
  const answerPlan = run.trace.answerPlan as AnswerPlan;
  assert.equal(run.facts.runExecution.find((entry) => entry.capabilityId === "answer_plan")?.artifactId, answerPlan.planId);
  assert.equal(run.facts.runExecution.find((entry) => entry.capabilityId === "evidence_preparation")?.state, "completed");
  const evidenceBundle = (run.trace.evidencePreparationRequest as { bundle: EvidenceBundle }).bundle;
  assert.equal(Object.hasOwn(evidenceBundle, "grounded"), false);
  assert.ok(answerPlan.taskFamily === "planning" || answerPlan.taskFamily === "mixed");
  assert.match(JSON.stringify(run.trace.providerRequests[0]), /answer_plan/);
});

test("AQ-01 web slice executes Evidence Preparation and keeps no-qualified evidence explicit", async () => {
  const target = ANSWER_QUALITY_CORPUS.find((entry) => entry.coverage.taskFamily === "factual_query" && entry.coverage.robustness.includes("no_qualified_evidence"))!;
  const run = await runFixedProviderCase(target, { response: "无法根据现有结果核实。", buildFingerprint: "build:test", clock: () => "2026-09-01T00:00:00.000Z" });
  const bundle = (run.trace.evidencePreparationRequest as { bundle: EvidenceBundle }).bundle;
  assert.equal(bundle.evidencePolicyStatus, "not_satisfied");
  assert.equal(bundle.stopReason, "no_more_candidates");
  assert.deepEqual(run.admittedEvidence, []);
  assert.equal(run.facts.runExecution.find((entry) => entry.capabilityId === "evidence_preparation")?.artifactId, bundle.bundleId);
});

test("AQ-01 multi-turn and correction slices execute the production Conversation Context capability", async () => {
  const slices = ANSWER_QUALITY_CORPUS.filter((entry) => entry.coverage.robustness.some((tag) => ["multi_turn_reference", "correction_and_negation"].includes(tag)));
  assert.ok(slices.length >= 20);
  for (const target of slices) {
    const run = await runFixedProviderCase(target, { response: "固定正文", buildFingerprint: "build:test" });
    const context = run.trace.conversationContext as ConversationContext;
    assert.equal(run.facts.runExecution.find((entry) => entry.capabilityId === "conversation_context")?.state, "completed");
    assert.ok(context.items.some((item) => item.semanticCategory === "current_request" && item.selection === "selected"));
    assert.ok(context.items.some((item) => item.source.originalRole === "user" && item.semanticCategory !== "current_request" && item.selection === "selected"));
    if (target.coverage.robustness.includes("multi_turn_reference")) {
      assert.ok(context.relations.some((relation) => relation.kind === "pronoun_reference"));
    }
    if (target.coverage.robustness.includes("correction_and_negation")) {
      assert.equal(context.relations.find((relation) => relation.kind === "instruction_retraction")?.status, "resolved");
      assert.equal(context.relations.find((relation) => relation.kind === "assistant_conclusion_rejected")?.status, "resolved");
    }
  }
});

test("canaries and evaluation-only mutations cannot alter normalized production traces", async () => {
  const original = ANSWER_QUALITY_CORPUS.find((entry) => entry.coverage.robustness.includes("source_order"))!;
  const { mutated, sentinels } = injectEvaluationCanaries(original);
  const originalScenario = productionScenarioFromCase(original);
  const mutatedScenario = productionScenarioFromCase(mutated);
  assert.deepEqual(mutatedScenario, originalScenario);
  const [left, right] = await Promise.all([
    runFixedProviderCase(original, { response: "固定正文", buildFingerprint: "build:test", clock: () => "2026-01-01T00:00:00.000Z" }),
    runFixedProviderCase(mutated, { response: "固定正文", buildFingerprint: "build:test", clock: () => "2026-01-01T00:00:00.000Z" }),
  ]);
  const serialized = JSON.stringify([left.trace, right.trace]);
  for (const sentinel of sentinels) assert.ok(!serialized.includes(sentinel), sentinel);
  assert.deepEqual(normalizeProductionTrace(left.trace), normalizeProductionTrace(right.trace));
});

test("required domain, format, irrelevant-context, source-order and unavailable-capability metamorphisms stay explicit", async () => {
  const original = ANSWER_QUALITY_CORPUS.find((entry) => entry.coverage.robustness.includes("source_order"))!;
  const variants = new Map(createRequiredMetamorphicVariants(original).map((entry) => [entry.relation, entry.testCase]));
  assert.deepEqual([...variants.keys()].sort(), ["capability_unavailable", "domain_replacement", "explicit_format_change", "irrelevant_context_injection", "source_order_change"].sort());

  const sourceOrder = variants.get("source_order_change")!;
  assert.deepEqual(normalizedQualifiedEvidenceIdentities(sourceOrder.environment.fixedSearchResults), normalizedQualifiedEvidenceIdentities(original.environment.fixedSearchResults));
  const stableId = () => "00000000-0000-0000-0000-000000000001";
  const [left, reordered] = await Promise.all([
    runFixedProviderCase(original, { response: "固定正文", buildFingerprint: "build:test", id: stableId }),
    runFixedProviderCase(sourceOrder, { response: "固定正文", buildFingerprint: "build:test", id: stableId }),
  ]);
  assert.deepEqual(normalizeProductionTrace(left.trace), normalizeProductionTrace(reordered.trace));

  const domain = variants.get("domain_replacement")!;
  assert.equal(domain.coverage.taskFamily, original.coverage.taskFamily);
  assert.notEqual(domain.user.request, original.user.request);

  const irrelevant = await runFixedProviderCase(variants.get("irrelevant_context_injection")!, { response: "固定正文", buildFingerprint: "build:test", id: stableId });
  assert.equal(irrelevant.trace.finalBody, left.trace.finalBody);
  assert.ok(JSON.stringify(irrelevant.trace.providerRequests).includes(original.user.request));

  const formatCase = variants.get("explicit_format_change")!;
  const formatResponse = formatCase.expectation.hardConstraints.format === "table"
    ? "| 方案 | 说明 |\n| --- | --- |\n| A | 覆盖要求 |"
    : "- 第一项覆盖要求\n- 第二项说明限制";
  const formatRun = await runFixedProviderCase(formatCase, { response: formatResponse, buildFingerprint: "build:test", id: stableId });
  const formatEvaluation = evaluateAnswerQualityRun(formatCase, formatRun);
  assert.ok(formatEvaluation.findings.some((finding) => finding.code === "format_satisfied"));

  const unavailable = await runFixedProviderCase(variants.get("capability_unavailable")!, { response: "不会被调用", buildFingerprint: "build:test", unavailableReason: "model-profile-disabled", id: stableId });
  assert.equal(unavailable.trace.providerRequests.length, 0);
  assert.equal(evaluateCapabilityFacts(unavailable.facts).find((finding) => finding.capabilityId === "final_writing")?.outcome, "unavailable");
});

test("judge input is a whitelist and cannot see hidden reasoning, provider brand, plan or case expectation", () => {
  const run = {
    finalBody: "可评分正文",
    userRequest: "请比较两个方案",
    explicitSettings: { format: "table" },
    admittedEvidence: [{ id: "e-1", text: "公开证据" }],
    validCitations: [{ sourceId: "e-1", startOffset: 0, endOffset: 4 }],
    hiddenReasoning: "CANARY_REASONING",
    providerBrand: "CANARY_PROVIDER",
    answerPlan: "CANARY_PLAN",
    caseExpectation: "CANARY_EXPECTATION",
  } as unknown as Parameters<typeof buildJudgeInput>[0];
  const serialized = JSON.stringify(buildJudgeInput(run));
  assert.ok(serialized.includes("可评分正文"));
  for (const sentinel of ["CANARY_REASONING", "CANARY_PROVIDER", "CANARY_PLAN", "CANARY_EXPECTATION"]) assert.ok(!serialized.includes(sentinel));
});

test("missing identity on a supported applicable artifact rejects semantic scoring", () => {
  const target = ANSWER_QUALITY_CORPUS[0]!;
  const replay = BASELINE_REPLAYS[0]!;
  const run = evaluateReplay(target, { ...replay, artifactBindings: replay.artifactBindings.filter((entry) => entry.capabilityId !== "final_writing") });
  assert.equal(run.scoringStatus, "rejected_missing_identity");
  assert.ok(run.findings.some((finding) => finding.code === "identity_missing"));
});

test("offline baseline exposes multiple stable defect classes without averaging them away", () => {
  const report = summarizeBaseline(ANSWER_QUALITY_CORPUS, BASELINE_REPLAYS);
  assert.ok(report.defectClasses.length >= 3);
  assert.ok(report.defectClasses.includes("multi_turn_or_completion_coverage"));
  assert.ok(report.defectClasses.includes("thinking_body_incomplete"));
  assert.ok(report.defectClasses.includes("long_form_repetition"));
  assert.ok(report.hardFailureCount > 0);
});

test("human calibration packet is blind, complete and limited to Judge-visible inputs", () => {
  const preparation = summarizeHumanCalibrationPreparation(HUMAN_CALIBRATION_CANDIDATES);
  assert.equal(preparation.sampleCount, 20);
  assert.ok(preparation.taskFamilyCount >= 6);
  assert.deepEqual(new Set(HUMAN_CALIBRATION_CANDIDATES.map((entry) => entry.layer)), new Set(["generic_semantic", "task_family"]));
  assert.equal(preparation.status, "pending_human_review");
  const packet = createHumanCalibrationReviewPacket(HUMAN_CALIBRATION_CANDIDATES);
  assert.equal(packet.items.length, 20);
  const serialized = JSON.stringify(packet);
  for (const forbidden of ["evaluatorVerdict", "referenceVerdict", "caseExpectation", "mustCover", "mustAvoid", "referenceAnswer", "rubric"]) {
    assert.ok(!serialized.includes(forbidden), forbidden);
  }
  for (const item of packet.items) {
    assert.deepEqual(Object.keys(item.judgeInput).sort(), ["admittedEvidence", "explicitSettings", "finalBody", "userRequest", "validCitations"]);
    assert.equal(item.humanVerdict, "");
    assert.equal(item.rationale, "");
  }
});

test("human calibration requires every independent label before reporting metrics", () => {
  const packet = createHumanCalibrationReviewPacket(HUMAN_CALIBRATION_CANDIDATES);
  assert.throws(
    () => calculateHumanCalibrationReport(HUMAN_CALIBRATION_CANDIDATES, packet),
    /reviewer 尚未填写|humanVerdict 尚未填写/,
  );
  const candidatesById = new Map(HUMAN_CALIBRATION_CANDIDATES.map((entry) => [entry.sampleId, entry]));
  const completed = {
    ...packet,
    reviewer: "independent-reviewer",
    reviewedAt: "2026-08-31T12:00:00.000Z",
    items: packet.items.map((item, index) => ({
      ...item,
      humanVerdict: index === 0
        ? (candidatesById.get(item.sampleId)!.evaluatorVerdict === "pass" ? "fail" as const : "pass" as const)
        : candidatesById.get(item.sampleId)!.evaluatorVerdict,
      rationale: "根据公开请求、正文和证据独立判断。",
    })),
  };
  const report = calculateHumanCalibrationReport(HUMAN_CALIBRATION_CANDIDATES, completed);
  assert.equal(report.status, "human_reviewed");
  assert.equal(report.sampleCount, 20);
  assert.ok(report.taskFamilyCount >= 6);
  assert.equal(report.agreementRate, 0.95);
  assert.equal(report.falsePositiveCount + report.falseNegativeCount, 1);
  assert.ok(Object.keys(report.dimensionBias).length > 0);
});

test("human calibration rejects edits to the blind sample", () => {
  const packet = createHumanCalibrationReviewPacket(HUMAN_CALIBRATION_CANDIDATES);
  packet.items[0]!.judgeInput.finalBody = "被改动的正文";
  assert.throws(
    () => calculateHumanCalibrationReport(HUMAN_CALIBRATION_CANDIDATES, packet),
    /Judge 输入被改动/,
  );
});

test("tracked human calibration evidence reproduces the committed report", () => {
  const review = JSON.parse(readFileSync("evals/answer-quality/reviews/aq-corpus-v1-human-review.json", "utf8")) as unknown;
  const report = JSON.parse(readFileSync("evals/answer-quality/reviews/aq-corpus-v1-human-calibration-report.json", "utf8")) as unknown;
  assert.deepEqual(calculateHumanCalibrationReport(HUMAN_CALIBRATION_CANDIDATES, review), report);
});

test("pairwise diagnostics explain repeat consistency and order flips", () => {
  const judgments: PairwiseJudgment[] = [
    { repetition: 1, order: "ab", winner: "a", reason: "A 更完整", confidence: 0.8 },
    { repetition: 1, order: "ba", winner: "b", reason: "同一原始 A 更完整", confidence: 0.8 },
    { repetition: 2, order: "ab", winner: "a", reason: "A 更完整", confidence: 0.75 },
    { repetition: 2, order: "ba", winner: "b", reason: "同一原始 A 更完整", confidence: 0.75 },
  ];
  const report = comparePairwiseJudgments(judgments);
  assert.equal(report.canonicalWinner, "a");
  assert.equal(report.orderFlipRate, 0);
  assert.equal(report.repeatAgreementRate, 1);
});

test("long-form deterministic checks detect cross-section repetition and incomplete headings", () => {
  const repeated = "这一段足够长，用来证明两个不同章节重复了同一段完整内容，而且不是标题或短语巧合。";
  assert.deepEqual(findCrossSectionExactRepetitions([
    `## 第一节\n\n${repeated}`,
    `## 第二节\n\n${repeated}`,
  ]), [repeated]);
  assert.equal(evaluateLongFormCompletion({
    sections: ["## 第一节\n\n正文", "## 错误标题\n\n正文"],
    expectedHeadings: ["第一节", "第二节"],
    finishReasons: ["stop", "stop"],
  }).verdict, "fail");
});

test("long-form gate activates only when the frozen quality and resource thresholds all pass", () => {
  const dimensions = [
    "cross_section_repetition",
    "cross_section_contradiction",
    "required_operation_coverage",
    "terminology_consistency",
    "completion_integrity",
  ] as const satisfies readonly LongFormGateDimension[];
  const run = (candidateId: LongFormGateCandidateId, repetition: number, failed: readonly LongFormGateDimension[], metrics = {
    outputTokens: 1_000,
    estimatedCostUsd: 0.01,
    firstCharacterLatencyMs: 1_000,
    completeLatencyMs: 5_000,
  }): LongFormGateRunResult => ({
    candidateId,
    repetition,
    evidenceVerified: true,
    dimensions: Object.fromEntries(dimensions.map((dimension) => [dimension, {
      verdict: failed.includes(dimension) ? "fail" : "pass",
      reason: failed.includes(dimension) ? "failed" : "passed",
    }])) as LongFormGateRunResult["dimensions"],
    metrics,
  });
  const runs: LongFormGateRunResult[] = [
    run("current_final_writing", 1, ["cross_section_repetition"]),
    run("current_final_writing", 2, ["cross_section_repetition"]),
    run("current_final_writing", 3, ["required_operation_coverage"]),
    run("minimal_prompt_adjustment", 1, ["cross_section_repetition"]),
    run("minimal_prompt_adjustment", 2, ["cross_section_contradiction"]),
    run("minimal_prompt_adjustment", 3, ["required_operation_coverage"]),
    run("long_form_state_prototype", 1, [], { outputTokens: 1_100, estimatedCostUsd: 0.011, firstCharacterLatencyMs: 1_100, completeLatencyMs: 5_500 }),
    run("long_form_state_prototype", 2, [], { outputTokens: 1_100, estimatedCostUsd: 0.011, firstCharacterLatencyMs: 1_100, completeLatencyMs: 5_500 }),
    run("long_form_state_prototype", 3, [], { outputTokens: 1_100, estimatedCostUsd: 0.011, firstCharacterLatencyMs: 1_100, completeLatencyMs: 5_500 }),
  ];
  const decision = decideLongFormGate({
    runs,
    pairwise: [1, 2, 3].map((repetition) => ({ repetition, canonicalWinner: repetition < 3 ? "long_form_state_prototype" as const : "tie" as const })),
    repetitions: 3,
    thresholds: {
      stableDefectMinimumRuns: 2,
      releaseLineMinimumFullyPassingRuns: 2,
      minimumLongFormStateDimensionPassRateGain: 0.2,
      minimumLongFormStatePairwiseWinsAgainstMinimal: 2,
      maximumOutputTokenIncreaseRatio: 0.2,
      maximumEstimatedCostIncreaseRatio: 0.2,
      maximumFirstCharacterLatencyIncreaseRatio: 0.25,
      maximumCompleteLatencyIncreaseRatio: 0.25,
      noDimensionRegression: true,
    },
  });
  assert.equal(decision.verdict, "activated");
  assert.deepEqual(decision.stableCurrentDefects, ["cross_section_repetition"]);
  assert.equal(decision.fullyPassingRuns.long_form_state_prototype, 3);

  const tooSlow = decideLongFormGate({
    runs: runs.map((entry) => entry.candidateId === "long_form_state_prototype"
      ? { ...entry, metrics: { ...entry.metrics, completeLatencyMs: 7_000 } }
      : entry),
    pairwise: [1, 2, 3].map((repetition) => ({ repetition, canonicalWinner: "long_form_state_prototype" as const })),
    repetitions: 3,
    thresholds: {
      ...decisionThresholdsForTest(),
    },
  });
  assert.equal(tooSlow.verdict, "not_activated");
  assert.equal(tooSlow.checks.resourcesWithinLimits, false);
});

function decisionThresholdsForTest() {
  return {
    stableDefectMinimumRuns: 2,
    releaseLineMinimumFullyPassingRuns: 2,
    minimumLongFormStateDimensionPassRateGain: 0.2,
    minimumLongFormStatePairwiseWinsAgainstMinimal: 2,
    maximumOutputTokenIncreaseRatio: 0.2,
    maximumEstimatedCostIncreaseRatio: 0.2,
    maximumFirstCharacterLatencyIncreaseRatio: 0.25,
    maximumCompleteLatencyIncreaseRatio: 0.25,
    noDimensionRegression: true,
  };
}

test("real blind A/B mode keeps provider identity away from pairwise Judge input", async () => {
  const target = ANSWER_QUALITY_CORPUS[0]!;
  const captured: string[] = [];
  const runner = (label: string, response: string) => ({
    run: async () => {
      const run = await runFixedProviderCase(target, { response, buildFingerprint: "build:test" });
      return { ...run, mode: "real_model_blind_ab" as const, identity: { ...run.identity, model: label } };
    },
  });
  const result = await runRealModelBlindAB({
    testCase: target,
    runnerA: runner("CANARY_PROVIDER_A", "答案 A"),
    runnerB: runner("CANARY_PROVIDER_B", "答案 B"),
    judge: {
      compare: async (input, context) => {
        captured.push(JSON.stringify(input));
        return { winner: context.order === "ab" ? "a" : "b", reason: "同一原始 A 更完整", confidence: 0.8 };
      },
    },
    repetitions: 2,
  });
  assert.equal(result.status, "verified");
  assert.equal(result.diagnostic.orderFlipRate, 0);
  assert.equal(result.diagnostic.repeatAgreementRate, 1);
  for (const serialized of captured) {
    assert.ok(!serialized.includes("CANARY_PROVIDER_A"));
    assert.ok(!serialized.includes("CANARY_PROVIDER_B"));
  }
});

test("without external credentials offline/fixed modes run and real blind A/B is explicitly unverified", async () => {
  const target = ANSWER_QUALITY_CORPUS[0]!;
  const fixed = await runFixedProviderCase(target, { response: "离线固定正文", buildFingerprint: "build:test" });
  assert.equal(fixed.mode, "fixed_provider");
  const real = createUnavailableRealModelReport("judge-adapter-or-api-key-unavailable");
  assert.equal(real.status, "unverified");
  assert.match(real.reason, /unavailable/);
});

test("evaluation runs do not retain credentials, raw profiles or hidden prompts", async () => {
  const run: AnswerQualityRun = await runFixedProviderCase(ANSWER_QUALITY_CORPUS[0]!, { response: "安全正文", buildFingerprint: "build:test" });
  const serialized = JSON.stringify(run);
  for (const forbidden of ["apiKey", "authorization", "rawProfile", "hiddenPrompt"]) assert.ok(!serialized.includes(forbidden));
});
