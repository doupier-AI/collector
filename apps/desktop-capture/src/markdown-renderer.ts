/**
 * Markdown 渲染器 — 将原始 Markdown 转为安全的 HTML
 *
 * 基于 marked 解析 + 白名单 sanitizer，不依赖 DOMPurify 以控制体积。
 */

import { marked } from "marked";

// ── 白名单 ──────────────────────────────────────────

const ALLOWED_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "strong", "em", "del",
  "code", "pre",
  "blockquote",
  "a",
  "table", "thead", "tbody", "tr", "th", "td",
  "br", "hr",
  "img", "span",
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a:    new Set(["href", "class"]),
  img:  new Set(["src", "alt", "class"]),
};

const GLOBAL_ATTRS = new Set(["class"]);

// ── Sanitizer ───────────────────────────────────────

/**
 * 白名单 HTML sanitizer。
 * 1. 移除 <script> / <style> 及其内容
 * 2. 移除不在白名单中的标签（保留内联子节点）
 * 3. 移除不在白名单中的属性
 * 4. 移除 on* 事件处理属性
 * 5. 清理 href 中的 javascript: 协议
 */
function sanitize(html: string): string {
  // 1) 剥离 <script> 和 <style> 块（含内容）
  let out = html.replace(/<script[\s>][\s\S]*?<\/script\s*>/gi, "");
  out = out.replace(/<style[\s>][\s\S]*?<\/style\s*>/gi, "");

  // 2) 处理所有标签
  out = out.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g, (full, tag) => {
    const lower = tag.toLowerCase();

    // 不在白名单 → 剥离标签本身（保留内容）
    if (!ALLOWED_TAGS.has(lower)) return "";

    // 闭合标签
    if (full.startsWith("</")) return `</${lower}>`;

    // 自闭合
    if (full.endsWith("/>")) return `<${lower}/>`;

    // 开标签 — 过滤属性
    const attrAllowed = ALLOWED_ATTRS[lower] ?? GLOBAL_ATTRS;
    const cleaned = full.replace(
      /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/g,
      (attrMatch: string, attrName: string) => {
        const lowerAttr = attrName.toLowerCase();
        // 移除事件处理属性
        if (lowerAttr.startsWith("on")) return "";
        // 属性白名单
        if (!attrAllowed.has(lowerAttr)) return "";
        // 清理 javascript: 协议
        if (lowerAttr === "href") {
          const val = attrMatch.slice(attrMatch.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
          if (/^\s*javascript:/i.test(val)) return "";
        }
        return attrMatch;
      },
    );

    return cleaned.replace(/\s+/g, " ").replace(/\s+>/g, ">").replace(/\s+\/>/g, "/>");
  });

  return out;
}

// ── 公开 API ────────────────────────────────────────

/**
 * 将原始 Markdown 字符串渲染为安全的 HTML。
 *
 * @param raw - 原始 Markdown 文本
 * @returns 经过白名单过滤的 HTML 字符串
 */
export function renderMarkdown(raw: string): string {
  const html = marked.parse(raw, { async: false }) as string;
  return sanitize(html);
}
