import katex, { type KatexOptions } from "katex";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

export interface MarkdownRange {
  /** UTF-16 code-unit offset, matching JavaScript string offsets and browser selections. */
  start: number;
  /** Exclusive UTF-16 code-unit offset. */
  end: number;
}

export interface MarkdownProjectionNode {
  /** Stable within this projection; callers must not persist it as content identity. */
  id: string;
  kind: "root" | "element" | "text";
  /** Sanitized HTML tag name for element nodes. */
  tagName?: string;
  /** Sanitized renderer data (for example href, checked, or language class). */
  properties?: Readonly<Record<string, unknown>>;
  /** Text contributed to visibleText by text nodes. */
  value?: string;
  sourceRange: MarkdownRange;
  visibleRange: MarkdownRange;
  /** Top-level block identity shared by all descendants of that block. */
  blockId?: string;
  /** True for structural whitespace inserted by the Markdown pipeline. */
  generated?: boolean;
  children: MarkdownProjectionNode[];
}

export interface MarkdownProjectionBlock {
  id: string;
  ordinal: number;
  sourceRange: MarkdownRange;
  visibleRange: MarkdownRange;
  nodeId: string;
}

export interface MarkdownParseDiagnostic {
  severity: "warning" | "error";
  code: "raw-html-removed" | "unsafe-url-removed" | "math-render-failed" | "parse-failed";
  message: string;
  sourceRange: MarkdownRange;
}

export interface MarkdownDocumentProjection {
  source: string;
  visibleText: string;
  root: MarkdownProjectionNode;
  blocks: MarkdownProjectionBlock[];
  diagnostics: MarkdownParseDiagnostic[];
}

/** One versioned policy for every Node/browser projection consumer. */
export const MARKDOWN_PROJECTION_CONFIG = Object.freeze({
  version: 1,
  dialect: "gfm" as const,
  softBreaks: "line-break" as const,
  rawHtml: "remove" as const,
  mdx: false,
  math: "katex" as const,
  sanitizeSchema: "github-safe-v1" as const,
});

/** Explicit limits for untrusted formula input; shared by projection and Web rendering. */
export const MARKDOWN_MATH_OPTIONS = Object.freeze({
  output: "htmlAndMathml",
  throwOnError: false,
  strict: "error",
  trust: false,
  maxExpand: 1_000,
  maxSize: 20,
} satisfies KatexOptions);

/** Sanitize untrusted Markdown before KaTeX expands its trusted renderer output. */
export const MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
  },
} as typeof defaultSchema;

type PositionedNode = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: PositionedNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
};

type MarkdownSourcePoint = { line: number; column: number; offset: number };
type MarkdownSourcePointAt = (offset: number) => MarkdownSourcePoint;

function createMarkdownProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA)
    .use(rehypeMathSourceFallback)
    .use(rehypeKatex, MARKDOWN_MATH_OPTIONS);
}

let cachedProcessor: ReturnType<typeof createMarkdownProcessor> | undefined;

function markdownProcessor() {
  cachedProcessor ??= createMarkdownProcessor();
  return cachedProcessor;
}

/**
 * Parse Markdown without I/O or code execution and project one sanitized document model.
 * The function is deterministic and uses browser-compatible dependencies only.
 */
export function projectMarkdownDocument(source: string): MarkdownDocumentProjection {
  try {
    const processor = markdownProcessor();
    const parsed = processor.parse(source);
    const diagnostics = collectDiagnostics(parsed as unknown as PositionedNode, source);
    applySourcePreservingBreaks(parsed as unknown as PositionedNode, source, createSourcePointResolver(source));
    const sanitized = processor.runSync(parsed) as unknown as PositionedNode;
    collectRenderedDiagnostics(sanitized, source, diagnostics);
    return projectSanitizedTree(source, sanitized, diagnostics);
  } catch (error) {
    const range = { start: 0, end: source.length };
    const textNode: MarkdownProjectionNode = {
      id: "node:0",
      kind: "text",
      value: source,
      sourceRange: range,
      visibleRange: range,
      children: [],
    };
    return {
      source,
      visibleText: source,
      root: {
        id: "root",
        kind: "root",
        sourceRange: range,
        visibleRange: range,
        children: [textNode],
      },
      blocks: source ? [{ id: "block:0", ordinal: 0, sourceRange: range, visibleRange: range, nodeId: textNode.id }] : [],
      diagnostics: [{
        severity: "error",
        code: "parse-failed",
        message: error instanceof Error ? error.message : "Markdown parsing failed",
        sourceRange: range,
      }],
    };
  }
}

function collectRenderedDiagnostics(
  node: PositionedNode,
  source: string,
  diagnostics: MarkdownParseDiagnostic[],
): void {
  const classNames = Array.isArray(node.properties?.className) ? node.properties.className : [];
  if (classNames.includes("math-source-fallback")) {
    diagnostics.push({
      severity: "warning",
      code: "math-render-failed",
      message: "The formula is unsupported or malformed; its source is preserved.",
      sourceRange: nodeRange(node, source.length, 0),
    });
  }
  node.children?.forEach((child) => collectRenderedDiagnostics(child, source, diagnostics));
}

/**
 * Preserve the complete source for malformed, unsupported, or trust-requiring formulas.
 * This runs after sanitization and before rehype-katex, so fallback nodes are inert text.
 */
export function rehypeMathSourceFallback() {
  return (tree: PositionedNode): void => {
    replaceInvalidMathChildren(tree);
  };
}

function replaceInvalidMathChildren(parent: PositionedNode): void {
  if (!parent.children) return;
  for (let index = 0; index < parent.children.length; index += 1) {
    const child = parent.children[index]!;
    const classNames = Array.isArray(child.properties?.className) ? child.properties.className : [];
    const displayMode = classNames.includes("math-display") || (classNames.includes("language-math") && parent.tagName === "pre");
    const isMath = child.tagName === "code" && classNames.includes("language-math");
    if (isMath) {
      const source = collectNodeText(child).replace(/\n$/, "");
      if (!formulaCanRender(source, displayMode)) {
        const fallback = mathSourceFallbackNode(child, source, displayMode);
        if (displayMode && parent.tagName === "pre") {
          parent.tagName = fallback.tagName;
          parent.properties = fallback.properties;
          parent.children = fallback.children;
          return;
        }
        parent.children[index] = fallback;
        continue;
      }
    }
    replaceInvalidMathChildren(child);
  }
}

function formulaCanRender(source: string, displayMode: boolean): boolean {
  if (/\\(?:href|url|includegraphics|htmlClass|htmlId|htmlStyle|htmlData)\b/.test(source)) return false;
  try {
    katex.renderToString(source, { ...MARKDOWN_MATH_OPTIONS, displayMode, throwOnError: true });
    return true;
  } catch {
    return false;
  }
}

function mathSourceFallbackNode(node: PositionedNode, source: string, displayMode: boolean): PositionedNode {
  const code: PositionedNode = {
    type: "element",
    tagName: "code",
    properties: { className: ["math-source-fallback__code"] },
    position: node.position,
    children: [{ type: "text", value: source, position: node.position }],
  };
  return {
    type: "element",
    tagName: displayMode ? "pre" : "span",
    properties: { className: ["math-source-fallback", displayMode ? "math-source-fallback--display" : "math-source-fallback--inline"] },
    position: node.position,
    children: displayMode ? [code] : code.children,
  };
}

function collectNodeText(node: PositionedNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(collectNodeText).join("");
}

/** remark-breaks semantics with original UTF-16 offsets retained on split text nodes. */
function applySourcePreservingBreaks(node: PositionedNode, source: string, pointAt: MarkdownSourcePointAt): void {
  if (!node.children) return;
  const nextChildren: PositionedNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string" && /\r?\n|\r/.test(child.value)) {
      nextChildren.push(...splitTextAtLineBreaks(child, source, pointAt));
    } else {
      applySourcePreservingBreaks(child, source, pointAt);
      nextChildren.push(child);
    }
  }
  node.children = nextChildren;
}

function splitTextAtLineBreaks(node: PositionedNode, source: string, pointAt: MarkdownSourcePointAt): PositionedNode[] {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return [node];
  const raw = source.slice(start!, end!);
  const valueBreaks = [...(node.value ?? "").matchAll(/\r\n|\r|\n/g)];
  const rawBreaks = [...raw.matchAll(/\r\n|\r|\n/g)];
  if (valueBreaks.length !== rawBreaks.length) return [node];

  const result: PositionedNode[] = [];
  let valueCursor = 0;
  let rawCursor = 0;
  for (let index = 0; index < valueBreaks.length; index += 1) {
    const valueBreak = valueBreaks[index]!;
    const rawBreak = rawBreaks[index]!;
    const value = (node.value ?? "").slice(valueCursor, valueBreak.index);
    if (value) {
      result.push({
        type: "text",
        value,
        position: offsetPosition(pointAt, start! + rawCursor, start! + rawBreak.index),
      });
    }
    result.push({
      type: "break",
      position: offsetPosition(pointAt, start! + rawBreak.index, start! + rawBreak.index + rawBreak[0].length),
    });
    valueCursor = valueBreak.index + valueBreak[0].length;
    rawCursor = rawBreak.index + rawBreak[0].length;
  }
  const tail = (node.value ?? "").slice(valueCursor);
  if (tail) {
    result.push({ type: "text", value: tail, position: offsetPosition(pointAt, start! + rawCursor, end!) });
  }
  return result;
}

function offsetPosition(pointAt: MarkdownSourcePointAt, start: number, end: number) {
  return { start: pointAt(start), end: pointAt(end) };
}

/** Build one O(n) line index, then resolve every split point in O(log lines). */
function createSourcePointResolver(source: string): MarkdownSourcePointAt {
  const lineStarts = [0];
  for (let offset = 0; offset < source.length; offset += 1) {
    if (source[offset] === "\r") {
      if (source[offset + 1] === "\n") offset += 1;
      lineStarts.push(offset + 1);
    } else if (source[offset] === "\n") {
      lineStarts.push(offset + 1);
    }
  }
  return (offset) => {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle]! <= offset) low = middle;
      else high = middle;
    }
    return { line: low + 1, column: offset - lineStarts[low]! + 1, offset };
  };
}

function projectSanitizedTree(
  source: string,
  tree: PositionedNode,
  diagnostics: MarkdownParseDiagnostic[],
): MarkdownDocumentProjection {
  let visibleText = "";
  let nodeOrdinal = 0;
  const blocks: MarkdownProjectionBlock[] = [];

  const visit = (
    node: PositionedNode,
    inheritedBlockId: string | undefined,
    fallbackSourceOffset: number,
    topLevelOrdinal?: number,
  ): MarkdownProjectionNode => {
    const sourceRange = nodeRange(node, source.length, fallbackSourceOffset);
    const blockId = topLevelOrdinal === undefined ? inheritedBlockId : `block:${topLevelOrdinal}`;
    const visibleStart = visibleText.length;
    const id = node.type === "root" ? "root" : `node:${nodeOrdinal++}`;
    const kind = node.type === "root" ? "root" : node.type === "text" ? "text" : "element";
    const generated = node.position === undefined;

    if (node.type === "text" && typeof node.value === "string") visibleText += node.value;

    const children: MarkdownProjectionNode[] = [];
    let childFallback = sourceRange.start;
    for (const child of node.children ?? []) {
      const projected = visit(child, blockId, childFallback);
      children.push(projected);
      childFallback = projected.sourceRange.end;
    }

    const projected: MarkdownProjectionNode = {
      id,
      kind,
      ...(node.tagName ? { tagName: node.tagName } : {}),
      ...(node.properties ? { properties: cloneProperties(node.properties) } : {}),
      ...(node.type === "text" && typeof node.value === "string" ? { value: node.value } : {}),
      sourceRange,
      visibleRange: { start: visibleStart, end: visibleText.length },
      ...(blockId ? { blockId } : {}),
      ...(generated ? { generated: true } : {}),
      children,
    };

    if (topLevelOrdinal !== undefined) {
      blocks.push({
        id: blockId!,
        ordinal: topLevelOrdinal,
        sourceRange,
        visibleRange: projected.visibleRange,
        nodeId: id,
      });
    }
    return projected;
  };

  const rootRange = { start: 0, end: source.length };
  const rootChildren: MarkdownProjectionNode[] = [];
  let fallbackOffset = 0;
  let blockOrdinal = 0;
  for (const child of tree.children ?? []) {
    const isGeneratedWhitespace = child.type === "text" && child.position === undefined;
    const projected = visit(child, undefined, fallbackOffset, isGeneratedWhitespace ? undefined : blockOrdinal++);
    rootChildren.push(projected);
    fallbackOffset = projected.sourceRange.end;
  }
  const root: MarkdownProjectionNode = {
    id: "root",
    kind: "root",
    sourceRange: rootRange,
    visibleRange: { start: 0, end: visibleText.length },
    children: rootChildren,
  };
  return { source, visibleText, root, blocks, diagnostics };
}

function cloneProperties(properties: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]));
}

function nodeRange(node: PositionedNode, sourceLength: number, fallback: number): MarkdownRange {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start! >= 0 && end! >= start!) {
    return { start: Math.min(start!, sourceLength), end: Math.min(end!, sourceLength) };
  }
  const offset = Math.min(Math.max(fallback, 0), sourceLength);
  return { start: offset, end: offset };
}

function collectDiagnostics(tree: PositionedNode, source: string): MarkdownParseDiagnostic[] {
  const diagnostics: MarkdownParseDiagnostic[] = [];
  const visit = (node: PositionedNode): void => {
    const sourceRange = nodeRange(node, source.length, 0);
    if (node.type === "html") {
      diagnostics.push({
        severity: "warning",
        code: "raw-html-removed",
        message: "Raw HTML is removed by the Markdown safety policy.",
        sourceRange,
      });
    }
    if ((node.type === "link" || node.type === "image") && typeof (node as PositionedNode & { url?: unknown }).url === "string") {
      const url = (node as PositionedNode & { url: string }).url;
      if (!isSafeUrl(url)) {
        diagnostics.push({
          severity: "warning",
          code: "unsafe-url-removed",
          message: "An unsafe URL is removed by the Markdown safety policy.",
          sourceRange,
        });
      }
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return diagnostics;
}

function isSafeUrl(url: string): boolean {
  const colon = url.indexOf(":");
  const boundary = [url.indexOf("/"), url.indexOf("?"), url.indexOf("#")]
    .filter((index) => index >= 0)
    .reduce((minimum, index) => Math.min(minimum, index), Number.POSITIVE_INFINITY);
  return colon < 0 || colon > boundary || /^(https?|ircs?|mailto|xmpp)$/i.test(url.slice(0, colon));
}
