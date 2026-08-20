import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ResearchMessageRecord, type ResearchNodeRecord, type ResearchTaskRecord, type TermMarker } from "@collector/capture-contracts";
import {
  CaptureService,
  LocalAuth,
  type ResearchGenerationRequest,
  SqliteStore,
  createApiServer,
  type ResearchGenerationProvider,
} from "@collector/api";
import { listenOnFetchSafePort } from "./test-http-server.js";

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
  const service = new CaptureService(store, join(root, "artifacts"), undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: options.autoRunResearchTasks ?? true,
    autoRunResearchImports: false,
    autoRunSelectionTasks: false,
    researchProvider: options.provider,
  });
  const server = createApiServer(service, auth);
  await listenOnFetchSafePort(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return {
    root, store, service, server, token, base: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

async function waitForTask(base: string, token: string, taskId: string, status: "completed" | "failed") {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${base}/v1/research-tasks/${taskId}`, { headers: headers(token) });
    assert.equal(response.status, 200);
    const task = await response.json() as { status: string; [key: string]: unknown };
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Research task did not reach ${status}`);
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

async function appendCompletedAssistant(
  harness: Awaited<ReturnType<typeof createHarness>>,
  node: ResearchNodeRecord,
  content: string,
) {
  const now = new Date().toISOString();
  const inputMessage: ResearchMessageRecord = {
    id: randomUUID(), sessionId: node.sessionId, nodeId: node.id, role: "user", content: "Continue in this context", status: "completed", createdAt: now, updatedAt: now,
  };
  const outputMessage: ResearchMessageRecord = {
    id: randomUUID(), sessionId: node.sessionId, nodeId: node.id, role: "assistant", content, status: "completed", createdAt: now, updatedAt: now,
  };
  const task: ResearchTaskRecord = {
    id: randomUUID(), sessionId: node.sessionId, nodeId: node.id, inputMessageId: inputMessage.id, outputMessageId: outputMessage.id,
    idempotencyKey: randomUUID(), status: "completed", retryable: false, promptVersion: "test", createdAt: now, updatedAt: now, completedAt: now,
  };
  await harness.store.createResearchTurnForNode(node, inputMessage, outputMessage, task);
  const view = await harness.service.getResearchNodeView(node.id);
  const assistant = view.messages.find((message: ResearchMessageRecord) => message.id === outputMessage.id);
  assert.ok(assistant);
  const marker = view.termDetections?.[assistant.id]?.terms.find((candidate: TermMarker) => candidate.text === "REST");
  assert.ok(marker);
  return { assistant, marker };
}

test("term preview is persisted, streamed once, and grows a child from the exact preview", async (t) => {
  const requests: ResearchGenerationRequest[] = [];
  const answer = "REST API explains how HTTP clients communicate with a service.";
  const mainAnswer = "[[abbreviation:rest:REST]] API explains how HTTP clients communicate with a service.";
  const provider: ResearchGenerationProvider = {
    provider: "term-preview-provider",
    model: "term-preview-model",
    async *generate(request) {
      requests.push(structuredClone(request));
      const output = request.messages[0]?.content.includes("请解释当前回答中的") ? answer : mainAnswer;
      yield output.slice(0, Math.ceil(output.length / 2));
      await new Promise<void>((resolve) => setImmediate(resolve));
      yield output.slice(Math.ceil(output.length / 2));
    },
  };
  const harness = await createHarness({ provider });
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
  assert.equal(requests.filter((request) => request.messages[0]?.content.includes("请解释当前回答中的缩写")).length, 1);
  const previewRequest = requests.find((request) => request.messages[0]?.content.includes("请解释当前回答中的缩写"));
  const previewPrompt = previewRequest?.messages[0]?.content ?? "";
  // 预览请求显式关闭弱标记指令：预览内容不经标记管线解析，注入指令会让模型输出原始控制串（#86）。
  assert.equal(previewRequest?.mentionMarkup, false);
  assert.match(previewPrompt, /60–120 字/);
  assert.match(previewPrompt, /120–220 字/);
  assert.match(previewPrompt, /220–300 字/);
  assert.match(previewPrompt, /不得超过 320 字/);

  const eventsResponse = await fetch(`${harness.base}/v1/research-term-preview-tasks/${accepted.preview.id}/events`, { headers: headers(harness.token) });
  assert.equal(eventsResponse.status, 200);
  const events = await eventsResponse.text();
  assert.match(events, /event: snapshot/);
  assert.match(events, /event: delta/);
  assert.match(events, /event: completed/);

  const growResponse = await postJson(harness.base, harness.token, `/v1/research-term-previews/${accepted.preview.id}/grow`, {}, "term-grow-one");
  assert.equal(growResponse.status, 202);
  const grown = await growResponse.json() as { node: { id: string; originSelectionId?: string }; selection: { id: string }; outputMessage: { content: string; status: string; termMarkers?: TermMarker[] }; task: { status: string } };
  assert.equal(grown.node.originSelectionId, grown.selection.id);
  assert.equal(grown.outputMessage.content, answer);
  assert.equal(grown.outputMessage.status, "completed");
  // 生长落库显式空标记：预览内容不经流内标记管线，声明"本条无标记"。
  assert.deepEqual(grown.outputMessage.termMarkers, []);
  assert.equal(grown.task.status, "completed");

  // 节点视图不得把显式空标记的新消息退回词法检测——否则 "REST"/"API"/"HTTP" 会被乱标。
  const childViewResponse = await fetch(`${harness.base}/v1/research-nodes/${grown.node.id}`, { headers: headers(harness.token) });
  assert.equal(childViewResponse.status, 200);
  const childView = await childViewResponse.json() as {
    messages: Array<{ id: string; role: string }>;
    termDetections?: Record<string, { terms: TermMarker[] }>;
  };
  const grownAssistant = childView.messages.find((message) => message.role === "assistant");
  assert.ok(grownAssistant);
  assert.deepEqual(childView.termDetections?.[grownAssistant.id]?.terms, []);

  const repeatedGrow = await postJson(harness.base, harness.token, `/v1/research-term-previews/${accepted.preview.id}/grow`, {}, "term-grow-two");
  assert.equal(repeatedGrow.status, 202);
  const repeatedGrown = await repeatedGrow.json() as { node: { id: string }; outputMessage: { content: string } };
  assert.equal(repeatedGrown.node.id, grown.node.id);
  assert.equal(repeatedGrown.outputMessage.content, answer);
});

test("multiple mentions of the same entity in one stable answer reuse one preview task", async (t) => {
  const harness = await createHarness({ autoRunResearchTasks: false });
  t.after(() => harness.close());
  const fixture = await createCompletedAssistant(
    harness,
    "REST appears in this explanation, and REST appears again with enough surrounding context for detection.",
  );
  const mentions = fixture.markers.filter((marker: TermMarker) => marker.text === "REST");
  assert.equal(mentions.length, 2);
  assert.equal(mentions[0]?.entityId, mentions[1]?.entityId);

  const first = await harness.service.termPreviews.start(
    fixture.node.id,
    { messageId: fixture.assistant.id, marker: mentions[0]! },
    "same-entity-first",
  );
  const second = await harness.service.termPreviews.start(
    fixture.node.id,
    { messageId: fixture.assistant.id, marker: mentions[1]! },
    "same-entity-second",
  );
  assert.equal(second.preview.id, first.preview.id);
});

test("same-named mentions in different messages reuse a preview only after same-node context verification", async (t) => {
  const checks: Array<{ left: { context: string }; right: { context: string } }> = [];
  const provider: ResearchGenerationProvider = {
    provider: "term-identity-provider",
    model: "term-identity-model",
    async *generate() { yield "preview"; },
    async verifyTermIdentity(input) {
      checks.push(structuredClone(input));
      return true;
    },
  };
  const harness = await createHarness({ provider, autoRunResearchTasks: false });
  t.after(() => harness.close());

  const first = await createCompletedAssistant(harness, "REST is discussed as the architectural style used by this service.");
  const firstPreview = await harness.service.termPreviews.start(
    first.node.id,
    { messageId: first.assistant.id, marker: first.marker },
    "same-node-first-message",
  );
  const second = await appendCompletedAssistant(
    harness,
    first.node,
    "In this same service discussion, REST continues to describe that architectural style.",
  );
  const reused = await harness.service.termPreviews.start(
    first.node.id,
    { messageId: second.assistant.id, marker: second.marker },
    "same-node-second-message",
  );

  assert.equal(reused.preview.id, firstPreview.preview.id);
  assert.equal(checks.length, 1);
  assert.ok(checks[0]!.left.context.length <= 600);
  assert.ok(checks[0]!.right.context.length <= 600);
});

test("same-node verification rejection creates an independent preview", async (t) => {
  let checks = 0;
  const provider: ResearchGenerationProvider = {
    provider: "term-identity-provider",
    model: "term-identity-model",
    async *generate() { yield "preview"; },
    async verifyTermIdentity() {
      checks += 1;
      return false;
    },
  };
  const harness = await createHarness({ provider, autoRunResearchTasks: false });
  t.after(() => harness.close());

  const first = await createCompletedAssistant(harness, "REST is the architectural style used by this service.");
  const firstPreview = await harness.service.termPreviews.start(
    first.node.id,
    { messageId: first.assistant.id, marker: first.marker },
    "different-meaning-first",
  );
  const second = await appendCompletedAssistant(
    harness,
    first.node,
    "The speaker said REST to mean taking a break after the deployment.",
  );
  const independent = await harness.service.termPreviews.start(
    first.node.id,
    { messageId: second.assistant.id, marker: second.marker },
    "different-meaning-second",
  );

  assert.notEqual(independent.preview.id, firstPreview.preview.id);
  assert.equal(checks, 1);
});

test("different nodes always regenerate a same-named entity without cross-node verification", async (t) => {
  let checks = 0;
  const provider: ResearchGenerationProvider = {
    provider: "term-identity-provider",
    model: "term-identity-model",
    async *generate() { yield "preview"; },
    async verifyTermIdentity() {
      checks += 1;
      return true;
    },
  };
  const harness = await createHarness({ provider, autoRunResearchTasks: false });
  t.after(() => harness.close());

  const root = await createCompletedAssistant(harness, "REST is the architectural style used by the root-node discussion.");
  const rootPreview = await harness.service.termPreviews.start(
    root.node.id,
    { messageId: root.assistant.id, marker: root.marker },
    "root-node-preview",
  );
  const now = new Date().toISOString();
  const child: ResearchNodeRecord = {
    id: randomUUID(), sessionId: root.session.id, parentNodeId: root.node.id, status: "active", createdAt: now, updatedAt: now,
  };
  await harness.store.createResearchNode(child, randomUUID());
  const childMessage = await appendCompletedAssistant(
    harness,
    child,
    "REST appears in this child node and needs an explanation fitted to the child context.",
  );
  const childPreview = await harness.service.termPreviews.start(
    child.id,
    { messageId: childMessage.assistant.id, marker: childMessage.marker },
    "child-node-preview",
  );

  assert.notEqual(childPreview.preview.id, rootPreview.preview.id);
  assert.equal(checks, 0);
});

test("term preview uses 320 characters only as a safety cap", async (t) => {
  const requests: ResearchGenerationRequest[] = [];
  const harness = await createHarness({
    autoRunResearchTasks: false,
    provider: providerWithAnswer("解".repeat(400), requests),
  });
  t.after(() => harness.close());
  const fixture = await createCompletedAssistant(harness, "REST API gives enough context for this preview boundary test.");
  const started = await harness.service.termPreviews.start(
    fixture.node.id,
    { messageId: fixture.assistant.id, marker: fixture.marker },
    "preview-safety-cap",
  );
  await harness.service.termPreviews.processTask(started.preview.id);
  const completed = harness.service.termPreviews.getPreview(started.preview.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.content.length, 320);
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
  const reopened = new CaptureService(reopenedStore, join(harness.root, "artifacts-reopened"), undefined, {
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

test("same text with different answer-local identities in one answer gets separate previews without verification", async (t) => {
  let identityChecks = 0;
  const provider: ResearchGenerationProvider = {
    provider: "identity-split-provider",
    model: "identity-split-model",
    async *generate(request) {
      yield request.messages[0]?.content.includes("请解释当前回答中的")
        ? "preview"
        : "[[abbreviation:rest-style:REST]] as an architectural style, while [[abbreviation:rest-break:REST]] means taking a break.";
    },
    async verifyTermIdentity() {
      identityChecks += 1;
      return true;
    },
  };
  const harness = await createHarness({ provider });
  t.after(() => harness.close());

  const sessionResponse = await postJson(harness.base, harness.token, "/v1/research-sessions", {}, randomUUID());
  assert.equal(sessionResponse.status, 201);
  const session = await sessionResponse.json() as { id: string };
  const turnResponse = await postJson(
    harness.base,
    harness.token,
    `/v1/research-sessions/${session.id}/messages`,
    { content: "Explain the two meanings of REST" },
    randomUUID(),
  );
  assert.equal(turnResponse.status, 202);
  const turn = await turnResponse.json() as { task: { id: string } };
  await waitForTask(harness.base, harness.token, turn.task.id, "completed");

  const viewResponse = await fetch(`${harness.base}/v1/research-nodes/${session.id}`, { headers: headers(harness.token) });
  assert.equal(viewResponse.status, 200);
  const view = await viewResponse.json() as {
    messages: Array<{ id: string; role: string }>;
    termDetections?: Record<string, { terms: TermMarker[] }>;
  };
  const assistant = view.messages.find((message) => message.role === "assistant");
  assert.ok(assistant);
  const mentions = view.termDetections?.[assistant.id]?.terms.filter((candidate) => candidate.text === "REST") ?? [];
  assert.equal(mentions.length, 2);
  assert.notEqual(mentions[0]?.entityId, mentions[1]?.entityId);

  const first = await postJson(harness.base, harness.token, `/v1/research-nodes/${session.id}/term-previews`, { messageId: assistant.id, marker: mentions[0] }, randomUUID());
  const second = await postJson(harness.base, harness.token, `/v1/research-nodes/${session.id}/term-previews`, { messageId: assistant.id, marker: mentions[1] }, randomUUID());
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  const firstAccepted = await first.json() as { preview: { id: string } };
  const secondAccepted = await second.json() as { preview: { id: string } };
  assert.notEqual(secondAccepted.preview.id, firstAccepted.preview.id);
  // 同一回答内的复用只按回答内身份判断，不触发跨消息实体核验。
  assert.equal(identityChecks, 0);
});

test("same-node verification error regenerates an independent preview", async (t) => {
  let checks = 0;
  const provider: ResearchGenerationProvider = {
    provider: "term-identity-provider",
    model: "term-identity-model",
    async *generate() { yield "preview"; },
    async verifyTermIdentity() {
      checks += 1;
      throw new Error("verification provider unavailable");
    },
  };
  const harness = await createHarness({ provider, autoRunResearchTasks: false });
  t.after(() => harness.close());

  const first = await createCompletedAssistant(harness, "REST is the architectural style used by this service.");
  const firstPreview = await harness.service.termPreviews.start(
    first.node.id,
    { messageId: first.assistant.id, marker: first.marker },
    "verification-error-first",
  );
  const second = await appendCompletedAssistant(
    harness,
    first.node,
    "In this same service discussion, REST continues to describe that architectural style.",
  );
  const independent = await harness.service.termPreviews.start(
    first.node.id,
    { messageId: second.assistant.id, marker: second.marker },
    "verification-error-second",
  );

  // 核验失败一律视为不同实体：不复用、不污染新预览任务。
  assert.notEqual(independent.preview.id, firstPreview.preview.id);
  assert.equal(checks, 1);
});

test("same-node reuse is skipped entirely when no model is available for verification", async (t) => {
  const harness = await createHarness({ autoRunResearchTasks: false });
  t.after(() => harness.close());

  const first = await createCompletedAssistant(harness, "REST is the architectural style used by this service.");
  const firstPreview = await harness.service.termPreviews.start(
    first.node.id,
    { messageId: first.assistant.id, marker: first.marker },
    "model-missing-first",
  );
  const second = await appendCompletedAssistant(
    harness,
    first.node,
    "In this same service discussion, REST continues to describe that architectural style.",
  );
  const independent = await harness.service.termPreviews.start(
    first.node.id,
    { messageId: second.assistant.id, marker: second.marker },
    "model-missing-second",
  );

  // 模型不可用时不复用：为当前提及创建独立的预览任务（生成失败由任务自身承载）。
  assert.notEqual(independent.preview.id, firstPreview.preview.id);
});

test("body, markers, and completed preview survive a process restart", async (t) => {
  const previewAnswer = "REST API explains how HTTP clients communicate with a service.";
  const mainAnswer = "[[abbreviation:rest:REST]] API explains how [[abbreviation:http:HTTP]] clients communicate with a service.";
  const provider: ResearchGenerationProvider = {
    provider: "restart-consistency-provider",
    model: "restart-consistency-model",
    async *generate(request) {
      yield request.messages[0]?.content.includes("请解释当前回答中的") ? previewAnswer : mainAnswer;
    },
  };
  const harness = await createHarness({ provider });
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
  await waitForTask(harness.base, harness.token, turn.task.id, "completed");

  const viewResponse = await fetch(`${harness.base}/v1/research-nodes/${session.id}`, { headers: headers(harness.token) });
  assert.equal(viewResponse.status, 200);
  const view = await viewResponse.json() as {
    messages: Array<{ id: string; role: string }>;
    termDetections?: Record<string, { terms: TermMarker[] }>;
  };
  const assistant = view.messages.find((message) => message.role === "assistant");
  assert.ok(assistant);
  const marker = view.termDetections?.[assistant.id]?.terms.find((candidate) => candidate.text === "REST");
  assert.ok(marker);
  const startResponse = await postJson(harness.base, harness.token, `/v1/research-nodes/${session.id}/term-previews`, { messageId: assistant.id, marker }, randomUUID());
  assert.equal(startResponse.status, 202);
  const accepted = await startResponse.json() as { preview: { id: string } };
  const completed = await waitForPreview(harness.base, harness.token, accepted.preview.id, "completed") as unknown as { content: string };
  assert.equal(completed.content, previewAnswer);

  const persisted = harness.store.getResearchMessage(assistant.id);
  assert.ok(persisted);
  assert.ok((persisted.termMarkers ?? []).length >= 2);
  const databasePath = harness.store.getDataFilePath()!;
  harness.store.close();

  const reopenedStore = new SqliteStore(databasePath);
  await reopenedStore.init();
  const restoredMessage = reopenedStore.getResearchMessage(assistant.id);
  assert.ok(restoredMessage);
  assert.equal(restoredMessage.content, persisted.content);
  assert.ok(!restoredMessage.content.includes("[["));
  assert.deepEqual(restoredMessage.termMarkers, persisted.termMarkers);
  const restoredPreview = reopenedStore.getResearchTermPreview(accepted.preview.id);
  assert.equal(restoredPreview?.status, "completed");
  assert.equal(restoredPreview?.content, previewAnswer);
  reopenedStore.close();
});

test("streaming assistant messages can start a term preview; failed messages cannot", async (t) => {
  const harness = await createHarness({ autoRunResearchTasks: false });
  t.after(() => harness.close());
  const session = await harness.service.research.createSession("Streaming preview session", randomUUID());
  const node = harness.store.getResearchNode(session.id);
  assert.ok(node);
  const now = new Date().toISOString();
  const content = "REST is still being generated as a streaming answer.";
  const startOffset = content.indexOf("REST");
  const marker: TermMarker = {
    text: "REST", blockOrdinal: 0, startOffset, endOffset: startOffset + 4, category: "abbreviation", entityId: "rest",
  };
  const insertTurn = async (status: "streaming" | "failed") => {
    const inputMessage: ResearchMessageRecord = {
      id: randomUUID(), sessionId: session.id, nodeId: node.id, role: "user", content: "Explain the terms", status: "completed", createdAt: now, updatedAt: now,
    };
    const outputMessage: ResearchMessageRecord = {
      id: randomUUID(), sessionId: session.id, nodeId: node.id, role: "assistant", content, status, termMarkers: [marker], createdAt: now, updatedAt: now,
    };
    const task: ResearchTaskRecord = {
      id: randomUUID(), sessionId: session.id, nodeId: node.id, inputMessageId: inputMessage.id, outputMessageId: outputMessage.id,
      idempotencyKey: randomUUID(), status: status === "failed" ? "failed" : "running", retryable: false, promptVersion: "test", createdAt: now, updatedAt: now,
    };
    await harness.store.createResearchTurnForNode(node, inputMessage, outputMessage, task);
    return outputMessage;
  };

  // ADR-0029：流式期间提及闭合后上下文已固定，可以启动预览，不等待整篇完成。
  const streamingMessage = await insertTurn("streaming");
  const accepted = await harness.service.termPreviews.start(
    node.id,
    { messageId: streamingMessage.id, marker },
    "streaming-preview-start",
  );
  assert.equal(accepted.preview.status, "queued");
  assert.equal(accepted.preview.messageId, streamingMessage.id);

  const failedMessage = await insertTurn("failed");
  await assert.rejects(
    () => harness.service.termPreviews.start(node.id, { messageId: failedMessage.id, marker }, "failed-preview-start"),
    /streaming or completed/,
  );
});

test("growth anchors the child node at the clicked mention and repeated growth stays idempotent", async (t) => {
  const harness = await createHarness({ provider: providerWithAnswer("preview explanation", []), autoRunResearchTasks: false });
  t.after(() => harness.close());
  const first = await createCompletedAssistant(harness, "REST is the architectural style used by this service.");
  const started = await harness.service.termPreviews.start(
    first.node.id,
    { messageId: first.assistant.id, marker: first.marker },
    "mention-growth-preview",
  );
  await harness.service.termPreviews.processTask(started.preview.id);
  assert.equal(harness.service.termPreviews.getPreview(started.preview.id).status, "completed");

  // 同一对象在同一节点的后一条回答中再次被提及；用户在第二条上点击生长。
  const second = await appendCompletedAssistant(
    harness,
    first.node,
    "In this same service discussion, REST continues to describe that architectural style.",
  );
  const growBody = { mention: { messageId: second.assistant.id, marker: second.marker } };
  // 真实客户端的生长幂等键按预览派生（`term-growth:{previewId}`），首次生长按同一约定建模。
  const growKey = `term-growth:${started.preview.id}`;
  const growResponse = await postJson(
    harness.base, harness.token, `/v1/research-term-previews/${started.preview.id}/grow`, growBody, growKey,
  );
  assert.equal(growResponse.status, 202);
  const grown = await growResponse.json() as {
    node: { id: string; originSelectionId?: string };
    selection: { id: string; anchor: { kind: string; messageId?: string; startOffset: number; endOffset: number; exact: string } };
  };
  // ADR-0029：子节点来源锚定用户实际点击的那次提及，而不是预览最初生成时的首次提及。
  assert.equal(grown.node.originSelectionId, grown.selection.id);
  assert.equal(grown.selection.anchor.kind, "message");
  assert.equal(grown.selection.anchor.messageId, second.assistant.id);
  assert.equal(grown.selection.anchor.startOffset, second.marker.startOffset);
  assert.equal(grown.selection.anchor.endOffset, second.marker.endOffset);
  const persistedSelection = harness.store.getResearchSelection(grown.selection.id);
  assert.ok(persistedSelection);

  // 同一提及重复生长（同幂等键、换幂等键、回落无 mention）都返回首次创建的子节点。
  for (const [body, key] of [
    [growBody, growKey],
    [growBody, "mention-grow-two"],
    [{}, "mention-grow-three"],
  ] as const) {
    const repeat = await postJson(harness.base, harness.token, `/v1/research-term-previews/${started.preview.id}/grow`, body, key);
    assert.equal(repeat.status, 202);
    const repeated = await repeat.json() as { node: { id: string } };
    assert.equal(repeated.node.id, grown.node.id);
  }

  // 点击提及必须与预览同文同类：不同类别不能伪装成同一对象的生长来源。
  const mismatched = await postJson(
    harness.base,
    harness.token,
    `/v1/research-term-previews/${started.preview.id}/grow`,
    { mention: { messageId: second.assistant.id, marker: { ...second.marker, category: "concept" } } },
    "mention-grow-mismatch",
  );
  assert.equal(mismatched.status, 400);
});
