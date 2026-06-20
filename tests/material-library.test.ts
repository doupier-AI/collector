import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CaptureService, MemoryStore, LocalAuth, createApiServer } from "@collector/api";

test("material library lists and searches captures", async (t) => {
  const root = join(tmpdir(), `collector-materials-${crypto.randomUUID()}`);
  const store = new MemoryStore();
  await store.init();
  const auth = new LocalAuth(store);
  const token = "test-token";
  await auth.registerTrustedToken(token);

  const server = createApiServer(new CaptureService(store, join(root, "artifacts")), auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>((r) => server.close(() => r())); store.close?.(); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // Create test captures
  const inputs = [
    { captureType: "pasted_text", content: "TypeScript type system notes", locator: { kind: "user_supplied" as const } },
    { captureType: "pasted_url", sourceUrl: "https://example.com/react-hooks", locator: { kind: "user_supplied" as const } },
    { captureType: "browser_selection", content: "Browser DOM selection", sourceUrl: "https://example.com/page", locator: { kind: "browser" as const, pageUrl: "https://example.com/page" } },
  ];

  const created: Array<{ id: string }> = [];
  for (const input of inputs) {
    const id = crypto.randomUUID();
    const res = await fetch(`${base}/v1/captures`, { method: "POST", headers: { ...headers, "Idempotency-Key": id }, body: JSON.stringify({ ...input, clientCaptureId: id, capturedAt: new Date().toISOString() }) });
    assert.equal(res.status, 201);
    created.push(await res.json());
  }

  // Test: list all materials
  const listRes = await fetch(`${base}/v1/materials`, { headers });
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json() as { items: Array<{ id: string }>; total: number };
  assert.equal(listBody.total, 3);
  assert.equal(listBody.items.length, 3);

  // Test: pagination
  const page1 = await fetch(`${base}/v1/materials?page=1&limit=2`, { headers });
  const p1 = await page1.json() as { items: unknown[]; total: number };
  assert.equal(p1.total, 3);
  assert.equal(p1.items.length, 2);

  // Test: search
  const searchRes = await fetch(`${base}/v1/materials?q=TypeScript`, { headers });
  const searchBody = await searchRes.json() as { items: unknown[]; total: number };
  assert.equal(searchBody.total, 1);

  // Test: material detail
  const detailRes = await fetch(`${base}/v1/materials/${created[0].id}`, { headers });
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json() as { id: string; title: string; content: string; evidenceGrade: string; fragments: unknown[] };
  assert.equal(detail.id, created[0].id);
  assert.ok(detail.content.includes("TypeScript"));
  assert.ok(Array.isArray(detail.fragments));

  // Test: auth rejection
  const unauth = await fetch(`${base}/v1/materials`);
  assert.equal(unauth.status, 401);
});

test("material detail returns 404 for unknown id", async (t) => {
  const root = join(tmpdir(), `collector-mat-404-${crypto.randomUUID()}`);
  const store = new MemoryStore();
  await store.init();
  const auth = new LocalAuth(store);
  const token = "test-token";
  await auth.registerTrustedToken(token);
  const server = createApiServer(new CaptureService(store, join(root, "artifacts")), auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>((r) => server.close(() => r())); store.close?.(); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  const res = await fetch(`${base}/v1/materials/not-exists`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 404);
});
