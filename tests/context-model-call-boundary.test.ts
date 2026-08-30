import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CONTEXT_PURPOSES, type ContextPurpose } from "@collector/capture-contracts";
import { assembleConnectionTestContext, assemblePurposeContext, reassemblePurposeContext } from "@collector/api";
import { FakeProvider, ModelGateway } from "@collector/model-gateway";

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

test("context-native gateway entry applies the purpose output budget", async () => {
  const provider = new FakeProvider([JSON.stringify({ title: "标题", concepts: [] })]);
  const gateway = new ModelGateway(provider);
  const assembly = assemblePurposeContext({
    purpose: "research_slice_annotation",
    materials: [{ id: "paragraph", content: JSON.stringify({ content: "一段正文" }) }],
  });
  await gateway.deriveSliceAnnotationsFromContext(assembly, { maxTokens: 99_999 });
  assert.equal(provider.calls[0].maxTokens, assembly.budget.reservedOutputTokens);
});
