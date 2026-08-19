import { cloneElement, createElement, isValidElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Options as ReactMarkdownOptions } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { remarkCitationMarkers } from "../features/research-session/remark-citation-markers";

/** MarkdownContent 与所有定位逻辑共享的解析/清洗管线。 */
export const markdownRemarkPlugins: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = [remarkGfm, remarkBreaks, remarkCitationMarkers];

/** rehype-sanitize 默认 schema 上的安全扩展：放行 cite-marker 与内联容器标签。 */
export const markdownSafeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "cite-marker", "del", "input"],
  attributes: {
    ...defaultSchema.attributes,
    "cite-marker": ["data-source-ordinal", "class", "role", "tabindex", "aria-label", "aria-expanded", "aria-describedby"],
  },
};

export const markdownRehypePlugins: NonNullable<ReactMarkdownOptions["rehypePlugins"]> = [[rehypeSanitize, markdownSafeSchema]];

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

/** 只作为 ReactMarkdown 解析结果中的可识别边界，不真正渲染。 */
function ProjectionCitationBoundary() {
  return null;
}

/**
 * 使用与 MarkdownContent 完全相同的 ReactMarkdown/GFM/换行/引用/清洗管线，
 * 读取它将交给 React 的文本子节点。这样列表、引用、代码、表格、图片等格式
 * 不需要在定位层维护第二套 Markdown 解释器。
 */
export function projectMarkdownVisibleText(source: string): MarkdownVisibleProjection {
  const tree = ReactMarkdown({
    children: source,
    remarkPlugins: [...markdownRemarkPlugins],
    rehypePlugins: [...markdownRehypePlugins],
    components: { "cite-marker": ProjectionCitationBoundary } as ReactMarkdownOptions["components"],
  });
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

/**
 * 在 ReactMarkdown 交给 React 之前，按同一可见文字偏移组合定位 mark 与术语按钮。
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
