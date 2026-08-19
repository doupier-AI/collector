import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelectionQualityHint } from "./SelectionQualityHint";
import type { ActiveCapture } from "./useSelection";

const capture: ActiveCapture = {
  range: { text: "过长选区", blockCount: 1, startBlockId: "block-1", endBlockId: "block-1", startOffset: 0, endOffset: 4 },
  quality: { level: "too_long", maxCharacters: 10 },
  rect: { top: 4, bottom: 24, left: 0, right: 40 },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SelectionQualityHint", () => {
  it("贴近视口顶部时按实测高度翻转到选区下方并保留关闭按钮", () => {
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList?.contains("selection-hint") ? 56 : 0;
    });
    const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList?.contains("selection-hint") ? 200 : 0;
    });
    try {
      render(<SelectionQualityHint capture={capture} onDismiss={() => {}} />);
      const hint = screen.getByTestId("selection-quality-hint");
      expect(hint.style.top).toBe("34px");
      expect(hint.style.left).toBe("8px");
      expect(screen.getByRole("button", { name: "关闭提示" })).toBeVisible();
    } finally {
      width.mockRestore();
      height.mockRestore();
    }
  });
});
