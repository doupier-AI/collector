import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANSWER_QUALITY_CORPUS,
  LONG_FORM_GATE_DIMENSIONS,
  decideLongFormGate,
  evaluateLongFormCompletion,
  findCrossSectionExactRepetitions,
  runFixedProviderCase,
} from "@collector/answer-quality-evals";
import { assembleContext } from "@collector/api";
import { researchBodyVersionId } from "@collector/capture-contracts";
import { createProvider, DEFAULT_PROVIDER_REGISTRY, ModelGateway } from "@collector/model-gateway";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const argumentValue = (name) => process.argv.slice(2).find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
const preregistrationPath = repositoryPath(argumentValue("--preregistration") ?? "evals/answer-quality/decisions/aq-long-form-gate-v1-preregistration.json");
const outputPath = repositoryPath(argumentValue("--output") ?? "evals/answer-quality/decisions/aq-long-form-gate-v1-result.json");
const databasePath = resolve(argumentValue("--database") ?? process.env.COLLECTOR_REAL_MODEL_DATABASE ?? join(repositoryRoot, ".collector-data", "collector.sqlite"));
const preregistration = JSON.parse(await readFile(preregistrationPath, "utf8"));
validatePreregistration(preregistration);

const profileRuntime = readActiveProfile(databasePath);
validateProfile(profileRuntime.profile, preregistration.releaseProfile.model);
const definition = DEFAULT_PROVIDER_REGISTRY.get(profileRuntime.profile.providerId);
if (!definition) throw new Error(`Preregistered provider is unavailable: ${profileRuntime.profile.providerId}`);

const testCase = ANSWER_QUALITY_CORPUS.find((entry) => entry.id === preregistration.case.caseId);
if (!testCase || testCase.caseVersion !== preregistration.case.caseVersion) throw new Error("Preregistered answer-quality case identity is unavailable");
const preparation = await runFixedProviderCase(testCase, {
  response: "evaluation-context-preparation",
  buildFingerprint: preregistration.candidateSha,
});
const baseCandidates = preparation.trace.contextAssembly?.request?.candidates;
if (!Array.isArray(baseCandidates)) throw new Error("Answer-quality preparation did not expose ContextAssembly candidates");

const harnessSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
const generatedRuns = [];
for (let repetition = 1; repetition <= preregistration.sampleProtocol.generationRepetitions; repetition += 1) {
  for (const candidateId of preregistration.sampleProtocol.runOrderPerRepetition) {
    process.stderr.write(`[long-form-gate] repetition=${repetition} candidate=${candidateId}\n`);
    generatedRuns.push(await runCandidate({
      candidateId,
      repetition,
      preregistration,
      testCase,
      preparation,
      baseCandidates,
      profileRuntime,
      definition,
    }));
  }
}

const pairwise = [];
for (let repetition = 1; repetition <= preregistration.sampleProtocol.generationRepetitions; repetition += 1) {
  const minimal = generatedRuns.find((run) => run.repetition === repetition && run.candidateId === "minimal_prompt_adjustment");
  const state = generatedRuns.find((run) => run.repetition === repetition && run.candidateId === "long_form_state_prototype");
  if (!minimal || !state) throw new Error(`Missing pairwise bodies for repetition ${repetition}`);
  process.stderr.write(`[long-form-gate] pairwise repetition=${repetition}\n`);
  pairwise.push(await compareCandidateBodies({ repetition, minimal, state, testCase, profileRuntime }));
}

const decision = decideLongFormGate({
  runs: generatedRuns.map((run) => ({
    candidateId: run.candidateId,
    repetition: run.repetition,
    evidenceVerified: run.evidenceVerified,
    dimensions: run.dimensions,
    metrics: run.metrics,
  })),
  pairwise: pairwise.map(({ repetition, canonicalWinner }) => ({ repetition, canonicalWinner })),
  repetitions: preregistration.sampleProtocol.generationRepetitions,
  thresholds: preregistration.decisionThresholds,
});

const result = {
  schemaVersion: 1,
  decisionId: preregistration.decisionId,
  status: "complete",
  completedAt: new Date().toISOString(),
  preregistration: {
    path: relative(repositoryRoot, preregistrationPath).replaceAll("\\", "/"),
    sha256: sha256(await readFile(preregistrationPath, "utf8")),
  },
  execution: {
    candidateSha: preregistration.candidateSha,
    evaluationHarnessSha: harnessSha,
    case: preregistration.case,
    rubricVersion: preregistration.rubric.version,
    releaseProfileVersion: preregistration.releaseProfile.version,
    provider: profileRuntime.profile.providerId,
    model: profileRuntime.profile.model,
    thinking: profileRuntime.profile.thinkingEnabled ?? false,
    promptEnvelopeVersion: preregistration.releaseProfile.promptEnvelopeVersion,
    generationRepetitions: preregistration.sampleProtocol.generationRepetitions,
    additionalRuns: 0,
  },
  upstreamIdentities: {
    answerPlanId: preparation.trace.answerPlan?.planId,
    conversationContextId: preparation.trace.conversationContext?.contextId,
    evidenceBundleId: preparation.trace.evidencePreparationRequest?.bundle?.bundleId ?? null,
    qualifiedEvidenceIds: preparation.admittedEvidence.map((entry) => entry.id),
    initialContextAssemblyAttemptId: preparation.trace.contextAssembly?.audit?.assemblyAttemptId,
  },
  runs: generatedRuns,
  pairwise,
  decision,
};
const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (serialized.includes(profileRuntime.apiKey)) throw new Error("Result serialization retained the provider credential");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, serialized, { flag: "wx" });
console.log(JSON.stringify({
  decisionId: result.decisionId,
  output: relative(repositoryRoot, outputPath).replaceAll("\\", "/"),
  verdict: decision.verdict,
  checks: decision.checks,
  stableCurrentDefects: decision.stableCurrentDefects,
  fullyPassingRuns: decision.fullyPassingRuns,
  resourceIncreaseRatios: decision.resourceIncreaseRatios,
}, null, 2));

async function runCandidate({ candidateId, repetition, preregistration: packet, testCase: target, preparation: prepared, baseCandidates: initialCandidates, profileRuntime: runtime, definition: providerDefinition }) {
  const taskId = `${packet.decisionId}:${candidateId}:${repetition}`;
  const outputMessageId = `${taskId}:output`;
  const events = [];
  const provider = createProvider(providerDefinition, {
    apiKey: () => runtime.apiKey,
    baseUrl: runtime.profile.baseUrl || providerDefinition.defaultBaseUrl,
  });
  const gateway = new ModelGateway(provider, {
    model: runtime.profile.model,
    thinking: runtime.profile.thinkingEnabled ?? false,
    promptVersion: packet.releaseProfile.promptEnvelopeVersion,
    buildFingerprint: packet.candidateSha,
    onCall(event) { events.push(event); },
  });
  const ruleCandidates = candidateId === "minimal_prompt_adjustment" ? [minimalPromptCandidate(taskId)] : [];
  const outlineAssembly = requireAssembly(assembleContext({
    purpose: "research_body_outline",
    workflowRunId: taskId,
    workflowStepId: "body-outline",
    candidates: [...structuredClone(initialCandidates), ...ruleCandidates],
  }), "outline");
  const startedAt = Date.now();
  const outline = await gateway.generateBodyOutlineFromContext(outlineAssembly, {
    maxTokens: packet.releaseProfile.outlineOutputBudgetTokens,
    context: modelContext(taskId, "body-outline", "research_body_outline", prepared.trace.answerPlan?.planId, packet),
  });
  const sections = [];
  const finishReasons = [];
  const contextAssemblyAttemptIds = [outlineAssembly.assemblyAttemptId];
  let writtenSoFar = "";
  let firstCharacterLatencyMs;
  for (let sectionIndex = 0; sectionIndex < outline.sections.length; sectionIndex += 1) {
    let sectionContent = "";
    let finishReason;
    for (let continuation = 0; continuation <= 2; continuation += 1) {
      const state = candidateState({
        candidateId,
        taskId,
        outputMessageId,
        repetition,
        outline,
        sectionIndex,
        writtenSoFar,
        completedSections: sections,
        continuationContent: sectionContent,
      });
      const sectionAssembly = requireAssembly(assembleContext({
        purpose: "research_body_section",
        workflowRunId: taskId,
        workflowStepId: `body-section:${sectionIndex}`,
        candidates: [
          ...structuredClone(initialCandidates),
          ...ruleCandidates,
          continuationCandidate(taskId, sectionIndex, state),
        ],
      }), `section ${sectionIndex + 1}`);
      contextAssemblyAttemptIds.push(sectionAssembly.assemblyAttemptId);
      const result = await gateway.expandBodySectionFromContext(sectionAssembly, {
        goal: "admitted-context",
        outline,
        sectionIndex,
        writtenSoFar: "",
        ...(continuation > 0 ? { continuation: { priorSectionContent: "admitted-continuation-state" } } : {}),
      }, {
        maxTokens: packet.releaseProfile.sectionOutputBudgetTokens,
        context: modelContext(taskId, `body-section:${sectionIndex}`, "research_body_section", prepared.trace.answerPlan?.planId, packet),
      });
      sectionContent = sectionContent ? joinContinuation(sectionContent, result.content) : result.content.trim();
      finishReason = result.finishReason;
      if (finishReason !== "length") break;
    }
    const completedSection = ensureSectionHeading(sectionContent, outline.sections[sectionIndex].heading);
    if (firstCharacterLatencyMs === undefined && completedSection) firstCharacterLatencyMs = Date.now() - startedAt;
    sections.push(completedSection);
    finishReasons.push(finishReason);
    writtenSoFar = sections.join("\n\n");
  }
  const completeLatencyMs = Date.now() - startedAt;
  const body = sections.join("\n\n");
  const exactRepetitions = findCrossSectionExactRepetitions(sections);
  const semanticJudge = await judgeLongForm({ target, body, sections, runtime });
  const completion = evaluateLongFormCompletion({
    sections,
    expectedHeadings: outline.sections.map((section) => section.heading),
    finishReasons,
  });
  const missingCoverageTerms = target.expectation.mustCover.filter((term) => !body.includes(term));
  const dimensions = combineDimensions({ semanticJudge, completion, exactRepetitions, missingCoverageTerms });
  const usageVerified = events.length > 0 && events.every((event) => event.status === "completed" && event.usage && event.estimatedCostUsd !== undefined);
  const metrics = {
    outputTokens: events.reduce((sum, event) => sum + (event.usage?.outputTokens ?? 0), 0),
    estimatedCostUsd: round(events.reduce((sum, event) => sum + (event.estimatedCostUsd ?? 0), 0), 12),
    firstCharacterLatencyMs: firstCharacterLatencyMs ?? completeLatencyMs,
    completeLatencyMs,
  };
  return {
    candidateId,
    repetition,
    evidenceVerified: usageVerified && LONG_FORM_GATE_DIMENSIONS.every((dimension) => dimensions[dimension].verdict !== "unverified"),
    identity: {
      taskId,
      outputMessageId,
      generationAttempt: repetition,
      bodyVersionId: researchBodyVersionId(outputMessageId, body),
      answerPlanId: prepared.trace.answerPlan?.planId,
      conversationContextId: prepared.trace.conversationContext?.contextId,
      evidenceBundleId: prepared.trace.evidencePreparationRequest?.bundle?.bundleId ?? null,
      qualifiedEvidenceIds: prepared.admittedEvidence.map((entry) => entry.id),
      admittedEvidenceIds: prepared.admittedEvidence.map((entry) => entry.id),
      contextAssemblyAttemptIds,
    },
    outline,
    sections,
    finishReasons,
    body,
    exactRepeatedParagraphs: exactRepetitions,
    missingCoverageTerms,
    dimensions,
    metrics,
    modelCalls: events.map(safeModelCall),
    semanticJudge,
  };
}

async function judgeLongForm({ target, body, sections, runtime }) {
  const semanticDimensions = [
    "cross_section_repetition",
    "cross_section_contradiction",
    "required_operation_coverage",
    "terminology_consistency",
  ];
  const prompt = JSON.stringify({
    instruction: "只根据公开用户请求和最终正文评估长文跨节质量。不要推测隐藏计划、供应商身份或内部推理。每个维度都必须给出 pass 或 fail；发现失败时给出最多两个正文短摘录。",
    dimensions: {
      cross_section_repetition: "不同章节是否实质重复同一论证或结论，而非必要的短语复现。",
      cross_section_contradiction: "后文是否无解释地推翻前文约束、判断或结论。",
      required_operation_coverage: "正文是否真正完成用户要求的诊断、比较、执行顺序和明确结论，而非只宣称完成。",
      terminology_consistency: "核心术语、路径名称和结论标签是否跨节保持同一含义；合理定义或显式修订不算漂移。",
    },
    outputContract: {
      dimensions: semanticDimensions.map((dimension) => ({ dimension, verdict: "pass|fail", reason: "string", evidence: ["short exact excerpt"], confidence: 0.5 })),
    },
    input: {
      userRequest: target.user.request,
      explicitSettings: target.user.explicitSettings,
      finalBody: body,
      sectionBodies: sections.map((section, index) => ({ section: index + 1, body: section })),
    },
  });
  const response = await openAiCompatibleJson(runtime, prompt, "Evaluate long-form quality and return valid JSON only.");
  const parsed = parseJsonResponse(response.content);
  const dimensions = {};
  for (const dimension of semanticDimensions) {
    const item = Array.isArray(parsed.dimensions) ? parsed.dimensions.find((entry) => entry?.dimension === dimension) : undefined;
    dimensions[dimension] = parseSemanticDimension(item);
  }
  return { promptVersion: "aq-long-form-judge-v1", dimensions, latencyMs: response.latencyMs, usage: response.usage };
}

async function compareCandidateBodies({ repetition, minimal, state, testCase: target, profileRuntime: runtime }) {
  const compare = async (order) => {
    const first = order === "minimal-state" ? minimal.body : state.body;
    const second = order === "minimal-state" ? state.body : minimal.body;
    const prompt = JSON.stringify({
      instruction: "盲化比较两篇正文。只按用户请求与五项长文维度判断，不推测候选名称、模型或内部实现。若无稳定优势返回 tie。",
      dimensions: LONG_FORM_GATE_DIMENSIONS,
      outputContract: { winner: "first|second|tie", reason: "string", confidence: 0.5 },
      input: { userRequest: target.user.request, explicitSettings: target.user.explicitSettings, first, second },
    });
    const response = await openAiCompatibleJson(runtime, prompt, "Compare the two answers and return valid JSON only.");
    const parsed = parseJsonResponse(response.content);
    const winner = parsed.winner === "first" || parsed.winner === "second" || parsed.winner === "tie" ? parsed.winner : "invalid";
    const canonicalWinner = winner === "tie" || winner === "invalid"
      ? winner
      : order === "minimal-state"
        ? winner === "first" ? "minimal_prompt_adjustment" : "long_form_state_prototype"
        : winner === "first" ? "long_form_state_prototype" : "minimal_prompt_adjustment";
    return {
      order,
      displayedWinner: winner,
      canonicalWinner,
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 1_000) : "No valid reason returned",
      confidence: boundedConfidence(parsed.confidence),
      latencyMs: response.latencyMs,
      usage: response.usage,
    };
  };
  const judgments = [await compare("minimal-state"), await compare("state-minimal")];
  const winners = judgments.map((entry) => entry.canonicalWinner);
  const canonicalWinner = winners[0] === winners[1] && winners[0] !== "invalid" ? winners[0] : "inconclusive";
  return { repetition, canonicalWinner, judgments };
}

async function openAiCompatibleJson(runtime, prompt, system) {
  const baseUrl = (runtime.profile.baseUrl || DEFAULT_PROVIDER_REGISTRY.get(runtime.profile.providerId).defaultBaseUrl).replace(/\/+$/, "");
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${runtime.apiKey}`, "Content-Type": "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model: runtime.profile.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Evaluation Judge failed with HTTP ${response.status}`);
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("Evaluation Judge returned no structured content");
  return {
    content,
    latencyMs: Date.now() - startedAt,
    usage: payload.usage ? {
      inputTokens: Number(payload.usage.prompt_tokens ?? 0),
      outputTokens: Number(payload.usage.completion_tokens ?? 0),
      inputCacheHitTokens: Number(payload.usage.prompt_cache_hit_tokens ?? payload.usage.prompt_tokens_details?.cached_tokens ?? 0),
      inputCacheMissTokens: Number(payload.usage.prompt_cache_miss_tokens ?? 0),
    } : undefined,
  };
}

function combineDimensions({ semanticJudge, completion, exactRepetitions, missingCoverageTerms }) {
  const semantic = semanticJudge.dimensions;
  return {
    cross_section_repetition: exactRepetitions.length
      ? { verdict: "fail", reason: `Deterministic cross-section duplicate: ${exactRepetitions[0].slice(0, 160)}`, confidence: 1 }
      : semantic.cross_section_repetition,
    cross_section_contradiction: semantic.cross_section_contradiction,
    required_operation_coverage: missingCoverageTerms.length
      ? { verdict: "fail", reason: `Missing preregistered case coverage terms: ${missingCoverageTerms.join(", ")}`, confidence: 1 }
      : semantic.required_operation_coverage,
    terminology_consistency: semantic.terminology_consistency,
    completion_integrity: completion,
  };
}

function candidateState({ candidateId, taskId, outputMessageId, repetition, outline, sectionIndex, writtenSoFar, completedSections, continuationContent }) {
  if (candidateId !== "long_form_state_prototype") {
    return JSON.stringify({
      outline,
      sectionIndex,
      writtenSoFarTail: writtenSoFar.slice(-4_000),
      ...(continuationContent ? { continuationTail: continuationContent.slice(-500) } : {}),
    });
  }
  const snapshot = {
    schemaVersion: 1,
    stateVersion: "long-form-state-prototype-v1",
    snapshotId: `${taskId}:state:${sectionIndex}:${continuationContent ? "continuation" : "initial"}`,
    generationAttempt: repetition,
    bodyVersionId: researchBodyVersionId(outputMessageId, writtenSoFar),
    planProgress: outline.sections.map((section, index) => ({
      heading: section.heading,
      status: index < sectionIndex ? "completed" : index === sectionIndex ? "writing" : "pending",
    })),
    terminologyConventions: outline.sections.map((section) => ({ term: section.heading, canonicalLabel: section.heading, source: "outline" })),
    completedSectionSummaries: completedSections.map((section, index) => ({
      heading: outline.sections[index]?.heading ?? `section-${index + 1}`,
      summary: summarizeSection(section),
    })),
    unresolvedOutlineItems: outline.sections.slice(sectionIndex).map((section) => ({ heading: section.heading, summary: section.summary })),
    recentBodyTail: writtenSoFar.slice(-1_500),
    ...(continuationContent ? { continuationTail: continuationContent.slice(-500) } : {}),
    evidenceAllocations: [],
    invalidation: { generationAttempt: repetition, bodyVersionId: researchBodyVersionId(outputMessageId, writtenSoFar) },
  };
  return JSON.stringify(snapshot);
}

function minimalPromptCandidate(taskId) {
  return {
    id: `${taskId}:minimal-long-form-rule`,
    channel: "behavior_rule",
    ruleKind: "task_contract",
    content: "每节只推进它对应的大纲项；不得重述已完成章节的论证或结论。沿用前文已经建立的核心术语、路径名称和结论含义；如需修订必须明确说明。最终正文必须实际完成用户要求的诊断、比较、执行顺序并给出明确结论。",
    source: { kind: "task_rule", id: "aq-long-form-minimal-prompt-v1", version: "1", scope: "turn" },
    permission: { status: "required", basis: "task_contract", allowedPurposes: ["research_body_outline", "research_body_section"] },
    sensitivity: "standard",
    priority: "task_required",
    protection: "required",
  };
}

function continuationCandidate(taskId, sectionIndex, content) {
  return {
    id: `${taskId}:continuation:${sectionIndex}`,
    channel: "factual_evidence",
    evidenceKind: "continuation_state",
    content,
    source: { kind: "continuation", id: `${taskId}:section:${sectionIndex}`, version: "1", scope: "turn" },
    permission: { status: "required", basis: "task_contract", allowedPurposes: ["research_body_section"] },
    sensitivity: "private",
    priority: "task_required",
    protection: "required",
    upstreamRank: { source: "tool", rank: 0 },
  };
}

function modelContext(taskId, workflowStepId, purpose, answerPlanId, packet) {
  return {
    workflowRunId: taskId,
    workflowStepId,
    answerPlanId,
    purpose,
    promptVersion: packet.releaseProfile.promptEnvelopeVersion,
    buildFingerprint: packet.candidateSha,
  };
}

function safeModelCall(event) {
  return {
    context: event.context,
    provider: event.provider,
    model: event.model,
    promptVersion: event.promptVersion,
    envelope: event.envelope,
    requestedBudget: event.requestedBudget,
    resolvedBudget: event.resolvedBudget,
    appliedBudget: event.appliedBudget,
    status: event.status,
    usage: event.usage,
    estimatedCostUsd: event.estimatedCostUsd,
    latencyMs: event.latencyMs,
    finishReason: event.finishReason,
    errorCategory: event.errorCategory,
    buildFingerprint: event.buildFingerprint,
    createdAt: event.createdAt,
    completedAt: event.completedAt,
  };
}

function parseSemanticDimension(item) {
  if (!item || (item.verdict !== "pass" && item.verdict !== "fail")) {
    return { verdict: "unverified", reason: "Judge did not return the preregistered dimension.", confidence: 0 };
  }
  const evidence = Array.isArray(item.evidence) ? item.evidence.filter((entry) => typeof entry === "string").slice(0, 2) : [];
  return {
    verdict: item.verdict,
    reason: `${typeof item.reason === "string" ? item.reason.slice(0, 1_000) : "No reason returned"}${evidence.length ? ` Evidence: ${evidence.join(" | ")}` : ""}`,
    confidence: boundedConfidence(item.confidence),
  };
}

function parseJsonResponse(value) {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}

function requireAssembly(result, label) {
  if (result.status !== "assembled") throw new Error(`ContextAssembly failed for ${label}: ${result.reason}`);
  return result;
}

function ensureSectionHeading(content, heading) {
  const normalized = content.trim();
  const firstLine = normalized.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n", 1)[0] ?? "";
  return /^##(?!#)\s+\S/.test(firstLine) ? normalized : `## ${heading}\n\n${normalized}`;
}

function joinContinuation(existing, continuation) {
  const left = existing.trimEnd();
  const right = continuation.trimStart();
  const maximum = Math.min(left.length, right.length, 500);
  for (let length = maximum; length >= 20; length -= 1) {
    if (left.endsWith(right.slice(0, length))) return `${left}${right.slice(length)}`;
  }
  return `${left}\n\n${right}`;
}

function summarizeSection(value) {
  return value.replace(/^##(?!#).*$/m, "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function readActiveProfile(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const activeProfileId = database.prepare("SELECT value FROM settings WHERE key = ?").get("active_provider_profile_id")?.value;
    if (!activeProfileId) throw new Error("No active provider profile is configured in the read-only evaluation database");
    const row = database.prepare("SELECT record_json AS recordJson FROM provider_profiles WHERE id = ?").get(activeProfileId);
    if (!row?.recordJson) throw new Error("The active provider profile is unavailable");
    const profile = JSON.parse(row.recordJson);
    const apiKey = database.prepare("SELECT api_key AS apiKey FROM provider_credentials WHERE id = ?").get(activeProfileId)?.apiKey;
    if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("The active provider credential is unavailable");
    return { profile, apiKey: apiKey.trim() };
  } finally {
    database.close();
  }
}

function validateProfile(profile, expected) {
  const actual = {
    provider: profile.providerId,
    model: profile.model,
    thinking: profile.thinkingEnabled ?? false,
    configurationVersion: profile.configurationVersion,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Active model profile does not match preregistration: ${JSON.stringify(actual)}`);
}

function validatePreregistration(packet) {
  if (packet.schemaVersion !== 1 || packet.status !== "preregistered") throw new Error("Unsupported long-form preregistration packet");
  if (packet.sampleProtocol.generationRepetitions !== 3 || packet.sampleProtocol.additionalRunLimit !== 0) throw new Error("Preregistered sample protocol was changed");
  if (JSON.stringify(packet.rubric.mustPassDimensions) !== JSON.stringify(LONG_FORM_GATE_DIMENSIONS)) throw new Error("Preregistered long-form dimensions do not match the evaluator");
}

function repositoryPath(value) {
  const path = resolve(repositoryRoot, value);
  const local = relative(repositoryRoot, path);
  if (!local || local.startsWith("..") || isAbsolute(local)) throw new Error("Evaluation artifact path must stay inside the repository");
  return path;
}

function boundedConfidence(value) {
  const confidence = Number(value);
  return Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0;
}

function round(value, digits) {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
