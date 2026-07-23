import { searchBing } from "../web-search-agent.js";
import type { SearchBackend } from "./types.js";
import type { WebSearchResultSet } from "../web-search-agent.js";

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
