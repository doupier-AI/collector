import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PROVIDER_REGISTRY,
  OFFICIAL_MIMO_OPENAI_BASE_URL,
  createProvider,
  isOfficialMimoEndpoint,
  resolveCatalogCapabilities,
  resolveModelThinkingCapability,
  type ModelProviderStreamEvent,
} from "@collector/model-gateway";

function jsonResponse(model = "ok"): Response {
  return new Response(JSON.stringify({ model, choices: [{ message: { content: "answer" }, finish_reason: "stop" }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(events: unknown[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function collect(stream: AsyncIterable<ModelProviderStreamEvent>): Promise<ModelProviderStreamEvent[]> {
  const events: ModelProviderStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("集中能力解析大小写不敏感，未知模型与非官方 MiMo 端点不猜测", () => {
  assert.equal(resolveModelThinkingCapability({
    providerId: "DeepSeek", apiMode: "openai_chat_completions", baseUrl: "https://api.deepseek.com", model: "DeepSeek-V4-Pro",
  }).thinkingSupported, true);
  assert.equal(resolveModelThinkingCapability({
    providerId: "custom", apiMode: "openai_chat_completions", baseUrl: `${OFFICIAL_MIMO_OPENAI_BASE_URL}/`, model: "MIMO-V2.5",
  }).thinkingSupported, true);
  assert.equal(resolveModelThinkingCapability({
    providerId: "custom", apiMode: "openai_chat_completions", baseUrl: "https://proxy.example/v1", model: "mimo-v2.5-pro",
  }).thinkingSupported, false);
  assert.equal(resolveModelThinkingCapability({
    providerId: "custom", apiMode: "openai_chat_completions", baseUrl: `${OFFICIAL_MIMO_OPENAI_BASE_URL}?proxy=1`, model: "mimo-v2.5-pro",
  }).thinkingSupported, false);
  assert.equal(resolveModelThinkingCapability({
    providerId: "deepseek", apiMode: "openai_chat_completions", baseUrl: "https://api.deepseek.com", model: "future-model",
  }).thinkingSupported, false);
  assert.equal(resolveModelThinkingCapability({
    providerId: "custom", apiMode: "openai_chat_completions", baseUrl: "https://token-plan-cn-hz.xiaomimimo.com/v1", model: "MIMO-V2.5-PRO",
  }).thinkingSupported, true);
  assert.equal(isOfficialMimoEndpoint("https://token-plan-us-west.xiaomimimo.com/v1/"), true);
  for (const spoofed of [
    "https://token-plan-us-west.xiaomimimo.com.evil.example/v1",
    "https://xiaomimimo.com.evil.example/v1",
    "https://user@token-plan-us.xiaomimimo.com/v1",
    "https://token-plan-us.xiaomimimo.com/v1?token=secret",
    "http://token-plan-us.xiaomimimo.com/v1",
    "https://token-plan-us.xiaomimimo.com/v2",
  ]) assert.equal(isOfficialMimoEndpoint(spoofed), false, spoofed);
  const unknown = resolveCatalogCapabilities({ providerId: "custom", apiMode: "openai_chat_completions", baseUrl: "https://proxy.example/v1", model: "mimo-v2.5" });
  assert.equal(unknown.thinking.status, "unknown");
});

test("OpenAI-Compatible thinking.type 对支持模型发 enabled/disabled，对未知模型完全省略", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return jsonResponse();
  };
  const provider = createProvider(DEFAULT_PROVIDER_REGISTRY.get("custom"), {
    apiKey: () => "secret",
    baseUrl: OFFICIAL_MIMO_OPENAI_BASE_URL,
    fetchImpl,
  });

  await provider.complete({ prompt: "q", model: "MiMo-V2.5-Pro", thinking: true });
  await provider.complete({ prompt: "q", model: "mimo-v2.5", thinking: false });
  await provider.complete({ prompt: "q", model: "mimo-unknown", thinking: true });

  assert.deepEqual(bodies[0]?.thinking, { type: "enabled" });
  assert.equal(bodies[0]?.model, "MiMo-V2.5-Pro", "实际发包 model ID 必须保持原样");
  assert.deepEqual(bodies[1]?.thinking, { type: "disabled" });
  assert.equal(Object.hasOwn(bodies[2] ?? {}, "thinking"), false);
});

test("当前能力快照显式覆盖目录，实际发包不回退到过期支持结论", async () => {
  const blockedBodies: Array<Record<string, unknown>> = [];
  const blocked = createProvider(DEFAULT_PROVIDER_REGISTRY.get("custom"), {
    apiKey: () => "secret",
    baseUrl: OFFICIAL_MIMO_OPENAI_BASE_URL,
    thinkingSupported: () => false,
    fetchImpl: async (_input, init) => {
      blockedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse();
    },
  });
  await blocked.complete({ prompt: "q", model: "mimo-v2.5", thinking: true });
  assert.equal(Object.hasOwn(blockedBodies[0] ?? {}, "thinking"), false);

  const enabledBodies: Array<Record<string, unknown>> = [];
  const enabled = createProvider(DEFAULT_PROVIDER_REGISTRY.get("custom"), {
    apiKey: () => "secret",
    baseUrl: "https://models.example.com/v1",
    thinkingSupported: () => true,
    fetchImpl: async (_input, init) => {
      enabledBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse();
    },
  });
  await enabled.complete({ prompt: "q", model: "verified-custom-model", thinking: true });
  assert.deepEqual(enabledBodies[0]?.thinking, { type: "enabled" });
});

test("官方 MiMo reasoning_content 作为独立推理事件流，不混入正文", async () => {
  const provider = createProvider(DEFAULT_PROVIDER_REGISTRY.get("custom"), {
    apiKey: () => "secret",
    baseUrl: OFFICIAL_MIMO_OPENAI_BASE_URL,
    fetchImpl: async () => sseResponse([
      { model: "mimo-v2.5", choices: [{ delta: { reasoning_content: "先分析" } }] },
      { model: "mimo-v2.5", choices: [{ delta: { content: "正文" }, finish_reason: "stop" }] },
    ]),
  });
  assert.equal(typeof provider.completeStream, "function");
  const events = await collect(provider.completeStream!({ prompt: "q", model: "mimo-v2.5", thinking: true }));
  assert.deepEqual(events.filter((event) => event.type === "reasoning"), [{ type: "reasoning", text: "先分析" }]);
  assert.deepEqual(events.filter((event) => event.type === "delta"), [{ type: "delta", text: "正文" }]);
});
