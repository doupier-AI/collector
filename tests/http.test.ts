import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CaptureService, JsonStore, LocalAuth, createApiServer } from "@collector/api";

test("HTTP API creates and retrieves a capture", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-http-"));
  const store = new JsonStore(join(root, "store.json"));
  await store.init();
  const auth = new LocalAuth(store);
  const ownerToken = "test-owner-token";
  await auth.registerTrustedToken(ownerToken, "test");
  const server = createApiServer(new CaptureService(store, join(root, "artifacts")), auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.deepEqual(await home.json(), { name: "Collector Local API", ui: "electron" });
  const input = {
    captureType: "pasted_text",
    content: "A sufficiently detailed source statement for HTTP review, relation, and topic workflow verification.",
    locator: { kind: "user_supplied" },
    clientCaptureId: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
  };
  const unauthorized = await fetch(`${base}/v1/inbox`);
  assert.equal(unauthorized.status, 401);
  const headers = { "Authorization": `Bearer ${ownerToken}` };
  const create = await fetch(`${base}/v1/captures`, { method: "POST", headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": input.clientCaptureId }, body: JSON.stringify(input) });
  assert.equal(create.status, 201);
  const record = await create.json();
  const get = await fetch(`${base}/v1/captures/${record.id}`, { headers });
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), record);
  const inbox = await fetch(`${base}/v1/inbox`, { headers });
  assert.equal(inbox.status, 200);
  const inboxItems = await inbox.json() as Array<{ capture: { id: string }; reviewProposals: Array<{ id: string }> }>;
  assert.equal(inboxItems.length, 1);
  const proposalId = inboxItems[0].reviewProposals[0].id;
  const decision = await fetch(`${base}/v1/review-proposals/${proposalId}/decision`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ decision: "accepted" }) });
  assert.equal(decision.status, 200);
  const relations = await (await fetch(`${base}/v1/relations`, { headers })).json() as Array<{ id: string; status: string }>;
  assert.equal(relations.length, 1);
  const createTopic = await fetch(`${base}/v1/topics`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ title: "HTTP workflow" }) });
  assert.equal(createTopic.status, 201);
  const topic = await createTopic.json() as { id: string };
  assert.equal((await fetch(`${base}/v1/topics/${topic.id}/members/${record.id}`, { method: "POST", headers })).status, 200);
  const workspace = await (await fetch(`${base}/v1/topics/${topic.id}/workspace`, { headers })).json() as { captures: unknown[]; relations: unknown[] };
  assert.equal(workspace.captures.length, 1);
  assert.equal(workspace.relations.length, 1);
  const rename = await fetch(`${base}/v1/topics/${topic.id}`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ title: "Renamed HTTP workflow" }) });
  assert.equal((await rename.json() as { title: string }).title, "Renamed HTTP workflow");
  assert.equal((await fetch(`${base}/v1/topics/${topic.id}/members/${record.id}`, { method: "DELETE", headers })).status, 200);
  const revoked = await fetch(`${base}/v1/relations/${relations[0].id}/revoke`, { method: "POST", headers });
  assert.equal((await revoked.json() as { status: string }).status, "revoked");
});

test("pairing codes are one-time and exchanged tokens authorize requests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-pairing-"));
  const store = new JsonStore(join(root, "store.json"));
  await store.init();
  const auth = new LocalAuth(store);
  const ownerToken = "owner";
  await auth.registerTrustedToken(ownerToken);
  const server = createApiServer(new CaptureService(store, join(root, "artifacts")), auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  const pairingResponse = await fetch(`${base}/v1/pairings`, { method: "POST", headers: { "Authorization": `Bearer ${ownerToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "test client" }) });
  assert.equal(pairingResponse.status, 201);
  const pairing = await pairingResponse.json() as { code: string };
  const exchange = await fetch(`${base}/v1/pairings/exchange`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: pairing.code }) });
  assert.equal(exchange.status, 200);
  const { token } = await exchange.json() as { token: string };
  assert.equal((await fetch(`${base}/v1/inbox`, { headers: { "Authorization": `Bearer ${token}` } })).status, 200);
  assert.equal((await fetch(`${base}/v1/pairings/exchange`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: pairing.code }) })).status, 401);
});

test("pairing exchange rate limits repeated invalid codes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-pairing-limit-"));
  const store = new JsonStore(join(root, "store.json"));
  await store.init();
  const auth = new LocalAuth(store);
  const server = createApiServer(new CaptureService(store, join(root, "artifacts")), auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  for (let index = 0; index < 10; index += 1) {
    const response = await fetch(`${base}/v1/pairings/exchange`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "999999" }) });
    assert.equal(response.status, 401);
  }
  const limited = await fetch(`${base}/v1/pairings/exchange`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "999999" }) });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
});
