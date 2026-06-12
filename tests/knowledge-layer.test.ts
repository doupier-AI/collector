import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CaptureInput } from "@collector/capture-contracts";
import { CaptureService, JsonStore, ValidationError } from "@collector/api";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "collector-knowledge-"));
  const store = new JsonStore(join(root, "store.json"));
  await store.init();
  return { root, store, service: new CaptureService(store, join(root, "artifacts")) };
}

function input(content: string): CaptureInput {
  return { captureType: "pasted_text", content, locator: { kind: "user_supplied" }, clientCaptureId: crypto.randomUUID(), capturedAt: new Date().toISOString() };
}

test("accepting a proposal creates an auditable formal relation", async (t) => {
  const { root, store, service } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const capture = await service.createCapture(input("A standalone knowledge statement long enough to create a review proposal."));
  const proposal = service.listInbox()[0].reviewProposals[0];
  await service.decideReviewProposal(proposal.id, "accepted");
  const relation = service.listRelations(capture.id)[0];
  assert.equal(relation.proposalId, proposal.id);
  assert.equal(relation.status, "active");
  assert.deepEqual(relation.evidenceFragmentIds, proposal.evidenceFragmentIds);
  assert.equal(store.listUserDecisions()[0].action, "accepted");
});

test("rejecting or deferring a proposal does not create a formal relation", async (t) => {
  const { root, service } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await service.createCapture(input("First independent statement that will be rejected after review."));
  const first = service.listInbox()[0].reviewProposals[0];
  await service.decideReviewProposal(first.id, "rejected");
  await service.createCapture(input("Second independent statement that will remain deferred for later."));
  const second = service.listInbox().find((item) => item.capture.content?.startsWith("Second"))!.reviewProposals[0];
  await service.decideReviewProposal(second.id, "deferred");
  assert.equal(service.listRelations().length, 0);
});

test("revoking a relation preserves the relation and appends an audit decision", async (t) => {
  const { root, store, service } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await service.createCapture(input("Knowledge that will be accepted and then explicitly revoked without deletion."));
  const proposal = service.listInbox()[0].reviewProposals[0];
  await service.decideReviewProposal(proposal.id, "accepted");
  const relation = service.listRelations()[0];
  const revoked = await service.revokeRelation(relation.id);
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.version, 2);
  assert.equal(service.listRelations()[0].id, relation.id);
  assert.deepEqual(store.listUserDecisions().map((decision) => decision.action), ["accepted", "revoked"]);
});

test("final review decisions cannot be silently changed", async (t) => {
  const { root, service } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await service.createCapture(input("Knowledge with a final accepted decision that must remain stable."));
  const proposal = service.listInbox()[0].reviewProposals[0];
  await service.decideReviewProposal(proposal.id, "accepted");
  await assert.rejects(() => service.decideReviewProposal(proposal.id, "rejected"), ValidationError);
  assert.equal(service.listRelations().length, 1);
});

test("topic workspace contains members and only active formal relations", async (t) => {
  const { root, service } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await service.createCapture(input("Collector uses evidence fragments to preserve the source of knowledge."));
  const second = await service.createCapture(input("Collector uses evidence fragments to preserve source traceability and review."));
  const relatedProposal = service.listInbox().find((item) => item.capture.id === second.id)!.reviewProposals[0];
  await service.decideReviewProposal(relatedProposal.id, "accepted");
  const topic = await service.createTopic("Trusted knowledge");
  await service.addTopicMember(topic.id, first.id);
  await service.addTopicMember(topic.id, second.id);
  let workspace = service.getTopicWorkspace(topic.id);
  assert.equal(workspace.captures.length, 2);
  assert.equal(workspace.relations.length, 1);
  await service.revokeRelation(workspace.relations[0].id);
  workspace = service.getTopicWorkspace(topic.id);
  assert.equal(workspace.relations.length, 0);
  const renamed = await service.updateTopic(topic.id, { title: "Evidence workspace", status: "archived" });
  assert.equal(renamed.status, "archived");
  assert.equal(renamed.title, "Evidence workspace");
});

test("capture topicId creates the topic membership with the capture", async (t) => {
  const { root, service } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const topic = await service.createTopic("Direct capture topic");
  const withTopic = { ...input("A second capture submitted with a topic identifier for atomic membership persistence."), topicId: topic.id };
  const stored = await service.createCapture(withTopic);
  assert.equal(service.getTopicWorkspace(topic.id).captures[0].capture.id, stored.id);
  await assert.rejects(() => service.createCapture({ ...input("An invalid topic reference must reject the capture before persistence."), topicId: "missing-topic" }), ValidationError);
  assert.equal(service.listInbox().length, 1);
});
