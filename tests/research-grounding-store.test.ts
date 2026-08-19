import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CaptureService, ResearchSessionService, SqliteStore, citedGroundingSources, type ResearchGenerationProvider } from "@collector/api";

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "collector-grounding-store-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  return { root, store, close: async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}

test("引用来源过滤同时匹配 runId 与 sourceId", () => {
  const createdAt = "2026-01-01T00:00:00.000Z";
  const sources = [
    { id: "shared", runId: "run-a", ordinal: 2, title: "A", createdAt },
    { id: "shared", runId: "run-b", ordinal: 5, title: "B", createdAt },
  ];
  const citations = [{ id: "citation", messageId: "message", runId: "run-b", sourceId: "shared", blockOrdinal: 0, markerOffset: 0, createdAt }];

  assert.deepEqual(citedGroundingSources(sources, citations).map((source) => [source.runId, source.ordinal]), [["run-b", 5]]);
});

test("grounded research persists all sources but views only expose cited original ordinals", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const provider: ResearchGenerationProvider = {
    provider: "grounding-fake", model: "grounding-model", promptVersion: "grounding-test-v1",
    async *generate() { yield "ordinary fallback"; },
    async generateAgentGrounded() {
      const content = "[[concept:web-grounding:联网回答]]内容与补充证据。";
      const firstCitation = content.indexOf("内容");
      const secondCitation = content.indexOf("证据");
      return {
        content, status: "grounded", queries: ["collector web search"],
        sources: [
          {
            title: "Uncited search result",
            url: "https://example.com/search-result",
            snippet: "搜索到但没有写入正文依据",
          },
          {
            title: "Source api-key=secret-value",
            url: "https://example.com/source?token=hidden",
            snippet: "摘要 authorization=Bearer-secret",
            locator: "页码 2 cookie=session-secret",
          },
          { title: "No evidence", url: "https://example.com/none", evidenceStatus: "none" },
          { title: "Another uncited result", url: "https://example.com/uncited" },
          { title: "Second cited source", url: "https://example.com/second-cited" },
        ],
        citations: [
          { sourceOrdinal: 2, startOffset: firstCitation, endOffset: firstCitation + 2 },
          { sourceOrdinal: 5, startOffset: secondCitation, endOffset: secondCitation + 2 },
        ],
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
  assert.deepEqual(task.groundingScope && { status: task.groundingScope.status, sourceCount: task.groundingScope.sourceCount, citationCount: task.groundingScope.citationCount }, { status: "grounded", sourceCount: 5, citationCount: 2 });
  const run = harness.store.listResearchGroundingRuns(turn.task.id)[0];
  assert.equal(run.queries[0], "collector web search");
  assert.equal(run.responseSummary?.authorization, "[REDACTED]");
  assert.equal(run.errorMessage, "token=[REDACTED]");
  const storedSources = harness.store.listResearchGroundingSources(run.id);
  assert.equal(storedSources.length, 5);
  const source = storedSources[1];
  const secondSource = storedSources[4];
  assert.equal(source.url, "https://example.com/source");
  assert.equal(source.title, "Source api-key=[REDACTED]");
  assert.equal(source.snippet, "摘要 authorization=[REDACTED]");
  assert.equal(source.locator, "页码 2 cookie=[REDACTED]");
  const output = harness.store.getResearchMessage(turn.task.outputMessageId);
  assert.ok(output);
  assert.equal(output.content, "联网回答内容与补充证据。");
  assert.deepEqual(output.termMarkers?.map((marker) => marker.text), ["联网回答"]);
  const citations = harness.store.listResearchCitationsForMessages([output.id]);
  assert.equal(citations.length, 2);
  assert.equal(citations[0]?.markerOffset, output.content.indexOf("内容"));
  const view = service.getSession(session.id);
  assert.deepEqual(view.groundingSources?.map((item) => ({ id: item.id, ordinal: item.ordinal })), [
    { id: source.id, ordinal: 2 },
    { id: secondSource.id, ordinal: 5 },
  ]);
  assert.equal(view.citations?.[0]?.sourceId, source.id);
  const nodeView = new CaptureService(harness.store, join(harness.root, "artifacts"), undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
    autoRunResearchImports: false,
    autoRunResearchChapters: false,
    autoRunSelectionTasks: false,
  }).nodeGrowth.getNodeView(session.id);
  assert.deepEqual(nodeView.groundingSources?.map((item) => ({ id: item.id, ordinal: item.ordinal })), [
    { id: source.id, ordinal: 2 },
    { id: secondSource.id, ordinal: 5 },
  ]);
});

test("联网引用端点落在隐藏控制字段内时不伪造精确位置", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const content = "结论来自 [[concept:hidden-id:本地优先]]。";
  const hiddenStart = content.indexOf("hidden-id");
  const provider: ResearchGenerationProvider = {
    provider: "grounding-fake", model: "grounding-model",
    async *generate() { yield "ordinary fallback"; },
    async generateAgentGrounded() {
      return {
        content, status: "grounded", queries: [],
        sources: [{ title: "Source", url: "https://example.com/source" }],
        citations: [{ sourceOrdinal: 1, startOffset: hiddenStart, endOffset: hiddenStart + 4 }],
      };
    },
  };
  const service = new ResearchSessionService(harness.store, { provider, autoRunTasks: false });
  const session = await service.createSession("测试", "invalid-range-session");
  const turn = await service.submitMessage(session.id, "解释", "invalid-range-turn", { allowWebSearch: true });
  await service.processTask(turn.task.id);

  const output = harness.store.getResearchMessage(turn.task.outputMessageId);
  assert.equal(output?.content, "结论来自 本地优先。");
  assert.equal(harness.store.listResearchCitationsForMessages([turn.task.outputMessageId]).length, 0);
  assert.equal(service.getTask(turn.task.id).groundingScope?.citationCount, 0);
  assert.equal(harness.store.listResearchGroundingSources(service.getTask(turn.task.id).groundingScope!.runId!).length, 1);
  assert.equal(service.getSession(session.id).groundingSources, undefined);
});

test("文本型来源标记在弱标记清洗后的正文上解析", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const provider: ResearchGenerationProvider = {
    provider: "agent-fake", model: "agent-model",
    async *generate() { yield "ordinary fallback"; },
    async generateAgentGrounded() {
      return {
        content: "[[concept:local-first:本地优先]]强调数据留在设备上。[来源1]",
        status: "grounded", queries: ["本地优先"],
        sources: [{ title: "Source", url: "https://example.com/source", evidenceStatus: "full" }],
        citations: [],
      };
    },
  };
  const service = new ResearchSessionService(harness.store, { provider, autoRunTasks: false });
  const session = await service.createSession("测试", "agent-citation-session");
  const turn = await service.submitMessage(session.id, "解释", "agent-citation-turn", { allowWebSearch: true });
  await service.processTask(turn.task.id);

  const output = harness.store.getResearchMessage(turn.task.outputMessageId);
  assert.equal(output?.content, "本地优先强调数据留在设备上。[来源1]");
  const citation = harness.store.listResearchCitationsForMessages([turn.task.outputMessageId])[0];
  assert.ok(citation);
  assert.equal(citation.markerOffset, "本地优先强调数据留在设备上。".length);
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
