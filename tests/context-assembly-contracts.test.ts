import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_PURPOSES,
  MODEL_PURPOSES,
  type ContextAssemblyRequest,
  type FactualEvidenceContextCandidate,
} from "@collector/capture-contracts";
import { ContextPurposeRegistry, DEFAULT_CONTEXT_PURPOSE_REGISTRY } from "@collector/api";

test("every current route and model subpurpose has an explicit context policy", () => {
  const policies = DEFAULT_CONTEXT_PURPOSE_REGISTRY.list();
  assert.deepEqual(policies.map(({ purpose }) => purpose).sort(), [...CONTEXT_PURPOSES].sort());
  assert.deepEqual([...new Set(policies.map(({ modelPurpose }) => modelPurpose))].sort(), [...MODEL_PURPOSES].sort());

  for (const required of [
    "research_chat",
    "research_grounding",
    "research_body",
    "research_slice_annotation",
    "term_preview",
    "session_titling",
    "import_chapter_parsing",
    "association_hint_evaluation",
    "temporary_fusion_discovery",
    "query_reformulation",
    "agent_search",
    "document_outline",
    "document_sections",
  ]) {
    assert.equal(DEFAULT_CONTEXT_PURPOSE_REGISTRY.resolve(required).allowed, true, `${required} must be registered`);
  }
});

test("unknown purposes are denied before candidates can reach a provider", () => {
  assert.deepEqual(DEFAULT_CONTEXT_PURPOSE_REGISTRY.resolve("unregistered_side_channel"), {
    allowed: false,
    purpose: "unregistered_side_channel",
    reason: "unknown_purpose",
  });
});

test("candidate contracts keep channel, source, permission, sensitivity, and budget explicit", () => {
  const question: FactualEvidenceContextCandidate = {
    id: "question:turn-1",
    channel: "factual_evidence",
    evidenceKind: "current_question",
    content: "当前问题",
    source: { kind: "conversation", id: "message:user-1", version: "body:v1", scope: "turn" },
    permission: { status: "required", basis: "task_contract", allowedPurposes: ["research_chat"] },
    sensitivity: "private",
    priority: "task_required",
    protection: "required",
    upstreamRank: { source: "conversation", rank: 0 },
  };
  const request: ContextAssemblyRequest = {
    purpose: "research_chat",
    workflowRunId: "task-1",
    budget: { maxInputTokens: 4_000, reservedOutputTokens: 1_000 },
    candidates: [question],
  };

  assert.equal(request.candidates[0].source.id, "message:user-1");
  assert.equal(request.candidates[0].permission.status, "required");
  assert.equal(request.budget?.reservedOutputTokens, 1_000);
});

test("registry snapshots are isolated and invalid policies fail closed", () => {
  const first = DEFAULT_CONTEXT_PURPOSE_REGISTRY.list();
  (first[0].allowedChannels as string[]).push("mutated");
  assert.equal(DEFAULT_CONTEXT_PURPOSE_REGISTRY.list()[0].allowedChannels.includes("mutated" as never), false);

  const chat = DEFAULT_CONTEXT_PURPOSE_REGISTRY.resolve("chat");
  assert.equal(chat.allowed, true);
  if (!chat.allowed) return;
  assert.throws(() => new ContextPurposeRegistry([chat.policy, chat.policy]), /already registered/);
  assert.throws(() => new ContextPurposeRegistry([{ ...chat.policy, defaultBudget: { maxInputTokens: 0, reservedOutputTokens: 1 } }]), /positive/);
});
