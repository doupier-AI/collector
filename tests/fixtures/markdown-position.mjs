function nthRange(source, exact, occurrence) {
  let cursor = 0;
  let start = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    start = source.indexOf(exact, cursor);
    if (start < 0) throw new Error(`Markdown position fixture is missing occurrence ${occurrence + 1} of ${exact}`);
    cursor = start + exact.length;
  }
  return Object.freeze({ start, end: start + exact.length });
}

const body = [
  "## 跨功能位置回归",
  "",
  "**重复锚点** 与重复锚点保持一致。",
  "",
  "| 能力 | 目标 |",
  "| --- | --- |",
  "| 弱标记 | REST |",
  "",
  "行内代码 `const stable = true` 与公式 $E=mc^2$。",
  "",
  "```ts",
  "const answer = \"位置稳定\";",
  "```",
  "",
  "$$",
  "\\frac{1}{",
  "$$",
  "",
  "### 来源返回",
  "",
  "搜索锚点：跨功能唯一定位词。",
].join("\n");

export const MARKDOWN_POSITION_FIXTURE = Object.freeze({
  trigger: "E2E Markdown 位置跨功能回归",
  body,
  heading: "跨功能位置回归",
  selection: Object.freeze({
    exact: "重复锚点",
    occurrence: 1,
    sourceRange: nthRange(body, "重复锚点", 1),
  }),
  citation: Object.freeze({
    sourceRange: nthRange(body, "重复锚点", 1),
    sourceTitle: "共享位置夹具来源",
    sourceUrl: "https://example.com/markdown-position-fixture",
  }),
  term: Object.freeze({ exact: "REST" }),
  search: Object.freeze({
    exact: "跨功能唯一定位词",
    sourceRange: nthRange(body, "跨功能唯一定位词", 0),
  }),
  chapter: Object.freeze({ title: "来源返回" }),
  formula: Object.freeze({ valid: "E=mc^2", invalid: "\\frac{1}{" }),
});
