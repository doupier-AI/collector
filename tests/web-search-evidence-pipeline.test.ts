import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { fetchPublicResource, PublicFetchError, type PublicUrlDnsLookup } from "../apps/api/dist/parsers.js";
import { sanitizeGroundingUrl } from "@collector/capture-contracts";
import { webFetch, createSearchRunContext, filterCitationsByEvidence } from "../apps/api/dist/web-search-agent.js";

/**
 * #49 C2：证据管线测试。
 * 覆盖：失败分类（瞬时/永久）、有界退避重试、每域熔断、部分证据兜底、
 * 引用清洗（引用完整性）与失败留痕（trace 脱敏）。
 * fixture 沿用 web-search-fetch-security.test.ts 的本地 HTTP server + dnsLookup 注入模式；
 * 被测代码从编译产物引入（与既有测试一致）。
 */

type DnsLookup = PublicUrlDnsLookup;

async function createLocalServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolvePromise, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Server did not bind");
  }
  return { server, port: address.port };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

/** 把 localhost 解析为 127.0.0.1 的注入 DNS（允许连接本地 fixture 服务器）。 */
function localhostDnsLookup(): DnsLookup {
  return async () => [{ address: "127.0.0.1", family: 4 }];
}

/** 每条本地 fixture URL 的抓取注入选项（allowNonPublic 仅作用于第一跳的显式配置后端）。 */
function fetchOptionsFor(port: number) {
  return { dnsLookup: localhostDnsLookup(), allowNonPublic: true, timeoutMs: 200, retrySleep: async () => {} };
}

function html(body: string) {
  return `<html><body>${body}</body></html>`;
}

// ── 失败分类（parsers 层）─────────────────────────────────────────────

test("failure classification: transient vs permanent (message text unchanged)", async (t) => {
  const counts = new Map<string, number>();
  const { server, port } = await createLocalServer((req, res) => {
    const path = req.url?.split("?")[0] ?? "/";
    counts.set(path, (counts.get(path) ?? 0) + 1);
    if (path === "/rate-limit") { res.writeHead(429); res.end(); return; }
    if (path === "/server-error") { res.writeHead(500); res.end(); return; }
    if (path === "/forbidden") { res.writeHead(403); res.end(); return; }
    if (path === "/unauthorized") { res.writeHead(401); res.end(); return; }
    if (path === "/request-timeout") { res.writeHead(408); res.end(); return; }
    if (path === "/huge") { res.writeHead(200, { "Content-Type": "text/html", "Content-Length": String(6 * 1024 * 1024) }); res.end(Buffer.alloc(6 * 1024 * 1024 + 1)); return; }
    res.writeHead(200, { "Content-Type": "text/html" }); res.end(html("ok"));
  });
  t.after(() => closeServer(server));

  const cases: Array<{ path: string; transient: boolean; status?: number }> = [
    { path: "/rate-limit", transient: true, status: 429 },
    { path: "/server-error", transient: true, status: 500 },
    { path: "/request-timeout", transient: true, status: 408 },
    { path: "/forbidden", transient: false, status: 403 },
    { path: "/unauthorized", transient: false, status: 401 },
  ];
  for (const item of cases) {
    await assert.rejects(
      fetchPublicResource(`http://127.0.0.1:${port}${item.path}`, { allowNonPublic: true, dnsLookup: localhostDnsLookup(), timeoutMs: 200 }),
      (error) => {
        assert.ok(error instanceof PublicFetchError, `expected PublicFetchError for ${item.path}, got ${String(error)}`);
        assert.equal(error.transient, item.transient, `transient flag for ${item.path}`);
        assert.equal(error.category, "http_status", `category for ${item.path}`);
        if (item.status !== undefined) assert.equal(error.status, item.status, `status for ${item.path}`);
        // message 文本与旧版逐字一致（回归硬闸：SourceParser 导入路径与既有测试依赖它）
        assert.equal(error.message, `URL returned HTTP ${item.status}`, `message for ${item.path}`);
        return true;
      },
    );
  }
  // 体积超限：永久，message 不变
  await assert.rejects(
    fetchPublicResource(`http://127.0.0.1:${port}/huge`, { allowNonPublic: true, dnsLookup: localhostDnsLookup(), timeoutMs: 200 }),
    (error) => {
      assert.ok(error instanceof PublicFetchError);
      assert.equal(error.transient, false);
      assert.equal(error.category, "too_large");
      assert.equal(error.message, "URL response exceeds 5 MiB limit");
      return true;
    },
  );
  // 私网地址：永久（安全红线，永不重试）
  await assert.rejects(
    fetchPublicResource("http://10.0.0.5/", { dnsLookup: localhostDnsLookup(), timeoutMs: 200 }),
    (error) => {
      assert.ok(error instanceof PublicFetchError);
      assert.equal(error.transient, false);
      assert.equal(error.category, "private_address");
      assert.equal(error.message, "URL resolves to a private or reserved address");
      return true;
    },
  );
});

// ── 重试：瞬时失败退避重试成功后成功 ──────────────────────────────────

test("webFetch: transient 429 retried with backoff, succeeds on retry", async (t) => {
  let requestCount = 0;
  const { server, port } = await createLocalServer((_req, res) => {
    requestCount += 1;
    if (requestCount === 1) { res.writeHead(429); res.end(); return; }
    res.writeHead(200, { "Content-Type": "text/html" }); res.end(html("可读正文"));
  });
  t.after(() => closeServer(server));

  const sleeps: number[] = [];
  const result = await webFetch(`http://localhost:${port}/rate-limit`, { ...fetchOptionsFor(port), retrySleep: async (ms) => { sleeps.push(ms); } });

  assert.equal(result.errorMessage, undefined, "should succeed after retry");
  assert.ok(result.content.includes("可读正文"));
  assert.equal(result.retryCount, 1, "one retry");
  assert.equal(sleeps.length, 1, "one backoff sleep");
  // 指数退避基数 500ms × 抖动 ±50% → [250, 500]
  assert.ok(sleeps[0] >= 250 && sleeps[0] <= 500, `backoff delay ${sleeps[0]} in expected range`);
});

// ── 不重试永久失败 ────────────────────────────────────────────────────

test("webFetch: permanent 403 not retried", async (t) => {
  let requestCount = 0;
  const sleeps: number[] = [];
  const { server, port } = await createLocalServer((_req, res) => {
    requestCount += 1;
    res.writeHead(403); res.end();
  });
  t.after(() => closeServer(server));

  const result = await webFetch(`http://localhost:${port}/forbidden`, { ...fetchOptionsFor(port), retrySleep: async (ms) => { sleeps.push(ms); } });

  assert.equal(requestCount, 1, "no retries for permanent failure");
  assert.equal(sleeps.length, 0, "no backoff sleep");
  assert.equal(result.errorCategory, "http_status");
  assert.equal(result.errorMessage, "URL returned HTTP 403");
  assert.equal(result.retryCount, 0);
});

// ── 重试耗尽：瞬时失败持续失败后按有界次数终止 ────────────────────────

test("webFetch: transient 500 retries exhaust at bound", async (t) => {
  let requestCount = 0;
  const sleeps: number[] = [];
  const { server, port } = await createLocalServer((_req, res) => {
    requestCount += 1;
    res.writeHead(500); res.end();
  });
  t.after(() => closeServer(server));

  const result = await webFetch(`http://localhost:${port}/server-error`, { ...fetchOptionsFor(port), retrySleep: async (ms) => { sleeps.push(ms); } });

  // 1 首试 + 2 退避重试（有界）
  assert.equal(requestCount, 3);
  assert.equal(sleeps.length, 2);
  assert.equal(result.errorCategory, "http_status");
  assert.equal(result.retryCount, 2);
});

// ── 每域熔断 ──────────────────────────────────────────────────────────

test("webFetch: circuit breaker trips after permanent failure on same domain", async (t) => {
  let requestCount = 0;
  const { server, port } = await createLocalServer((req, res) => {
    if (req.url?.startsWith("/forbidden")) {
      requestCount += 1;
      res.writeHead(403); res.end(); return;
    }
    res.writeHead(200, { "Content-Type": "text/html" }); res.end(html("ok"));
  });
  t.after(() => closeServer(server));

  const ctx = createSearchRunContext();
  const first = await webFetch(`http://localhost:${port}/forbidden-a`, { ...fetchOptionsFor(port), context: ctx });
  assert.equal(first.errorCategory, "http_status", "first fetch fails as permanent");

  const second = await webFetch(`http://localhost:${port}/forbidden-b`, { ...fetchOptionsFor(port), context: ctx });
  assert.equal(second.errorCategory, "circuit_open", "second fetch short-circuited");
  assert.ok(second.errorMessage?.includes("熔断"), "circuit message fed back to model");
  assert.equal(requestCount, 1, "no further requests to tripped domain");
});

test("webFetch: circuit breaker is per-run and domain-isolated", async (t) => {
  let forbiddenCount = 0;
  let okCount = 0;
  const { server, port } = await createLocalServer((req, res) => {
    const path = req.url?.split("?")[0] ?? "/";
    if (path.startsWith("/forbidden")) { forbiddenCount += 1; res.writeHead(403); res.end(); return; }
    okCount += 1;
    res.writeHead(200, { "Content-Type": "text/html" }); res.end(html("ok"));
  });
  t.after(() => closeServer(server));

  // 同一域名下：403 熔断后，同域其他路径不再请求
  const ctxA = createSearchRunContext();
  await webFetch(`http://localhost:${port}/forbidden-1`, { ...fetchOptionsFor(port), context: ctxA });
  const tripped = await webFetch(`http://localhost:${port}/forbidden-2`, { ...fetchOptionsFor(port), context: ctxA });
  assert.equal(tripped.errorCategory, "circuit_open");
  assert.equal(forbiddenCount, 1);

  // 另一个运行上下文（不同任务）：同域名不受上一个 ctx 的熔断影响（隔离性）
  const ctxB = createSearchRunContext();
  const inB = await webFetch(`http://localhost:${port}/ok-b`, { ...fetchOptionsFor(port), context: ctxB });
  assert.equal(inB.errorMessage, undefined, "fresh run context not affected by other run's circuit");
  assert.equal(okCount, 1);
});

// ── 部分证据兜底：内容级失败（garbage / captcha）────────────────────────

test("webFetch: unreadable content classified as content (permanent)", async (t) => {
  const { server, port } = await createLocalServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" }); res.end("<html><head><title>x</title></head><body><script>no text</script></body></html>");
  });
  t.after(() => closeServer(server));

  const result = await webFetch(`http://localhost:${port}/garbage`, { ...fetchOptionsFor(port) });

  assert.equal(result.errorCategory, "content");
  assert.equal(result.errorMessage, "No readable text");
});

test("webFetch: captcha/paywall heuristic classified as blocked (permanent)", async (t) => {
  const { server, port } = await createLocalServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html("请输入验证码完成安全验证"));
  });
  t.after(() => closeServer(server));

  const result = await webFetch(`http://localhost:${port}/captcha`, { ...fetchOptionsFor(port) });

  assert.equal(result.errorCategory, "blocked");
  assert.ok(result.errorMessage?.includes("验证码"), "blocked message");
});

// ── 引用清洗（引用完整性）─────────────────────────────────────────────

test("filterCitationsByEvidence: keeps full/partial, drops none and out-of-range", () => {
  const citations = [
    { sourceOrdinal: 1, markerOffset: 10 },
    { sourceOrdinal: 2, markerOffset: 20 },
    { sourceOrdinal: 3, markerOffset: 30 },
    { sourceOrdinal: 9, markerOffset: 90 }, // 越界
  ];
  const sources = [
    { evidenceStatus: "full" as const },
    { evidenceStatus: "none" as const },
    { evidenceStatus: "partial" as const },
  ];
  const kept = filterCitationsByEvidence(citations, sources);
  assert.deepEqual(kept, [
    { sourceOrdinal: 1, markerOffset: 10 },
    { sourceOrdinal: 3, markerOffset: 30 },
  ]);
});

// ── 失败留痕（trace）──────────────────────────────────────────────────

test("SearchRunContext trace records failures, retries and circuit openings", async (t) => {
  let rateLimitCount = 0;
  const { server, port } = await createLocalServer((req, res) => {
    const path = req.url?.split("?")[0] ?? "/";
    if (path === "/rate-limit") {
      rateLimitCount += 1;
      if (rateLimitCount === 1) { res.writeHead(429); res.end(); return; }
      res.writeHead(200, { "Content-Type": "text/html" }); res.end(html("正文")); return;
    }
    res.writeHead(403); res.end();
  });
  t.after(() => closeServer(server));

  const ctx = createSearchRunContext();
  await webFetch(`http://localhost:${port}/rate-limit?token=abc`, { ...fetchOptionsFor(port), context: ctx });
  await webFetch(`http://localhost:${port}/forbidden`, { ...fetchOptionsFor(port), context: ctx });
  await webFetch(`http://localhost:${port}/blocked-again`, { ...fetchOptionsFor(port), context: ctx });

  const trace = ctx.toTrace();
  assert.ok(trace.length >= 3, `expected ≥3 trace entries, got ${trace.length}`);

  const completed = trace.find((entry) => entry.status === "completed");
  assert.ok(completed, "has completed entry");
  assert.equal(completed.stage, "fetch");
  assert.equal(completed.evidenceStatus, "full");
  assert.equal(completed.attempts, 2, "429 retried once → attempts 2");
  assert.ok(completed.latencyMs >= 0);

  const permanent = trace.find((entry) => entry.status === "permanent_failed");
  assert.ok(permanent, "has permanent_failed entry");
  assert.equal(permanent.errorCategory, "http_status");
  assert.equal(permanent.evidenceStatus, "none");

  const circuit = trace.find((entry) => entry.status === "circuit_open");
  assert.ok(circuit, "has circuit_open entry");
  assert.equal(circuit.errorCategory, "circuit_open");
  assert.equal(circuit.evidenceStatus, "none");

  // URL 脱敏：trace 中的原始 url 含敏感查询参数，落库层经 sanitizeGroundingUrl 剥离
  const urls = trace.map((entry) => entry.url).filter((url): url is string => url !== undefined);
  assert.ok(urls.some((url) => url.includes("token")), "raw trace url includes token param before sanitization");
  const sanitized = urls.map((url) => sanitizeGroundingUrl(url)).filter((url): url is string => url !== undefined);
  assert.ok(sanitized.length > 0);
  assert.ok(sanitized.every((url) => !url.includes("token")), "sensitive query params stripped by sanitizeGroundingUrl");
});
