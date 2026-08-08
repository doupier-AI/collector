import type { GroundingEvidenceStatus, FetchErrorCategory, ResearchGroundingSourceRecord, ResearchGroundingTraceEntry } from "@collector/capture-contracts";
import { extractReadableText, fetchPublicResource, classifyFetchError, type PublicUrlDnsLookup } from "./parsers.js";
import { createSearchBackendRegistry, defaultSearchConfig, selectSearchBackend } from "./search-backends/index.js";
import { ALL_SEARCH_BACKEND_IDS } from "./search-backends/index.js";
import { SearchBackendRegistry } from "./search-backends/index.js";
import type { SearchBackend, SearchBackendId, SearchConfig } from "./search-backends/index.js";

export type { SearchBackendId, SearchConfig };

const MAX_PAGE_BYTES = 256 * 1024;

// ── 证据管线参数（#49）──────────────────────────────────────────────
// 重试/退避/熔断阈值。有界：最坏情况每个 URL 首试 + 2 次退避（≈6s 额外时延）。

/** 首试之后的退避重试次数上限（有界）。 */
const FETCH_RETRY_MAX_ATTEMPTS = 2;
/** 指数退避基数。 */
const FETCH_RETRY_BASE_DELAY_MS = 500;
/** 单次退避上限。 */
const FETCH_RETRY_MAX_DELAY_MS = 4_000;
/** 瞬时/慢速失败连续达到该次数后熔断该域名。 */
const CIRCUIT_BREAKER_THRESHOLD = 3;
/** 成功但抓取耗时超过该值时视为慢速域名，计入熔断计数。 */
const SLOW_DOMAIN_MS = 6_000;
/** 单次搜索运行的失败留痕上限，超限丢弃最旧。 */
const TRACE_MAX_ENTRIES = 50;
/** 内容级验证码/付费墙启发式的短文本门限（低于此长度才判定）。 */
const BLOCKED_PAGE_TEXT_LIMIT = 300;
/** 验证码/付费墙内容特征词。 */
const BLOCKED_PAGE_MARKERS = /captcha|验证码|安全验证|robot check|paywall|付费墙/i;

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
 * 保持单次原子：重试/熔断由 webFetch 编排。
 */
export async function fetchPageContent(
  url: string,
  options: { dnsLookup?: PublicUrlDnsLookup; allowNonPublic?: boolean; timeoutMs?: number } = {},
): Promise<{
  url: string;
  text: string;
  errorMessage?: string;
  errorCategory?: FetchErrorCategory;
  httpStatus?: number;
}> {
  const fetchStartedAt = Date.now();
  try {
    const fetched = await fetchPublicResource(url, options);
    const raw = Buffer.from(fetched.bytes).toString("utf8");
    let text = "";
    if (fetched.contentType === "text/html") {
      text = raw.length > MAX_PAGE_BYTES ? stripHtml(raw).slice(0, MAX_PAGE_BYTES) : extractReadableText(raw, fetched.url);
    } else {
      text = raw.slice(0, MAX_PAGE_BYTES);
    }
    const trimmed = text.trim();
    // 内容级验证码/付费墙启发式：#49 失败分类（永久）。短文本门限降低对正文恰好
    // 包含这些词组的正常页面的误判；误判后果仅为该页降级为部分证据且不重试。
    if (trimmed && trimmed.length < BLOCKED_PAGE_TEXT_LIMIT && BLOCKED_PAGE_MARKERS.test(trimmed)) {
      return { url: fetched.url, text: "", errorMessage: "页面疑似验证码或付费墙（内容被拦截）", errorCategory: "blocked" };
    }
    const result = { url: fetched.url, text: trimmed.slice(0, 6000), errorMessage: trimmed ? undefined : "No readable text", ...(!trimmed ? { errorCategory: "content" as const } : {}) };
    console.log(`[web-search] fetchPageContent ${result.errorMessage ? "error" : "completed"} url="${fetched.url}" textLen=${result.text.length} latency=${Date.now() - fetchStartedAt}ms${result.errorMessage ? ` error="${result.errorMessage}"` : ""}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown fetch error";
    const { category, status } = classifyFetchError(error);
    console.log(`[web-search] fetchPageContent error url="${url}" message="${message}" latency=${Date.now() - fetchStartedAt}ms`);
    return { url, text: "", errorMessage: message, errorCategory: category, ...(status !== undefined ? { httpStatus: status } : {}) };
  }
}

/**
 * 抓取指定 URL 的网页正文（带证据管线：#49）。
 * 只抓不搜——失败分类：瞬时失败（超时/408/429/选定 5xx）有限退避重试，
 * 永久失败（401/403/验证码/付费墙/私网/体积/类型等）不重试；
 * 每域熔断：一次搜索运行（SearchRunContext）内，永久失败立即熔断，
 * 瞬时失败连续达到阈值或抓取过慢时熔断，熔断后不再请求该域名。
 * options 中的 dnsLookup/allowNonPublic/timeoutMs 仅供测试注入（生产不传）。
 */
export async function webFetch(
  url: string,
  options: {
    context?: SearchRunContext;
    retrySleep?: (ms: number) => Promise<void>;
    dnsLookup?: PublicUrlDnsLookup;
    allowNonPublic?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<WebFetchResult & { errorCategory?: FetchErrorCategory; retryCount: number }> {
  const ctx = options.context;
  const domain = hostnameOf(url);
  const startedAt = Date.now();
  const maxRetries = FETCH_RETRY_MAX_ATTEMPTS;

  if (ctx?.isTripped(domain)) {
    const message = `域名 ${domain} 已被暂时熔断，本轮搜索内不再抓取该域名。`;
    ctx.recordEntry({
      stage: "fetch", domain, url, status: "circuit_open", latencyMs: 0, errorCategory: "circuit_open", evidenceStatus: "none",
    });
    console.log(`[web-search] webFetch circuitOpen url="${url}"`);
    return { url, content: "", errorMessage: message, errorCategory: "circuit_open", retryCount: 0 };
  }

  let lastCategory: FetchErrorCategory = "network";
  let lastMessage = "Unknown fetch error";
  let lastHttpStatus: number | undefined;
  let attempt = 0;
  for (; attempt <= maxRetries; attempt += 1) {
    const page = await fetchPageContent(url, { dnsLookup: options.dnsLookup, allowNonPublic: options.allowNonPublic, timeoutMs: options.timeoutMs });
    if (!page.errorMessage) {
      ctx?.recordSuccess(domain);
      const latency = Date.now() - startedAt;
      ctx?.recordEntry({ stage: "fetch", domain, url: page.url, status: "completed", attempts: attempt + 1, latencyMs: latency, evidenceStatus: "full" });
      // 成功但抓取过慢：计入慢域熔断计数，本轮不再请求该慢速域名。
      if (latency > SLOW_DOMAIN_MS) ctx?.recordFailure(domain, false);
      console.log(`[web-search] webFetch completed url="${page.url}" contentLen=${page.text.length} attempts=${attempt + 1} latency=${Date.now() - startedAt}ms`);
      return { url: page.url, content: page.text, retryCount: attempt };
    }
    lastCategory = page.errorCategory ?? classifyFetchError(page.errorMessage).category;
    lastMessage = page.errorMessage;
    if (page.httpStatus !== undefined) lastHttpStatus = page.httpStatus;
    if (!isRetryable(page)) break; // 永久失败（含 401/403 等非 408/429/5xx 的 4xx）：不重试
    if (attempt >= maxRetries) break;
    const delay = backoffDelayMs(attempt);
    console.log(`[web-search] webFetch retry url="${url}" attempt=${attempt + 1} category=${lastCategory} delay=${delay}ms`);
    await (options.retrySleep ?? sleep)(delay);
  }

  const transient = isRetryable({ errorCategory: lastCategory });
  const finalStatus: "permanent_failed" | "retry_exhausted" = transient ? "retry_exhausted" : "permanent_failed";
  const tripped = ctx?.recordFailure(domain, transient) ?? false;
  ctx?.recordEntry({
    stage: "fetch", domain, url, status: finalStatus, attempts: attempt + 1, latencyMs: Date.now() - startedAt,
    errorCategory: lastCategory, httpStatus: lastHttpStatus, retryReason: attempt > 0 ? lastMessage : undefined, evidenceStatus: "none", ...(tripped ? { fallbackReason: "circuit_tripped" as const } : {}),
  });
  console.log(`[web-search] webFetch ${finalStatus} url="${url}" category=${lastCategory} attempts=${attempt + 1} latency=${Date.now() - startedAt}ms`);
  return { url, content: "", errorMessage: lastMessage, errorCategory: lastCategory, retryCount: attempt };
}

/** 从 URL 提取域名（hostname）。用于熔断键与 trace。 */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.split("/")[0] ?? url;
  }
}

/**
 * 是否可重试：分类为瞬时（timeout/network/dns）或 http_status 且状态码属于
 * 408/429/5xx（服务端可恢复）。401/403 等其余 4xx 视为永久失败不重试
 * （避免被视为恶意请求、浪费预算）。
 */
function isRetryable(page: { errorCategory?: FetchErrorCategory; httpStatus?: number }): boolean {
  if (page.errorCategory === "timeout" || page.errorCategory === "network" || page.errorCategory === "dns") return true;
  if (page.errorCategory === "http_status") {
    const status = page.httpStatus ?? 0;
    return status === 408 || status === 429 || status >= 500;
  }
  return false;
}

/** 瞬时失败分类集合（供熔断阈值判断）。 */
function isTransientFetchCategory(category: FetchErrorCategory): boolean {
  return category === "timeout" || category === "http_status" || category === "network" || category === "dns";
}

/** 指数退避 + 抖动（对齐 research.ts 口径）：500 → 1000 → 2000，抖动 ±50%。 */
function backoffDelayMs(attempt: number): number {
  const base = Math.min(FETCH_RETRY_MAX_DELAY_MS, FETCH_RETRY_BASE_DELAY_MS * 2 ** attempt);
  return Math.round(base * (0.5 + Math.random() / 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 一次搜索运行的证据管线上下文（#49）。
 * 作用域 = 一次 generateAgentGrounded 调用（service 闭包捕获），任务间隔离；
 * 每次调用 new 一个实例，不做模块级状态（避免并发任务互相污染）。
 * 追踪轨迹上限 TRACE_MAX_ENTRIES 条，超限丢弃最旧。
 */
export class SearchRunContext {
  private readonly domainStates = new Map<string, { consecutiveFailures: number; tripped: boolean }>();
  private readonly trace: ResearchGroundingTraceEntry[] = [];

  isTripped(domain: string): boolean {
    return this.domainStates.get(domain)?.tripped ?? false;
  }

  /** 抓取成功：清零该域连续失败计数（慢域除外——由调用方在成功后补 recordFailure）。 */
  recordSuccess(domain: string): void {
    const state = this.domainStates.get(domain);
    if (state) {
      state.consecutiveFailures = 0;
      state.tripped = false;
    }
  }

  /**
   * 记录一次失败。永久失败立即熔断；瞬时/慢速失败连续达到阈值熔断。
   * transient 由调用方按实际可重试性判定（http_status 分类中 401/403 等
   * 非 408/429/5xx 的 4xx 是永久失败，立即熔断）。返回是否刚刚触发熔断。
   */
  recordFailure(domain: string, transient: boolean): boolean {
    const state = this.domainStates.get(domain) ?? { consecutiveFailures: 0, tripped: false };
    if (state.tripped) return false;
    if (!transient || state.consecutiveFailures + 1 >= CIRCUIT_BREAKER_THRESHOLD) {
      state.consecutiveFailures += 1;
      state.tripped = true;
      this.domainStates.set(domain, state);
      return true;
    }
    state.consecutiveFailures += 1;
    this.domainStates.set(domain, state);
    return false;
  }

  recordEntry(entry: ResearchGroundingTraceEntry): void {
    if (this.trace.length >= TRACE_MAX_ENTRIES) this.trace.shift();
    this.trace.push(entry);
  }

  toTrace(): ResearchGroundingTraceEntry[] {
    return [...this.trace];
  }
}

export function createSearchRunContext(): SearchRunContext {
  return new SearchRunContext();
}

/**
 * 只保留指向"实际取得证据"来源的引用（#49 引用完整性）。
 * 全部来源保留入库（序数稠密，正文 [来源n] 不改写），
 * 仅丢弃指向 none（无任何内容取得）来源的引用记录。
 * 越界序号视为无效丢弃。
 */
export function filterCitationsByEvidence(
  citations: Array<{ sourceOrdinal: number; markerOffset: number }>,
  sources: Array<{ evidenceStatus?: GroundingEvidenceStatus }>,
): Array<{ sourceOrdinal: number; markerOffset: number }> {
  return citations.filter((citation) => {
    const source = sources[citation.sourceOrdinal - 1];
    return source !== undefined && source.evidenceStatus !== "none";
  });
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
