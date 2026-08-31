import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { deriveMessageBlocks, hashBodyContent } from "@collector/capture-contracts";
import { CaptureService, LocalAuth, SqliteStore, createApiServer } from "@collector/api";
import { listenOnFetchSafePort } from "./test-http-server.js";

const ASSISTANT_CONTENT = "第一段介绍本地优先研究的基本概念。\n\n第二段讨论选区如何连接阅读与研究，并给出实践建议。\n\n第三段总结尚未验证的问题。";

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "collector-selection-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = `selection-${randomUUID()}`;
  await auth.registerTrustedToken(token, "research-selection-test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
    autoRunResearchImports: false,
  });
  const server = createApiServer(service, auth);
  await listenOnFetchSafePort(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return {
    store, server, token,
    base: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

async function createSessionWithAnswer(harness: Awaited<ReturnType<typeof createHarness>>, content = ASSISTANT_CONTENT) {
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
    content, status: "completed" as const, createdAt: now, updatedAt: now,
  };
  const task = {
    id: randomUUID(), sessionId: session.id,
    inputMessageId: userMessage.id, outputMessageId: assistantMessage.id,
    idempotencyKey: randomUUID(), status: "completed" as const, retryable: false,
    promptVersion: "research-chat-v1", createdAt: now, updatedAt: now, completedAt: now,
  };
  await harness.store.createResearchTurn(
    { id: session.id, title: "测试会话", status: "active", isFavorite: false, createdAt: now, updatedAt: now },
    userMessage, assistantMessage, task,
  );
  return { session, assistantMessage };
}

function anchorForSelection(messageId: string, blockOrdinal: number, exact: string) {
  const block = deriveMessageBlocks(ASSISTANT_CONTENT)[blockOrdinal];
  const startOffset = block.text.indexOf(exact);
  assert.ok(startOffset >= 0, `fixture text must contain ${exact}`);
  return { kind: "message", messageId, blockOrdinal, startOffset, endOffset: startOffset + exact.length, exact };
}

test("creating a selection persists only the anchor record and never starts AI work", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);

  const key = randomUUID();
  const anchor = anchorForSelection(assistantMessage.id, 1, "选区如何连接阅读与研究");
  const createResponse = await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, { anchor }, key);
  assert.equal(createResponse.status, 201);
  const accepted = await createResponse.json() as {
    selection: { id: string; text: string; status: string; anchor: { prefix?: string; suffix?: string } };
    task?: unknown;
  };
  assert.equal(accepted.selection.text, "选区如何连接阅读与研究");
  assert.equal(accepted.selection.status, "active");
  assert.equal(accepted.task, undefined);
  assert.ok(accepted.selection.anchor.prefix || accepted.selection.anchor.suffix);

  const listed = await (await fetch(`${harness.base}/v1/research-sessions/${session.id}/selections`, { headers: headers(harness.token) })).json() as Array<{ id: string }>;
  assert.deepEqual(listed.map((item) => item.id), [accepted.selection.id]);

  const database = new DatabaseSync(harness.store.getDataFilePath(), { readOnly: true });
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name));
  assert.ok(!tables.includes("research_selection_tasks"));
  assert.ok(!tables.includes("research_selection_task_events"));
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM model_calls").get() as { count: number }).count, 0);
  const row = database.prepare("SELECT idempotency_key AS key FROM research_selections WHERE id = ?").get(accepted.selection.id) as { key: string };
  assert.equal(row.key, key);
  database.close();

  assert.equal((await fetch(`${harness.base}/v1/research-selection-tasks/retired`, { headers: headers(harness.token) })).status, 404);
  assert.equal((await fetch(`${harness.base}/v1/research-selection-tasks/retired/events`, { headers: headers(harness.token) })).status, 404);
  assert.equal((await postJson(harness.base, harness.token, "/v1/research-selection-tasks/retired/retry", {})).status, 404);
});

test("selection creation is idempotent without a task row", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const key = randomUUID();
  const anchor = anchorForSelection(assistantMessage.id, 1, "实践建议");

  const first = await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, { anchor }, key);
  const second = await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, { anchor }, key);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const firstAccepted = await first.json() as { selection: { id: string } };
  const secondAccepted = await second.json() as { selection: { id: string } };
  assert.equal(secondAccepted.selection.id, firstAccepted.selection.id);
  assert.equal(harness.store.listResearchSelections(session.id).length, 1);
});

test("server self-heals stale offsets and degrades unresolvable anchors honestly", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const exact = "选区如何连接阅读与研究";
  const block = deriveMessageBlocks(ASSISTANT_CONTENT)[1];
  const start = block.text.indexOf(exact);

  const healedResponse = await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, {
    anchor: {
      kind: "message", messageId: assistantMessage.id, blockOrdinal: 1,
      startOffset: start + 2, endOffset: start + 2 + exact.length, exact,
      prefix: block.text.slice(Math.max(0, start - 6), start),
    },
  }, randomUUID());
  const healed = await healedResponse.json() as { selection: { status: string; anchor: { startOffset: number; endOffset: number } } };
  assert.equal(healed.selection.status, "active");
  assert.equal(healed.selection.anchor.startOffset, start);
  assert.equal(healed.selection.anchor.endOffset, start + exact.length);

  const staleResponse = await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, {
    anchor: { kind: "message", messageId: assistantMessage.id, blockOrdinal: 0, startOffset: 0, endOffset: 12, exact: "这段文字根本不在块内" },
  }, randomUUID());
  const stale = await staleResponse.json() as { selection: { status: string; text: string } };
  assert.equal(stale.selection.status, "stale");
  assert.equal(stale.selection.text, "这段文字根本不在块内");
});

test("selection validation rejects malformed and cross-session anchors", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { session, assistantMessage } = await createSessionWithAnswer(harness);
  const otherSessionResponse = await postJson(harness.base, harness.token, "/v1/research-sessions", {}, randomUUID());
  const otherSession = await otherSessionResponse.json() as { id: string };

  assert.equal((await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, { anchor: { kind: "dom" } }, randomUUID())).status, 400);
  assert.equal((await postJson(harness.base, harness.token, `/v1/research-sessions/${otherSession.id}/selections`, {
    anchor: anchorForSelection(assistantMessage.id, 0, "本地优先研究"),
  }, randomUUID())).status, 404);
  assert.equal((await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, {
    anchor: anchorForSelection(assistantMessage.id, 0, "本地优先研究"),
  })).status, 400);
});

test("complex Markdown selection records one versioned source and visible range and never jumps to repeated text", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const content = "**重复文本**与重复文本。\n\n| 列 | 值 |\n| --- | --- |\n| A | `code` |";
  const { session, assistantMessage } = await createSessionWithAnswer(harness, content);
  const secondSourceStart = content.indexOf("重复文本", content.indexOf("重复文本") + 4);

  const response = await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, {
    // Browser offsets are in the projected block: the second occurrence starts after "重复文本与".
    anchor: { kind: "message", messageId: assistantMessage.id, blockOrdinal: 0, startOffset: 5, endOffset: 9, exact: "重复文本" },
  }, randomUUID());
  assert.equal(response.status, 201);
  const accepted = await response.json() as {
    selection: {
      status: string;
      anchor: {
        startOffset: number;
        endOffset: number;
        location: {
          contentId: string;
          bodyVersionId: string;
          sourceRange: { startOffset: number; endOffset: number };
          visibleRange: { startOffset: number; endOffset: number };
          exact: string;
        };
      };
    };
  };
  assert.equal(accepted.selection.status, "active");
  assert.deepEqual(accepted.selection.anchor.location.sourceRange, {
    startOffset: secondSourceStart,
    endOffset: secondSourceStart + 4,
  });
  assert.deepEqual(accepted.selection.anchor.location.visibleRange, { startOffset: 5, endOffset: 9 });
  assert.equal(accepted.selection.anchor.location.contentId, assistantMessage.id);
  assert.equal(accepted.selection.anchor.location.bodyVersionId, `body:${assistantMessage.id}:${hashBodyContent(content)}`);

  const firstSourceStart = content.indexOf("重复文本");
  const forged = await postJson(harness.base, harness.token, `/v1/research-sessions/${session.id}/selections`, {
    anchor: {
      kind: "message",
      messageId: assistantMessage.id,
      blockOrdinal: 0,
      startOffset: 5,
      endOffset: 9,
      exact: "重复文本",
      location: {
        contentId: assistantMessage.id,
        bodyVersionId: `body:${assistantMessage.id}:${hashBodyContent(content)}`,
        sourceRange: { startOffset: firstSourceStart, endOffset: firstSourceStart + 4 },
        visibleRange: { startOffset: 5, endOffset: 9 },
        exact: "重复文本",
      },
    },
  }, randomUUID());
  assert.equal(forged.status, 201);
  assert.equal((await forged.json() as { selection: { status: string } }).selection.status, "stale");
});
