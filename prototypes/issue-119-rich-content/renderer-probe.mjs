/**
 * PROTOTYPE — throwaway evidence for GitHub Issue #119. Do not ship.
 *
 * Question: what does Collector's current Markdown stack already render, and
 * which rich-content claims are still unsupported by an explicit contract?
 *
 * Run from the repository root:
 *   node .worktrees/issue-119/prototypes/issue-119-rich-content/renderer-probe.mjs
 */

import assert from "node:assert/strict";
import { deriveMessageBlocks } from "@collector/capture-contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const markdown = `# 自然标题

- 列表项

| 能力 | 状态 |
| --- | --- |
| 表格 | 可渲染 |

\`\`\`ts
const answer = 42;
\`\`\`

公式仍是字面文本：$E=mc^2$。

![有意义的替代文本](https://images.example/research.png)

![危险图片](javascript:alert(1))

![内嵌数据图片](data:image/svg+xml;base64,PHN2Zy8+)

<script>alert("raw html")</script>
`;

function renderMarkdown(source) {
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    children: source,
    remarkPlugins: [remarkGfm, remarkBreaks],
    rehypePlugins: [rehypeSanitize],
  }));
}

const html = renderMarkdown(markdown);
const crossBlankCode = `\`\`\`ts
const first = 1;

const second = 2;
\`\`\``;
const looseList = `- 第一项

  第一项的续段

- 第二项`;
const codeBlocks = deriveMessageBlocks(crossBlankCode);
const listBlocks = deriveMessageBlocks(looseList);
const wholeCodeHtml = renderMarkdown(crossBlankCode);
const splitCodeHtml = codeBlocks.map((block) => renderMarkdown(block.text)).join("");
const wholeListHtml = renderMarkdown(looseList);
const splitListHtml = listBlocks.map((block) => renderMarkdown(block.text)).join("");

const checks = {
  heading: html.includes("<h1>自然标题</h1>"),
  list: html.includes("<li>列表项</li>"),
  table: html.includes("<table>"),
  fencedCode: html.includes('class="language-ts"') && html.includes("const answer = 42;"),
  formulaIsUnrenderedText: html.includes("$E=mc^2$"),
  rendererEmitsRemoteHttpsImageRequest: html.includes('src="https://images.example/research.png"') && html.includes('alt="有意义的替代文本"'),
  javascriptImageBlocked: !html.includes("javascript:"),
  dataImageBlocked: !html.includes("data:image"),
  rawScriptBlocked: !html.includes("<script"),
  fullDocumentCodeFenceWorks: wholeCodeHtml.includes("const first = 1;") && wholeCodeHtml.includes("const second = 2;"),
  currentBlockPipelineChangesCrossBlankCode: codeBlocks.length === 2 && splitCodeHtml !== wholeCodeHtml,
  currentBlockPipelineChangesLooseList: listBlocks.length === 3 && splitListHtml !== wholeListHtml,
};

for (const [name, passed] of Object.entries(checks)) {
  assert.equal(passed, true, `${name} failed\n${html}`);
}

console.log(JSON.stringify({
  question: "What does the current Markdown stack prove without adding product behavior?",
  verdict: {
    alreadyRendered: ["headings", "lists", "GFM tables", "fenced code"],
    securityObserved: ["javascript image URL blocked", "data image URL blocked", "raw script blocked"],
    gaps: [
      "formula syntax remains literal text",
      "the renderer emits a direct HTTPS image request",
      "the production block-by-block pipeline changes Markdown constructs that cross blank lines",
      "no provenance, cache, expiry, export, or alt-quality contract is established",
    ],
  },
  limitation: "This component probe does not simulate HTTP headers; Collector's production CSP currently blocks non-self image origins.",
  checks,
  blockPipelineEvidence: {
    crossBlankCode: { blockCount: codeBlocks.length, wholeCodeHtml, splitCodeHtml },
    looseList: { blockCount: listBlocks.length, wholeListHtml, splitListHtml },
  },
  renderedHtml: html,
}, null, 2));
