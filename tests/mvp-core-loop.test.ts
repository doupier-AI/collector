import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CaptureService, SqliteStore } from "@collector/api";
import { FakeProvider, ModelGateway } from "@collector/model-gateway";

const captureInput = (content: string, id: string) => ({
  captureType: "pasted_text" as const,
  content,
  locator: { kind: "user_supplied" as const },
  clientCaptureId: id,
  capturedAt: new Date().toISOString(),
});

test("cluster promotion trusts the persisted snapshot membership", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-mvp-cluster-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const first = await service.createCapture(captureInput("Alpha material with enough source text.", "mvp-cluster-1"), "mvp-cluster-1");
  const second = await service.createCapture(captureInput("Beta material with enough source text.", "mvp-cluster-2"), "mvp-cluster-2");
  service.setModelGateway(new ModelGateway(new FakeProvider([JSON.stringify({
    clusters: [{ name: "Persisted group", summary: "A trusted group.", materialIds: [first.id, second.id] }],
    unclusteredMaterialIds: [],
  })])));

  await service.organizeRecent("mvp-cluster-run");
  assert.equal(await service.resumeRecentOrganizationRuns(), 7);
  const snapshot = service.getLatestRecentClusterSnapshot();
  const topic = await service.promoteClusterToTopic(snapshot.id, 0, "Trusted topic");
  assert.deepEqual(store.listTopicCaptureIds(topic.id).sort(), [first.id, second.id].sort());
  await assert.rejects(service.promoteClusterToTopic("spoofed-snapshot", 0, "Spoofed"));
});

test("recent cluster validation rejects forced and duplicate memberships and stabilizes unchanged groups", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-mvp-cluster-validation-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const first = await service.createCapture(captureInput("Shared subject evidence one.", "mvp-validate-1"), "mvp-validate-1");
  const second = await service.createCapture(captureInput("Shared subject evidence two.", "mvp-validate-2"), "mvp-validate-2");
  const unrelated = await service.createCapture(captureInput("An unrelated singleton.", "mvp-validate-3"), "mvp-validate-3");
  const proposal = JSON.stringify({
    clusters: [
      { name: "Reliable pair", summary: "Two related materials.", materialIds: [first.id, second.id, second.id] },
      { name: "Forced singleton", summary: "Must remain unclustered.", materialIds: [unrelated.id, "foreign-material", first.id] },
    ],
    unclusteredMaterialIds: [],
  });
  service.setModelGateway(new ModelGateway(new FakeProvider([proposal, proposal])));

  await service.organizeRecent("mvp-validate-run-1");
  await service.resumeRecentOrganizationRuns();
  const firstSnapshot = service.getLatestRecentClusterSnapshot();
  assert.equal(firstSnapshot.clusters.length, 1);
  assert.deepEqual(firstSnapshot.clusters[0].materialIds, [first.id, second.id]);
  assert.deepEqual(firstSnapshot.unclusteredMaterialIds, [unrelated.id]);

  await service.organizeRecent("mvp-validate-run-2");
  await service.resumeRecentOrganizationRuns();
  const secondSnapshot = service.getLatestRecentClusterSnapshot();
  assert.equal(secondSnapshot.clusters[0].id, firstSnapshot.clusters[0].id);
});

test("materials disabled for cloud AI remain local and are never sent into AI workflows", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-mvp-local-only-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const first = await service.createCapture(captureInput("Cloud eligible material one.", "mvp-cloud-1"), "mvp-cloud-1");
  const second = await service.createCapture(captureInput("Cloud eligible material two.", "mvp-cloud-2"), "mvp-cloud-2");
  const localOnly = await service.createCapture(captureInput("Private local-only material.", "mvp-local-only"), "mvp-local-only");
  await service.setMaterialAiProcessing(localOnly.id, true);
  service.setModelGateway(new ModelGateway(new FakeProvider([JSON.stringify({
    clusters: [{ name: "Eligible pair", summary: "Only cloud-eligible content.", materialIds: [first.id, second.id, localOnly.id] }],
    unclusteredMaterialIds: [],
  })])));

  await service.organizeRecent("mvp-local-only-run");
  await service.resumeRecentOrganizationRuns();
  const snapshot = service.getLatestRecentClusterSnapshot();
  assert.deepEqual(snapshot.clusters[0].materialIds, [first.id, second.id]);
  assert.ok(snapshot.unclusteredMaterialIds.includes(localOnly.id));
  const topic = await service.createTopic("Private topic", [first.id, localOnly.id]);
  await assert.rejects(service.generateTopicDocument(topic.id, "mvp-private-doc"), /cloud AI processing disabled/);
  const detail = service.getMaterial(localOnly.id);
  assert.equal(detail.aiProcessingDisabled, true);
  assert.ok(detail.fragments.every((fragment: { id?: string }) => Boolean(fragment.id)));
});

test("material revisions atomically replace searchable content and citable fragments", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-mvp-revision-current-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const material = await service.createCapture(captureInput("Original wording for the material.", "mvp-revision-current"), "mvp-revision-current");
  const originalFragmentIds = store.listFragments(material.id).map((fragment) => fragment.id);
  await service.editRevision(material.id, "Revised searchable wording with current evidence.");

  assert.equal(store.getCapture(material.id)?.content, "Revised searchable wording with current evidence.");
  assert.equal(service.listMaterials("current evidence").total, 1);
  assert.equal(service.listMaterials("Original wording").total, 0);
  const revisedFragments = store.listFragments(material.id);
  assert.ok(revisedFragments.some((fragment) => fragment.text.includes("Revised searchable wording")));
  assert.ok(revisedFragments.every((fragment) => !originalFragmentIds.includes(fragment.id)));
});

test("topic document completes all checkpoints and stays on the requested topic", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-mvp-document-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const shared = await service.createCapture(captureInput("Research shows TypeScript improves maintainability because types expose errors.", "mvp-doc-1"), "mvp-doc-1");
  const firstTopic = await service.createTopic("First topic", [shared.id]);
  const targetTopic = await service.createTopic("Target topic", [shared.id]);
  service.setModelGateway(new ModelGateway(new FakeProvider([
    JSON.stringify({ title: "Target document", sections: [{ heading: "Evidence", keyPoints: ["Types expose errors."] }] }),
    JSON.stringify({ sections: [{ heading: "Evidence", markdown: "Research shows maintainability improves because types expose errors.", citationMaterialIds: [shared.id] }] }),
  ])));

  const run = await service.generateTopicDocument(targetTopic.id, "mvp-doc-run");
  assert.equal(run.topicId, targetTopic.id);
  assert.equal(await service.resumeTopicDocumentRuns(), 10);
  assert.equal(service.getWorkflowRun(run.id).status, "completed");
  assert.equal(store.getWorkflowSteps(run.id).length, 10);
  assert.equal(service.getLatestTopicDocument(firstTopic.id), undefined);
  const document = service.getLatestTopicDocument(targetTopic.id);
  assert.ok(document);
  assert.equal(document.topicId, targetTopic.id);
  assert.deepEqual(document.materialIds, [shared.id]);
  assert.ok(document.sections.every((section) => section.citationIds.length > 0));
  const modelCalls = store.listModelCalls(run.id);
  assert.deepEqual(modelCalls.map((call) => call.purpose), ["document_outline", "document_sections"]);
  assert.ok(modelCalls.every((call) => call.inputTokens > 0 && call.outputTokens > 0));
  const claims = service.getVerificationClaims(document.id);
  assert.ok(claims.length > 0);
  assert.ok(claims.every((claim) => claim.status === "unverified" && claim.sources.length === 0));
});

test("failed model generation publishes no document version", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-mvp-model-failure-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const material = await service.createCapture(captureInput("A citable material that cannot be drafted without a model.", "mvp-failure-1"), "mvp-failure-1");
  const topic = await service.createTopic("Failure topic", [material.id]);
  const run = await service.generateTopicDocument(topic.id, "mvp-failure-run");
  assert.equal(await service.resumeTopicDocumentRuns(), 3);
  assert.equal(service.getWorkflowRun(run.id).status, "failed");
  assert.equal(service.getLatestTopicDocument(topic.id), undefined);
});

test("AI workflows wait for budget and resume after the limit is raised", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-mvp-budget-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  await store.saveModelCall({
    id: crypto.randomUUID(), provider: "deepseek", model: "test-model", purpose: "budget-fixture", promptVersion: "v1",
    status: "completed", inputTokens: 1, outputTokens: 1, cacheHitTokens: 0, estimatedCostUsd: 1,
    latencyMs: 1, retryCount: 0, createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
  });
  await service.updateAiBudgetSettings({ monthlyLimitUsd: 1, warningThresholdUsd: 0.5, enabled: true });
  const material = await service.createCapture(captureInput("A citable source for a budget-aware document.", "mvp-budget-1"), "mvp-budget-1");
  const topic = await service.createTopic("Budget-aware topic", [material.id]);
  service.setModelGateway(new ModelGateway(new FakeProvider([
    JSON.stringify({ title: "Budget-aware document", sections: [{ heading: "Evidence", keyPoints: ["A supported point."] }] }),
    JSON.stringify({ sections: [{ heading: "Evidence", markdown: "A supported point from the source.", citationMaterialIds: [material.id] }] }),
  ])));

  const run = await service.generateTopicDocument(topic.id, "mvp-budget-run");
  assert.equal(await service.resumeTopicDocumentRuns(), 3);
  assert.equal(service.getWorkflowRun(run.id).status, "waiting_for_budget");
  assert.equal(store.getWorkflowSteps(run.id).find((step) => step.stepType === "build_outline")?.status, "waiting_for_budget");
  assert.equal(service.getLatestTopicDocument(topic.id), undefined);

  await service.updateAiBudgetSettings({ monthlyLimitUsd: 2 });
  assert.equal(await service.resumeTopicDocumentRuns(), 8);
  assert.equal(service.getWorkflowRun(run.id).status, "completed");
  assert.equal(service.getWorkflowRun(run.id).errorMessage, undefined);
  assert.ok(service.getLatestTopicDocument(topic.id));
});

test("incremental confirmation preserves existing sections and records the new material set", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-mvp-incremental-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const first = await service.createCapture(captureInput("Research shows the first fact is stable because evidence exists.", "mvp-update-1"), "mvp-update-1");
  const topic = await service.createTopic("Incremental topic", [first.id]);
  service.setModelGateway(new ModelGateway(new FakeProvider([
    JSON.stringify({ title: "Incremental document", sections: [{ heading: "Stable section", keyPoints: ["The first fact is stable."] }] }),
    JSON.stringify({ sections: [{ heading: "Stable section", markdown: "Research shows the first fact is stable because evidence exists.", citationMaterialIds: [first.id] }] }),
    JSON.stringify({ additions: [{ heading: "New evidence", markdown: "The newly collected fact extends the topic.", citationMaterialIds: [] }] }),
  ])));
  await service.generateTopicDocument(topic.id, "mvp-update-run");
  assert.equal(await service.resumeTopicDocumentRuns(), 10);
  const original = service.getLatestTopicDocument(topic.id);
  assert.ok(original);

  const second = await service.createCapture(captureInput("A newly collected fact for the next version.", "mvp-update-2"), "mvp-update-2");
  service.setModelGateway(new ModelGateway(new FakeProvider([
    JSON.stringify({ additions: [{ heading: "New evidence", markdown: "The newly collected fact extends the topic.", citationMaterialIds: [second.id] }] }),
  ])));
  await service.addTopicMember(topic.id, second.id);
  const preview = await service.previewDocumentUpdate(topic.id);
  assert.ok(preview);
  assert.equal(preview.proposedAdditions.length, 1);
  assert.deepEqual(preview.keptSections, original.sections.map((section) => section.id));
  await service.confirmDocumentUpdate(topic.id, preview.id, true);
  const updated = service.getLatestTopicDocument(topic.id);
  assert.ok(updated);
  assert.equal(updated.documentVersion, 2);
  assert.deepEqual(updated.materialIds.sort(), [first.id, second.id].sort());
  assert.ok(updated.sections.some((section) => section.id === original.sections[0].id));
  assert.equal(updated.sections.length, original.sections.length + 1);
  assert.ok(updated.sections.some((section) => section.heading === "New evidence" && section.markdown === "The newly collected fact extends the topic."));
  assert.ok(!updated.sections.some((section) => section.markdown === second.content));

  const rolledBack = await service.rollbackTopicDocument(topic.id, original.id);
  assert.equal(rolledBack.documentVersion, 3);
  assert.deepEqual(rolledBack.sections, original.sections);
  assert.equal(service.getLatestTopicDocument(topic.id)?.id, rolledBack.id);
});

test("permanent deletion reports document and workflow impact and publishes a citation gap", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-mvp-delete-impact-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const material = await service.createCapture(captureInput("A source that will later be deleted after publication.", "mvp-delete-1"), "mvp-delete-1");
  const topic = await service.createTopic("Deletion impact", [material.id]);
  service.setModelGateway(new ModelGateway(new FakeProvider([
    JSON.stringify({ title: "Deletion impact", sections: [{ heading: "Evidence", keyPoints: ["A cited claim."] }] }),
    JSON.stringify({ sections: [{ heading: "Evidence", markdown: "A cited claim.", citationMaterialIds: [material.id] }] }),
  ])));
  await service.generateTopicDocument(topic.id, "mvp-delete-document");
  await service.resumeTopicDocumentRuns();
  const pending = await service.organizeRecent("mvp-delete-pending-run");

  const impact = service.getDeleteImpact(material.id);
  assert.deepEqual(impact.topicMemberships.map((membership: { topicId: string }) => membership.topicId), [topic.id]);
  assert.ok(impact.citationCount > 0);
  assert.ok(impact.workflowInputs.some((input: { workflowRunId: string }) => input.workflowRunId === pending.id));
  assert.deepEqual(await service.permanentDelete(material.id), { impactBlocked: true });

  assert.deepEqual(await service.permanentDelete(material.id, true), { deleted: true });
  assert.equal(service.getWorkflowRun(pending.id).status, "cancelled");
  const latest = service.getLatestTopicDocument(topic.id);
  assert.ok(latest);
  assert.equal(latest.documentVersion, 2);
  assert.deepEqual(latest.materialIds, []);
  assert.ok(latest.gapItems.some((gap) => gap.kind === "missing_context"));
  assert.ok(latest.sections.some((section) => section.citationIds.length > 0));
});
