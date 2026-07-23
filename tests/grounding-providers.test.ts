import assert from "node:assert/strict";
import test from "node:test";
import {
  AnthropicMessagesProvider,
  GeminiGroundingProvider,
  OpenAiResponsesProvider,
  createProvider,
  DEFAULT_PROVIDER_REGISTRY,
} from "@collector/model-gateway";

const grounding = { taskId: "task-1", scenario: "chat" as const, requireGrounding: true as const, promptVersion: "research-grounding-v1" };

test("OpenAI Responses adapter requires web search and normalizes URL citations", async () => {
  let body: Record<string, unknown> | undefined;
  const provider = createProvider(DEFAULT_PROVIDER_REGISTRY.get("openai"), {
    apiKey: () => "openai-secret",
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ model: "gpt-4.1", output: [{ type: "web_search_call", action: { query: "collector" } }, { content: [{ type: "output_text", text: "有来源的回答", annotations: [{ type: "url_citation", url: "https://example.com/a?token=gone", title: "Example", start_index: 0, end_index: 4 }] }] }] }), { status: 200 });
    },
  });
  assert.ok(provider instanceof OpenAiResponsesProvider);
  const result = await provider.generateGroundedResearch({ prompt: "问题", model: "gpt-4.1", grounding });
  assert.deepEqual(body?.tools, [{ type: "web_search" }]);
  assert.equal(body?.tool_choice, "required");
  assert.equal(result.status, "grounded");
  assert.equal(result.sources[0]?.url, "https://example.com/a?token=gone");
  assert.deepEqual(result.queries, ["collector"]);
});

test("Gemini grounding adapter uses Google Search and maps grounding metadata", async () => {
  let body: Record<string, unknown> | undefined;
  const provider = createProvider(DEFAULT_PROVIDER_REGISTRY.get("gemini"), {
    apiKey: () => "AIza-test-key",
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Gemini 回答" }] }, groundingMetadata: { webSearchQueries: ["collector"], groundingChunks: [{ web: { uri: "https://example.com/g", title: "Google source" } }], groundingSupports: [{ segment: { startIndex: 0, endIndex: 6 }, groundingChunkIndices: [0] }] } }] }), { status: 200 });
    },
  });
  assert.ok(provider instanceof GeminiGroundingProvider);
  const result = await provider.generateGroundedResearch({ prompt: "问题", model: "gemini-2.5-flash", grounding });
  assert.deepEqual(body?.tools, [{ google_search: {} }]);
  assert.equal(result.status, "grounded");
  assert.equal(result.sources[0]?.url, "https://example.com/g");
  assert.deepEqual(result.citations, [{ sourceOrdinal: 1, startOffset: 0, endOffset: 6 }]);
});

test("Anthropic adapter resumes server-side tools after pause_turn and maps final citations", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const provider = createProvider(DEFAULT_PROVIDER_REGISTRY.get("anthropic"), {
    apiKey: () => "anthropic-secret",
    fetchImpl: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) {
        return new Response(JSON.stringify({
          stop_reason: "pause_turn",
          content: [{ type: "server_tool_use", id: "tool-1", name: "web_search", input: { query: "collector" } }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        stop_reason: "end_turn",
        content: [{
          type: "text",
          text: "联网结论",
          citations: [{ id: "citation-1", url: "https://example.com/source", title: "Example" }],
        }],
      }), { status: 200 });
    },
  });
  assert.ok(provider instanceof AnthropicMessagesProvider);
  const result = await provider.generateGroundedResearch({ prompt: "问题", model: "claude-sonnet-5", grounding });
  assert.equal(bodies.length, 2);
  const secondMessages = bodies[1]?.messages as Array<{ role: string; content: unknown }>;
  assert.equal(secondMessages.length, 2);
  assert.equal(secondMessages[1]?.role, "assistant");
  assert.deepEqual(secondMessages[1]?.content, [{ type: "server_tool_use", id: "tool-1", name: "web_search", input: { query: "collector" } }]);
  assert.equal(result.status, "grounded");
  assert.equal(result.citations[0]?.sourceOrdinal, 1);
  assert.deepEqual(result.citations[0]?.startOffset, 0);
  assert.deepEqual(result.citations[0]?.endOffset, "联网结论".length);
});

