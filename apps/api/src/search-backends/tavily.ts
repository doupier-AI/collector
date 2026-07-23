import type { SearchBackend } from "./types.js";
import type { WebSearchResultSet } from "../web-search-agent.js";

const TAVILY_URL = "https://api.tavily.com/search";
const SEARCH_TIMEOUT_MS = 10_000;

/**
 * Tavily Search API 后端。
 * Tavily 是专为 AI Agent 设计的搜索 API，返回结构化 JSON 结果。
 * 需要 API Key（用户在 tavily.com 申请，免费额度 1000 次/月）。
 *
 * API 文档：https://docs.tavily.com/api-reference/endpoint/search
 *
 * 特性：
 * - 返回 results 数组（title/url/content），content 已包含页面提取文本
 * - search_depth: "basic" 快速搜索，"advanced" 深度搜索
 * - include_answer: true 返回 AI 生成的综述答案
 */
export function createTavilyBackend(apiKey: string): SearchBackend {
  if (!apiKey || !apiKey.trim()) {
    throw new Error("Tavily API key is required");
  }

  return {
    id: "tavily",
    requiresKey: true,

    async search(query: string, maxResults = 5): Promise<WebSearchResultSet> {
      const searchStartedAt = Date.now();
      console.log(`[web-search] tavily search query="${query.trim()}" maxResults=${maxResults}`);

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error("Tavily search timed out")), SEARCH_TIMEOUT_MS);

        let response: Response;
        try {
          response = await fetch(TAVILY_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              api_key: apiKey.trim(),
              query: query.trim(),
              max_results: Math.min(maxResults, 10),
              search_depth: "basic",
              include_answer: false,
            }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          const errMessage = response.status === 401 ? "Tavily API key is invalid"
            : response.status === 429 ? "Tavily rate limit exceeded"
            : `Tavily returned HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`;
          console.log(`[web-search] tavily error query="${query.trim()}" httpStatus=${response.status} latency=${Date.now() - searchStartedAt}ms`);
          return { query: query.trim(), total_results: 0, results: [], errorMessage: errMessage };
        }

        const data = await response.json() as TavilySearchResponse;
        const results = (data.results ?? []).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.content?.slice(0, 300) ?? "",
        }));

        if (!results.length) {
          console.log(`[web-search] tavily no_results query="${query.trim()}" latency=${Date.now() - searchStartedAt}ms`);
          return { query: query.trim(), total_results: 0, results: [] };
        }

        console.log(`[web-search] tavily completed query="${query.trim()}" resultCount=${results.length} latency=${Date.now() - searchStartedAt}ms`);
        return {
          query: query.trim(),
          total_results: results.length,
          results: results.slice(0, maxResults),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown search error";
        console.log(`[web-search] tavily error query="${query.trim()}" message="${message}" latency=${Date.now() - searchStartedAt}ms`);
        return { query: query.trim(), total_results: 0, results: [], errorMessage: message };
      }
    },
  };
}

interface TavilySearchResponse {
  query?: string;
  answer?: string;
  results?: Array<{
    title: string;
    url: string;
    content: string;
    score?: number;
    published_date?: string;
  }>;
}
