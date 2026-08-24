import assert from "node:assert/strict";
import test from "node:test";
import { ModelGateway, type ModelProvider, type ModelProviderRequest } from "@collector/model-gateway";

test("document generation sends every long-input segment and merges batch results", async () => {
  const prompts: string[] = [];
  let outlineBatch = 0;
  let sectionBatch = 0;
  const provider: ModelProvider = {
    name: "recording-provider",
    async complete(request: ModelProviderRequest) {
      prompts.push(request.prompt);
      if (request.prompt.includes("Create a document outline")) {
        outlineBatch += 1;
        return {
          model: request.model,
          content: JSON.stringify({ title: "Long document", sections: [{ heading: "Complete evidence", keyPoints: [`outline batch ${outlineBatch}`] }] }),
        };
      }
      sectionBatch += 1;
      return {
        model: request.model,
        content: JSON.stringify({ sections: [{ heading: "Complete evidence", markdown: `section batch ${sectionBatch}`, citationMaterialIds: ["long-material"] }] }),
      };
    },
  };
  const gateway = new ModelGateway(provider);
  const content = `START-${"a".repeat(29_000)}-MIDDLE-${"b".repeat(29_000)}-END`;
  const outline = await gateway.generateDocumentOutline([{ id: "long-material", content }], "Long input");
  assert.ok(!("errorCode" in outline));
  assert.ok(outlineBatch >= 3);
  const sections = await gateway.generateDocumentSections(outline, [{ id: "long-material", content, fragmentIds: ["fragment-long"] }]);
  assert.ok(!("errorCode" in sections));
  assert.equal(sectionBatch, outlineBatch);
  assert.match(sections.sections[0].markdown, /section batch 1/);
  assert.match(sections.sections[0].markdown, new RegExp(`section batch ${sectionBatch}`));
  assert.deepEqual(sections.sections[0].citationIds, ["fragment-long"]);
  const combinedPrompts = prompts.join("\n");
  assert.match(combinedPrompts, /START-/);
  assert.match(combinedPrompts, /-MIDDLE-/);
  assert.match(combinedPrompts, /-END/);
});

test("association hint evaluation returns a value decision and rejects an inconsistent provider result", async () => {
  const valid: ModelProvider = {
    name: "fake",
    async complete() {
      return { model: "fake", content: JSON.stringify({ relationType: "contrast", reason: "两段材料可形成有助于理解差异的对照。", hasValue: true, benefits: ["comparison"], priority: 72, reasonSubstantiallyChanged: true }) };
    },
  };
  const gateway = new ModelGateway(valid);
  const result = await gateway.evaluateAssociationHint({
    left: { nodeId: "a", content: "证据 A", currentContext: "当前认识 A" },
    right: { nodeId: "b", content: "证据 B", currentContext: "当前认识 B" },
    terminalReasons: ["先前只是同名概念的对照。"],
  });
  assert.deepEqual(result, { relationType: "contrast", reason: "两段材料可形成有助于理解差异的对照。", hasValue: true, benefits: ["comparison"], priority: 72, reasonSubstantiallyChanged: true });

  const invalid = new ModelGateway({
    name: "fake",
    async complete() {
      return { model: "fake", content: JSON.stringify({ relationType: "contrast", reason: "关系成立但不值得打扰。", hasValue: false, benefits: ["comparison"], priority: 30, reasonSubstantiallyChanged: false }) };
    },
  });
  await assert.rejects(() => invalid.evaluateAssociationHint({
    left: { nodeId: "a", content: "证据 A", currentContext: "当前认识 A" },
    right: { nodeId: "b", content: "证据 B", currentContext: "当前认识 B" },
    terminalReasons: [],
  }), /inconsistent value decision/);

  const missingReasonChangeDecision = new ModelGateway({
    name: "fake",
    async complete() {
      return { model: "fake", content: JSON.stringify({ relationType: "contrast", reason: "一个看似新的理由。", hasValue: true, benefits: ["comparison"], priority: 30 }) };
    },
  });
  await assert.rejects(() => missingReasonChangeDecision.evaluateAssociationHint({
    left: { nodeId: "a", content: "证据 A", currentContext: "当前认识 A" },
    right: { nodeId: "b", content: "证据 B", currentContext: "当前认识 B" },
    terminalReasons: ["历史理由"],
  }), /invalid result/);
});
