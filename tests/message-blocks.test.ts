import assert from "node:assert/strict";
import test from "node:test";
import { deriveMessageBlocks, messageContentBlockId } from "@collector/capture-contracts";

test("deriveMessageBlocks returns no blocks for empty or blank content", () => {
  assert.deepEqual(deriveMessageBlocks(""), []);
  assert.deepEqual(deriveMessageBlocks("   \n\n  \n"), []);
});

test("deriveMessageBlocks keeps a single paragraph as one block", () => {
  const blocks = deriveMessageBlocks("第一段内容。");
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], { ordinal: 0, text: "第一段内容。", startOffset: 0 });
});

test("deriveMessageBlocks splits paragraphs on blank lines with stable offsets", () => {
  const content = "第一段。\n\n第二段。\n\n\n第三段。";
  const blocks = deriveMessageBlocks(content);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].text, "第一段。");
  assert.equal(blocks[0].startOffset, 0);
  assert.equal(blocks[1].text, "第二段。");
  assert.equal(content.slice(blocks[1].startOffset, blocks[1].startOffset + blocks[1].text.length), "第二段。");
  assert.equal(blocks[2].text, "第三段。");
  assert.equal(content.slice(blocks[2].startOffset, blocks[2].startOffset + blocks[2].text.length), "第三段。");
  assert.deepEqual(blocks.map((block) => block.ordinal), [0, 1, 2]);
});

test("deriveMessageBlocks keeps single newlines inside a block", () => {
  const blocks = deriveMessageBlocks("第一行\n第二行\n\n下一段");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, "第一行\n第二行");
});

test("deriveMessageBlocks trims surrounding whitespace and blank lines", () => {
  const blocks = deriveMessageBlocks("\n\n  第一段。  \n\n");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, "第一段。");
});

test("deriveMessageBlocks normalizes CRLF and CR line endings", () => {
  const lf = deriveMessageBlocks("第一段。\n\n第二段。");
  const crlf = deriveMessageBlocks("第一段。\r\n\r\n第二段。");
  const cr = deriveMessageBlocks("第一段。\r\r第二段。");
  assert.deepEqual(crlf, lf);
  assert.deepEqual(cr, lf);
});

test("deriveMessageBlocks treats whitespace-only lines as separators", () => {
  const blocks = deriveMessageBlocks("第一段。\n  \t \n第二段。");
  assert.equal(blocks.length, 2);
});

test("deriveMessageBlocks handles long content deterministically", () => {
  const paragraph = "长".repeat(5000);
  const content = Array.from({ length: 50 }, () => paragraph).join("\n\n");
  const blocks = deriveMessageBlocks(content);
  assert.equal(blocks.length, 50);
  for (const [index, block] of blocks.entries()) {
    assert.equal(block.ordinal, index);
    assert.equal(block.text, paragraph);
    assert.equal(content.slice(block.startOffset, block.startOffset + block.text.length), paragraph);
  }
});

test("messageContentBlockId derives stable block ids from message id and ordinal", () => {
  assert.equal(messageContentBlockId("msg-1", 0), "msg-1#p0");
  assert.equal(messageContentBlockId("msg-1", 12), "msg-1#p12");
});
