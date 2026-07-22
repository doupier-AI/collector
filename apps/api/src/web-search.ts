import { randomUUID } from "node:crypto";
import type {
  WebPageReadRecord,
  WebSearchRecord,
  WebSearchScope,
  WebSearchSource,
} from "@collector/capture-contracts";
import {
  WEB_SEARCH_EXCERPT_MAX_CHARACTERS,
  WEB_SEARCH_MAX_SOURCES,
  WEB_SEARCH_SNIPPET_MAX_CHARACTERS,
} from "@collector/capture-contracts";
import { extractReadableText, fetchPublicResource } from "./parsers.js";
import type { CollectorStore } from "./store.js";

/** 搜索后端返回的单条候选结果。 */
export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
}

/**
 * 可替换的搜索适配层接口。首个实现是 SearXNG 兼容 JSON 接口；
 * 测试与 e2e 使用 FakeSearchProvider，演示模式不构造任何搜索后端。
 */
export interface SearchProvider {
  readonly name: string;
  search(query: string): Promise<SearchHit[]>;
}

/** 所有搜索后端都不可用时抛出；上层按降级处理，不阻断生成。 */
export class SearchUnavailableError extends Error {}

const SEARCH_TITLE_MAX_CHARACTERS = 200;
const SEARCH_ERROR_MAX_CHARACTERS = 300;

/**
 * 默认公开 SearXNG 实例（原型级默认值，公开实例可能不稳定或记录查询）。
 * 正式本地运行建议通过 COLLECTOR_SEARXNG_URL 指向自带或可控后端。
 */
export const DEFAULT_SEARXNG_INSTANCES: readonly string[] = [
  "https://searx.be",
  "https://search.inetol.net",
  "https://searxng.site",
];

export interface SearchInstance {
  url: string;
  /** 用户显式配置的本地后端（如 COLLECTOR_SEARXNG_URL）允许非公网地址；搜索结果页永远严格校验。 */
  trusted: boolean;
}

export function resolveSearxngInstances(environmentUrl?: string): SearchInstance[] {
  const trimmed = environmentUrl?.trim();
  if (trimmed) return [{ url: trimmed, trusted: true }];
  return DEFAULT_SEARXNG_INSTANCES.map((url) => ({ url, trusted: false }));
}

export interface SearxngSearchProviderOptions {
  instances?: SearchInstance[];
}

/**
 * SearXNG 兼容搜索后端：GET {instance}/search?q=…&format=json&pageno=1。
 * 多实例顺序故障切换；请求前校验公网目标（显式配置的本地后端除外）；
 * 请求体大小与网络时间受 fetchPublicResource 的统一上限约束。
 */
export class SearxngSearchProvider implements SearchProvider {
  readonly name = "searxng";
  private readonly instances: SearchInstance[];

  constructor(options: SearxngSearchProviderOptions = {}) {
    this.instances = options.instances?.length
      ? options.instances
      : DEFAULT_SEARXNG_INSTANCES.map((url) => ({ url, trusted: false }));
  }

  async search(query: string): Promise<SearchHit[]> {
    if (!this.instances.length) throw new SearchUnavailableError("没有可用的搜索后端");
    const failures: string[] = [];
    for (const instance of this.instances) {
      try {
        return await this.searchInstance(instance, query);
      } catch (error) {
        failures.push(`${instance.url}: ${limitMessage(error, SEARCH_ERROR_MAX_CHARACTERS)}`);
      }
    }
    throw new SearchUnavailableError(`所有搜索后端均不可用（${failures.join("；")}）`);
  }

  private async searchInstance(instance: SearchInstance, query: string): Promise<SearchHit[]> {
    const base = instance.url.endsWith("/") ? instance.url : `${instance.url}/`;
    const endpoint = new URL("search", base);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("pageno", "1");
    const fetched = await fetchPublicResource(endpoint.toString(), instance.trusted ? { allowNonPublic: true } : {});
    if (fetched.contentType !== "application/json") {
      throw new Error(`搜索后端返回了非 JSON 内容（${fetched.contentType}）`);
    }
    const body = Buffer.from(fetched.bytes).toString("utf8");
    return parseSearxngResults(body);
  }
}

/** 解析 SearXNG JSON 响应为候选结果；结构不合法即抛错（触发故障切换或降级）。 */
export function parseSearxngResults(body: string): SearchHit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("搜索后端返回了无法解析的 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("搜索响应不是 JSON 对象");
  }
  const results = (parsed as { results?: unknown }).results;
  if (!Array.isArray(results)) throw new Error("搜索响应缺少 results 数组");
  const hits: SearchHit[] = [];
  for (const item of results) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = item as { url?: unknown; title?: unknown; content?: unknown };
    if (typeof candidate.url !== "string" || !candidate.url.trim()) continue;
    let normalized: string;
    try {
      normalized = new URL(candidate.url).toString();
    } catch {
      continue;
    }
    if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) continue;
    const title = typeof candidate.title === "string" && candidate.title.trim()
      ? candidate.title.trim().slice(0, SEARCH_TITLE_MAX_CHARACTERS)
      : normalized;
    const snippet = typeof candidate.content === "string"
      ? candidate.content.trim().slice(0, WEB_SEARCH_SNIPPET_MAX_CHARACTERS)
      : "";
    hits.push({ url: normalized, title, snippet });
  }
  return hits;
}

/** 确定性假搜索后端：供单元测试与 e2e harness 注入，永不为真实联网。 */
export class FakeSearchProvider implements SearchProvider {
  readonly name = "fake";
  private readonly outcome: SearchHit[] | Error;

  constructor(outcome: SearchHit[] | Error) {
    this.outcome = outcome;
  }

  async search(_query: string): Promise<SearchHit[]> {
    if (this.outcome instanceof Error) throw this.outcome;
    return structuredClone(this.outcome);
  }
}

/** 页面读取结果：正文文本与实际读取字节数。 */
export interface PageText {
  text: string;
  bytes: number;
}

async function readPageText(url: string): Promise<PageText> {
  const fetched = await fetchPublicResource(url);
  const raw = Buffer.from(fetched.bytes).toString("utf8");
  const text = fetched.contentType === "text/html" ? extractReadableText(raw, fetched.url) : raw;
  return { text, bytes: fetched.bytes.byteLength };
}

/** 进入生成材料与轨迹的来源页面摘录（摘录即页面正文提取，按最大字符数截断）。 */
export interface WebSearchMaterial {
  ordinal: number;
  url: string;
  title: string;
  excerpt: string;
}

/** 一次任务搜索的结果：范围元数据、搜索记录与可用材料。失败时 materials 为空。 */
export interface WebSearchOutcome {
  scope: WebSearchScope;
  record: WebSearchRecord;
  materials: WebSearchMaterial[];
}

export interface WebSearchServiceOptions {
  /** 未提供时搜索恒为降级（未配置搜索后端）。演示模式不注入任何后端。 */
  provider?: SearchProvider;
  /** 页面读取实现，默认走公网校验抓取 + 正文提取；测试注入确定性页面。 */
  readPage?: (url: string) => Promise<PageText>;
  maxSources?: number;
}

/**
 * 搜索编排：搜索 → 读取前 N 条候选页面 → 持久化搜索与页面读取轨迹 →
 * 返回材料。任何失败都落库为失败记录并返回 degraded 范围，不向调用方抛错，
 * 因此联网失败永远不阻断生成。
 */
export class WebSearchService {
  constructor(private readonly store: CollectorStore, private readonly options: WebSearchServiceOptions = {}) {}

  async runSearchForTask(taskId: string, sessionId: string, query: string): Promise<WebSearchOutcome> {
    const maxSources = this.options.maxSources ?? WEB_SEARCH_MAX_SOURCES;
    const readPage = this.options.readPage ?? readPageText;
    const createdAt = new Date().toISOString();
    const searchId = randomUUID();
    const provider = this.options.provider;

    if (!provider) {
      const completedAt = new Date().toISOString();
      const record: WebSearchRecord = {
        id: searchId, taskId, sessionId, query, backend: "none",
        status: "failed", resultCount: 0, sources: [],
        errorMessage: "未配置搜索后端", createdAt, completedAt,
      };
      await this.store.createWebSearch(record);
      return { scope: { status: "degraded", sourceCount: 0 }, record, materials: [] };
    }

    let hits: SearchHit[];
    try {
      hits = await provider.search(query);
    } catch (error) {
      const completedAt = new Date().toISOString();
      const record: WebSearchRecord = {
        id: searchId, taskId, sessionId, query, backend: provider.name,
        status: "failed", resultCount: 0, sources: [],
        errorMessage: limitMessage(error, SEARCH_ERROR_MAX_CHARACTERS), createdAt, completedAt,
      };
      await this.store.createWebSearch(record);
      return { scope: { status: "degraded", sourceCount: 0 }, record, materials: [] };
    }

    const reads: WebPageReadRecord[] = [];
    const sources: WebSearchSource[] = [];
    const materials: WebSearchMaterial[] = [];
    for (const hit of hits.slice(0, maxSources)) {
      const readAt = new Date().toISOString();
      try {
        const page = await readPage(hit.url);
        const excerpt = normalizeExcerpt(page.text);
        if (!excerpt) {
          reads.push({
            id: randomUUID(), searchId, sourceOrdinal: 0, url: hit.url, title: hit.title, snippet: hit.snippet,
            status: "failed", fetchedBytes: page.bytes, excerpt: "", errorMessage: "页面正文为空", createdAt: readAt,
          });
          continue;
        }
        const ordinal = sources.length + 1;
        reads.push({
          id: randomUUID(), searchId, sourceOrdinal: ordinal, url: hit.url, title: hit.title, snippet: hit.snippet,
          status: "completed", fetchedBytes: page.bytes, excerpt, createdAt: readAt,
        });
        sources.push({ ordinal, url: hit.url, title: hit.title, snippet: hit.snippet });
        materials.push({ ordinal, url: hit.url, title: hit.title, excerpt });
      } catch (error) {
        reads.push({
          id: randomUUID(), searchId, sourceOrdinal: 0, url: hit.url, title: hit.title, snippet: hit.snippet,
          status: "failed", fetchedBytes: 0, excerpt: "",
          errorMessage: limitMessage(error, SEARCH_ERROR_MAX_CHARACTERS), createdAt: readAt,
        });
      }
    }

    const completedAt = new Date().toISOString();
    if (!sources.length) {
      const record: WebSearchRecord = {
        id: searchId, taskId, sessionId, query, backend: provider.name,
        status: "failed", resultCount: hits.length, sources: [],
        errorMessage: "未能读取任何来源页面", createdAt, completedAt,
      };
      await this.store.createWebSearch(record);
      await this.store.saveWebPageReads(reads);
      return { scope: { status: "degraded", sourceCount: 0 }, record, materials: [] };
    }

    const record: WebSearchRecord = {
      id: searchId, taskId, sessionId, query, backend: provider.name,
      status: "completed", resultCount: hits.length, sources, createdAt, completedAt,
    };
    await this.store.createWebSearch(record);
    await this.store.saveWebPageReads(reads);
    return { scope: { status: "searched", sourceCount: sources.length }, record, materials };
  }
}

function normalizeExcerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, WEB_SEARCH_EXCERPT_MAX_CHARACTERS);
}

function limitMessage(error: unknown, max: number): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > max ? `${message.slice(0, max)}…` : message;
}
