import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ArtifactRecord, CaptureRecord, FragmentRecord, KnowledgeItemRecord, ReviewProposalRecord } from "@collector/capture-contracts";
import { SqliteStore } from "@collector/api";

function records() {
  const capture: CaptureRecord = {
    id: "capture-1", captureType: "pasted_text", content: "Migrated knowledge", locator: { kind: "user_supplied" },
    clientCaptureId: "client-1", capturedAt: "2026-06-11T00:00:00.000Z", checksum: "checksum-1", status: "inbox",
    evidenceGrade: "D", preflight: { processingLevel: "L2", processable: true, duplicate: false, evidenceGrade: "D", reasons: [] },
    createdAt: "2026-06-11T00:00:01.000Z",
  };
  const fragment: FragmentRecord = { id: "fragment-1", captureId: capture.id, ordinal: 0, text: capture.content!, createdAt: capture.createdAt };
  const item: KnowledgeItemRecord = { id: "item-1", captureId: capture.id, fragmentId: fragment.id, kind: "source_excerpt", content: fragment.text, origin: "source", createdAt: capture.createdAt };
  const proposal: ReviewProposalRecord = { id: "proposal-1", captureId: capture.id, relationType: "independent", confidence: 0.8, evidenceFragmentIds: [fragment.id], rationale: "migration", createdAt: capture.createdAt };
  return { capture, fragment, item, proposal };
}

test("SQLite migrates legacy JSON completely and only once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-sqlite-"));
  const jsonPath = join(root, "store.json");
  const dbPath = join(root, "collector.sqlite");
  const { capture, fragment, item, proposal } = records();
  await writeFile(jsonPath, JSON.stringify({
    captures: { [capture.id]: capture }, captureByClientId: { [capture.clientCaptureId]: capture.id }, captureByChecksum: { [capture.checksum]: capture.id },
    artifacts: {}, fragments: { [fragment.id]: fragment }, knowledgeItems: { [item.id]: item }, reviewProposals: { [proposal.id]: proposal },
  }));
  const store = new SqliteStore(dbPath, jsonPath);
  await store.init();
  assert.deepEqual(store.getCapture(capture.id), capture);
  assert.deepEqual(store.listFragments(capture.id), [fragment]);
  assert.deepEqual(store.listKnowledgeItems(capture.id), [item]);
  assert.deepEqual(store.listReviewProposals(capture.id), [proposal]);
  store.close();
  const backups = (await readdir(root)).filter((name) => name.startsWith("store.json.migrated-") && name.endsWith(".bak"));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(jsonPath, "utf8"), await readFile(join(root, backups[0]), "utf8"));
  const reopened = new SqliteStore(dbPath, jsonPath);
  await reopened.init();
  assert.equal(reopened.listCaptures().length, 1);
  reopened.close();
  await chmod(join(root, backups[0]), 0o666);
  t.after(() => rm(root, { recursive: true, force: true }));
});

test("failed legacy JSON migration preserves the source file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-sqlite-fail-"));
  const jsonPath = join(root, "store.json");
  await writeFile(jsonPath, "{invalid json", "utf8");
  const store = new SqliteStore(join(root, "collector.sqlite"), jsonPath);
  await assert.rejects(() => store.init());
  store.close();
  assert.equal(await readFile(jsonPath, "utf8"), "{invalid json");
  assert.equal((await readdir(root)).filter((name) => name.endsWith(".bak")).length, 0);
  t.after(() => rm(root, { recursive: true, force: true }));
});

test("legacy migration uses an explicit marker when JSON contains artifacts but no captures", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-sqlite-artifact-only-"));
  const jsonPath = join(root, "store.json");
  const dbPath = join(root, "collector.sqlite");
  const artifact: ArtifactRecord = {
    id: "artifact-only", fileName: "orphan.txt", mimeType: "text/plain", size: 4, checksum: "artifact-checksum",
    objectPath: join(root, "orphan.txt"), status: "stored", createdAt: "2026-06-11T00:00:00.000Z",
  };
  await writeFile(jsonPath, JSON.stringify({
    captures: {}, captureByClientId: {}, captureByChecksum: {}, artifacts: { [artifact.id]: artifact }, fragments: {}, knowledgeItems: {}, reviewProposals: {},
  }));
  const first = new SqliteStore(dbPath, jsonPath);
  await first.init();
  assert.deepEqual(first.getArtifact(artifact.id), artifact);
  first.close();
  const second = new SqliteStore(dbPath, jsonPath);
  await second.init();
  assert.deepEqual(second.getArtifact(artifact.id), artifact);
  second.close();
  const backups = (await readdir(root)).filter((name) => name.endsWith(".bak"));
  assert.equal(backups.length, 1);
  await chmod(join(root, backups[0]), 0o666);
  t.after(() => rm(root, { recursive: true, force: true }));
});
