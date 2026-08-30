import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CaptureService, LocalAuth, SqliteStore, createApiServer } from "@collector/api";
import type { ResearchChapterTaskRecord } from "@collector/capture-contracts";
import { listenOnFetchSafePort } from "./test-http-server.js";

function longText(): string {
  return Array.from(
    { length: 12 },
    (_, index) => `第${index + 1}段开头句。${`这是第${index + 1}段用于验证导入章节解析异步管线与规则锚点降级的确定性正文。`.repeat(18)}`,
  ).join("\n\n");
}

function shortText(): string {
  return "短文内容，不触发章节解析。";
}

/** 确定性假章节供应商：按 [Bn] 编号取首/中/尾三块作为章节起点。 */
function fakeChapterProvider(behavior: "valid" | "fail" | "invalid" = "valid") {
  return {
    provider: "test-fake",
    model: "fake-chapter-e2e",
    async parseImportChapters(request: { taskId: string; content: string }) {
      assert.ok(request.taskId);
      if (behavior === "fail") throw new Error("provider temporarily down");
      if (behavior === "invalid") return "definitely-not-json";
      const blocks = [...request.content.matchAll(/\[B(\d+)\]/g)].map((match) => Number(match[1]));
      assert.ok(blocks.length >= 3);
      const picked = [...new Set([blocks[0], blocks[Math.floor(blocks.length / 2)], blocks[blocks.length - 1]])];
      return JSON.stringify({ chapters: picked.map((block, index) => ({ block, title: `章节${index + 1}` })) });
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function createHarness(options: {
  autoRunResearchImports?: boolean;
  autoRunResearchChapters?: boolean;
  chapterParseProvider?: ReturnType<typeof fakeChapterProvider>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "collector-chapters-"));
  const databasePath = join(root, "collector.sqlite");
  const artifactRoot = join(root, "artifacts");
  const store = new SqliteStore(databasePath);
  await store.init();
  const auth = new LocalAuth(store);
  const token = `chapters-${randomUUID()}`;
  await auth.registerTrustedToken(token, "research-chapters-test");
  const service = new CaptureService(store, artifactRoot, undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
    autoRunResearchImports: options.autoRunResearchImports,
    autoRunResearchChapters: options.autoRunResearchChapters,
    ...(options.chapterParseProvider ? { chapterParseProvider: options.chapterParseProvider } : {}),
  });
  const server = createApiServer(service, auth);
  await listenOnFetchSafePort(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return {
    root, databasePath, artifactRoot, store, service, token,
    base: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
    async closeKeepData() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

function headers(token: string, key?: string, fileName?: string, contentType = "application/json") {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": contentType,
    ...(key ? { "Idempotency-Key": key } : {}),
    ...(fileName ? { "X-File-Name": encodeURIComponent(fileName) } : {}),
  };
}

async function createSession(base: string, token: string) {
  const response = await fetch(`${base}/v1/research-sessions`, {
    method: "POST", headers: headers(token, randomUUID()), body: "{}",
  });
  assert.equal(response.status, 201);
  return response.json() as Promise<{ id: string }>;
}

async function upload(base: string, token: string, sessionId: string, key: string, text: string) {
  return fetch(`${base}/v1/research-sessions/${sessionId}/imports`, {
    method: "POST", headers: headers(token, key, "article.txt", "text/plain"), body: Buffer.from(text, "utf8"),
  });
}

async function waitForImport(base: string, token: string, taskId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${base}/v1/research-imports/${taskId}`, { headers: headers(token) });
    assert.equal(response.status, 200);
    const task = await response.json() as { status: string; [key: string]: unknown };
    if (task.status === "completed") return;
    await sleep(10);
  }
  throw new Error("Research import did not complete");
}

async function waitForChapterTask(store: SqliteStore, snapshotId: string, label: string, predicate: (task: ResearchChapterTaskRecord) => boolean = () => true) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = store.getResearchChapterTaskBySnapshot(snapshotId);
    if (task && predicate(task)) return task;
    await sleep(10);
  }
  throw new Error(`Chapter task did not reach ${label}`);
}

async function importLongArticle(harness: { base: string; token: string; store: SqliteStore }, sessionId: string, key: string) {
  const response = await upload(harness.base, harness.token, sessionId, key, longText());
  assert.equal(response.status, 202);
  const accepted = await response.json() as { task: { id: string }; attachment: { id: string; contentSnapshotId?: string } };
  await waitForImport(harness.base, harness.token, accepted.task.id);
  const attachment = harness.store.getResearchAttachment(accepted.attachment.id)!;
  const snapshot = harness.store.getResearchContentSnapshot(attachment.contentSnapshotId!)!;
  return { attachment, snapshot };
}

test("导入长文：AI 章节解析异步完成、幂等不重复、HTTP 视图与运行记录留痕", async (t) => {
  const harness = await createHarness({ chapterParseProvider: fakeChapterProvider("valid") });
  t.after(() => harness.close());
  const session = await createSession(harness.base, harness.token);
  const { snapshot } = await importLongArticle(harness, session.id, "ai-key");

  const task = await waitForChapterTask(harness.store, snapshot.id, "completed");
  assert.equal(task.status, "completed");
  assert.equal(task.source, "ai");
  assert.equal(task.fallbackReason, undefined);
  assert.equal(task.retryable, false);
  assert.ok(task.chapters.length >= 2);
  const ordinals = task.chapters.map((chapter) => chapter.blockOrdinal);
  assert.deepEqual(ordinals, [...ordinals].sort((a, b) => a - b));
  assert.ok(ordinals.every((blockOrdinal) => blockOrdinal >= 0 && blockOrdinal < snapshot.blocks.length));
  assert.ok(task.chapters.every((chapter) => chapter.title === "章节1" || chapter.title === "章节2" || chapter.title === "章节3"));
  for (const chapter of task.chapters) {
    const block = snapshot.blocks[chapter.blockOrdinal]!;
    assert.deepEqual(chapter.location, {
      contentId: block.id,
      bodyVersionId: snapshot.id,
      sourceRange: { startOffset: 0, endOffset: block.text.length },
      exact: block.text,
    });
  }

  // 幂等：重复触发不产生重复任务（快照唯一约束），任务 ID 不变。
  harness.service.researchChapters.enqueueForSnapshot(snapshot);
  await sleep(30);
  const again = harness.store.getResearchChapterTaskBySnapshot(snapshot.id)!;
  assert.equal(again.id, task.id);
  assert.equal(again.chapters.length, task.chapters.length);

  // HTTP 阅读视图携带章节解析状态；AI 成功后重试被 409 拒绝。
  const viewResponse = await fetch(`${harness.base}/v1/research-content/${snapshot.id}`, { headers: headers(harness.token) });
  assert.equal(viewResponse.status, 200);
  const view = await viewResponse.json() as { chapterParse?: { source?: string; chapters: unknown[]; retryable: boolean } };
  assert.equal(view.chapterParse?.source, "ai");
  assert.deepEqual(view.chapterParse?.chapters, task.chapters);
  const retryResponse = await fetch(`${harness.base}/v1/research-content/${snapshot.id}/chapters/retry`, { method: "POST", headers: headers(harness.token) });
  assert.equal(retryResponse.status, 409);

  // 运行记录：章节解析任务作为独立运行行留痕（operationType chapter_parse）。
  const rows = harness.store.listRunRecordRows({ limit: 50 });
  const chapterRow = rows.find((row) => row.source === "chapter" && row.id === task.id);
  assert.ok(chapterRow, "chapter task must appear in run record rows");
  assert.equal(chapterRow.operationType, "chapter_parse");
  assert.equal(chapterRow.status, "completed");
});

test("无可用模型：长文获得规则锚点、导航可用、状态诚实且可重试", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const session = await createSession(harness.base, harness.token);
  const { snapshot } = await importLongArticle(harness, session.id, "no-model-key");

  const task = await waitForChapterTask(harness.store, snapshot.id, "completed");
  assert.equal(task.status, "completed");
  assert.equal(task.source, "rule");
  assert.equal(task.fallbackReason, "no_model");
  assert.equal(task.retryable, true);
  assert.equal(task.error, undefined);
  assert.ok(task.chapters.length >= 2);
  assert.match(task.chapters[0].title, /第1段开头句/);

  const viewResponse = await fetch(`${harness.base}/v1/research-content/${snapshot.id}`, { headers: headers(harness.token) });
  const view = await viewResponse.json() as { chapterParse?: { source?: string; fallbackReason?: string; retryable: boolean; chapters: unknown[] } };
  assert.equal(view.chapterParse?.source, "rule");
  assert.equal(view.chapterParse?.fallbackReason, "no_model");
  assert.equal(view.chapterParse?.retryable, true);
  assert.deepEqual(view.chapterParse?.chapters, task.chapters);

  // 无模型重试：仍走规则降级且不发起任何外部调用，任务回到完成态。
  const retryResponse = await fetch(`${harness.base}/v1/research-content/${snapshot.id}/chapters/retry`, { method: "POST", headers: headers(harness.token) });
  assert.equal(retryResponse.status, 202);
  const retried = await waitForChapterTask(harness.store, snapshot.id, "completed after retry");
  assert.equal(retried.source, "rule");
  assert.equal(retried.fallbackReason, "no_model");
});

test("AI 解析失败：正文不破坏、退化为规则锚点、重试成功后替换为 AI 章节", async (t) => {
  const harness = await createHarness({ chapterParseProvider: fakeChapterProvider("fail") });
  t.after(() => harness.close());
  const session = await createSession(harness.base, harness.token);
  const { snapshot } = await importLongArticle(harness, session.id, "fail-key");

  const failed = await waitForChapterTask(harness.store, snapshot.id, "failed");
  assert.equal(failed.status, "failed");
  assert.equal(failed.source, "rule");
  assert.equal(failed.fallbackReason, "ai_failed");
  assert.equal(failed.retryable, true);
  assert.equal(failed.error?.code, "provider_error");
  assert.ok(failed.chapters.length >= 2);

  // 正文始终可读：快照与块在失败路径上一字不动。
  const viewResponse = await fetch(`${harness.base}/v1/research-content/${snapshot.id}`, { headers: headers(harness.token) });
  assert.equal(viewResponse.status, 200);
  const view = await viewResponse.json() as { blocks: unknown[]; chapterParse?: { source?: string; status: string } };
  assert.ok(view.blocks.length >= 2);
  assert.equal(view.chapterParse?.source, "rule");
  assert.equal(view.chapterParse?.status, "failed");

  // 供应商恢复后重试：AI 章节原子替换规则锚点，无重复。
  harness.service.researchChapters.setProvider(fakeChapterProvider("valid"));
  const retryResponse = await fetch(`${harness.base}/v1/research-content/${snapshot.id}/chapters/retry`, { method: "POST", headers: headers(harness.token) });
  assert.equal(retryResponse.status, 202);
  const recovered = await waitForChapterTask(harness.store, snapshot.id, "completed with ai", (task) => task.status === "completed" && task.source === "ai");
  assert.equal(recovered.fallbackReason, undefined);
  assert.equal(recovered.retryable, false);
  assert.deepEqual(recovered.chapters.map((chapter) => chapter.title), ["章节1", "章节2", "章节3"]);
});

test("AI 输出不合契约：退化为规则锚点并诚实留痕", async (t) => {
  const harness = await createHarness({ chapterParseProvider: fakeChapterProvider("invalid") });
  t.after(() => harness.close());
  const session = await createSession(harness.base, harness.token);
  const { snapshot } = await importLongArticle(harness, session.id, "invalid-key");

  const failed = await waitForChapterTask(harness.store, snapshot.id, "failed");
  assert.equal(failed.status, "failed");
  assert.equal(failed.source, "rule");
  assert.equal(failed.fallbackReason, "ai_invalid");
  assert.equal(failed.error?.code, "invalid_output");
  assert.ok(failed.chapters.length >= 2);
});

test("短于阈值的导入内容不触发章节解析", async (t) => {
  const harness = await createHarness({ chapterParseProvider: fakeChapterProvider("valid") });
  t.after(() => harness.close());
  const session = await createSession(harness.base, harness.token);
  const response = await upload(harness.base, harness.token, session.id, "short-key", shortText());
  assert.equal(response.status, 202);
  const accepted = await response.json() as { task: { id: string }; attachment: { id: string } };
  await waitForImport(harness.base, harness.token, accepted.task.id);
  const attachment = harness.store.getResearchAttachment(accepted.attachment.id)!;
  const snapshot = harness.store.getResearchContentSnapshot(attachment.contentSnapshotId!)!;
  await sleep(50);
  assert.equal(harness.store.getResearchChapterTaskBySnapshot(snapshot.id), undefined);
  const viewResponse = await fetch(`${harness.base}/v1/research-content/${snapshot.id}`, { headers: headers(harness.token) });
  const view = await viewResponse.json() as { chapterParse?: unknown };
  assert.equal(view.chapterParse, undefined);
});

test("回收站会话不再入队章节解析；会话删除级联清理章节任务", async (t) => {
  const harness = await createHarness({ autoRunResearchChapters: false });
  t.after(() => harness.close());
  const session = await createSession(harness.base, harness.token);
  const { snapshot } = await importLongArticle(harness, session.id, "trash-key");
  // autoRunResearchChapters=false：任务已创建但未执行。
  const created = harness.store.getResearchChapterTaskBySnapshot(snapshot.id);
  assert.ok(created && created.status === "queued");

  // 回收站守卫：快照所属会话已进回收站时，重复触发不再创建或推进章节任务。
  await harness.store.trashResearchSession(session.id, new Date().toISOString());
  harness.service.researchChapters.enqueueForSnapshot(snapshot);
  await sleep(30);
  const afterTrash = harness.store.getResearchChapterTaskBySnapshot(snapshot.id)!;
  assert.equal(afterTrash.id, created.id);
  assert.equal(afterTrash.status, "queued");
  assert.equal(afterTrash.attempts, 0);

  // 彻底删除会话时级联清理章节任务。
  await harness.store.deleteResearchSession(session.id);
  assert.equal(harness.store.getResearchChapterTaskBySnapshot(snapshot.id), undefined);

  // 回收站会话的重试请求被 409 拒绝（诚实不可重试，不产生永远排队的新任务）。
  const trashed = await createSession(harness.base, harness.token);
  const imported = await importLongArticle(harness, trashed.id, "trash-retry-key");
  await harness.store.trashResearchSession(trashed.id, new Date().toISOString());
  const retryResponse = await fetch(`${harness.base}/v1/research-content/${imported.snapshot.id}/chapters/retry`, { method: "POST", headers: headers(harness.token) });
  assert.equal(retryResponse.status, 409);
});

test("快照缺失的章节任务永久失败且不可重试", async (t) => {
  const harness = await createHarness({ autoRunResearchChapters: false });
  t.after(() => harness.close());
  const session = await createSession(harness.base, harness.token);
  const now = new Date().toISOString();
  const record: ResearchChapterTaskRecord = {
    id: randomUUID(),
    sessionId: session.id,
    snapshotId: randomUUID(),
    title: "ghost.txt",
    status: "queued",
    retryable: false,
    chapters: [],
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  await harness.store.createResearchChapterTask(record);
  await harness.service.researchChapters.processTask(record.id);
  const task = harness.store.getResearchChapterTask(record.id)!;
  assert.equal(task.status, "failed");
  assert.equal(task.retryable, false);
  assert.equal(task.error?.code, "snapshot_missing");
  assert.deepEqual(task.chapters, []);
});

test("重启恢复：running 回排队、queued 重跑，状态一致且无重复锚点", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-chapters-recovery-"));
  const databasePath = join(root, "collector.sqlite");
  const artifactRoot = join(root, "artifacts");

  // 第一进程：导入完成即落快照；章节任务只入队不执行。
  const storeA = new SqliteStore(databasePath);
  await storeA.init();
  const authA = new LocalAuth(storeA);
  const tokenA = `recovery-a-${randomUUID()}`;
  await authA.registerTrustedToken(tokenA, "recovery-a");
  const serviceA = new CaptureService(storeA, artifactRoot, undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
    autoRunResearchImports: true,
    autoRunResearchChapters: false,
  });
  const serverA = createApiServer(serviceA, authA);
  await new Promise<void>((resolve) => serverA.listen(0, "127.0.0.1", resolve));
  const addressA = serverA.address();
  if (!addressA || typeof addressA === "string") throw new Error("Server A did not bind");
  const baseA = `http://127.0.0.1:${addressA.port}`;
  const sessionA = await createSession(baseA, tokenA);
  const first = await importLongArticle({ base: baseA, token: tokenA, store: storeA }, sessionA.id, "recovery-1");
  const second = await importLongArticle({ base: baseA, token: tokenA, store: storeA }, sessionA.id, "recovery-2");
  const queuedFirst = storeA.getResearchChapterTaskBySnapshot(first.snapshot.id)!;
  const queuedSecond = storeA.getResearchChapterTaskBySnapshot(second.snapshot.id)!;
  assert.equal(queuedFirst.status, "queued");
  assert.equal(queuedSecond.status, "queued");
  // 模拟进程在模型调用进行中崩溃：第一条任务停留在 running。
  await storeA.updateResearchChapterTask({ ...queuedFirst, status: "running", attempts: 1, startedAt: new Date().toISOString() });

  await new Promise<void>((resolve) => serverA.close(() => resolve()));
  storeA.close();

  // 第二进程：同一数据目录重启，章节服务启动恢复。
  const storeB = new SqliteStore(databasePath);
  await storeB.init();
  const authB = new LocalAuth(storeB);
  const tokenB = `recovery-b-${randomUUID()}`;
  await authB.registerTrustedToken(tokenB, "recovery-b");
  const serviceB = new CaptureService(storeB, artifactRoot, undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
    autoRunResearchImports: false,
    autoRunResearchChapters: true,
  });
  t.after(async () => {
    storeB.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const waitFor = async (snapshotId: string) => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const task = storeB.getResearchChapterTaskBySnapshot(snapshotId);
      if (task && task.status === "completed") return task;
      await sleep(10);
    }
    throw new Error("chapter task did not recover");
  };
  const recoveredFirst = await waitFor(first.snapshot.id);
  const recoveredSecond = await waitFor(second.snapshot.id);
  assert.equal(recoveredFirst.source, "rule");
  assert.equal(recoveredFirst.fallbackReason, "no_model");
  assert.equal(recoveredSecond.source, "rule");
  assert.equal(recoveredSecond.fallbackReason, "no_model");
  // 每个快照仍只有一条任务、一组锚点（快照唯一约束即幂等），锚点全部落在既有块上。
  assert.ok(recoveredFirst.chapters.length >= 2);
  assert.ok(recoveredFirst.chapters.every((chapter) => chapter.blockOrdinal >= 0 && chapter.blockOrdinal < first.snapshot.blocks.length));
  assert.ok(recoveredSecond.chapters.length >= 2);
  assert.ok(recoveredSecond.chapters.every((chapter) => chapter.blockOrdinal >= 0 && chapter.blockOrdinal < second.snapshot.blocks.length));
  // 第一条任务从 running 回排队重跑，attempts 应随恢复执行累加。
  assert.ok(recoveredFirst.attempts >= 2);
});
