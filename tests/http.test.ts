import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CaptureService, JsonStore, createApiServer } from "@collector/api";

test("HTTP API creates and retrieves a capture", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-http-"));
  const store = new JsonStore(join(root, "store.json"));
  await store.init();
  const server = createApiServer(new CaptureService(store, join(root, "artifacts")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Collector Inbox/);
  const input = {
    captureType: "pasted_url",
    sourceUrl: "https://example.com",
    locator: { kind: "user_supplied" },
    clientCaptureId: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
  };
  const create = await fetch(`${base}/v1/captures`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": input.clientCaptureId }, body: JSON.stringify(input) });
  assert.equal(create.status, 201);
  const record = await create.json();
  const get = await fetch(`${base}/v1/captures/${record.id}`);
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), record);
  const inbox = await fetch(`${base}/v1/inbox`);
  assert.equal(inbox.status, 200);
  assert.equal((await inbox.json()).length, 1);
});
