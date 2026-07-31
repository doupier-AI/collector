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
  const turn = await service.submitMessage(session.id, "解释联网研究", "turn-key", { allowWebSearch: true });
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

test("关闭联网开关时跳过 Agent 搜索并把任务标记为未请求联网", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  let groundedCalls = 0;
  let normalCalls = 0;
  const provider: ResearchGenerationProvider = {
    provider: "toggle-fake", model: "toggle-model", promptVersion: "toggle-test-v1",
    async *generate() {
      normalCalls += 1;
      yield "仅基于本地材料的回答";
    },
    async generateAgentGrounded() {
      groundedCalls += 1;
      throw new Error("联网搜索不应被调用");
    },
  };
  const service = new ResearchSessionService(harness.store, { provider, autoRunTasks: false });
  const session = await service.createSession("测试", "session-off-key");
  const turn = await service.submitMessage(session.id, "只看当前材料", "turn-off-key");

  assert.equal(turn.task.allowWebSearch, false);
  assert.deepEqual(turn.task.groundingScope, { status: "not_requested", sourceCount: 0, citationCount: 0 });
  await service.processTask(turn.task.id);

  const task = service.getTask(turn.task.id);
  assert.equal(task.status, "completed");
  assert.equal(task.groundingScope?.status, "not_requested");
  assert.equal(groundedCalls, 0);
  assert.equal(normalCalls, 1);
  assert.equal(harness.store.listResearchGroundingRuns(turn.task.id).length, 0);
});

test("用户开启联网但供应商没有联网实现时诚实标记为不支持", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const provider: ResearchGenerationProvider = {
    provider: "unsupported-fake", model: "unsupported-model",
    async *generate() { yield "本地回答"; },
  };
  const service = new ResearchSessionService(harness.store, { provider, autoRunTasks: false });
  const session = await service.createSession("测试", "session-unsupported-key");
  const turn = await service.submitMessage(session.id, "允许联网但当前模型不支持", "turn-unsupported-key", { allowWebSearch: true });
  await service.processTask(turn.task.id);

  const task = service.getTask(turn.task.id);
  assert.equal(task.status, "completed");
  assert.equal(task.groundingScope?.status, "grounding_unsupported");
  assert.equal(harness.store.listResearchGroundingRuns(turn.task.id).length, 1);
});
