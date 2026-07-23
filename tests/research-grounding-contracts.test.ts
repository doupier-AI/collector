import assert from "node:assert/strict";
import test from "node:test";
import {
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
    citations: [{ id: "citation-1", messageId: "message-1", runId: "run-1", sourceId: "source-1", blockOrdinal: 0, markerOffset: 2, createdAt: "2026-07-22T00:00:00.000Z" }],
  };
  assert.doesNotThrow(() => validateResearchGroundingResult(result));
  assert.throws(() => validateResearchGroundingResult({ ...result, citations: [{ ...result.citations[0], sourceId: "other" }] }), /same grounding run/);
  assert.throws(() => validateResearchGroundingResult({ ...result, citations: [{ ...result.citations[0], markerOffset: 99 }] }), /positioned/);
});
