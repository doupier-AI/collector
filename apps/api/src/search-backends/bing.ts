import type { SearchBackend } from "./types.js";
import type { WebSearchResultSet, WebSearchResult } from "../web-search-agent.js";

const BING_URL = "https://www.bing.com/search";
const SEARCH_TIMEOUT_MS = 10_000;

/**
 * 解析 Bing 搜索结果页面 HTML（li.b_algo 结果块）。
 */
function parseBingHtmlBlocks(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blockRegex = /<li[^>]*class="b_algo"[^>]*>/gi;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRegex.exec(html)) !== null) {
    const start = blockMatch.index + blockMatch[0].length;
    const remaining = html.slice(start);
    const nextLi = remaining.search(/<li[^>]*class="b_algo"[^>]*>/i);
    const endLi = nextLi > 0 ? remaining.slice(0, nextLi).lastIndexOf("</li>") : remaining.lastIndexOf("</li>");
    if (endLi < 0) continue;
    const block = remaining.slice(0, endLi);

    const titleMatch = block.match(/<h2[^>]*><a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/i);
    if (!titleMatch) continue;
    const url = titleMatch[1].replace(/&amp;/g, "&");
    const title = stripHtml(titleMatch[2]).trim();
    if (!title || title.length < 3) continue;

    const snippetMatch = block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
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
 * 请求 Bing 搜索结果页 HTML，解析其中的 li.b_algo 结果块。
 */
async function searchBing(query: string): Promise<{
  status: "completed" | "no_results" | "error";
  query: string;
  results: WebSearchResult[];
  errorMessage?: string;
}> {
  const searchStartedAt = Date.now();
  console.log(`[web-search] searchBing query="${query}"`);
  try {
    const params = new URLSearchParams({ q: query.trim(), count: "10" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Bing search timed out")), SEARCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${BING_URL}?${params.toString()}`, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "zh-CN,zh;q=0.9",
          Accept: "text/html",
        },
        redirect: "follow",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      console.log(`[web-search] searchBing error query="${query.trim()}" httpStatus=${response.status} latency=${Date.now() - searchStartedAt}ms`);
      return { status: "error", query: query.trim(), results: [], errorMessage: `Bing returned HTTP ${response.status}` };
    }
    const html = await response.text();
    const results = parseBingHtmlBlocks(html);
    if (!results.length) {
      console.log(`[web-search] searchBing no_results query="${query.trim()}" latency=${Date.now() - searchStartedAt}ms`);
      return { status: "no_results", query: query.trim(), results: [] };
    }
    console.log(`[web-search] searchBing completed query="${query.trim()}" resultCount=${results.length} latency=${Date.now() - searchStartedAt}ms`);
    return { status: "completed", query: query.trim(), results };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown search error";
    console.log(`[web-search] searchBing error query="${query.trim()}" message="${message}" latency=${Date.now() - searchStartedAt}ms`);
    return { status: "error", query: query.trim(), results: [], errorMessage: message };
  }
}

/**
 * Bing 网页搜索后端（HTML 抓取，无需 API Key）。
 * 请求 Bing 搜索结果页 HTML，解析其中的 li.b_algo 结果块。
 * 这是 Collector 的默认搜索后端。
 */
export const bingBackend: SearchBackend = {
  id: "bing",
  requiresKey: false,

  async search(query: string, maxResults = 5): Promise<WebSearchResultSet> {
    const searchStartedAt = Date.now();
    console.log(`[web-search] bing search query="${query.trim()}" maxResults=${maxResults}`);
    const outcome = await searchBing(query.trim());
    if (outcome.status === "error" || outcome.status === "no_results") {
      console.log(`[web-search] bing ${outcome.status} query="${outcome.query}" latency=${Date.now() - searchStartedAt}ms`);
      return { query: outcome.query, total_results: 0, results: [], errorMessage: outcome.errorMessage };
    }
    const trimmed = outcome.results.slice(0, maxResults);
    console.log(`[web-search] bing completed query="${outcome.query}" resultCount=${trimmed.length} latency=${Date.now() - searchStartedAt}ms`);
    return {
      query: outcome.query,
      total_results: outcome.results.length,
      results: trimmed.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
    };
  },
};
