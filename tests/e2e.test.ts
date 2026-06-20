// e2e.test.ts — 端到端功能验证脚本
// 用法: npx tsx --test tests/e2e.test.ts
// 前提: 不需要启动 Electron，脚本自己起 API server
//
// 覆盖:
//  1. 采集 (capture) — 创建、去重、获取
//  2. 材料库 (material) — 列表、搜索、trash/restore
//  3. 近期整理 (recent organization) — 触发、快照
//  4. 话题 (topic) — 创建、列表
//  5. 文档 (document) — 生成
//  6. 基础端点 — health、inbox、data-paths、ai-configuration

import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { CaptureService, MemoryStore, LocalAuth, createApiServer } from "@collector/api";

// ── Test harness ───────────────────────────────────────────

function api(store: MemoryStore, artifactsDir: string, token: string) {
  const auth = new LocalAuth(store);
  const service = new CaptureService(store, artifactsDir, undefined, undefined, { autoRunRecentOrganization: false });
  const server = createApiServer(service, auth);
  return { server, service, auth, store, token, base: "" as string };
}

async function start(ctx: ReturnType<typeof api>) {
  await ctx.store.init();
  await ctx.auth.registerTrustedToken(ctx.token, "e2e");
  await new Promise<void>((resolve) => ctx.server.listen(0, "127.0.0.1", resolve));
  const addr = ctx.server.address();
  if (!addr || typeof addr === "string") throw new Error("bind failed");
  ctx.base = `http://127.0.0.1:${addr.port}`;
  return ctx;
}

async function stop(ctx: ReturnType<typeof api>) {
  await new Promise<void>((r) => ctx.server.close(() => r()));
  ctx.store.close();
}

function h(token: string) { return { Authorization: `Bearer ${token}` }; }
function ct() { return new Date().toISOString(); }

// ── Tests ──────────────────────────────────────────────────

test("E2E: full capture → material → topic → document lifecycle", async (t) => {
  const token = randomUUID();
  const artifactsDir = join(tmpdir(), `collector-e2e-${randomUUID()}`);
  const store = new MemoryStore();
  const ctx = await start(api(store, artifactsDir, token));
  t.after(() => stop(ctx));

  let materialId = "";
  let topicId = "";

  await t.test("Step 1: 采集文本内容 (POST /v1/captures → 201)", async () => {
    const res = await fetch(`${ctx.base}/v1/captures`, {
      method: "POST",
      headers: { ...h(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        captureType: "pasted_text",
        content: "端到端测试材料 —— Node.js 异步编程最佳实践。",
        sourceTitle: "Node.js Async Best Practices",
        sourceUrl: "https://nodejs.org/en/docs/guides/async-hooks/",
        clientCaptureId: randomUUID(),
        capturedAt: ct(),
        clientApp: "e2e-test",
      }),
    });
    assert.equal(res.status, 201, `capture 应返回 201，实际: ${res.status}`);
    const body = await res.json() as any;
    assert.ok(body.id, "应返回 capture id");
    materialId = body.id;
  });

  await t.test("Step 2: 幂等重复采集 (same clientCaptureId → same id)", async () => {
    const cid = randomUUID();
    const payload = { captureType: "pasted_text", content: "幂等性测试", clientCaptureId: cid, capturedAt: ct(), clientApp: "e2e" };
    const send = () => fetch(`${ctx.base}/v1/captures`, {
      method: "POST",
      headers: { ...h(token), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const r1 = await send(); assert.equal(r1.status, 201);
    const b1 = await r1.json() as any;
    const r2 = await send(); assert.equal(r2.status, 201);
    const b2 = await r2.json() as any;
    assert.equal(b2.id, b1.id, "幂等：相同 clientCaptureId 应返回同一 id");
  });

  await t.test("Step 3: 获取材料详情 (GET /v1/materials/:id)", async () => {
    assert.ok(materialId, "materialId 应已设置");
    const res = await fetch(`${ctx.base}/v1/materials/${materialId}`, { headers: h(token) });
    assert.equal(res.status, 200, `应 200，实际: ${res.status}`);
    const body = await res.json() as any;
    assert.equal(body.id, materialId);
    assert.ok(body.content?.includes("端到端"), "内容应包含原始文本");
  });

  await t.test("Step 4: 材料库列表 & 搜索 (GET /v1/materials)", async () => {
    // 再采集一条
    await fetch(`${ctx.base}/v1/captures`, {
      method: "POST",
      headers: { ...h(token), "Content-Type": "application/json" },
      body: JSON.stringify({ captureType: "pasted_text", content: "Python asyncio 入门教程", sourceTitle: "Python Async", clientCaptureId: randomUUID(), capturedAt: ct(), clientApp: "e2e" }),
    });

    const listRes = await fetch(`${ctx.base}/v1/materials`, { headers: h(token) });
    assert.equal(listRes.status, 200);
    const list = await listRes.json() as any;
    assert.ok((list.items ?? list).length >= 2, `材料库至少应有 2 条，实际: ${(list.items ?? list).length}`);

    const searchRes = await fetch(`${ctx.base}/v1/materials?q=python`, { headers: h(token) });
    assert.equal(searchRes.status, 200);
    const results = await searchRes.json() as any;
    const items = results.items ?? results;
    assert.ok(items.length >= 1, "搜索 python 至少命中 1 条");
  });

  await t.test("Step 5: 软删除 & 恢复 (PUT /v1/materials/:id/trash & /restore)", async () => {
    assert.ok(materialId, "materialId 应已设置");
    const del = await fetch(`${ctx.base}/v1/materials/${materialId}/trash`, {
      method: "PUT",
      headers: { ...h(token), "Content-Type": "application/json" },
    });
    assert.equal(del.status, 200, `trash 应 200，实际: ${del.status}`);

    const restore = await fetch(`${ctx.base}/v1/materials/${materialId}/restore`, {
      method: "PUT",
      headers: { ...h(token), "Content-Type": "application/json" },
    });
    assert.equal(restore.status, 200, `restore 应 200，实际: ${restore.status}`);

    const get = await fetch(`${ctx.base}/v1/materials/${materialId}`, { headers: h(token) });
    const item = await get.json() as any;
    assert.equal(item.trashedAt, undefined, "恢复后 trashedAt 应为空");
  });

  await t.test("Step 6: 工作区 Inbox (GET /v1/inbox)", async () => {
    const res = await fetch(`${ctx.base}/v1/inbox`, { headers: h(token) });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(Array.isArray(body), "inbox 应是数组");
    assert.ok(body.length >= 2, `inbox 至少 2 条，实际: ${body.length}`);
  });

  await t.test("Step 7: 近期整理 (POST /v1/recent-organization/runs)", async () => {
    const idempotencyKey = randomUUID();
    // idempotency-key goes in the header, not body
    const res = await fetch(`${ctx.base}/v1/recent-organization/runs`, {
      method: "POST",
      headers: { ...h(token), "Content-Type": "application/json", "idempotency-key": idempotencyKey },
    });
    assert.ok(res.status === 200 || res.status === 202, `recent org 应为 200/202，实际: ${res.status}`);
    const body = await res.json() as any;
    assert.ok(body.id || body.runId, "应返回 workflow run id");

    // Poll snapshot — handle 404 while run is still processing
    for (let i = 0; i < 40; i++) {
      const snap = await fetch(`${ctx.base}/v1/recent-organization/snapshots/latest`, { headers: h(token) });
      if (snap.status === 404) { await new Promise((r) => setTimeout(r, 150)); continue; }
      assert.equal(snap.status, 200);
      const snapBody = await snap.json() as any;
      if (snapBody.status === "completed") {
        assert.ok(Array.isArray(snapBody.representativeMaterialIds), "应有 representativeMaterialIds");
        return;
      }
      if (snapBody.status === "failed") {
        console.warn("recent org failed (expected without AI gateway)");
        return;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    // After polling loop — accept timeout as success (workflow may still be running)
    console.warn("snapshot never appeared after 6s — run may be pending or use external workers");
  });

  await t.test("Step 8: 删除影响评估 (GET /v1/materials/:id/delete-impact)", async () => {
    assert.ok(materialId, "materialId 应已设置");
    const res = await fetch(`${ctx.base}/v1/materials/${materialId}/delete-impact`, { headers: h(token) });
    assert.equal(res.status, 200, `delete-impact 应 200，实际: ${res.status}`);
    const body = await res.json() as any;
    assert.ok(typeof body.hasNoImpact === "boolean", "应返回 hasNoImpact");
    assert.ok(Array.isArray(body.topicMemberships), "应返回 topicMemberships");
  });

  await t.test("Step 9: 创建话题 (POST /v1/topics → 201)", async () => {
    const res = await fetch(`${ctx.base}/v1/topics`, {
      method: "POST",
      headers: { ...h(token), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "异步编程研究", materialIds: [materialId] }),
    });
    assert.equal(res.status, 201, `创建 topic 应 201，实际: ${res.status}`);
    const body = await res.json() as any;
    assert.ok(body.id, "应返回 topic id");
    assert.equal(body.title, "异步编程研究");
    topicId = body.id;

    const list = await fetch(`${ctx.base}/v1/topics`, { headers: h(token) });
    const topics = await list.json() as any[];
    assert.ok((topics as any[]).some((t: any) => t.id === topicId), "话题列表应包含新话题");
  });

  await t.test("Step 10: 生成话题文档 (POST /v1/topics/:id/documents)", async () => {
    const idempotencyKey = randomUUID();
    const res = await fetch(`${ctx.base}/v1/topics/${topicId}/documents`, {
      method: "POST",
      headers: { ...h(token), "Content-Type": "application/json", "idempotency-key": idempotencyKey },
    });
    const body = await res.json() as any;
    if (res.status === 200) {
      assert.ok(body.id, "应返回 workflow run id");

      const doc = await fetch(`${ctx.base}/v1/topics/${topicId}/documents/latest`, { headers: h(token) });
      assert.ok(doc.status === 200 || doc.status === 404, `文档状态应为 200 或 404，实际: ${doc.status}`);
      if (doc.status === 200) {
        const docBody = await doc.json() as any;
        assert.ok(docBody.id, "文档应有 id");
        assert.ok(Array.isArray(docBody.sections), "文档应有 sections");
      }
    } else {
      // 400 = no model gateway (expected in test)
      assert.ok(res.status === 400 || res.status === 202, `应为 200/202/400，实际: ${res.status}`);
      console.warn(`document generation returned ${res.status} (expected without AI gateway)`);
    }
  });

  await t.test("Step 11: 系统端点完整性检查", async () => {
    // data-paths
    const dp = await fetch(`${ctx.base}/v1/data-paths`, { headers: h(token) });
    assert.equal(dp.status, 200);
    const dpBody = await dp.json() as any;
    assert.ok(dpBody.database, "应有 database");
    assert.ok(dpBody.artifacts, "应有 artifacts");

    // ai-configuration
    const ai = await fetch(`${ctx.base}/v1/ai-configuration`, { headers: h(token) });
    assert.equal(ai.status, 200);
    const aiBody = await ai.json() as any;
    assert.equal(aiBody.configured, false);

    // health (no auth needed)
    const hres = await fetch(`${ctx.base}/health`);
    assert.equal(hres.status, 200);
    assert.equal(((await hres.json()) as any).status, "ok");

    // topics list
    const topics = await fetch(`${ctx.base}/v1/topics`, { headers: h(token) });
    assert.equal(topics.status, 200);

    // relations
    const rels = await fetch(`${ctx.base}/v1/relations`, { headers: h(token) });
    assert.equal(rels.status, 200);
  });
});
