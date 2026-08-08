import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ResearchMessageRecord, ResearchSliceRecord } from "@collector/capture-contracts";
import { deriveBodyVersion, deriveFragmentsFromBlocks } from "@collector/capture-contracts";
import { CaptureService, LocalAuth, SqliteStore, createApiServer } from "@collector/api";

const NOW = "2026-08-01T00:00:00.000Z";
const CONTENT = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "collector-bodyver-http-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = `bodyver-${randomUUID()}`;
  await auth.registerTrustedToken(token, "bodyver-http-test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
  });
  await store.createResearchSession({ id: "session-1", title: "T", status: "active", createdAt: NOW, updatedAt: NOW }, "k-s");
  await store.createResearchNode({ id: "node-1", sessionId: "session-1", status: "active", createdAt: NOW, updatedAt: NOW }, "k-n");
  const db = (store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  const message: ResearchMessageRecord = { id: "msg-1", sessionId: "session-1", nodeId: "node-1", role: "assistant", content: CONTENT, status: "completed", createdAt: NOW, updatedAt: NOW };
  db.prepare("INSERT INTO research_messages (id, session_id, node_id, branch_id, role, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(message.id, message.sessionId, message.nodeId!, null, message.role, message.status, message.createdAt, message.updatedAt, JSON.stringify(message));
  const slices: ResearchSliceRecord[] = [0, 1, 2].map((i) => ({
    id: `slice:node-1:msg-1:${i}`, nodeId: "node-1", messageId: "msg-1", ordinal: i,
    title: `t${i}`, normalizedConcepts: [], sourceRefs: [], isProvisional: false, createdAt: NOW,
  }));
  await store.replaceSlicesForMessage("msg-1", slices);
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return {
    store, service, base: `http://127.0.0.1:${address.port}`, token,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

test("node view returns both legacy slices and new bodyVersions (coexistence)", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const response = await fetch(`${harness.base}/v1/research-nodes/node-1`, { headers: headers(harness.token) });
  assert.strictEqual(response.status, 200);
  const view = await response.json();
  assert.ok(view.slices?.["msg-1"], "legacy slices still present");
  assert.ok(view.bodyVersions?.["msg-1"], "new bodyVersions present");
  assert.strictEqual(view.bodyVersions["msg-1"].content, CONTENT);
});

test("GET /v1/research-body-versions/:id returns version with derived fragment excerpts", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const view = await (await fetch(`${harness.base}/v1/research-nodes/node-1`, { headers: headers(harness.token) })).json();
  const versionId = view.bodyVersions["msg-1"].id;

  const response = await fetch(`${harness.base}/v1/research-body-versions/${versionId}`, { headers: headers(harness.token) });
  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.strictEqual(body.version.id, versionId);
  assert.strictEqual(body.version.content, CONTENT);
  assert.strictEqual(body.fragments.length, 3);
  // 摘录是运行时从正文版本派生的，不是独立存储的内容副本。
  assert.strictEqual(body.fragments[0].excerpt, "First paragraph.");
  assert.strictEqual(body.fragments[1].excerpt, "Second paragraph.");
});

test("GET /v1/research-body-versions/:id returns 404 for unknown id", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const response = await fetch(`${harness.base}/v1/research-body-versions/body%3Anope%3Adeadbeef`, { headers: headers(harness.token) });
  assert.strictEqual(response.status, 404);
});

test("corrupted fragment surfaces a clear integrity error, never silent re-association", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const { store, service } = harness;
  const version = deriveBodyVersion({ messageId: "msg-1", nodeId: "node-1", content: CONTENT, origin: "backfill", createdAt: NOW });
  await store.createResearchBodyVersion(version);
  const good = deriveFragmentsFromBlocks(version)[0];
  const corrupted = { ...good, excerptChecksum: "00000000" };
  await store.createSemanticFragments([corrupted]);
  assert.throws(
    () => service.getResearchBodyVersionView(version.id),
    (e: unknown) => (e as { code?: string }).code === "fragment_checksum_mismatch",
  );
});
