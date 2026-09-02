import assert from "node:assert/strict";
import test from "node:test";

import { validateEvidenceBundle, type AnswerPlan } from "@collector/capture-contracts";
import {
  EvidencePreparationModule,
  evidenceBundleContextCandidates,
  normalizeEvidenceUrl,
  type EvidencePreparationAdapter,
  type EvidenceSearchCandidate,
} from "../apps/api/dist/evidence-preparation.js";

function plan(overrides: Partial<AnswerPlan> = {}): AnswerPlan {
  return {
    schemaVersion: 2,
    planId: "plan-206",
    plannerVersion: "answer-planner-v1",
    buildFingerprint: "build:test",
    taskId: "task-206",
    generationAttempt: 1,
    inputMessageId: "input-206",
    outputMessageId: "output-206",
    conversationContextId: "context-206",
    planning: { mode: "deterministic", modelCall: "not_needed", reason: "simple_clear_task" },
    taskFamily: "factual_query",
    userGoal: "Verify the current Node release",
    audience: { description: "unspecified", source: "unspecified" },
    explicitConstraints: [],
    requiredOperations: ["verify_facts"],
    assumptions: [],
    evidencePolicy: {
      mode: "web_if_authorized",
      requiresCurrentFacts: true,
      access: "authorized",
      conflictHandling: "preserve_for_evidence_chain",
    },
    uncertaintyHandling: { action: "proceed", reasons: [] },
    presentation: { mode: "compact", preferredBlocks: [] },
    completionContract: { machineChecks: [], semanticCriteria: [] },
    ...overrides,
  };
}

const budget = { maxQueries: 2, maxCandidates: 8, maxFetches: 8, maxPackedTokens: 2_000 };
const fixedClock = () => new Date("2026-09-01T00:00:00.000Z");

function adapterFor(results: readonly EvidenceSearchCandidate[], content: Record<string, string> = {}): EvidencePreparationAdapter {
  return {
    async search(query) { return { query, results }; },
    async fetch(url) { return { url, content: content[url] ?? "" }; },
  };
}

test("Evidence Preparation normalizes redirects, default ports, fragments, and safe tracking parameters", () => {
  assert.equal(
    normalizeEvidenceUrl("https://Search.Example:443/redirect?url=https%3A%2F%2FEXAMPLE.com%3A443%2Fdocs%2F%3Futm_source%3Dx%26b%3D2%26a%3D1#top"),
    "https://example.com/docs?a=1&b=2",
  );
  assert.equal(normalizeEvidenceUrl("https://user:pass@example.com/a?token=secret&keep=yes#fragment"), "https://example.com/a?keep=yes");
  const bingTarget = Buffer.from("https://nodejs.org/en/about/previous-releases?utm_source=bing", "utf8").toString("base64url");
  assert.equal(normalizeEvidenceUrl(`https://www.bing.com/ck/a?u=a1${bingTarget}&ntb=1`), "https://nodejs.org/en/about/previous-releases");
  assert.equal(normalizeEvidenceUrl("file:///etc/passwd"), undefined);
});

test("a no-evidence plan does not search and records not_required without a grounded field", async () => {
  let calls = 0;
  const module = new EvidencePreparationModule({
    async search(query) { calls += 1; return { query, results: [] }; },
    async fetch(url) { calls += 1; return { url, content: "" }; },
  }, fixedClock);
  const result = await module.prepare({
    currentQuestion: "Rewrite this sentence",
    answerPlan: plan({
      taskFamily: "rewriting",
      evidencePolicy: { mode: "none", requiresCurrentFacts: false, access: "not_required", conflictHandling: "preserve_for_evidence_chain" },
    }),
    webAuthorization: "authorized",
    budget,
  });
  assert.equal(calls, 0);
  assert.equal(result.bundle.evidencePolicyStatus, "policy_satisfied");
  assert.equal(result.bundle.stopReason, "not_required");
  assert.equal(Object.hasOwn(result.bundle, "grounded"), false);
  assert.doesNotMatch(JSON.stringify(result.bundle), /"grounded"/);
  assert.throws(() => validateEvidenceBundle({ ...result.bundle, grounded: true } as typeof result.bundle), /must not own grounded/);
});

test("not-authorized evidence stays not_satisfied and does not call an external adapter", async () => {
  let calls = 0;
  const module = new EvidencePreparationModule({
    async search(query) { calls += 1; return { query, results: [] }; },
    async fetch(url) { calls += 1; return { url, content: "" }; },
  }, fixedClock);
  const result = await module.prepare({ currentQuestion: "latest Node release", answerPlan: plan(), webAuthorization: "not_authorized", budget });
  assert.equal(calls, 0);
  assert.equal(result.bundle.evidencePolicyStatus, "not_satisfied");
  assert.equal(result.bundle.stopReason, "not_required");
  assert.equal(result.bundle.needs[0]?.searched, false);
});

test("canonical URL, final redirect, and content digest dedupe are invariant to source order", async () => {
  const first = "https://example.com/node?utm_source=mail";
  const duplicateUrl = "https://EXAMPLE.com:443/node#fragment";
  const duplicateContent = "https://mirror.example/node";
  const independent = "https://docs.example/releases";
  const results = [
    { sourceId: "search-a", title: "Current Node release", url: first, snippet: "Node release" },
    { sourceId: "search-b", title: "Duplicate URL", url: duplicateUrl, snippet: "Node release" },
    { sourceId: "search-c", title: "Mirror", url: duplicateContent, snippet: "Node release" },
    { sourceId: "search-d", title: "Release documentation", url: independent, snippet: "Current Node release" },
  ];
  const pages: Record<string, string> = {
    "https://example.com/node": "The current Node release is documented here with complete release details.",
    "https://mirror.example/node": "The current Node release is documented here with complete release details.",
    "https://docs.example/releases": "Node release documentation lists the current supported release and publication date.",
  };
  const run = (ordered: readonly EvidenceSearchCandidate[]) => new EvidencePreparationModule(adapterFor(ordered, pages), fixedClock).prepare({
    currentQuestion: "Verify the current Node release",
    answerPlan: plan(),
    webAuthorization: "authorized",
    budget,
  });
  const forward = await run(results);
  const reverse = await run([...results].reverse());
  assert.equal(forward.bundle.evidencePolicyStatus, "policy_satisfied");
  assert.deepEqual(forward.bundle, reverse.bundle);
  assert.equal(forward.bundle.evidence.length, 2);
  assert.deepEqual(forward.bundle.packedEvidenceIds, forward.bundle.evidence.map((item) => item.id));
  assert.ok(forward.trace.some((entry) => entry.fallbackReason === "duplicate_canonical_url"));
  assert.ok(forward.trace.some((entry) => entry.fallbackReason === "duplicate_content"));
});

test("snippet-only evidence is partial and never masquerades as full policy coverage", async () => {
  const url = "https://example.com/node";
  const module = new EvidencePreparationModule({
    async search(query) { return { query, results: [{ title: "Current Node release", url, snippet: "Current Node release summary" }] }; },
    async fetch() { return { url, content: "", errorMessage: "blocked" }; },
  }, fixedClock);
  const result = await module.prepare({ currentQuestion: "Verify the current Node release", answerPlan: plan(), webAuthorization: "authorized", budget });
  assert.equal(result.bundle.evidencePolicyStatus, "partially_satisfied");
  assert.equal(result.bundle.stopReason, "no_more_candidates");
  assert.equal(result.bundle.evidence[0]?.availability, "partial");
});

test("full content with unknown freshness and authority does not satisfy a current-facts policy", async () => {
  const url = "https://example.com/node-release";
  const result = await new EvidencePreparationModule(adapterFor(
    [{ title: "Current Node release", url, snippet: "Current Node release" }],
    { [url]: "The current Node release is described in this complete but undated secondary page." },
  ), fixedClock).prepare({ currentQuestion: "Verify the current Node release", answerPlan: plan(), webAuthorization: "authorized", budget });
  assert.equal(result.bundle.evidence[0]?.availability, "full");
  assert.equal(result.bundle.evidence[0]?.freshness, "unknown");
  assert.equal(result.bundle.evidence[0]?.authorityClass, "unknown");
  assert.equal(result.bundle.evidencePolicyStatus, "partially_satisfied");
});

test("same-name wrong-domain and low-information results are rejected before packing", async () => {
  const ambiguousUrl = "https://biology.example/node";
  const lowInformationUrl = "https://example.com/node";
  const module = new EvidencePreparationModule({
    async search(query) {
      return {
        query,
        results: [
          { sourceId: "ambiguous", title: "Node release", url: ambiguousUrl, snippet: "A biological node in a plant stem is described here." },
          { sourceId: "low-info", title: "Node", url: lowInformationUrl, snippet: "Node release" },
        ],
      };
    },
    async fetch(url) { return { url, content: url === ambiguousUrl ? "This page concerns a biological plant node, not a software runtime release." : "" }; },
    async assess({ candidate }) {
      return {
        relevance: candidate.finalUrl === ambiguousUrl ? "irrelevant" : "uncertain",
        producer: "bounded-domain-assessor",
        version: "v1",
      };
    },
  }, fixedClock);
  const result = await module.prepare({ currentQuestion: "Verify the current Node release", answerPlan: plan(), webAuthorization: "authorized", budget });
  assert.equal(result.bundle.evidencePolicyStatus, "not_satisfied");
  assert.deepEqual(result.bundle.evidence, []);
  assert.ok(result.trace.some((entry) => entry.fallbackReason === "not_relevant"));
  assert.ok(result.trace.some((entry) => entry.fallbackReason === "low_information"));
});

test("no results and provider failure remain distinct stopping states", async () => {
  const noResults = await new EvidencePreparationModule({
    async search(query) { return { query, results: [] }; },
    async fetch(url) { return { url, content: "" }; },
  }, fixedClock).prepare({ currentQuestion: "Verify the current Node release", answerPlan: plan(), webAuthorization: "authorized", budget });
  const failed = await new EvidencePreparationModule({
    async search(query) { return { query, results: [], errorMessage: "provider unavailable" }; },
    async fetch(url) { return { url, content: "" }; },
  }, fixedClock).prepare({ currentQuestion: "Verify the current Node release", answerPlan: plan(), webAuthorization: "authorized", budget });
  assert.equal(noResults.bundle.stopReason, "no_more_candidates");
  assert.equal(failed.bundle.stopReason, "provider_failed");
  assert.equal(noResults.bundle.evidencePolicyStatus, "not_satisfied");
  assert.equal(failed.bundle.evidencePolicyStatus, "not_satisfied");
});

test("resource limits produce an explicit budget_exhausted result", async () => {
  const result = await new EvidencePreparationModule(adapterFor([
    { title: "Current Node release", url: "https://example.com/node", snippet: "Current Node release summary with enough bounded information" },
  ]), fixedClock).prepare({
    currentQuestion: "Verify the current Node release",
    answerPlan: plan(),
    webAuthorization: "authorized",
    budget: { ...budget, maxFetches: 0 },
  });
  assert.equal(result.bundle.evidencePolicyStatus, "partially_satisfied");
  assert.equal(result.bundle.stopReason, "budget_exhausted");
  assert.equal(result.bundle.budget.usedFetches, 0);
});

test("opposing bounded assessment proposals produce conflicting policy status, not truth", async () => {
  const results = [
    { title: "Node release A", url: "https://a.example/node", snippet: "Current Node release A" },
    { title: "Node release B", url: "https://b.example/node", snippet: "Current Node release B" },
  ];
  const module = new EvidencePreparationModule({
    ...adapterFor(results, {
      "https://a.example/node": "Current Node release A is the supported version according to this source.",
      "https://b.example/node": "Current Node release B is the supported version according to this source.",
    }),
    async assess({ candidate, needIds }) {
      return {
        relevance: "relevant",
        coveredNeedIds: needIds,
        conflictKey: "node-current-release",
        conflictStance: candidate.finalUrl.includes("a.example") ? "A" : "B",
        producer: "fixed-assessment-provider",
        version: "v1",
      };
    },
  }, fixedClock);
  const result = await module.prepare({ currentQuestion: "Verify the current Node release", answerPlan: plan(), webAuthorization: "authorized", budget });
  assert.equal(result.bundle.evidencePolicyStatus, "conflicting");
  assert.equal(result.bundle.needs[0]?.policyStatus, "conflicting");
  assert.ok(result.bundle.evidence.every((item) => item.decisions.conflict.proposalProducer === "fixed-assessment-provider"));
});

test("packed source identities become required ContextAssembly candidates alongside a separate ledger", async () => {
  const url = "https://docs.example/node";
  const result = await new EvidencePreparationModule(adapterFor(
    [{ title: "Current Node release", url, snippet: "Node release" }],
    { [url]: "The current Node release documentation contains complete release information." },
  ), fixedClock).prepare({ currentQuestion: "Verify the current Node release", answerPlan: plan(), webAuthorization: "authorized", budget });
  const candidates = evidenceBundleContextCandidates(result.bundle);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0]?.source.kind, "tool_result");
  assert.equal(candidates[1]?.source.id, result.bundle.evidence[0]?.id);
  assert.ok(candidates.every((candidate) => candidate.permission.status === "required" && candidate.protection === "required"));
  assert.ok(candidates.every((candidate) => candidate.permission.allowedPurposes?.includes("research_body")));
});
