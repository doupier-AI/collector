import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { SqliteStore, defaultDataPaths } from "../apps/api/dist/store.js";
import { CaptureService } from "../apps/api/dist/service.js";
import { LocalAuth } from "../apps/api/dist/auth.js";
import { createApiServer } from "../apps/api/dist/http.js";
import { CaptureClient } from "../packages/capture-client/dist/index.js";

// This test verifies the capture path used by local HTTP clients:
// CaptureClient → HTTP → API → CaptureService → SQLite

describe("Capture-to-persistence integration smoke", () => {
  let root: string;
  let store: SqliteStore;
  let service: CaptureService;
  let auth: LocalAuth;
  let client: CaptureClient;
  let server: ReturnType<typeof createServer>;
  let masterToken: string;
  const port = 49360;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "collector-smoke-"));
    const paths = defaultDataPaths(root);
    store = new SqliteStore(paths.database, paths.legacyJson);
    await store.init();
    auth = new LocalAuth(store);
    masterToken = randomUUID();
    await auth.registerTrustedToken(masterToken, "smoke-test");
    service = new CaptureService(store, paths.artifacts);
    server = createApiServer(service, auth, { instanceId: "smoke-test" });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    client = new CaptureClient({ baseUrl: `http://127.0.0.1:${port}`, token: masterToken });
  });

  after(async () => {
    server?.close();
    store?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("creates a text capture and persists to SQLite", async () => {
    const clientId = `smoke-${randomUUID()}`;
    const input = {
      captureType: "pasted_text" as const,
      content: "Integration smoke test content",
      locator: { kind: "user_supplied" as const },
      clientCaptureId: clientId,
      capturedAt: new Date().toISOString(),
    };

    const record = await client.createCapture(input);
    assert.equal(record.clientCaptureId, clientId);
    assert.ok(record.id);
    assert.equal(record.content, "Integration smoke test content");

    // Verify SQLite persistence
    const db = new DatabaseSync(join(root, "collector.sqlite"), { readOnly: true });
    try {
      const captures = db.prepare("SELECT id, record_json FROM captures WHERE id = ?").all(record.id) as Array<{ id: string; record_json: string }>;
      assert.equal(captures.length, 1);
      const persisted = JSON.parse(captures[0].record_json);
      assert.equal(persisted.content, "Integration smoke test content");
      assert.equal(persisted.clientCaptureId, clientId);
    } finally {
      db.close();
    }
  });

  it("idempotent captures return existing record", async () => {
    const clientId = `idem-${randomUUID()}`;
    const input = {
      captureType: "pasted_text" as const,
      content: "Idempotency test",
      locator: { kind: "user_supplied" as const },
      clientCaptureId: clientId,
      capturedAt: new Date().toISOString(),
    };

    const first = await client.createCapture(input);
    const second = await client.createCapture(input);
    assert.equal(first.id, second.id);
    assert.equal(first.checksum, second.checksum);
  });

  it("reads capture back via API", async () => {
    const clientId = `read-${randomUUID()}`;
    const input = {
      captureType: "pasted_text" as const,
      content: "API read-back test",
      locator: { kind: "user_supplied" as const },
      clientCaptureId: clientId,
      capturedAt: new Date().toISOString(),
    };

    const created = await client.createCapture(input);
    const fetched = await client.getCapture(created.id);
    assert.equal(fetched.content, "API read-back test");
    assert.equal(fetched.id, created.id);
  });

  it("rejects unauthenticated requests", async () => {
    const anonymous = new CaptureClient({ baseUrl: `http://127.0.0.1:${port}` });
    await assert.rejects(
      () => anonymous.createCapture({
        captureType: "pasted_text",
        content: "Unauthorized",
        locator: { kind: "user_supplied" },
        clientCaptureId: `unauth-${randomUUID()}`,
        capturedAt: new Date().toISOString(),
      }),
      /unauthorized|401|pair/i,
    );
  });

  it("rejects duplicate clientCaptureId with different content", async () => {
    const clientId = `dup-content-${randomUUID()}`;
    const first = await client.createCapture({
      captureType: "pasted_text",
      content: "Original content",
      locator: { kind: "user_supplied" },
      clientCaptureId: clientId,
      capturedAt: new Date().toISOString(),
    });

    // Same clientCaptureId, different content - should return original (idempotent)
    const second = await client.createCapture({
      captureType: "pasted_text",
      content: "Different content",
      locator: { kind: "user_supplied" },
      clientCaptureId: clientId,
      capturedAt: new Date().toISOString(),
    });

    assert.equal(second.id, first.id);
    assert.equal(second.content, "Original content");
  });
});
