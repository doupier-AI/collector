import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ResearchMapNodeLabelStack } from "./ResearchMapNodeLabelStack";

function renderStack(options: { secondaryTitle?: string; details?: string } = {}) {
  return render(<svg>
    <ResearchMapNodeLabelStack
      title={["单行标题", options.secondaryTitle]}
      titleFontSize={13}
      details={options.details}
      evidence={{ label: "证据可用", health: "available" }}
      scopeLabel="范围外关系端点"
    />
  </svg>);
}

function y(container: HTMLElement, selector: string): number {
  return Number(container.querySelector(selector)?.getAttribute("y"));
}

describe("ResearchMapNodeLabelStack", () => {
  it("只让实际显示的标签行参与纵向排布", () => {
    const { container, rerender } = renderStack();
    const compactEvidenceY = y(container, ".global-map__node-evidence");
    const compactScopeY = y(container, ".global-map__node-scope");
    expect(container.querySelector(".global-map__node-details")).toBeNull();

    rerender(<svg>
      <ResearchMapNodeLabelStack
        title={["单行标题", undefined]}
        titleFontSize={13}
        details="未分类 · 融合成果"
        evidence={{ label: "证据可用", health: "available" }}
        scopeLabel="范围外关系端点"
      />
    </svg>);

    expect(y(container, ".global-map__node-details")).toBe(compactEvidenceY);
    expect(y(container, ".global-map__node-evidence")).toBe(compactScopeY);
    expect(y(container, ".global-map__node-scope")).toBeGreaterThan(compactScopeY);
  });

  it("双行标题只增加一行标题自己的行高", () => {
    const { container, rerender } = renderStack();
    const singleLineEvidenceY = y(container, ".global-map__node-evidence");

    rerender(<svg>
      <ResearchMapNodeLabelStack
        title={["第一行", "第二行"]}
        titleFontSize={13}
        evidence={{ label: "证据可用", health: "available" }}
      />
    </svg>);

    expect(container.querySelectorAll(".global-map__node-title tspan")).toHaveLength(2);
    expect(y(container, ".global-map__node-evidence") - singleLineEvidenceY).toBeCloseTo(13 * 1.7, 5);
  });
});
