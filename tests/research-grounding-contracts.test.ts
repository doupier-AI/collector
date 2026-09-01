import assert from "node:assert/strict";
import test from "node:test";
import {
  hashBodyContent,
  redactGroundingValue,
  sanitizeGroundingQueries,
  sanitizeGroundingUrl,
  validateResearchGroundingResult,
  type ResearchGroundingResult,
} from "@collector/capture-contracts";

test("sanitizeGroundingUrl strips credentials and sensitive query parameters", () => {
  assert.equal(
    sanitizeGroundingUrl("https://user:pass@example.com/report?token=secret&keep=value&api_key=hidden"),
    "https://example.com/report?keep=value",
  );
  assert.equal(sanitizeGroundingUrl("file:///private/report"), undefined);
  assert.equal(sanitizeGroundingUrl("not a url"), undefined);
});

test("grounding trace values redact secrets and bound untrusted strings", () => {
  const value = redactGroundingValue({ authorization: "Bearer top-secret", message: "token=abc sk-short-key" }) as Record<string, unknown>;
  assert.equal(value.authorization, "[REDACTED]");
  assert.match(String(value.message), /\[REDACTED\]/);
  assert.deepEqual(sanitizeGroundingQueries([" query ", "query", "", "next"]), ["query", "next"]);
});

test("grounding citations must reference a source in the same run and a valid message position", () => {
  const result: ResearchGroundingResult = {
    content: "第一段内容。\n\n第二段内容。",
    scope: { status: "grounded", sourceCount: 1, citationCount: 1, runId: "run-1" },
    run: {
      id: "run-1", taskId: "task-1", sessionId: "session-1", provider: "openai", model: "gpt-test",
      capability: "openai_web_search", scenario: "chat", status: "grounded", queries: [], attempt: 1, createdAt: "2026-07-22T00:00:00.000Z",
    },
    sources: [{ id: "source-1", runId: "run-1", ordinal: 1, title: "Source", createdAt: "2026-07-22T00:00:00.000Z" }],
    citations: [{
      id: "citation-1", messageId: "message-1", runId: "run-1", sourceId: "source-1", blockOrdinal: 0, markerOffset: 2,
      location: {
        contentId: "message-1",
        bodyVersionId: `body:message-1:${hashBodyContent("第一段内容。\n\n第二段内容。")}`,
        sourceRange: { startOffset: 0, endOffset: 3 },
        exact: "第一段",
      },
      createdAt: "2026-07-22T00:00:00.000Z",
    }],
  };
  assert.doesNotThrow(() => validateResearchGroundingResult(result));
  assert.throws(() => validateResearchGroundingResult({ ...result, citations: [{ ...result.citations[0], sourceId: "other" }] }), /same grounding run/);
  assert.throws(() => validateResearchGroundingResult({ ...result, citations: [{ ...result.citations[0], markerOffset: 99 }] }), /positioned/);
  assert.throws(() => validateResearchGroundingResult({
    ...result,
    citations: [{ ...result.citations[0], location: { ...result.citations[0].location!, bodyVersionId: "body:message-1:stale" } }],
  }), /version-mismatch/);
});

test("accepted attribution exclusively owns citation source, range, and grounded derivation", () => {
  const content = "Node 24 is the current LTS release.";
  const messageId = "message-207";
  const bodyVersionId = `body:${messageId}:${hashBodyContent(content)}`;
  const createdAt = "2026-09-01T00:00:00.000Z";
  const attribution = {
    id: "attribution-1",
    candidateId: "model:body-1:1",
    taskId: "task-207",
    messageId,
    runId: "run-207",
    bodyVersionId,
    generationAttempt: 1,
    candidateProducer: { kind: "independent_model" as const, provider: "deepseek", model: "deepseek-v4-flash", version: "citation-attribution-producer-v1" },
    evidenceIdentity: { sourceId: "source-1", sourceOrdinal: 1, preparedEvidenceId: "evidence-1", sourceVersion: "digest-1" },
    claimRange: { startOffset: 0, endOffset: content.length, exact: content },
    evidenceRange: { startOffset: 0, endOffset: 14, exact: "Node 24 is LTS" },
    supportCandidate: {
      support: true,
      confidence: 0.93,
      producer: { kind: "independent_model" as const, provider: "deepseek", model: "deepseek-v4-flash", version: "citation-attribution-producer-v1" },
    },
    acceptancePolicyVersion: "citation-support-acceptance-v1" as const,
    status: "accepted" as const,
    rejectionReasons: [],
    createdAt,
  };
  const result: ResearchGroundingResult = {
    content,
    scope: { status: "grounded", sourceCount: 1, citationCount: 1, runId: "run-207" },
    run: {
      id: "run-207", taskId: "task-207", sessionId: "session-207", provider: "deepseek", model: "deepseek-v4-flash",
      capability: "unsupported", scenario: "chat", status: "no_verifiable_sources", queries: [], attempt: 1, createdAt,
      citationAttribution: {
        schemaVersion: "citation-attribution-run-v1", id: "attribution-run-1", taskId: "task-207", messageId,
        groundingRunId: "run-207", bodyVersionId, generationAttempt: 1, status: "completed",
        acceptancePolicyVersion: "citation-support-acceptance-v1", producerCalls: [{
          batchId: "body-1", mode: "discover", provider: "deepseek", model: "deepseek-v4-flash",
          producerVersion: "citation-attribution-producer-v1", status: "completed",
        }], invalidProposalCount: 0, attributions: [attribution], createdAt, completedAt: createdAt,
      },
    },
    sources: [
      { id: "source-1", runId: "run-207", ordinal: 1, title: "Source 1", evidenceStatus: "full", createdAt },
      { id: "source-2", runId: "run-207", ordinal: 2, title: "Source 2", evidenceStatus: "full", createdAt },
    ],
    citations: [{
      id: "citation-207", messageId, runId: "run-207", sourceId: "source-1", blockOrdinal: 0, markerOffset: 0,
      location: { contentId: messageId, bodyVersionId, sourceRange: { startOffset: 0, endOffset: content.length }, exact: content },
      attributionId: "attribution-1", acceptancePolicyVersion: "citation-support-acceptance-v1", createdAt,
    }],
  };

  assert.doesNotThrow(() => validateResearchGroundingResult(result));
  assert.throws(() => validateResearchGroundingResult({
    ...result,
    citations: [{ ...result.citations[0]!, sourceId: "source-2" }],
  }), /preserve its accepted attribution source/);
  assert.throws(() => validateResearchGroundingResult({
    ...result,
    run: { ...result.run, citationAttribution: { ...result.run.citationAttribution!, attributions: [{ ...attribution, supportCandidate: { ...attribution.supportCandidate, confidence: 0.5 } }] } },
  }), /incomplete/);
});
