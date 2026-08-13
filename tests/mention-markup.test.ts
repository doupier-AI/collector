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
  assert.deepEqual(stream.push("cept:反向传播"), {
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
    "[[concept:机会成本]]、[[entity:欧盟]]、[[abbreviation:RAG]] 和 ",
    "[[notation:O(n log n)]] 都可能需要解释。再次提到 [[abbreviation:RAG]]。",
  ].join(""));
  const result = stream.finish();

  assert.deepEqual(result.markers.map((marker) => marker.category), [
    "concept", "entity", "abbreviation", "notation", "abbreviation",
  ]);
  assert.equal(result.markers[2]?.entityId, result.markers[4]?.entityId);
  assert.notEqual(result.markers[2]?.mentionId, result.markers[4]?.mentionId);
});

test("格式错误只丢弃提及，保留可读正文且永不保存控制符", () => {
  const stream = new MentionMarkupStream({ messageId: "message-3", nodeDepth: 0 });
  stream.push("前文 [[unknown:仍应保留]]，以及未闭合的 [[concept:正文尾部");
  const result = stream.finish();

  assert.equal(result.content, "前文 仍应保留，以及未闭合的 正文尾部");
  assert.deepEqual(result.markers, []);
  assert.ok(!result.content.includes("[["));
  assert.ok(!result.content.includes("]]"));
});

test("深度二至三只接收少量核心提及，深度四停止新增提及但保留正文", () => {
  const marked = Array.from({ length: 7 }, (_, index) => `[[concept:概念${index + 1}]]`).join("、");
  const reduced = new MentionMarkupStream({ messageId: "message-4", nodeDepth: 2 });
  reduced.push(marked);
  assert.equal(reduced.finish().markers.length, 4);

  const stopped = new MentionMarkupStream({ messageId: "message-5", nodeDepth: 4 });
  stopped.push(marked);
  const result = stopped.finish();
  assert.equal(result.content, "概念1、概念2、概念3、概念4、概念5、概念6、概念7");
  assert.deepEqual(result.markers, []);
});
