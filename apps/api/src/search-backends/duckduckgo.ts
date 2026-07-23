import type { SearchBackend } from "./types.js";
import type { WebSearchResultSet, WebSearchResult } from "../web-search-agent.js";

const DDG_URL = "https://html.duckduckgo.com/html/";
const SEARCH_TIMEOUT_MS = 10_000;

/**
 * 解析 DuckDuckGo HTML 搜索结果页面。
 * DDG 将每条结果放在 class="result__body" 的 div 中，
 * 标题在 class="result__a" 的 <a> 中，摘要放在 class="result__snippet" 中。
 */
function parseDdgHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];

  // DDG 结果格式：每条结果在 <div class="result__body"> 中
  const blockRegex = /<div[^>]*class="[^"]*result__body[^"]*"[^>]*>/gi;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRegex.exec(html)) !== null) {
    const start = blockMatch.index + blockMatch[0].length;
    const remaining = html.slice(start);
    // 找到下一个 result__body 的起始位置
    const nextBlock = remaining.search(/<div[^>]*class="[^"]*result__body[^"]*"[^>]*>/i);
    const endBlock = nextBlock > 0
      ? remaining.slice(0, nextBlock).lastIndexOf("</div>")
      : remaining.lastIndexOf("</div>");
    if (endBlock < 0) continue;
    const block = remaining.slice(0, endBlock);

    // 提取标题和 URL：<a class="result__a" href="...">标题</a>
    const titleMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const url = titleMatch[1].replace(/&amp;/g, "&").replace(/&amp;/g, "&");
    const title = stripHtml(titleMatch[2]).trim();
    if (!title || title.length < 3) continue;

    // 提取摘要：<a class="result__snippet">...</a>
    const snippetMatch = block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]).trim().slice(0, 300) : "";

    if (!url.startsWith("http")) continue;

    results.push({ title, url, snippet });
  }

  return results.slice(0, 10);
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z]+;/gi, (entity) => {
      const entities: Record<string, string> = {
        "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
        "&#x27;": "'", "&nbsp;": " ", "&#39;": "'", "&ensp;": " ",
      };
      return entities[entity.toLowerCase()] ?? entity;
    });
}

/**
 * DuckDuckGo 搜索后端（HTML 抓取，无需 API Key）。
 * 使用 DDG 的纯 HTML 版本（html.duckduckgo.com/html/），
 * 无需 JavaScript，返回简单的 HTML 结果页。
 *
 * 注意：DDG 有速率限制，高频率访问可能会被暂时封禁。
 */
export const duckduckgoBackend: SearchBackend = {
  id: "duckduckgo",
  requiresKey: false,

  async search(query: string, maxResults = 5): Promise<WebSearchResultSet> {
    const searchStartedAt = Date.now();
    console.log(`[web-search] duckduckgo search query="${query.trim()}" maxResults=${maxResults}`);

    try {
      const params = new URLSearchParams({ q: query.trim() });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("DuckDuckGo search timed out")), SEARCH_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(`${DDG_URL}?${params.toString()}`, {
          method: "POST",
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept-Language": "zh-CN,zh;q=0.9",
            Accept: "text/html",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params.toString(),
          redirect: "follow",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        console.log(`[web-search] duckduckgo error query="${query.trim()}" httpStatus=${response.status} latency=${Date.now() - searchStartedAt}ms`);
        return { query: query.trim(), total_results: 0, results: [], errorMessage: `DuckDuckGo returned HTTP ${response.status}` };
      }

      const html = await response.text();
      const results = parseDdgHtml(html);

      if (!results.length) {
        console.log(`[web-search] duckduckgo no_results query="${query.trim()}" latency=${Date.now() - searchStartedAt}ms`);
        return { query: query.trim(), total_results: 0, results: [] };
      }

      const trimmed = results.slice(0, maxResults);
      console.log(`[web-search] duckduckgo completed query="${query.trim()}" resultCount=${trimmed.length} totalResults=${results.length} latency=${Date.now() - searchStartedAt}ms`);
      return {
        query: query.trim(),
        total_results: results.length,
        results: trimmed.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown search error";
      console.log(`[web-search] duckduckgo error query="${query.trim()}" message="${message}" latency=${Date.now() - searchStartedAt}ms`);
      return { query: query.trim(), total_results: 0, results: [], errorMessage: message };
    }
  },
};
