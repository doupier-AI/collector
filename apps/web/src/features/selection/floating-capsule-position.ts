import type { SelectionRect } from "./useSelection";

/** 浮动胶囊的定位结果：页面绝对坐标（随内容滚动）与呈现侧。 */
export interface FloatingPlacement {
  /** 页面绝对纵坐标（已叠加纵向滚动量）。 */
  top: number;
  /** 页面绝对横坐标（已叠加横向滚动量）。 */
  left: number;
  /** 胶囊相对选区的呈现侧：优先上方，上方空间不足翻转下方。 */
  side: "above" | "below";
}

export interface FloatingPositionOptions {
  /** 胶囊与选区之间的间距（视口像素），默认 8。 */
  gap?: number;
  /** 视口边缘安全边距（视口像素），默认 8。 */
  margin?: number;
}

/**
 * 计算浮动胶囊相对选区包围盒的页面绝对定位（修订一 #9）。
 *
 * - 优先置于选区上方；上方空间不足一整个胶囊高度时翻转到选区下方；
 * - 横向以选区水平中心对齐胶囊中心，并钳制在视口安全边距内，任何情况不溢出；
 * - 输出为页面绝对坐标（viewport 坐标 + 滚动量），胶囊以 position: absolute
 *   挂在页面根部，随内容滚动而不是固定在视口。
 */
export function computeFloatingCapsulePlacement(
  selection: SelectionRect,
  capsule: { width: number; height: number },
  viewport: { width: number; height: number },
  scroll: { x: number; y: number },
  options: FloatingPositionOptions = {},
): FloatingPlacement {
  const gap = options.gap ?? 8;
  const margin = options.margin ?? 8;
  const side = selection.top - gap - capsule.height >= margin ? "above" : "below";
  const viewportTop = side === "above" ? selection.top - gap - capsule.height : selection.bottom + gap;
  const centerX = (selection.left + selection.right) / 2;
  const minLeft = margin;
  const maxLeft = Math.max(minLeft, viewport.width - capsule.width - margin);
  const viewportLeft = Math.min(Math.max(centerX - capsule.width / 2, minLeft), maxLeft);
  return {
    top: viewportTop + scroll.y,
    left: viewportLeft + scroll.x,
    side,
  };
}
