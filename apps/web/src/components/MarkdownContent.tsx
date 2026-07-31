import { type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { ResearchCitationRecord, ResearchGroundingSourceRecord, TermMarker } from "@collector/capture-contracts";
import { CitationMarker } from "./CitationMarker";
import { remarkCitationMarkers } from "../features/research-session/remark-citation-markers";
import { buildCitationIndex, buildSourceMap } from "../features/research-session/citation-utils";

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
  terms?: readonly TermMarker[];
  variant?: "message" | "insight";
  className?: string;
}

/**
 * 把 AI 生成的 Markdown 文本渲染为安全 HTML。
 * - 安全白名单（不开 rehype-raw，模型输出的 <script> 被转义）
 * - [来源n] 由 remark 插件转为可悬停 CitationMarker
 * - variant="insight" 时适用较简洁排版
 * - 对极速流式更新做 useMemo 防止闪烁
 */
export function MarkdownContent({ text, sources = [], citations = [], terms = [], variant = "message", className }: MarkdownContentProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sourceById = useMemo(() => buildSourceMap(sources), [sources]);
  const citationIndexById = useMemo(() => buildCitationIndex(citations), [citations]);

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
    let searchFrom = 0;
    const validTerms = terms
      .filter((term) => isValidTermMarker(text, term))
      .sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset);

    for (const term of validTerms) {
      const match = findRenderedTextRange(root, term.text, searchFrom);
      if (!match || !wrapTermRange(root, match, term)) continue;
      searchFrom = match.endOffset;
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
            const citation = (citationByOrdinal.get(ordinal) ?? [])[0];
            if (!citation || Number.isNaN(ordinal)) return null;
            const index = citationIndexById.get(citation.id) ?? ordinal;
            const source = sourceById.get(citation.sourceId);
            return <CitationMarker index={index} citation={citation} source={source} />;
          },
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

interface RenderedTextRange {
  start: TextPoint;
  end: TextPoint;
  endOffset: number;
}

function isValidTermMarker(text: string, marker: TermMarker): boolean {
  return (
    marker.text.length > 0 &&
    Number.isSafeInteger(marker.startOffset) &&
    Number.isSafeInteger(marker.endOffset) &&
    marker.startOffset >= 0 &&
    marker.endOffset > marker.startOffset &&
    marker.endOffset <= text.length &&
    text.slice(marker.startOffset, marker.endOffset) === marker.text
  );
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

function findRenderedTextRange(root: Element, needle: string, fromOffset: number): RenderedTextRange | undefined {
  if (!needle) return undefined;
  const nodes = renderedTextNodes(root);
  const visibleText = nodes.map((node) => node.data).join("");
  const startOffset = visibleText.indexOf(needle, fromOffset);
  if (startOffset < 0) return undefined;
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
function wrapTermRange(root: Element, rendered: RenderedTextRange, term: TermMarker): boolean {
  try {
    const range = root.ownerDocument.createRange();
    range.setStart(rendered.start.node, rendered.start.offset);
    range.setEnd(rendered.end.node, rendered.end.offset);
    const marker = root.ownerDocument.createElement("span");
    marker.className = "term-marker";
    marker.setAttribute("data-term-marker", "");
    marker.setAttribute("data-term-category", term.category);
    marker.setAttribute("data-term-text", term.text);
    marker.setAttribute("data-term-block-ordinal", String(term.blockOrdinal));
    marker.setAttribute("data-term-start-offset", String(term.startOffset));
    marker.setAttribute("data-term-end-offset", String(term.endOffset));
    marker.setAttribute("role", "button");
    marker.setAttribute("tabindex", "0");
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
