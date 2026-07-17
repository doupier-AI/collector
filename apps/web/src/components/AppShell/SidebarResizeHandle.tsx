import { useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import {
  SIDEBAR_KEYBOARD_STEP,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  adjustSidebarWidth,
  clampSidebarWidth,
} from "./sidebar-width";

export interface SidebarResizeHandleProps {
  /** 手柄所在的侧栏：左侧栏手柄在右边缘，向右拖变宽；右侧栏反之。 */
  side: "left" | "right";
  width: number;
  onResize: (width: number) => void;
  label: string;
}

/**
 * 固定侧栏内边缘的拖拽手柄：Pointer Events 拖拽调宽，
 * 键盘左右方向键每次 16px；宽度由父组件 state 保存（不持久化）。
 */
export function SidebarResizeHandle({ side, width, onResize, label }: SidebarResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    setDragging(true);
    // jsdom 等环境没有 Pointer Capture，有能力时才调用
    if (typeof event.currentTarget.setPointerCapture === "function") {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // 忽略捕获失败，移动与抬起事件仍会到达
      }
    }
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = event.clientX - drag.startX;
    const next = side === "left" ? drag.startWidth + delta : drag.startWidth - delta;
    onResize(clampSidebarWidth(next));
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    // 方向键沿手柄视觉方向移动：左侧栏向右拖变宽，右侧栏向左拖变宽
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const delta = side === "left" ? direction * SIDEBAR_KEYBOARD_STEP : -direction * SIDEBAR_KEYBOARD_STEP;
    onResize(adjustSidebarWidth(width, delta));
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      tabIndex={0}
      className={`sidebar-resize-handle sidebar-resize-handle--${side}${dragging ? " sidebar-resize-handle--active" : ""}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
    />
  );
}
