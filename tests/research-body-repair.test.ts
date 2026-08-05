import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelProviderHttpError, ModelProviderTimeoutError } from "@collector/model-gateway";
import { CaptureService, SqliteStore } from "@collector/api";

const NOW = "2026-08-05T00:00:00.000Z";

interface SectionCall {
  sectionIndex: number;
  continuation?: { priorSectionContent: string };
  repairHint?: string;
  targetCharsOverride?: number;
}

/**
 * 可编程的 plan-then-write 假 provider：generateOutline 固定返回两节长文大纲；
 * expandSection 由 script 逐次编程（返回值或抛错）。deriveAnnotations 缺省（走提示注入降级）。
 */
function makeProvider(opts: {
  outlineFails?: boolean;
  expandScript: Array<(call: SectionCall) => { content: string; finishReason?: string } | never>;
  expandCalls: SectionCall[];
}): Record<string, unknown> {
  return {
    provider: "fake",
    model: "fake-1",
    promptVersion: "test",
    async *generate() { yield "unused"; },
    // writeBody 存在以走自由正文分支（plan-then-write 判定的前置）；长文判定命中后不被调用。
    async writeBody() { return "短正文（长文路径不应调用此）。"; },
    async generateOutline() {
      if (opts.outlineFails) throw new ModelProviderHttpError("outline boom (HTTP 500)", 500);
      return { sections: [
        { heading: "起源", summary: "概念起源", targetChars: 600 },
        { heading: "实践", summary: "落地方式", targetChars: 800 },
      ] };
    },
    async expandSection(request: SectionCall) {
      opts.expandCalls.push(request);
      const next = opts.expandScript.shift();
      if (!next) throw new Error("expandSection called more than scripted");
      return next(request);
    },
  };
}

async function makeService(t: test.TestContext, provider: Record<string, unknown>, sleeps?: number[]): Promise<{ store: SqliteStore; service: CaptureService; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "collector-bodyrepair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  await store.createResearchSession({ id: "session-1", title: "T", status: "active", createdAt: NOW, updatedAt: NOW }, "k-s");
  await store.createResearchNode({ id: "node-1", sessionId: "session-1", status: "active", createdAt: NOW, updatedAt: NOW }, "k-n");
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, {
    autoRunRecentOrganization: false,
    researchProvider: provider as never,
    // 注入确定性 retrySleep：记录退避序列、不真实等待。
    researchRetrySleep: async (ms) => { sleeps?.push(ms); },
  });
  return { store, service, root };
}

async function runToCompletion(store: SqliteStore, service: CaptureService, key: string): Promise<{ taskId: string; outputMessageId: string; status: string }> {
  const accepted = await service.research.submitMessage("session-1", "写一篇 3000 字的长文", key);
  for (let i = 0; i < 200; i++) {
    const task = store.getResearchTask(accepted.task.id);
    if (task && (task.status === "completed" || task.status === "failed")) return { taskId: task.id, outputMessageId: accepted.outputMessage.id, status: task.status };
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("task did not settle");
}

test("两节一次成功：每节恰一次 expand 调用，正文完整拼接", async (t) => {
  const expandCalls: SectionCall[] = [];
  const provider = makeProvider({
    expandCalls,
    expandScript: [
      () => ({ content: "第一节正文，论述起源。", finishReason: "stop" }),
      () => ({ content: "第二节正文，论述实践。", finishReason: "stop" }),
    ],
  });
  const { store, service } = await makeService(t, provider);
  const { outputMessageId, status } = await runToCompletion(store, service, "k-ok");
  assert.equal(status, "completed");
  assert.equal(expandCalls.length, 2, "两节各一次调用");
  assert.equal(expandCalls[0]?.sectionIndex, 0);
  assert.equal(expandCalls[1]?.sectionIndex, 1);
  const content = store.getResearchMessage(outputMessageId)!.content;
  assert.ok(content.includes("第一节正文，论述起源。"));
  assert.ok(content.includes("第二节正文，论述实践。"));
  assert.ok(!content.includes("[本节生成失败"), "成功路径无失败标记");
  store.close();
});

test("单节截断续写一次成功：恰两次调用、第二次带 continuation 断点", async (t) => {
  const expandCalls: SectionCall[] = [];
  const provider = makeProvider({
    expandCalls,
    expandScript: [
      // 第一节：先截断（length），后续写完成。
      () => ({ content: "第一节正文被截断在中途", finishReason: "length" }),
      (call) => ({ content: "，续写补全第一节。", finishReason: "stop" }),
      () => ({ content: "第二节正文。", finishReason: "stop" }),
    ],
  });
  const { store, service } = await makeService(t, provider);
  const { outputMessageId, status } = await runToCompletion(store, service, "k-trunc");
  assert.equal(status, "completed");
  // 第一节两次（截断+续写），第二节一次。
  assert.equal(expandCalls.length, 3);
  assert.equal(expandCalls[1]?.sectionIndex, 0, "第二次调用仍是第一节（续写）");
  assert.ok(expandCalls[1]?.continuation?.priorSectionContent.includes("第一节正文被截断在中途"), "续写携带断点前文");
  const content = store.getResearchMessage(outputMessageId)!.content;
  assert.ok(content.includes("第一节正文被截断在中途"));
  assert.ok(content.includes("续写补全第一节"));
  assert.ok(!content.includes("[本节生成失败"));
  store.close();
});

test("空节重问两次仍空 → 节失败写标记、不静默丢、另一节完整", async (t) => {
  const expandCalls: SectionCall[] = [];
  const provider = makeProvider({
    expandCalls,
    expandScript: [
      () => ({ content: "   ", finishReason: "stop" }), // 空 1
      () => ({ content: "", finishReason: "stop" }),    // 空 2
      () => ({ content: "", finishReason: "stop" }),    // 空 3（超 MAX_EMPTY_REASKS=2）→ 进降级
      () => ({ content: "", finishReason: "stop" }),    // 降级重试仍空 → 节失败
      () => ({ content: "第二节完整正文。", finishReason: "stop" }),
    ],
  });
  const { store, service } = await makeService(t, provider);
  const { outputMessageId, status } = await runToCompletion(store, service, "k-empty");
  assert.equal(status, "completed", "一节失败不整任务失败");
  const content = store.getResearchMessage(outputMessageId)!.content;
  assert.ok(content.includes("[本节生成失败：起源]"), "失败节写入显式标记（不静默丢节）");
  assert.ok(content.includes("第二节完整正文。"), "另一节完整保留");
  store.close();
});

test("429 可重试退避序列后成功；retrySleep 记录递增退避", async (t) => {
  const expandCalls: SectionCall[] = [];
  const sleeps: number[] = [];
  let firstSectionCalls = 0;
  const provider = makeProvider({
    expandCalls,
    expandScript: [
      () => { firstSectionCalls += 1; throw new ModelProviderHttpError("rate limited (HTTP 429)", 429); },
      () => { firstSectionCalls += 1; throw new ModelProviderHttpError("rate limited (HTTP 429)", 429); },
      () => ({ content: "第一节正文。", finishReason: "stop" }),
      () => ({ content: "第二节正文。", finishReason: "stop" }),
    ],
  });
  const { store, service } = await makeService(t, provider, sleeps);
  const { status } = await runToCompletion(store, service, "k-429");
  assert.equal(status, "completed");
  assert.equal(firstSectionCalls, 2, "第一节前两次 429");
  assert.equal(sleeps.length, 2, "两次退避等待");
  assert.ok(sleeps[1]! > sleeps[0]!, "退避递增");
  store.close();
});

test("400 致命错误跳过重试直接进降级，降级仍败 → 节失败", async (t) => {
  const expandCalls: SectionCall[] = [];
  const sleeps: number[] = [];
  const provider = makeProvider({
    expandCalls,
    expandScript: [
      () => { throw new ModelProviderHttpError("bad request (HTTP 400)", 400); },
      () => { throw new ModelProviderHttpError("bad request (HTTP 400)", 400); }, // 降级重试也 400
      () => ({ content: "第二节正文。", finishReason: "stop" }),
    ],
  });
  const { store, service } = await makeService(t, provider, sleeps);
  const { outputMessageId, status } = await runToCompletion(store, service, "k-400");
  assert.equal(status, "completed");
  assert.equal(sleeps.length, 0, "400 致命：不退避重试");
  const content = store.getResearchMessage(outputMessageId)!.content;
  assert.ok(content.includes("[本节生成失败：起源]"));
  assert.ok(content.includes("第二节正文。"));
  store.close();
});

test("空闲超时属可重试类，退避后重试成功", async (t) => {
  const expandCalls: SectionCall[] = [];
  const sleeps: number[] = [];
  const provider = makeProvider({
    expandCalls,
    expandScript: [
      () => { throw new ModelProviderTimeoutError("stream idle timed out"); },
      () => ({ content: "第一节正文。", finishReason: "stop" }),
      () => ({ content: "第二节正文。", finishReason: "stop" }),
    ],
  });
  const { store, service } = await makeService(t, provider, sleeps);
  const { status } = await runToCompletion(store, service, "k-timeout");
  assert.equal(status, "completed");
  assert.equal(sleeps.length, 1, "超时退避一次后重试");
  store.close();
});

test("大纲生成失败降级回退单轮 writeBody，任务仍完成", async (t) => {
  const expandCalls: SectionCall[] = [];
  const provider = {
    ...makeProvider({ outlineFails: true, expandCalls, expandScript: [] }),
    async writeBody() { return "单轮回退写出的完整正文。"; },
  };
  const { store, service } = await makeService(t, provider);
  const { outputMessageId, status } = await runToCompletion(store, service, "k-outline-fail");
  assert.equal(status, "completed");
  assert.equal(expandCalls.length, 0, "大纲失败不再逐节扩写");
  assert.equal(store.getResearchMessage(outputMessageId)!.content, "单轮回退写出的完整正文。");
  store.close();
});

test("续写完成派生新版本、旧版本行不变（正文唯一事实源 + 版本哈希）", async (t) => {
  const expandCalls: SectionCall[] = [];
  const provider = makeProvider({
    expandCalls,
    expandScript: [
      () => ({ content: "第一节截断在中途", finishReason: "length" }),
      () => ({ content: "，续写完成第一节。", finishReason: "stop" }),
      () => ({ content: "第二节正文。", finishReason: "stop" }),
    ],
  });
  const { store, service } = await makeService(t, provider);
  const { outputMessageId, status } = await runToCompletion(store, service, "k-version");
  assert.equal(status, "completed");
  const version = store.getBodyVersionForMessage(outputMessageId);
  assert.ok(version, "完成派生正文版本");
  assert.equal(version.content, store.getResearchMessage(outputMessageId)!.content, "版本哈希自最终正文");
  store.close();
});
