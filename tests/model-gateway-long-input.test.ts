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

test("native research generation repairs malformed slices at most twice", async () => {
  const responses = [
    JSON.stringify({ slices: [{ title: "无正文", content: "", normalizedConcepts: [] }] }),
    JSON.stringify({ slices: [
      { title: "本地优先", content: "本地优先让研究数据保留在用户控制的环境中。", normalizedConcepts: ["本地优先"] },
      { title: "恢复能力", content: "任务状态持久化后，失败可以在原有上下文中恢复。", normalizedConcepts: ["任务恢复"] },
    ] }),
  ];
  const prompts: string[] = [];
  const events: Array<{ retryCount: number; promptVersion: string }> = [];
  const provider: ModelProvider = {
    name: "repairing-provider",
    async complete(request) {
      prompts.push(request.prompt);
      return { model: request.model, content: responses.shift() ?? "{}" };
    },
  };
  const gateway = new ModelGateway(provider, { onCall: (event) => { events.push({ retryCount: event.retryCount, promptVersion: event.promptVersion }); } });
  const result = await gateway.generateNativeResearchConversation(
    [{ role: "user", content: "说明本地优先的价值" }],
    { nodeId: "node-1", messageId: "message-1", ordinalStart: 4 },
    { context: { workflowRunId: "task-1", purpose: "research_chat", promptVersion: "research-slices-v1" } },
  );

  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? "", /failed Collector's required slice schema/);
  assert.deepEqual(events.map((event) => event.retryCount), [0, 1]);
  assert.deepEqual(events.map((event) => event.promptVersion), ["research-slices-v1", "research-slices-v1"]);
  assert.equal(result.content, "本地优先让研究数据保留在用户控制的环境中。\n\n任务状态持久化后，失败可以在原有上下文中恢复。");
  assert.deepEqual(result.slices.map((slice) => ({ id: slice.id, ordinal: slice.ordinal, isProvisional: slice.isProvisional })), [
    { id: "slice:node-1:message-1:4", ordinal: 4, isProvisional: false },
    { id: "slice:node-1:message-1:5", ordinal: 5, isProvisional: false },
  ]);
});

test("native research generation fails after two bounded repairs without returning content", async () => {
  let calls = 0;
  const gateway = new ModelGateway({
    name: "invalid-provider",
    async complete(request) {
      calls += 1;
      return { model: request.model, content: JSON.stringify({ slices: [] }) };
    },
  });

  await assert.rejects(
    gateway.generateNativeResearchConversation(
      [{ role: "user", content: "说明失败边界" }],
      { nodeId: "node-2", messageId: "message-2", ordinalStart: 0 },
    ),
    /remained invalid after 2 repairs/,
  );
  assert.equal(calls, 3);
});
