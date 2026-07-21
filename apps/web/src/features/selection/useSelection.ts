import { useCallback, useEffect, useState } from "react";
import type { ResearchSelectionAnchor, ResearchSelectionQuality } from "@collector/capture-contracts";
import { evaluateSelectionQuality } from "@collector/capture-contracts";
import { captureSelection, readContentContext, resolveBlockRange } from "./selection-capture";
import type { BlockSelectionRange } from "./selection-capture";

export interface SelectionRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** 一次有效捕获：块内范围、质量评级、锚点（仅单块且位置可解析时）与屏幕位置。 */
export interface ActiveCapture {
  range: BlockSelectionRange;
  anchor?: ResearchSelectionAnchor;
  quality: ResearchSelectionQuality;
  rect: SelectionRect;
}

export interface SelectionCaptureState {
  active: ActiveCapture | null;
  dismiss(): void;
}

function closestContentContainer(node: Node | null): Element | null {
  if (!node) return null;
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  return element?.closest?.("[data-content-kind]") ?? null;
}

function isInsideSelectionUi(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  return Boolean(element?.closest?.("[data-selection-ui]"));
}

/** 焦点在表单控件内（如选区窗口里的方向输入框）时，光标变化不属于正文选区。 */
function isFormFieldFocused(): boolean {
  const active = document.activeElement;
  return active instanceof Element && Boolean(active.closest?.("input, textarea, select, [contenteditable]"));
}

function readActiveCapture(): ActiveCapture | null {
  if (typeof window.getSelection !== "function") return null;
  const domSelection = window.getSelection();
  if (!domSelection || domSelection.rangeCount === 0 || domSelection.isCollapsed) return null;
  const range = domSelection.getRangeAt(0);
  const container = closestContentContainer(range.commonAncestorContainer);
  const context = container ? readContentContext(container) : undefined;
  if (!context) return null;
  const blockRange = resolveBlockRange(range, context);
  if (!blockRange) return null;
  const captured = captureSelection(blockRange, context);
  const rect = range.getBoundingClientRect();
  return {
    range: captured.range,
    anchor: captured.anchor,
    quality: evaluateSelectionQuality({ text: captured.range.text, blockCount: captured.range.blockCount }),
    rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
  };
}

/**
 * 文档级选区捕获：只在完成的 AI 回答块与阅读正文块上生效
 * （只有这些容器带 data-content-kind 标记）。
 * 鼠标抬起、键盘选择抬起时提交；选区折叠或清空时关闭提示与窗口。
 */
export function useSelectionCapture(): SelectionCaptureState {
  const [active, setActive] = useState<ActiveCapture | null>(null);

  const commit = useCallback(() => {
    setActive(readActiveCapture());
  }, []);

  const dismiss = useCallback(() => {
    setActive(null);
    if (typeof window.getSelection === "function") window.getSelection()?.removeAllRanges();
  }, []);

  useEffect(() => {
    function handleMouseUp(event: MouseEvent) {
      if (isInsideSelectionUi(event.target)) return;
      commit();
    }
    function handleTouchEnd(event: TouchEvent) {
      if (isInsideSelectionUi(event.target)) return;
      commit();
    }
    function handleKeyUp(event: KeyboardEvent) {
      if (event.key === "Escape") {
        dismiss();
        return;
      }
      if (!event.shiftKey) return;
      if (isInsideSelectionUi(event.target)) return;
      commit();
    }
    function handleSelectionChange() {
      if (isFormFieldFocused()) return;
      const domSelection = typeof window.getSelection === "function" ? window.getSelection() : null;
      if (!domSelection || domSelection.rangeCount === 0 || domSelection.isCollapsed) setActive(null);
    }
    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("touchend", handleTouchEnd);
    document.addEventListener("keyup", handleKeyUp);
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("touchend", handleTouchEnd);
      document.removeEventListener("keyup", handleKeyUp);
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [commit, dismiss]);

  return { active, dismiss };
}
