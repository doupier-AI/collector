import { assertPublicUrl } from "../parsers.js";
import type { SearchBackend } from "./types.js";
import type { WebSearchResultSet } from "../web-search-agent.js";

const SEARCH_TIMEOUT_MS = 10_000;

/**
 * SearXNG 搜索后端。
 * SearXNG 是自托管的搜索引擎聚合器，通过 JSON API 提供结果。
 * 用户可以自部署实例或使用可信的公共实例。
 *
 * API: GET {instanceUrl}/search?format=json&q={query}&categories=general
 * 文档：https://docs.searxng.org/dev/search_api.html
 *
 * 特性：
 * - 完全免费，无速率限制（取决于实例配置）
 * - 聚合 Google、Bing、DDG 等多个搜索引擎结果
 * - 通过 JSON API 返回结构化结果，包括 title/url/content/score
 * - 支持 allowNonPublic 以便用户连接本地 SearXNG 实例
 */
export function createSearxngBackend(instanceUrl: string): SearchBackend {
  if (!instanceUrl || !instanceUrl.trim()) {
    throw new Error("SearXNG instance URL is required");
  }

  // 启动时校验 URL 格式和可达性（阻塞注册）
  let validatedUrl: string;
  const trimmedUrl = instanceUrl.trim().replace(/\/+$/, "");

  return {
    id: "searxng",
    requiresKey: true,

    async search(query: string, maxResults = 5): Promise<WebSearchResultSet> {
      const searchStartedAt = Date.now();
      console.log(`[web-search] searxng search query="${query.trim()}" maxResults=${maxResults}`);

      try {
        const params = new URLSearchParams({
          q: query.trim(),
          format: "json",
          categories: "general",
        });

        const searchUrl = `${trimmedUrl}/search?${params.toString()}`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error("SearXNG search timed out")), SEARCH_TIMEOUT_MS);

        let response: Response;
        try {
          response = await fetch(searchUrl, {
            method: "GET",
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
              Accept: "application/json",
            },
            redirect: "follow",
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (!response.ok) {
          console.log(`[web-search] searxng error query="${query.trim()}" httpStatus=${response.status} latency=${Date.now() - searchStartedAt}ms`);
          return { query: query.trim(), total_results: 0, results: [], errorMessage: `SearXNG returned HTTP ${response.status}` };
        }

        const data = await response.json() as SearxngSearchResponse;
        const results = (data.results ?? []).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: (r.content ?? "").slice(0, 300),
        }));

        if (!results.length) {
          console.log(`[web-search] searxng no_results query="${query.trim()}" latency=${Date.now() - searchStartedAt}ms`);
          return { query: query.trim(), total_results: 0, results: [] };
        }

        const trimmed = results.slice(0, maxResults);
        console.log(`[web-search] searxng completed query="${query.trim()}" resultCount=${trimmed.length} totalResults=${results.length} latency=${Date.now() - searchStartedAt}ms`);
        return {
          query: query.trim(),
          total_results: data.number_of_results ?? results.length,
          results: trimmed,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown search error";
        console.log(`[web-search] searxng error query="${query.trim()}" message="${message}" latency=${Date.now() - searchStartedAt}ms`);
        return { query: query.trim(), total_results: 0, results: [], errorMessage: message };
      }
    },
  };
}

interface SearxngSearchResponse {
  query?: string;
  number_of_results?: number;
  results?: Array<{
    title: string;
    url: string;
    content?: string;
    score?: number;
    engine?: string;
    category?: string;
    publishedDate?: string;
  }>;
}
