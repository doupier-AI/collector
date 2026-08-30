import { type ReactNode, useMemo, useRef } from "react";
import "katex/dist/katex.min.css";
import type { ResearchCitationRecord, ResearchGroundingSourceRecord, TermMarker } from "@collector/capture-contracts";
import { CitationMarker } from "./CitationMarker";
import { buildCitationIndex, buildSourceMap } from "../features/research-session/citation-utils";
import {
  projectMarkdownReact,
  projectMarkdownVisibleText,
  renderMarkdownVisibleHighlights,
  type MarkdownVisibleHighlight,
  type MarkdownVisibleTerm,
} from "./markdown-projection";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "cite-marker": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        "data-source-ordinal"?: string;
      };
    }
  }
}

export interface MarkdownContentProps {
  text: string;
  sources?: readonly ResearchGroundingSourceRecord[];
  citations?: readonly ResearchCitationRecord[];
  terms?: readonly RenderedTermMarker[];
  variant?: "message" | "insight";
  className?: string;
  /**
   * 语义卡片标题锚点 id。设置后，正文中第一个标题元素被提升为卡片标题
   * （挂 slice-card__title 样式与该 id，供章节导航 scrollIntoView 定位），
   * 其余标题保持默认样式。标题字符仍在正文文本内，选区/术语偏移不受影响。
   */
  titleAnchorId?: string;
  /** 已投影到 Markdown 可见文字空间的只读定位范围。 */
  highlights?: readonly MarkdownVisibleHighlight[];
}

/** 合并渲染多个正文块时的视图偏移；持久化锚点仍保留在 TermMarker 原字段。 */
export type RenderedTermMarker = TermMarker & {
  renderedStartOffset?: number;
  renderedEndOffset?: number;
};

const EMPTY_MARKDOWN_PROJECTION = { text: "", citationBoundaries: [] } as const;

/**
 * 把 AI 生成的 Markdown 文本渲染为安全 HTML。
 * - 安全白名单（不开 rehype-raw，模型输出的 <script> 被转义）
 * - [来源n] 由共享投影适配为可悬停 CitationMarker
 * - variant="insight" 用于术语预览和推理摘要等紧凑辅助内容
 */
export function MarkdownContent({ text, sources = [], citations = [], terms = [], variant = "message", className, titleAnchorId, highlights = [] }: MarkdownContentProps) {
  const sourceById = useMemo(() => buildSourceMap(sources), [sources]);
  const citationIndexById = useMemo(() => buildCitationIndex(citations), [citations]);
  // 仅提升"第一个"标题为卡片标题；用 ref 计数，每次共享投影渲染前重置。
  const promotedTitleRef = useRef(false);
  promotedTitleRef.current = false;

  // 按 source ordinal → 引用记录（用于 cite-marker 根据 data-source-ordinal 查找来源）
  const citationByOrdinal = useMemo(() => {
    const map = new Map<number, ResearchCitationRecord[]>();
    for (const c of citations) {
      const source = sourceById.get(c.sourceId);
      if (!source) continue;
      const list = map.get(source.ordinal);
      if (list) list.push(c);
      else map.set(source.ordinal, [c]);
    }
    return map;
  }, [citations, sourceById]);

  const rootClass = variant === "insight" ? "markdown-content markdown-content--insight" : "markdown-content";
  const projection = useMemo(
    () => (highlights.length === 0 && terms.length === 0 ? EMPTY_MARKDOWN_PROJECTION : projectMarkdownVisibleText(text)),
    [highlights.length, terms.length, text],
  );
  const validHighlights = useMemo(() => {
    if (highlights.length === 0) return [];
    return highlights.filter((highlight) =>
      Number.isSafeInteger(highlight.start) &&
      Number.isSafeInteger(highlight.end) &&
      highlight.start >= 0 &&
      highlight.end > highlight.start &&
      highlight.end <= projection.text.length &&
      projection.text.slice(highlight.start, highlight.end) === highlight.exact,
    );
  }, [highlights, projection.text]);
  const visibleTerms = useMemo(() => (
    terms
      .filter((term) => isValidTermMarker(text, term))
      .sort((left, right) => renderedStart(left) - renderedStart(right) || renderedEnd(left) - renderedEnd(right))
      .flatMap<MarkdownVisibleTerm>((term) => {
        // 同名术语按"源文本第 N 次出现"对应"渲染可见文字第 N 次出现"定位。渲染器随后
        // 在 React 树中排除链接、按钮和代码节点，保持既有不可交互区域的丢弃语义。
        const occurrence = countOccurrences(text.slice(0, renderedStart(term)), term.text);
        const start = findOccurrence(projection.text, term.text, occurrence);
        if (start < 0) return [];
        return [{
          start,
          end: start + term.text.length,
          text: term.text,
          category: term.category,
          blockOrdinal: term.blockOrdinal,
          sourceStartOffset: term.startOffset,
          sourceEndOffset: term.endOffset,
        }];
      })
  ), [projection.text, terms, text]);
  const components = {
    // 产品安全边界不加载模型或正文提供的任意远程图片；保留可读、可复制的替代文字。
    img: ({ alt }: React.ImgHTMLAttributes<HTMLImageElement>): ReactNode => (
      alt ? <span className="markdown-image-fallback">{`[图片：${alt}]`}</span> : null
    ),
    "cite-marker": ({ "data-source-ordinal": ordinalStr }: Record<string, unknown>): ReactNode => {
      const ordinal = Number(ordinalStr);
      const citation = (citationByOrdinal.get(ordinal) ?? [])[0];
      if (!citation || Number.isNaN(ordinal)) return null;
      const source = sourceById.get(citation.sourceId);
      // #98：过滤后的来源数组可能只剩 2、5、7；角标必须沿用来源原始序号，
      // 不能再按当前消息内引用的数组位置从 1 重新编号。
      const index = source?.ordinal ?? citationIndexById.get(citation.id) ?? ordinal;
      return <CitationMarker index={index} citation={citation} source={source} />;
    },
    // 卡片标题提升：正文首个标题（## / ###…）成为卡片大标题并挂导航锚点。
    ...(titleAnchorId ? buildPromotedHeadingComponents(titleAnchorId, promotedTitleRef) : {}),
  } as Record<string, React.ComponentType<any>>;
  const markdownTree = projectMarkdownReact(text, components).tree;
  const renderedTree = renderMarkdownVisibleHighlights(markdownTree, validHighlights, visibleTerms);

  return (
    <div className={`${rootClass}${className ? ` ${className}` : ""}`}>
      {renderedTree}
    </div>
  );
}

/**
 * 生成 h1–h6 的渲染器：正文里第一个标题被提升为卡片标题（挂 anchorId 与 slice-card__title
 * 样式，但保留原 heading 标签层级，字符与文本节点不变）；其后的标题用默认渲染。
 * 只在切片卡片正文（titleAnchorId 存在）时启用。
 */
function buildPromotedHeadingComponents(
  anchorId: string,
  promotedRef: { current: boolean },
): Record<string, React.ComponentType<any>> {
  const makeRenderer = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") => {
    function PromotedHeading({ children, ...rest }: React.HTMLAttributes<HTMLHeadingElement> & { children?: ReactNode }) {
      if (!promotedRef.current) {
        promotedRef.current = true;
        return (
          <Tag id={anchorId} className="slice-card__title" {...rest}>
            {children}
          </Tag>
        );
      }
      return <Tag {...rest}>{children}</Tag>;
    }
    return PromotedHeading;
  };
  return {
    h1: makeRenderer("h1"),
    h2: makeRenderer("h2"),
    h3: makeRenderer("h3"),
    h4: makeRenderer("h4"),
    h5: makeRenderer("h5"),
    h6: makeRenderer("h6"),
  };
}

function isValidTermMarker(text: string, marker: RenderedTermMarker): boolean {
  const startOffset = renderedStart(marker);
  const endOffset = renderedEnd(marker);
  return (
    marker.text.length > 0 &&
    Number.isSafeInteger(startOffset) &&
    Number.isSafeInteger(endOffset) &&
    startOffset >= 0 &&
    endOffset > startOffset &&
    endOffset <= text.length &&
    text.slice(startOffset, endOffset) === marker.text
  );
}

function renderedStart(marker: RenderedTermMarker): number {
  return marker.renderedStartOffset ?? marker.startOffset;
}

function renderedEnd(marker: RenderedTermMarker): number {
  return marker.renderedEndOffset ?? marker.endOffset;
}

/** 源文本中 needle 在 haystack 里的不重叠出现次数（与渲染侧逐个出现的计数口径一致）。 */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return count;
    count += 1;
    from = index + needle.length;
  }
}

function findOccurrence(haystack: string, needle: string, occurrenceIndex: number): number {
  if (!needle) return -1;
  let index = -1;
  let from = 0;
  for (let seen = 0; seen <= occurrenceIndex; seen += 1) {
    index = haystack.indexOf(needle, from);
    if (index < 0) return -1;
    from = index + needle.length;
  }
  return index;
}
