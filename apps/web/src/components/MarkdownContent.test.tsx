import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./MarkdownContent";
import { projectMarkdownVisibleText } from "./markdown-projection";

describe("MarkdownContent formula and safety rendering", () => {
  it("renders accessible inline and block formulas while preserving tables and code", () => {
    const { container } = render(<MarkdownContent text={[
      "行内公式 $E = mc^2$。",
      "",
      "$$",
      "\\int_0^1 x^2 \\, dx",
      "$$",
      "",
      "| 列 | 值 |",
      "| --- | --- |",
      "| 代码 | `const x = 1` |",
    ].join("\n")} />);

    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    expect(container.querySelectorAll("math")).toHaveLength(2);
    expect(container.querySelectorAll('.katex-html[aria-hidden="true"]')).toHaveLength(2);
    expect(container.querySelector(".katex-display")).not.toBeNull();
    expect(container.querySelector("table")).not.toBeNull();
    expect(screen.getByText("const x = 1")).toBeInTheDocument();
  });

  it("keeps the rendered answer text on the shared projection for mixed Markdown", () => {
    const source = [
      "## 结论",
      "",
      "第一行  ",
      "第二行含 $E = mc^2$。",
      "",
      "- 列表",
      "",
      "| 列 | 值 |",
      "| --- | --- |",
      "| A | `code` |",
    ].join("\n");
    const { container } = render(<MarkdownContent text={source} />);

    expect(container.querySelector(".markdown-content")?.textContent).toBe(projectMarkdownVisibleText(source).text);
    expect(container.querySelector("h2")?.textContent).toBe("结论");
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("code");
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  it("keeps malformed formula source visible and copyable", () => {
    const source = "\\frac{1}{";
    const { container } = render(<MarkdownContent text={`$$\n${source}\n$$`} />);

    const fallback = container.querySelector(".math-source-fallback");
    expect(fallback).not.toBeNull();
    expect(fallback).toHaveTextContent(source);
  });

  it("maps a repeated weak marker from its source range instead of guessing the first visible match", () => {
    const source = "**REST** 与 REST";
    const secondStart = source.lastIndexOf("REST");
    const { container } = render(<MarkdownContent text={source} terms={[{
      text: "REST",
      blockOrdinal: 0,
      startOffset: secondStart,
      endOffset: secondStart + 4,
      category: "abbreviation",
    }]} />);

    expect(container.querySelector("strong [data-term-marker]")).toBeNull();
    expect(container.querySelectorAll("[data-term-marker]")).toHaveLength(1);
  });

  it("inserts sidecar citations by stable range across repeated text, code, and tables without changing copied text", () => {
    const source = [
      "重复结论与重复结论。",
      "",
      "代码：`const cited = true`",
      "",
      "| 结论 | 依据 |",
      "| --- | --- |",
      "| 稳定 | 可复核 |",
    ].join("\n");
    const repeatedStart = source.lastIndexOf("重复结论");
    const codeStart = source.indexOf("const cited = true");
    const tableStart = source.lastIndexOf("稳定");
    const sources = [
      { id: "source-1", runId: "run", ordinal: 1, title: "重复文字来源", url: "https://example.test/repeated", createdAt: "2026-08-31T00:00:00.000Z" },
      { id: "source-2", runId: "run", ordinal: 2, title: "代码来源", url: "https://example.test/code", createdAt: "2026-08-31T00:00:00.000Z" },
      { id: "source-3", runId: "run", ordinal: 3, title: "表格来源", url: "https://example.test/table", createdAt: "2026-08-31T00:00:00.000Z" },
    ];
    const citations = [
      { id: "citation-1", messageId: "message", runId: "run", sourceId: "source-1", blockOrdinal: 0, markerOffset: 0, renderedStartOffset: repeatedStart, renderedEndOffset: repeatedStart + 4, createdAt: "2026-08-31T00:00:00.000Z" },
      { id: "citation-2", messageId: "message", runId: "run", sourceId: "source-2", blockOrdinal: 1, markerOffset: 0, renderedStartOffset: codeStart, renderedEndOffset: codeStart + "const cited = true".length, createdAt: "2026-08-31T00:00:00.000Z" },
      { id: "citation-3", messageId: "message", runId: "run", sourceId: "source-3", blockOrdinal: 2, markerOffset: 0, renderedStartOffset: tableStart, renderedEndOffset: tableStart + 2, createdAt: "2026-08-31T00:00:00.000Z" },
    ];
    const { container } = render(<MarkdownContent text={source} sources={sources} citations={citations} />);

    const repeated = screen.getByLabelText("打开来源 1：重复文字来源");
    const code = screen.getByText("const cited = true", { selector: "code" });
    const codeCitation = screen.getByLabelText("打开来源 2：代码来源");
    const tableCitation = screen.getByLabelText("打开来源 3：表格来源");
    expect(repeated.closest("strong")).toBeNull();
    expect(codeCitation.previousElementSibling).toBe(code);
    expect(tableCitation.closest("td")).not.toBeNull();
    expect(container.querySelector(".markdown-content")?.textContent).toBe(projectMarkdownVisibleText(source).text);
  });

  it("does not execute HTML or create script, SVG, data-image, remote-image, or formula links", () => {
    delete (globalThis as { __markdownExecuted?: boolean }).__markdownExecuted;
    const { container } = render(<MarkdownContent text={[
      "<script>globalThis.__markdownExecuted=true</script>",
      "<svg><script>globalThis.__markdownExecuted=true</script></svg>",
      "![data image](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSkgLz4=)",
      "![remote image](https://example.com/tracker.png)",
      "$\\href{javascript:alert(1)}{危险链接}$",
    ].join("\n\n")} />);

    expect((globalThis as { __markdownExecuted?: boolean }).__markdownExecuted).toBeUndefined();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText("[图片：data image]")).toBeInTheDocument();
    expect(screen.getByText("[图片：remote image]")).toBeInTheDocument();
  });

  it("renders a very long plain-text document without dropping content", () => {
    const source = `开头${"很长的正文".repeat(20_000)}结尾`;
    const { container } = render(<MarkdownContent text={source} />);
    expect(container.textContent?.startsWith("开头")).toBe(true);
    expect(container.textContent?.endsWith("结尾")).toBe(true);
    expect(container.textContent?.length).toBe(source.length);
  });
});
