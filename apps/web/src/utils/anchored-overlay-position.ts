/**
 * 固定锚点弹层的纯定位规则。
 *
 * 先尝试首选侧，空间不足时翻转到对侧；两侧都不足时贴边钳制。横轴/纵轴的交叉方向
 * 始终钳制，因而调用方只需以 CSS 的 max-height + 内部滚动处理超过可视高度的内容。
 */
export type AnchoredOverlayPlacement = "top" | "bottom" | "left" | "right";

export interface OverlayAnchorRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width?: number;
  height?: number;
}

export interface AnchoredOverlayPosition {
  top: number;
  left: number;
  placement: AnchoredOverlayPlacement;
}

export type OverlayCrossAxisAlignment = "start" | "center" | "end";

/** 供已固定在视口坐标的弹层在 resize/旋转后保留原位置并仅贴边钳制。 */
export function clampOverlayToViewport(
  position: { top: number; left: number },
  overlay: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
): { top: number; left: number } {
  const clamp = (value: number, size: number, limit: number) => Math.min(Math.max(value, margin), Math.max(margin, limit - size - margin));
  return { top: clamp(position.top, overlay.height, viewport.height), left: clamp(position.left, overlay.width, viewport.width) };
}

export function computeAnchoredOverlayPosition(
  anchor: OverlayAnchorRect,
  overlay: { width: number; height: number },
  viewport: { width: number; height: number },
  options: { gap?: number; margin?: number; preferredPlacement?: AnchoredOverlayPlacement; crossAxisAlignment?: OverlayCrossAxisAlignment } = {},
): AnchoredOverlayPosition {
  const gap = options.gap ?? 8;
  const margin = options.margin ?? 8;
  const preferredPlacement = options.preferredPlacement ?? "bottom";
  const crossAxisAlignment = options.crossAxisAlignment ?? "center";
  const opposite: Record<AnchoredOverlayPlacement, AnchoredOverlayPlacement> = {
    top: "bottom", bottom: "top", left: "right", right: "left",
  };
  const fits = (placement: AnchoredOverlayPlacement) => {
    switch (placement) {
      case "top": return anchor.top - gap - overlay.height >= margin;
      case "bottom": return anchor.bottom + gap + overlay.height <= viewport.height - margin;
      case "left": return anchor.left - gap - overlay.width >= margin;
      case "right": return anchor.right + gap + overlay.width <= viewport.width - margin;
    }
  };
  const placement = fits(preferredPlacement)
    ? preferredPlacement
    : fits(opposite[preferredPlacement])
      ? opposite[preferredPlacement]
      : preferredPlacement;
  const clamp = (value: number, size: number, limit: number) => Math.min(Math.max(value, margin), Math.max(margin, limit - size - margin));
  const centerX = (anchor.left + anchor.right) / 2;
  const centerY = (anchor.top + anchor.bottom) / 2;
  const horizontalCrossAxis = () => crossAxisAlignment === "start"
    ? anchor.left
    : crossAxisAlignment === "end"
      ? anchor.right - overlay.width
      : centerX - overlay.width / 2;
  const verticalCrossAxis = () => crossAxisAlignment === "start"
    ? anchor.top
    : crossAxisAlignment === "end"
      ? anchor.bottom - overlay.height
      : centerY - overlay.height / 2;
  switch (placement) {
    case "top":
      return { placement, top: clamp(anchor.top - gap - overlay.height, overlay.height, viewport.height), left: clamp(horizontalCrossAxis(), overlay.width, viewport.width) };
    case "bottom":
      return { placement, top: clamp(anchor.bottom + gap, overlay.height, viewport.height), left: clamp(horizontalCrossAxis(), overlay.width, viewport.width) };
    case "left":
      return { placement, top: clamp(verticalCrossAxis(), overlay.height, viewport.height), left: clamp(anchor.left - gap - overlay.width, overlay.width, viewport.width) };
    case "right":
      return { placement, top: clamp(verticalCrossAxis(), overlay.height, viewport.height), left: clamp(anchor.right + gap, overlay.width, viewport.width) };
  }
}
