import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_PROVIDER_DEFINITIONS,
  AnthropicMessagesProvider,
  createProvider,
  DEFAULT_PROVIDER_REGISTRY,
  OpenAiCompatibleProvider,
  ProviderRegistry,
  ProviderRuntimeResolver,
  validateExternalProviderBaseUrl,
} from "@collector/model-gateway";
import type { ProviderDefinition } from "@collector/capture-contracts";

const compatibleDefinition: ProviderDefinition = {
  id: "compatible-cloud",
  label: "Compatible Cloud",
  apiMode: "openai_chat_completions",
  authMode: "bearer",
  defaultBaseUrl: "https://models.example.com/v1/",
  defaultModel: "example-model",
  models: ["example-model"],
  capabilities: { structuredJson: true, reasoningOutput: "none", thinkingMode: "none", modelDiscovery: true, webGrounding: "unsupported" },
};

test("provider registry validates, clones, and rejects duplicate definitions", () => {
  const registry = new ProviderRegistry([compatibleDefinition]);
  const first = registry.get("compatible-cloud");
  first.models.push("mutated");
  assert.deepEqual(registry.get("compatible-cloud").models, ["example-model"]);
  assert.throws(() => registry.register(compatibleDefinition), /already registered/);
  assert.throws(() => new ProviderRegistry([{ ...compatibleDefinition, defaultBaseUrl: "http://models.example.com" }]), /HTTPS/);
  assert.throws(
    () => new ProviderRegistry([{ ...compatibleDefinition, capabilities: { ...compatibleDefinition.capabilities, reasoningOutput: "unknown" as never } }]),
    /reasoningOutput/,
  );
});

test("DeepSeek is a normal built-in provider definition", () => {
  assert.equal(BUILTIN_PROVIDER_DEFINITIONS.filter((definition) => definition.id === "deepseek").length, 1);
  const definition = DEFAULT_PROVIDER_REGISTRY.get("deepseek");
  assert.equal(definition.apiMode, "openai_chat_completions");
  assert.equal(definition.capabilities.thinkingMode, "openai_compatible");
  assert.equal(definition.capabilities.reasoningOutput, "openai_reasoning_content");
  assert.ok(BUILTIN_PROVIDER_DEFINITIONS.filter((candidate) => candidate.id !== "deepseek").every((candidate) => candidate.capabilities.reasoningOutput === "none"));
});

test("OpenAI-compatible adapter translates capabilities without brand branches", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return new Response(JSON.stringify({
      model: "example-model",
      choices: [{ message: { content: "{\"ok\":true}" } }],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const provider = createProvider(compatibleDefinition, { apiKey: () => "secret-value", fetchImpl });
  assert.ok(provider instanceof OpenAiCompatibleProvider);
  const response = await provider.complete({
    prompt: "test",
    model: "example-model",
    responseFormat: { type: "json_object" },
    thinking: true,
    maxTokens: 100,
  });
  assert.equal(response.content, '{"ok":true}');
  assert.equal(requests[0].url, "https://models.example.com/v1/chat/completions");
  assert.equal(requests[0].authorization, "Bearer secret-value");
  assert.equal("thinking" in requests[0].body, false);
});

test("DeepSeek capability adds its thinking request field through registry data", async () => {
  let body: Record<string, unknown> | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 });
  };
  const provider = createProvider(DEFAULT_PROVIDER_REGISTRY.get("deepseek"), { apiKey: () => "secret-value", fetchImpl });
  await provider.complete({ prompt: "test", model: "deepseek-v4-flash", responseFormat: { type: "json_object" }, thinking: true });
  assert.deepEqual(body?.thinking, { type: "enabled" });
});

test("Anthropic Messages adapter uses native headers, body, text blocks, and cache usage", async () => {
  let captured: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    return new Response(JSON.stringify({
      model: "claude-sonnet-5",
      content: [{ type: "text", text: "{\"ok\":" }, { type: "text", text: "true}" }],
      usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 2, output_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const provider = createProvider(DEFAULT_PROVIDER_REGISTRY.get("anthropic"), { apiKey: () => "anthropic-secret", fetchImpl });
  assert.ok(provider instanceof AnthropicMessagesProvider);
  const response = await provider.complete({ prompt: "test", model: "claude-sonnet-5", responseFormat: { type: "json_object" }, maxTokens: 200 });
  assert.equal(captured?.url, "https://api.anthropic.com/v1/messages");
  assert.equal(captured?.headers.get("x-api-key"), "anthropic-secret");
  assert.equal(captured?.headers.get("anthropic-version"), "2023-06-01");
  assert.deepEqual(captured?.body.messages, [{ role: "user", content: "test" }]);
  assert.equal(response.content, '{"ok":true}');
  assert.deepEqual(response.usage, { inputTokens: 16, outputTokens: 3, inputCacheHitTokens: 4, inputCacheMissTokens: 12 });
});

test("runtime resolver freezes a non-secret route and scopes credential lookup to the profile", async () => {
  const registry = new ProviderRegistry([compatibleDefinition]);
  const requestedProfiles: string[] = [];
  const resolver = new ProviderRuntimeResolver(registry, async (profileId) => { requestedProfiles.push(profileId); return "profile-secret"; });
  const runtime = await resolver.resolve({
    id: "profile-runtime",
    providerId: compatibleDefinition.id,
    displayName: compatibleDefinition.label,
    baseUrl: compatibleDefinition.defaultBaseUrl,
    model: compatibleDefinition.defaultModel,
    credentialConfigured: true,
    enabled: true,
    configurationVersion: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  assert.deepEqual(requestedProfiles, ["profile-runtime"]);
  assert.equal(runtime.route.providerProfileId, "profile-runtime");
  assert.equal(runtime.route.providerId, compatibleDefinition.id);
  assert.equal(runtime.route.model, compatibleDefinition.defaultModel);
  assert.equal(runtime.route.configurationVersion, 3);
  assert.match(runtime.route.baseUrlFingerprint, /^[a-f0-9]{64}$/);
  assert.equal("apiKey" in runtime.route, false);
});

test("custom provider URLs require public HTTPS addresses", async () => {
  const publicLookup = (async () => [{ address: "203.0.113.8", family: 4 }]) as unknown as NonNullable<Parameters<typeof validateExternalProviderBaseUrl>[1]>;
  const privateLookup = (async () => [{ address: "10.0.0.8", family: 4 }]) as unknown as NonNullable<Parameters<typeof validateExternalProviderBaseUrl>[1]>;
  await assert.rejects(() => validateExternalProviderBaseUrl("http://models.example.com/v1", publicLookup), /HTTPS/);
  await assert.rejects(() => validateExternalProviderBaseUrl("https://localhost/v1", publicLookup), /public host/);
  await assert.rejects(() => validateExternalProviderBaseUrl("https://models.example.com/v1", privateLookup), /non-public/);
  assert.equal(await validateExternalProviderBaseUrl("https://models.example.com/v1/?token=secret#fragment", publicLookup), "https://models.example.com/v1");
});
