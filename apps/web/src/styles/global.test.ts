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

describe("Markdown 列表间距", () => {
  it("折叠 AST 结构性空白，显式换行交给语义 br 节点", () => {
    const rootRule = css.match(/(?:^|\r?\n)\.markdown-content\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rootRule).toMatch(/white-space:\s*normal/);
  });

  it("列表项无机械 margin，只有真实多段和嵌套列表获得关系型间距", () => {
    const itemRule = css.match(/\.markdown-content :where\(li\)\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(itemRule).toMatch(/margin:\s*0/);
    expect(css).toMatch(/\.markdown-content :where\(li > p\)\s*\{\s*margin:\s*0/);
    expect(css).toMatch(/\.markdown-content :where\(li > p \+ p\)\s*\{\s*margin-top:\s*var\(--markdown-space-flow\)/);
    expect(css).toMatch(/\.markdown-content :where\(li > ul, li > ol\)\s*\{\s*margin:\s*var\(--markdown-space-tight\) 0 0/);
  });

  it("仅缝合回答中相邻的纯列表块", () => {
    expect(css).toMatch(/\.turn-card > \.message__content:has\(> \.markdown-content > :only-child:is\(ul, ol\)\)[\s\S]*\+ \.message__content:has\(> \.markdown-content > :only-child:is\(ul, ol\)\)[\s\S]*margin-top:\s*0/);
  });
});
