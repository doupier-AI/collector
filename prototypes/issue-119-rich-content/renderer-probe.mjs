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

const html = renderToStaticMarkup(createElement(ReactMarkdown, {
  children: markdown,
  remarkPlugins: [remarkGfm, remarkBreaks],
  rehypePlugins: [rehypeSanitize],
}));

const checks = {
  heading: html.includes("<h1>自然标题</h1>"),
  list: html.includes("<li>列表项</li>"),
  table: html.includes("<table>"),
  fencedCode: html.includes('class="language-ts"') && html.includes("const answer = 42;"),
  formulaIsUnrenderedText: html.includes("$E=mc^2$"),
  remoteHttpsImageLoadsDirectly: html.includes('src="https://images.example/research.png"') && html.includes('alt="有意义的替代文本"'),
  javascriptImageBlocked: !html.includes("javascript:"),
  dataImageBlocked: !html.includes("data:image"),
  rawScriptBlocked: !html.includes("<script"),
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
      "HTTPS images are loaded directly from their remote origin",
      "no provenance, cache, expiry, export, or alt-quality contract is established",
    ],
  },
  checks,
  renderedHtml: html,
}, null, 2));
