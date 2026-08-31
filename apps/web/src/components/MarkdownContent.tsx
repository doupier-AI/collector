import { type ReactNode, useMemo, useRef } from "react";
import "katex/dist/katex.min.css";
import type { ResearchGroundingSourceRecord, TermMarker } from "@collector/capture-contracts";
import { projectMarkdownDocument, projectMarkdownSourceRange } from "@collector/markdown-projection";
import { CitationMarker } from "./CitationMarker";
import { buildCitationIndex, buildSourceMap } from "../features/research-session/citation-utils";
import type { RenderedCitationRecord } from "../features/research-session/citation-utils";
import {
  projectMarkdownReact,
  projectMarkdownVisibleText,
  renderMarkdownVisibleAnnotations,
  renderMarkdownVisibleHighlights,
  type MarkdownVisibleHighlight,
  type MarkdownVisibleTerm,
} from "./markdown-projection";

export interface MarkdownContentProps {
  text: string;
  sources?: readonly ResearchGroundingSourceRecord[];
  citations?: readonly RenderedCitationRecord[];
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
 * - 引用只按当前正文版本的稳定旁路范围插入，不读取正文控制串
 * - variant="insight" 用于术语预览和推理摘要等紧凑辅助内容
 */
export function MarkdownContent({ text, sources = [], citations = [], terms = [], variant = "message", className, titleAnchorId, highlights = [] }: MarkdownContentProps) {
  const sourceById = useMemo(() => buildSourceMap(sources), [sources]);
  const citationIndexById = useMemo(() => buildCitationIndex(citations), [citations]);
  // 仅提升"第一个"标题为卡片标题；用 ref 计数，每次共享投影渲染前重置。
  const promotedTitleRef = useRef(false);
  promotedTitleRef.current = false;

  const rootClass = variant === "insight" ? "markdown-content markdown-content--insight" : "markdown-content";
  const projection = useMemo(
    () => (highlights.length === 0 && terms.length === 0 ? EMPTY_MARKDOWN_PROJECTION : projectMarkdownVisibleText(text)),
    [highlights.length, terms.length, text],
  );
  const locationProjection = useMemo(
    () => (terms.length === 0 && citations.length === 0 ? undefined : projectMarkdownDocument(text)),
    [citations.length, terms.length, text],
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
        const mapped = locationProjection && projectMarkdownSourceRange(locationProjection, {
          start: renderedStart(term),
          end: renderedEnd(term),
        });
        if (!mapped || mapped.exact !== term.text
          || projection.text.slice(mapped.visibleRange.start, mapped.visibleRange.end) !== term.text) return [];
        return [{
          start: mapped.visibleRange.start,
          end: mapped.visibleRange.end,
          text: term.text,
          category: term.category,
          blockOrdinal: term.blockOrdinal,
          sourceStartOffset: term.startOffset,
          sourceEndOffset: term.endOffset,
        }];
      })
  ), [locationProjection, projection.text, terms, text]);
  const components = {
    // 产品安全边界不加载模型或正文提供的任意远程图片；保留可读、可复制的替代文字。
    img: ({ alt }: React.ImgHTMLAttributes<HTMLImageElement>): ReactNode => (
      alt ? <span className="markdown-image-fallback">{`[图片：${alt}]`}</span> : null
    ),
    // 卡片标题提升：正文首个标题（## / ###…）成为卡片大标题并挂导航锚点。
    ...(titleAnchorId ? buildPromotedHeadingComponents(titleAnchorId, promotedTitleRef) : {}),
  } as Record<string, React.ComponentType<any>>;
  const markdownTree = projectMarkdownReact(text, components).tree;
  const citationAnnotations = citations.flatMap((citation) => {
    if (!locationProjection || citation.renderedStartOffset < 0
      || citation.renderedEndOffset <= citation.renderedStartOffset
      || citation.renderedEndOffset > text.length) return [];
    const mapped = projectMarkdownSourceRange(locationProjection, {
      start: citation.renderedStartOffset,
      end: citation.renderedEndOffset,
    });
    if (!mapped) return [];
    const source = sourceById.get(citation.sourceId);
    // 过滤后的来源可能只剩 2、5、7；可用来源沿用原始序号。来源记录失效时
    // 使用当前消息内的稳定引用序号，并通过来源区给出明确降级说明。
    const index = source?.ordinal ?? citation.displayIndex ?? citationIndexById.get(citation.id) ?? 1;
    return [{
      offset: mapped.visibleRange.end,
      key: `citation-marker-${citation.id}`,
      node: <CitationMarker index={index} citation={citation} source={source} />,
    }];
  });
  const annotatedTree = renderMarkdownVisibleAnnotations(markdownTree, citationAnnotations);
  const renderedTree = renderMarkdownVisibleHighlights(annotatedTree, validHighlights, visibleTerms);

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
