import { describe, expect, it } from "vitest";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  adjustSidebarWidth,
  clampSidebarWidth,
} from "./sidebar-width";

describe("clampSidebarWidth", () => {
  it("默认宽度 264 在范围内原样保留", () => {
    expect(SIDEBAR_DEFAULT_WIDTH).toBe(264);
    expect(clampSidebarWidth(264)).toBe(264);
  });

  it("小于最小值时钳制到 208", () => {
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(207)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(0)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(-50)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("大于最大值时钳制到 400", () => {
    expect(clampSidebarWidth(999)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(401)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it("边界值 208 / 400 原样保留", () => {
    expect(clampSidebarWidth(208)).toBe(208);
    expect(clampSidebarWidth(400)).toBe(400);
  });

  it("小数值取整后钳制", () => {
    expect(clampSidebarWidth(263.6)).toBe(264);
    expect(clampSidebarWidth(207.6)).toBe(208);
    expect(clampSidebarWidth(400.4)).toBe(400);
  });

  it("非有限输入回退到默认宽度", () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe("adjustSidebarWidth", () => {
  it("键盘步进 16px 增减", () => {
    expect(adjustSidebarWidth(264, 16)).toBe(280);
    expect(adjustSidebarWidth(264, -16)).toBe(248);
  });

  it("越过边界时钳制", () => {
    expect(adjustSidebarWidth(396, 16)).toBe(SIDEBAR_MAX_WIDTH);
    expect(adjustSidebarWidth(212, -16)).toBe(SIDEBAR_MIN_WIDTH);
    expect(adjustSidebarWidth(208, -16)).toBe(SIDEBAR_MIN_WIDTH);
    expect(adjustSidebarWidth(400, 16)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it("拖拽大 delta 同样钳制", () => {
    expect(adjustSidebarWidth(264, 500)).toBe(SIDEBAR_MAX_WIDTH);
    expect(adjustSidebarWidth(264, -500)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("当前值越界时先钳制再步进", () => {
    expect(adjustSidebarWidth(500, -16)).toBe(384);
    expect(adjustSidebarWidth(100, 16)).toBe(224);
  });
});
