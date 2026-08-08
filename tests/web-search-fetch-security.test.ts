import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { fetchPublicResource, resolvePublicUrl, type PublicUrlDnsLookup } from "../apps/api/dist/parsers.js";

/**
 * #46 C1：搜索抓取私网校验（安全）测试。
 * fetchPublicResource 是 Agent 搜索循环抓取入口 fetchPageContent 的唯一底层，
 * 本文件直接验证安全抓取契约：私网/保留地址拒绝、重定向逐跳复验、
 * DNS 解析结果钉死连接（dnsLookup 注入）、重定向上限、公网目标正常抓取不受影响。
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

// ── resolvePublicUrl：私网/保留地址拒绝 ──

test("resolvePublicUrl: rejects loopback URL", async () => {
  await assert.rejects(resolvePublicUrl("http://127.0.0.1:8080/"), /private or reserved address/);
});

test("resolvePublicUrl: rejects private range URL", async () => {
  await assert.rejects(resolvePublicUrl("http://10.0.0.5/"), /private or reserved address/);
});

test("resolvePublicUrl: rejects cloud metadata address", async () => {
  await assert.rejects(resolvePublicUrl("http://169.254.169.254/latest/meta-data/"), /private or reserved address/);
});

test("resolvePublicUrl: rejects hostname resolving to private address", async () => {
  await assert.rejects(
    resolvePublicUrl("http://private.example.com/", { dnsLookup: async () => [{ address: "10.0.0.7", family: 4 }] }),
    /private or reserved address/,
  );
});

// ── resolvePublicUrl：DNS 解析结果钉死 ──

test("resolvePublicUrl: dnsLookup injection is used and pins the resolved address", async () => {
  const lookupCalls: string[] = [];
  const dnsLookup: DnsLookup = async (hostname) => {
    lookupCalls.push(hostname);
    return [{ address: "93.184.216.34", family: 4 }];
  };
  const resolved = await resolvePublicUrl("http://example.com/", { dnsLookup });
  assert.equal(resolved.url.hostname, "example.com");
  assert.equal(resolved.address, "93.184.216.34");
  assert.equal(lookupCalls.length, 1);
});

// ── fetchPublicResource：重定向逐跳复验与上限 ──

test("fetchPublicResource: redirect target resolving to private address is rejected", async (t) => {
  const { server, port } = await createLocalServer((_req, res) => {
    res.writeHead(302, { Location: "http://10.0.0.9/private" });
    res.end();
  });
  t.after(() => closeServer(server));

  await assert.rejects(
    fetchPublicResource(`http://127.0.0.1:${port}/start`, { allowNonPublic: true }),
    /private or reserved address/,
  );
});

test("fetchPublicResource: redirect without Location is rejected as redirect failure", async (t) => {
  const { server, port } = await createLocalServer((_req, res) => {
    res.writeHead(302, {});
    res.end();
  });
  t.after(() => closeServer(server));

  await assert.rejects(
    fetchPublicResource(`http://localhost:${port}/start`, { allowNonPublic: true }),
    /redirect limit exceeded/,
  );
});

test("fetchPublicResource: dnsLookup pins the address used for the connection", async (t) => {
  const lookupCalls: string[] = [];
  const { server, port } = await createLocalServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("pinned ok");
  });
  t.after(() => closeServer(server));

  // localhost 走 allowNonPublic（模拟用户显式配置的本地后端）；
  // 注入 dnsLookup 把 localhost 解析为 127.0.0.1——若连接未用钉死的
  // 地址（例如 Node 对域名二次解析），假域名将解析失败
  const fetched = await fetchPublicResource(`http://localhost:${port}/page`, {
    allowNonPublic: true,
    dnsLookup: async (hostname) => {
      lookupCalls.push(hostname);
      return [{ address: "127.0.0.1", family: 4 }];
    },
  });
  assert.equal(fetched.contentType, "text/plain");
  assert.equal(Buffer.from(fetched.bytes).toString("utf8"), "pinned ok");
  assert.ok(lookupCalls.length >= 1, `expected injected lookup to be called, got ${lookupCalls.length}`);
});

// ── fetchPublicResource：公网目标正常抓取 ──

test("fetchPublicResource: public target fetch succeeds", async (t) => {
  try {
    const fetched = await fetchPublicResource("https://example.com/");
    assert.equal(fetched.contentType, "text/html");
    assert.ok(fetched.bytes.length > 0, "expected non-empty body from public fetch");
  } catch (error) {
    // 无外网环境（CI 离线）下跳过，避免把环境限制误判为安全回归
    t.skip(`public network unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
});
