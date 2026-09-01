import { randomUUID } from "node:crypto";
import { AnswerPlanningModule, CitationAttributionModule, EvidencePreparationModule, assembleContext, contextAssemblyAudit, ConversationContextResolver, conversationContextCandidate, evidenceBundleContextCandidates } from "@collector/api";
import { researchBodyVersionId, type ContextCandidate, type ResearchMessageBodyRecord } from "@collector/capture-contracts";
import { FakeProvider, ModelGateway, type ModelCallEvent, type ModelProvider, type ModelProviderResponse } from "@collector/model-gateway";
import { createCurrentBuildCapabilities, createEvaluationFacts } from "./facts.js";
import {
  ANSWER_QUALITY_CAPABILITIES,
  type AnswerQualityCase,
  type AnswerQualityCapabilityId,
  type AnswerQualityRun,
  type ArtifactBinding,
  type ProductionScenario,
  type ProductionTrace,
  type RunAvailabilityFact,
  type RunExecutionFact,
} from "./types.js";

export interface FixedProviderRunOptions {
  response: string | Error | ModelProviderResponse;
  citationResponse?: string | Error | ModelProviderResponse;
  buildFingerprint: string;
  promptVersion?: string;
  unavailableReason?: string;
  clock?: () => string;
  id?: () => string;
}

export interface ProviderCaseRunOptions {
  provider: ModelProvider;
  buildFingerprint: string;
  mode?: AnswerQualityRun["mode"];
  model?: string;
  thinking?: boolean;
  promptVersion?: string;
  stream?: boolean;
  unavailableReason?: string;
  enableCitationAttribution?: boolean;
  clock?: () => string;
  id?: () => string;
}

export function productionScenarioFromCase(testCase: AnswerQualityCase): ProductionScenario {
  return {
    userRequest: testCase.user.request,
    conversation: testCase.user.conversation.map((turn) => ({ ...turn })),
    explicitSettings: { ...testCase.user.explicitSettings },
    environment: {
      model: testCase.environment.model,
      thinking: testCase.environment.thinking,
      webAuthorized: testCase.environment.webAuthorized,
      outputBudgetTokens: testCase.environment.outputBudgetTokens,
      fixedSearchResults: testCase.environment.fixedSearchResults.map((entry) => ({ ...entry })),
    },
  };
}

export async function runFixedProviderCase(testCase: AnswerQualityCase, options: FixedProviderRunOptions): Promise<AnswerQualityRun> {
  const provider = new FakeProvider([
    options.response,
    ...(options.citationResponse !== undefined ? [options.citationResponse] : []),
  ]);
  return runProviderCase(testCase, {
    provider,
    buildFingerprint: options.buildFingerprint,
    ...(options.promptVersion ? { promptVersion: options.promptVersion } : {}),
    ...(options.unavailableReason ? { unavailableReason: options.unavailableReason } : {}),
    ...(options.citationResponse !== undefined ? { enableCitationAttribution: true } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.id ? { id: options.id } : {}),
  });
}

export async function runProviderCase(testCase: AnswerQualityCase, options: ProviderCaseRunOptions): Promise<AnswerQualityRun> {
  const clock = options.clock ?? (() => new Date().toISOString());
  const id = options.id ?? randomUUID;
  const scenario = productionScenarioFromCase(testCase);
  const taskId = `aq-task:${id()}`;
  const inputMessageId = `aq-input:${id()}`;
  const outputMessageId = `aq-output:${id()}`;
  const availabilityCapturedAt = clock();
  const { candidates, conversationContext } = productionCandidates(
    scenario,
    taskId,
    inputMessageId,
    outputMessageId,
    availabilityCapturedAt,
    options.buildFingerprint,
  );
  const answerPlanInput = {
    taskId,
    generationAttempt: 1,
    inputMessageId,
    outputMessageId,
    currentQuestion: scenario.userRequest,
    conversationContext,
    explicitAnswerSettings: scenario.explicitSettings,
    adoptedAdaptationCategories: [],
    capabilities: {
      structuredPlanning: "unavailable" as const,
      webSearch: scenario.environment.webAuthorized ? "authorized" as const : "not_authorized" as const,
    },
  };
  const answerPlanning = await new AnswerPlanningModule({ buildFingerprint: options.buildFingerprint }).plan(answerPlanInput);
  candidates.push(answerPlanning.candidate);
  const evidencePreparationRequest = scenario.environment.webAuthorized ? {
    currentQuestion: scenario.userRequest,
    answerPlan: answerPlanning.plan,
    webAuthorization: "authorized" as const,
    budget: { maxQueries: 2, maxCandidates: 8, maxFetches: 8, maxPackedTokens: 4_000 },
  } : undefined;
  const fixedResultsByUrl = new Map(scenario.environment.fixedSearchResults.map((result) => [result.url, result]));
  const evidencePreparation = evidencePreparationRequest
    ? await new EvidencePreparationModule({
      async search(query) {
        return { query, results: scenario.environment.fixedSearchResults.map((result) => ({ sourceId: result.id, title: result.title, url: result.url, snippet: result.snippet })) };
      },
      async fetch(url) {
        const result = fixedResultsByUrl.get(url);
        return { url, content: result?.snippet ?? "", ...(result ? {} : { errorMessage: "missing fixed result" }) };
      },
      async assess({ candidate, needIds }) {
        const result = fixedResultsByUrl.get(candidate.canonicalUrl);
        return {
          relevance: result?.qualified ? "relevant" : "irrelevant",
          authorityClass: result?.qualified ? "primary" : "unknown",
          coveredNeedIds: result?.qualified ? needIds : [],
          producer: "answer-quality-fixed-search",
          version: "v1",
        };
      },
    }, () => new Date(availabilityCapturedAt)).prepare(evidencePreparationRequest)
    : undefined;
  if (evidencePreparation) candidates.push(...evidenceBundleContextCandidates(evidencePreparation.bundle));
  const assembly = assembleContext({ purpose: "research_body", workflowRunId: taskId, workflowStepId: "final-writing", candidates });
  if (assembly.status !== "assembled") throw new Error(`Fixed-provider context assembly failed: ${assembly.reason}`);
  const provider = options.provider;
  const promptVersion = options.promptVersion ?? "answer-quality-fixed-provider-v1";
  const callEvents: ModelCallEvent[] = [];
  const gateway = new ModelGateway(provider, {
    model: options.model ?? scenario.environment.model,
    promptVersion,
    thinking: options.thinking ?? scenario.environment.thinking,
    buildFingerprint: options.buildFingerprint,
    onCall: (event) => { callEvents.push(event); },
  });
  let finalBody = "";
  const generationStartedAt = Date.now();
  let firstCharacterLatencyMs: number | undefined;
  let completeLatencyMs: number | undefined;
  let error: AnswerQualityRun["error"];
  if (!options.unavailableReason) {
    try {
      if (options.stream) {
        for await (const chunk of gateway.writeResearchBodyStreamFromContext(assembly, {
          maxTokens: scenario.environment.outputBudgetTokens,
          context: { workflowRunId: taskId, workflowStepId: "final-writing", purpose: "research_body", promptVersion },
        })) {
          if (firstCharacterLatencyMs === undefined && chunk.length) firstCharacterLatencyMs = Date.now() - generationStartedAt;
          finalBody += chunk;
        }
        finalBody = finalBody.trim();
      } else {
        finalBody = await gateway.writeResearchBodyFromContext(assembly, {
          maxTokens: scenario.environment.outputBudgetTokens,
          context: { workflowRunId: taskId, workflowStepId: "final-writing", purpose: "research_body", promptVersion },
        });
      }
      completeLatencyMs = Date.now() - generationStartedAt;
      firstCharacterLatencyMs ??= completeLatencyMs;
    } catch (cause) {
      error = { category: "provider", message: safeError(cause) };
    }
  }
  const bodyVersionId = researchBodyVersionId(outputMessageId, finalBody);
  let citationAttribution: Awaited<ReturnType<CitationAttributionModule["attribute"]>> | undefined;
  if (!error && finalBody && evidencePreparation?.bundle.evidence.length && options.enableCitationAttribution
    && testCase.expectation.capabilities.citation_attribution === "required") {
    citationAttribution = await new CitationAttributionModule({
      async produce(batch) {
        const workflowStepId = `citation-attribution:${batch.batchId}`;
        const attributionAssembly = assembleContext({
          purpose: "citation_attribution",
          workflowRunId: taskId,
          workflowStepId,
          candidates: [{
            id: `${workflowStepId}:input`,
            channel: "factual_evidence",
            evidenceKind: "research_context",
            content: JSON.stringify(batch),
            source: { kind: "research_content", id: outputMessageId, version: bodyVersionId, scope: "turn" },
            permission: { status: "required", basis: "task_contract", allowedPurposes: ["citation_attribution"] },
            sensitivity: "private",
            priority: "task_required",
            protection: "required",
          }],
        });
        if (attributionAssembly.status !== "assembled") throw new Error(`Citation attribution context failed: ${attributionAssembly.reason}`);
        return {
          output: await gateway.produceCitationAttributionsFromContext(attributionAssembly, {
            context: { workflowRunId: taskId, workflowStepId, purpose: "citation_attribution", promptVersion: "citation-attribution-producer-v1" },
          }),
          provider: gateway.providerName,
          model: gateway.modelName,
          producerVersion: "citation-attribution-producer-v1",
        };
      },
    }, () => new Date(availabilityCapturedAt)).attribute({
      taskId,
      messageId: outputMessageId,
      groundingRunId: `${taskId}:grounding`,
      bodyVersionId,
      generationAttempt: 1,
      body: finalBody,
      writer: { provider: gateway.providerName, model: gateway.modelName, version: "answer-quality-final-writer-v1" },
      sources: evidencePreparation.bundle.evidence.map((item, index) => ({
        sourceId: item.id,
        sourceOrdinal: index + 1,
        preparedEvidenceId: item.id,
        ...(item.contentDigest ? { sourceVersion: item.contentDigest } : {}),
        content: item.excerpt,
        evidenceStatus: item.availability,
        admitted: true,
      })),
      providerCandidates: [],
    });
  }
  const finalCallEvent = callEvents.find((event) => event.context.workflowStepId === "final-writing");
  const finalWritingState: RunExecutionFact = options.unavailableReason
    ? { capabilityId: "final_writing", state: "not_executed" }
    : error
    ? { capabilityId: "final_writing", state: "failed", artifactId: finalCallEvent ? `${taskId}:final-writing-call` : undefined, errorCategory: error.category }
    : { capabilityId: "final_writing", state: "completed", artifactId: outputMessageId };
  const promptEnvelopeState: RunExecutionFact = finalCallEvent
    ? { capabilityId: "prompt_envelope", state: "completed", artifactId: `${taskId}:prompt-envelope:${finalCallEvent.envelope.version}` }
    : { capabilityId: "prompt_envelope", state: "not_executed" };
  const modelBudgetState: RunExecutionFact = finalCallEvent
    ? { capabilityId: "model_budget_policy", state: "completed", artifactId: finalCallEvent.resolvedBudget.budgetResolutionAttemptId }
    : { capabilityId: "model_budget_policy", state: "not_executed" };
  const citationState: RunExecutionFact | undefined = testCase.expectation.capabilities.citation_attribution === "not_applicable"
    ? undefined
    : citationAttribution?.run.status === "completed"
      ? { capabilityId: "citation_attribution", state: "completed", artifactId: citationAttribution.run.id }
      : citationAttribution
        ? { capabilityId: "citation_attribution", state: "failed", artifactId: citationAttribution.run.id, errorCategory: citationAttribution.run.status }
        : { capabilityId: "citation_attribution", state: "not_executed" };
  const productionRunRecordState: RunExecutionFact = finalCallEvent
    ? { capabilityId: "production_run_record", state: "completed", artifactId: `${taskId}:model-call` }
    : { capabilityId: "production_run_record", state: "not_executed" };
  const availability = availabilityFacts(testCase, availabilityCapturedAt, {
    finalWritingUnavailableReason: options.unavailableReason,
    citationAttributionAvailable: Boolean(options.enableCitationAttribution && evidencePreparation?.bundle.evidence.length),
  });
  const execution: RunExecutionFact[] = [
    { capabilityId: "conversation_context", state: "completed", artifactId: conversationContext.contextId },
    { capabilityId: "answer_plan", state: "completed", artifactId: answerPlanning.plan.planId },
    promptEnvelopeState,
    modelBudgetState,
    ...(evidencePreparation ? [{ capabilityId: "evidence_preparation" as const, state: "completed" as const, artifactId: evidencePreparation.bundle.bundleId }] : []),
    { capabilityId: "context_assembly", state: "completed", artifactId: `${taskId}:context-assembly` },
    finalWritingState,
    ...(citationState ? [citationState] : []),
    productionRunRecordState,
  ];
  const facts = createEvaluationFacts({
    caseExpectation: { capabilities: { ...testCase.expectation.capabilities } },
    buildCapabilities: createCurrentBuildCapabilities(),
    runAvailability: availability,
    runExecution: execution,
    releaseRequirement: { id: "historical-baseline", capabilities: {} },
  });
  const artifactBindings = artifactBindingsFor(testCase, availability, execution);
  const trace: ProductionTrace = {
    conversationContext,
    answerPlanInput,
    answerPlan: answerPlanning.plan,
    ...(evidencePreparationRequest && evidencePreparation ? { evidencePreparationRequest: { request: evidencePreparationRequest, bundle: evidencePreparation.bundle } } : {}),
    contextAssembly: {
      request: { purpose: "research_body", candidates },
      audit: contextAssemblyAudit(assembly),
    },
    ...(finalCallEvent ? { promptEnvelope: finalCallEvent.envelope } : {}),
    toolCalls: [],
    providerRequests: provider instanceof FakeProvider ? provider.calls.map((request) => ({ ...request, signal: undefined })) : [],
    finalBody,
    productionRunRecords: callEvents.map((event) => ({ ...event, context: { ...event.context } })),
  };
  return {
    mode: options.mode ?? "fixed_provider",
    identity: {
      caseVersion: testCase.caseVersion,
      caseId: testCase.id,
      taskId,
      inputMessageId,
      outputMessageId,
      bodyVersionId,
      generationAttempt: 1,
      model: options.model ?? scenario.environment.model,
      thinking: options.thinking ?? scenario.environment.thinking,
      buildFingerprint: options.buildFingerprint,
    },
    facts,
    artifactBindings,
    trace,
    userRequest: scenario.userRequest,
    explicitSettings: scenario.explicitSettings,
    admittedEvidence: evidencePreparation?.bundle.evidence.map((item) => ({ id: item.id, text: item.excerpt })) ?? [],
    validCitations: citationAttribution?.accepted.flatMap((entry) => entry.claimRange && entry.evidenceIdentity.sourceId
      ? [{ sourceId: entry.evidenceIdentity.sourceId, startOffset: entry.claimRange.startOffset, endOffset: entry.claimRange.endOffset }]
      : []) ?? [],
    ...(finalCallEvent && completeLatencyMs !== undefined && firstCharacterLatencyMs !== undefined ? {
      metrics: {
        outputTokens: finalCallEvent.usage?.outputTokens ?? 0,
        estimatedCostUsd: finalCallEvent.estimatedCostUsd ?? 0,
        firstCharacterLatencyMs,
        completeLatencyMs,
      },
    } : {}),
    ...(error ? { error } : {}),
  };
}

export function injectEvaluationCanaries(testCase: AnswerQualityCase): { mutated: AnswerQualityCase; sentinels: string[] } {
  const sentinels = [
    "AQ_CANARY_CASE_EXPECTATION",
    "AQ_CANARY_REFERENCE_ANSWER",
    "AQ_CANARY_RUBRIC",
    "AQ_CANARY_MUST_COVER",
    "AQ_CANARY_EXPECTED_EVIDENCE",
    "AQ_CANARY_EXPECTED_TASK",
    "AQ_CANARY_EXPECTED_SOURCE_COUNT",
  ];
  const mutated = structuredClone(testCase) as AnswerQualityCase;
  const expectation = mutated.expectation as unknown as Record<string, unknown>;
  expectation.referenceAnswer = sentinels[1];
  expectation.mustCover = [sentinels[3]];
  expectation.mustAvoid = [sentinels[0]];
  expectation.expectedSourceCount = { min: sentinels[6] };
  expectation.expectedEvidenceApplicability = sentinels[4];
  expectation.expectedTaskFamily = sentinels[5];
  (mutated.rubric as unknown as Record<string, unknown>).caseCriteria = [sentinels[2]];
  return { mutated, sentinels };
}

export function normalizeProductionTrace(trace: ProductionTrace): unknown {
  return normalizeValue(trace);
}

function productionCandidates(
  scenario: ProductionScenario,
  taskId: string,
  inputMessageId: string,
  outputMessageId: string,
  timestamp: string,
  buildFingerprint: string,
): { candidates: ContextCandidate[]; conversationContext: ReturnType<ConversationContextResolver["resolve"]> } {
  const nodeId = `${taskId}:node`;
  const history: ResearchMessageBodyRecord[] = scenario.conversation.map((turn, index) => ({
    id: `${taskId}:history:${index}`,
    sessionId: taskId,
    nodeId,
    role: turn.role,
    content: turn.content,
    status: "completed",
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  const currentMessage: ResearchMessageBodyRecord = {
    id: inputMessageId,
    sessionId: taskId,
    nodeId,
    role: "user",
    content: scenario.userRequest,
    status: "completed",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const conversationContext = new ConversationContextResolver({ buildFingerprint }).resolve({
    taskId,
    generationAttempt: 1,
    inputMessageId,
    outputMessageId,
    nodeId,
    currentMessage,
    messages: [...history, currentMessage],
  });
  const candidates: ContextCandidate[] = [{
    id: `${taskId}:current-question`,
    channel: "factual_evidence",
    content: scenario.userRequest,
    source: { kind: "conversation", id: `${taskId}:current-question`, scope: "turn" },
    permission: { status: "required", basis: "task_contract", allowedPurposes: ["research_body"] },
    sensitivity: "private",
    priority: "task_required",
    protection: "required",
    evidenceKind: "current_question",
    upstreamRank: { source: "conversation", rank: 0 },
  }, {
    id: `${taskId}:explicit-settings`,
    channel: "behavior_rule",
    content: JSON.stringify(scenario.explicitSettings),
    source: { kind: "user_instruction", id: `${taskId}:explicit-settings`, scope: "turn" },
    permission: { status: "required", basis: "user_choice", allowedPurposes: ["research_body"] },
    sensitivity: "standard",
    priority: "turn",
    protection: "required",
    ruleKind: "turn_instruction",
  }];
  const conversationCandidate = conversationContextCandidate(conversationContext);
  if (conversationCandidate) candidates.push(conversationCandidate);
  return { candidates, conversationContext };
}

function availabilityFacts(
  testCase: AnswerQualityCase,
  capturedAt: string,
  options: { finalWritingUnavailableReason?: string; citationAttributionAvailable: boolean },
): RunAvailabilityFact[] {
  const facts: RunAvailabilityFact[] = [
    { capabilityId: "conversation_context", state: "available", capturedAt },
    { capabilityId: "answer_plan", state: "available", capturedAt },
    { capabilityId: "prompt_envelope", state: "available", capturedAt },
    { capabilityId: "model_budget_policy", state: "available", capturedAt },
    { capabilityId: "context_assembly", state: "available", capturedAt },
    options.finalWritingUnavailableReason
      ? { capabilityId: "final_writing", state: "unavailable", reason: options.finalWritingUnavailableReason, capturedAt }
      : { capabilityId: "final_writing", state: "available", capturedAt },
    { capabilityId: "production_run_record", state: "available", capturedAt },
  ];
  if (testCase.expectation.capabilities.evidence_preparation !== "not_applicable") {
    facts.push({ capabilityId: "evidence_preparation", state: "available", capturedAt });
  }
  if (testCase.expectation.capabilities.citation_attribution !== "not_applicable") {
    facts.push(options.citationAttributionAvailable
      ? { capabilityId: "citation_attribution", state: "available", capturedAt }
      : { capabilityId: "citation_attribution", state: "unavailable", reason: "citation-attribution-runner-not-configured", capturedAt });
  }
  return facts;
}

function artifactBindingsFor(testCase: AnswerQualityCase, availability: readonly RunAvailabilityFact[], execution: readonly RunExecutionFact[]): ArtifactBinding[] {
  const builds = new Map(createCurrentBuildCapabilities().map((entry) => [entry.capabilityId, entry]));
  const available = new Map(availability.map((entry) => [entry.capabilityId, entry]));
  const executed = new Map(execution.map((entry) => [entry.capabilityId, entry]));
  return ANSWER_QUALITY_CAPABILITIES.map((capabilityId): ArtifactBinding => {
    if (testCase.expectation.capabilities[capabilityId] === "not_applicable") return { capabilityId, status: "not_applicable" };
    if (!builds.get(capabilityId)?.supported) return { capabilityId, status: "not_supported_by_build" };
    if (available.get(capabilityId)?.state === "unavailable") return { capabilityId, status: "unavailable", reason: available.get(capabilityId)?.reason };
    const executionFact = executed.get(capabilityId);
    if (executionFact?.state === "failed") return { capabilityId, status: "failed", ...(executionFact.artifactId ? { artifactId: executionFact.artifactId } : {}), reason: executionFact.errorCategory };
    if (executionFact?.state === "completed" && executionFact.artifactId) return { capabilityId, status: "bound", artifactId: executionFact.artifactId };
    return { capabilityId, status: testCase.expectation.capabilities[capabilityId] === "optional" ? "not_applicable" : "unavailable", reason: "no-artifact-produced" };
  });
}

function normalizeValue(value: unknown, key?: string): unknown {
  if (["createdAt", "completedAt", "preparedAt", "capturedAt", "latencyMs", "taskId", "workflowRunId", "inputMessageId", "outputMessageId", "bodyVersionId", "bundleId", "assemblyAttemptId", "previousAssemblyAttemptId", "budgetResolutionAttemptId", "previousBudgetResolutionAttemptId"].includes(key ?? "")) return undefined;
  if (Array.isArray(value)) return value.map((entry) => normalizeValue(entry)).filter((entry) => entry !== undefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([entryKey, entryValue]) => {
        const normalized = normalizeValue(entryValue, entryKey);
        return normalized === undefined ? [] : [[entryKey, normalized]];
      }));
  }
  if (typeof value === "string") return value
    .replace(/aq-task:[0-9a-f-]{36}/gi, "aq-task:<normalized>")
    .replace(/aq-input:[0-9a-f-]{36}/gi, "aq-input:<normalized>")
    .replace(/aq-output:[0-9a-f-]{36}/gi, "aq-output:<normalized>")
    .replace(/evidence-bundle:[0-9a-f]{20}/gi, "evidence-bundle:<normalized>")
    .replace(/\b[0-9a-f]{64}\b/gi, "<sha256>");
  return value;
}

function safeError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/\b(?:sk|AIza|ghp|xox[baprs]-)[-_A-Za-z0-9]{8,}\b/gi, "[REDACTED]").slice(0, 500);
}
