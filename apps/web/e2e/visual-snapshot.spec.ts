import { expect, test } from "@playwright/test";
import { PNG } from "pngjs";
import {
  compareScreenshotsWithFontRasterRegions,
  expectExactTextLayoutContract,
  readTextLayoutContract,
  translateAndClipSnapshotRects,
  type SnapshotRect,
} from "./visual-snapshot";

const FONT_REGION: SnapshotRect = { x: 5, y: 5, width: 20, height: 8 };

test.describe("Windows 字体栅格视觉门禁防弱化", () => {
  test("双方都有字形墨迹时只归一化声明区域内的栅格颜色", () => {
    const expected = image(40, 30, [245, 244, 239, 255]);
    const actual = image(40, 30, [245, 244, 239, 255]);
    paintGlyph(expected, FONT_REGION, [90, 90, 90, 255]);
    paintGlyph(actual, FONT_REGION, [32, 35, 31, 255]);

    const rasterOnly = compareScreenshotsWithFontRasterRegions(
      PNG.sync.write(expected),
      PNG.sync.write(actual),
      [FONT_REGION],
    );
    expect(rasterOnly.dimensionsMatch).toBe(true);
    expect(rasterOnly.diffPixels).toBe(0);
  });

  test("正文消失时缺少实际字形墨迹，不能作为栅格噪声归一化", () => {
    const expected = image(40, 30, [245, 244, 239, 255]);
    const actual = image(40, 30, [245, 244, 239, 255]);
    paintGlyph(expected, FONT_REGION, [32, 35, 31, 255]);
    const hiddenText = compareScreenshotsWithFontRasterRegions(
      PNG.sync.write(expected),
      PNG.sync.write(actual),
      [FONT_REGION],
    );
    expect(hiddenText.diffRatio).toBeGreaterThan(0.01);
  });

  test("1px 几何位移独立触发像素门禁", () => {
    const expected = image(40, 30, [245, 244, 239, 255]);
    const actual = image(40, 30, [245, 244, 239, 255]);
    paint(expected, { x: 30, y: 3, width: 2, height: 22 }, [20, 20, 20, 255]);
    paint(actual, { x: 31, y: 3, width: 2, height: 22 }, [20, 20, 20, 255]);
    const shifted = compareScreenshotsWithFontRasterRegions(
      PNG.sync.write(expected),
      PNG.sync.write(actual),
      [FONT_REGION],
    );
    expect(shifted.diffRatio).toBeGreaterThan(0.01);
  });

  test("颜色变化独立触发像素门禁", () => {
    const expected = image(40, 30, [245, 244, 239, 255]);
    const actual = image(40, 30, [245, 244, 239, 255]);
    paint(actual, { x: 26, y: 18, width: 10, height: 10 }, [180, 40, 40, 255]);
    const recolored = compareScreenshotsWithFontRasterRegions(
      PNG.sync.write(expected),
      PNG.sync.write(actual),
      [FONT_REGION],
    );
    expect(recolored.diffRatio).toBeGreaterThan(0.01);
  });

  test("尺寸变化直接失败，不能被字体区域归一化", () => {
    const expected = PNG.sync.write(image(40, 30, [245, 244, 239, 255]));
    const actual = PNG.sync.write(image(41, 30, [245, 244, 239, 255]));
    const comparison = compareScreenshotsWithFontRasterRegions(expected, actual, [FONT_REGION]);
    expect(comparison.dimensionsMatch).toBe(false);
    expect(comparison.diffRatio).toBe(1);
  });

  test("页面截图只平移并裁切既有文字行区域，不纳入周边像素", () => {
    expect(translateAndClipSnapshotRects(
      [
        { x: 5, y: 6, width: 10, height: 8 },
        { x: 5, y: 20, width: 10, height: 8 },
        { x: 50, y: 50, width: 4, height: 4 },
      ],
      { x: 10, y: 5 },
      { width: 40, height: 30 },
    )).toEqual([
      { x: 15, y: 11, width: 10, height: 8 },
      { x: 15, y: 25, width: 10, height: 5 },
    ]);
  });

  test("真实 DOM 的隐藏、1px 位移、改色、斜体、祖先淡化和改内容都独立改变严格契约", async ({ page }) => {
    await page.goto("/");
    const fixture = `
      <style>
        #card { width: 240px; padding: 16px; color: rgb(32, 35, 31); font: 400 16px/28px "Microsoft YaHei", sans-serif; }
        #card p { margin: 0; overflow-wrap: anywhere; }
      </style>
      <section id="card"><div class="markdown-content"><p>确定性正文用于验证真实 DOM 契约。</p></div></section>
    `;
    const assertMutationChangesContract = async (mutate: (card: import("@playwright/test").Locator) => Promise<void>) => {
      await page.setContent(fixture);
      const card = page.locator("#card");
      const baseline = await readTextLayoutContract(card, "p");
      await mutate(card);
      const mutated = await readTextLayoutContract(card, "p");
      expect(() => expectExactTextLayoutContract(mutated, baseline)).toThrow();
    };

    await assertMutationChangesContract((card) => card.locator("p").evaluate((element) => {
      element.style.visibility = "hidden";
    }));
    await assertMutationChangesContract((card) => card.locator("p").evaluate((element) => {
      element.style.transform = "translateX(1px)";
    }));
    await assertMutationChangesContract((card) => card.locator("p").evaluate((element) => {
      element.style.color = "rgb(180, 40, 40)";
    }));
    await assertMutationChangesContract((card) => card.locator("p").evaluate((element) => {
      element.style.fontStyle = "italic";
    }));
    await assertMutationChangesContract((card) => card.locator(".markdown-content").evaluate((element) => {
      element.style.filter = "opacity(.5)";
    }));
    await assertMutationChangesContract((card) => card.locator("p").evaluate((element) => {
      element.textContent = "不同的正文";
    }));
  });
});

function image(width: number, height: number, color: readonly [number, number, number, number]): PNG {
  const png = new PNG({ width, height });
  paint(png, { x: 0, y: 0, width, height }, color);
  return png;
}

function paintGlyph(png: PNG, rect: SnapshotRect, color: readonly [number, number, number, number]): void {
  for (let x = rect.x; x < rect.x + rect.width; x += 3) {
    paint(png, { x, y: rect.y, width: 1, height: rect.height }, color);
  }
}

function paint(png: PNG, rect: SnapshotRect, color: readonly [number, number, number, number]): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const offset = (y * png.width + x) * 4;
      png.data[offset] = color[0];
      png.data[offset + 1] = color[1];
      png.data[offset + 2] = color[2];
      png.data[offset + 3] = color[3];
    }
  }
}
