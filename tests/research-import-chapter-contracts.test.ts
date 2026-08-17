import assert from "node:assert/strict";
import test from "node:test";
import {
  IMPORT_CHAPTER_MAX_COUNT,
  IMPORT_CHAPTER_PARSE_MAX_INPUT_CHARS,
  IMPORT_CHAPTER_TITLE_MAX_CHARACTERS,
  LONG_TEXT_CHAR_THRESHOLD,
  deriveImportRuleChapters,
  formatImportChapterParseInput,
  importSnapshotNeedsChapterParse,
  validateImportChapterPlan,
  type ResearchContentBlock,
} from "@collector/capture-contracts";

function block(ordinal: number, text: string, anchor: ResearchContentBlock["anchor"]): ResearchContentBlock {
  return { id: `b${ordinal}`, ordinal, text, anchor };
}

function textBlocks(paragraphs: string[]): ResearchContentBlock[] {
  return paragraphs.map((text, ordinal) => block(ordinal, text, { kind: "text", startLine: 1, endLine: 1, exact: text }));
}

function markdownHeadingBlocks(titles: string[]): ResearchContentBlock[] {
  const blocks: ResearchContentBlock[] = [];
  titles.forEach((title, index) => {
    blocks.push(block(index * 2, `## ${title}`, { kind: "markdown", startLine: index * 2 + 1, endLine: index * 2 + 1, blockType: "heading", heading: title, exact: `## ${title}` }));
    blocks.push(block(index * 2 + 1, `第${index + 1}章正文段落。`, { kind: "markdown", startLine: index * 2 + 2, endLine: index * 2 + 2, blockType: "paragraph", heading: title, exact: "正文" }));
  });
  return blocks;
}

test("importSnapshotNeedsChapterParse 以全文总长与长文阈值同源判定", () => {
  assert.equal(importSnapshotNeedsChapterParse([]), false);
  assert.equal(importSnapshotNeedsChapterParse([{ text: "" }]), false);
  assert.equal(importSnapshotNeedsChapterParse([{ text: "x".repeat(LONG_TEXT_CHAR_THRESHOLD) }]), false);
  assert.equal(importSnapshotNeedsChapterParse([{ text: "x".repeat(LONG_TEXT_CHAR_THRESHOLD + 1) }]), true);
  // 阈值按拼接后全文计（块间以 "\n\n" 连接）：两块拼接恰好 2000 不触发、2001 触发。
  assert.equal(importSnapshotNeedsChapterParse([{ text: "a".repeat(1_100) }, { text: "b".repeat(898) }]), false);
  assert.equal(importSnapshotNeedsChapterParse([{ text: "a".repeat(1_100) }, { text: "b".repeat(899) }]), true);
});

test("deriveImportRuleChapters 空快照与无文本返回空数组", () => {
  assert.deepEqual(deriveImportRuleChapters([]), []);
  assert.deepEqual(deriveImportRuleChapters(textBlocks(["", "  "])), []);
});

test("deriveImportRuleChapters 原文标题块成为章节锚点", () => {
  const blocks = markdownHeadingBlocks(["绪论", "方法", "结论"]);
  const chapters = deriveImportRuleChapters(blocks);
  assert.deepEqual(chapters.map((chapter) => chapter.title), ["绪论", "方法", "结论"]);
  assert.deepEqual(chapters.map((chapter) => chapter.blockOrdinal), [0, 2, 4]);
  assert.deepEqual(chapters.map((chapter) => chapter.ordinal), [0, 1, 2]);
});

test("deriveImportRuleChapters 标题过多时均匀抽样且保留首尾", () => {
  const titles = Array.from({ length: IMPORT_CHAPTER_MAX_COUNT * 2 }, (_, index) => `标题${index}`);
  const chapters = deriveImportRuleChapters(markdownHeadingBlocks(titles));
  assert.ok(chapters.length <= IMPORT_CHAPTER_MAX_COUNT);
  assert.equal(chapters[0].title, "标题0");
  assert.equal(chapters[chapters.length - 1].title, `标题${titles.length - 1}`);
  const ordinals = chapters.map((chapter) => chapter.blockOrdinal);
  assert.deepEqual(ordinals, [...ordinals].sort((a, b) => a - b));
});

test("deriveImportRuleChapters 单一标题退化为段落结构首句锚点", () => {
  const textAnchor = (ordinal: number) => ({ kind: "text" as const, startLine: ordinal + 1, endLine: ordinal + 1, exact: `第${ordinal}段` });
  const blocks: ResearchContentBlock[] = [
    block(0, "## 唯一标题", { kind: "markdown", startLine: 1, endLine: 1, blockType: "heading", heading: "唯一标题", exact: "## 唯一标题" }),
    block(1, `第一段开头句。${"这是第一段足够长的正文。".repeat(120)}`, textAnchor(1)),
    block(2, `第二段开头句。${"这是第二段足够长的正文。".repeat(120)}`, textAnchor(2)),
  ];
  const chapters = deriveImportRuleChapters(blocks);
  assert.ok(chapters.length >= 2);
  assert.equal(chapters[0].blockOrdinal, 0);
  assert.equal(chapters[0].title, "唯一标题");
  assert.match(chapters[1].title, /第一段开头句|第二段开头句/);
});

test("deriveImportRuleChapters 无标题段落按结构均分、首句为标题、块序严格递增", () => {
  const paragraphs = Array.from({ length: 12 }, (_, index) => `第${index + 1}段开头句。这是第${index + 1}段的其余内容，${"扩展".repeat(200)}`);
  const chapters = deriveImportRuleChapters(textBlocks(paragraphs));
  assert.ok(chapters.length >= 2);
  assert.ok(chapters.length <= 8);
  assert.equal(chapters[0].blockOrdinal, 0);
  const ordinals = chapters.map((chapter) => chapter.blockOrdinal);
  assert.deepEqual(ordinals, [...ordinals].sort((a, b) => a - b));
  assert.ok(new Set(ordinals).size === ordinals.length);
  for (const chapter of chapters) {
    assert.ok(chapter.title.length >= 1 && chapter.title.length <= IMPORT_CHAPTER_TITLE_MAX_CHARACTERS + 1);
    assert.match(paragraphs[chapter.blockOrdinal], /^第\d+段开头句/);
  }
});

test("deriveImportRuleChapters 标题与首句收口到长度上限", () => {
  const longTitle = "超".repeat(IMPORT_CHAPTER_TITLE_MAX_CHARACTERS + 30);
  const chapters = deriveImportRuleChapters(markdownHeadingBlocks([longTitle, "短标题"]));
  assert.ok(chapters[0].title.length <= IMPORT_CHAPTER_TITLE_MAX_CHARACTERS);
  assert.ok(chapters[0].title.endsWith("…"));
});

test("formatImportChapterParseInput 按块编号并在块边界截断", () => {
  const blocks = textBlocks(["第一块。", "第二块。", "第三块。"]);
  const { content, blockCount } = formatImportChapterParseInput(blocks);
  assert.equal(blockCount, 3);
  assert.match(content, /^\[B0\] 第一块。/);
  assert.match(content, /\[B2\] 第三块。/);

  const maxChars = 12;
  const truncated = formatImportChapterParseInput(textBlocks(["一二三四五六七八九十", "十一十二"]), maxChars);
  assert.ok(truncated.content.length <= maxChars + 2);
  assert.equal(truncated.blockCount, 1);
});

test("validateImportChapterPlan 接受合法输出并收口标题", () => {
  const valid = validateImportChapterPlan(JSON.stringify({ chapters: [{ block: 0, title: "开篇" }, { block: 3, title: `  ${"很长的标题".repeat(20)} ` }] }), 10);
  assert.ok(valid);
  assert.equal(valid.length, 2);
  assert.deepEqual(valid.map((chapter) => chapter.blockOrdinal), [0, 3]);
  assert.equal(valid[0].title, "开篇");
  assert.ok(valid[1].title.length <= IMPORT_CHAPTER_TITLE_MAX_CHARACTERS);
});

test("validateImportChapterPlan 拒绝不合契约输出", () => {
  const cases: Array<{ raw: string; blockCount: number }> = [
    { raw: "not json", blockCount: 10 },
    { raw: JSON.stringify({}), blockCount: 10 },
    { raw: JSON.stringify({ chapters: [] }), blockCount: 10 },
    { raw: JSON.stringify({ chapters: [{ block: 0, title: "标题" }, { block: 0, title: "重复" }] }), blockCount: 10 },
    { raw: JSON.stringify({ chapters: [{ block: 2, title: "标题" }, { block: 1, title: "倒序" }] }), blockCount: 10 },
    { raw: JSON.stringify({ chapters: [{ block: 10, title: "越界" }] }), blockCount: 10 },
    { raw: JSON.stringify({ chapters: [{ block: 0, title: "" }] }), blockCount: 10 },
    { raw: JSON.stringify({ chapters: [{ block: 0, title: 42 }] }), blockCount: 10 },
    { raw: JSON.stringify({ chapters: [{ block: 0.5, title: "非整数" }] }), blockCount: 10 },
    { raw: JSON.stringify({ chapters: [{ block: -1, title: "负数" }] }), blockCount: 10 },
    { raw: JSON.stringify({ chapters: Array.from({ length: IMPORT_CHAPTER_MAX_COUNT + 1 }, (_, index) => ({ block: index, title: `标题${index}` })) }), blockCount: IMPORT_CHAPTER_MAX_COUNT + 1 },
  ];
  for (const item of cases) {
    assert.equal(validateImportChapterPlan(item.raw, item.blockCount), null, `应拒绝：${item.raw.slice(0, 60)}`);
  }
});
