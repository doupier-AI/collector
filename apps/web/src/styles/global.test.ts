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

describe("研究图谱视觉参数", () => {
  it("关系状态和普通标题都从用户视觉变量派生", () => {
    for (const selector of ["global-map__edge--fused-from", "global-map__edge--emphasized", "global-map__edge--connected"]) {
      const rule = css.match(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      expect(rule).toMatch(/stroke-width:\s*calc\(var\(--global-map-line-width/);
    }
    const titleRule = css.match(/(?:^|\r?\n)\.global-map__node-title\s*\{([^}]*)\}/m)?.[1] ?? "";
    expect(titleRule).toMatch(/opacity:\s*var\(--global-map-title-opacity/);
  });
});
