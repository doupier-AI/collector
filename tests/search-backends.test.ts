import assert from "node:assert/strict";
import test from "node:test";
import { bingBackend } from "../apps/api/dist/search-backends/bing.js";
import { duckduckgoBackend } from "../apps/api/dist/search-backends/duckduckgo.js";
import { createTavilyBackend } from "../apps/api/dist/search-backends/tavily.js";
import { createSearxngBackend } from "../apps/api/dist/search-backends/searxng.js";
import {
  createSearchBackendRegistry,
  defaultSearchConfig,
  selectSearchBackend,
  SearchBackendRegistry,
} from "../apps/api/dist/search-backends/index.js";
import type { SearchBackendId } from "../apps/api/dist/search-backends/index.js";
import {
  initSearchBackends,
  getSearchConfig,
  updateSearchConfig,
  listAvailableBackends,
  webSearch,
} from "../apps/api/dist/web-search-agent.js";

// ── 后端接口约定 ──

test("all built-in backends satisfy the interface contract", () => {
  const backends = [
    bingBackend,
    duckduckgoBackend,
    createTavilyBackend("tvly-test-key"),
    createSearxngBackend("https://searxng.example.com"),
  ];
  for (const backend of backends) {
    assert.equal(typeof backend.id, "string");
    assert.ok(backend.id.length > 0);
    assert.equal(typeof backend.requiresKey, "boolean");
    assert.equal(typeof backend.search, "function");
  }
});

test("bing backend is zero-config", () => {
  assert.equal(bingBackend.requiresKey, false);
  assert.equal(bingBackend.id, "bing");
});

test("duckduckgo backend is zero-config", () => {
  assert.equal(duckduckgoBackend.requiresKey, false);
  assert.equal(duckduckgoBackend.id, "duckduckgo");
});

test("tavily backend requires API key", () => {
  assert.throws(() => createTavilyBackend(""), { message: /API key is required/ });
  assert.throws(() => createTavilyBackend("  "), { message: /API key is required/ });

  const backend = createTavilyBackend("tvly-test-key");
  assert.equal(backend.requiresKey, true);
  assert.equal(backend.id, "tavily");
});

test("searxng backend requires instance URL", () => {
  assert.throws(() => createSearxngBackend(""), { message: /instance URL is required/ });
  assert.throws(() => createSearxngBackend("  "), { message: /instance URL is required/ });

  const backend = createSearxngBackend("https://searxng.example.com");
  assert.equal(backend.requiresKey, true);
  assert.equal(backend.id, "searxng");
});

// ── 注册表逻辑 ──

test("registry prevents duplicate registration", () => {
  const registry = new SearchBackendRegistry();
  registry.register(bingBackend);
  assert.throws(() => registry.register(bingBackend), { message: /already registered/ });
});

test("registry list returns all registered backend IDs", () => {
  const registry = new SearchBackendRegistry();
  registry.register(bingBackend);
  registry.register(duckduckgoBackend);
  const list = registry.list();
  assert.ok(list.includes("bing"));
  assert.ok(list.includes("duckduckgo"));
  assert.equal(list.length, 2);
});

test("registry get returns undefined for unknown backend", () => {
  const registry = new SearchBackendRegistry();
  assert.equal(registry.get("tavily" as SearchBackendId), undefined);
});

test("createSearchBackendRegistry with default config registers free backends", () => {
  const cfg = defaultSearchConfig();
  const registry = createSearchBackendRegistry(cfg);
  assert.ok(registry.get("bing"));
  assert.ok(registry.get("duckduckgo"));
  assert.equal(registry.get("tavily"), undefined);
  assert.equal(registry.get("searxng"), undefined);
});

test("createSearchBackendRegistry with Tavily key registers tavily", () => {
  const cfg = { ...defaultSearchConfig(), tavilyApiKey: "tvly-test" };
  const registry = createSearchBackendRegistry(cfg);
  assert.ok(registry.get("tavily"));
});

test("createSearchBackendRegistry with SearXNG URL registers searxng", () => {
  const cfg = { ...defaultSearchConfig(), searxngUrl: "https://search.example.com" };
  const registry = createSearchBackendRegistry(cfg);
  assert.ok(registry.get("searxng"));
});

// ── 后端选择与回退 ──

test("selectSearchBackend returns preferred backend when available", () => {
  const registry = new SearchBackendRegistry();
  registry.register(bingBackend);
  const { backend, usedFallback } = selectSearchBackend(registry, "bing", true);
  assert.equal(backend.id, "bing");
  assert.equal(usedFallback, false);
});

test("selectSearchBackend falls back when preferred unavailable", () => {
  const registry = new SearchBackendRegistry();
  registry.register(bingBackend);
  registry.register(duckduckgoBackend);
  const { backend, usedFallback } = selectSearchBackend(registry, "tavily", true);
  assert.equal(backend.id, "bing"); // first in fallback order
  assert.equal(usedFallback, true);
});

test("selectSearchBackend throws when preferred unavailable and fallback disabled", () => {
  const registry = new SearchBackendRegistry();
  registry.register(bingBackend);
  assert.throws(
    () => selectSearchBackend(registry, "tavily", false),
    { message: /not available.*fallback is disabled/ },
  );
});

test("selectSearchBackend throws when no backends are registered", () => {
  const registry = new SearchBackendRegistry();
  assert.throws(
    () => selectSearchBackend(registry, "bing", true),
    { message: /No search backend is available/ },
  );
});

// ── 配置持久化 ──

test("default search config is bing with fallback enabled", () => {
  const cfg = defaultSearchConfig();
  assert.equal(cfg.backend, "bing");
  assert.equal(cfg.fallback, true);
});

test("initSearchBackends sets initial configuration", () => {
  initSearchBackends({ backend: "duckduckgo" });
  const cfg = getSearchConfig();
  assert.equal(cfg.backend, "duckduckgo");
  const available = listAvailableBackends();
  assert.ok(available.includes("bing"));
  assert.ok(available.includes("duckduckgo"));
});

test("updateSearchConfig changes backend at runtime", () => {
  initSearchBackends({ backend: "bing" });
  updateSearchConfig({ backend: "duckduckgo" });
  const cfg = getSearchConfig();
  assert.equal(cfg.backend, "duckduckgo");
});

test("updateSearchConfig with Tavily key registers tavily backend", () => {
  initSearchBackends({ backend: "bing" });
  updateSearchConfig({ tavilyApiKey: "tvly-test" });
  const available = listAvailableBackends();
  assert.ok(available.includes("tavily"));
});

test("updateSearchConfig persists fallback setting", () => {
  initSearchBackends({ fallback: true });
  updateSearchConfig({ fallback: false });
  assert.equal(getSearchConfig().fallback, false);
});

test("listAvailableBackends always includes bing and duckduckgo", () => {
  initSearchBackends();
  const list = listAvailableBackends();
  assert.ok(list.includes("bing"));
  assert.ok(list.includes("duckduckgo"));
});

test("production webSearch and backend logs never include the private query or API key", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const lines: string[] = [];
  globalThis.fetch = async () => new Response(JSON.stringify({
    results: [{ title: "Result", url: "https://example.com/result", content: "Evidence" }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    initSearchBackends({ backend: "tavily", tavilyApiKey: "api-key-secret-value", fallback: false });
    const result = await webSearch("query-secret-value", 3);
    assert.equal(result.results.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    initSearchBackends();
  }
  const output = lines.join("\n");
  assert.doesNotMatch(output, /query-secret-value|api-key-secret-value/);
  assert.match(output, /queryChars=18/);
});
