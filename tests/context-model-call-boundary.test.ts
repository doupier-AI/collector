import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CONTEXT_PURPOSES, type ContextPurpose } from "@collector/capture-contracts";
import { assembleConnectionTestContext, assemblePurposeContext, reassemblePurposeContext } from "@collector/api";
import { FakeProvider, ModelGateway, type ModelCallEvent } from "@collector/model-gateway";

const AUXILIARY_PURPOSES: readonly ContextPurpose[] = [
  "research_slice_annotation",
  "term_preview",
  "term_entity_verification",
  "session_titling",
  "node_naming",
  "import_chapter_parsing",
  "association_hint_evaluation",
  "similarity_verification",
  "temporary_fusion_discovery",
  "temporary_fusion_conversation",
  "temporary_fusion_draft_revalidation",
  "query_reformulation",
  "agent_search",
  "cluster_materials",
  "document_outline",
  "document_sections",
  "incremental_document_update",
] as const;

test("every auxiliary business purpose is registered and accepts only its declared minimal material", () => {
  for (const purpose of AUXILIARY_PURPOSES) {
    assert.ok(CONTEXT_PURPOSES.includes(purpose));
    const assembly = assemblePurposeContext({
      purpose,
      workflowRunId: `test:${purpose}`,
      materials: [{ id: "only-material", content: JSON.stringify({ value: purpose }) }],
    });
    assert.equal(assembly.purpose, purpose);
    assert.equal(assembly.adopted.length, 1);
    assert.equal(assembly.adopted[0].candidate.permission.allowedPurposes?.[0], purpose);
  }
  const probe = assembleConnectionTestContext();
  assert.equal(probe.purpose, "connection_test");
  assert.deepEqual(probe.adopted.map((item) => item.candidate.channel), ["behavior_rule"]);

  const grounding = assemblePurposeContext({
    purpose: "research_grounding",
    materials: [{ id: "question", content: "当前问题" }],
  });
  const agent = reassemblePurposeContext({
    purpose: "agent_search",
    candidates: grounding.adopted.map((item) => item.candidate),
  });
  assert.deepEqual(agent.adopted.map((item) => item.candidate.channel), ["factual_evidence"]);
});

test("API orchestration has no direct legacy ModelGateway business calls", () => {
  const source = readFileSync(join(process.cwd(), "apps/api/src/service.ts"), "utf8");
  const legacyCalls = [
    "answerResearchConversation",
    "deriveSliceAnnotations",
    "verifyTermIdentity",
    "parseImportChapters",
    "runAgentSearchLoop",
    "testConnection",
  ];
  for (const method of legacyCalls) {
    assert.doesNotMatch(source, new RegExp(`\\.${method}\\(`), `${method} must receive an assembled context`);
  }
});

test("context-native gateway resolves the requested output budget without silently using ContextAssembly reserve", async () => {
  const provider = new FakeProvider([JSON.stringify({ title: "标题", concepts: [] })]);
  let emitted: ModelCallEvent | undefined;
  const gateway = new ModelGateway(provider, { onCall: (event) => { emitted = event; } });
  const assembly = assemblePurposeContext({
    purpose: "research_slice_annotation",
    materials: [{ id: "paragraph", content: JSON.stringify({ content: "MODEL_CONTEXT_BODY_SENTINEL" }) }],
  });
  await gateway.deriveSliceAnnotationsFromContext(assembly, { maxTokens: 99_999 });
  assert.equal(provider.calls[0].maxTokens, 16_000);
  assert.equal(emitted?.requestedBudget.maxOutputTokens, 99_999);
  assert.equal(emitted?.resolvedBudget.maxOutputTokens, 16_000);
  assert.equal(emitted?.appliedBudget.maxOutputTokens, 16_000);
  assert.notEqual(provider.calls[0].maxTokens, assembly.budget.reservedOutputTokens);
  assert.equal(emitted?.context.contextAssembly?.adoptedCount, 1);
  assert.equal(emitted?.context.contextAssembly?.purpose, "research_slice_annotation");
  assert.doesNotMatch(JSON.stringify(emitted?.context.contextAssembly), /MODEL_CONTEXT_BODY_SENTINEL|candidateId|sourceId/);
});
