import { cloneElement, createElement, isValidElement, type ComponentType, type ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { Element, Root, RootContent, Text } from "hast";
import { projectMarkdownDocument, type MarkdownProjectionNode } from "@collector/markdown-projection";

export interface MarkdownVisibleProjection {
  /** 与 MarkdownContent 实际 DOM textContent 一致、但不包含零文本来源角标的正文。 */
  text: string;
  /** 来源角标在可见正文空间中的零宽位置；高亮不得跨过这些位置。 */
  citationBoundaries: number[];
}

export interface MarkdownVisibleHighlight {
  start: number;
  end: number;
  exact: string;
}

export interface MarkdownVisibleTerm {
  start: number;
  end: number;
  text: string;
  category: string;
  blockOrdinal: number;
  sourceStartOffset: number;
  sourceEndOffset: number;
}

/** 只作为共享投影 React 树中的可识别边界，不真正渲染。 */
function ProjectionCitationBoundary() {
  return null;
}

export interface MarkdownReactProjection {
  tree: ReactNode;
  visible: MarkdownVisibleProjection;
}

/** 把共享安全投影适配为 React；解析、范围和渲染不再各自维护 Markdown 解释器。 */
export function projectMarkdownReact(
  source: string,
  components: Record<string, ComponentType<any>> = {},
): MarkdownReactProjection {
  const projection = projectMarkdownDocument(source);
  const hast = projectionToHast(projection.root);
  const tree = toJsxRuntime(hast, {
    Fragment,
    jsx,
    jsxs,
    passKeys: true,
    components: { "cite-marker": ProjectionCitationBoundary, ...components },
  });
  return { tree, visible: visibleProjection(tree) };
}

export function projectMarkdownVisibleText(source: string): MarkdownVisibleProjection {
  return projectMarkdownReact(source).visible;
}

function visibleProjection(tree: ReactNode): MarkdownVisibleProjection {
  let text = "";
  const citationBoundaries: number[] = [];
  const visit = (node: ReactNode): void => {
    if (typeof node === "string" || typeof node === "number") {
      text += String(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isValidElement<{ children?: ReactNode }>(node)) return;
    if (node.type === ProjectionCitationBoundary) {
      citationBoundaries.push(text.length);
      return;
    }
    visit(node.props.children);
  };
  visit(tree);
  return { text, citationBoundaries };
}

function projectionToHast(node: MarkdownProjectionNode): Root {
  return { type: "root", children: node.children.flatMap((child) => projectionChildren(child, true)) };
}

const CITATION_TOKEN = /\[来源(\d+)\]/g;

function projectionChildren(node: MarkdownProjectionNode, citationsAllowed: boolean): RootContent[] {
  if (node.kind === "text") {
    const value = node.value ?? "";
    if (!citationsAllowed) return [{ type: "text", value } satisfies Text];
    const children: RootContent[] = [];
    let cursor = 0;
    CITATION_TOKEN.lastIndex = 0;
    for (const match of value.matchAll(CITATION_TOKEN)) {
      if (match.index > cursor) children.push({ type: "text", value: value.slice(cursor, match.index) });
      children.push({
        type: "element",
        tagName: "cite-marker",
        properties: { "data-source-ordinal": match[1] ?? "" },
        children: [],
      } as Element);
      cursor = match.index + match[0].length;
    }
    if (cursor < value.length) children.push({ type: "text", value: value.slice(cursor) });
    return children;
  }
  if (node.kind !== "element" || !node.tagName) return [];
  const allowChildren = citationsAllowed && node.tagName !== "code" && node.tagName !== "pre";
  return [{
    type: "element",
    tagName: node.tagName,
    properties: { ...(node.properties ?? {}) },
    children: node.children.flatMap((child) => projectionChildren(child, allowChildren)),
  } as Element];
}

/**
 * 在共享投影交给 React 之前，按同一可见文字偏移组合定位 mark 与术语按钮。
 *
 * 旧实现会在 useLayoutEffect 中用 DOM Range 搬动已经由 React 管理的标题、段落和
 * 弱标记节点；高亮到期后 React 按原树恢复时会因父子关系已被改写而崩溃。
 * 这里始终返回 React 自己拥有的节点树，格式节点与零文本引用角标都留在原位；术语在
 * 链接、按钮和代码内继续按既有规则丢弃，避免生成嵌套交互控件。
 */
export function renderMarkdownVisibleHighlights(
  tree: ReactNode,
  highlights: readonly MarkdownVisibleHighlight[],
  terms: readonly MarkdownVisibleTerm[] = [],
): ReactNode {
  if (highlights.length === 0 && terms.length === 0) return tree;
  const sorted = [...highlights].sort((left, right) => left.start - right.start || left.end - right.end);
  const sortedTerms = [...terms].sort((left, right) => left.start - right.start || left.end - right.end);
  let visibleOffset = 0;
  let markOrdinal = 0;
  let termOrdinal = 0;

  const highlightedSlice = (value: string, nodeStart: number, start: number, end: number): ReactNode => {
    const overlaps = sorted.filter((highlight) => highlight.start < nodeStart + end && highlight.end > nodeStart + start);
    if (overlaps.length === 0) return value.slice(start, end);

    const pieces: ReactNode[] = [];
    let localOffset = start;
    for (const highlight of overlaps) {
      const highlightStart = Math.max(highlight.start - nodeStart, start);
      const highlightEnd = Math.min(highlight.end - nodeStart, end);
      if (highlightStart > localOffset) pieces.push(value.slice(localOffset, highlightStart));
      if (highlightEnd > highlightStart) {
        pieces.push(createElement(
          "mark",
          { className: "selection-mark", "data-selection-mark": "", key: `selection-mark-${markOrdinal++}` },
          value.slice(highlightStart, highlightEnd),
        ));
      }
      localOffset = Math.max(localOffset, highlightEnd);
    }
    if (localOffset < end) pieces.push(value.slice(localOffset, end));
    return pieces;
  };

  const visit = (node: ReactNode, termBlocked = false): ReactNode => {
    if (typeof node === "string" || typeof node === "number") {
      const value = String(node);
      const nodeStart = visibleOffset;
      const nodeEnd = nodeStart + value.length;
      visibleOffset = nodeEnd;
      const localTerms = termBlocked
        ? []
        : sortedTerms.filter((term) => term.start >= nodeStart && term.end <= nodeEnd);
      if (localTerms.length === 0) return highlightedSlice(value, nodeStart, 0, value.length);

      const pieces: ReactNode[] = [];
      let localOffset = 0;
      for (const term of localTerms) {
        const start = term.start - nodeStart;
        const end = term.end - nodeStart;
        if (start < localOffset || end <= start) continue;
        if (start > localOffset) pieces.push(highlightedSlice(value, nodeStart, localOffset, start));
        pieces.push(createElement(
          "button",
          {
            type: "button",
            className: "term-marker",
            "data-term-marker": "",
            "data-term-category": term.category,
            "data-term-text": term.text,
            "data-term-block-ordinal": String(term.blockOrdinal),
            "data-term-start-offset": String(term.sourceStartOffset),
            "data-term-end-offset": String(term.sourceEndOffset),
            "aria-label": `解释术语 ${term.text}`,
            key: `term-marker-${termOrdinal++}`,
          },
          highlightedSlice(value, nodeStart, start, end),
        ));
        localOffset = end;
      }
      if (localOffset < value.length) pieces.push(highlightedSlice(value, nodeStart, localOffset, value.length));
      return pieces;
    }
    if (Array.isArray(node)) return node.map((child) => visit(child, termBlocked));
    if (!isValidElement<{ children?: ReactNode }>(node) || node.props.children === undefined) return node;
    const nodeType = typeof node.type === "string" ? node.type : undefined;
    const blocksTerms = termBlocked || nodeType === "a" || nodeType === "button" || nodeType === "code" || nodeType === "pre";
    return cloneElement(node, undefined, visit(node.props.children, blocksTerms));
  };

  return visit(tree);
}
