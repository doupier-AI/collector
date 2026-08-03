import assert from "node:assert/strict";
import test from "node:test";
import {
  BodyIntegrityError,
  deriveBodyVersion,
  deriveFragmentsFromBlocks,
  deriveFragmentsFromSlices,
  hashBodyContent,
  normalizeBodyContent,
  resolveFragmentExcerpt,
  type ResearchCitationRecord,
  type ResearchSliceRecord,
} from "@collector/capture-contracts";

const NOW = "2026-08-01T00:00:00.000Z";
const CONTENT = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";

function makeVersion(content = CONTENT) {
  return deriveBodyVersion({
    messageId: "msg-1",
    nodeId: "node-1",
    content,
    origin: "generation",
    taskId: "task-1",
    createdAt: NOW,
  });
}

test("normalizeBodyContent folds CRLF/CR to LF", () => {
  assert.strictEqual(normalizeBodyContent("a\r\nb\rc\nd"), "a\nb\nc\nd");
});

test("hashBodyContent is deterministic and CRLF-insensitive", () => {
  assert.strictEqual(hashBodyContent(CONTENT), hashBodyContent(CONTENT));
  assert.strictEqual(hashBodyContent("a\r\nb"), hashBodyContent("a\nb"));
  assert.notStrictEqual(hashBodyContent("a"), hashBodyContent("b"));
});

test("deriveBodyVersion is deterministic — same message+content yields same id", () => {
  const a = makeVersion();
  const b = makeVersion();
  assert.strictEqual(a.id, b.id);
  assert.strictEqual(a.contentHash, b.contentHash);
  assert.strictEqual(a.version, 1);
});

test("deriveBodyVersion normalizes content and different content yields different id", () => {
  const crlf = deriveBodyVersion({ messageId: "msg-1", nodeId: "node-1", content: "a\r\nb", origin: "backfill", createdAt: NOW });
  const lf = deriveBodyVersion({ messageId: "msg-1", nodeId: "node-1", content: "a\nb", origin: "backfill", createdAt: NOW });
  assert.strictEqual(crlf.id, lf.id);
  assert.strictEqual(crlf.content, "a\nb");
  const other = deriveBodyVersion({ messageId: "msg-1", nodeId: "node-1", content: "different", origin: "backfill", createdAt: NOW });
  assert.notStrictEqual(other.id, lf.id);
});

test("deriveFragmentsFromBlocks yields deterministic provisional fragments with valid ranges", () => {
  const version = makeVersion();
  const frags = deriveFragmentsFromBlocks(version);
  assert.strictEqual(frags.length, 3);
  assert.strictEqual(frags[0].isProvisional, true);
  assert.strictEqual(frags[0].granularity, "paragraph");
  for (const [i, f] of frags.entries()) {
    assert.strictEqual(f.ordinal, i);
    assert.strictEqual(f.bodyVersionId, version.id);
    assert.strictEqual(version.content.slice(f.startOffset, f.endOffset), ["First paragraph.", "Second paragraph.", "Third paragraph."][i]);
  }
  // determinism
  assert.deepStrictEqual(deriveFragmentsFromBlocks(version).map((f) => f.id), frags.map((f) => f.id));
});

test("deriveFragmentsFromSlices maps to formal fragments when slices tile the body", () => {
  const version = makeVersion();
  const slices: ResearchSliceRecord[] = ["First paragraph.", "Second paragraph.", "Third paragraph."].map((text, i) => ({
    id: `slice:node-1:msg-1:${i}`,
    nodeId: "node-1",
    messageId: "msg-1",
    ordinal: i,
    title: `t${i}`,
    content: text,
    normalizedConcepts: [],
    sourceRefs: [],
    isProvisional: false,
    createdAt: NOW,
  }));
  const frags = deriveFragmentsFromSlices(version, slices);
  assert.strictEqual(frags.length, 3);
  assert.ok(frags.every((f) => f.isProvisional === false));
  assert.strictEqual(version.content.slice(frags[1].startOffset, frags[1].endOffset), "Second paragraph.");
});

test("deriveFragmentsFromSlices falls back to provisional blocks when slices do not tile", () => {
  const version = makeVersion();
  const badSlices: ResearchSliceRecord[] = [{
    id: "slice:node-1:msg-1:0", nodeId: "node-1", messageId: "msg-1", ordinal: 0,
    title: "x", content: "not the body", normalizedConcepts: [], sourceRefs: [], isProvisional: false, createdAt: NOW,
  }];
  const frags = deriveFragmentsFromSlices(version, badSlices);
  assert.ok(frags.every((f) => f.isProvisional === true));
});

test("fragments carry citation sourceRefs by block ordinal", () => {
  const version = makeVersion();
  const citations = [{
    id: "cite-1", messageId: "msg-1", runId: "run-1", sourceId: "src-1", blockOrdinal: 1, markerOffset: 0, createdAt: NOW,
  } as unknown as ResearchCitationRecord];
  const frags = deriveFragmentsFromBlocks(version, citations);
  assert.strictEqual(frags[1].sourceRefs.length, 1);
  assert.strictEqual(frags[0].sourceRefs.length, 0);
});

test("resolveFragmentExcerpt returns derived excerpt and is not stored content", () => {
  const version = makeVersion();
  const frag = deriveFragmentsFromBlocks(version)[0];
  assert.strictEqual(resolveFragmentExcerpt(version, frag), "First paragraph.");
});

test("resolveFragmentExcerpt throws typed errors — version mismatch", () => {
  const version = makeVersion();
  const frag = deriveFragmentsFromBlocks(version)[0];
  const other = deriveBodyVersion({ messageId: "msg-2", nodeId: "node-2", content: CONTENT, origin: "backfill", createdAt: NOW });
  assert.throws(() => resolveFragmentExcerpt(other, frag), (e: unknown) => e instanceof BodyIntegrityError && e.code === "body_version_mismatch");
});

test("resolveFragmentExcerpt throws typed errors — range invalid", () => {
  const version = makeVersion();
  const frag = { ...deriveFragmentsFromBlocks(version)[0], endOffset: version.content.length + 100 };
  assert.throws(() => resolveFragmentExcerpt(version, frag), (e: unknown) => e instanceof BodyIntegrityError && e.code === "fragment_range_invalid");
});

test("resolveFragmentExcerpt throws typed errors — checksum mismatch (no silent re-association)", () => {
  const version = makeVersion();
  const frag = { ...deriveFragmentsFromBlocks(version)[0], excerptChecksum: "deadbeef" };
  assert.throws(() => resolveFragmentExcerpt(version, frag), (e: unknown) => e instanceof BodyIntegrityError && e.code === "fragment_checksum_mismatch");
});
