import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveMessageSlices, validateDerivedSlices, deriveMessageBlocks, composeSectionUnits, deriveFragmentsFromSlices, resolveFragmentExcerpt, type ResearchSliceRecord, type ResearchTaskRecord } from "@collector/capture-contracts";

describe("deriveMessageSlices (生成自由化后的确定性派生切片)", () => {
  const nodeId = "node-d";
  const messageId = "msg-d";
  const createdAt = "2026-08-04T00:00:00.000Z";
  const content = "第一节完整论述，可跨多句。\n\n第二节继续展开。\n\n第三节收束。";

  it("按空行段落逐块派生切片，isProvisional 恒为 false，切片不携带正文副本（#43）", () => {
    const slices = deriveMessageSlices(nodeId, messageId, content, 0, [], [], createdAt);
    assert.equal(slices.length, 3);
    // #43 收缩：切片不再保存 content 字段，正文唯一事实源是消息正文与正文版本。
    assert.ok(slices.every((s) => !("content" in s)));
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

describe("composeSectionUnits (节级组合：标题块并入正文，正文逐字保留)", () => {
  it("无标题正文保持一段一节的现状粒度", () => {
    const units = composeSectionUnits(deriveMessageBlocks("甲段落。\n\n乙段落。\n\n丙段落。"));
    assert.equal(units.length, 3);
    assert.deepEqual(units.map((u) => u.title), ["", "", ""]);
    assert.deepEqual(units.map((u) => u.content), ["甲段落。", "乙段落。", "丙段落。"]);
  });

  it("标题块并入随后正文，content 逐字等于原始正文片段（含标题行）", () => {
    const content = "## 背景与起源\n\n第一段正文。\n\n第二段正文。";
    const units = composeSectionUnits(deriveMessageBlocks(content));
    assert.equal(units.length, 1);
    assert.equal(units[0]?.title, "背景与起源");
    assert.equal(units[0]?.content, content);
    assert.equal(units[0]?.blockCount, 3);
  });

  it("连续标题各自开新节，后一个标题收束前一节", () => {
    const content = "## 总标题\n\n## 第一节\n\n第一节正文。\n\n## 第二节\n\n第二节正文。";
    const units = composeSectionUnits(deriveMessageBlocks(content));
    assert.deepEqual(units.map((u) => u.title), ["总标题", "第一节", "第二节"]);
    assert.equal(units[1]?.content, "## 第一节\n\n第一节正文。");
  });

  it("整段加粗短行识别为标题并并入正文", () => {
    const content = "**自注意力机制的核心思想**\n\n自注意力机制是灵魂所在。";
    const units = composeSectionUnits(deriveMessageBlocks(content));
    assert.equal(units.length, 1);
    assert.equal(units[0]?.title, "自注意力机制的核心思想");
    assert.equal(units[0]?.content, content);
  });

  it("同块内标题+正文（无空行）整块成节、逐字保留", () => {
    const content = "## 节标题\n正文紧跟标题同一行块。";
    const units = composeSectionUnits(deriveMessageBlocks(content));
    assert.equal(units.length, 1);
    assert.equal(units[0]?.title, "节标题");
    assert.equal(units[0]?.content, content);
  });

  it("正文里的加粗句（非整段短行）不误判为标题", () => {
    const content = "这是一段包含 **强调** 的普通正文，长度足够长不会被当作标题处理。";
    const units = composeSectionUnits(deriveMessageBlocks(content));
    assert.equal(units.length, 1);
    assert.equal(units[0]?.title, "");
    assert.equal(units[0]?.content, content);
  });
});

describe("deriveMessageSlices 节级派生（标题并入正文）", () => {
  const nodeId = "node-s";
  const messageId = "msg-s";
  const createdAt = "2026-08-05T00:00:00.000Z";

  it("标题不再自成切片，节标题提升为 title；正文经派生层逐字保留", () => {
    const content = "## Transformer架构详解\n\n## 背景与起源\n\n背景正文一。\n\n背景正文二。";
    const slices = deriveMessageSlices(nodeId, messageId, content, 0, [], [], createdAt);
    assert.equal(slices.length, 2);
    assert.equal(slices[0]?.title, "Transformer架构详解");
    assert.equal(slices[1]?.title, "背景与起源");
    // #43：切片不再保存正文副本；拼接不变量移到派生层（composeSectionUnits）。
    const units = composeSectionUnits(deriveMessageBlocks(content));
    assert.equal(units[0]?.content, "## Transformer架构详解");
    assert.equal(units[1]?.content, "## 背景与起源\n\n背景正文一。\n\n背景正文二。");
    assert.equal(units.map((u) => u.content).join("\n\n"), content);
  });

  it("节标题优先于抽取标题；概念取自节起始块标注", () => {
    // "## 已定标题" 开启一个节，其后所有正文（含无标题段落）都属该节，直到下一个标题。
    const content = "## 已定标题\n\n该节正文。\n\n无标题段落。";
    const blocks = deriveMessageBlocks(content);
    const annotations: ({ title: string; concepts: string[] } | undefined)[] = blocks.map(() => undefined);
    annotations[0] = { title: "被忽略的抽取标题", concepts: ["概念A"] };
    const slices = deriveMessageSlices(nodeId, messageId, content, 0, [], annotations, createdAt);
    assert.equal(slices.length, 1);
    assert.equal(slices[0]?.title, "已定标题");
    assert.deepEqual(slices[0]?.normalizedConcepts, ["概念A"]);
  });

  it("无标题段落用抽取标题补题（不与正文重复）", () => {
    const content = "第一段无标题。\n\n第二段无标题。";
    const blocks = deriveMessageBlocks(content);
    const annotations: ({ title: string; concepts: string[] } | undefined)[] = blocks.map(() => undefined);
    annotations[1] = { title: "补上的标题", concepts: [] };
    const slices = deriveMessageSlices(nodeId, messageId, content, 0, [], annotations, createdAt);
    assert.equal(slices.length, 2);
    assert.equal(slices[0]?.title, "");
    assert.equal(slices[1]?.title, "补上的标题");
  });

  it("引用按节覆盖的块范围聚合", () => {
    const content = "## 节\n\n第一段。\n\n第二段。";
    const citations = [
      { id: "c-1", messageId, runId: "r", sourceId: "s", blockOrdinal: 1, markerOffset: 0, createdAt },
      { id: "c-2", messageId, runId: "r", sourceId: "s", blockOrdinal: 2, markerOffset: 0, createdAt },
    ];
    const slices = deriveMessageSlices(nodeId, messageId, content, 0, citations, [], createdAt);
    assert.equal(slices.length, 1);
    assert.deepEqual(slices[0]?.sourceRefs.map((c) => c.id), ["c-1", "c-2"]);
  });

  it("派生结果通过 validateDerivedSlices", () => {
    const content = "## 标题\n\n正文一。\n\n正文二。\n\n无标题段。";
    const slices = deriveMessageSlices(nodeId, messageId, content, 0, [], [], createdAt);
    assert.doesNotThrow(() => validateDerivedSlices(slices, nodeId, messageId));
  });
});

describe("deriveFragmentsFromSlices 节级片段", () => {
  const createdAt = "2026-08-05T00:00:00.000Z";
  it("结构对齐门下片段范围映射到节起始块到末块，摘录经正文版本回读逐字对应", () => {
    // 两个标题节 + 中间无标题段属前一节：验证多节片段范围互不重叠且铺满正文。
    const content = "## 第一节\n\n第一节正文。\n\n续段。\n\n## 第二节\n\n第二节正文。";
    const slices = deriveMessageSlices("n", "m", content, 0, [], [], createdAt);
    const version = { id: "body:m:x", messageId: "m", nodeId: "n", version: 1, content, contentHash: "x", origin: "generation" as const, createdAt };
    const fragments = deriveFragmentsFromSlices(version, slices, []);
    assert.equal(fragments.length, 2);
    // #43：切片不携带正文副本，摘录一律经 resolveFragmentExcerpt 从正文版本范围回读。
    const units = composeSectionUnits(deriveMessageBlocks(content));
    for (const f of fragments) {
      assert.equal(resolveFragmentExcerpt(version, f), units[f.ordinal]?.content);
      assert.equal(f.isProvisional, false);
    }
    // 节片段首尾相接铺满正文（前一节 end 到后一节 start 只差节间 "\n\n"）。
    assert.equal(fragments[1]!.startOffset - fragments[0]!.endOffset, 2);
  });

  it("对齐门失败（数量不一致）时退化为按块派生的临时片段，绝不伪造范围", () => {
    const content = "一。\n\n二。\n\n三。";
    // 派生切片 3 个，但手工构造 2 个切片（与节单元数量不一致）→ 结构对齐门失败。
    const twoSlices: ResearchSliceRecord[] = [
      { id: "slice:n:m:0", nodeId: "n", messageId: "m", ordinal: 0, title: "", normalizedConcepts: [], sourceRefs: [], isProvisional: false, createdAt },
      { id: "slice:n:m:1", nodeId: "n", messageId: "m", ordinal: 1, title: "", normalizedConcepts: [], sourceRefs: [], isProvisional: false, createdAt },
    ];
    const version = { id: "body:m:x", messageId: "m", nodeId: "n", version: 1, content, contentHash: "x", origin: "generation" as const, createdAt };
    const fragments = deriveFragmentsFromSlices(version, twoSlices, []);
    assert.equal(fragments.length, 3);
    assert.ok(fragments.every((f) => f.isProvisional === true));
  });
});

describe("validateDerivedSlices (允许空标题的派生切片校验)", () => {
  const nodeId = "node-d";
  const messageId = "msg-d";
  const createdAt = "2026-08-04T00:00:00.000Z";

  it("接受空标题的派生切片", () => {
    const slices = deriveMessageSlices(nodeId, messageId, "唯一段。", 0, [], [], createdAt);
    assert.equal(slices[0]?.title, "");
    assert.doesNotThrow(() => validateDerivedSlices(slices, nodeId, messageId));
  });

  it("仍强制稳定 ID 与 ordinal 严格递增", () => {
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
