import {
  type ContextCandidate,
  type ContextPurpose,
  type ContextSensitivity,
} from "@collector/capture-contracts";
import type { AssembledModelContext } from "@collector/model-gateway";
import { assembleContext } from "./context-assembly.js";

export interface PurposeContextMaterial {
  id: string;
  content: string;
  sourceKind?: "conversation" | "research_content" | "imported_material" | "tool_result" | "system_probe";
  evidenceKind?: "current_question" | "explicit_material" | "conversation_history" | "research_context" | "imported_material" | "tool_result";
  sensitivity?: ContextSensitivity;
}

/**
 * Auxiliary model calls must declare their complete, minimal material set here before reaching
 * ModelGateway. This keeps permission, sensitivity, redaction and budget policy on the same path
 * as the main research chain instead of letting each feature hand-build an arbitrary prompt.
 */
export function assemblePurposeContext(input: {
  purpose: ContextPurpose;
  workflowRunId?: string;
  projectId?: string;
  materials: readonly PurposeContextMaterial[];
}): AssembledModelContext {
  const candidates: ContextCandidate[] = input.materials.map((material, index) => ({
    id: `${input.purpose}:${material.id}`,
    channel: "factual_evidence",
    content: material.content,
    source: {
      kind: material.sourceKind ?? "research_content",
      id: material.id,
      scope: input.projectId ? "project" : "turn",
      ...(input.projectId ? { projectId: input.projectId } : {}),
    },
    permission: {
      status: "required",
      basis: "task_contract",
      allowedPurposes: [input.purpose],
    },
    sensitivity: material.sensitivity ?? "private",
    priority: "task_required",
    protection: "required",
    evidenceKind: material.evidenceKind ?? (index === 0 ? "current_question" : "explicit_material"),
    upstreamRank: { source: "research", rank: index },
  }));
  const result = assembleContext({
    purpose: input.purpose,
    ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    candidates,
  });
  if (result.status !== "assembled") {
    throw new Error(`Context assembly rejected ${input.purpose}: ${result.reason}`);
  }
  return result;
}

/** Re-evaluate already-admitted material for a narrower registered purpose without changing channels. */
export function reassemblePurposeContext(input: {
  purpose: ContextPurpose;
  workflowRunId?: string;
  candidates: readonly ContextCandidate[];
}): AssembledModelContext {
  const projectIds = [...new Set(input.candidates.flatMap((candidate) => candidate.source.projectId ? [candidate.source.projectId] : []))];
  if (projectIds.length > 1) throw new Error(`Context reassembly cannot cross projects for ${input.purpose}`);
  const candidates = input.candidates.map((candidate, index): ContextCandidate => ({
    ...candidate,
    id: `${input.purpose}:${index}:${candidate.id}`,
    source: { ...candidate.source },
    permission: { ...candidate.permission, allowedPurposes: [input.purpose] },
  }));
  const result = assembleContext({
    purpose: input.purpose,
    ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    ...(projectIds[0] ? { projectId: projectIds[0] } : {}),
    candidates,
  });
  if (result.status !== "assembled") throw new Error(`Context reassembly rejected ${input.purpose}: ${result.reason}`);
  return result;
}

/** Connection probing carries no user material; its only admitted input is the fixed probe rule. */
export function assembleConnectionTestContext(): AssembledModelContext {
  const result = assembleContext({
    purpose: "connection_test",
    candidates: [{
      id: "connection_test:probe",
      channel: "behavior_rule",
      content: "Return the fixed connection probe response only.",
      source: { kind: "system_probe", id: "connection-test-v1", scope: "system", version: "1" },
      permission: { status: "required", basis: "product_boundary", allowedPurposes: ["connection_test"] },
      sensitivity: "standard",
      priority: "hard_boundary",
      protection: "required",
      ruleKind: "product_boundary",
    }],
  });
  if (result.status !== "assembled") throw new Error(`Connection-test context assembly rejected: ${result.reason}`);
  return result;
}
