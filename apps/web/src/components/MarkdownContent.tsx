import { type ReactNode, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { ResearchCitationRecord, ResearchGroundingSourceRecord } from "@collector/capture-contracts";
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
export function MarkdownContent({ text, sources = [], citations = [], variant = "message", className }: MarkdownContentProps) {
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

  return (
    <div className={`${rootClass}${className ? ` ${className}` : ""}`}>
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
