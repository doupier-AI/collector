import assert from "node:assert/strict";
import test from "node:test";
import { deriveBodyVersion, deriveFragmentsFromBlocks, deriveMessageSlices, hashBodyContent, toResearchMessageBody, type ResearchMessageRecord } from "@collector/capture-contracts";
import { deriveMessageBodyArtifacts, getOrDeriveMessageBodyArtifacts } from "@collector/api";

test("正文哈希、切片和引用片段只从正文投影派生", () => {
  const sentinel = "RSN05_REASONING_SENTINEL_7f5c";
  const message: ResearchMessageRecord = {
    id: "message-boundary", sessionId: "session-1", nodeId: "node-1", role: "assistant",
    content: "第一段公开正文。\n\n第二段公开正文。", reasoning: sentinel, reasoningRecordId: "reasoning-1",
    versions: [{ content: "历史正文", reasoning: sentinel, createdAt: "2026-08-01T00:00:00.000Z" }],
    status: "completed", createdAt: "2026-08-02T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z",
  };

  const body = toResearchMessageBody(message);
  const slices = deriveMessageSlices("node-1", body.id, body.content, 0, [], [{ title: "第一章" }, { title: "第二章" }]);
  const artifacts = deriveMessageBodyArtifacts({ nodeId: "node-1", message: body, slices });
  assert.equal(artifacts.version.contentHash, hashBodyContent(message.content));
  assert.equal(artifacts.fragments.length, 2);
  assert.deepEqual(slices.map((slice) => slice.title), ["第一章", "第二章"]);
  assert.doesNotMatch(JSON.stringify({ slices, artifacts }), new RegExp(sentinel));
  assert.doesNotMatch(JSON.stringify(artifacts), /历史正文|reasoning-1/);
});

test("getOrDeriveMessageBodyArtifacts never reuses a persisted body whose checksum differs from the current message", () => {
  const staleVersion = deriveBodyVersion({
    messageId: "message-1",
    nodeId: "node-1",
    content: "旧的已完成正文。",
    origin: "generation",
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  const artifacts = getOrDeriveMessageBodyArtifacts({
    getBodyVersionForMessage: () => staleVersion,
    listFragmentsByBodyVersion: () => deriveFragmentsFromBlocks(staleVersion),
  }, {
    nodeId: "node-1",
    message: { id: "message-1", content: "新的已完成正文。", createdAt: "2026-08-02T00:00:00.000Z" },
  });

  assert.strictEqual(artifacts.persisted, false);
  assert.strictEqual(artifacts.version.content, "新的已完成正文。");
  assert.notStrictEqual(artifacts.version.id, staleVersion.id);
  assert.ok(artifacts.fragments.every((fragment) => fragment.bodyVersionId === artifacts.version.id));
});
