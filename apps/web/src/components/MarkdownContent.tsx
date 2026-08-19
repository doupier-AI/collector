import { type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { ResearchCitationRecord, ResearchFusionSource, ResearchGroundingSourceRecord, TermMarker } from "@collector/capture-contracts";
import { CitationMarker } from "./CitationMarker";
import { remarkCitationMarkers } from "../features/research-session/remark-citation-markers";
import { buildCitationIndex, buildSourceMap } from "../features/research-session/citation-utils";
import { FusionCitationMarker } from "../features/research-session/FusionCitationMarker";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "cite-marker": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        "data-source-ordinal"?: string;
      };
    }
  }
}

/** rehype-sanitize 默认 schema 上的安全扩展：放行 cite-marker 与内联容器标签。 */
const safeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "cite-marker", "del", "input"],
  attributes: {
    ...defaultSchema.attributes,
    "cite-marker": ["data-source-ordinal", "class", "role", "tabindex", "aria-label", "aria-expanded", "aria-describedby"],
  },
};

export interface MarkdownContentProps {
  text: string;
  sources?: readonly ResearchGroundingSourceRecord[];
  citations?: readonly ResearchCitationRecord[];
  terms?: readonly RenderedTermMarker[];
  /** #31：融合正文的来源列表；存在时 [来源n] 渲染为可点击的融合引用标记。 */
  fusionSources?: readonly ResearchFusionSource[];
  variant?: "message" | "insight";
  className?: string;
  /**
   * 语义卡片标题锚点 id。设置后，正文中第一个标题元素被提升为卡片标题
   * （挂 slice-card__title 样式与该 id，供章节导航 scrollIntoView 定位），
   * 其余标题保持默认样式。标题字符仍在正文文本内，选区/术语偏移不受影响。
   */
  titleAnchorId?: string;
}

/** 合并渲染多个正文块时的视图偏移；持久化锚点仍保留在 TermMarker 原字段。 */
export type RenderedTermMarker = TermMarker & {
  renderedStartOffset?: number;
  renderedEndOffset?: number;
};

/**
 * 把 AI 生成的 Markdown 文本渲染为安全 HTML。
 * - 安全白名单（不开 rehype-raw，模型输出的 <script> 被转义）
 * - [来源n] 由 remark 插件转为可悬停 CitationMarker
 * - variant="insight" 时适用较简洁排版
 * - 对极速流式更新做 useMemo 防止闪烁
 */
export function MarkdownContent({ text, sources = [], citations = [], terms = [], fusionSources, variant = "message", className, titleAnchorId }: MarkdownContentProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sourceById = useMemo(() => buildSourceMap(sources), [sources]);
  const citationIndexById = useMemo(() => buildCitationIndex(citations), [citations]);
  // 仅提升"第一个"标题为卡片标题；用 ref 计数，ReactMarkdown 每次渲染重置。
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

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    clearTermMarkers(root);
    const validTerms = terms
      .filter((term) => isValidTermMarker(text, term))
      .sort((left, right) => renderedStart(left) - renderedStart(right) || renderedEnd(left) - renderedEnd(right));

    // 同名术语按"源文本第 N 次出现"对应"渲染可见文字第 N 次出现"定位：Markdown 渲染
    // 不改变出现顺序，因此同名异义只标记其中一次、或前一次出现落在代码/链接里时，
    // 都能命中正确的可见出现，而不会错误包裹别的同名文字。
    // 已知边界：术语原文出现在链接 URL 等不可见位置时序号可能漂移（与旧顺序游标同类风险）。
    for (const term of validTerms) {
      const occurrence = countOccurrences(text.slice(0, renderedStart(term)), term.text);
      const match = findRenderedTextRange(root, term.text, occurrence);
      if (!match) continue;
      // 命中的出现落在 a/button/code/pre 内无法包裹时丢弃该标记，不再顺延包裹下一次出现。
      wrapTermRange(root, match, term);
    }
  }, [text, terms]);

  return (
    <div ref={rootRef} className={`${rootClass}${className ? ` ${className}` : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkCitationMarkers]}
        rehypePlugins={[[rehypeSanitize, safeSchema]]}
        components={{
          "cite-marker": ({ "data-source-ordinal": ordinalStr }: Record<string, unknown>): ReactNode => {
            const ordinal = Number(ordinalStr);
            // #31 融合正文：优先按来源列表渲染为融合引用（[来源n] → 来源语义片段深链）。
            if (fusionSources && fusionSources.length > 0) {
              const source = fusionSources[ordinal - 1];
              if (!source || Number.isNaN(ordinal)) return null;
              return <FusionCitationMarker source={source} />;
            }
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
        } as Record<string, React.ComponentType<any>>}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

interface TextPoint {
  node: Text;
  offset: number;
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

interface RenderedTextRange {
  start: TextPoint;
  end: TextPoint;
  endOffset: number;
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

/** 读取 Markdown 渲染后的可见文字节点；引用角标没有正文，不参与术语定位。 */
function renderedTextNodes(root: Element): Text[] {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const textNode = node as Text;
    const parent = textNode.parentElement;
    if (parent?.closest("cite-marker")) continue;
    nodes.push(textNode);
  }
  return nodes;
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

/** 在渲染可见文字中取 needle 的第 occurrenceIndex 次（从 0 计）不重叠出现。 */
function findRenderedTextRange(root: Element, needle: string, occurrenceIndex: number): RenderedTextRange | undefined {
  if (!needle) return undefined;
  const nodes = renderedTextNodes(root);
  const visibleText = nodes.map((node) => node.data).join("");
  let startOffset = -1;
  let from = 0;
  for (let seen = 0; seen <= occurrenceIndex; seen += 1) {
    startOffset = visibleText.indexOf(needle, from);
    if (startOffset < 0) return undefined;
    from = startOffset + needle.length;
  }
  const endOffset = startOffset + needle.length;
  return {
    start: pointAtOffset(nodes, startOffset),
    end: pointAtOffset(nodes, endOffset),
    endOffset,
  };
}

function pointAtOffset(nodes: Text[], target: number): TextPoint {
  let offset = 0;
  for (const node of nodes) {
    const nextOffset = offset + node.data.length;
    if (target <= nextOffset) return { node, offset: target - offset };
    offset = nextOffset;
  }
  const last = nodes[nodes.length - 1];
  return { node: last, offset: last.data.length };
}

/** 用无语义的 span 包裹术语，保留原文字节点内容与 DOM 选区字符偏移。 */
function wrapTermRange(root: Element, rendered: RenderedTextRange, term: RenderedTermMarker): boolean {
  try {
    const range = root.ownerDocument.createRange();
    range.setStart(rendered.start.node, rendered.start.offset);
    range.setEnd(rendered.end.node, rendered.end.offset);
    if (rendered.start.node.parentElement?.closest("a, button, code, pre") || rendered.end.node.parentElement?.closest("a, button, code, pre")) {
      return false;
    }
    const marker = root.ownerDocument.createElement("button");
    marker.type = "button";
    marker.className = "term-marker";
    marker.setAttribute("data-term-marker", "");
    marker.setAttribute("data-term-category", term.category);
    marker.setAttribute("data-term-text", term.text);
    marker.setAttribute("data-term-block-ordinal", String(term.blockOrdinal));
    marker.setAttribute("data-term-start-offset", String(term.startOffset));
    marker.setAttribute("data-term-end-offset", String(term.endOffset));
    marker.setAttribute("aria-label", `解释术语 ${term.text}`);
    marker.appendChild(range.extractContents());
    range.insertNode(marker);
    return true;
  } catch {
    return false;
  }
}

function clearTermMarkers(root: Element): void {
  root.querySelectorAll<HTMLElement>("[data-term-marker]").forEach((marker) => {
    const parent = marker.parentNode;
    if (!parent) return;
    while (marker.firstChild) parent.insertBefore(marker.firstChild, marker);
    marker.remove();
  });
}
