import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelCallRecord, WorkflowRunRecord } from "@collector/capture-contracts";
import { CaptureService, SqliteStore } from "@collector/api";

function dummyRun(id: string): WorkflowRunRecord {
  const ts = new Date().toISOString();
  return {
    id, workflowType: "recent_organization", idempotencyKey: id,
    materialIds: [], materialSetVersion: id, status: "completed",
    createdAt: ts, startedAt: ts, completedAt: ts,
  };
}

function modelCall(overrides: Partial<ModelCallRecord> = {}): ModelCallRecord {
  return {
    id: crypto.randomUUID(),
    workflowRunId: crypto.randomUUID(),
    provider: "deepseek",
    model: "deepseek-v4-flash",
    purpose: "summarization",
    promptVersion: "v1",
    status: "completed",
    inputTokens: 500,
    outputTokens: 200,
    cacheHitTokens: 0,
    estimatedCostUsd: 0.0004,
    latencyMs: 1200,
    retryCount: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "collector-ai-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  return { root, store };
}

// ── Model Call Persistence ──────────────────────────────────

test("saveModelCall persists and listModelCalls returns records", async (t) => {
  const { root, store } = await fixture();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });

  const runId = crypto.randomUUID();
  await store.saveWorkflowRun(dummyRun(runId));

  const call = modelCall({ workflowRunId: runId });
  await store.saveModelCall(call);
  const all = store.listModelCalls();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, call.id);
  assert.equal(all[0].provider, "deepseek");
  assert.equal(all[0].inputTokens, 500);
  assert.equal(all[0].estimatedCostUsd, 0.0004);
});

test("listModelCalls filters by workflowRunId", async (t) => {
  const { root, store } = await fixture();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });

  const runA = crypto.randomUUID();
  const runB = crypto.randomUUID();
  await store.saveWorkflowRun(dummyRun(runA));
  await store.saveWorkflowRun(dummyRun(runB));

  await store.saveModelCall(modelCall({ workflowRunId: runA }));
  await store.saveModelCall(modelCall({ workflowRunId: runB }));
  await store.saveModelCall(modelCall({ workflowRunId: runA }));

  assert.equal(store.listModelCalls(runA).length, 2);
  assert.equal(store.listModelCalls(runB).length, 1);
  assert.equal(store.listModelCalls().length, 3);
});

test("model calls persist failed status and error message", async (t) => {
  const { root, store } = await fixture();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });

  const runId = crypto.randomUUID();
  await store.saveWorkflowRun(dummyRun(runId));

  const call = modelCall({ workflowRunId: runId, status: "failed", errorMessage: "Connection timeout", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
  await store.saveModelCall(call);
  const all = store.listModelCalls();
  assert.equal(all[0].status, "failed");
  assert.equal(all[0].errorMessage, "Connection timeout");
});

// ── Monthly Cost Tracking ──────────────────────────────────

test("getMonthModelCallCostUsd sums completed calls for a month", async (t) => {
  const { root, store } = await fixture();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const d1 = new Date(Date.UTC(year, month - 1, 5)).toISOString();
  const d2 = new Date(Date.UTC(year, month - 1, 15)).toISOString();

  const runA = crypto.randomUUID();
  const runB = crypto.randomUUID();
  await store.saveWorkflowRun(dummyRun(runA));
  await store.saveWorkflowRun(dummyRun(runB));

  await store.saveModelCall(modelCall({ workflowRunId: runA, createdAt: d1, estimatedCostUsd: 0.01 }));
  await store.saveModelCall(modelCall({ workflowRunId: runB, createdAt: d2, estimatedCostUsd: 0.02, status: "failed" }));
  await store.saveModelCall(modelCall({ workflowRunId: runA, createdAt: d2, estimatedCostUsd: 0.03 }));

  const cost = store.getMonthModelCallCostUsd(year, month);
  assert.ok(Math.abs(cost - 0.04) < 0.001, `Expected ~0.04, got ${cost}`);
});

test("getMonthModelCalls returns calls in date range", async (t) => {
  const { root, store } = await fixture();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const d = new Date(Date.UTC(year, month - 1, 10)).toISOString();

  const runId = crypto.randomUUID();
  await store.saveWorkflowRun(dummyRun(runId));
  await store.saveModelCall(modelCall({ workflowRunId: runId, createdAt: d }));

  assert.equal(store.getMonthModelCalls(year, month).length, 1);
});

// ── Budget Settings ─────────────────────────────────────────

test("AI budget settings can be saved and retrieved", async (t) => {
  const { root, store } = await fixture();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });

  await store.saveAiBudgetSetting("monthly_limit_usd", "5.00");
  await store.saveAiBudgetSetting("warning_threshold_usd", "4.00");
  await store.saveAiBudgetSetting("enabled", "true");

  assert.equal(store.getAiBudgetSetting("monthly_limit_usd"), "5.00");
  assert.equal(store.getAiBudgetSetting("warning_threshold_usd"), "4.00");
  assert.equal(store.getAiBudgetSetting("enabled"), "true");
  assert.equal(store.getAiBudgetSetting("nonexistent"), undefined);
});

test("saveAiBudgetSetting overwrites existing values", async (t) => {
  const { root, store } = await fixture();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });

  await store.saveAiBudgetSetting("monthly_limit_usd", "10.00");
  await store.saveAiBudgetSetting("monthly_limit_usd", "20.00");
  assert.equal(store.getAiBudgetSetting("monthly_limit_usd"), "20.00");
});

test("usage separates provider/model routes and strict budgets block unknown costs", async (t) => {
  const { root, store } = await fixture();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const runId = crypto.randomUUID();
  await store.saveWorkflowRun(dummyRun(runId));
  await store.saveModelCall(modelCall({ workflowRunId: runId, provider: "openai", model: "gpt-4.1-mini", costStatus: "unknown", estimatedCostUsd: 0 }));
  await store.saveModelCall(modelCall({ workflowRunId: runId, provider: "deepseek", model: "deepseek-v4-flash", costStatus: "estimated", estimatedCostUsd: 0.01 }));
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  const usage = service.getAiUsage();
  assert.equal(usage.unknownCostCalls, 1);
  assert.equal(usage.byProviderModel["openai/gpt-4.1-mini"].unknownCostCalls, 1);
  assert.equal(usage.byProviderModel["deepseek/deepseek-v4-flash"].costUsd, 0.01);
  await service.updateAiBudgetSettings({ enabled: true, monthlyLimitUsd: 10 });
  assert.equal(service.getAiBudgetSettings().status, "unknown");
  assert.equal(service.checkAiBudget(), false);
});
