import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ResearchMessageRecord, type ResearchTaskRecord, type TermMarker } from "@collector/capture-contracts";
import {
  CaptureService,
  LocalAuth,
  type ResearchGenerationRequest,
  SqliteStore,
  createApiServer,
  type ResearchGenerationProvider,
} from "@collector/api";

interface HarnessOptions {
  provider?: ResearchGenerationProvider;
  autoRunResearchTasks?: boolean;
}

async function createHarness(options: HarnessOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "collector-term-preview-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = `term-preview-${randomUUID()}`;
  await auth.registerTrustedToken(token, "term-preview-test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: options.autoRunResearchTasks ?? true,
    autoRunResearchImports: false,
    autoRunSelectionTasks: false,
    researchProvider: options.provider,
  });
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return {
    root, store, service, server, token, base: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function headers(token: string, key?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(key ? { "Idempotency-Key": key } : {}),
  };
}

async function postJson(base: string, token: string, path: string, body: unknown, key?: string): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers: headers(token, key), body: JSON.stringify(body) });
}

async function waitForPreview(base: string, token: string, previewId: string, status: "completed" | "failed") {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${base}/v1/research-term-preview-tasks/${previewId}`, { headers: headers(token) });
    assert.equal(response.status, 200);
    const preview = await response.json() as { status: string; [key: string]: unknown };
    if (preview.status === status) return preview;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Term preview did not reach ${status}`);
}

function providerWithAnswer(answer: string, requests: ResearchGenerationRequest[]) : ResearchGenerationProvider {
  return {
    provider: "term-preview-provider",
    model: "term-preview-model",
    async *generate(request) {
      requests.push(structuredClone(request));
      yield answer.slice(0, Math.ceil(answer.length / 2));
      await new Promise<void>((resolve) => setImmediate(resolve));
      yield answer.slice(Math.ceil(answer.length / 2));
    },
  };
}

async function createCompletedAssistant(harness: Awaited<ReturnType<typeof createHarness>>, content: string) {
  const session = await harness.service.research.createSession("Term preview session", randomUUID());
  const node = harness.store.getResearchNode(session.id);
  assert.ok(node);
  const now = new Date().toISOString();
  const inputMessage: ResearchMessageRecord = {
    id: randomUUID(), sessionId: session.id, nodeId: node.id, role: "user", content: "Explain the terms", status: "completed", createdAt: now, updatedAt: now,
  };
  const outputMessage: ResearchMessageRecord = {
    id: randomUUID(), sessionId: session.id, nodeId: node.id, role: "assistant", content, status: "completed", createdAt: now, updatedAt: now,
  };
  const task: ResearchTaskRecord = {
    id: randomUUID(), sessionId: session.id, nodeId: node.id, inputMessageId: inputMessage.id, outputMessageId: outputMessage.id,
    idempotencyKey: randomUUID(), status: "completed", retryable: false, promptVersion: "test", createdAt: now, updatedAt: now, completedAt: now,
  };
  await harness.store.createResearchTurnForNode(node, inputMessage, outputMessage, task);
  const view = await harness.service.getResearchNodeView(node.id);
  const assistant = view.messages.find((message: ResearchMessageRecord) => message.id === outputMessage.id);
  assert.ok(assistant);
  const markers = view.termDetections?.[assistant.id]?.terms ?? [];
  const marker = markers[0];
  assert.ok(marker);
  return { session, node, inputMessage, assistant, marker, markers };
}

test("term preview is persisted, streamed once, and grows a child from the exact preview", async (t) => {
  const requests: ResearchGenerationRequest[] = [];
  const answer = "REST API explains how HTTP clients communicate with a service.";
  const harness = await createHarness({ provider: providerWithAnswer(answer, requests) });
  t.after(() => harness.close());

  const sessionResponse = await postJson(harness.base, harness.token, "/v1/research-sessions", {}, randomUUID());
  assert.equal(sessionResponse.status, 201);
  const session = await sessionResponse.json() as { id: string };
  const turnResponse = await postJson(
    harness.base,
    harness.token,
    `/v1/research-sessions/${session.id}/messages`,
    { content: "Explain REST API and HTTP" },
    randomUUID(),
  );
  assert.equal(turnResponse.status, 202);
  const turn = await turnResponse.json() as { task: { id: string } };
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${harness.base}/v1/research-tasks/${turn.task.id}`, { headers: headers(harness.token) });
    const task = await response.json() as { status: string };
    if (task.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const viewResponse = await fetch(`${harness.base}/v1/research-nodes/${session.id}`, { headers: headers(harness.token) });
  assert.equal(viewResponse.status, 200);
  const view = await viewResponse.json() as {
    messages: Array<{ id: string; role: string; status: string; content: string }>;
    termDetections?: Record<string, { terms: TermMarker[] }>;
  };
  const assistant = view.messages.find((message) => message.role === "assistant");
  assert.ok(assistant);
  const marker = view.termDetections?.[assistant.id]?.terms.find((candidate) => candidate.text === "REST");
  assert.ok(marker);

  const starts = await Promise.all([
    postJson(harness.base, harness.token, `/v1/research-nodes/${session.id}/term-previews`, { messageId: assistant.id, marker }, "preview-one"),
    postJson(harness.base, harness.token, `/v1/research-nodes/${session.id}/term-previews`, { messageId: assistant.id, marker }, "preview-two"),
  ]);
  assert.deepEqual(starts.map((response) => response.status), [202, 202]);
  const accepted = await starts[0].json() as { preview: { id: string; status: string }; selection: { id: string } };
  const repeated = await starts[1].json() as { preview: { id: string }; selection: { id: string } };
  assert.equal(repeated.preview.id, accepted.preview.id);
  assert.equal(repeated.selection.id, accepted.selection.id);

  const completed = await waitForPreview(harness.base, harness.token, accepted.preview.id, "completed") as unknown as { content: string };
  assert.equal(completed.content, answer);
  assert.equal(requests.filter((request) => request.messages[0]?.content.includes("请解释当前回答中的术语")).length, 1);

  const eventsResponse = await fetch(`${harness.base}/v1/research-term-preview-tasks/${accepted.preview.id}/events`, { headers: headers(harness.token) });
  assert.equal(eventsResponse.status, 200);
  const events = await eventsResponse.text();
  assert.match(events, /event: snapshot/);
  assert.match(events, /event: delta/);
  assert.match(events, /event: completed/);

  const growResponse = await postJson(harness.base, harness.token, `/v1/research-term-previews/${accepted.preview.id}/grow`, {}, "term-grow-one");
  assert.equal(growResponse.status, 202);
  const grown = await growResponse.json() as { node: { id: string; originSelectionId?: string }; selection: { id: string }; outputMessage: { content: string; status: string }; task: { status: string } };
  assert.equal(grown.node.originSelectionId, grown.selection.id);
  assert.equal(grown.outputMessage.content, answer);
  assert.equal(grown.outputMessage.status, "completed");
  assert.equal(grown.task.status, "completed");

  const repeatedGrow = await postJson(harness.base, harness.token, `/v1/research-term-previews/${accepted.preview.id}/grow`, {}, "term-grow-two");
  assert.equal(repeatedGrow.status, 202);
  const repeatedGrown = await repeatedGrow.json() as { node: { id: string }; outputMessage: { content: string } };
  assert.equal(repeatedGrown.node.id, grown.node.id);
  assert.equal(repeatedGrown.outputMessage.content, answer);
});

test("term preview failure keeps partial content, retries, and marks interrupted work after restart", async (t) => {
  const failingProvider: ResearchGenerationProvider = {
    provider: "term-preview-failing",
    model: "term-preview-failing-model",
    async *generate() {
      yield "partial preview";
      throw new Error("provider unavailable");
    },
  };
  const harness = await createHarness({ provider: failingProvider, autoRunResearchTasks: false });
  t.after(() => harness.close());
  const fixture = await createCompletedAssistant(harness, "REST API gives an HTTP integration example for this node.");
  const started = await harness.service.termPreviews.start(fixture.node.id, { messageId: fixture.assistant.id, marker: fixture.marker }, "failure-preview");
  await harness.service.termPreviews.processTask(started.preview.id);
  const failed = harness.service.termPreviews.getPreview(started.preview.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.retryable, true);
  assert.equal(failed.content, "partial preview");
  assert.equal(failed.error?.code, "provider_error");

  harness.service.research.setProvider(providerWithAnswer("recovered preview", []));
  const retried = await harness.service.termPreviews.retryTask(started.preview.id);
  assert.equal(retried.status, "queued");
  await harness.service.termPreviews.processTask(started.preview.id);
  assert.equal(harness.service.termPreviews.getPreview(started.preview.id).content, "recovered preview");

  const databasePath = harness.store.getDataFilePath()!;
  const restartMarker = fixture.markers.find((marker: TermMarker) => marker.text === "HTTP");
  assert.ok(restartMarker);
  const interrupted = await harness.service.termPreviews.start(fixture.node.id, { messageId: fixture.assistant.id, marker: restartMarker }, "restart-preview");
  const claimed = harness.store.claimResearchTermPreview(interrupted.preview.id, "term-preview-failing", "term-preview-failing-model", "term-preview-v1");
  assert.equal(claimed?.status, "running");
  await harness.store.appendResearchTermPreviewDelta(interrupted.preview.id, "saved before restart");
  harness.store.close();

  const reopenedStore = new SqliteStore(databasePath);
  await reopenedStore.init();
  const reopened = new CaptureService(reopenedStore, join(harness.root, "artifacts-reopened"), undefined, undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
    researchProvider: failingProvider,
  });
  assert.equal(await reopened.termPreviews.resumeTasks(), 1);
  const restarted = reopened.termPreviews.getPreview(interrupted.preview.id);
  assert.equal(restarted.status, "failed");
  assert.equal(restarted.retryable, true);
  assert.equal(restarted.error?.code, "service_restarted");
  assert.equal(restarted.content, "saved before restart");
  reopenedStore.close();
});
