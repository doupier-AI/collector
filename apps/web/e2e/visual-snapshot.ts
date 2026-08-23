import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { expect, type Locator, type TestInfo } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface SnapshotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DescendantRenderingStyle {
  display: string;
  visibility: string;
  opacity: string;
  filter: string;
  backdropFilter: string;
  transform: string;
  clipPath: string;
  maskImage: string;
  mixBlendMode: string;
  isolation: string;
  perspective: string;
  overflow: string;
  contain: string;
  contentVisibility: string;
}

export interface TextRenderingAncestor {
  tagName: string;
  className: string;
  computedStyleSha256: string;
  beforeStyleSha256: string;
  afterStyleSha256: string;
  rect: SnapshotRect;
  renderingStyle: DescendantRenderingStyle;
}

export interface TextLayoutRegion {
  text: string | null;
  childElementCount: number;
  childNodeTypes: number[];
  beforeContent: string;
  afterContent: string;
  computedStyleSha256: string;
  beforeStyleSha256: string;
  afterStyleSha256: string;
  rect: SnapshotRect;
  lines: SnapshotRect[];
  ancestors: TextRenderingAncestor[];
  style: {
    display: string;
    visibility: string;
    opacity: string;
    color: string;
    webkitTextFillColor: string;
    webkitTextStrokeColor: string;
    webkitTextStrokeWidth: string;
    textShadow: string;
    filter: string;
    transform: string;
    clipPath: string;
    maskImage: string;
    mixBlendMode: string;
    fontFamily: string;
    fontSize: string;
    fontWeight: string;
    fontStyle: string;
    lineHeight: string;
    letterSpacing: string;
    wordSpacing: string;
    textIndent: string;
    textTransform: string;
    whiteSpace: string;
    overflowWrap: string;
    textRendering: string;
    backgroundColor: string;
    backgroundImage: string;
    boxShadow: string;
  };
}

export interface TextLayoutContract {
  root: {
    width: number;
    height: number;
    renderingStyle: DescendantRenderingStyle;
  };
  regions: TextLayoutRegion[];
}

interface FontRasterScreenshotOptions {
  textLayoutSelector: string;
  expectedTextLayout: TextLayoutContract;
  fontColor: readonly [number, number, number, number];
  mask?: Locator[];
  maskColor?: string;
}

export interface FontRasterComparison {
  dimensionsMatch: boolean;
  expectedSize: { width: number; height: number };
  actualSize: { width: number; height: number };
  diffPixels: number;
  diffRatio: number;
  diff?: Buffer;
}

const MAX_DIFF_PIXEL_RATIO = 0.01;
const PIXELMATCH_THRESHOLD = 0.2;
const INK_DISTANCE_FROM_BACKGROUND = 8;

/**
 * Windows Chromium can switch the 16px system-font raster between browser processes even when
 * Playwright, the baseline and the machine are unchanged. Before every screenshot this helper locks
 * text, computed styles, rendering ancestors and line geometry with a TextLayoutContract. Inside those
 * proven line rectangles, a differing pixel is normalized only when both images have ink within the
 * one-pixel glyph edge neighborhood and both colors can be produced by the declared foreground/background
 * blend. Every other pixel keeps the normal 0.2 / 1% gate.
 */
export async function expectScreenshotWithFontRasterRegions(
  target: Locator,
  snapshotName: string,
  testInfo: TestInfo,
  options: FontRasterScreenshotOptions,
): Promise<void> {
  expectExactTextLayoutContract(
    await readTextLayoutContract(target, options.textLayoutSelector),
    options.expectedTextLayout,
  );
  const expectedPath = testInfo.snapshotPath(snapshotName);
  const updateMode = testInfo.config.updateSnapshots;
  if (
    updateMode === "all"
    || updateMode === "changed"
    || (updateMode === "missing" && !existsSync(expectedPath))
  ) {
    await expect(target).toHaveScreenshot(snapshotName, {
      animations: "disabled",
      caret: "hide",
      mask: options.mask,
      maskColor: options.maskColor,
    });
    return;
  }
  const screenshot = target.screenshot as unknown as (options: {
    animations: "disabled";
    caret: "hide";
    mask?: Locator[];
    maskColor?: string;
  }) => Promise<Buffer>;
  const actual = await screenshot.call(target, {
    animations: "disabled",
    caret: "hide",
    mask: options.mask,
    maskColor: options.maskColor,
  });
  const expected = await readFile(expectedPath);
  const comparison = compareScreenshotsWithFontRasterRegions(
    expected,
    actual,
    options.expectedTextLayout.regions.flatMap((region) => region.lines),
    options.fontColor,
  );

  if (!comparison.dimensionsMatch || comparison.diffRatio > MAX_DIFF_PIXEL_RATIO) {
    await testInfo.attach(`${snapshotName}-expected`, { body: expected, contentType: "image/png" });
    await testInfo.attach(`${snapshotName}-actual`, { body: actual, contentType: "image/png" });
    if (comparison.diff) {
      await testInfo.attach(`${snapshotName}-font-raster-masked-diff`, {
        body: comparison.diff,
        contentType: "image/png",
      });
    }
  }

  expect(comparison.actualSize, `${snapshotName} 尺寸必须与视觉基线一致`).toEqual(comparison.expectedSize);

  expect(
    comparison.diffRatio,
    `${snapshotName} 排除已锁定字体栅格区域后仍有 ${comparison.diffPixels} 个差异像素（${(comparison.diffRatio * 100).toFixed(3)}%）`,
  ).toBeLessThanOrEqual(MAX_DIFF_PIXEL_RATIO);
}

export function compareScreenshotsWithFontRasterRegions(
  expected: Buffer,
  actual: Buffer,
  fontRasterRegions: SnapshotRect[],
  fontColor: readonly [number, number, number, number] = [32, 35, 31, 255],
): FontRasterComparison {
  const expectedPng = PNG.sync.read(expected);
  const actualPng = PNG.sync.read(actual);
  const expectedSize = { width: expectedPng.width, height: expectedPng.height };
  const actualSize = { width: actualPng.width, height: actualPng.height };

  if (expectedPng.width !== actualPng.width || expectedPng.height !== actualPng.height) {
    return { dimensionsMatch: false, expectedSize, actualSize, diffPixels: Number.POSITIVE_INFINITY, diffRatio: 1 };
  }

  const expectedData = Buffer.from(expectedPng.data);
  const actualData = Buffer.from(actualPng.data);
  normalizeFontRasterDifferences(
    expectedData,
    actualData,
    expectedPng.width,
    expectedPng.height,
    fontRasterRegions,
    fontColor,
  );

  const diffPng = new PNG({ width: expectedPng.width, height: expectedPng.height });
  const diffPixels = pixelmatch(
    expectedData,
    actualData,
    diffPng.data,
    expectedPng.width,
    expectedPng.height,
    { threshold: PIXELMATCH_THRESHOLD },
  );
  return {
    dimensionsMatch: true,
    expectedSize,
    actualSize,
    diffPixels,
    diffRatio: diffPixels / (expectedPng.width * expectedPng.height),
    diff: PNG.sync.write(diffPng),
  };
}

export async function readTextLayoutContract(target: Locator, selector: string): Promise<TextLayoutContract> {
  return target.evaluate(async (root, regionSelector) => {
    const rootRect = root.getBoundingClientRect();
    const relativeRect = (rect: DOMRect): SnapshotRect => ({
      x: rect.x - rootRect.x,
      y: rect.y - rootRect.y,
      width: rect.width,
      height: rect.height,
    });
    const styleSha256 = async (style: CSSStyleDeclaration): Promise<string> => {
      const serialized = Array.from(style)
        .sort()
        .map((property) => `${property}\0${style.getPropertyValue(property)}\0${style.getPropertyPriority(property)}`)
        .join("\n");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    const descendantRenderingStyle = (style: CSSStyleDeclaration): DescendantRenderingStyle => ({
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      filter: style.filter,
      backdropFilter: style.backdropFilter,
      transform: style.transform,
      clipPath: style.clipPath,
      maskImage: style.maskImage,
      mixBlendMode: style.mixBlendMode,
      isolation: style.isolation,
      perspective: style.perspective,
      overflow: style.overflow,
      contain: style.contain,
      contentVisibility: style.contentVisibility,
    });
    const renderingAncestor = async (element: Element): Promise<TextRenderingAncestor> => {
      const style = getComputedStyle(element);
      return {
        tagName: element.tagName,
        className: element.getAttribute("class") ?? "",
        computedStyleSha256: await styleSha256(style),
        beforeStyleSha256: await styleSha256(getComputedStyle(element, "::before")),
        afterStyleSha256: await styleSha256(getComputedStyle(element, "::after")),
        rect: relativeRect(element.getBoundingClientRect()),
        renderingStyle: descendantRenderingStyle(style),
      };
    };

    return {
      root: {
        width: rootRect.width,
        height: rootRect.height,
        renderingStyle: descendantRenderingStyle(getComputedStyle(root)),
      },
      regions: await Promise.all(Array.from(root.querySelectorAll(regionSelector)).map(async (region) => {
        const range = document.createRange();
        range.selectNodeContents(region);
        const style = getComputedStyle(region);
        const beforeStyle = getComputedStyle(region, "::before");
        const afterStyle = getComputedStyle(region, "::after");
        const ancestors: Element[] = [];
        for (let ancestor = region.parentElement; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
          ancestors.push(ancestor);
        }
        return {
          text: region.textContent,
          childElementCount: region.childElementCount,
          childNodeTypes: Array.from(region.childNodes, (node) => node.nodeType),
          beforeContent: beforeStyle.content,
          afterContent: afterStyle.content,
          computedStyleSha256: await styleSha256(style),
          beforeStyleSha256: await styleSha256(beforeStyle),
          afterStyleSha256: await styleSha256(afterStyle),
          rect: relativeRect(region.getBoundingClientRect()),
          lines: Array.from(range.getClientRects()).map(relativeRect),
          ancestors: await Promise.all(ancestors.map(renderingAncestor)),
          style: {
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            color: style.color,
            webkitTextFillColor: style.getPropertyValue("-webkit-text-fill-color"),
            webkitTextStrokeColor: style.getPropertyValue("-webkit-text-stroke-color"),
            webkitTextStrokeWidth: style.getPropertyValue("-webkit-text-stroke-width"),
            textShadow: style.textShadow,
            filter: style.filter,
            transform: style.transform,
            clipPath: style.clipPath,
            maskImage: style.maskImage,
            mixBlendMode: style.mixBlendMode,
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            fontStyle: style.fontStyle,
            lineHeight: style.lineHeight,
            letterSpacing: style.letterSpacing,
            wordSpacing: style.wordSpacing,
            textIndent: style.textIndent,
            textTransform: style.textTransform,
            whiteSpace: style.whiteSpace,
            overflowWrap: style.overflowWrap,
            textRendering: style.textRendering,
            backgroundColor: style.backgroundColor,
            backgroundImage: style.backgroundImage,
            boxShadow: style.boxShadow,
          },
        };
      })),
    };
  }, selector);
}

export function expectExactTextLayoutContract(actual: TextLayoutContract, expected: TextLayoutContract): void {
  expect(actual, "正文内容、颜色、字体度量和逐行布局必须与视觉契约完全一致").toEqual(expected);
}

function normalizeFontRasterDifferences(
  expected: Buffer,
  actual: Buffer,
  width: number,
  height: number,
  regions: SnapshotRect[],
  fontColor: readonly [number, number, number, number],
): void {
  const originalActual = Buffer.from(actual);
  for (const region of regions) {
    const left = Math.floor(region.x);
    const top = Math.floor(region.y);
    const right = Math.ceil(region.x + region.width);
    const bottom = Math.ceil(region.y + region.height);
    if (left < 0 || top < 0 || right > width || bottom > height || right <= left || bottom <= top) {
      throw new Error(`字体栅格区域超出截图边界：${JSON.stringify(region)}，截图 ${width}x${height}`);
    }
    const expectedBackground = dominantColor(expected, width, left, top, right, bottom);
    const actualBackground = dominantColor(actual, width, left, top, right, bottom);
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const offset = (y * width + x) * 4;
        if (
          pixelsEqual(expected, actual, offset)
          || !isForegroundBlend(expected, offset, expectedBackground, fontColor)
          || !isForegroundBlend(originalActual, offset, actualBackground, fontColor)
          || !hasInkNear(expected, x, y, width, expectedBackground, left, top, right, bottom)
          || !hasInkNear(originalActual, x, y, width, actualBackground, left, top, right, bottom)
        ) {
          continue;
        }
        actual[offset] = expected[offset]!;
        actual[offset + 1] = expected[offset + 1]!;
        actual[offset + 2] = expected[offset + 2]!;
        actual[offset + 3] = expected[offset + 3]!;
      }
    }
  }
}

function dominantColor(
  data: Buffer,
  width: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): readonly [number, number, number, number] {
  const counts = new Map<string, number>();
  let winner = "0,0,0,0";
  let winnerCount = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * width + x) * 4;
      const key = `${data[offset]},${data[offset + 1]},${data[offset + 2]},${data[offset + 3]}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count > winnerCount) {
        winner = key;
        winnerCount = count;
      }
    }
  }
  return winner.split(",").map(Number) as [number, number, number, number];
}

function pixelsEqual(expected: Buffer, actual: Buffer, offset: number): boolean {
  return expected[offset] === actual[offset]
    && expected[offset + 1] === actual[offset + 1]
    && expected[offset + 2] === actual[offset + 2]
    && expected[offset + 3] === actual[offset + 3];
}

function isForegroundBlend(
  data: Buffer,
  offset: number,
  background: readonly [number, number, number, number],
  foreground: readonly [number, number, number, number],
): boolean {
  for (let channel = 0; channel < 4; channel += 1) {
    const minimum = Math.min(background[channel]!, foreground[channel]!);
    const maximum = Math.max(background[channel]!, foreground[channel]!);
    const value = data[offset + channel]!;
    if (value < minimum || value > maximum) return false;
  }
  return true;
}

function hasInkNear(
  data: Buffer,
  x: number,
  y: number,
  width: number,
  background: readonly [number, number, number, number],
  left: number,
  top: number,
  right: number,
  bottom: number,
): boolean {
  for (let sampleY = Math.max(top, y - 1); sampleY < Math.min(bottom, y + 2); sampleY += 1) {
    for (let sampleX = Math.max(left, x - 1); sampleX < Math.min(right, x + 2); sampleX += 1) {
      const offset = (sampleY * width + sampleX) * 4;
      if (
        Math.abs(data[offset]! - background[0]) > INK_DISTANCE_FROM_BACKGROUND
        || Math.abs(data[offset + 1]! - background[1]) > INK_DISTANCE_FROM_BACKGROUND
        || Math.abs(data[offset + 2]! - background[2]) > INK_DISTANCE_FROM_BACKGROUND
      ) return true;
    }
  }
  return false;
}
