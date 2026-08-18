import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ModelCallRecord,
  ResearchGroundingResult,
  ResearchMessageRecord,
  ResearchSessionRecord,
  ResearchTaskRecord,
  WorkflowRunRecord,
} from "@collector/capture-contracts";
import { CaptureService, LocalAuth, SqliteStore, createApiServer } from "@collector/api";

const AUTH_TOKEN = "run-record-test-token";

interface Harness {
  root: string;
  store: SqliteStore;
  server: ReturnType<typeof createApiServer>;
  base: string;
  token: string;
  close(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "collector-run-records-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  await auth.registerTrustedToken(AUTH_TOKEN, "run-records-test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
    autoRunResearchImports: false,
    autoRunSelectionTasks: false,
  });
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Run record test server did not bind");
  return {
    root,
    store,
    server,
    base: `http://127.0.0.1:${address.port}`,
    token: AUTH_TOKEN,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function responseJson<T>(harness: Harness, path: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${harness.base}${path}`, { headers: headers(harness.token) });
  return { status: response.status, body: await response.json() as T };
}

async function seedSession(store: SqliteStore): Promise<ResearchSessionRecord> {
  const session: ResearchSessionRecord = {
    id: "session-run-records",
    title: "运行记录测试会话",
    status: "active",
    isFavorite: false,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
  };
  await store.createResearchSession(session, randomUUID());
  return session;
}

async function seedResearchTask(
  store: SqliteStore,
  session: ResearchSessionRecord,
  id: string,
  createdAt: string,
  status: "completed" | "failed" = "completed",
): Promise<ResearchTaskRecord> {
  const input: ResearchMessageRecord = {
    id: `${id}-input`, sessionId: session.id, role: "user", content: "本地运行记录测试输入",
    status: "completed", createdAt, updatedAt: createdAt,
  };
  const output: ResearchMessageRecord = {
    id: `${id}-output`, sessionId: session.id, role: "assistant", content: "本地运行记录测试输出",
    status: "pending", createdAt, updatedAt: createdAt,
  };
  const task: ResearchTaskRecord = {
    id, sessionId: session.id, inputMessageId: input.id, outputMessageId: output.id,
    idempotencyKey: `${id}-idempotency`, status: "queued", retryable: false,
    promptVersion: "run-record-prompt-v1", sliceCount: 2, createdAt, updatedAt: createdAt,
  };
  await store.createResearchTurn(session, input, output, task);
  const claimed = store.claimResearchTask(id, "test-provider", "test-model", "run-record-prompt-v2");
  assert.ok(claimed);
  if (status === "completed") await store.completeResearchTask(id);
  else await store.failResearchTask(claimed, { code: "provider_error", message: "provider failed" });
  return store.getResearchTask(id)!;
}

async function seedModelCall(store: SqliteStore, workflowRunId: string, status: ModelCallRecord["status"] = "completed") {
  const call: ModelCallRecord = {
    id: `${workflowRunId}-model-call`, workflowRunId, provider: "test-provider", model: "test-model",
    purpose: "research", promptVersion: "run-record-prompt-v2", status,
    inputTokens: 120, outputTokens: 80, cacheHitTokens: 4, estimatedCostUsd: 0.002,
    latencyMs: 850, retryCount: status === "failed" ? 1 : 0,
    ...(status === "failed" ? { errorMessage: "authorization: Bearer sk-model-secret" } : {}),
    createdAt: "2026-07-31T00:04:00.000Z", completedAt: "2026-07-31T00:04:01.000Z",
  };
  await store.saveModelCall(call);
}

async function seedSearch(store: SqliteStore, taskId: string, sessionId: string): Promise<void> {
  const result: ResearchGroundingResult = {
    content: "本地搜索测试回答",
    scope: { status: "grounded", sourceCount: 1, citationCount: 0, runId: `${taskId}-search` },
    run: {
      id: `${taskId}-search`, taskId, sessionId, provider: "test-search", model: "search-model",
      capability: "unsupported", scenario: "chat", status: "grounded",
      queries: ["安全查询 api_key=search-secret"],
      responseSummary: { apiKey: "sk-search-secret", safe: "summary" },
      errorMessage: "authorization: Bearer sk-search-secret",
      attempt: 2, createdAt: "2026-07-31T00:04:02.000Z", completedAt: "2026-07-31T00:04:03.000Z",
    },
    sources: [{
      id: `${taskId}-source`, runId: `${taskId}-search`, ordinal: 1, title: "安全来源",
      url: "https://example.com/article?api_key=source-secret&safe=1", snippet: "安全摘要",
      createdAt: "2026-07-31T00:04:03.000Z",
    }],
    citations: [],
  };
  await store.saveResearchGroundingResult(result);
}

async function seedWorkflow(store: SqliteStore): Promise<void> {
  const workflow: WorkflowRunRecord = {
    id: "workflow-failed", workflowType: "recent_organization", idempotencyKey: "workflow-key",
    materialIds: [], materialSetVersion: "materials-v1", status: "failed",
    createdAt: "2026-07-31T00:02:00.000Z", startedAt: "2026-07-31T00:02:01.000Z",
    completedAt: "2026-07-31T00:02:02.000Z", errorMessage: "workflow failed",
  };
  await store.saveWorkflowRun(workflow);
}

test("run record API paginates, filters, restores related traces, and redacts sensitive values", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const session = await seedSession(harness.store);
  const task = await seedResearchTask(harness.store, session, "task-run-records", "2026-07-31T00:03:00.000Z");
  await seedModelCall(harness.store, task.id);
  await seedSearch(harness.store, task.id, session.id);
  await seedWorkflow(harness.store);

  const unauthorized = await fetch(`${harness.base}/v1/run-records`);
  assert.equal(unauthorized.status, 401);

  const first = await responseJson<{ items: Array<{ id: string; operationType: string; modelCallCount: number; searchCount: number }>; nextCursor?: string }>(harness, "/v1/run-records?limit=1");
  assert.equal(first.status, 200);
  assert.equal(first.body.items.length, 1);
  assert.equal(first.body.items[0].id, `research:${task.id}`);
  assert.equal(first.body.items[0].operationType, "research");
  assert.equal(first.body.items[0].modelCallCount, 1);
  assert.equal(first.body.items[0].searchCount, 1);
  assert.ok(first.body.nextCursor);

  const second = await responseJson<{ items: Array<{ id: string }> }>(harness, `/v1/run-records?limit=1&cursor=${encodeURIComponent(first.body.nextCursor!)}`);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.items.map((item) => item.id), ["workflow:workflow-failed"]);

  const filtered = await responseJson<{ items: Array<{ id: string; outcome: string }> }>(harness, "/v1/run-records?operationType=recent_organization&outcome=failure");
  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.body.items.map((item) => item.id), ["workflow:workflow-failed"]);
  assert.equal(filtered.body.items[0].outcome, "failure");

  const detail = await responseJson<{
    task?: { provider?: string; model?: string; promptVersion?: string; sliceCount?: number };
    modelCalls: Array<{ inputTokens: number; outputTokens: number }>;
    searches: Array<{ queries: string[]; responseSummary?: Record<string, unknown>; sources: Array<{ url?: string }> }>;
    errors: Array<{ message: string }>;
  }>(harness, `/v1/run-records/${encodeURIComponent(`research:${task.id}`)}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.task?.provider, "test-provider");
  assert.equal(detail.body.task?.model, "test-model");
  assert.equal(detail.body.task?.promptVersion, "run-record-prompt-v2");
  assert.equal(detail.body.task?.sliceCount, 2);
  assert.equal(detail.body.modelCalls[0].inputTokens, 120);
  assert.equal(detail.body.modelCalls[0].outputTokens, 80);
  assert.equal(detail.body.searches[0].queries[0], "安全查询 api_key=[REDACTED]");
  assert.equal(detail.body.searches[0].sources[0].url, "https://example.com/article?safe=1");
  assert.ok(detail.body.searches[0].responseSummary);
  assert.equal(detail.body.searches[0].responseSummary?.apiKey, "[REDACTED]");
  assert.ok(detail.body.errors.some((error) => error.message.includes("[REDACTED]")));
  const serialized = JSON.stringify(detail.body);
  assert.doesNotMatch(serialized, /sk-model-secret|sk-search-secret|source-secret|Bearer/);

  const unauthorizedExport = await fetch(`${harness.base}/v1/run-records/export`);
  assert.equal(unauthorizedExport.status, 401);

  const exported = await fetch(`${harness.base}/v1/run-records/export?operationType=research`, { headers: headers(harness.token) });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-disposition") ?? "", /collector-run-records-/);
  const exportLines = (await exported.text()).trim().split("\n").map((line) => JSON.parse(line) as { type: string; [key: string]: unknown });
  assert.equal(exportLines[0].type, "header");
  assert.deepEqual((exportLines[0].filters as { operationType?: string }).operationType, "research");
  assert.equal(exportLines[1].type, "record");
  const exportedRecord = exportLines[1].record as { id: string; searches: Array<{ queries: string[]; sources: Array<{ url?: string }> }>; errors: Array<{ message: string }> };
  assert.equal(exportedRecord.id, `research:${task.id}`);
  assert.equal(exportedRecord.searches[0].queries[0], "安全查询 api_key=[REDACTED]");
  assert.equal(exportedRecord.searches[0].sources[0].url, "https://example.com/article?safe=1");
  assert.ok(exportedRecord.errors.some((error) => error.message.includes("[REDACTED]")));
  assert.doesNotMatch(JSON.stringify(exportLines), /sk-model-secret|sk-search-secret|source-secret|Bearer/);
  assert.equal(exportLines[2].type, "summary");
  assert.equal((exportLines[2] as unknown as { recordCount: number }).recordCount, 1);

  const emptyExport = await fetch(`${harness.base}/v1/run-records/export?operationType=selection_analysis`, { headers: headers(harness.token) });
  assert.equal(emptyExport.status, 404);
  assert.equal((await emptyExport.json() as { error: { code: string } }).error.code, "no_export_records");
});

test("run record API exposes corrupt records safely and rejects invalid pagination", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const session = await seedSession(harness.store);
  const task = await seedResearchTask(harness.store, session, "task-corrupt-run-record", "2026-07-31T00:05:00.000Z");
  const database = new DatabaseSync(harness.store.getDataFilePath());
  database.prepare("UPDATE research_tasks SET record_json = ? WHERE id = ?").run("{broken", task.id);
  database.close();

  const list = await responseJson<{ items: Array<{ id: string; status: string; outcome: string }> }>(harness, "/v1/run-records?operationType=research");
  assert.equal(list.status, 200);
  assert.equal(list.body.items[0].id, `research:${task.id}`);
  assert.equal(list.body.items[0].status, "corrupt");
  assert.equal(list.body.items[0].outcome, "unavailable");

  const detail = await responseJson<{ status: string; errors: Array<{ source: string; message: string }>; modelCalls: unknown[] }>(harness, `/v1/run-records/${encodeURIComponent(`research:${task.id}`)}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.status, "corrupt");
  assert.deepEqual(detail.body.modelCalls, []);
  assert.equal(detail.body.errors[0].source, "record");
  assert.doesNotMatch(JSON.stringify(detail.body), /broken/);

  const invalid = await responseJson<{ error: { code: string } }>(harness, "/v1/run-records?limit=0");
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, "invalid_request");
});
