import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { fetchLoopback, isFetchSafePort, listenOnFetchSafePort } from "./test-http-server.js";

test("fetch-safe test server rejects standard blocked ports and binds a usable loopback port", async (t) => {
  assert.equal(isFetchSafePort(6667), false);
  assert.equal(isFetchSafePort(6000), false);
  assert.equal(isFetchSafePort(45_000), true);
  const server = createServer((_request, response) => response.end("ok"));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = await listenOnFetchSafePort(server);
  assert.equal(isFetchSafePort(port), true);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "ok");
});

test("loopback fetch retries one transient connection reset", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    if (calls === 1) {
      const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      throw new TypeError("fetch failed", { cause });
    }
    return new Response("ok");
  }) as typeof fetch;
  assert.equal(await (await fetchLoopback("http://127.0.0.1:43110", undefined, fetchFn)).text(), "ok");
  assert.equal(calls, 2);
});

test("loopback fetch does not retry permanent failures", async () => {
  let calls = 0;
  const failure = new TypeError("invalid URL");
  const fetchFn = (async () => {
    calls += 1;
    throw failure;
  }) as typeof fetch;
  await assert.rejects(() => fetchLoopback("http://127.0.0.1:43110", undefined, fetchFn), failure);
  assert.equal(calls, 1);
});

test("loopback fetch exposes a second transient failure", async () => {
  let calls = 0;
  const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const failure = new TypeError("fetch failed", { cause });
  const fetchFn = (async () => {
    calls += 1;
    throw failure;
  }) as typeof fetch;
  await assert.rejects(() => fetchLoopback("http://127.0.0.1:43110", undefined, fetchFn), failure);
  assert.equal(calls, 2);
});
