import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveDefaultLaterSummary, deriveMessageBlocks } from "@collector/capture-contracts";
import {
  CaptureService,
  createApiServer,
  LocalAuth,
  SqliteStore,
} from "@collector/api";

const ASSISTANT_CONTENT = "第一段介绍本地优先研究的基本概念。\n\n第二段讨论选区如何连接阅读与研究，并给出实践建议。\n\n第三段总结尚未验证的问题。";
const SESSION_TITLE = "测试会话";

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "collector-later-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = `later-${randomUUID()}`;
  await auth.registerTrustedToken(token, "later-test");
  // 稍后再学是基础能力：不配置任何模型供应商，也不运行分析与生成任务。
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
    autoRunResearchImports: false,
    autoRunSelectionTasks: false,
  });
  const server = createApiServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return {
    root, store, service, server, token,
    base: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function headers(token: string, key?: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(key ? { "Idempotency-Key": key } : {}),
  };
}

async function postJson(base: string, token: string, path: string, body: unknown, key?: string) {
  return fetch(`${base}${path}`, { method: "POST", headers: headers(token, key), body: JSON.stringify(body) });
}

async function putJson(base: string, token: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, { method: "PUT", headers: headers(token), body: JSON.stringify(body) });
}

async function deleteJson(base: string, token: string, path: string) {
  return fetch(`${base}${path}`, { method: "DELETE", headers: headers(token) });
}

async function createSessionWithAnswer(harness: Awaited<ReturnType<typeof createHarness>>) {
  const sessionResponse = await postJson(harness.base, harness.token, "/v1/research-sessions", {}, randomUUID());
  assert.equal(sessionResponse.status, 201);
  const session = await sessionResponse.json() as { id: string };
  const now = new Date().toISOString();
  const userMessage = {
    id: randomUUID(), sessionId: session.id, role: "user" as const,
    content: "什么是本地优先研究？", status: "completed" as const, createdAt: now, updatedAt: now,
  };
  const assistantMessage = {
    id: randomUUID(), sessionId: session.id, role: "assistant" as const,
    content: ASSISTANT_CONTENT, status: "completed" as const, createdAt: now, updatedAt: now,
  };
  const task = {
    id: randomUUID(), sessionId: session.id,
    inputMessageId: userMessage.id, outputMessageId: assistantMessage.id,
    idempotencyKey: randomUUID(), status: "completed" as const, retryable: false,
    promptVersion: "research-chat-v1", createdAt: now, updatedAt: now, completedAt: now,
  };
  await harness.store.createResearchTurn(
    { id: session.id, title: SESSION_TITLE, status: "active", isFavorite: false, createdAt: now, updatedAt: now },
    userMessage, assistantMessage, task,
  );
  return { session, assistantMessage };
}

function anchorForSelection(messageId: string, blockOrdinal: number, exact: string) {
  const block = deriveMessageBlocks(ASSISTANT_CONTENT)[blockOrdinal];
  const startOffset = block.text.indexOf(exact);
  assert.ok(startOffset >= 0, `fixture text must contain ${exact}`);
  return {
    kind: "message", messageId, blockOrdinal,
    startOffset, endOffset: startOffset + exact.length, exact,
  };
}

async function createSelectionOn(
  harness: Awaited<ReturnType<typeof createHarness>>,
  sessionId: string,
  anchor: unknown,
) {
  const response = await postJson(harness.base, harness.token, `/v1/research-sessions/${sessionId}/selections`, { anchor }, randomUUID());
  assert.equal(response.status, 201);
  return await response.json() as { selection: { id: string; text: string }; task: { id: string } };
}

interface LaterView {
  item: { id: string; sessionId: string; nodeId?: string; selectionId: string; summary: string; priority: number; status: string; note?: string; createdAt: string; updatedAt: string };
  selection: { id: string; text: string };
  sourceTitle: string;
  sourceNode: { id: string; label: string };
}

test("creates a later item from a message selection without any AI dependency", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const exact = "选区如何连接阅读与研究";
  const created = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 1, exact));

  const response = await postJson(harness.base, harness.token, "/v1/research-later-items", { selectionId: created.selection.id }, randomUUID());
  assert.equal(response.status, 201);
  const view = await response.json() as LaterView;
  assert.equal(view.item.sessionId, session.id);
  assert.equal(view.item.nodeId, session.id);
  assert.equal(view.item.selectionId, created.selection.id);
  assert.equal(view.item.status, "pending");
  assert.equal(view.item.priority, 3);
  // 概括默认值确定性派生：无句末标点时取整段（不超过 80 字符）
  assert.equal(view.item.summary, deriveDefaultLaterSummary(exact));
  assert.equal(view.item.summary, exact);
  assert.equal(view.selection.text, exact);
  assert.equal(view.sourceTitle, SESSION_TITLE);
  assert.deepEqual(view.sourceNode, { id: session.id, label: SESSION_TITLE });
  assert.equal(harness.store.listResearchLaterItems().length, 1);
});

test("first-sentence default summary is derived from the selection text", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const exact = "第二段讨论选区如何连接阅读与研究，并给出实践建议。";
  const created = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 1, exact));

  const response = await postJson(harness.base, harness.token, "/v1/research-later-items", { selectionId: created.selection.id }, randomUUID());
  const view = await response.json() as LaterView;
  assert.equal(view.item.summary, "第二段讨论选区如何连接阅读与研究，并给出实践建议");
});

test("explicit priority and summary are stored as provided", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const created = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 0, "本地优先研究"));

  const response = await postJson(harness.base, harness.token, "/v1/research-later-items", {
    selectionId: created.selection.id, priority: 5, summary: "用户自定义概括",
  }, randomUUID());
  assert.equal(response.status, 201);
  const view = await response.json() as LaterView;
  assert.equal(view.item.priority, 5);
  assert.equal(view.item.summary, "用户自定义概括");
});

test("idempotent replay returns the same item without duplicates", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const created = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 1, "实践建议"));

  const key = randomUUID();
  const first = await (await postJson(harness.base, harness.token, "/v1/research-later-items", { selectionId: created.selection.id }, key)).json() as LaterView;
  const second = await (await postJson(harness.base, harness.token, "/v1/research-later-items", { selectionId: created.selection.id }, key)).json() as LaterView;
  assert.equal(second.item.id, first.item.id);
  assert.equal(harness.store.listResearchLaterItems().length, 1);
});

test("mark idempotency is compatible with a legacy later key", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const created = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 1, "实践建议"));

  const legacy = await (await postJson(
    harness.base,
    harness.token,
    "/v1/research-later-items",
    { selectionId: created.selection.id },
    `later:${created.selection.id}`,
  )).json() as LaterView;
  const mark = await (await postJson(
    harness.base,
    harness.token,
    "/v1/research-later-items",
    { selectionId: created.selection.id },
    `mark:${created.selection.id}`,
  )).json() as LaterView;

  assert.equal(mark.item.id, legacy.item.id);
  assert.equal(harness.store.listResearchLaterItems().length, 1);
});

test("lists items across sessions with joined selection text, newest first", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const first = await createSessionWithAnswer(harness);
  const second = await createSessionWithAnswer(harness);
  const firstSelection = await createSelectionOn(harness, first.session.id, anchorForSelection(first.assistantMessage.id, 0, "本地优先研究"));
  const secondSelection = await createSelectionOn(harness, second.session.id, anchorForSelection(second.assistantMessage.id, 2, "尚未验证的问题"));

  const firstItem = await (await postJson(harness.base, harness.token, "/v1/research-later-items", { selectionId: firstSelection.selection.id }, randomUUID())).json() as LaterView;
  const secondItem = await (await postJson(harness.base, harness.token, "/v1/research-later-items", { selectionId: secondSelection.selection.id }, randomUUID())).json() as LaterView;

  const list = await (await fetch(`${harness.base}/v1/research-later-items`, { headers: headers(harness.token) })).json() as LaterView[];
  assert.deepEqual(list.map((view) => view.item.id), [secondItem.item.id, firstItem.item.id]);
  assert.deepEqual(list.map((view) => view.selection.text), ["尚未验证的问题", "本地优先研究"]);
  assert.ok(list.every((view) => view.sourceTitle === SESSION_TITLE));
});

test("status filter returns matching items and rejects unknown status", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const selection = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 0, "本地优先研究"));
  const view = await (await postJson(harness.base, harness.token, "/v1/research-later-items", { selectionId: selection.selection.id }, randomUUID())).json() as LaterView;
  await putJson(harness.base, harness.token, `/v1/research-later-items/${view.item.id}`, { status: "done" });

  const pending = await (await fetch(`${harness.base}/v1/research-later-items?status=pending`, { headers: headers(harness.token) })).json() as LaterView[];
  assert.deepEqual(pending, []);
  const done = await (await fetch(`${harness.base}/v1/research-later-items?status=done`, { headers: headers(harness.token) })).json() as LaterView[];
  assert.deepEqual(done.map((item) => item.item.id), [view.item.id]);
  assert.equal((await fetch(`${harness.base}/v1/research-later-items?status=archived`, { headers: headers(harness.token) })).status, 400);
});

test("updates priority, summary and status independently", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const selection = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 1, "实践建议"));
  const created = await (await postJson(harness.base, harness.token, "/v1/research-later-items", { selectionId: selection.selection.id }, randomUUID())).json() as LaterView;

  const priorityUpdate = await putJson(harness.base, harness.token, `/v1/research-later-items/${created.item.id}`, { priority: 1 });
  assert.equal(priorityUpdate.status, 200);
  const afterPriority = await priorityUpdate.json() as LaterView;
  assert.equal(afterPriority.item.priority, 1);
  assert.equal(afterPriority.item.summary, created.item.summary);
  assert.equal(afterPriority.item.status, "pending");

  const summaryUpdate = await (await putJson(harness.base, harness.token, `/v1/research-later-items/${created.item.id}`, { summary: "调整后的概括" })).json() as LaterView;
  assert.equal(summaryUpdate.item.summary, "调整后的概括");
  assert.equal(summaryUpdate.item.priority, 1);

  const doneUpdate = await (await putJson(harness.base, harness.token, `/v1/research-later-items/${created.item.id}`, { status: "done" })).json() as LaterView;
  assert.equal(doneUpdate.item.status, "done");
  const restored = await (await putJson(harness.base, harness.token, `/v1/research-later-items/${created.item.id}`, { status: "pending" })).json() as LaterView;
  assert.equal(restored.item.status, "pending");

  const single = await (await fetch(`${harness.base}/v1/research-later-items/${created.item.id}`, { headers: headers(harness.token) })).json() as LaterView;
  assert.equal(single.item.priority, 1);
  assert.equal(single.item.summary, "调整后的概括");
  assert.equal(single.item.status, "pending");
});

test("mark flow: create without note, add a note, then clear it back to a pure mark (修订二)", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const selection = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 1, "实践建议"));

  // 点击【标记】即创建：无笔记（纯标记），不依赖 AI
  const created = await (await postJson(harness.base, harness.token, "/v1/research-later-items", { selectionId: selection.selection.id }, randomUUID())).json() as LaterView;
  assert.equal(created.item.note, undefined);

  // 输入笔记后点击其他位置：保存笔记
  const noted = await (await putJson(harness.base, harness.token, `/v1/research-later-items/${created.item.id}`, { note: "这一段要反复验证" })).json() as LaterView;
  assert.equal(noted.item.note, "这一段要反复验证");
  assert.equal(noted.item.summary, created.item.summary);

  const single = await (await fetch(`${harness.base}/v1/research-later-items/${created.item.id}`, { headers: headers(harness.token) })).json() as LaterView;
  assert.equal(single.item.note, "这一段要反复验证");
  // 列表视图同样携带笔记
  const listed = await (await fetch(`${harness.base}/v1/research-later-items`, { headers: headers(harness.token) })).json() as LaterView[];
  assert.equal(listed.find((view) => view.item.id === created.item.id)?.item.note, "这一段要反复验证");

  // 空笔记 / 纯空白视为清除，回到纯标记
  const cleared = await (await putJson(harness.base, harness.token, `/v1/research-later-items/${created.item.id}`, { note: "   " })).json() as LaterView;
  assert.equal(cleared.item.note, undefined);
  assert.equal(harness.store.getResearchLaterItem(created.item.id)?.note, undefined);

  // 超长笔记被拒绝
  assert.equal((await putJson(harness.base, harness.token, `/v1/research-later-items/${created.item.id}`, { note: "x".repeat(2_001) })).status, 400);
});

test("deletes a mark permanently with stable auth and not-found responses", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const selection = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 1, "实践建议"));
  const created = await (await postJson(harness.base, harness.token, "/v1/research-later-items", { selectionId: selection.selection.id }, randomUUID())).json() as LaterView;

  const unauthorized = await fetch(`${harness.base}/v1/research-later-items/${created.item.id}`, { method: "DELETE" });
  assert.equal(unauthorized.status, 401);
  assert.ok(harness.store.getResearchLaterItem(created.item.id));

  const deleted = await deleteJson(harness.base, harness.token, `/v1/research-later-items/${created.item.id}`);
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { deleted: true });
  assert.equal(harness.store.getResearchLaterItem(created.item.id), undefined);

  assert.equal((await deleteJson(harness.base, harness.token, `/v1/research-later-items/${created.item.id}`)).status, 404);
  assert.equal((await deleteJson(harness.base, harness.token, `/v1/research-later-items/${randomUUID()}`)).status, 404);
});

test("validation rejects malformed requests and unknown references", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const selection = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 0, "本地优先研究"));

  assert.equal((await postJson(harness.base, harness.token, "/v1/research-later-items", { selectionId: randomUUID() }, randomUUID())).status, 404);
  assert.equal((await postJson(harness.base, harness.token, "/v1/research-later-items", {}, randomUUID())).status, 400);
  assert.equal((await postJson(harness.base, harness.token, "/v1/research-later-items", { selectionId: selection.selection.id, priority: 6 }, randomUUID())).status, 400);
  assert.equal((await postJson(harness.base, harness.token, "/v1/research-later-items", { selectionId: selection.selection.id, summary: "   " }, randomUUID())).status, 400);
  assert.equal((await postJson(harness.base, harness.token, "/v1/research-later-items", { selectionId: selection.selection.id })).status, 400);

  const created = await (await postJson(harness.base, harness.token, "/v1/research-later-items", { selectionId: selection.selection.id }, randomUUID())).json() as LaterView;
  assert.equal((await fetch(`${harness.base}/v1/research-later-items/${randomUUID()}`, { headers: headers(harness.token) })).status, 404);
  assert.equal((await putJson(harness.base, harness.token, `/v1/research-later-items/${randomUUID()}`, { priority: 2 })).status, 404);
  assert.equal((await putJson(harness.base, harness.token, `/v1/research-later-items/${created.item.id}`, {})).status, 400);
  assert.equal((await putJson(harness.base, harness.token, `/v1/research-later-items/${created.item.id}`, { status: "archived" })).status, 400);
  assert.equal((await putJson(harness.base, harness.token, `/v1/research-later-items/${created.item.id}`, { priority: 0 })).status, 400);
});

test("later item from an imported document snapshot carries the content title", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { session } = await createSessionWithAnswer(harness);

  const upload = await fetch(`${harness.base}/v1/research-sessions/${session.id}/imports`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${harness.token}`,
      "Content-Type": "text/plain",
      "Idempotency-Key": randomUUID(),
      "X-File-Name": encodeURIComponent("笔记.txt"),
    },
    body: Buffer.from("第一行内容。\n\n第二行包含可引用的关键论断。"),
  });
  assert.equal(upload.status, 202);
  const imported = await upload.json() as { task: { id: string }; attachment: { id: string } };
  await harness.service.researchImports.processTask(imported.task.id);
  const attachment = harness.store.getResearchAttachment(imported.attachment.id)!;
  const snapshot = harness.store.getResearchContentSnapshot(attachment.contentSnapshotId!)!;
  const block = snapshot.blocks[1];
  const exact = "可引用的关键论断";
  const start = block.text.indexOf(exact);

  const created = await createSelectionOn(harness, session.id, {
    kind: "snapshot", contentSnapshotId: snapshot.id, blockId: block.id,
    startOffset: start, endOffset: start + exact.length, exact,
  });
  const view = await (await postJson(harness.base, harness.token, "/v1/research-later-items", { selectionId: created.selection.id }, randomUUID())).json() as LaterView;
  assert.equal(view.sourceTitle, snapshot.title);
  assert.equal(view.selection.text, exact);
  assert.equal(view.item.summary, exact);
});

test("later items persist across store reopen and survive service restart", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const selection = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 1, "实践建议"));
  const created = await (await postJson(harness.base, harness.token, "/v1/research-later-items", { selectionId: selection.selection.id, priority: 4 }, randomUUID())).json() as LaterView;
  await putJson(harness.base, harness.token, `/v1/research-later-items/${created.item.id}`, { note: "重启后仍在的笔记" });

  const reopened = new SqliteStore(join(harness.root, "collector.sqlite"));
  await reopened.init();
  const item = reopened.getResearchLaterItem(created.item.id);
  assert.equal(item?.priority, 4);
  assert.equal(item?.status, "pending");
  assert.equal(item?.selectionId, selection.selection.id);
  assert.equal(item?.note, "重启后仍在的笔记");
  reopened.close();
});

test("clearAllData removes later items without foreign key errors", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const selection = await createSelectionOn(harness, session.id, anchorForSelection(assistantMessage.id, 1, "实践建议"));
  await postJson(harness.base, harness.token, "/v1/research-later-items", { selectionId: selection.selection.id }, randomUUID());

  await harness.store.clearAllData();
  assert.deepEqual(harness.store.listResearchLaterItems(), []);
  assert.deepEqual(harness.store.listResearchSelections(session.id), []);
  assert.deepEqual(harness.store.listResearchSessions(), []);
});
