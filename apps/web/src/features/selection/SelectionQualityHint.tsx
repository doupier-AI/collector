import type { MouseEvent } from "react";
import type { ResearchSelectionQuality } from "@collector/capture-contracts";
import { RESEARCH_SELECTION_MAX_CHARACTERS, RESEARCH_SELECTION_MIN_CHARACTERS } from "@collector/capture-contracts";
import type { ActiveCapture } from "./useSelection";

function qualityCopy(quality: ResearchSelectionQuality): string {
  switch (quality.level) {
    case "too_short":
      return `选区太短。至少选择 ${quality.minCharacters ?? RESEARCH_SELECTION_MIN_CHARACTERS} 个字，才能开始分析。`;
    case "too_long":
      return `选区太长。请控制在 ${quality.maxCharacters ?? RESEARCH_SELECTION_MAX_CHARACTERS} 字以内。`;
    case "cross_block":
      return "选区跨了多个段落。调整到一个段落内，才能开始分析。";
    case "ok":
      return "";
  }
}

function preventSelectionClear(event: MouseEvent): void {
  // 点击提示本身不应清除用户刚做出的选区
  event.preventDefault();
}

/** 选区质量提示：只给调整建议，不创建选区记录。 */
export function SelectionQualityHint({ capture, onDismiss }: { capture: ActiveCapture; onDismiss: () => void }) {
  const copy = qualityCopy(capture.quality);
  if (!copy) return null;
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1024;
  const midpoint = Math.min(Math.max((capture.rect.left + capture.rect.right) / 2, 104), viewportWidth - 104);
  return (
    <div
      className="selection-hint"
      data-selection-ui
      data-testid="selection-quality-hint"
      role="status"
      style={{ top: Math.max(capture.rect.top - 10, 8), left: midpoint }}
      onMouseDown={preventSelectionClear}
    >
      <p className="selection-hint__text">{copy}</p>
      <button type="button" className="selection-hint__close" aria-label="关闭提示" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
