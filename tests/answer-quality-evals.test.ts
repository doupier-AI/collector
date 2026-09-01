import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ANSWER_QUALITY_CAPABILITIES,
  ANSWER_QUALITY_CORPUS,
  ANSWER_QUALITY_CORPUS_VERSION,
  ANSWER_QUALITY_QUICK_CASE_IDS,
  ANSWER_QUALITY_REAL_MODEL_CASE_IDS,
  ANSWER_QUALITY_RELEASE_PROFILE_V1,
  BASELINE_REPLAYS,
  HUMAN_CALIBRATION_CANDIDATES,
  OpenAiCompatibleJudgeAdapter,
  OpenAiCompatiblePairwiseJudgeAdapter,
  buildJudgeInput,
  createLayeredJudgePrompt,
  calculateHumanCalibrationReport,
  comparePairwiseJudgments,
  createCurrentBuildCapabilities,
  createEvaluationFacts,
  createPassingReleaseReplayEvidence,
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
  passingBody,
  parseJudgeJsonContent,
  parseJudgeResult,
  releaseEvidenceFromEvaluatedRun,
  ReleaseQualityModule,
  decideLongFormGate,
  runRealModelBlindAB,
  runRepeatedRealModelBlindAB,
  runFixedProviderCase,
  summarizeHumanCalibrationPreparation,
  summarizeBaseline,
  type AnswerQualityCapabilityId,
  type AnswerQualityRun,
  type PairwiseJudgment,
  type LongFormGateCandidateId,
  type LongFormGateDimension,
  type LongFormGateRunResult,
  type AnswerQualityReleaseProfile,
  type CalibrationReport,
  type ReleaseRunEvidence,
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
  const prompt = JSON.parse(createLayeredJudgePrompt(buildJudgeInput(run)));
  assert.deepEqual(Object.keys(prompt.layers).sort(), ["generic_semantic", "task_family"]);
  assert.equal(prompt.responseRequirements.rootKey, "dimensions");
  assert.deepEqual(prompt.responseRequirements.requiredLayers, ["generic_semantic", "task_family"]);
  assert.deepEqual(prompt.responseRequirements.dimensionSchema.layer.enum, ["generic_semantic", "task_family"]);
  assert.match(prompt.instruction, /响应根对象只能有 dimensions 键/);
});

test("absolute Judge normalizes only the exact observed two-layer array wrapper", () => {
  const result = parseJudgeResult({
    layers: {
      generic_semantic: [{ dimension: "相关性", verdict: "pass", reason: "符合", evidenceLocations: [], confidence: 0.8 }],
      task_family: [{ dimension: "比较", verdict: "pass", reason: "符合", evidenceLocations: [], confidence: 0.8 }],
    },
  }, 4);
  assert.deepEqual(result.dimensions.map((entry) => entry.layer), ["generic_semantic", "task_family"]);
  assert.throws(() => parseJudgeResult({ layers: { generic_semantic: [], unexpected: [] } }, 4), /has no dimensions/);
  assert.throws(() => parseJudgeResult({ layers: { generic_semantic: {}, task_family: [] } }, 4), /has no dimensions/);
});

test("Judge JSON decoding accepts only unambiguous provider serialization noise", () => {
  const payload = { dimensions: [{ layer: "generic_semantic", dimension: "相关性", verdict: "pass" }] };
  const json = JSON.stringify(payload);
  assert.deepEqual(parseJudgeJsonContent(json), payload);
  assert.deepEqual(parseJudgeJsonContent(`\`\`\`json\n${json}\n\`\`\``), payload);
  assert.deepEqual(parseJudgeJsonContent(`${json}\n${json}`), payload);
  assert.throws(() => parseJudgeJsonContent(`${json}\n${JSON.stringify({ dimensions: [] })}`), /different concatenated/);
  assert.throws(() => parseJudgeJsonContent(`${json}\n说明`), SyntaxError);
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

  const unavailableResourceEvidence = decideLongFormGate({
    runs: runs.map((entry) => entry.candidateId === "long_form_state_prototype" && entry.repetition === 1
      ? { ...entry, evidenceVerified: false }
      : entry),
    pairwise: [1, 2, 3].map((repetition) => ({ repetition, canonicalWinner: "long_form_state_prototype" as const })),
    repetitions: 3,
    thresholds: decisionThresholdsForTest(),
  });
  assert.equal(unavailableResourceEvidence.checks.resourcesWithinLimits, false);
  assert.equal(unavailableResourceEvidence.resourceIncreaseRatios.outputTokens, null);
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

test("repeated real blind A/B performs fresh production runs for every repetition", async () => {
  const target = ANSWER_QUALITY_CORPUS[0]!;
  let callsA = 0;
  let callsB = 0;
  const result = await runRepeatedRealModelBlindAB({
    testCase: target,
    repetitions: 3,
    runnerA: { run: async () => ({ ...(await runFixedProviderCase(target, { response: `A-${++callsA}`, buildFingerprint: "build:a" })), mode: "real_model_blind_ab" as const }) },
    runnerB: { run: async () => ({ ...(await runFixedProviderCase(target, { response: `B-${++callsB}`, buildFingerprint: "build:b" })), mode: "real_model_blind_ab" as const }) },
    judge: { compare: async (_input, context) => ({ winner: context.order === "ab" ? "a" : "b", reason: "原始 A", confidence: 0.8 }) },
  });
  assert.equal(callsA, 3);
  assert.equal(callsB, 3);
  assert.equal(result.runs.length, 3);
  assert.equal(result.judgments.length, 6);
  assert.equal(result.diagnostic.repeatAgreementRate, 1);
});

test("pairwise Judge accepts the observed outputContract result wrapper without weakening winner enums", async () => {
  const target = ANSWER_QUALITY_CORPUS[0]!;
  const run = await runFixedProviderCase(target, { response: "固定正文", buildFingerprint: "build:test" });
  const input = buildJudgeInput({
    userRequest: run.userRequest,
    explicitSettings: run.explicitSettings,
    finalBody: run.trace.finalBody,
    admittedEvidence: run.admittedEvidence,
    validCitations: run.validCitations,
  });
  const adapter = new OpenAiCompatiblePairwiseJudgeAdapter({
    baseUrl: "https://judge.test/v1",
    model: "judge-test",
    apiKey: () => "test-key",
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ outputContract: { winner: "B", reason: "第二项更完整", confidence: 0.9 } }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  });
  const result = await adapter.compare({ userRequest: run.userRequest, explicitSettings: run.explicitSettings, first: input, second: input });
  assert.deepEqual(result, { winner: "b", reason: "第二项更完整", confidence: 0.9 });
});

test("real DeepSeek Judge requests disable thinking and bound structured output", async () => {
  const target = ANSWER_QUALITY_CORPUS[0]!;
  const run = await runFixedProviderCase(target, { response: "固定正文", buildFingerprint: "build:test" });
  const input = buildJudgeInput({
    userRequest: run.userRequest,
    explicitSettings: run.explicitSettings,
    finalBody: run.trace.finalBody,
    admittedEvidence: run.admittedEvidence,
    validCitations: run.validCitations,
  });
  let requestBody: Record<string, unknown> | undefined;
  const adapter = new OpenAiCompatiblePairwiseJudgeAdapter({
    baseUrl: "https://judge.test/v1",
    model: "judge-test",
    apiKey: () => "test-key",
    maxTokens: 2_048,
    thinking: false,
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ winner: "tie", reason: "等价", confidence: 0.8 }) } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  await adapter.compare({ userRequest: run.userRequest, explicitSettings: run.explicitSettings, first: input, second: input });
  assert.equal(requestBody?.max_tokens, 2_048);
  assert.deepEqual(requestBody?.thinking, { type: "disabled" });

  let absoluteRequestBody: Record<string, unknown> | undefined;
  const absoluteAdapter = new OpenAiCompatibleJudgeAdapter({
    baseUrl: "https://judge.test/v1",
    model: "judge-test",
    apiKey: () => "test-key",
    maxTokens: 2_048,
    thinking: false,
    fetchImpl: async (_url, init) => {
      absoluteRequestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ outputContract: { dimensions: [
          { layer: "generic_semantic", dimension: "相关性", verdict: "pass", reason: "符合", evidenceLocations: [], confidence: 0.8 },
          { layer: "task_family", dimension: "比较", verdict: "pass", reason: "符合", evidenceLocations: [], confidence: 0.8 },
        ] } }) } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  await absoluteAdapter.judge(input);
  assert.equal(absoluteRequestBody?.max_tokens, 2_048);
  assert.deepEqual(absoluteRequestBody?.thinking, { type: "disabled" });
});

test("production Final Writer A/B keeps a versioned baseline and translates explicit format codes only in the candidate", async () => {
  const target = ANSWER_QUALITY_CORPUS.find((entry) => entry.id === ANSWER_QUALITY_REAL_MODEL_CASE_IDS[0])!;
  const baseline = await runFixedProviderCase(target, { response: passingBody(target), buildFingerprint: "build:test", promptVersion: "answer-quality-release-baseline-v1" });
  const candidate = await runFixedProviderCase(target, { response: passingBody(target), buildFingerprint: "build:test", promptVersion: "answer-quality-release-candidate-v1" });
  const baselineRequest = baseline.trace.providerRequests[0] as { prompt?: string } | undefined;
  const candidateRequest = candidate.trace.providerRequests[0] as { prompt?: string } | undefined;
  assert.doesNotMatch(baselineRequest?.prompt ?? "", /format=numbered_steps[^\n]*1\.、2\.、3\./);
  assert.match(candidateRequest?.prompt ?? "", /format=numbered_steps[^\n]*1\.、2\.、3\./);
  assert.doesNotMatch(candidate.trace.finalBody, /format=numbered_steps/);
});

test("case coverage accepts the calibrated conclusion-summary equivalence without broad fuzzy matching", async () => {
  const target = ANSWER_QUALITY_CORPUS.find((entry) => entry.id === ANSWER_QUALITY_REAL_MODEL_CASE_IDS[0])!;
  const response = "1. 全文检索适合精确词项。\n\n2. 向量检索适合语义召回。\n\n3. 总结：两者边界不同，应按查询意图组合。";
  const run = await runFixedProviderCase(target, { response, buildFingerprint: "build:test" });
  const evaluation = evaluateAnswerQualityRun(target, run);
  assert.ok(evaluation.findings.some((finding) => finding.code === "case_coverage_present" && /等价表述“总结”覆盖“结论”/.test(finding.reason)));
  assert.ok(!evaluation.findings.some((finding) => finding.code === "case_coverage_missing"));
});

test("numbered-step hard constraint accepts Markdown numbered headings but not unnumbered sections", async () => {
  const target = ANSWER_QUALITY_CORPUS.find((entry) => entry.id === ANSWER_QUALITY_REAL_MODEL_CASE_IDS[0])!;
  const numbered = await runFixedProviderCase(target, {
    response: "## 1. 全文检索边界\n\n## 2. 向量检索边界\n\n## 3. 结论\n\n两者按查询意图组合。",
    buildFingerprint: "build:test",
  });
  const unnumbered = await runFixedProviderCase(target, {
    response: "## 全文检索边界\n\n## 向量检索边界\n\n## 结论\n\n两者按查询意图组合。",
    buildFingerprint: "build:test",
  });
  assert.ok(evaluateAnswerQualityRun(target, numbered).findings.some((finding) => finding.code === "format_satisfied"));
  assert.ok(evaluateAnswerQualityRun(target, unnumbered).findings.some((finding) => finding.code === "format_missing"));
});

test("Release Profile result matrix is exhaustive, mutually exclusive and priority ordered", () => {
  const target = ANSWER_QUALITY_CORPUS.find((entry) => entry.id === ANSWER_QUALITY_QUICK_CASE_IDS[0])!;
  const buildFingerprint = "release-candidate:test";
  const base = createPassingReleaseReplayEvidence(target, buildFingerprint);
  const profile = singleCaseOfflineProfile(target.id);
  const evaluate = (evidence: ReleaseRunEvidence, selectedProfile = profile) => new ReleaseQualityModule(selectedProfile).evaluate({
    gateId: "quick",
    candidateBuildFingerprint: buildFingerprint,
    candidateRuns: [evidence],
  }).cases[0]!.primaryOutcome;

  assert.equal(evaluate(base, {
    ...profile,
    gates: { ...profile.gates, quick: { ...profile.gates.quick, caseIds: [ANSWER_QUALITY_CORPUS.find((entry) => entry.id !== target.id)!.id] } },
  }), "not_applicable");

  const buildMissing = cloneReleaseEvidence(base, {
    buildCapabilities: base.run.facts.buildCapabilities.map((entry) => entry.capabilityId === "final_writing" ? { ...entry, supported: false } : entry),
  });
  assert.equal(evaluate(buildMissing), "build_capability_missing");

  const unavailable = cloneReleaseEvidence(base, {
    runAvailability: base.run.facts.runAvailability.map((entry) => entry.capabilityId === "final_writing" ? { ...entry, state: "unavailable" as const, reason: "profile-disabled" } : entry),
  });
  assert.equal(evaluate(unavailable), "run_unavailable");

  const identityMissing = {
    ...base,
    run: { ...base.run, artifactBindings: base.run.artifactBindings.filter((entry) => entry.capabilityId !== "final_writing") },
  };
  assert.equal(evaluate(identityMissing), "identity_missing");

  const executionFailed = {
    ...cloneReleaseEvidence(base, {
      runExecution: base.run.facts.runExecution.map((entry) => entry.capabilityId === "final_writing"
        ? { ...entry, state: "failed" as const, errorCategory: "provider-5xx", artifactId: "provider-call:5xx" }
        : entry),
    }),
    run: {
      ...cloneReleaseEvidence(base, {
        runExecution: base.run.facts.runExecution.map((entry) => entry.capabilityId === "final_writing"
          ? { ...entry, state: "failed" as const, errorCategory: "provider-5xx", artifactId: "provider-call:5xx" }
          : entry),
      }).run,
      artifactBindings: base.run.artifactBindings.map((entry) => entry.capabilityId === "final_writing"
        ? { ...entry, status: "failed" as const, artifactId: "provider-call:5xx", reason: "provider-5xx" }
        : entry),
    },
  };
  assert.equal(evaluate(executionFailed), "execution_failed", "available 后的 5xx 必须是 execution_failed");

  const failedWithoutIdentity = {
    ...executionFailed,
    run: { ...executionFailed.run, artifactBindings: executionFailed.run.artifactBindings.filter((entry) => entry.capabilityId !== "final_writing") },
  };
  assert.equal(evaluate(failedWithoutIdentity), "identity_missing", "身份缺失必须先于执行失败");

  const semanticFailure = { code: "judge_quality", layer: "generic_semantic" as const, verdict: "fail" as const, reason: "答案质量差" };
  const notVerified = { ...base, semantic: { status: "not_verified" as const, method: "offline_replay" as const, findings: [semanticFailure], reason: "real judge missing" } };
  assert.equal(evaluate(notVerified), "not_verified", "未验证必须先于语义失败");
  assert.equal(evaluate({ ...base, semantic: { status: "verified" as const, method: "offline_replay" as const, findings: [semanticFailure] } }), "semantic_quality_failed");
  assert.equal(evaluate(base), "passed");

  const duplicate = new ReleaseQualityModule(profile).evaluate({
    gateId: "quick",
    candidateBuildFingerprint: buildFingerprint,
    candidateRuns: [base, base],
  });
  assert.equal(duplicate.verdict, "not_verified");
  assert.ok(duplicate.missingEvidence.some((entry) => entry.endsWith(":duplicate")));
});

test("real semantic evidence requires both generic and task-family Judge dimensions", () => {
  const target = ANSWER_QUALITY_CORPUS.find((entry) => entry.id === ANSWER_QUALITY_REAL_MODEL_CASE_IDS[0])!;
  const run = evaluateAnswerQualityRun(target, createPassingReleaseReplayEvidence(target, "release:test").run);
  const evidence = releaseEvidenceFromEvaluatedRun(target, {
    ...run,
    findings: [
      ...run.findings.filter((entry) => entry.code !== "llm_judge_not_run"),
      { code: "judge:generic", layer: "generic_semantic", verdict: "pass", reason: "通用维度通过" },
    ],
  }, "real_model_judge");
  assert.equal(evidence.semantic.status, "not_verified");
  assert.match(evidence.semantic.reason ?? "", /task_family/);
});

test("full offline Release Profile evaluates all 70 cases and keeps non-average slices", () => {
  const buildFingerprint = "release-offline:test";
  const report = new ReleaseQualityModule(ANSWER_QUALITY_RELEASE_PROFILE_V1).evaluate({
    gateId: "full_offline",
    candidateBuildFingerprint: buildFingerprint,
    candidateRuns: ANSWER_QUALITY_CORPUS.map((testCase) => createPassingReleaseReplayEvidence(testCase, buildFingerprint)),
  });
  assert.equal(report.verdict, "passed");
  assert.equal(report.cases.length, ANSWER_QUALITY_CORPUS.length);
  assert.ok(report.cases.every((entry) => entry.primaryOutcome === "passed"));
  assert.equal(Object.keys(report.slices.taskFamilies).length, 10);
  assert.ok(report.slices.multiTurnContext.caseCount >= 20);
  assert.ok(report.slices.thinkingBodyCompletion.caseCount >= 10);
  assert.ok(report.slices.longFormCoherence.caseCount >= 10);
  assert.ok(report.slices.evidencePolicyAndAttribution.caseCount > 0);
  assert.ok(Object.keys(report.slices.robustnessCalibrationAndCost.robustness).length >= 7);
});

test("quick Release Profile executes production seams with FakeProvider including attribution", async () => {
  const buildFingerprint = "release-quick:test";
  const evidence: ReleaseRunEvidence[] = [];
  for (const caseId of ANSWER_QUALITY_QUICK_CASE_IDS) {
    const testCase = ANSWER_QUALITY_CORPUS.find((entry) => entry.id === caseId)!;
    const body = passingBody(testCase);
    const source = testCase.environment.fixedSearchResults.find((entry) => entry.qualified);
    const citationResponse = testCase.expectation.capabilities.citation_attribution === "required" && source
      ? JSON.stringify({ attributions: [{ sourceOrdinal: 1, claimText: source.snippet, evidenceText: source.snippet, support: true, confidence: 1 }] })
      : undefined;
    const run = await runFixedProviderCase(testCase, {
      response: body,
      ...(citationResponse ? { citationResponse } : {}),
      buildFingerprint,
      clock: () => "2026-09-01T00:00:00.000Z",
    });
    const evaluated = evaluateAnswerQualityRun(testCase, run);
    evidence.push(releaseEvidenceFromEvaluatedRun(testCase, evaluated, "deterministic"));
  }
  const report = new ReleaseQualityModule(ANSWER_QUALITY_RELEASE_PROFILE_V1).evaluate({
    gateId: "quick",
    candidateBuildFingerprint: buildFingerprint,
    candidateRuns: evidence,
  });
  assert.equal(report.verdict, "passed");
  assert.equal(report.cases.length, ANSWER_QUALITY_QUICK_CASE_IDS.length);
  const attribution = evidence.find((entry) => entry.testCase.expectation.capabilities.citation_attribution === "required")!;
  assert.equal(attribution.run.facts.runExecution.find((entry) => entry.capabilityId === "citation_attribution")?.state, "completed");
  assert.equal(attribution.run.facts.runExecution.find((entry) => entry.capabilityId === "prompt_envelope")?.state, "completed");
  assert.equal(attribution.run.facts.runExecution.find((entry) => entry.capabilityId === "model_budget_policy")?.state, "completed");
});

test("release candidate requires three matched blind runs, calibration, metrics and #210 verdict", () => {
  assert.deepEqual(ANSWER_QUALITY_RELEASE_PROFILE_V1.gates.release_candidate.promptProfiles, {
    baseline: "answer-quality-release-baseline-v1",
    candidate: "answer-quality-release-candidate-v1",
  });
  const candidateBuildFingerprint = "release-candidate:test";
  const baselineBuildFingerprint = "release-baseline:test";
  const candidateRuns: ReleaseRunEvidence[] = [];
  const baselineRuns: ReleaseRunEvidence[] = [];
  const pairwise = [];
  for (const caseId of ANSWER_QUALITY_REAL_MODEL_CASE_IDS) {
    const testCase = ANSWER_QUALITY_CORPUS.find((entry) => entry.id === caseId)!;
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      candidateRuns.push(realReleaseEvidence(testCase, candidateBuildFingerprint, repetition));
      baselineRuns.push(realReleaseEvidence(testCase, baselineBuildFingerprint, repetition));
      pairwise.push(
        { caseId, repetition, order: "ab" as const, winner: "b" as const, reason: "候选更完整", confidence: 0.8 },
        { caseId, repetition, order: "ba" as const, winner: "a" as const, reason: "交换顺序后候选仍更完整", confidence: 0.8 },
      );
    }
  }
  const calibration = JSON.parse(readFileSync("evals/answer-quality/reviews/aq-corpus-v1-human-calibration-report.json", "utf8")) as CalibrationReport;
  const report = new ReleaseQualityModule(ANSWER_QUALITY_RELEASE_PROFILE_V1).evaluate({
    gateId: "release_candidate",
    candidateBuildFingerprint,
    candidateRuns,
    baselineRuns,
    pairwise,
    calibration,
    longFormDecision: { decisionId: "aq-long-form-gate-v1", verdict: "not_activated" },
  });
  assert.equal(report.verdict, "passed");
  assert.equal(report.slices.robustnessCalibrationAndCost.calibration.status, "passed");
  assert.ok(Object.values(report.slices.robustnessCalibrationAndCost.pairwise).every((entry) => entry.orderFlipRate === 0 && entry.repeatAgreementRate === 1 && entry.candidateWinRate === 1));
  assert.ok(Object.values(report.slices.robustnessCalibrationAndCost.metrics).every((entry) => entry.sampleCount === candidateRuns.length && entry.variance === 0));
  assert.deepEqual(report.cases.find((entry) => entry.lane === "candidate")?.identity, candidateRuns[0]!.run.identity);

  const ties = new ReleaseQualityModule(ANSWER_QUALITY_RELEASE_PROFILE_V1).evaluate({
    gateId: "release_candidate",
    candidateBuildFingerprint,
    candidateRuns,
    baselineRuns,
    pairwise: pairwise.map((entry) => ({ ...entry, winner: "tie" as const })),
    calibration,
    longFormDecision: { decisionId: "aq-long-form-gate-v1", verdict: "not_activated" },
  });
  assert.equal(ties.verdict, "passed", "同配置真实模型运行可以持平，不得虚构候选胜出");
  assert.ok(Object.values(ties.slices.robustnessCalibrationAndCost.pairwise).every((entry) => entry.candidateNonLossRate === 1));

  const invalidMetrics = new ReleaseQualityModule(ANSWER_QUALITY_RELEASE_PROFILE_V1).evaluate({
    gateId: "release_candidate",
    candidateBuildFingerprint,
    candidateRuns: candidateRuns.map((entry, index) => index ? entry : { ...entry, metrics: { ...entry.metrics!, outputTokens: 0 } }),
    baselineRuns,
    pairwise,
    calibration,
    longFormDecision: { decisionId: "aq-long-form-gate-v1", verdict: "not_activated" },
  });
  assert.equal(invalidMetrics.verdict, "not_verified");
  assert.ok(invalidMetrics.missingEvidence.some((entry) => entry.endsWith(":metrics:invalid")));

  const missingRealEvidence = new ReleaseQualityModule(ANSWER_QUALITY_RELEASE_PROFILE_V1).evaluate({
    gateId: "release_candidate",
    candidateBuildFingerprint,
    candidateRuns: candidateRuns.slice(0, 1),
  });
  assert.equal(missingRealEvidence.verdict, "not_verified");
  assert.ok(missingRealEvidence.missingEvidence.length > 0);
});

function singleCaseOfflineProfile(caseId: string): AnswerQualityReleaseProfile {
  return {
    ...ANSWER_QUALITY_RELEASE_PROFILE_V1,
    gates: {
      ...ANSWER_QUALITY_RELEASE_PROFILE_V1.gates,
      quick: {
        ...ANSWER_QUALITY_RELEASE_PROFILE_V1.gates.quick,
        caseIds: [caseId],
        runModes: ["offline_replay"],
        verificationMethods: ["offline_replay"],
      },
    },
  };
}

function cloneReleaseEvidence(base: ReleaseRunEvidence, facts: Partial<ReleaseRunEvidence["run"]["facts"]>): ReleaseRunEvidence {
  return { ...base, run: { ...base.run, facts: { ...base.run.facts, ...facts } } };
}

function realReleaseEvidence(testCase: (typeof ANSWER_QUALITY_CORPUS)[number], buildFingerprint: string, repetition: number): ReleaseRunEvidence {
  const base = createPassingReleaseReplayEvidence(testCase, buildFingerprint);
  return {
    ...base,
    repetition,
    run: { ...base.run, mode: "real_model_blind_ab", identity: { ...base.run.identity, buildFingerprint } },
    semantic: { ...base.semantic, method: "real_model_judge", status: "verified" },
    metrics: { outputTokens: 500, estimatedCostUsd: 0.01, firstCharacterLatencyMs: 800, completeLatencyMs: 4_000 },
  };
}
