import { describe, expect, it } from "vitest";
import { fitViewBoxToPoints, screenBoundedUserFontSize, screenPointToSvgPoint } from "./research-map-geometry";

describe("research map svg geometry", () => {
  it("converts screen coordinates through the inverse SVG screen matrix", () => {
    const screenMatrix = { a: 2, b: 0, c: 0, d: 2, e: 100, f: 50 };

    expect(screenPointToSvgPoint(screenMatrix, { x: 340, y: 170 })).toEqual({ x: 120, y: 60 });
  });

  it("keeps title text at a readable screen size across svg zoom levels", () => {
    expect(screenBoundedUserFontSize(2) * 2).toBeCloseTo(13, 5);
    expect(screenBoundedUserFontSize(0.5) * 0.5).toBeCloseTo(13, 5);
  });

  it("fits all points while preserving the actual canvas aspect ratio", () => {
    const fitted = fitViewBoxToPoints([{ x: 0, y: 0 }, { x: 800, y: 100 }], 2);

    expect(fitted.width / fitted.height).toBe(2);
    expect(fitted.x).toBeLessThanOrEqual(-90);
    expect(fitted.x + fitted.width).toBeGreaterThanOrEqual(890);
    expect(fitted.y).toBeLessThanOrEqual(-80);
    expect(fitted.y + fitted.height).toBeGreaterThanOrEqual(180);
  });

  it("centers the content bounding box instead of expanding around an outlier-skewed centroid", () => {
    const points = [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 900, y: 0 }];
    const fitted = fitViewBoxToPoints(points, 2);

    expect((450 - fitted.x) / fitted.width).toBeCloseTo(0.5, 8);
    expect((50 - fitted.y) / fitted.height).toBeCloseTo(0.5, 8);
    expect(fitted.width).toBe(1080);
  });
});
