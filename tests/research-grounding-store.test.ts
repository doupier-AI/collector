import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResearchSessionService, SqliteStore, type ResearchGenerationProvider } from "@collector/api";

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "collector-grounding-store-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  return { store, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("grounded research persists a v21 run, sources, citations, and task scope", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const provider: ResearchGenerationProvider = {
    provider: "grounding-fake", model: "grounding-model", promptVersion: "grounding-test-v1",
    async *generate() { yield "ordinary fallback"; },
    async generateAgentGrounded() {
      return {
        content: "联网回答内容。", status: "grounded", queries: ["collector web search"],
        sources: [{
          title: "Source api-key=secret-value",
          url: "https://example.com/source?token=hidden",
          snippet: "摘要 authorization=Bearer-secret",
          locator: "页码 2 cookie=session-secret",
        }],
        citations: [{ sourceOrdinal: 1, startOffset: 2, endOffset: 4 }],
        responseSummary: { result: "ok", authorization: "Bearer secret" },
        errorMessage: "token=error-secret",
      };
    },
  };
  const service = new ResearchSessionService(harness.store, { provider, autoRunTasks: false });
  const session = await service.createSession("测试", "session-key");
  const turn = await service.submitMessage(session.id, "解释联网研究", "turn-key");
  await service.processTask(turn.task.id);
  const task = service.getTask(turn.task.id);
  assert.deepEqual(task.groundingScope && { status: task.groundingScope.status, sourceCount: task.groundingScope.sourceCount, citationCount: task.groundingScope.citationCount }, { status: "grounded", sourceCount: 1, citationCount: 1 });
  const run = harness.store.listResearchGroundingRuns(turn.task.id)[0];
  assert.equal(run.queries[0], "collector web search");
  assert.equal(run.responseSummary?.authorization, "[REDACTED]");
  assert.equal(run.errorMessage, "token=[REDACTED]");
  const source = harness.store.listResearchGroundingSources(run.id)[0];
  assert.equal(source.url, "https://example.com/source");
  assert.equal(source.title, "Source api-key=[REDACTED]");
  assert.equal(source.snippet, "摘要 authorization=[REDACTED]");
  assert.equal(source.locator, "页码 2 cookie=[REDACTED]");
  const output = harness.store.getResearchMessage(turn.task.outputMessageId);
  assert.ok(output);
  assert.equal(harness.store.listResearchCitationsForMessages([output.id]).length, 1);
});
