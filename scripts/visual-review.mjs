#!/usr/bin/env node
/**
 * 程序化视觉审阅（无图环境的视觉验证工具，testing.md「无图环境的视觉验证」的机器事实源）。
 *
 * 用途：任务要求视觉验证但环境无法直接看图时，对「基准图 vs 实际图」做逐像素比较，
 * 回答三个问题——哪里不同（差异聚类区域）、差异有多大（像素数/占比）、
 * 是否符合预期变更范围（差异是否全部落在 --allow 预期区域内）。
 *
 * 用法：
 *   npm run visual:diff -- <基准.png> <实际.png> [--allow x,y,w,h ...] [--json <报告路径>]
 *
 * 判定与退出码：
 *   0 —— 零差异；或全部差异像素落在 --allow 区域并集内；或未给 --allow 的报告模式（有差异也只报告，以输出结论为准）；
 *   1 —— 给了 --allow 且存在越界差异（输出越界像素数与越界区域包围盒）；
 *   2 —— 用法错误 / 文件不可读 / 非 PNG。
 *   尺寸不一致不算用法错误：按差异处理（整幅超出部分计入差异），并明确报两边尺寸。
 *
 * 算法与 Playwright toHaveScreenshot 同源：pixelmatch（比较）+ pngjs（解码），
 * 默认 threshold 0.2 与仓库像素基线容差一致，可用 --threshold 覆盖。
 * 聚类：差异像素先按网格桶（默认 32px）归并再输出每桶包围盒与像素数，
 * 按像素数降序，最多输出 20 桶；完整逐像素结论以 JSON 报告为准。
 *
 * 本工具不负责判断「任务是否需要视觉验证」（仍是规则与人判断），
 * 也不锁死唯一算法——任何能提供等价或更强证据的方式都允许（testing.md）。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const BUCKET_SIZE = 32;
const MAX_BUCKETS_IN_TEXT = 20;

function usage() {
  console.error(
    [
      "用法：npm run visual:diff -- <基准.png> <实际.png> [--allow x,y,w,h ...] [--json <报告路径>] [--threshold 0.2]",
      "  --allow x,y,w,h   预期差异区域（可重复）；给出后差异必须全部落在其并集内",
      "  --json <路径>     结构化报告落盘（差异像素坐标、聚类、越界明细）",
      "  --threshold <n>   像素色差阈值，默认 0.2（与仓库 toHaveScreenshot 基线一致）",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const positional = [];
  const allow = [];
  let jsonPath = null;
  let threshold = 0.2;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--allow") {
      const raw = argv[++i];
      const parts = String(raw ?? "").split(",").map((v) => Number(v.trim()));
      if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v) || v < 0) || parts[2] === 0 || parts[3] === 0) {
        throw new Error(`--allow 需要 x,y,w,h 四个非负数且 w/h 非零，收到「${raw}」`);
      }
      allow.push({ x: parts[0], y: parts[1], w: parts[2], h: parts[3] });
    } else if (arg === "--json") {
      jsonPath = argv[++i];
      if (!jsonPath) throw new Error("--json 需要报告路径");
    } else if (arg === "--threshold") {
      threshold = Number(argv[++i]);
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        throw new Error("--threshold 需要 0~1 的数");
      }
    } else if (arg.startsWith("--")) {
      throw new Error(`未知参数「${arg}」`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) throw new Error("需要基准图与实际图两个路径参数");
  return { baselinePath: positional[0], actualPath: positional[1], allow, jsonPath, threshold };
}

function loadPng(path) {
  try {
    return PNG.sync.read(readFileSync(path));
  } catch (error) {
    throw new Error(`无法读取或解码 PNG「${path}」：${error.message}`);
  }
}

/** 差异像素聚类：按网格桶归并，输出每桶包围盒与像素数（降序）。 */
function clusterDiffPixels(diffPixels) {
  const buckets = new Map();
  for (const { x, y } of diffPixels) {
    const key = `${Math.floor(x / BUCKET_SIZE)},${Math.floor(y / BUCKET_SIZE)}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { minX: x, minY: y, maxX: x, maxY: y, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.minX = Math.min(bucket.minX, x);
    bucket.minY = Math.min(bucket.minY, y);
    bucket.maxX = Math.max(bucket.maxX, x);
    bucket.maxY = Math.max(bucket.maxY, y);
    bucket.count += 1;
  }
  return [...buckets.values()]
    .map((b) => ({ x: b.minX, y: b.minY, w: b.maxX - b.minX + 1, h: b.maxY - b.minY + 1, pixels: b.count }))
    .sort((a, b) => b.pixels - a.pixels);
}

function boundingBox(pixels) {
  if (pixels.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { x, y } of pixels) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

const inAnyAllowRegion = (allow) => (p) =>
  allow.some((r) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h);

const formatBox = (b) => (b ? `(${b.x},${b.y}) ${b.w}×${b.h}` : "无");

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage();
    console.error(`错误：${error.message}`);
    process.exit(2);
  }

  let baseline;
  let actual;
  try {
    baseline = loadPng(args.baselinePath);
    actual = loadPng(args.actualPath);
  } catch (error) {
    console.error(`错误：${error.message}`);
    process.exit(2);
  }

  console.log(`── visual-review 审图`);
  console.log(`   基准：${args.baselinePath}（${baseline.width}×${baseline.height}）`);
  console.log(`   实际：${args.actualPath}（${actual.width}×${actual.height}）`);

  // 尺寸不一致：把两图对齐到共同画布，超出的部分整体计为差异（显式报告，不算用法错误）。
  const width = Math.max(baseline.width, actual.width);
  const height = Math.max(baseline.height, actual.height);
  const sizeMismatch = baseline.width !== actual.width || baseline.height !== actual.height;
  if (sizeMismatch) {
    console.log(`   尺寸不一致：基准 ${baseline.width}×${baseline.height} vs 实际 ${actual.width}×${actual.height}，超出部分整体计入差异`);
  }
  const baseData = new Uint8Array(width * height * 4);
  const actualData = new Uint8Array(width * height * 4);
  for (let y = 0; y < baseline.height; y += 1) {
    baseData.set(baseline.data.subarray(y * baseline.width * 4, (y + 1) * baseline.width * 4), y * width * 4);
  }
  for (let y = 0; y < actual.height; y += 1) {
    actualData.set(actual.data.subarray(y * actual.width * 4, (y + 1) * actual.width * 4), y * width * 4);
  }

  // pixelmatch 只返回数量；逐像素坐标让它写 diff 图，再读标红（255,0,0）的像素得到。
  const diffImage = new PNG({ width, height });
  const mismatchCount = pixelmatch(baseData, actualData, diffImage.data, width, height, { threshold: args.threshold });
  const diffPixels = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      // pixelmatch 差异像素标红（255,0,0）；非差异输出为灰度底图
      if (diffImage.data[idx] === 255 && diffImage.data[idx + 1] === 0 && diffImage.data[idx + 2] === 0) {
        diffPixels.push({ x, y });
      }
    }
  }

  const total = width * height;
  const ratio = diffPixels.length / total;
  const overall = boundingBox(diffPixels);
  const regions = clusterDiffPixels(diffPixels);

  let verdict;
  let outOfBounds = [];
  if (diffPixels.length === 0) {
    verdict = "PASS：零差异";
  } else if (args.allow.length === 0) {
    verdict = "DIFF：存在差异（未给 --allow 预期区域，仅报告不定性）";
  } else {
    const inside = inAnyAllowRegion(args.allow);
    outOfBounds = diffPixels.filter((p) => !inside(p));
    verdict =
      outOfBounds.length === 0
        ? "PASS：差异全部落在预期区域内"
        : "FAIL：差异超出预期区域";
  }

  console.log(`   差异像素：${diffPixels.length} / ${total}（${(ratio * 100).toFixed(3)}%），pixelmatch 计数校验 ${mismatchCount === diffPixels.length ? "一致" : `不一致（${mismatchCount}）`}`);
  console.log(`   差异总包围盒：${formatBox(overall)}`);
  console.log(`   差异聚类（${BUCKET_SIZE}px 网格桶，共 ${regions.length} 桶，按像素数降序）：`);
  for (const region of regions.slice(0, MAX_BUCKETS_IN_TEXT)) {
    console.log(`     (${region.x},${region.y}) ${region.w}×${region.h} — ${region.pixels} 像素`);
  }
  if (regions.length > MAX_BUCKETS_IN_TEXT) {
    console.log(`     …其余 ${regions.length - MAX_BUCKETS_IN_TEXT} 桶见 JSON 报告`);
  }
  if (args.allow.length > 0) {
    console.log(`   预期区域：${args.allow.map((r) => `(${r.x},${r.y}) ${r.w}×${r.h}`).join("；")}`);
    if (outOfBounds.length > 0) {
      console.log(`   越界像素：${outOfBounds.length}，越界包围盒：${formatBox(boundingBox(outOfBounds))}`);
    }
  }
  console.log(`   结论：${verdict}`);

  if (args.jsonPath) {
    const report = {
      baseline: { path: resolve(args.baselinePath), width: baseline.width, height: baseline.height },
      actual: { path: resolve(args.actualPath), width: actual.width, height: actual.height },
      threshold: args.threshold,
      sizeMismatch,
      diffPixelCount: diffPixels.length,
      diffRatio: ratio,
      diffBoundingBox: overall,
      diffRegions: regions,
      allowRegions: args.allow,
      outOfBoundsCount: outOfBounds.length,
      outOfBoundsBoundingBox: boundingBox(outOfBounds),
      verdict,
    };
    mkdirSync(dirname(resolve(args.jsonPath)), { recursive: true });
    writeFileSync(args.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`   报告：${resolve(args.jsonPath)}`);
  }

  process.exit(outOfBounds.length > 0 ? 1 : 0);
}

main();
