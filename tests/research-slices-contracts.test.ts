import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveProvisionalSlices, deriveMessageSlices, validateSliceSchema, validateDerivedSlices, deriveMessageBlocks, type ResearchSliceRecord, type ResearchTaskRecord } from "@collector/capture-contracts";

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

describe("deriveMessageSlices (生成自由化后的确定性派生切片)", () => {
  const nodeId = "node-d";
  const messageId = "msg-d";
  const createdAt = "2026-08-04T00:00:00.000Z";
  const content = "第一节完整论述，可跨多句。\n\n第二节继续展开。\n\n第三节收束。";

  it("按空行段落逐块派生切片，content 恒等于块文本且 isProvisional 恒为 false", () => {
    const slices = deriveMessageSlices(nodeId, messageId, content, 0, [], [], createdAt);
    assert.equal(slices.length, 3);
    assert.deepEqual(slices.map((s) => s.content), ["第一节完整论述，可跨多句。", "第二节继续展开。", "第三节收束。"]);
    assert.ok(slices.every((s) => s.isProvisional === false));
    assert.deepEqual(slices.map((s) => s.id), [
      "slice:node-d:msg-d:0",
      "slice:node-d:msg-d:1",
      "slice:node-d:msg-d:2",
    ]);
    assert.deepEqual(slices.map((s) => s.ordinal), [0, 1, 2]);
  });

  it("注入的标题与概念按块下标对齐；缺省块标题给空串、概念给空数组", () => {
    const slices = deriveMessageSlices(nodeId, messageId, content, 0, [], [
      { title: "起点", concepts: ["概念甲", " 概念乙 "] },
      undefined,
      { concepts: ["概念丙"] },
    ], createdAt);
    assert.equal(slices[0]?.title, "起点");
    assert.deepEqual(slices[0]?.normalizedConcepts, ["概念甲", "概念乙"]);
    assert.equal(slices[1]?.title, "");
    assert.deepEqual(slices[1]?.normalizedConcepts, []);
    assert.equal(slices[2]?.title, "");
    assert.deepEqual(slices[2]?.normalizedConcepts, ["概念丙"]);
  });

  it("幂等且不改源文本；ordinalOffset 保证节点范围 ordinal 连续唯一", () => {
    const first = deriveMessageSlices(nodeId, messageId, content, 5, [], [], createdAt);
    const second = deriveMessageSlices(nodeId, messageId, content, 5, [], [], createdAt);
    assert.deepEqual(first, second);
    assert.deepEqual(first.map((s) => s.ordinal), [5, 6, 7]);
    assert.equal(content, "第一节完整论述，可跨多句。\n\n第二节继续展开。\n\n第三节收束。");
  });

  it("空内容派生零切片；引用按 blockOrdinal 挂到对应切片", () => {
    assert.deepEqual(deriveMessageSlices(nodeId, messageId, "   ", 0, [], [], createdAt), []);
    const citations = [{ id: "c-1", messageId, runId: "run-1", sourceId: "src-1", blockOrdinal: 1, markerOffset: 0, createdAt }];
    const slices = deriveMessageSlices(nodeId, messageId, content, 0, citations, [], createdAt);
    assert.equal(slices[0]?.sourceRefs.length, 0);
    assert.equal(slices[1]?.sourceRefs[0]?.id, "c-1");
  });
});

describe("validateDerivedSlices (允许空标题的派生切片校验)", () => {
  const nodeId = "node-d";
  const messageId = "msg-d";
  const createdAt = "2026-08-04T00:00:00.000Z";

  it("接受空标题的派生切片（与 validateSliceSchema 的 title 非空硬约束区分）", () => {
    const slices = deriveMessageSlices(nodeId, messageId, "唯一段。", 0, [], [], createdAt);
    assert.equal(slices[0]?.title, "");
    assert.doesNotThrow(() => validateDerivedSlices(slices, nodeId, messageId));
    assert.throws(() => validateSliceSchema(slices, nodeId, messageId), /title must be a non-empty string/);
  });

  it("仍强制稳定 ID、ordinal 严格递增与 content 非空", () => {
    const good = deriveMessageSlices(nodeId, messageId, "一。\n\n二。", 0, [], [{ title: "甲" }, { title: "乙" }], createdAt);
    assert.doesNotThrow(() => validateDerivedSlices(good, nodeId, messageId));
    const badId = [{ ...good[0]!, id: "wrong" }];
    assert.throws(() => validateDerivedSlices(badId, nodeId, messageId), /Slice id must be/);
    const dupOrdinal = [good[0]!, { ...good[1]!, ordinal: 0, id: good[0]!.id }];
    assert.throws(() => validateDerivedSlices(dupOrdinal, nodeId, messageId));
  });
});

describe("ResearchBodyPlan (plan-then-write 任务计划的 record_json 往返)", () => {
  it("bodyPlan 字段可序列化往返，承载逐节进度", () => {
    const task: ResearchTaskRecord = {
      id: "task-1",
      sessionId: "session-1",
      inputMessageId: "in-1",
      outputMessageId: "out-1",
      idempotencyKey: "key-1",
      status: "running",
      retryable: true,
      promptVersion: "research-body-v1",
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
      bodyPlan: {
        sections: [
          { heading: "起", summary: "开端", targetChars: 800, status: "completed", content: "已完成节正文。" },
          { heading: "承", summary: "发展", targetChars: 800, status: "pending" },
        ],
      },
    };
    const roundTripped = JSON.parse(JSON.stringify(task)) as ResearchTaskRecord;
    assert.equal(roundTripped.bodyPlan?.sections.length, 2);
    assert.equal(roundTripped.bodyPlan?.sections[0]?.status, "completed");
    assert.equal(roundTripped.bodyPlan?.sections[0]?.content, "已完成节正文。");
    assert.equal(roundTripped.bodyPlan?.sections[1]?.status, "pending");
    assert.equal(roundTripped.bodyPlan?.sections[1]?.content, undefined);
  });
});
