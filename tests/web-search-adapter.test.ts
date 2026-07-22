import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import test from "node:test";
import {
  FakeSearchProvider,
  SearchUnavailableError,
  SearxngSearchProvider,
  fetchPublicResource,
  parseSearxngResults,
  resolveSearxngInstances,
} from "@collector/api";

async function startStub(handler: (url: URL) => { status?: number; contentType?: string; body?: string; headers?: Record<string, string> }): Promise<{ base: string; close(): Promise<void> }> {
  let server: Server;
  const base = await new Promise<string>((resolve) => {
    server = createServer((request, response) => {
      const result = handler(new URL(request.url ?? "/", "http://127.0.0.1"));
      response.writeHead(result.status ?? 200, { "Content-Type": result.contentType ?? "application/json", ...(result.headers ?? {}) });
      response.end(result.body ?? "");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  return {
    base: base!,
    close: () => new Promise<void>((resolve) => server!.close(() => resolve())),
  };
}

const SEARXNG_JSON = JSON.stringify({
  results: [
    { url: "https://example.com/a", title: "来源甲", content: "甲的摘要" },
    { url: "https://example.com/b", title: "来源乙", content: "乙的摘要" },
    { url: "not-a-url", title: "无效地址", content: "应被跳过" },
    { url: "ftp://example.com/c", title: "非 HTTP 协议", content: "应被跳过" },
    { title: "缺少地址", content: "应被跳过" },
  ],
});

test("parseSearxngResults maps results and skips unusable entries", () => {
  const hits = parseSearxngResults(SEARXNG_JSON);
  assert.deepEqual(hits, [
    { url: "https://example.com/a", title: "来源甲", snippet: "甲的摘要" },
    { url: "https://example.com/b", title: "来源乙", snippet: "乙的摘要" },
  ]);
});

test("parseSearxngResults rejects malformed payloads", () => {
  assert.throws(() => parseSearxngResults("这不是 JSON"), /无法解析/);
  assert.throws(() => parseSearxngResults("[]"), /不是 JSON 对象/);
  assert.throws(() => parseSearxngResults(JSON.stringify({ query: "x" })), /缺少 results/);
});

test("resolveSearxngInstances marks environment-configured instances as trusted", () => {
  assert.deepEqual(resolveSearxngInstances("http://127.0.0.1:8080"), [{ url: "http://127.0.0.1:8080", trusted: true }]);
  const defaults = resolveSearxngInstances(undefined);
  assert.ok(defaults.length >= 2);
  assert.ok(defaults.every((instance) => instance.trusted === false));
});

test("SearxngSearchProvider queries a SearXNG-compatible JSON endpoint", async (t) => {
  const stub = await startStub((url) => {
    assert.equal(url.pathname, "/search");
    assert.equal(url.searchParams.get("format"), "json");
    assert.equal(url.searchParams.get("q"), "量子计算");
    return { body: SEARXNG_JSON };
  });
  t.after(() => stub.close());
  const provider = new SearxngSearchProvider({ instances: [{ url: stub.base, trusted: true }] });
  const hits = await provider.search("量子计算");
  assert.equal(hits.length, 2);
  assert.equal(hits[0].title, "来源甲");
});

test("SearxngSearchProvider fails over to the next instance", async (t) => {
  const stub = await startStub(() => ({ body: SEARXNG_JSON }));
  t.after(() => stub.close());
  const provider = new SearxngSearchProvider({
    instances: [
      { url: "http://127.0.0.1:1", trusted: true },
      { url: stub.base, trusted: true },
    ],
  });
  const hits = await provider.search("任意查询");
  assert.equal(hits.length, 2);
});

test("SearxngSearchProvider throws SearchUnavailableError when every instance fails", async () => {
  const provider = new SearxngSearchProvider({
    instances: [{ url: "http://127.0.0.1:1", trusted: true }],
  });
  await assert.rejects(() => provider.search("任意查询"), SearchUnavailableError);
});

test("SearxngSearchProvider rejects non-JSON responses", async (t) => {
  const stub = await startStub(() => ({ contentType: "text/html", body: "<html></html>" }));
  t.after(() => stub.close());
  const provider = new SearxngSearchProvider({ instances: [{ url: stub.base, trusted: true }] });
  await assert.rejects(() => provider.search("任意查询"), /非 JSON 内容/);
});

test("fetchPublicResource rejects private targets unless explicitly trusted", async (t) => {
  const stub = await startStub(() => ({ body: "{}" }));
  t.after(() => stub.close());
  await assert.rejects(() => fetchPublicResource(`${stub.base}/search`), /private or reserved/);
  const trusted = await fetchPublicResource(`${stub.base}/search`, { allowNonPublic: true });
  assert.equal(trusted.contentType, "application/json");
});

test("fetchPublicResource re-validates redirect targets without the trust exception", async (t) => {
  const stub = await startStub((url) => {
    if (url.pathname === "/redirect") {
      return { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data/" }, body: "" };
    }
    return { body: "{}" };
  });
  t.after(() => stub.close());
  await assert.rejects(
    () => fetchPublicResource(`${stub.base}/redirect`, { allowNonPublic: true }),
    /private or reserved/,
  );
});

test("fetchPublicResource rejects non-http protocols", async () => {
  await assert.rejects(() => fetchPublicResource("ftp://example.com/file"), /HTTP and HTTPS/);
});

test("FakeSearchProvider returns deterministic hits or errors", async () => {
  const hits = [{ url: "https://example.com/x", title: "假来源", snippet: "假摘要" }];
  const provider = new FakeSearchProvider(hits);
  assert.deepEqual(await provider.search("任意查询"), hits);
  const failing = new FakeSearchProvider(new Error("搜索失败"));
  await assert.rejects(() => failing.search("任意查询"), /搜索失败/);
});
