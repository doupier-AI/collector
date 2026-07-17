/** 固定侧栏宽度的刚性范围与钳制计算（纯函数，便于单测）。 */

export const SIDEBAR_DEFAULT_WIDTH = 264;
export const SIDEBAR_MIN_WIDTH = 208;
export const SIDEBAR_MAX_WIDTH = 400;
/** 键盘方向键每步调整的像素数 */
export const SIDEBAR_KEYBOARD_STEP = 16;

/** 把任意数值钳制到 [208, 400] 并取整；非有限输入回退到默认宽度。 */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

/** 在当前宽度上增减 delta（拖拽或键盘步进），结果同样钳制。 */
export function adjustSidebarWidth(current: number, delta: number): number {
  return clampSidebarWidth(clampSidebarWidth(current) + delta);
}
