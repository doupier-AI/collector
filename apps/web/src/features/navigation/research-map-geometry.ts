export interface MapPoint { x: number; y: number; }
export interface MapViewBox { x: number; y: number; width: number; height: number; }

export interface SvgScreenMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** 把浏览器屏幕坐标通过 SVG 的真实 screen CTM 逆变换到用户坐标。 */
export function screenPointToSvgPoint(matrix: SvgScreenMatrix, point: MapPoint): MapPoint | undefined {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (Math.abs(determinant) < Number.EPSILON) return undefined;
  const translatedX = point.x - matrix.e;
  const translatedY = point.y - matrix.f;
  return {
    x: (matrix.d * translatedX - matrix.c * translatedY) / determinant,
    y: (-matrix.b * translatedX + matrix.a * translatedY) / determinant,
  };
}

export function svgPointFromClient(svg: SVGSVGElement, clientX: number, clientY: number): MapPoint | undefined {
  if (typeof svg.getScreenCTM !== "function") return undefined;
  const matrix = svg.getScreenCTM();
  return matrix ? screenPointToSvgPoint(matrix, { x: clientX, y: clientY }) : undefined;
}

export function screenBoundedUserFontSize(screenScale: number, preferredScreenPixels = 13): number {
  const readableScreenPixels = Math.max(11, Math.min(14, preferredScreenPixels));
  return readableScreenPixels / Math.max(0.001, Math.abs(screenScale));
}

export function fitViewBoxToPoints(
  points: Iterable<MapPoint>,
  aspectRatio: number,
  horizontalPadding = 180,
  verticalPadding = 160,
): MapViewBox {
  const values = [...points];
  const ratio = Number.isFinite(aspectRatio) ? Math.max(0.1, Math.min(10, aspectRatio)) : 16 / 9;
  if (!values.length) {
    const height = Math.max(220, 320 / ratio);
    return { x: 0, y: 0, width: height * ratio, height };
  }
  const minX = Math.min(...values.map(({ x }) => x));
  const maxX = Math.max(...values.map(({ x }) => x));
  const minY = Math.min(...values.map(({ y }) => y));
  const maxY = Math.max(...values.map(({ y }) => y));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const contentWidth = maxX - minX + horizontalPadding;
  const contentHeight = maxY - minY + verticalPadding;
  let width = Math.max(320, contentWidth, contentHeight * ratio);
  let height = width / ratio;
  if (height < Math.max(220, contentHeight)) {
    height = Math.max(220, contentHeight);
    width = height * ratio;
  }
  return { x: centerX - width / 2, y: centerY - height / 2, width, height };
}

/**
 * 在不缩小真实 SVG 画布的前提下，把内容拟合进右侧浮层之外的可见区域。
 * 返回的 viewBox 仍保持完整画布宽高比；右侧扩出的用户坐标只落在浮层下方。
 */
export function fitViewBoxToPointsWithRightInset(
  points: Iterable<MapPoint>,
  aspectRatio: number,
  rightInsetRatio: number,
  horizontalPadding = 180,
  verticalPadding = 160,
): MapViewBox {
  const visibleWidthRatio = 1 - Math.max(0, Math.min(0.75, rightInsetRatio));
  const visible = fitViewBoxToPoints(
    points,
    aspectRatio * visibleWidthRatio,
    horizontalPadding,
    verticalPadding,
  );
  return { ...visible, width: visible.width / visibleWidthRatio };
}
