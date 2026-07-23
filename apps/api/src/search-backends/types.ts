import type { WebSearchOutcome, WebSearchResultSet } from "../web-search-agent.js";

/**
 * 搜索后端统一接口。
 * 每个后端实现此接口，负责将 query 转换为搜索结果。
 */
export interface SearchBackend {
  /** 后端标识符，如 "bing"、"duckduckgo"、"tavily"、"searxng" */
  readonly id: SearchBackendId;
  /** 是否需要 API Key 或额外配置才能使用 */
  readonly requiresKey: boolean;
  /** 执行搜索，返回原始搜索结果 */
  search(query: string, maxResults?: number): Promise<WebSearchResultSet>;
}

/** 已注册的搜索后端标识符 */
export type SearchBackendId = "bing" | "duckduckgo" | "tavily" | "searxng";

/**
 * 搜索后端注册表。
 * 对标 model-gateway 的 ProviderRegistry——基于 Map 的注册 + list()/get() 模式。
 */
export class SearchBackendRegistry {
  private readonly backends = new Map<SearchBackendId, SearchBackend>();

  register(backend: SearchBackend): void {
    if (this.backends.has(backend.id)) {
      throw new Error(`Search backend already registered: ${backend.id}`);
    }
    this.backends.set(backend.id, backend);
  }

  get(id: SearchBackendId): SearchBackend | undefined {
    return this.backends.get(id);
  }

  /** 返回所有已注册的后端 ID */
  list(): SearchBackendId[] {
    return [...this.backends.keys()];
  }

  /** 返回所有已注册的后端 */
  listBackends(): SearchBackend[] {
    return [...this.backends.values()];
  }
}
