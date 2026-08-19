import { isValidElement, type ReactNode } from "react";
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
