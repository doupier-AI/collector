import { describe, expect, it } from "vitest";
import { clampOverlayToViewport, computeAnchoredOverlayPosition } from "./anchored-overlay-position";

const viewport = { width: 320, height: 568 };
const overlay = { width: 200, height: 160 };

describe("computeAnchoredOverlayPosition", () => {
  it("首选侧空间足够时保持首选侧并居中", () => {
    expect(computeAnchoredOverlayPosition({ top: 300, bottom: 320, left: 100, right: 120 }, overlay, viewport, { preferredPlacement: "top" }))
      .toEqual({ placement: "top", top: 132, left: 10 });
  });

  it("首选侧不足时翻转到对侧", () => {
    expect(computeAnchoredOverlayPosition({ top: 30, bottom: 50, left: 100, right: 120 }, overlay, viewport, { preferredPlacement: "top" }))
      .toMatchObject({ placement: "bottom", top: 58 });
  });

  it("两侧都不足时把实测弹层贴在安全边距内", () => {
    expect(computeAnchoredOverlayPosition({ top: 250, bottom: 270, left: 100, right: 120 }, { width: 300, height: 540 }, viewport, { preferredPlacement: "bottom", margin: 12 }))
      .toEqual({ placement: "bottom", top: 16, left: 12 });
  });

  it("左右预览同样翻转并钳制交叉轴", () => {
    expect(computeAnchoredOverlayPosition({ top: 540, bottom: 560, left: 280, right: 300 }, overlay, viewport, { preferredPlacement: "right" }))
      .toEqual({ placement: "left", top: 400, left: 72 });
  });

  it("可保持菜单相对触发按钮的右缘对齐，同时仍受视口钳制", () => {
    expect(computeAnchoredOverlayPosition({ top: 100, bottom: 120, left: 240, right: 280 }, { width: 160, height: 120 }, viewport, {
      preferredPlacement: "bottom",
      crossAxisAlignment: "end",
    })).toMatchObject({ placement: "bottom", top: 128, left: 120 });
  });

  it("可将已固定的弹层在 resize 后贴边钳制", () => {
    expect(clampOverlayToViewport({ top: 600, left: 300 }, { width: 240, height: 40 }, { width: 320, height: 500 }))
      .toEqual({ top: 452, left: 72 });
  });
});
