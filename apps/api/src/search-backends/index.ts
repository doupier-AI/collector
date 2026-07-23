/**
 * Collector 搜索后端模块。
 *
 * 提供多搜索后端可插拔架构：
 * - bing：Bing HTML 抓取（默认，零配置）
 * - duckduckgo：DuckDuckGo HTML 抓取（免费，无需 API Key）
 * - tavily：Tavily Search API（AI 专用，需 API Key）
 * - searxng：SearXNG 自托管聚合引擎（需实例 URL）
 *
 * 使用方式：
 * 1. createSearchBackendRegistry() 创建注册表并注册所有可用后端
 * 2. selectSearchBackend(registry, preferred, config) 选择活跃后端
 * 3. 调用 backend.search(query) 执行搜索
 */

import { SearchBackendRegistry } from "./types.js";
import type { SearchBackend, SearchBackendId } from "./types.js";
import { bingBackend } from "./bing.js";
import { duckduckgoBackend } from "./duckduckgo.js";
import { createTavilyBackend } from "./tavily.js";
import { createSearxngBackend } from "./searxng.js";

export { SearchBackendRegistry } from "./types.js";
export type { SearchBackend, SearchBackendId } from "./types.js";
export { bingBackend } from "./bing.js";
export { duckduckgoBackend } from "./duckduckgo.js";
export { createTavilyBackend } from "./tavily.js";
export { createSearxngBackend } from "./searxng.js";

/** 搜索配置（从 settings 表读取） */
export interface SearchConfig {
  /** 首选后端（默认 "bing"） */
  backend: SearchBackendId;
  /** 是否启用故障回退 */
  fallback: boolean;
  /** Tavily API Key */
  tavilyApiKey?: string;
  /** SearXNG 实例 URL */
  searxngUrl?: string;
}

/** 默认搜索配置 */
export function defaultSearchConfig(): SearchConfig {
  return { backend: "bing", fallback: true };
}

/**
 * 创建搜索后端注册表并注册所有后端。
 * 如果配置了 Tavily API Key 或 SearXNG URL，也注册对应的后端。
 */
export function createSearchBackendRegistry(config: SearchConfig): SearchBackendRegistry {
  const registry = new SearchBackendRegistry();

  // 始终注册免费后端
  registry.register(bingBackend);
  registry.register(duckduckgoBackend);

  // 按需注册需要密钥的后端
  if (config.tavilyApiKey?.trim()) {
    try {
      registry.register(createTavilyBackend(config.tavilyApiKey.trim()));
    } catch (error) {
      console.log(`[search-backend] tavily registration failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }

  if (config.searxngUrl?.trim()) {
    try {
      registry.register(createSearxngBackend(config.searxngUrl.trim()));
    } catch (error) {
      console.log(`[search-backend] searxng registration failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }

  return registry;
}

/**
 * 从注册表中选择活跃的搜索后端。
 * 如果首选后端不可用且启用了回退，按顺序尝试其他后端。
 *
 * 回退顺序：bing → duckduckgo → tavily → searxng
 */
export function selectSearchBackend(
  registry: SearchBackendRegistry,
  preferred: SearchBackendId,
  fallbackEnabled: boolean,
): { backend: SearchBackend; usedFallback: boolean } {
  const preferredBackend = registry.get(preferred);
  if (preferredBackend) {
    return { backend: preferredBackend, usedFallback: false };
  }

  if (!fallbackEnabled) {
    throw new Error(`Search backend "${preferred}" is not available and fallback is disabled`);
  }

  // 固定回退顺序
  const FALLBACK_ORDER: SearchBackendId[] = ["bing", "duckduckgo", "tavily", "searxng"];
  for (const id of FALLBACK_ORDER) {
    const backend = registry.get(id);
    if (backend) {
      console.log(`[search-backend] falling back from "${preferred}" to "${id}"`);
      return { backend, usedFallback: true };
    }
  }

  throw new Error(`No search backend is available (preferred: "${preferred}")`);
}
