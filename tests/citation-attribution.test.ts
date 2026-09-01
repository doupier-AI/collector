import assert from "node:assert/strict";
import test from "node:test";
import {
  CitationAttributionModule,
  type CitationAttributionInput,
  type CitationAttributionModelAdapter,
} from "@collector/api";

const now = () => new Date("2026-09-01T00:00:00.000Z");

function input(overrides: Partial<CitationAttributionInput> = {}): CitationAttributionInput {
  return {
    taskId: "task",
    messageId: "message",
    groundingRunId: "run",
    bodyVersionId: "body-version",
    generationAttempt: 1,
    body: "Node 24 is the current LTS release.",
    writer: { provider: "deepseek", model: "deepseek-v4-flash", version: "research-slices-v1" },
    sources: [{
      sourceId: "source-1",
      sourceOrdinal: 1,
      providerSourceId: "evidence-1",
      preparedEvidenceId: "evidence-1",
      sourceVersion: "digest-1",
      content: "The release page identifies Node 24 as the current LTS release.",
      evidenceStatus: "full",
      admitted: true,
    }],
    providerCandidates: [],
    ...overrides,
  };
}

function model(output: object): CitationAttributionModelAdapter {
  return {
    async produce() {
      return {
        output: JSON.stringify(output),
        provider: "deepseek",
        model: "deepseek-v4-flash",
        producerVersion: "citation-attribution-producer-v1",
      };
    },
  };
}

test("independent attribution accepts only an exact, admitted, policy-qualified support candidate", async () => {
  const value = input();
  const claimText = "Node 24 is the current LTS release.";
  const evidenceText = "Node 24 as the current LTS release";
  const result = await new CitationAttributionModule(model({ attributions: [{
    sourceOrdinal: 1,
    claimText,
    evidenceText,
    support: true,
    confidence: 0.94,
  }] }), now).attribute(value);

  assert.equal(result.run.status, "completed");
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0]?.candidateProducer.kind, "independent_model");
  assert.equal(result.accepted[0]?.evidenceIdentity.sourceId, "source-1");
  assert.equal(result.accepted[0]?.supportCandidate?.confidence, 0.94);
  assert.equal(result.accepted[0]?.acceptancePolicyVersion, "citation-support-acceptance-v1");
});

test("independent exact-text selectors deterministically resolve ranges without trusting model arithmetic", async () => {
  const value = input();
  const claimText = "Node 24 is the current LTS release.";
  const evidenceText = "Node 24 as the current LTS release";
  const result = await new CitationAttributionModule(model({ attributions: [{
    sourceOrdinal: 1,
    claimStartOffset: 0,
    claimEndOffset: 5,
    claimText,
    evidenceStartOffset: 0,
    evidenceEndOffset: 5,
    evidenceText,
    support: true,
    confidence: 0.94,
  }] }), now).attribute(value);

  assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.accepted[0]?.claimRange, { startOffset: 0, endOffset: claimText.length, exact: claimText });
  assert.equal(result.accepted[0]?.evidenceRange?.exact, evidenceText);
});

test("ambiguous exact-text selectors are rejected instead of guessing a range", async () => {
  const value = input({ body: "Node 24 appears here. Node 24 appears again." });
  const result = await new CitationAttributionModule(model({ attributions: [{
    sourceOrdinal: 1,
    claimText: "Node 24",
    evidenceText: "Node 24 as the current LTS release",
    support: true,
    confidence: 0.94,
  }] }), now).attribute(value);

  assert.equal(result.accepted.length, 0);
  assert.deepEqual(result.run.attributions[0]?.rejectionReasons, ["claim_text_ambiguous"]);
});

test("provider-native metadata remains a candidate and low-confidence semantic support cannot auto-promote it", async () => {
  const value = input({ providerCandidates: [{ sourceOrdinal: 1, startOffset: 0, endOffset: 7, providerCitationId: "native-1" }] });
  const evidenceText = "Node 24";
  const result = await new CitationAttributionModule(model({ attributions: [{
    nativeCandidateId: "provider:1",
    sourceOrdinal: 1,
    claimText: "Node 24",
    evidenceText,
    support: true,
    confidence: 0.55,
  }] }), now).attribute(value);

  assert.equal(result.accepted.length, 0);
  assert.equal(result.run.attributions[0]?.candidateProducer.kind, "provider_native");
  assert.equal(result.run.attributions[0]?.status, "rejected");
  assert.deepEqual(result.run.attributions[0]?.rejectionReasons, ["confidence_below_threshold"]);
});

test("a coarse native claim is rejected while the independent no-annotation path can still discover an exact attribution", async () => {
  const value = input({ providerCandidates: [{ sourceOrdinal: 1, providerCitationId: "coarse" }] });
  const evidenceText = "Node 24 as the current LTS release";
  const result = await new CitationAttributionModule(model({ attributions: [{
    sourceOrdinal: 1,
    claimStartOffset: 0,
    claimEndOffset: value.body.length,
    claimText: value.body,
    evidenceStartOffset: value.sources[0]!.content.indexOf(evidenceText),
    evidenceEndOffset: value.sources[0]!.content.indexOf(evidenceText) + evidenceText.length,
    evidenceText,
    support: true,
    confidence: 0.9,
  }] }), now).attribute(value);

  assert.equal(result.run.attributions.length, 2);
  assert.deepEqual(result.run.attributions[0]?.rejectionReasons, ["claim_range_missing"]);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0]?.candidateProducer.kind, "independent_model");
});

test("unadmitted evidence is rejected before producer execution", async () => {
  let calls = 0;
  const adapter: CitationAttributionModelAdapter = {
    async produce() { calls += 1; throw new Error("must not run"); },
  };
  const value = input({
    sources: [{ ...input().sources[0]!, admitted: false }],
    providerCandidates: [{ sourceOrdinal: 1, startOffset: 0, endOffset: 7 }],
  });
  const result = await new CitationAttributionModule(adapter, now).attribute(value);

  assert.equal(calls, 0);
  assert.equal(result.run.status, "completed");
  assert.deepEqual(result.run.attributions[0]?.rejectionReasons, ["source_not_admitted"]);
});

test("a provider-native candidate with an unknown source ordinal is rejected and recorded", async () => {
  const result = await new CitationAttributionModule(model({ attributions: [] }), now).attribute(input({
    providerCandidates: [{ sourceOrdinal: 9, startOffset: 0, endOffset: 7, providerCitationId: "wrong-source" }],
  }));

  assert.equal(result.accepted.length, 0);
  assert.equal(result.run.attributions[0]?.evidenceIdentity.sourceId, undefined);
  assert.deepEqual(result.run.attributions[0]?.rejectionReasons, ["source_not_found"]);
});

test("producer failure rejects pending native candidates without blocking the attribution result", async () => {
  const value = input({ providerCandidates: [{ sourceOrdinal: 1, startOffset: 0, endOffset: 7 }] });
  const result = await new CitationAttributionModule({ async produce() { throw new Error("transient"); } }, now).attribute(value);

  assert.equal(result.run.status, "failed");
  assert.equal(result.accepted.length, 0);
  assert.deepEqual(result.run.attributions[0]?.rejectionReasons, ["producer_failed"]);
  assert.equal(result.run.producerCalls[0]?.errorCode, "producer_failed");
});

test("long final bodies use deterministic overlapping batches", async () => {
  const calls: Array<{ batchId: string; startOffset: number; endOffset: number }> = [];
  const value = input({ body: "甲".repeat(16_000), providerCandidates: [] });
  const result = await new CitationAttributionModule({
    async produce(batch) {
      calls.push({ batchId: batch.batchId, startOffset: batch.body.startOffset, endOffset: batch.body.endOffset });
      return { output: '{"attributions":[]}', provider: "deepseek", model: "deepseek-v4-flash" };
    },
  }, now).attribute(value);

  assert.deepEqual(calls, [
    { batchId: "body-1", startOffset: 0, endOffset: 8_000 },
    { batchId: "body-2", startOffset: 7_500, endOffset: 15_500 },
    { batchId: "body-3", startOffset: 15_000, endOffset: 16_000 },
  ]);
  assert.equal(result.run.status, "completed");
  assert.equal(result.accepted.length, 0);
});
