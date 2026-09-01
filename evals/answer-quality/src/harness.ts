import { randomUUID } from "node:crypto";
import { AnswerPlanningModule, assembleContext, contextAssemblyAudit, ConversationContextResolver, conversationContextCandidate } from "@collector/api";
import { researchBodyVersionId, type ContextCandidate, type ResearchMessageBodyRecord } from "@collector/capture-contracts";
import { FakeProvider, ModelGateway, type ModelCallEvent, type ModelProviderResponse } from "@collector/model-gateway";
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
  buildFingerprint: string;
  unavailableReason?: string;
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
  const assembly = assembleContext({ purpose: "research_body", workflowRunId: taskId, workflowStepId: "final-writing", candidates });
  if (assembly.status !== "assembled") throw new Error(`Fixed-provider context assembly failed: ${assembly.reason}`);
  const provider = new FakeProvider([options.response]);
  const callEvents: ModelCallEvent[] = [];
  const gateway = new ModelGateway(provider, {
    model: scenario.environment.model,
    promptVersion: "answer-quality-fixed-provider-v1",
    thinking: scenario.environment.thinking,
    onCall: (event) => { callEvents.push(event); },
  });
  let finalBody = "";
  let error: AnswerQualityRun["error"];
  if (!options.unavailableReason) {
    try {
      finalBody = await gateway.writeResearchBodyFromContext(assembly, {
        maxTokens: scenario.environment.outputBudgetTokens,
        context: { workflowRunId: taskId, workflowStepId: "final-writing", purpose: "research_body", promptVersion: "answer-quality-fixed-provider-v1" },
      });
    } catch (cause) {
      error = { category: "provider", message: safeError(cause) };
    }
  }
  const finalWritingState: RunExecutionFact = options.unavailableReason
    ? { capabilityId: "final_writing", state: "not_executed" }
    : error
    ? { capabilityId: "final_writing", state: "failed", errorCategory: error.category }
    : { capabilityId: "final_writing", state: "completed", artifactId: outputMessageId };
  const availability = availabilityFacts(testCase, availabilityCapturedAt, options.unavailableReason);
  const execution: RunExecutionFact[] = [
    { capabilityId: "conversation_context", state: "completed", artifactId: conversationContext.contextId },
    { capabilityId: "answer_plan", state: "completed", artifactId: answerPlanning.plan.planId },
    { capabilityId: "context_assembly", state: "completed", artifactId: `${taskId}:context-assembly` },
    finalWritingState,
    { capabilityId: "production_run_record", state: "completed", artifactId: `${taskId}:model-call` },
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
    contextAssembly: {
      request: { purpose: "research_body", candidates },
      audit: contextAssemblyAudit(assembly),
    },
    toolCalls: [],
    providerRequests: provider.calls.map((request) => ({ ...request, signal: undefined })),
    finalBody,
    productionRunRecords: callEvents.map((event) => ({ ...event, context: { ...event.context } })),
  };
  return {
    mode: "fixed_provider",
    identity: {
      caseVersion: testCase.caseVersion,
      caseId: testCase.id,
      taskId,
      inputMessageId,
      outputMessageId,
      bodyVersionId: researchBodyVersionId(outputMessageId, finalBody),
      generationAttempt: 1,
      model: scenario.environment.model,
      thinking: scenario.environment.thinking,
      buildFingerprint: options.buildFingerprint,
    },
    facts,
    artifactBindings,
    trace,
    userRequest: scenario.userRequest,
    explicitSettings: scenario.explicitSettings,
    admittedEvidence: [],
    validCitations: [],
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

function availabilityFacts(testCase: AnswerQualityCase, capturedAt: string, finalWritingUnavailableReason?: string): RunAvailabilityFact[] {
  const facts: RunAvailabilityFact[] = [
    { capabilityId: "conversation_context", state: "available", capturedAt },
    { capabilityId: "answer_plan", state: "available", capturedAt },
    { capabilityId: "context_assembly", state: "available", capturedAt },
    finalWritingUnavailableReason
      ? { capabilityId: "final_writing", state: "unavailable", reason: finalWritingUnavailableReason, capturedAt }
      : { capabilityId: "final_writing", state: "available", capturedAt },
    { capabilityId: "production_run_record", state: "available", capturedAt },
  ];
  if (testCase.expectation.capabilities.citation_attribution !== "not_applicable") {
    facts.push({ capabilityId: "citation_attribution", state: "unavailable", reason: "fixed-provider-has-no-qualified-citation-events", capturedAt });
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
    if (executionFact?.state === "failed") return { capabilityId, status: "failed", reason: executionFact.errorCategory };
    if (executionFact?.state === "completed" && executionFact.artifactId) return { capabilityId, status: "bound", artifactId: executionFact.artifactId };
    return { capabilityId, status: testCase.expectation.capabilities[capabilityId] === "optional" ? "not_applicable" : "unavailable", reason: "no-artifact-produced" };
  });
}

function normalizeValue(value: unknown, key?: string): unknown {
  if (["createdAt", "completedAt", "capturedAt", "latencyMs", "taskId", "workflowRunId", "inputMessageId", "outputMessageId", "bodyVersionId", "assemblyAttemptId", "previousAssemblyAttemptId", "budgetResolutionAttemptId", "previousBudgetResolutionAttemptId"].includes(key ?? "")) return undefined;
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
    .replace(/\b[0-9a-f]{64}\b/gi, "<sha256>");
  return value;
}

function safeError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/\b(?:sk|AIza|ghp|xox[baprs]-)[-_A-Za-z0-9]{8,}\b/gi, "[REDACTED]").slice(0, 500);
}
