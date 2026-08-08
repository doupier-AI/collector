import { describe, expect, it } from "vitest";
import { computeFloatingCapsulePlacement } from "./floating-capsule-position";

const VIEWPORT = { width: 1024, height: 768 };
const NO_SCROLL = { x: 0, y: 0 };
const CAPSULE = { width: 80, height: 32 };

describe("computeFloatingCapsulePlacement", () => {
  it("上方空间充足时置于选区上方，横向以选区中心对齐", () => {
    const placement = computeFloatingCapsulePlacement(
      { top: 200, bottom: 220, left: 100, right: 300 },
      CAPSULE,
      VIEWPORT,
      NO_SCROLL,
    );
    // 200 - 8(间距) - 32(胶囊高) = 160
    expect(placement.side).toBe("above");
    expect(placement.top).toBe(160);
    // 选区中心 200 - 胶囊半宽 40 = 160
    expect(placement.left).toBe(160);
  });

  it("上方空间不足时翻转到选区下方", () => {
    const placement = computeFloatingCapsulePlacement(
      { top: 30, bottom: 50, left: 100, right: 300 },
      CAPSULE,
      VIEWPORT,
      NO_SCROLL,
    );
    // 30 - 8 - 32 < 8(边距) → 下方：50 + 8 = 58
    expect(placement.side).toBe("below");
    expect(placement.top).toBe(58);
  });

  it("靠近视口左缘时横向钳制到安全边距内", () => {
    const placement = computeFloatingCapsulePlacement(
      { top: 200, bottom: 220, left: 0, right: 40 },
      CAPSULE,
      VIEWPORT,
      NO_SCROLL,
    );
    // 选区中心 20 - 半宽 40 = -20，低于最小边距 8
    expect(placement.left).toBe(8);
  });

  it("靠近视口右缘时横向钳制到安全边距内", () => {
    const placement = computeFloatingCapsulePlacement(
      { top: 200, bottom: 220, left: 980, right: 1024 },
      CAPSULE,
      VIEWPORT,
      NO_SCROLL,
    );
    // 最大 left = 1024 - 80 - 8 = 936
    expect(placement.left).toBe(936);
  });

  it("胶囊宽于视口时不产生负坐标（极窄屏兜底）", () => {
    const placement = computeFloatingCapsulePlacement(
      { top: 200, bottom: 220, left: 0, right: 100 },
      { width: 400, height: 32 },
      { width: 320, height: 568 },
      NO_SCROLL,
    );
    expect(placement.left).toBe(8);
  });

  it("输出为页面绝对坐标：叠加页面滚动量", () => {
    const placement = computeFloatingCapsulePlacement(
      { top: 200, bottom: 220, left: 100, right: 300 },
      CAPSULE,
      VIEWPORT,
      { x: 25, y: 500 },
    );
    expect(placement.top).toBe(160 + 500);
    expect(placement.left).toBe(160 + 25);
  });

  it("自定义间距与边距生效", () => {
    const placement = computeFloatingCapsulePlacement(
      { top: 200, bottom: 220, left: 100, right: 300 },
      CAPSULE,
      VIEWPORT,
      NO_SCROLL,
      { gap: 4, margin: 16 },
    );
    // 200 - 4 - 32 = 164；横向 200 - 40 = 160，在边距内不受影响
    expect(placement.top).toBe(164);
    expect(placement.left).toBe(160);
  });
});
