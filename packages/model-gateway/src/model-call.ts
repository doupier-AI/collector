import { randomUUID } from "node:crypto";
import {
  PROMPT_ENVELOPE_VERSION,
  type AppliedModelBudget,
  type ModelBudgetLimits,
  type ModelBudgetResolution,
  type PromptEnvelope,
  type PromptEnvelopeMessage,
  type PromptEnvelopeObservation,
  type PromptEnvelopeOutputContract,
  type RequestedModelBudget,
  type ResolvedModelBudget,
} from "@collector/capture-contracts";

const ENVELOPE_MESSAGE_OVERHEAD = 6;
const DEFAULT_SYSTEM_MESSAGE = "Follow the declared message roles and output contract. Do not expose hidden reasoning or internal control data.";

export const DEFAULT_MODEL_BUDGET_LIMITS: ModelBudgetLimits = {
  contextWindowTokens: 64_000,
  maxOutputTokens: 16_000,
  reasoningBudgetMode: "shared_output",
};

/** Stable local estimate. It is intentionally separate from provider-reported usage. */
export function estimatePromptTokens(value: string): number {
  let estimate = 0;
  for (const character of value) estimate += character.codePointAt(0)! > 0x7f ? 1 : 0.25;
  return Math.max(1, Math.ceil(estimate));
}

export function estimatePromptEnvelopeTokens(envelope: PromptEnvelope): number {
  return envelope.messages.reduce((total, message) => total
    + ENVELOPE_MESSAGE_OVERHEAD
    + estimatePromptTokens(message.content ?? "")
    + (message.toolCalls?.reduce((sum, call) => sum + estimatePromptTokens(call.name) + estimatePromptTokens(call.arguments), 0) ?? 0), 0);
}

export function createPromptEnvelope(input: {
  purpose: string;
  promptVersion: string;
  messages?: readonly PromptEnvelopeMessage[];
  system?: string;
  user?: string;
  outputContract: PromptEnvelopeOutputContract;
}): PromptEnvelope {
  const messages = input.messages
    ? input.messages.map((message) => ({
      ...message,
      ...(message.toolCalls ? { toolCalls: message.toolCalls.map((call) => ({ ...call })) } : {}),
    }))
    : [
      { role: "system" as const, content: input.system?.trim() || DEFAULT_SYSTEM_MESSAGE },
      { role: "user" as const, content: input.user ?? "" },
    ];
  if (!input.purpose.trim() || !input.promptVersion.trim()) throw new Error("Prompt envelope requires purpose and promptVersion");
  if (!messages.length || messages.some((message) => !["system", "user", "assistant", "tool"].includes(message.role))) {
    throw new Error("Prompt envelope requires valid role-preserving messages");
  }
  if (!Number.isFinite(input.outputContract.minimumBodyTokens) || input.outputContract.minimumBodyTokens <= 0) {
    throw new RangeError("Prompt envelope minimumBodyTokens must be positive");
  }
  return {
    version: PROMPT_ENVELOPE_VERSION,
    purpose: input.purpose,
    promptVersion: input.promptVersion,
    messages,
    outputContract: { ...input.outputContract },
  };
}

export function observePromptEnvelope(envelope: PromptEnvelope): PromptEnvelopeObservation {
  const roleCounts: PromptEnvelopeObservation["roleCounts"] = {};
  for (const message of envelope.messages) roleCounts[message.role] = (roleCounts[message.role] ?? 0) + 1;
  return {
    version: envelope.version,
    purpose: envelope.purpose,
    promptVersion: envelope.promptVersion,
    messageCount: envelope.messages.length,
    roleCounts,
    estimatedInputTokens: estimatePromptEnvelopeTokens(envelope),
    outputContract: { ...envelope.outputContract },
  };
}

export function resolveModelBudget(input: {
  envelope: PromptEnvelope;
  requested: RequestedModelBudget;
  limits?: ModelBudgetLimits;
  budgetResolutionAttemptId?: string;
  previousBudgetResolutionAttemptId?: string;
}): ModelBudgetResolution {
  const limits = input.limits ?? DEFAULT_MODEL_BUDGET_LIMITS;
  const attempt = {
    budgetResolutionAttemptId: input.budgetResolutionAttemptId ?? randomUUID(),
    ...(input.previousBudgetResolutionAttemptId ? { previousBudgetResolutionAttemptId: input.previousBudgetResolutionAttemptId } : {}),
  };
  for (const [name, value] of Object.entries({
    maxInputTokens: input.requested.maxInputTokens,
    maxOutputTokens: input.requested.maxOutputTokens,
    minimumBodyTokens: input.requested.minimumBodyTokens,
    contextWindowTokens: limits.contextWindowTokens,
    providerMaxOutputTokens: limits.maxOutputTokens,
  })) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`Model budget ${name} must be positive`);
  }
  const estimatedInputTokens = estimatePromptEnvelopeTokens(input.envelope);
  if (limits.maxOutputTokens < input.requested.minimumBodyTokens) {
    return {
      status: "unsatisfiable",
      ...attempt,
      estimatedInputTokens,
      minimumBodyTokens: input.requested.minimumBodyTokens,
      reason: "provider_output_limit_below_minimum",
    };
  }
  const maximumInputTokens = Math.min(
    Math.trunc(input.requested.maxInputTokens),
    Math.trunc(limits.contextWindowTokens - input.requested.minimumBodyTokens),
  );
  if (maximumInputTokens <= 0) {
    return {
      status: "unsatisfiable",
      ...attempt,
      estimatedInputTokens,
      minimumBodyTokens: input.requested.minimumBodyTokens,
      reason: "context_window_below_minimum",
    };
  }
  if (estimatedInputTokens > maximumInputTokens) {
    return {
      status: "reassembly_required",
      ...attempt,
      estimatedInputTokens,
      maximumInputTokens,
      minimumBodyTokens: input.requested.minimumBodyTokens,
      reason: "context_window_requires_smaller_input",
    };
  }
  const availableOutputTokens = Math.trunc(limits.contextWindowTokens - estimatedInputTokens);
  const maxOutputTokens = Math.min(
    Math.trunc(input.requested.maxOutputTokens),
    Math.trunc(limits.maxOutputTokens),
    availableOutputTokens,
  );
  if (maxOutputTokens < input.requested.minimumBodyTokens) {
    return {
      status: "reassembly_required",
      ...attempt,
      estimatedInputTokens,
      maximumInputTokens,
      minimumBodyTokens: input.requested.minimumBodyTokens,
      reason: "context_window_requires_smaller_input",
    };
  }
  return {
    status: "resolved",
    ...attempt,
    estimatedInputTokens,
    maxInputTokens: maximumInputTokens,
    maxOutputTokens,
    minimumBodyTokens: input.requested.minimumBodyTokens,
    thinking: input.requested.thinking,
    reasoningBudgetMode: input.requested.thinking ? limits.reasoningBudgetMode : "none",
  };
}

export function appliedModelBudget(resolved: ResolvedModelBudget): AppliedModelBudget {
  return { maxOutputTokens: resolved.maxOutputTokens, thinking: resolved.thinking };
}

export class ModelBudgetReassemblyRequiredError extends Error {
  readonly name = "ModelBudgetReassemblyRequiredError";
  constructor(readonly resolution: Extract<ModelBudgetResolution, { status: "reassembly_required" }>) {
    super("Model input must be reassembled within the resolved context window");
  }
}

export class ModelBudgetUnsatisfiableError extends Error {
  readonly name = "ModelBudgetUnsatisfiableError";
  constructor(readonly resolution: Extract<ModelBudgetResolution, { status: "unsatisfiable" }>) {
    super("Model budget cannot satisfy the minimum visible-body contract");
  }
}

export function assertResolvedBudget(resolution: ModelBudgetResolution): ResolvedModelBudget {
  if (resolution.status === "reassembly_required") throw new ModelBudgetReassemblyRequiredError(resolution);
  if (resolution.status === "unsatisfiable") throw new ModelBudgetUnsatisfiableError(resolution);
  return resolution;
}

export function promptEnvelopeText(envelope: PromptEnvelope): string {
  return envelope.messages.map((message) => message.content ?? "").filter(Boolean).join("\n\n");
}
