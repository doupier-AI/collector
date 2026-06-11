import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CaptureInput } from "@collector/capture-contracts";
import { CaptureService, JsonStore } from "@collector/api";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "collector-test-"));
  const store = new JsonStore(join(root, "store.json"));
  await store.init();
  return { root, service: new CaptureService(store, join(root, "artifacts")) };
}

function capture(overrides: Partial<CaptureInput> = {}): CaptureInput {
  return {
    captureType: "pasted_text",
    content: "A sufficiently useful piece of knowledge supplied by the user for collection and later review.",
    locator: { kind: "user_supplied" },
    clientCaptureId: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("browser selections receive grade A and L2 processing", async (t) => {
  const { root, service } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = service.preflight(capture({
    captureType: "browser_selection",
    sourceUrl: "https://example.com/article",
    locator: { kind: "browser", pageUrl: "https://example.com/article", startOffset: 2, endOffset: 8 },
  }));
  assert.equal(result.evidenceGrade, "A");
  assert.equal(result.processingLevel, "L2");
});

test("unsourced pasted text receives grade D", async (t) => {
  const { root, service } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(service.preflight(capture()).evidenceGrade, "D");
});

test("clientCaptureId makes capture creation idempotent", async (t) => {
  const { root, service } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = capture();
  const first = await service.createCapture(input, input.clientCaptureId);
  const second = await service.createCapture(input, input.clientCaptureId);
  assert.equal(first.id, second.id);
});

test("same content with a new client id is marked duplicate", async (t) => {
  const { root, service } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = capture();
  await service.createCapture(first);
  const duplicate = capture({ content: first.content });
  const result = await service.createCapture(duplicate);
  assert.equal(result.preflight.duplicate, true);
  assert.equal(result.preflight.processingLevel, "L0");
});

test("images are stored without OCR and capture needs processing", async (t) => {
  const { root, service } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifact = await service.createArtifact("screen.png", "image/png", new Uint8Array([1, 2, 3]));
  const result = await service.createCapture(capture({
    captureType: "local_file",
    content: undefined,
    artifactIds: [artifact.id],
    locator: { kind: "file", fileName: artifact.fileName, mimeType: artifact.mimeType, checksum: artifact.checksum },
  }));
  assert.equal(artifact.status, "needs_processing");
  assert.equal(result.status, "needs_processing");
  assert.equal(result.preflight.processingLevel, "L0");
});

test("capture enrichment creates a reviewable inbox item", async (t) => {
  const { root, service } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = await service.createCapture(capture());
  const inbox = service.listInbox();
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].capture.id, record.id);
  assert.equal(inbox[0].fragments.length, 1);
  assert.equal(inbox[0].knowledgeItems[0].origin, "source");
  assert.equal(inbox[0].reviewProposals[0].relationType, "independent");
});

test("review proposals can be accepted without mutating source content", async (t) => {
  const { root, service } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = await service.createCapture(capture());
  const proposal = service.listInbox()[0].reviewProposals[0];
  const decided = await service.decideReviewProposal(proposal.id, "accepted");
  assert.equal(decided.decision, "accepted");
  assert.equal(service.getCapture(record.id).content, record.content);
});
