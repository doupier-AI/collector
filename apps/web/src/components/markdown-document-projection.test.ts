import { describe, expect, it } from "vitest";
import { projectMarkdownDocument } from "@collector/markdown-projection";

describe("Markdown document projection in the browser bundle", () => {
  it("uses the same UTF-16 source and visible ranges as Node", () => {
    const source = "## 中文\r\n\r\n- [x] 任务\r\n- `code`";
    const projection = projectMarkdownDocument(source);

    expect(projection.visibleText).toContain("中文");
    expect(projection.visibleText).toContain("任务");
    expect(projection.visibleText).toContain("code");
    expect(projection.blocks[0]?.sourceRange.start).toBe(0);
    expect(projection.blocks.at(-1)?.sourceRange.end).toBe(source.length);
    expect(projection.diagnostics).toEqual([]);
  });
});
