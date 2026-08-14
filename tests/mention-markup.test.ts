import assert from "node:assert/strict";
import test from "node:test";
import { MentionMarkupStream } from "@collector/capture-contracts";

test("流内提及在控制短语闭合前不泄露控制符，闭合后立即产生干净正文与范围", () => {
  const stream = new MentionMarkupStream({ messageId: "message-1", nodeDepth: 0 });

  assert.deepEqual(stream.push("理解[[con"), {
    content: "理解",
    delta: "理解",
    markers: [],
  });
  assert.deepEqual(stream.push("cept:backprop:反向传播"), {
    content: "理解",
    delta: "",
    markers: [],
  });

  const closed = stream.push("]]有助于学习。");
  assert.equal(closed.content, "理解反向传播有助于学习。");
  assert.equal(closed.delta, "反向传播有助于学习。");
  assert.deepEqual(closed.markers.map(({ text, blockOrdinal, startOffset, endOffset, category }) => ({
    text, blockOrdinal, startOffset, endOffset, category,
  })), [{ text: "反向传播", blockOrdinal: 0, startOffset: 2, endOffset: 6, category: "concept" }]);
  assert.ok(!closed.content.includes("[["));
  assert.ok(!closed.content.includes("]]"));
});

test("四类可解释对象使用稳定分类，同一消息内同一对象的多个提及共享实体身份", () => {
  const stream = new MentionMarkupStream({ messageId: "message-2", nodeDepth: 0 });
  stream.push([
    "[[concept:opportunity-cost:机会成本]]、[[entity:eu:欧盟]]、[[abbreviation:rag:RAG]] 和 ",
    "[[notation:big-o:O(n log n)]] 都可能需要解释。再次提到 [[abbreviation:rag:RAG]]。",
  ].join(""));
  const result = stream.finish();

  assert.deepEqual(result.markers.map((marker) => marker.category), [
    "concept", "entity", "abbreviation", "notation", "abbreviation",
  ]);
  assert.equal(result.markers[2]?.entityId, result.markers[4]?.entityId);
  assert.notEqual(result.markers[2]?.mentionId, result.markers[4]?.mentionId);
});

test("回答内身份而不是类别与文字决定实体：同名异义分离，别名可以共享", () => {
  const stream = new MentionMarkupStream({ messageId: "message-identity", nodeDepth: 0 });
  stream.push([
    "[[entity:apple-company:苹果]]发布了产品，",
    "[[entity:apple-fruit:苹果]]富含膳食纤维；",
    "[[entity:apple-company:Apple Inc.]]仍指前一家公司。",
  ].join(""));
  const result = stream.finish();

  assert.notEqual(result.markers[0]?.entityId, result.markers[1]?.entityId);
  assert.equal(result.markers[0]?.entityId, result.markers[2]?.entityId);
  assert.notEqual(result.markers[0]?.mentionId, result.markers[2]?.mentionId);
});

test("回答内身份由消息作用域隔离，不能跨回答继承", () => {
  const first = new MentionMarkupStream({ messageId: "answer-a", nodeDepth: 0 });
  const second = new MentionMarkupStream({ messageId: "answer-b", nodeDepth: 0 });
  first.push("[[abbreviation:rag:RAG]]");
  second.push("[[abbreviation:rag:RAG]]");

  assert.notEqual(first.finish().markers[0]?.entityId, second.finish().markers[0]?.entityId);
});

test("三段式控制串可在任意流片段边界拆分并得到相同结果", () => {
  const raw = "前[[concept:backprop:反向传播]]后[[abbreviation:rag:RAG]]。";
  const expected = new MentionMarkupStream({ messageId: "split-answer", nodeDepth: 0 });
  expected.push(raw);
  const expectedResult = expected.finish();

  for (let split = 0; split <= raw.length; split += 1) {
    const stream = new MentionMarkupStream({ messageId: "split-answer", nodeDepth: 0 });
    stream.push(raw.slice(0, split));
    stream.push(raw.slice(split));
    assert.deepEqual(stream.finish(), expectedResult, `split=${split}`);
  }

  const characterStream = new MentionMarkupStream({ messageId: "split-answer", nodeDepth: 0 });
  for (const character of raw) characterStream.push(character);
  assert.deepEqual(characterStream.finish(), expectedResult, "character-by-character stream");
});

test("格式错误只丢弃提及，保留可读正文且永不保存控制符", () => {
  const stream = new MentionMarkupStream({ messageId: "message-3", nodeDepth: 0 });
  stream.push("前文 [[unknown:x:仍应保留]]、[[concept:bad id:身份错误]]、[[concept:旧格式正文]]，以及未闭合的 [[concept:tail:正文尾部");
  const result = stream.finish();

  assert.equal(result.content, "前文 仍应保留、身份错误、旧格式正文，以及未闭合的 正文尾部");
  assert.deepEqual(result.markers, []);
  assert.ok(!result.content.includes("[["));
  assert.ok(!result.content.includes("]]"));
});

test("深度二至三只接收少量核心提及，深度四停止新增提及但保留正文", () => {
  const marked = Array.from({ length: 7 }, (_, index) => `[[concept:item-${index + 1}:概念${index + 1}]]`).join("、");
  const reduced = new MentionMarkupStream({ messageId: "message-4", nodeDepth: 2 });
  reduced.push(marked);
  assert.equal(reduced.finish().markers.length, 4);

  const reducedAtThree = new MentionMarkupStream({ messageId: "message-4b", nodeDepth: 3 });
  reducedAtThree.push(marked);
  assert.equal(reducedAtThree.finish().markers.length, 4);

  const stopped = new MentionMarkupStream({ messageId: "message-5", nodeDepth: 4 });
  stopped.push(marked);
  const result = stopped.finish();
  assert.equal(result.content, "概念1、概念2、概念3、概念4、概念5、概念6、概念7");
  assert.deepEqual(result.markers, []);
});

test("清洗器把原始输出范围映射到同一段干净正文，控制字段内端点诚实拒绝", () => {
  const raw = "前文 [[concept:local-first:本地优先]] 之后是联网结论。";
  const stream = new MentionMarkupStream({ messageId: "citation-answer", nodeDepth: 0 });
  stream.push(raw);
  const result = stream.finish();

  const rawConclusionStart = raw.indexOf("联网结论");
  const cleanConclusionStart = result.content.indexOf("联网结论");
  assert.deepEqual(
    stream.mapRawRange(rawConclusionStart, rawConclusionStart + "联网结论".length),
    { startOffset: cleanConclusionStart, endOffset: cleanConclusionStart + "联网结论".length },
  );

  const hiddenIdentityStart = raw.indexOf("local-first");
  assert.equal(stream.mapRawRange(hiddenIdentityStart, hiddenIdentityStart + 5), undefined);
});
