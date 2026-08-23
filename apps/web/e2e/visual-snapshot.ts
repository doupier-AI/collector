import { readFile } from "node:fs/promises";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import sharp from "sharp";

interface StableScreenshotOptions {
  mask?: Locator[];
  maskColor?: string;
}

const MAX_DIFF_PIXEL_RATIO = 0.01;
const PIXELMATCH_THRESHOLD = 0.2;
const FONT_RASTER_BLUR_SIGMA = 1;

/**
 * 比较含大量 Windows 系统字体的视觉基线。
 *
 * 同一 Microsoft YaHei 字形会随 DirectWrite/ClearType 状态产生灰阶、彩色子像素和
 * hinting 差异。对基准与实际图施加相同的 1px 高斯归一化，只消除字形边缘的栅格噪声；
 * 尺寸必须完全一致，比较仍使用仓库既有 1% 差异上限和 0.2 pixelmatch 阈值。
 */
export async function expectSystemFontStableScreenshot(
  target: Page | Locator,
  snapshotName: string,
  testInfo: TestInfo,
  options: StableScreenshotOptions = {},
): Promise<void> {
  const screenshot = target.screenshot as unknown as (options: {
    animations: "disabled";
    caret: "hide";
    mask?: Locator[];
    maskColor?: string;
  }) => Promise<Buffer>;
  const actual = await screenshot.call(target, {
    animations: "disabled",
    caret: "hide",
    ...options,
  });
  const expectedPath = testInfo.snapshotPath(snapshotName);
  const expected = await readFile(expectedPath);
  const [normalizedExpected, normalizedActual] = await Promise.all([
    normalizeFontRaster(expected),
    normalizeFontRaster(actual),
  ]);
  const expectedPng = PNG.sync.read(normalizedExpected);
  const actualPng = PNG.sync.read(normalizedActual);

  expect(
    { width: actualPng.width, height: actualPng.height },
    `${snapshotName} 尺寸必须与视觉基线一致`,
  ).toEqual({ width: expectedPng.width, height: expectedPng.height });

  const diff = new PNG({ width: expectedPng.width, height: expectedPng.height });
  const diffPixels = pixelmatch(
    expectedPng.data,
    actualPng.data,
    diff.data,
    expectedPng.width,
    expectedPng.height,
    { threshold: PIXELMATCH_THRESHOLD },
  );
  const diffRatio = diffPixels / (expectedPng.width * expectedPng.height);

  if (diffRatio > MAX_DIFF_PIXEL_RATIO) {
    await testInfo.attach(`${snapshotName}-actual`, { body: actual, contentType: "image/png" });
    await testInfo.attach(`${snapshotName}-normalized-diff`, {
      body: PNG.sync.write(diff),
      contentType: "image/png",
    });
  }
  expect(
    diffRatio,
    `${snapshotName} 归一化后仍有 ${diffPixels} 个差异像素（${(diffRatio * 100).toFixed(3)}%）`,
  ).toBeLessThanOrEqual(MAX_DIFF_PIXEL_RATIO);
}

async function normalizeFontRaster(image: Buffer): Promise<Buffer> {
  return sharp(image).blur(FONT_RASTER_BLUR_SIGMA).png().toBuffer();
}
