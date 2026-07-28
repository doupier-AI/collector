import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { CaptureService, MemoryStore } from "@collector/api";
import { DEFAULT_PROVIDER_REGISTRY, discoverProviderModels } from "@collector/model-gateway";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

test("model discovery lists OpenAI-compatible models with bearer auth and dedupe", async () => {
  let captured: { url: string; headers: Headers } | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = { url: String(input), headers: new Headers(init?.headers) };
    return jsonResponse({ data: [{ id: "model-a" }, { id: "model-b" }, { id: "model-a" }, { nope: 1 }] });
  };
  const result = await discoverProviderModels(DEFAULT_PROVIDER_REGISTRY.get("deepseek"), "https://api.deepseek.com/", "sk-secret", { fetchImpl });
  assert.deepEqual(result, { ok: true, models: ["model-a", "model-b"] });
  assert.equal(captured?.url, "https://api.deepseek.com/models");
  assert.equal(captured?.headers.get("authorization"), "Bearer sk-secret");
});

test("model discovery lists Anthropic models with native headers", async () => {
  let captured: { url: string; headers: Headers } | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = { url: String(input), headers: new Headers(init?.headers) };
    return jsonResponse({ data: [{ id: "claude-sonnet-5" }, { id: "claude-haiku-4-5-20251001" }] });
  };
  const result = await discoverProviderModels(DEFAULT_PROVIDER_REGISTRY.get("anthropic"), "https://api.anthropic.com/v1", "anthropic-secret", { fetchImpl });
  assert.deepEqual(result, { ok: true, models: ["claude-sonnet-5", "claude-haiku-4-5-20251001"] });
  assert.equal(captured?.url, "https://api.anthropic.com/v1/models");
  assert.equal(captured?.headers.get("x-api-key"), "anthropic-secret");
  assert.equal(captured?.headers.get("anthropic-version"), "2023-06-01");
});

test("model discovery lists Gemini models and strips the models/ prefix", async () => {
  let captured: { url: string; headers: Headers } | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = { url: String(input), headers: new Headers(init?.headers) };
    return jsonResponse({ models: [{ name: "models/gemini-2.5-flash" }, { name: "models/gemini-2.5-pro" }] });
  };
  const result = await discoverProviderModels(DEFAULT_PROVIDER_REGISTRY.get("gemini"), "https://generativelanguage.googleapis.com/v1beta", "gemini-secret", { fetchImpl });
  assert.deepEqual(result, { ok: true, models: ["gemini-2.5-flash", "gemini-2.5-pro"] });
  assert.equal(captured?.url, "https://generativelanguage.googleapis.com/v1beta/models");
  assert.equal(captured?.headers.get("x-goog-api-key"), "gemini-secret");
});

test("model discovery classifies auth, unsupported endpoint, parse, and network failures", async () => {
  const definition = DEFAULT_PROVIDER_REGISTRY.get("openai");
  const withStatus = (status: number): typeof fetch => async () => jsonResponse({}, status);
  assert.deepEqual(await discoverProviderModels(definition, "https://api.openai.com/v1", "sk-bad", { fetchImpl: withStatus(401) }), { ok: false, error: "认证失败：请检查 API Key 是否正确" });
  assert.deepEqual(await discoverProviderModels(definition, "https://api.openai.com/v1", "sk-bad", { fetchImpl: withStatus(403) }), { ok: false, error: "认证失败：请检查 API Key 是否正确" });
  assert.deepEqual(await discoverProviderModels(definition, "https://api.openai.com/v1", "sk-ok", { fetchImpl: withStatus(404) }), { ok: false, error: "该供应商未提供模型列表端点，请手动填写模型名称" });
  const serverError = await discoverProviderModels(definition, "https://api.openai.com/v1", "sk-ok", { fetchImpl: withStatus(500) });
  assert.equal(serverError.ok, false);
  if (!serverError.ok) assert.match(serverError.error, /HTTP 500/);
  const parseFailure = await discoverProviderModels(definition, "https://api.openai.com/v1", "sk-ok", { fetchImpl: async () => jsonResponse({ unexpected: true }) });
  assert.deepEqual(parseFailure, { ok: false, error: "模型列表解析失败：返回内容不符合预期格式，请手动填写模型名称" });
  const timeout = await discoverProviderModels(definition, "https://api.openai.com/v1", "sk-ok", { fetchImpl: async () => { throw new Error("The operation timed out"); } });
  assert.deepEqual(timeout, { ok: false, error: "模型列表请求超时，请稍后重试或检查网络" });
});

test("builtin catalog includes the domestic OpenAI-compatible presets", () => {
  for (const id of ["moonshot", "zhipu", "siliconflow", "dashscope"]) {
    const definition = DEFAULT_PROVIDER_REGISTRY.get(id);
    assert.equal(definition.apiMode, "openai_chat_completions");
    assert.equal(definition.authMode, "bearer");
    assert.equal(definition.capabilities.modelDiscovery, true);
    assert.equal(definition.capabilities.webGrounding, "unsupported");
    assert.ok(definition.defaultModel.length > 0);
  }
});

test("service discovery reuses the stored credential when apiKey is omitted", async () => {
  const store = new MemoryStore();
  await store.init();
  let seenAuthorization: string | null = null;
  const service = new CaptureService(store, join(tmpdir(), "collector-discovery-service"), undefined, undefined, {
    autoRunRecentOrganization: false,
    modelDiscoveryFetch: async (_input, init) => {
      seenAuthorization = new Headers(init?.headers).get("authorization");
      return jsonResponse({ data: [{ id: "gpt-4.1-mini" }] });
    },
  });
  const profile = await service.saveProviderProfileWithCredential({
    providerId: "openai",
    displayName: "OpenAI",
    model: "gpt-4.1-mini",
    apiKey: "sk-stored",
  });
  const result = await service.discoverProviderModels({ providerId: "openai", profileId: profile.id });
  assert.deepEqual(result, { ok: true, models: ["gpt-4.1-mini"] });
  assert.equal(seenAuthorization, "Bearer sk-stored");

  const noKey = await service.discoverProviderModels({ providerId: "openai" });
  assert.deepEqual(noKey, { ok: false, error: "请先填写 API Key 后再获取模型列表" });
});
