import type { ResearchGroundingSourceRecord } from "@collector/capture-contracts";
import { extractReadableText } from "./parsers.js";

const SEARCH_TIMEOUT_MS = 10_000;
const PAGE_FETCH_TIMEOUT_MS = 8_000;
const MAX_PAGE_BYTES = 256 * 1024;
const BING_URL = "https://www.bing.com/search";

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

/**
 * Bing 网页搜索（无需 API Key）。
 * 请求 Bing 搜索结果页 HTML，解析其中的 li.b_algo 结果块。
 */
export async function searchBing(query: string): Promise<WebSearchOutcome> {
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
    const results = parseBingHtml(html);
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
 * 搜索互联网并返回标准化的结果集。
 * 只搜不抓——内部调用 searchBing 获取搜索结果，只返回标题、URL 和摘要，
 * 不抓取页面正文。供 Agent 工具循环中的 web_search 工具调用。
 */
export async function webSearch(query: string, maxResults = 5): Promise<WebSearchResultSet> {
  const searchStartedAt = Date.now();
  console.log(`[web-search] webSearch query="${query.trim()}" maxResults=${maxResults}`);
  const outcome = await searchBing(query.trim());
  if (outcome.status === "error" || outcome.status === "no_results") {
    console.log(`[web-search] webSearch ${outcome.status} query="${outcome.query}" latency=${Date.now() - searchStartedAt}ms`);
    return { query: outcome.query, total_results: 0, results: [], errorMessage: outcome.errorMessage };
  }
  const trimmed = outcome.results.slice(0, maxResults);
  console.log(`[web-search] webSearch completed query="${outcome.query}" resultCount=${trimmed.length} latency=${Date.now() - searchStartedAt}ms`);
  return { query: outcome.query, total_results: outcome.results.length, results: trimmed.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })) };
}

/**
 * 解析 Bing 搜索结果页面 HTML。
 * Bing 将每条结果放在 <li class="b_algo"> 中，
 * 标题在 <h2><a href="..."> 中，摘要放在 <p class="b_lineclampN"> 中。
 */
function parseBingHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blockRegex = /<li[^>]*class="b_algo"[^>]*>/gi;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRegex.exec(html)) !== null) {
    const start = blockMatch.index + blockMatch[0].length;
    const remaining = html.slice(start);
    // 找到下一个 b_algo 的起始位置，当前块在此之前的 </li> 结束
    const nextLi = remaining.search(/<li[^>]*class="b_algo"[^>]*>/i);
    const endLi = nextLi > 0 ? remaining.slice(0, nextLi).lastIndexOf("</li>") : remaining.lastIndexOf("</li>");
    if (endLi < 0) continue;
    const block = remaining.slice(0, endLi);

    // 提取标题和 URL
    const titleMatch = block.match(/<h2[^>]*><a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/i);
    if (!titleMatch) continue;
    const url = titleMatch[1].replace(/&amp;/g, "&");
    const title = stripHtml(titleMatch[2]).trim();
    if (!title || title.length < 3) continue;

    // 提取摘要
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
 * 校验公网目标（复用 parsers.ts 已有的 assertPublicUrl + extractReadableText），
 * 抓取 HTML 后使用 Readability 提取可读文本。
 */
export async function fetchPageContent(url: string): Promise<{
  url: string;
  text: string;
  errorMessage?: string;
}> {
  const fetchStartedAt = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Page fetch timed out")), PAGE_FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        redirect: "follow",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      console.log(`[web-search] fetchPageContent error url="${url}" httpStatus=${response.status} latency=${Date.now() - fetchStartedAt}ms`);
      return { url, text: "", errorMessage: `HTTP ${response.status}` };
    }
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    let text = "";
    if (contentType.includes("text/html")) {
      const html = await response.text();
      if (html.length > MAX_PAGE_BYTES) {
        text = stripHtml(html).slice(0, MAX_PAGE_BYTES);
      } else {
        text = extractReadableText(html, url);
      }
    } else if (contentType.includes("text/plain")) {
      text = (await response.text()).slice(0, MAX_PAGE_BYTES);
    }
    const trimmed = text.trim();
    const result = { url, text: trimmed.slice(0, 6000), errorMessage: trimmed ? undefined : "No readable text" };
    console.log(`[web-search] fetchPageContent ${result.errorMessage ? "error" : "completed"} url="${url}" textLen=${result.text.length} latency=${Date.now() - fetchStartedAt}ms${result.errorMessage ? ` error="${result.errorMessage}"` : ""}`);
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
 * 编排搜索 + 页面抓取，返回可供注入生成提示的来源材料。
 */
export async function runWebSearch(
  query: string,
  maxSources = 5,
): Promise<{
  status: "completed" | "no_results" | "error";
  query: string;
  sources: ResearchGroundingSourceRecord[];
  searchResults: WebSearchResult[];
  errorMessage?: string;
}> {
  const runStartedAt = Date.now();
  if (!query.trim() || query.trim().length < 2) {
    console.log(`[web-search] runWebSearch error query="${query.trim()}" message="Query too short"`);
    return { status: "error", query: query.trim(), sources: [], searchResults: [], errorMessage: "Query too short" };
  }
  const outcome = await searchBing(query.trim());
  if (outcome.status !== "completed" || !outcome.results.length) {
    console.log(`[web-search] runWebSearch ${outcome.status} query="${outcome.query}" latency=${Date.now() - runStartedAt}ms`);
    return { status: outcome.status, query: outcome.query, sources: [], searchResults: [], errorMessage: outcome.errorMessage };
  }

  const top = outcome.results.slice(0, maxSources);
  console.log(`[web-search] runWebSearch fetching ${top.length} pages...`);
  const pages = await Promise.all(top.map((result) => fetchPageContent(result.url)));

  const sources: ResearchGroundingSourceRecord[] = [];
  let fetchSuccessCount = 0;
  let fetchFailCount = 0;
  for (let i = 0; i < top.length; i += 1) {
    const result = top[i];
    const page = pages[i];
    if (page.text) fetchSuccessCount += 1;
    else fetchFailCount += 1;
    sources.push({
      id: "", // assigned by caller
      runId: "", // assigned by caller
      ordinal: i + 1,
      title: (page.text ? page.text.slice(0, 80) : result.title) || `来源 ${i + 1}`,
      url: result.url,
      snippet: page.text ? page.text.slice(0, 1000) : result.snippet,
      createdAt: new Date().toISOString(),
    });
  }

  console.log(`[web-search] runWebSearch completed query="${outcome.query}" searchResults=${top.length} fetchOk=${fetchSuccessCount} fetchFail=${fetchFailCount} sourceCount=${sources.length} latency=${Date.now() - runStartedAt}ms`);
  return { status: "completed", query: outcome.query, sources, searchResults: top };
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
