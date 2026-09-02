import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PROVIDER_REGISTRY, probeModelCapabilities, resolveCatalogCapabilities } from "@collector/model-gateway";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

test("active probe observes protocol evidence in six serial bounded calls and preserves model ID", async () => {
  const definition = DEFAULT_PROVIDER_REGISTRY.get("custom");
  const bodies: any[] = [];
  let active = 0;
  let maxActive = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    active -= 1;
    if (body.thinking) return json({ choices: [{ message: { content: "OK", reasoning_content: "reason" } }] });
    if (body.response_format) return json({ choices: [{ message: { content: "{\"ok\":true}" } }] });
    if (body.tool_choice) return json({ choices: [{ message: { tool_calls: [{ function: { name: "capability_probe", arguments: "{\"value\":\"OK\"}" } }] } }] });
    if (body.stream) return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    if (Array.isArray(body.messages?.[0]?.content)) return json({ choices: [{ message: { content: "OK" } }] });
    return json({ choices: [{ message: { tool_calls: [{ type: "web_search", function: { name: "web_search" } }] } }] });
  };
  const result = await probeModelCapabilities(definition, "https://models.example.com/v1", "MiXeD-Model-ID", "secret", { fetchImpl });
  assert.equal(bodies.length, 6);
  assert.equal(maxActive, 1);
  assert.ok(bodies.every((body) => body.model === "MiXeD-Model-ID"));
  assert.equal(result.capabilities.thinking.status, "supported");
  assert.equal(result.capabilities.reasoningOutput.status, "supported");
  assert.equal(result.capabilities.nativeWebSearch.status, "supported");
  assert.equal(result.capabilities.nativeWebSearch.usable, false);
  assert.equal(result.capabilities.visionInput.status, "supported");
  assert.equal(result.capabilities.visionInput.usable, false);
  assert.equal(result.capabilities.streamingOutput.usable, true);
});

test("silent ignore and missing reasoning remain unknown while structured rejection is unsupported", async () => {
  const definition = DEFAULT_PROVIDER_REGISTRY.get("custom");
  const ignored = await probeModelCapabilities(definition, "https://models.example.com/v1", "unknown", "secret", {
    fetchImpl: async () => json({ choices: [{ message: { content: "OK" } }] }),
  });
  assert.equal(ignored.capabilities.thinking.status, "unknown");
  assert.equal(ignored.capabilities.reasoningOutput.status, "unknown");
  assert.equal(ignored.capabilities.toolCalling.status, "unknown");
  assert.equal(ignored.capabilities.streamingOutput.status, "unknown");

  const rejected = await probeModelCapabilities(definition, "https://models.example.com/v1", "unknown", "secret", {
    fetchImpl: async () => json({ error: { code: "unsupported_parameter", message: "thinking reasoning web_search response_format tool function_call image vision stream are not supported" } }, 400),
  });
  for (const [name, capability] of Object.entries(rejected.capabilities)) {
    assert.equal(capability.status, name === "collectorWebSearch" ? "supported" : "unsupported");
  }
});

test("auth and network failures stop probing, do not leak credentials, and preserve prior valid evidence", async () => {
  const definition = DEFAULT_PROVIDER_REGISTRY.get("custom");
  const previous = resolveCatalogCapabilities({
    providerId: "custom", apiMode: "openai_chat_completions", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", model: "mimo-v2.5",
  });
  let calls = 0;
  const failed = await probeModelCapabilities(definition, "https://token-plan-cn.xiaomimimo.com/v1", "mimo-v2.5", "never-persist-this-key", {
    previous,
    fetchImpl: async () => { calls += 1; return json({ error: { message: "bad key never-persist-this-key" } }, 401); },
  });
  assert.equal(calls, 1);
  assert.equal(failed.failureCode, "authentication");
  assert.equal(failed.capabilities.thinking.status, "supported");
  assert.equal(JSON.stringify(failed).includes("never-persist-this-key"), false);

  const network = await probeModelCapabilities(definition, "https://models.example.com/v1", "unknown", "secret", {
    fetchImpl: async () => { throw new Error("socket closed"); },
  });
  assert.equal(network.failureCode, "network");
  assert.equal(network.capabilities.thinking.status, "probe_failed");

  for (const [status, expected] of [[429, "rate_limited"], [503, "service_error"]] as const) {
    const failedStatus = await probeModelCapabilities(definition, "https://models.example.com/v1", "unknown", "secret", {
      fetchImpl: async () => json({ error: { message: "temporary failure" } }, status),
    });
    assert.equal(failedStatus.failureCode, expected);
    assert.equal(failedStatus.capabilities.toolCalling.status, "probe_failed");
  }

  const timedOut = await probeModelCapabilities(definition, "https://models.example.com/v1", "unknown", "secret", {
    timeoutMs: 5,
    fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }),
  });
  assert.equal(timedOut.failureCode, "timeout");
});
