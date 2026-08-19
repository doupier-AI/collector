import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/styles/global.css"), "utf8");

describe("轮次卡片章节焦点样式", () => {
  it("章节不再拥有焦点轮廓，外层轮次卡片在直接章节焦点时承担光环", () => {
    const sectionRule = css.match(/\.turn-card__section:focus-visible\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(sectionRule).toMatch(/outline:\s*none/);
    expect(sectionRule).not.toMatch(/box-shadow|border-radius/);
    expect(css).toMatch(/\.turn-card:has\(> \.turn-card__section:focus-visible\)\s*\{\s*box-shadow:\s*var\(--ring-focus\)/);
  });
});
