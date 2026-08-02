import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveProvisionalSlices, parseNativeResearchSliceGeneration, validateSliceSchema, deriveMessageBlocks, type ResearchSliceRecord } from "@collector/capture-contracts";

describe("validateSliceSchema (E1)", () => {
  const nodeId = "node-1";
  const messageId = "msg-1";

  function makeSlice(overrides: Partial<ResearchSliceRecord> = {}): ResearchSliceRecord {
    return {
      id: "slice:node-1:msg-1:0",
      nodeId: "node-1",
      messageId: "msg-1",
      ordinal: 0,
      title: "段落 1",
      content: "第一段内容",
      normalizedConcepts: [],
      sourceRefs: [],
      isProvisional: true,
      createdAt: "2026-08-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("passes for a single valid slice", () => {
    assert.doesNotThrow(() => validateSliceSchema([makeSlice()], nodeId, messageId));
  });

  it("passes for multiple slices with strictly increasing ordinals", () => {
    const slices = [
      makeSlice({ id: "slice:node-1:msg-1:0", ordinal: 0 }),
      makeSlice({ id: "slice:node-1:msg-1:3", ordinal: 3, title: "段落 2", content: "第二段内容" }),
    ];
    assert.doesNotThrow(() => validateSliceSchema(slices, nodeId, messageId));
  });

  it("rejects unstable ID", () => {
    const slices = [makeSlice({ id: "wrong-id" })];
    assert.throws(() => validateSliceSchema(slices, nodeId, messageId), /Slice id must be/);
  });

  it("rejects non-increasing ordinals", () => {
    const slices = [
      makeSlice({ id: "slice:node-1:msg-1:5", ordinal: 5 }),
      makeSlice({ id: "slice:node-1:msg-1:5", ordinal: 5, title: "段落 2", content: "第二段内容" }),
    ];
    assert.throws(() => validateSliceSchema(slices, nodeId, messageId), /strictly increasing/);
  });

  it("rejects empty title", () => {
    assert.throws(() => validateSliceSchema([makeSlice({ title: "" })], nodeId, messageId), /title must be a non-empty string/);
  });

  it("rejects empty content", () => {
    assert.throws(() => validateSliceSchema([makeSlice({ content: "   " })], nodeId, messageId), /content must be a non-empty string/);
  });

  it("rejects empty string in normalizedConcepts", () => {
    assert.throws(() => validateSliceSchema([makeSlice({ normalizedConcepts: [""] })], nodeId, messageId), /normalizedConcepts/);
  });
});

describe("deriveProvisionalSlices (E1)", () => {
  const nodeId = "node-1";
  const messageId = "msg-1";
  const timestamp = "2026-08-01T00:00:00.000Z";

  it("returns empty array for empty content", () => {
    assert.deepStrictEqual(deriveProvisionalSlices(nodeId, messageId, "", 0, [], timestamp), []);
    assert.deepStrictEqual(deriveProvisionalSlices(nodeId, messageId, "   \n\n   ", 0, [], timestamp), []);
  });

  it("derives one slice per message block with stable IDs", () => {
    const content = "第一段。\n\n第二段。\n\n第三段。";
    const slices = deriveProvisionalSlices(nodeId, messageId, content, 0, [], timestamp);
    assert.strictEqual(slices.length, 3);
    assert.strictEqual(slices[0].id, "slice:node-1:msg-1:0");
    assert.strictEqual(slices[1].id, "slice:node-1:msg-1:1");
    assert.strictEqual(slices[2].id, "slice:node-1:msg-1:2");
  });

  it("uses ordinalOffset for per-node ordinal continuation", () => {
    const content = "新消息第一段。\n\n新消息第二段。";
    const slices = deriveProvisionalSlices(nodeId, messageId, content, 5, [], timestamp);
    assert.strictEqual(slices[0].ordinal, 5);
    assert.strictEqual(slices[1].ordinal, 6);
    assert.strictEqual(slices[0].id, "slice:node-1:msg-1:5");
    assert.strictEqual(slices[1].id, "slice:node-1:msg-1:6");
  });

  it("slice content matches deriveMessageBlocks text", () => {
    const content = "Alpha paragraph.\n\nBeta paragraph.";
    const blocks = deriveMessageBlocks(content);
    const slices = deriveProvisionalSlices(nodeId, messageId, content, 0, [], timestamp);
    assert.strictEqual(slices.length, blocks.length);
    for (let i = 0; i < blocks.length; i++) {
      assert.strictEqual(slices[i].content, blocks[i].text);
    }
  });

  it("is idempotent — two calls produce identical results", () => {
    const content = "First.\n\nSecond.\n\nThird.";
    const a = deriveProvisionalSlices(nodeId, messageId, content, 0, [], timestamp);
    const b = deriveProvisionalSlices(nodeId, messageId, content, 0, [], timestamp);
    assert.deepStrictEqual(a, b);
  });

  it("does not modify source text", () => {
    const content = "  Spaced out.  \n\n  Another.  ";
    const original = content;
    deriveProvisionalSlices(nodeId, messageId, content, 0, [], timestamp);
    assert.strictEqual(content, original);
  });

  it("marks all slices as provisional with empty concepts", () => {
    const content = "Para one.\n\nPara two.";
    const slices = deriveProvisionalSlices(nodeId, messageId, content, 0, [], timestamp);
    for (const slice of slices) {
      assert.strictEqual(slice.isProvisional, true);
      assert.deepStrictEqual(slice.normalizedConcepts, []);
    }
  });

  it("passes validateSliceSchema", () => {
    const content = "Valid first.\n\nValid second.";
    const slices = deriveProvisionalSlices(nodeId, messageId, content, 0, [], timestamp);
    assert.doesNotThrow(() => validateSliceSchema(slices, nodeId, messageId));
  });

  it("handles CRLF normalization in block derivation", () => {
    const content = "Line1\r\n\r\nLine2\r\nLine2b";
    const slices = deriveProvisionalSlices(nodeId, messageId, content, 0, [], timestamp);
    const blocks = deriveMessageBlocks(content);
    assert.strictEqual(slices.length, blocks.length);
    for (let i = 0; i < blocks.length; i++) {
      assert.strictEqual(slices[i].content, blocks[i].text);
    }
  });
});

describe("parseNativeResearchSliceGeneration (E2)", () => {
  const input = { nodeId: "node-native", messageId: "message-native", ordinalStart: 7, createdAt: "2026-08-02T00:00:00.000Z" };

  it("assigns stable server identity and composes the visible article from formal slices", () => {
    const result = parseNativeResearchSliceGeneration({
      slices: [
        { title: "第一命题", content: "第一段说明一个连贯命题。", normalizedConcepts: ["概念 A", "概念 A"] },
        { title: "第二命题", content: "第二段说明另一个连贯命题。", normalizedConcepts: [] },
      ],
    }, {
      ...input,
      citations: [{ id: "citation-1", messageId: input.messageId, runId: "run-1", sourceId: "source-1", blockOrdinal: 1, markerOffset: 3, createdAt: input.createdAt }],
    });
    assert.equal(result.content, "第一段说明一个连贯命题。\n\n第二段说明另一个连贯命题。");
    assert.deepEqual(result.slices.map((slice) => ({ id: slice.id, ordinal: slice.ordinal, isProvisional: slice.isProvisional, normalizedConcepts: slice.normalizedConcepts })), [
      { id: "slice:node-native:message-native:7", ordinal: 7, isProvisional: false, normalizedConcepts: ["概念 A"] },
      { id: "slice:node-native:message-native:8", ordinal: 8, isProvisional: false, normalizedConcepts: [] },
    ]);
    assert.equal(result.slices[1]?.sourceRefs[0]?.id, "citation-1");
    assert.doesNotThrow(() => validateSliceSchema(result.slices, input.nodeId, input.messageId));
  });

  it("rejects malformed, empty, and anchor-unsafe model structures", () => {
    assert.throws(() => parseNativeResearchSliceGeneration({ slices: [] }, input), /1 to/);
    assert.throws(() => parseNativeResearchSliceGeneration({ slices: [{ title: "x", content: "正文", normalizedConcepts: [""] }] }, input), /normalized concept/);
    assert.throws(() => parseNativeResearchSliceGeneration({ slices: [{ title: "x", content: "第一段\n\n第二段", normalizedConcepts: [] }] }, input), /stable message block/);
  });
});
