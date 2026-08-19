import { useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import type { ResearchSelectionQuality } from "@collector/capture-contracts";
import { RESEARCH_SELECTION_MAX_CHARACTERS } from "@collector/capture-contracts";
import type { ActiveCapture } from "./useSelection";
import { computeAnchoredOverlayPosition } from "../../utils/anchored-overlay-position";

/**
 * 修订一·B（issue #10）：非空即有效，"选区太短"提示分支退役；
 * 仅保留太长与跨段落两种调整建议。
 */
function qualityCopy(quality: ResearchSelectionQuality): string {
  switch (quality.level) {
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
  const hintRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  useLayoutEffect(() => {
    if (!copy || !hintRef.current) return;
    const update = () => {
      const hint = hintRef.current;
      if (!hint) return;
      const next = computeAnchoredOverlayPosition(capture.rect, { width: hint.offsetWidth, height: hint.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, {
        gap: 10,
        margin: 8,
        preferredPlacement: "top",
      });
      setPosition((current) => current?.top === next.top && current.left === next.left ? current : { top: next.top, left: next.left });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [capture.rect, copy]);
  if (!copy) return null;
  return (
    <div
      ref={hintRef}
      className="selection-hint"
      data-selection-ui
      data-testid="selection-quality-hint"
      role="status"
      style={position ? { top: position.top, left: position.left } : { visibility: "hidden" }}
      onMouseDown={preventSelectionClear}
    >
      <p className="selection-hint__text">{copy}</p>
      <button type="button" className="selection-hint__close" aria-label="关闭提示" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
