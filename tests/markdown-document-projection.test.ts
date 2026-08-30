import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MARKDOWN_PROJECTION_CONFIG,
  projectMarkdownSourceRange,
  projectMarkdownDocument,
  resolveMarkdownVisibleRange,
  type MarkdownProjectionNode,
} from "@collector/markdown-projection";

describe("unified Markdown document projection", () => {
  it("projects GFM structures into one sanitized tree with source and visible ranges", () => {
    const source = [
      "# 中文标题",
      "",
      "- [x] **任务**与[链接](https://example.com)",
      "- 转义\\*星号\\*",
      "",
      "> 引用",
      "",
      "| 列一 | 列二 |",
      "| --- | --- |",
      "| 甲 | `code` |",
      "",
      "```ts",
      "const answer = 42;",
      "```",
    ].join("\n");
    const projection = projectMarkdownDocument(source);

    assert.equal(projection.source, source);
    assert.match(projection.visibleText, /中文标题/);
    assert.match(projection.visibleText, /任务与链接/);
    assert.match(projection.visibleText, /转义\*星号\*/);
    assert.match(projection.visibleText, /甲\s+code/);
    assert.match(projection.visibleText, /const answer = 42;/);
    assert.equal(projection.diagnostics.length, 0);
    assert.equal(findElement(projection.root, "a")?.properties?.href, "https://example.com");
    assert.equal(findElement(projection.root, "input")?.properties?.checked, true);
    assert.ok(projection.blocks.length >= 5);
    assert.deepEqual(projection.blocks.map((block) => block.ordinal), projection.blocks.map((_, index) => index));
    for (const block of projection.blocks) {
      assert.equal(block.id, `block:${block.ordinal}`);
      assert.ok(block.sourceRange.start >= 0 && block.sourceRange.end <= source.length);
      assert.ok(block.visibleRange.start >= 0 && block.visibleRange.end <= projection.visibleText.length);
    }
  });

  it("keeps UTF-16 offsets exact across CRLF/LF and exposes normalized visible output", () => {
    const lf = projectMarkdownDocument("## 标题\n第一行\n第二行");
    const crlfSource = "## 标题\r\n第一行\r\n第二行";
    const crlf = projectMarkdownDocument(crlfSource);

    assert.equal(lf.visibleText, crlf.visibleText);
    assert.equal(crlf.blocks[0]?.sourceRange.start, 0);
    assert.equal(crlf.blocks.at(-1)?.sourceRange.end, crlfSource.length);
    const secondLine = findText(crlf.root, "第二行");
    assert.deepEqual(secondLine?.sourceRange, {
      start: crlfSource.indexOf("第二行"),
      end: crlfSource.length,
    });
  });

  it("removes raw HTML and unsafe URLs without executing content", () => {
    delete (globalThis as { __markdownExecuted?: boolean }).__markdownExecuted;
    const source = "安全<script>globalThis.__markdownExecuted=true</script>[危险](javascript:alert(1))";
    const projection = projectMarkdownDocument(source);

    assert.equal((globalThis as { __markdownExecuted?: boolean }).__markdownExecuted, undefined);
    assert.doesNotMatch(projection.visibleText, /<\/?script/i);
    assert.match(projection.visibleText, /安全.*危险/);
    assert.equal(findElement(projection.root, "a")?.properties?.href, undefined);
    assert.deepEqual(projection.diagnostics.map((diagnostic) => diagnostic.code), [
      "raw-html-removed",
      "raw-html-removed",
      "unsafe-url-removed",
    ]);
  });

  it("renders formulas through the shared safe pipeline and diagnoses source fallback", () => {
    const valid = projectMarkdownDocument("行内 $E=mc^2$\n\n$$\n\\frac{1}{2}\n$$");
    assert.equal(findElement(valid.root, "math")?.tagName, "math");
    assert.equal(valid.diagnostics.length, 0);

    const source = "\\frac{1}{";
    const invalid = projectMarkdownDocument(`$$\n${source}\n$$`);
    const fallback = findElementByClass(invalid.root, "math-source-fallback");
    assert.ok(fallback);
    assert.match(invalid.visibleText, /frac/);
    assert.deepEqual(invalid.diagnostics.map((diagnostic) => diagnostic.code), ["math-render-failed"]);
  });

  it("publishes the single GFM, line-break, and safety configuration", () => {
    assert.deepEqual(MARKDOWN_PROJECTION_CONFIG, {
      version: 1,
      dialect: "gfm",
      softBreaks: "line-break",
      rawHtml: "remove",
      mdx: false,
      math: "katex",
      sanitizeSchema: "github-safe-v1",
    });
  });
  it("projects a multiline document at the 20 MiB import boundary", () => {
    const maxBytes = 20 * 1024 * 1024;
    const line = `${"long".repeat(255)}x\n`;
    const source = line.repeat(Math.ceil(maxBytes / line.length)).slice(0, maxBytes);
    const projection = projectMarkdownDocument(source);

    assert.equal(Buffer.byteLength(source, "utf8"), maxBytes);
    assert.equal(projection.source.length, source.length);
    assert.match(projection.visibleText, /^long/);
    assert.equal(projection.diagnostics.some((diagnostic) => diagnostic.code === "parse-failed"), false);
  });

  it("maps formatting, repeated text, tables, code, and zero-width citation annotations without guessing", () => {
    const source = [
      "**重复文本**与重复文本[来源1]",
      "",
      "| 列 | 值 |",
      "| --- | --- |",
      "| A | `code` |",
    ].join("\n");
    const projection = projectMarkdownDocument(source);
    const firstSource = { start: source.indexOf("重复文本"), end: source.indexOf("重复文本") + 4 };
    const secondStart = source.indexOf("重复文本", firstSource.end);
    const first = projectMarkdownSourceRange(projection, firstSource);
    const second = projectMarkdownSourceRange(projection, { start: secondStart, end: secondStart + 4 });

    assert.equal(first?.exact, "重复文本");
    assert.equal(second?.exact, "重复文本");
    assert.notDeepEqual(first?.visibleRange, second?.visibleRange);
    assert.deepEqual(resolveMarkdownVisibleRange(projection, first!.visibleRange, "重复文本")?.sourceRange, firstSource);
    assert.equal(projectMarkdownSourceRange(projection, {
      start: source.indexOf("[来源1]"),
      end: source.indexOf("[来源1]") + "[来源1]".length,
    }), undefined);

    const codeStart = source.indexOf("code");
    const code = projectMarkdownSourceRange(projection, { start: codeStart, end: codeStart + 4 });
    assert.equal(code?.exact, "code");
    assert.deepEqual(resolveMarkdownVisibleRange(projection, code!.visibleRange, "code")?.sourceRange, {
      start: codeStart,
      end: codeStart + 4,
    });
  });
});

function findText(node: MarkdownProjectionNode, value: string): MarkdownProjectionNode | undefined {
  if (node.value === value) return node;
  for (const child of node.children) {
    const found = findText(child, value);
    if (found) return found;
  }
  return undefined;
}

function findElement(node: MarkdownProjectionNode, tagName: string): MarkdownProjectionNode | undefined {
  if (node.tagName === tagName) return node;
  for (const child of node.children) {
    const found = findElement(child, tagName);
    if (found) return found;
  }
  return undefined;
}

function findElementByClass(node: MarkdownProjectionNode, className: string): MarkdownProjectionNode | undefined {
  const classNames = Array.isArray(node.properties?.className) ? node.properties.className : [];
  if (classNames.includes(className)) return node;
  for (const child of node.children) {
    const found = findElementByClass(child, className);
    if (found) return found;
  }
  return undefined;
}
