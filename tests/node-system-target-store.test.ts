import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compareAssociationHintsByValue,
  researchEdgeId,
  type ResearchCandidateSourceConnectionRecord,
  type ResearchAssociationHintRecord,
  type ResearchConfirmedFusionSnapshotRecord,
  type ResearchEdgeRecord,
  type ResearchFusionDraftVersionRecord,
  type ResearchNodeRecord,
  type ResearchPermanentEdgeRecord,
  type ResearchSessionRecord,
  type ResearchTemporaryFusionNodeRecord,
} from "@collector/capture-contracts";
import { SqliteStore } from "@collector/api";

const NOW = "2026-08-13T00:00:00.000Z";

test("association hint value ordering is total and stable when legacy rows lack an assessment", () => {
  assert.deepEqual(
    [{ id: "b" }, { id: "a" }].sort(compareAssociationHintsByValue).map(({ id }) => id),
    ["a", "b"],
  );
  assert.deepEqual(
    [
      { id: "legacy" },
      { id: "valued", valueAssessment: { promptVersion: "v1", benefits: ["comparison" as const], priority: 60, assessedAt: NOW, contextKey: "context" } },
    ].sort(compareAssociationHintsByValue).map(({ id }) => id),
    ["valued", "legacy"],
  );
});

async function makeStore(t: test.TestContext): Promise<SqliteStore> {
  const root = await mkdtemp(join(tmpdir(), "collector-node-target-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return store;
}

async function seedNode(store: SqliteStore, node: ResearchNodeRecord): Promise<void> {
  const session: ResearchSessionRecord = {
    id: node.sessionId,
    title: node.sessionId,
    status: "active",
    isFavorite: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await store.saveResearchSession(session);
  await store.createResearchNode(node, `create:${node.id}`);
}

test("target permanent edge repository excludes legacy semantic and temporary endpoints", async (t) => {
  const store = await makeStore(t);
  await seedNode(store, { id: "node-parent", sessionId: "session-parent", status: "active", createdAt: NOW, updatedAt: NOW });
  await seedNode(store, { id: "node-child", sessionId: "session-child", parentNodeId: "node-parent", status: "active", createdAt: NOW, updatedAt: NOW });

  const parentChild: ResearchPermanentEdgeRecord = {
    id: researchEdgeId("parent-child", "node-parent", "node-child"),
    kind: "parent-child",
    fromNodeId: "node-parent",
    toNodeId: "node-child",
    status: "active",
    createdAt: NOW,
  };
  assert.deepEqual(await store.createResearchPermanentEdge(parentChild), parentChild);

  const legacySemantic: ResearchEdgeRecord = {
    ...parentChild,
    id: researchEdgeId("semantic-related", "node-parent", "node-child"),
    kind: "semantic-related",
  };
  await assert.rejects(
    store.createResearchPermanentEdge(legacySemantic as ResearchPermanentEdgeRecord),
    /permanent edge kind/i,
  );
  await assert.rejects(
    store.createResearchPermanentEdge({ ...parentChild, id: "edge:temporary", toNodeId: "temporary-fusion-1" }),
    /formal research nodes/i,
  );
  assert.deepEqual(store.listResearchPermanentEdges(), [parentChild]);
});

function temporaryFusionBundle(id = "temporary-fusion-1") {
  const node: ResearchTemporaryFusionNodeRecord = {
    id,
    creationKey: "generation-task-1",
    triggerProposalId: "fusion:proposal-1",
    activeDraftVersionId: `${id}:draft:1`,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const activeDraft: ResearchFusionDraftVersionRecord = {
    id: node.activeDraftVersionId,
    temporaryFusionNodeId: node.id,
    version: 1,
    body: "来源 A 与来源 B 形成一条可核验的新认识。",
    contentHash: "sha256:draft-1",
    evidenceStatus: "verified",
    createdAt: NOW,
  };
  const candidateSources: ResearchCandidateSourceConnectionRecord[] = ["node-source-a", "node-source-b"].map((sourceNodeId) => ({
    id: `${id}:source:${sourceNodeId}`,
    temporaryFusionNodeId: id,
    sourceNodeId,
    sourceKind: "formal",
    bodyVersionId: `body:${sourceNodeId}:v1`,
    fragmentIds: [`fragment:${sourceNodeId}:1`],
    sourceHealth: "available",
    createdAt: NOW,
  }));
  return { node, activeDraft, candidateSources };
}

test("temporary fusion bundle is transactional, idempotent, and restart-safe", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-temporary-fusion-"));
  const databasePath = join(root, "collector.sqlite");
  let store = new SqliteStore(databasePath);
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  for (const nodeId of ["node-source-a", "node-source-b"]) {
    await seedNode(store, { id: nodeId, sessionId: `session:${nodeId}`, status: "active", createdAt: NOW, updatedAt: NOW });
  }
  const expected = temporaryFusionBundle();
  assert.deepEqual(await store.createTemporaryFusionBundle(expected), expected);

  const duplicate = temporaryFusionBundle("temporary-fusion-retry");
  assert.deepEqual(await store.createTemporaryFusionBundle(duplicate), expected, "creation key must make retries idempotent");

  const invalid = temporaryFusionBundle("temporary-fusion-invalid");
  invalid.node.creationKey = "generation-task-invalid";
  invalid.candidateSources[1] = { ...invalid.candidateSources[1], sourceNodeId: "missing-source" };
  await assert.rejects(store.createTemporaryFusionBundle(invalid), /source.*missing/i);
  assert.equal(store.getTemporaryFusionNode(invalid.node.id), undefined, "failed transaction must leave no partial node");

  store.close();
  store = new SqliteStore(databasePath);
  await store.init();
  assert.deepEqual(store.getTemporaryFusionBundle(expected.node.id), expected);
});

test("deleting a temporary candidate cannot modify permanent relationships", async (t) => {
  const store = await makeStore(t);
  for (const nodeId of ["node-source-a", "node-source-b"]) {
    await seedNode(store, { id: nodeId, sessionId: `session:${nodeId}`, status: "active", createdAt: NOW, updatedAt: NOW });
  }
  const permanent: ResearchPermanentEdgeRecord = {
    id: researchEdgeId("parent-child", "node-source-a", "node-source-b"),
    kind: "parent-child",
    fromNodeId: "node-source-a",
    toNodeId: "node-source-b",
    status: "active",
    createdAt: NOW,
  };
  const child = store.getResearchNode("node-source-b")!;
  // The fixture establishes immutable lineage before using the target edge interface.
  await store.deleteResearchSession(child.sessionId);
  await seedNode(store, { ...child, parentNodeId: "node-source-a" });
  await store.createResearchPermanentEdge(permanent);

  const candidate = temporaryFusionBundle();
  await store.createTemporaryFusionBundle(candidate);
  assert.equal(await store.deleteTemporaryFusionNode(candidate.node.id), true);
  assert.deepEqual(store.listResearchPermanentEdges(), [permanent]);
});

test("temporary candidate batch deletion cascades only through its own aggregate and reports missing ids", async (t) => {
  const store = await makeStore(t);
  for (const nodeId of ["node-source-a", "node-source-b"]) {
    await seedNode(store, { id: nodeId, sessionId: `session:${nodeId}`, status: "active", createdAt: NOW, updatedAt: NOW });
  }
  const first = temporaryFusionBundle("temporary-fusion-first");
  const second = temporaryFusionBundle("temporary-fusion-second");
  second.node.creationKey = "generation-task-2";
  second.activeDraft.id = second.node.activeDraftVersionId;
  second.candidateSources = second.candidateSources.map((source) => ({
    ...source,
    id: `${second.node.id}:source:${source.sourceNodeId}`,
    temporaryFusionNodeId: second.node.id,
  }));
  await store.createTemporaryFusionBundle(first);
  await store.createTemporaryFusionBundle(second);

  const deleted = await store.deleteTemporaryFusionNodes([first.node.id, "missing-temporary", second.node.id]);
  assert.deepEqual(deleted, { deletedIds: [first.node.id, second.node.id], missingIds: ["missing-temporary"] });
  assert.equal(store.getTemporaryFusionBundle(first.node.id), undefined);
  assert.equal(store.getTemporaryFusionBundle(second.node.id), undefined);
  assert.deepEqual(store.listResearchNodes("session:node-source-a").map((node) => node.id), ["node-source-a"], "formal source remains");
  assert.equal(await store.clearTemporaryFusionNodes(), 0, "empty clear is idempotent");
});

test("association hints stay temporary and confirmed fusion snapshots stay immutable", async (t) => {
  const store = await makeStore(t);
  for (const nodeId of ["node-a", "node-b"]) {
    await seedNode(store, { id: nodeId, sessionId: `session:${nodeId}`, status: "active", createdAt: NOW, updatedAt: NOW });
  }
  await seedNode(store, { id: "fusion-formal", sessionId: "session:fusion", isFusionNode: true, status: "active", createdAt: NOW, updatedAt: NOW });
  const hint: ResearchAssociationHintRecord = {
    id: "hint-1",
    anchorNodeId: "node-a",
    relatedNodeId: "node-b",
    relationType: "shared-concept",
    reason: "可返回原文的临时关联",
    anchorRanges: [{ nodeId: "node-a", bodyVersionId: "body:a:1", fragmentId: "fragment:a:1" }],
    relatedRanges: [{ nodeId: "node-b", bodyVersionId: "body:b:1", fragmentId: "fragment:b:1" }],
    evidenceContentKey: "content-1",
    evidenceKey: "evidence-1",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
  assert.deepEqual(await store.createAssociationHint(hint), hint);
  assert.deepEqual(await store.createAssociationHint({ ...hint, id: "hint-retry" }), hint);
  await store.saveAssociationHint({ ...hint, status: "ignored", ignoredAt: NOW });
  await assert.rejects(store.saveAssociationHint(hint), /cannot transition/i);
  await assert.rejects(store.saveAssociationHint({ ...hint, status: "expired", expiredAt: NOW }), /cannot transition/i);
  assert.deepEqual(store.listResearchPermanentEdges(), []);

  const snapshot: ResearchConfirmedFusionSnapshotRecord = {
    fusionNodeId: "fusion-formal",
    confirmedDraftVersionId: "draft-1",
    body: "固定的正式融合正文",
    contentHash: "sha256:formal",
    directSources: [
      { sourceNodeId: "node-a", bodyVersionId: "body:a:1", fragmentIds: ["fragment:a:1"] },
      { sourceNodeId: "node-b", bodyVersionId: "body:b:1", fragmentIds: ["fragment:b:1"] },
    ],
    confirmedAt: NOW,
  };
  assert.deepEqual(await store.createConfirmedFusionSnapshot(snapshot), snapshot);
  assert.deepEqual(await store.createConfirmedFusionSnapshot(snapshot), snapshot);
  await assert.rejects(store.createConfirmedFusionSnapshot({ ...snapshot, body: "尝试改写" }), /immutable/i);
});
