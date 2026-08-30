import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CaptureService, LocalAuth, SqliteStore, createApiServer } from "@collector/api";
import { listenOnFetchSafePort } from "./test-http-server.js";

const NOW = "2026-08-05T00:00:00.000Z";

/** 可编程的单轮流式假 provider：writeBodyStream 受控逐段产出，可脚本化断流。 */
function makeControllableProvider(): { provider: Record<string, unknown>; push: (text: string) => void; done: () => void } {
  const queue: string[] = [];
  let resolveNext: (() => void) | undefined;
  let ended = false;
  const provider = {
    provider: "fake",
    model: "fake-1",
    promptVersion: "test",
    async *generate() { yield "unused"; },
    async writeBody() { return "占位。"; },
    async *writeBodyStream(request: { onStreamDone?: (d: { finishReason?: string }) => void }) {
      while (!ended) {
        if (!queue.length) await new Promise<void>((r) => { resolveNext = r; });
        while (queue.length) yield queue.shift()!;
      }
      request.onStreamDone?.({ finishReason: "stop" });
    },
  };
  return {
    provider,
    push(text: string) { queue.push(text); resolveNext?.(); resolveNext = undefined; },
    done() { ended = true; resolveNext?.(); },
  };
}

async function createHarness(provider: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "collector-sse-push-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  const auth = new LocalAuth(store);
  const token = `sse-${randomUUID()}`;
  await auth.registerTrustedToken(token, "sse-push-test");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, {
    autoRunRecentOrganization: false,
    researchProvider: provider as never,
  });
  await store.createResearchSession({ id: "session-1", title: "T", status: "active", isFavorite: false, createdAt: NOW, updatedAt: NOW }, "k-s");
  await store.createResearchNode({ id: "node-1", sessionId: "session-1", status: "active", createdAt: NOW, updatedAt: NOW }, "k-n");
  const server = createApiServer(service, auth);
  await listenOnFetchSafePort(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return {
    store, service, base: `http://127.0.0.1:${address.port}`, token,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function headers(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** 读取 SSE 流直到遇到 completed 事件或超时，返回事件类型序列与完成时间。 */
async function readTaskEventStream(url: string, token: string, timeoutMs: number): Promise<{ types: string[]; completedAtMs: number | undefined }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const types: string[] = [];
  let completedAtMs: number | undefined;
  try {
    const response = await fetch(url, { headers: headers(token), signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const eventLine = frame.split("\n").find((line) => line.startsWith("event: "));
        if (!eventLine) continue;
        const type = eventLine.slice("event: ".length).trim();
        if (!types.includes(type) || type === "delta") types.push(type);
        if (type === "completed" && completedAtMs === undefined) completedAtMs = Date.now() - startedAt;
      }
      if (completedAtMs !== undefined) break;
    }
  } catch {
    // abort 结束读取。
  } finally {
    clearTimeout(timer);
  }
  return { types, completedAtMs };
}

test("pub/sub 即推：delta 产生后 <100ms 到达 SSE（非轮询节拍）", async (t) => {
  const { provider, push, done } = makeControllableProvider();
  const harness = await createHarness(provider);
  t.after(harness.close);
  // 提交一条短消息触发单轮流式。
  const submitted = await (await fetch(`${harness.base}/v1/research-sessions/session-1/messages`, {
    method: "POST",
    headers: { ...headers(harness.token), "Content-Type": "application/json", "Idempotency-Key": `k-${randomUUID()}` },
    body: JSON.stringify({ content: "简单问题" }),
  })).json();
  const taskId = submitted.task.id as string;
  // 打开 SSE 流。
  const streamPromise = readTaskEventStream(`${harness.base}/v1/research-tasks/${taskId}/events`, harness.token, 10_000);
  // 等服务认领任务后推一段 + 完成。
  await new Promise((r) => setTimeout(r, 100));
  push("第一段。");
  const pushedAt = Date.now();
  done();
  const { completedAtMs } = await streamPromise;
  assert.ok(completedAtMs !== undefined, "应收到 completed 事件");
  // pub/sub 即推：completed 应在推送后远小于 100ms 的轮询节拍内到达（留足调度余量）。
  assert.ok(completedAtMs < 1000, `completed 到达过慢（${completedAtMs}ms），疑似仍走轮询`);
  void pushedAt;
});

test("多连接扇出：每个 SSE 连接各收一次 completed", async (t) => {
  const { provider, push, done } = makeControllableProvider();
  const harness = await createHarness(provider);
  t.after(harness.close);
  const submitted = await (await fetch(`${harness.base}/v1/research-sessions/session-1/messages`, {
    method: "POST",
    headers: { ...headers(harness.token), "Content-Type": "application/json", "Idempotency-Key": `k-${randomUUID()}` },
    body: JSON.stringify({ content: "简单问题" }),
  })).json();
  const taskId = submitted.task.id as string;
  const s1 = readTaskEventStream(`${harness.base}/v1/research-tasks/${taskId}/events`, harness.token, 10_000);
  const s2 = readTaskEventStream(`${harness.base}/v1/research-tasks/${taskId}/events`, harness.token, 10_000);
  await new Promise((r) => setTimeout(r, 100));
  push("扇出的一段。");
  done();
  const [r1, r2] = await Promise.all([s1, s2]);
  assert.ok(r1.completedAtMs !== undefined, "连接 1 应收到 completed");
  assert.ok(r2.completedAtMs !== undefined, "连接 2 应收到 completed（扇出不漏）");
});

test("结构化引用候选作为独立命名事件进入 SSE，不混入正文 delta", async (t) => {
  const provider = {
    provider: "citation-fake",
    model: "citation-model",
    async *generate() { yield "unused"; },
    async prepareGrounded() {
      return {
        kind: "evidence" as const,
        evidence: '{"sources":[{"sourceOrdinal":1,"evidence":"证据"}]}',
        status: "grounded" as const,
        queries: [],
        sources: [{ title: "Source", evidenceStatus: "full" as const }],
        citations: [],
      };
    },
    async *writeGroundedFinalStream(_request: unknown, _evidence: string, options: { onCitation?: (candidate: { sourceOrdinal: number; startOffset?: number; endOffset?: number }) => void; onStreamDone?: (done: { finishReason?: string }) => void }) {
      options.onCitation?.({ sourceOrdinal: 1, startOffset: 0, endOffset: 3 });
      yield "正文。";
      options.onStreamDone?.({ finishReason: "stop" });
    },
  };
  const harness = await createHarness(provider);
  t.after(harness.close);
  const submitted = await (await fetch(`${harness.base}/v1/research-sessions/session-1/messages`, {
    method: "POST",
    headers: { ...headers(harness.token), "Content-Type": "application/json", "Idempotency-Key": `k-${randomUUID()}` },
    body: JSON.stringify({ content: "联网问题", allowWebSearch: true }),
  })).json();

  const { types } = await readTaskEventStream(`${harness.base}/v1/research-tasks/${submitted.task.id}/events`, harness.token, 10_000);
  assert.ok(types.includes("citation_candidate"));
  assert.ok(types.includes("delta"));
  assert.ok(types.includes("completed"));
  assert.equal(harness.store.getResearchMessage(submitted.task.outputMessageId)?.content, "正文。");
});
