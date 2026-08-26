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
import { deriveFusionEvidenceHealth, SqliteStore, TemporaryFusionDraftConflictError, TemporaryFusionDraftService } from "@collector/api";

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

async function createConfirmableTemporaryFusion(store: SqliteStore, id = "temporary-confirmable") {
  for (const nodeId of ["node-source-a", "node-source-b"]) {
    if (!store.getResearchNode(nodeId)) {
      await seedNode(store, { id: nodeId, sessionId: `session:${nodeId}`, status: "active", createdAt: NOW, updatedAt: NOW });
    }
    if (!store.getBodyVersion(`body:${nodeId}:v1`)) {
      await store.createResearchBodyVersion({
        id: `body:${nodeId}:v1`, messageId: `message:${nodeId}`, nodeId, version: 1,
        content: `正式来源 ${nodeId} 支持这项认识。`, contentHash: `sha256:${nodeId}`, origin: "generation", createdAt: NOW,
      });
    }
  }
  const bundle = temporaryFusionBundle(id);
  bundle.node.creationKey = `confirmation:${id}`;
  bundle.activeDraft.body = "已核验判断[来源1][来源2]";
  bundle.activeDraft.contentHash = `sha256:${id}`;
  bundle.candidateSources = bundle.candidateSources.map((source) => ({
    ...source,
    id: `${id}:source:${source.sourceNodeId}`,
    temporaryFusionNodeId: id,
  }));
  await store.createTemporaryFusionBundle(bundle);
  return bundle;
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

test("explicit draft edits create immutable versions, preserve unaffected evidence, and reject a stale writer", async (t) => {
  const store = await makeStore(t);
  for (const nodeId of ["node-source-a", "node-source-b"]) {
    await seedNode(store, { id: nodeId, sessionId: `session:${nodeId}`, status: "active", createdAt: NOW, updatedAt: NOW });
    await store.createResearchBodyVersion({ id: `body:${nodeId}:v1`, messageId: `message:${nodeId}`, nodeId, version: 1, content: `正式来源 ${nodeId} 支持这项认识。`, contentHash: `sha256:${nodeId}`, origin: "generation", createdAt: NOW });
  }
  const candidate = temporaryFusionBundle("draft-versioning");
  candidate.activeDraft.body = "原判断[来源1][来源2]";
  candidate.activeDraft.contentHash = "sha256:original";
  await store.createTemporaryFusionBundle(candidate);
  const drafts = new TemporaryFusionDraftService(store, async () => ({ async verifyTemporaryFusionDraftEvidence() { return { verified: true }; } }));

  const updated = await drafts.update(candidate.node.id, { body: "原判断[来源1][来源2]\n\n新增判断[来源1][来源2]", expectedDraftVersionId: candidate.activeDraft.id });
  assert.equal(updated.bundle.activeDraft.version, 2);
  assert.equal(updated.revalidationTasks.length, 1, "the unchanged cited judgment reuses its prior verified result");
  assert.equal(store.listTemporaryFusionDraftVersions(candidate.node.id).length, 2);
  assert.equal(store.listTemporaryFusionDraftVersions(candidate.node.id)[1]?.body, candidate.activeDraft.body, "old body remains immutable");
  await assert.rejects(drafts.update(candidate.node.id, { body: "并发覆盖", expectedDraftVersionId: candidate.activeDraft.id }), TemporaryFusionDraftConflictError);
  const restored = await drafts.restore(candidate.node.id, candidate.activeDraft.id, updated.bundle.activeDraft.id);
  assert.equal(restored.bundle.activeDraft.version, 3, "restore creates a new current version instead of deleting history");
  assert.equal(store.listTemporaryFusionDraftVersions(candidate.node.id).length, 3);
});

test("T06 confirms one verified draft in place, closes its temporary projection, and is idempotent", async (t) => {
  const store = await makeStore(t);
  const candidate = await createConfirmableTemporaryFusion(store);
  await store.createTemporaryFusionTurn(
    { id: "confirm-input", temporaryFusionNodeId: candidate.node.id, role: "user", content: "确认前尚未完成的讨论", status: "completed", createdAt: NOW, updatedAt: NOW },
    { id: "confirm-output", temporaryFusionNodeId: candidate.node.id, role: "assistant", content: "", status: "pending", createdAt: NOW, updatedAt: NOW },
    { id: "confirm-task", temporaryFusionNodeId: candidate.node.id, inputMessageId: "confirm-input", outputMessageId: "confirm-output", idempotencyKey: "confirm-task-key", status: "queued", retryable: false, promptVersion: "temporary-fusion-conversation-v1", createdAt: NOW, updatedAt: NOW },
  );

  const first = await store.confirmTemporaryFusionInPlace(candidate.node.id, candidate.activeDraft.id, "2026-08-26T01:02:03.000Z");
  assert.equal(first.fusionNode.id, candidate.node.id, "confirmation keeps the temporary identity");
  assert.equal(first.fusionNode.sessionId, candidate.node.id, "formal map projection has its own root container");
  assert.equal(first.session.projectId, undefined, "all-unclassified sources keep the confirmed session unclassified");
  assert.equal(first.snapshot.body, candidate.activeDraft.body, "confirmation never regenerates the current body");
  assert.equal(first.snapshot.contentHash, candidate.activeDraft.contentHash);
  assert.deepEqual(first.snapshot.directSources.map((source) => source.sourceNodeId).sort(), ["node-source-a", "node-source-b"]);
  assert.equal(store.listTemporaryFusionNodes().length, 0, "confirmed identity leaves the temporary layer");
  assert.equal(store.getTemporaryFusionNode(candidate.node.id)?.confirmedAt, first.snapshot.confirmedAt, "draft audit remains readable");
  assert.equal(store.listTemporaryFusionDraftVersions(candidate.node.id).length, 1, "immutable draft history survives confirmation");
  assert.equal(store.getTemporaryFusionTask("confirm-task")?.status, "cancelled", "confirmation closes outstanding temporary-only work");
  assert.deepEqual(store.listResearchPermanentEdges().map((edge) => [edge.kind, edge.fromNodeId, edge.toNodeId]).sort(), [
    ["fused-from", "node-source-a", candidate.node.id],
    ["fused-from", "node-source-b", candidate.node.id],
  ]);
  assert.ok(store.listAllResearchNodes().some((node) => node.id === candidate.node.id && node.isFusionNode), "formal map sees only the promoted node");

  const retried = await store.confirmTemporaryFusionInPlace(candidate.node.id, candidate.activeDraft.id, "2026-08-26T01:03:04.000Z");
  assert.deepEqual(retried, first, "repeated confirmation returns the original snapshot without duplicate edges");
  assert.equal(await store.deleteTemporaryFusionNode(candidate.node.id), false, "confirmation audit cannot be deleted as a temporary candidate");
});

test("T07 assigns a confirmed fusion to a project only when every direct source belongs to that same project", async (t) => {
  const store = await makeStore(t);
  await store.createProject({ id: "project-a", name: "Project A", colorRole: "amber", createdAt: NOW, updatedAt: NOW }, "project:a");
  await store.createProject({ id: "project-b", name: "Project B", colorRole: "violet", createdAt: NOW, updatedAt: NOW }, "project:b");
  await createConfirmableTemporaryFusion(store, "confirmation-project-bootstrap");

  await store.updateResearchSession("session:node-source-a", { projectId: "project-a" });
  await store.updateResearchSession("session:node-source-b", { projectId: "project-a" });
  const sameProject = await createConfirmableTemporaryFusion(store, "confirmation-same-project");
  assert.equal(
    (await store.confirmTemporaryFusionInPlace(sameProject.node.id, sameProject.activeDraft.id, NOW)).session.projectId,
    "project-a",
    "all direct sources in one project inherit that project",
  );

  await store.updateResearchSession("session:node-source-b", { projectId: "project-b" });
  const crossProject = await createConfirmableTemporaryFusion(store, "confirmation-cross-project");
  assert.equal(
    (await store.confirmTemporaryFusionInPlace(crossProject.node.id, crossProject.activeDraft.id, NOW)).session.projectId,
    undefined,
    "cross-project direct sources default to unclassified",
  );

  await store.updateResearchSession("session:node-source-b", { projectId: null });
  const includesUnclassified = await createConfirmableTemporaryFusion(store, "confirmation-unclassified-source");
  assert.equal(
    (await store.confirmTemporaryFusionInPlace(includesUnclassified.node.id, includesUnclassified.activeDraft.id, NOW)).session.projectId,
    undefined,
    "a source without a project prevents implicit project assignment",
  );
});

test("T08 changes source health across trash, restore, and permanent deletion without changing confirmed fusion facts", async (t) => {
  const store = await makeStore(t);
  const candidate = await createConfirmableTemporaryFusion(store, "t08-confirmed-source-health");
  const confirmed = await store.confirmTemporaryFusionInPlace(candidate.node.id, candidate.activeDraft.id, NOW);
  const originalSnapshot = structuredClone(confirmed.snapshot);

  assert.equal(await store.trashResearchSession("session:node-source-a", NOW), true);
  assert.equal(store.getTemporaryFusionBundle(candidate.node.id)?.candidateSources.find((source) => source.sourceNodeId === "node-source-a")?.sourceHealth, "temporarily-unavailable");
  assert.equal(
    deriveFusionEvidenceHealth(
      [...store.listAllResearchNodes(), ...store.listResearchNodes("session:node-source-a")],
      store.listAllResearchEdges(),
      [...store.listResearchSessions(), ...store.listTrashedResearchSessions()],
      store.listConfirmedFusionSourceHealth(),
    ).get(candidate.node.id),
    "temporarily-unavailable",
  );
  assert.deepEqual(store.getConfirmedFusionSnapshot(candidate.node.id), originalSnapshot, "trash never rewrites the confirmed snapshot");

  assert.equal(await store.restoreResearchSession("session:node-source-a"), true);
  assert.equal(store.getTemporaryFusionBundle(candidate.node.id)?.candidateSources.find((source) => source.sourceNodeId === "node-source-a")?.sourceHealth, "available");
  assert.equal(
    deriveFusionEvidenceHealth(store.listAllResearchNodes(), store.listAllResearchEdges(), store.listResearchSessions(), store.listConfirmedFusionSourceHealth()).get(candidate.node.id),
    "available",
  );

  assert.equal(await store.deleteResearchSession("session:node-source-a"), true);
  assert.equal(store.getResearchNode("node-source-a"), undefined);
  assert.equal(store.getBodyVersion("body:node-source-a:v1"), undefined, "permanent deletion leaves no source body readable through the API store");
  assert.equal(store.getTemporaryFusionBundle(candidate.node.id)?.candidateSources.find((source) => source.sourceNodeId === "node-source-a")?.sourceHealth, "deleted");
  assert.deepEqual(store.getConfirmedFusionSnapshot(candidate.node.id), originalSnapshot, "permanent deletion keeps the fixed confirmed body and source identity unchanged");
  assert.ok(!store.listResearchPermanentEdges().some((edge) => edge.fromNodeId === "node-source-a" || edge.toNodeId === "node-source-a"), "permanent deletion removes edges whose endpoint is no longer a formal node");
  assert.equal(
    deriveFusionEvidenceHealth(store.listAllResearchNodes(), store.listAllResearchEdges(), store.listResearchSessions(), store.listConfirmedFusionSourceHealth()).get(candidate.node.id),
    "deleted",
  );
});

test("T08 keeps an unconfirmed candidate visible but blocks confirmation when a direct source is unavailable", async (t) => {
  const store = await makeStore(t);
  const candidate = await createConfirmableTemporaryFusion(store, "t08-temporary-source-health");
  assert.equal(await store.trashResearchSession("session:node-source-a", NOW), true);
  const unavailable = store.getTemporaryFusionBundle(candidate.node.id)!;
  assert.equal(unavailable.candidateSources.find((source) => source.sourceNodeId === "node-source-a")?.sourceHealth, "temporarily-unavailable");
  await assert.rejects(
    store.confirmTemporaryFusionInPlace(candidate.node.id, candidate.activeDraft.id, NOW),
    /available direct sources/i,
  );
  assert.equal(await store.restoreResearchSession("session:node-source-a"), true);
  assert.equal(store.getTemporaryFusionBundle(candidate.node.id)?.candidateSources.find((source) => source.sourceNodeId === "node-source-a")?.sourceHealth, "available");
});

test("T08 source-health lifecycle transactions roll back both session and connection state on an injected fault", async (t) => {
  const store = await makeStore(t);
  const candidate = await createConfirmableTemporaryFusion(store, "t08-transaction-fault");
  const db = (store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  db.exec(`CREATE TRIGGER fail_t08_health_update
    BEFORE UPDATE ON research_candidate_source_connections
    WHEN NEW.source_health = 'temporarily-unavailable'
    BEGIN SELECT RAISE(ABORT, 'injected T08 source health failure'); END;`);

  await assert.rejects(store.trashResearchSession("session:node-source-a", NOW), /injected T08 source health failure/i);
  assert.equal(store.getResearchSession("session:node-source-a")?.trashedAt, undefined, "failed trash must not move the session");
  assert.equal(store.getTemporaryFusionBundle(candidate.node.id)?.candidateSources.find((source) => source.sourceNodeId === "node-source-a")?.sourceHealth, "available", "failed trash must not leave a changed connection");

  db.exec("DROP TRIGGER fail_t08_health_update");
  db.exec(`CREATE TRIGGER fail_t08_node_delete
    BEFORE DELETE ON research_nodes
    WHEN OLD.id = 'node-source-a'
    BEGIN SELECT RAISE(ABORT, 'injected T08 node deletion failure'); END;`);
  await assert.rejects(store.deleteResearchSession("session:node-source-a"), /injected T08 node deletion failure/i);
  assert.ok(store.getResearchNode("node-source-a"), "failed permanent deletion must retain the source node");
  assert.ok(store.getBodyVersion("body:node-source-a:v1"), "failed permanent deletion must retain source body atomically");
  assert.equal(store.getTemporaryFusionBundle(candidate.node.id)?.candidateSources.find((source) => source.sourceNodeId === "node-source-a")?.sourceHealth, "available", "failed permanent deletion must roll back the deleted marker");
});

test("T06 rejects stale or unverified confirmation and rolls back every formal write on an injected edge failure", async (t) => {
  const store = await makeStore(t);
  const candidate = await createConfirmableTemporaryFusion(store, "temporary-confirmation-guard");
  await assert.rejects(
    store.confirmTemporaryFusionInPlace(candidate.node.id, "draft:stale", NOW),
    /version conflict/i,
  );
  assert.equal(store.getResearchNode(candidate.node.id), undefined);

  const pending = await createConfirmableTemporaryFusion(store, "temporary-confirmation-pending");
  const db = (store as unknown as { db(): import("node:sqlite").DatabaseSync }).db();
  db.prepare("UPDATE research_fusion_draft_versions SET evidence_status = ?, record_json = ? WHERE id = ?")
    .run("pending", JSON.stringify({ ...pending.activeDraft, evidenceStatus: "pending" }), pending.activeDraft.id);
  await assert.rejects(
    store.confirmTemporaryFusionInPlace(pending.node.id, pending.activeDraft.id, NOW),
    /verified active draft/i,
  );
  assert.equal(store.getResearchNode(pending.node.id), undefined);

  db.exec(`CREATE TRIGGER fail_t06_confirmation_edge
    BEFORE INSERT ON research_edges
    WHEN NEW.to_node_id = '${candidate.node.id}'
    BEGIN SELECT RAISE(ABORT, 'injected confirmation edge failure'); END;`);
  await assert.rejects(
    store.confirmTemporaryFusionInPlace(candidate.node.id, candidate.activeDraft.id, NOW),
    /injected confirmation edge failure/i,
  );
  assert.equal(store.getResearchSession(candidate.node.id), undefined, "session insert rolled back");
  assert.equal(store.getResearchNode(candidate.node.id), undefined, "formal node insert rolled back");
  assert.equal(store.getConfirmedFusionSnapshot(candidate.node.id), undefined, "snapshot insert rolled back");
  assert.equal(store.getTemporaryFusionNode(candidate.node.id)?.confirmedAt, undefined, "temporary draft remains active after rollback");
  assert.equal(store.listResearchPermanentEdges().filter((edge) => edge.toNodeId === candidate.node.id).length, 0, "no orphan edge remains");
});

test("T06 preserves original citation ordinals when a confirmed draft adopts non-contiguous sources", async (t) => {
  const store = await makeStore(t);
  await createConfirmableTemporaryFusion(store, "confirmation-source-bootstrap");
  await seedNode(store, { id: "node-source-c", sessionId: "session:node-source-c", status: "active", createdAt: NOW, updatedAt: NOW });
  await store.createResearchBodyVersion({
    id: "body:node-source-c:v1", messageId: "message:node-source-c", nodeId: "node-source-c", version: 1,
    content: "正式来源 C 支持这项认识。", contentHash: "sha256:node-source-c", origin: "generation", createdAt: NOW,
  });
  const candidate = temporaryFusionBundle("temporary-non-contiguous-sources");
  candidate.node.creationKey = "confirmation:non-contiguous";
  candidate.activeDraft.body = "来源一与来源三共同支持判断[来源1][来源3]";
  candidate.activeDraft.contentHash = "sha256:non-contiguous";
  candidate.candidateSources = [
    { ...candidate.candidateSources[0]!, id: "non-contiguous:source:a", temporaryFusionNodeId: candidate.node.id, citationOrdinal: 1 },
    { ...candidate.candidateSources[1]!, id: "non-contiguous:source:c", temporaryFusionNodeId: candidate.node.id, sourceNodeId: "node-source-c", bodyVersionId: "body:node-source-c:v1", fragmentIds: ["fragment:node-source-c:1"], citationOrdinal: 3 },
  ];
  await store.createTemporaryFusionBundle(candidate);

  const confirmed = await store.confirmTemporaryFusionInPlace(candidate.node.id, candidate.activeDraft.id, NOW);
  assert.deepEqual(confirmed.snapshot.directSources.map((source) => source.sourceNodeId).sort(), ["node-source-a", "node-source-c"]);
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

test("temporary conversation is idempotent, recoverable, and cascades with its candidate", async (t) => {
  const store = await makeStore(t);
  for (const nodeId of ["node-source-a", "node-source-b"]) {
    await seedNode(store, { id: nodeId, sessionId: `session:${nodeId}`, status: "active", createdAt: NOW, updatedAt: NOW });
  }
  const candidate = temporaryFusionBundle("temporary-conversation");
  candidate.node.creationKey = "conversation-generation";
  await store.createTemporaryFusionBundle(candidate);
  const input = { id: "temp-message-input", temporaryFusionNodeId: candidate.node.id, role: "user" as const, content: "这条候选的证据边界是什么？", status: "completed" as const, createdAt: NOW, updatedAt: NOW };
  const output = { id: "temp-message-output", temporaryFusionNodeId: candidate.node.id, role: "assistant" as const, content: "", status: "pending" as const, createdAt: NOW, updatedAt: NOW };
  const task = { id: "temp-task", temporaryFusionNodeId: candidate.node.id, inputMessageId: input.id, outputMessageId: output.id, idempotencyKey: "temporary-turn-key", status: "queued" as const, retryable: false, promptVersion: "temporary-fusion-conversation-v1", createdAt: NOW, updatedAt: NOW };
  const accepted = await store.createTemporaryFusionTurn(input, output, task);
  assert.deepEqual(await store.createTemporaryFusionTurn({ ...input, id: "duplicate-input" }, { ...output, id: "duplicate-output" }, { ...task, id: "duplicate-task" }), accepted, "same idempotency key returns the original turn");
  const claimed = store.claimTemporaryFusionTask(task.id, "fake", "fake-model");
  assert.equal(claimed?.status, "running");
  assert.equal(store.requeueInterruptedTemporaryFusionTasks(), 1);
  assert.equal(store.getTemporaryFusionTask(task.id)?.status, "queued");
  const reClaimed = store.claimTemporaryFusionTask(task.id);
  assert.ok(reClaimed);
  await store.appendTemporaryFusionTaskDelta(task.id, "只讨论，不改写草案。");
  await store.completeTemporaryFusionTask(task.id);
  assert.equal(store.getTemporaryFusionMessage(output.id)?.content, "只讨论，不改写草案。");
  assert.deepEqual(store.getTemporaryFusionBundle(candidate.node.id)?.activeDraft, candidate.activeDraft, "discussion must not mutate the active draft");
  await store.deleteTemporaryFusionNode(candidate.node.id);
  assert.equal(store.getTemporaryFusionMessage(input.id), undefined);
  assert.equal(store.getTemporaryFusionTask(task.id), undefined);
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
