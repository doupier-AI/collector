import assert from "node:assert/strict";
import test from "node:test";
import { deriveBodyVersion, deriveFragmentsFromBlocks } from "@collector/capture-contracts";
import { getOrDeriveMessageBodyArtifacts } from "@collector/api";

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
