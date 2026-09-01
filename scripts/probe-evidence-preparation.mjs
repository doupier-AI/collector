/**
 * #206 real-network probe. It uses the configured production search registry and the same
 * SSRF-safe fetch path as runtime Evidence Preparation. Run after build:
 * node scripts/probe-evidence-preparation.mjs [query]
 */
import assert from "node:assert/strict";

import { EvidencePreparationModule } from "@collector/api";
import { createSearchRunContext, getSearchConfig, initSearchBackends, webFetch, webSearch } from "../apps/api/dist/web-search-agent.js";

const query = process.argv.slice(2).join(" ").trim() || "Node.js latest LTS release official documentation";
const plan = {
  schemaVersion: 1,
  planId: "probe-evidence-plan",
  plannerVersion: "answer-planner-v1",
  buildFingerprint: "probe-build",
  taskId: "probe-evidence-task",
  generationAttempt: 1,
  inputMessageId: "probe-evidence-input",
  outputMessageId: "probe-evidence-output",
  conversationContextId: "probe-evidence-context",
  planning: { mode: "deterministic", modelCall: "not_needed", reason: "simple_clear_task" },
  taskFamily: "factual_query",
  userGoal: query,
  audience: { description: "unspecified", source: "unspecified" },
  explicitConstraints: [],
  requiredOperations: ["verify_facts"],
  assumptions: [],
  evidencePolicy: { mode: "web_if_authorized", requiresCurrentFacts: true, access: "authorized", conflictHandling: "preserve_for_evidence_chain" },
  uncertaintyHandling: { action: "proceed", reasons: [] },
  completionContract: { machineChecks: [], semanticCriteria: [] },
};

initSearchBackends();
const searchContext = createSearchRunContext();
let searchCalls = 0;
let fetchCalls = 0;
const result = await new EvidencePreparationModule({
  async search(searchQuery, maxResults) {
    searchCalls += 1;
    const response = await webSearch(searchQuery, maxResults);
    return { query: response.query, results: response.results, errorMessage: response.errorMessage };
  },
  async fetch(url) {
    fetchCalls += 1;
    const response = await webFetch(url, { context: searchContext });
    return { url: response.url, content: response.content, errorMessage: response.errorMessage };
  },
}).prepare({
  currentQuestion: query,
  answerPlan: plan,
  webAuthorization: "authorized",
  budget: { maxQueries: 2, maxCandidates: 8, maxFetches: 6, maxPackedTokens: 6_000 },
});

assert.ok(searchCalls > 0, "expected a real search call");
assert.ok(fetchCalls > 0, "expected at least one SSRF-safe fetch call");
assert.ok(result.bundle.evidence.length > 0, `expected qualified evidence, got stop=${result.bundle.stopReason}`);
assert.notEqual(result.bundle.stopReason, "provider_failed");
assert.equal(Object.hasOwn(result.bundle, "grounded"), false);

console.log(JSON.stringify({
  verdict: "PASS",
  backend: getSearchConfig().backend,
  evidencePolicyStatus: result.bundle.evidencePolicyStatus,
  stopReason: result.bundle.stopReason,
  searchCalls,
  fetchCalls,
  qualifiedPackedSources: result.bundle.evidence.length,
  fullSources: result.bundle.evidence.filter((item) => item.availability === "full").length,
  partialSources: result.bundle.evidence.filter((item) => item.availability === "partial").length,
  traceEntries: searchContext.toTrace().length + result.trace.length,
}, null, 2));
