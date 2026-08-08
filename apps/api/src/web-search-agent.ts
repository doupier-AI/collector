import type { ResearchGroundingSourceRecord } from "@collector/capture-contracts";
import { extractReadableText, fetchPublicResource } from "./parsers.js";
import { createSearchBackendRegistry, defaultSearchConfig, selectSearchBackend } from "./search-backends/index.js";
import { ALL_SEARCH_BACKEND_IDS } from "./search-backends/index.js";
import { SearchBackendRegistry } from "./search-backends/index.js";
import type { SearchBackend, SearchBackendId, SearchConfig } from "./search-backends/index.js";

export type { SearchBackendId, SearchConfig };

const MAX_PAGE_BYTES = 256 * 1024;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOutcome {
  status: "completed" | "no_results" | "error";
  query: string;
  results: WebSearchResult[];
  errorMessage?: string;
}

/**
 * web_search 工具的标准返回格式。
 * 只搜不抓——只返回标题、URL 和摘要，不抓取页面正文。
 * 格式对齐 DeerFlow 的标准化工具输出：{ query, total_results, results: [{title, url, content/snippet}] }。
 */
export interface WebSearchResultSet {
  query: string;
  total_results: number;
  results: Array<{ title: string; url: string; snippet: string }>;
  errorMessage?: string;
  /** 实际使用的搜索后端 */
  backend?: SearchBackendId;
  /** 是否为回退后端 */
  usedFallback?: boolean;
}

/**
 * web_fetch 工具的标准返回格式。
 * 只抓不搜——抓取单个 URL 的页面正文，不触发搜索。
 */
export interface WebFetchResult {
  url: string;
  content: string;
  errorMessage?: string;
}

// ── 搜索后端调度器 ──────────────────────────────────────────────

let _searchRegistry: SearchBackendRegistry | undefined;
let _searchConfig: SearchConfig = defaultSearchConfig();

/**
 * 初始化搜索后端注册表。
 * 在服务启动时调用一次，根据当前搜索配置注册所有可用后端。
 */
export function initSearchBackends(config?: Partial<SearchConfig>): void {
  _searchConfig = { ...defaultSearchConfig(), ...config };
  _searchRegistry = createSearchBackendRegistry(_searchConfig);
  console.log(`[search-backend] initialized backend="${_searchConfig.backend}" fallback=${_searchConfig.fallback} available=${_searchRegistry.list().join(",")}`);
}

/**
 * 获取当前搜索配置（只读副本）。
 */
export function getSearchConfig(): SearchConfig {
  return { ..._searchConfig };
}

/**
 * 动态更新搜索配置并重新创建注册表。
 * 例如用户通过 API 切换后端或更新 Tavily API Key。
 */
export function updateSearchConfig(partial: Partial<SearchConfig>): void {
  _searchConfig = { ..._searchConfig, ...partial };
  _searchRegistry = createSearchBackendRegistry(_searchConfig);
  const available = _searchRegistry.list().join(",");
  console.log(`[search-backend] updated backend="${_searchConfig.backend}" fallback=${_searchConfig.fallback} available=${available}`);
}

/**
 * 获取当前活跃的搜索后端注册表。
 * 如果未初始化（例如早期代码路径），惰性创建默认注册表。
 */
function ensureRegistry(): SearchBackendRegistry {
  if (!_searchRegistry) {
    _searchRegistry = createSearchBackendRegistry(_searchConfig);
  }
  return _searchRegistry;
}

/**
 * 搜索互联网并返回标准化的结果集。
 * 只搜不抓——根据当前搜索配置选择后端，支持故障回退。
 * 供 Agent 工具循环中的 web_search 工具调用。
 */
export async function webSearch(query: string, maxResults = 5): Promise<WebSearchResultSet> {
  const searchStartedAt = Date.now();
  const registry = ensureRegistry();
  const { backend, usedFallback } = selectSearchBackend(registry, _searchConfig.backend, _searchConfig.fallback);

  console.log(`[web-search] webSearch backend="${backend.id}"${usedFallback ? " (fallback)" : ""} query="${query.trim()}" maxResults=${maxResults}`);

  try {
    const result = await backend.search(query.trim(), maxResults);
    console.log(`[web-search] webSearch ${result.errorMessage ? "error" : "completed"} backend="${backend.id}" query="${result.query}" resultCount=${result.results.length} latency=${Date.now() - searchStartedAt}ms`);
    return { ...result, backend: backend.id, usedFallback };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown search error";
    console.log(`[web-search] webSearch error backend="${backend.id}" query="${query.trim()}" message="${message}" latency=${Date.now() - searchStartedAt}ms`);

    // 如果启用了回退且当前后端不是回退选择，尝试用首选后端重试
    if (_searchConfig.fallback && usedFallback) {
      // 已经是回退后端了还失败，返回错误
      return { query: query.trim(), total_results: 0, results: [], errorMessage: message, backend: backend.id, usedFallback };
    }
    if (_searchConfig.fallback) {
      // 首选后端失败，尝试回退
      const FALLBACK_ORDER = ALL_SEARCH_BACKEND_IDS;
      for (const fallbackId of FALLBACK_ORDER) {
        if (fallbackId === backend.id) continue;
        const fallbackBackend = registry.get(fallbackId);
        if (!fallbackBackend) continue;
        try {
          console.log(`[web-search] webSearch falling back to "${fallbackId}" after "${backend.id}" failed`);
          const fallbackResult = await fallbackBackend.search(query.trim(), maxResults);
          return { ...fallbackResult, backend: fallbackId, usedFallback: true };
        } catch {
          // 继续尝试下一个
        }
      }
    }

    return { query: query.trim(), total_results: 0, results: [], errorMessage: message, backend: backend.id, usedFallback };
  }
}

/**
 * 返回当前可用的搜索后端 ID 列表。
 */
export function listAvailableBackends(): SearchBackendId[] {
  return ensureRegistry().list();
}

/**
 * 解析 Bing 搜索结果页面 HTML。
 * Bing 将每条结果放在 <li class="b_algo"> 中，
 * 标题在 <h2><a href="..."> 中，摘要放在 <p class="b_lineclampN"> 中。
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
 * 抓取搜索结果页面的正文文本。
 * 经 fetchPublicResource 走统一安全抓取路径（逐跳私网/保留地址重校验、
 * DNS 结果钉死连接、重定向上限），抓取 HTML 后使用 Readability 提取可读文本。
 */
export async function fetchPageContent(url: string): Promise<{
  url: string;
  text: string;
  errorMessage?: string;
}> {
  const fetchStartedAt = Date.now();
  try {
    const fetched = await fetchPublicResource(url);
    const raw = Buffer.from(fetched.bytes).toString("utf8");
    let text = "";
    if (fetched.contentType === "text/html") {
      text = raw.length > MAX_PAGE_BYTES ? stripHtml(raw).slice(0, MAX_PAGE_BYTES) : extractReadableText(raw, fetched.url);
    } else {
      text = raw.slice(0, MAX_PAGE_BYTES);
    }
    const trimmed = text.trim();
    const result = { url: fetched.url, text: trimmed.slice(0, 6000), errorMessage: trimmed ? undefined : "No readable text" };
    console.log(`[web-search] fetchPageContent ${result.errorMessage ? "error" : "completed"} url="${fetched.url}" textLen=${result.text.length} latency=${Date.now() - fetchStartedAt}ms${result.errorMessage ? ` error="${result.errorMessage}"` : ""}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown fetch error";
    console.log(`[web-search] fetchPageContent error url="${url}" message="${message}" latency=${Date.now() - fetchStartedAt}ms`);
    return { url, text: "", errorMessage: message };
  }
}

/**
 * 抓取指定 URL 的网页正文。
 * 只抓不搜——薄封装 fetchPageContent，返回标准化的 WebFetchResult。
 * 供 Agent 工具循环中的 web_fetch 工具调用。
 */
export async function webFetch(url: string): Promise<WebFetchResult> {
  const fetchStartedAt = Date.now();
  console.log(`[web-search] webFetch url="${url}"`);
  const page = await fetchPageContent(url);
  const status = page.errorMessage ? "error" : "completed";
  console.log(`[web-search] webFetch ${status} url="${url}" contentLen=${page.text.length} latency=${Date.now() - fetchStartedAt}ms${page.errorMessage ? ` error="${page.errorMessage}"` : ""}`);
  return { url: page.url, content: page.text, errorMessage: page.errorMessage };
}

/**
 * 解析模型回答中的 [来源n] 引用标记。
 * 返回引用位置列表（sourceOrdinal + markerOffset），供持久化到 research_citations 表。
 */
export function parseAgentCitations(
  content: string,
  sources: ResearchGroundingSourceRecord[],
): { citations: Array<{ sourceOrdinal: number; markerOffset: number }> } {
  const sourceCount = sources.length;
  const markerPattern = /\[来源(\d+)\]/g;
  const citations: Array<{ sourceOrdinal: number; markerOffset: number }> = [];
  let cleanOffset = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = markerPattern.exec(content)) !== null) {
    const sourceNum = Number(match[1]);
    if (sourceNum >= 1 && sourceNum <= sourceCount) {
      // 计算标记之前的累积文本偏移
      cleanOffset += content.slice(lastIndex, match.index).length;
      citations.push({ sourceOrdinal: sourceNum, markerOffset: cleanOffset });
      lastIndex = match.index + match[0].length;
    }
  }
  return { citations };
}
