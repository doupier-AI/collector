// e2e-live.test.ts — 对运行中 Electron 应用做端到端测试
// 用法: $env:RUN_LIVE_E2E='1'; npx tsx --test tests/e2e-live.test.ts
//
// 前提: Electron 应用正在运行
// 工作方式: 通过 pairing 机制获取 token，然后调用真实 API
//
// 如何获取 pairing code:
//   1. 右键系统托盘 → "浏览器扩展配对" → 记下 6 位数字码
//   2. 运行: PAIRING_CODE=123456 npx tsx --test tests/e2e-live.test.ts
//
// 无 PAIRING_CODE 时跳过认证测试，只跑 health/root 等公开端点

import assert from "node:assert/strict";
import nodeTest from "node:test";
import { randomUUID } from "node:crypto";

const BASE = process.env.COLLECTOR_API_URL ?? "http://127.0.0.1:43110";
const PAIRING_CODE = process.env.PAIRING_CODE ?? "";
const TIMEOUT = 30_000;
const test = process.env.RUN_LIVE_E2E === "1" ? nodeTest : nodeTest.skip;

let TOKEN = "";

// ── Bootstrap: exchange pairing code for token ─────────────

test("Bootstrap: 连接运行中的 Collector", async (t) => {
  await t.test("API 健康检查 (GET /health)", async () => {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.status, "ok");
    console.log(`  ✓ Collector 在 ${BASE} 运行中 (instanceId: ${body.instanceId})`);
  });

  await t.test("根端点 (GET /)", async () => {
    const res = await fetch(BASE);
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.name, "Collector Local API");
  });

  if (!PAIRING_CODE) {
    console.warn("  ⚠ 无 PAIRING_CODE，跳过认证测试。设置方式：");
    console.warn("    1. 右键托盘 → '浏览器扩展配对'");
    console.warn("    2. PAIRING_CODE=123456 npx tsx --test tests/e2e-live.test.ts");
    return;
  }

  await t.test("交换配对码获取 Token (POST /v1/pairings/exchange)", async () => {
    const res = await fetch(`${BASE}/v1/pairings/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: PAIRING_CODE }),
    });
    assert.equal(res.status, 200, `配对码交换失败 (status ${res.status})，请确认托盘显示的码正确`);
    const body = await res.json() as any;
    assert.ok(body.token, "应返回 token");
    TOKEN = body.token;
    console.log("  ✓ 配对成功，Token 已获取");
  });
});

// ── Authenticated tests (only run if we have a token) ──────

function withAuth() { return { Authorization: `Bearer ${TOKEN}` }; }
function ct() { return new Date().toISOString(); }

test("采集流程 (Capture → Material → Search)", async (t) => {
  if (!TOKEN) return; // skip if no token

  let materialId = "";

  await t.test("POST /v1/captures — 采集文本内容", async () => {
    const res = await fetch(`${BASE}/v1/captures`, {
      method: "POST",
      headers: { ...withAuth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        captureType: "pasted_text",
        content: "Live E2E 测试材料 — Node.js 流式 API 最佳实践 (from e2e-live.test.ts)",
        sourceTitle: "Stream API Best Practices",
        sourceUrl: "https://nodejs.org/api/stream.html",
        clientCaptureId: randomUUID(),
        capturedAt: ct(),
        clientApp: "e2e-live-test",
      }),
    });
    assert.equal(res.status, 201, `应 201，实际 ${res.status}`);
    const body = await res.json() as any;
    assert.ok(body.id);
    materialId = body.id;
    console.log(`  ✓ 采集成功: ${materialId}`);
  });

  await t.test("GET /v1/materials/:id — 获取材料详情", async () => {
    const res = await fetch(`${BASE}/v1/materials/${materialId}`, { headers: withAuth() });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.id, materialId);
    assert.ok(body.content?.includes("Live E2E"));
  });

  await t.test("GET /v1/materials — 材料列表", async () => {
    const res = await fetch(`${BASE}/v1/materials`, { headers: withAuth() });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok((body.items ?? body).length >= 1);
  });

  await t.test("GET /v1/materials?q= — 搜索材料", async () => {
    const res = await fetch(`${BASE}/v1/materials?q=stream`, { headers: withAuth() });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok((body.items ?? body).length >= 1, "搜索 stream 应命中");
  });

  await t.test("PUT /v1/materials/:id/trash → restore", async () => {
    const trash = await fetch(`${BASE}/v1/materials/${materialId}/trash`, {
      method: "PUT", headers: withAuth(),
    });
    assert.equal(trash.status, 200);

    const restore = await fetch(`${BASE}/v1/materials/${materialId}/restore`, {
      method: "PUT", headers: withAuth(),
    });
    assert.equal(restore.status, 200);

    const get = await fetch(`${BASE}/v1/materials/${materialId}`, { headers: withAuth() });
    assert.equal((await get.json() as any).trashedAt, undefined);
  });

  await t.test("GET /v1/materials/:id/delete-impact — 删除影响评估", async () => {
    const res = await fetch(`${BASE}/v1/materials/${materialId}/delete-impact`, { headers: withAuth() });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(typeof body.hasNoImpact === "boolean");
  });
});

test("话题与文档流程 (Topic → Document)", async (t) => {
  if (!TOKEN) return;

  let topicId = "";

  await t.test("POST /v1/topics — 创建话题", async () => {
    const res = await fetch(`${BASE}/v1/topics`, {
      method: "POST",
      headers: { ...withAuth(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: `Live E2E 测试话题 ${randomUUID().slice(0, 8)}` }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as any;
    assert.ok(body.id);
    topicId = body.id;
    console.log(`  ✓ 话题创建成功: ${topicId}`);
  });

  await t.test("GET /v1/topics — 话题列表", async () => {
    const res = await fetch(`${BASE}/v1/topics`, { headers: withAuth() });
    assert.equal(res.status, 200);
    const topics = await res.json() as any[];
    assert.ok(topics.some((t: any) => t.id === topicId));
  });

  await t.test("POST /v1/topics/:id/documents — 生成话题文档", async () => {
    const res = await fetch(`${BASE}/v1/topics/${topicId}/documents`, {
      method: "POST",
      headers: { ...withAuth(), "Content-Type": "application/json", "idempotency-key": randomUUID() },
    });
    // Without AI key, expect 400; with AI key, expect 200
    const body = await res.json() as any;
    if (res.status === 200) {
      assert.ok(body.id, "应返回 workflow run id");
      console.log(`  ✓ 文档生成已启动: ${body.id}`);
    } else {
      assert.ok(res.status === 400, `应为 200 或 400，实际 ${res.status}`);
      console.warn(`  ⚠ 文档生成返回 ${res.status}（无 AI 配置时正常）`);
    }
  });
});

test("近期整理 (Recent Organization)", async (t) => {
  if (!TOKEN) return;

  await t.test("POST /v1/recent-organization/runs — 触发整理", async () => {
    const res = await fetch(`${BASE}/v1/recent-organization/runs`, {
      method: "POST",
      headers: { ...withAuth(), "Content-Type": "application/json", "idempotency-key": randomUUID() },
    });
    assert.ok(res.status === 200 || res.status === 202, `应 200/202，实际 ${res.status}`);
    const body = await res.json() as any;
    assert.ok(body.id || body.runId);
    console.log(`  ✓ 近期整理已触发: ${body.id ?? body.runId}`);
  });

  await t.test("GET /v1/recent-organization/snapshots/latest — 最新快照", async () => {
    const res = await fetch(`${BASE}/v1/recent-organization/snapshots/latest`, { headers: withAuth() });
    if (res.status === 404) {
      console.warn("  ⚠ 无快照（整理可能仍在进行中或尚未产生）");
      return;
    }
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    console.log(`  ✓ 快照状态: ${body.status}`);
  });
});

test("系统端点完整性", async (t) => {
  if (!TOKEN) return;

  await t.test("GET /v1/inbox — 工作区收件箱", async () => {
    const res = await fetch(`${BASE}/v1/inbox`, { headers: withAuth() });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(Array.isArray(body));
    console.log(`  ✓ Inbox: ${body.length} 条`);
  });

  await t.test("GET /v1/data-paths — 数据路径", async () => {
    const res = await fetch(`${BASE}/v1/data-paths`, { headers: withAuth() });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(body.database);
    assert.ok(body.artifacts);
  });

  await t.test("GET /v1/ai-configuration — AI 配置", async () => {
    const res = await fetch(`${BASE}/v1/ai-configuration`, { headers: withAuth() });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(typeof body.configured === "boolean");
    assert.ok(typeof body.consent === "boolean");
  });

  await t.test("GET /v1/relations — 关系列表", async () => {
    const res = await fetch(`${BASE}/v1/relations`, { headers: withAuth() });
    assert.equal(res.status, 200);
  });
});
