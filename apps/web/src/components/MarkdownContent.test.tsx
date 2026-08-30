import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./MarkdownContent";

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

  it("keeps malformed formula source visible and copyable", () => {
    const source = "\\frac{1}{";
    const { container } = render(<MarkdownContent text={`$$\n${source}\n$$`} />);

    const fallback = container.querySelector(".math-source-fallback");
    expect(fallback).not.toBeNull();
    expect(fallback).toHaveTextContent(source);
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
