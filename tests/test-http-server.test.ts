import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { isFetchSafePort, listenOnFetchSafePort } from "./test-http-server.js";

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
