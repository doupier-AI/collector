import assert from "node:assert/strict";
import test from "node:test";
import {
  AnthropicMessagesProvider,
  FakeProvider,
  GeminiGroundingProvider,
  ModelGateway,
  ModelProviderAbortedError,
  ModelProviderHttpError,
  ModelProviderTimeoutError,
  OpenAiCompatibleProvider,
  OpenAiResponsesProvider,
  createProvider,
  iterateServerSentEvents,
  DEFAULT_PROVIDER_REGISTRY,
  type ModelProvider,
  type ModelProviderStreamEvent,
} from "@collector/model-gateway";

/** 把若干 SSE 帧编码成一个流式 Response（供 fetchImpl 注入）。frames 为完整 data 载荷。 */
function sseResponse(frames: Array<{ event?: string; data: string }>, status = 200): Response {
  const text = frames.map((frame) => `${frame.event ? `event: ${frame.event}\n` : ""}data: ${frame.data}\n\n`).join("");
  const encoded = new TextEncoder().encode(text);
  // 逐字节推送以验证解析器的流式缓冲（跨块多字节字符不被截断）。
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const chunkSize = 7;
      for (let index = 0; index < encoded.length; index += chunkSize) {
        controller.enqueue(encoded.slice(index, index + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(stream, { status });
}

async function collect(iterable: AsyncIterable<ModelProviderStreamEvent>): Promise<ModelProviderStreamEvent[]> {
  const events: ModelProviderStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const deltasOf = (events: ModelProviderStreamEvent[]): string =>
  events.filter((event): event is Extract<ModelProviderStreamEvent, { type: "delta" }> => event.type === "delta").map((event) => event.text).join("");
const doneOf = (events: ModelProviderStreamEvent[]): Extract<ModelProviderStreamEvent, { type: "done" }> => {
  const done = events.find((event) => event.type === "done");
  assert.ok(done && done.type === "done", "流应以 done 事件收尾");
  return done;
};

test("iterateServerSentEvents 拼接多 data 行、捕获 event、跨块不截断多字节字符", async () => {
  const events: Array<{ event?: string; data: string }> = [];
  for await (const event of iterateServerSentEvents(sseResponse([{ data: "第一行" }, { event: "greeting", data: "hello" }]).body!)) {
    events.push(event);
  }
  assert.equal(events.length, 2);
  assert.equal(events[0]?.data, "第一行");
  assert.equal(events[1]?.event, "greeting");
  assert.equal(events[1]?.data, "hello");
});

test("OpenAI 兼容 provider 流式：delta.content 逐字、终帧 usage、[DONE] 收尾", async () => {
  let body: Record<string, unknown> | undefined;
  const provider = createProvider(DEFAULT_PROVIDER_REGISTRY.get("deepseek"), {
    apiKey: () => "deepseek-secret",
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return sseResponse([
        { data: JSON.stringify({ model: "deepseek-v4-flash", choices: [{ delta: { content: "你好" } }] }) },
        { data: JSON.stringify({ model: "deepseek-v4-flash", choices: [{ delta: { content: "世界" } }] }) },
        { data: JSON.stringify({ model: "deepseek-v4-flash", choices: [], usage: { prompt_tokens: 11, completion_tokens: 22, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 8 } }) },
        { data: "[DONE]" },
      ]);
    },
  });
  assert.ok(provider instanceof OpenAiCompatibleProvider);
  assert.equal(typeof provider.completeStream, "function");
  const events = await collect(provider.completeStream!({ prompt: "问题", model: "deepseek-v4-flash" }));
  assert.equal(body?.stream, true);
  assert.deepEqual(body?.stream_options, { include_usage: true });
  assert.equal(deltasOf(events), "你好世界");
  const done = doneOf(events);
  assert.equal(done.model, "deepseek-v4-flash");
  assert.deepEqual(done.usage, { inputTokens: 11, outputTokens: 22, inputCacheHitTokens: 3, inputCacheMissTokens: 8 });
});

test("已验证 reasoning 输出能力：专用字段先于同帧正文产出，空值忽略且不计入正文", async () => {
  let body: Record<string, unknown> | undefined;
  const provider = createProvider(DEFAULT_PROVIDER_REGISTRY.get("deepseek"), {
    apiKey: () => "deepseek-secret",
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return sseResponse([
        { data: JSON.stringify({ model: "deepseek-v4-flash", choices: [{ delta: { reasoning_content: "先想" } }] }) },
        { data: JSON.stringify({ model: "deepseek-v4-flash", choices: [{ delta: { content: "你好", reasoning_content: "再想" } }] }) },
        { data: JSON.stringify({ model: "deepseek-v4-flash", choices: [{ delta: { reasoning_content: "" } }] }) },
        { data: JSON.stringify({ model: "deepseek-v4-flash", choices: [{ delta: { content: "世界" } }] }) },
        { data: "[DONE]" },
      ]);
    },
  });
  const events = await collect(provider.completeStream!({ prompt: "问题", model: "deepseek-v4-flash" }));
  assert.equal(deltasOf(events), "你好世界");
  const reasoning = events.filter((event): event is Extract<ModelProviderStreamEvent, { type: "reasoning" }> => event.type === "reasoning").map((event) => event.text).join("");
  assert.equal(reasoning, "先想再想");
  assert.deepEqual(events.map((event) => event.type === "done" ? "done" : `${event.type}:${event.text}`), [
    "reasoning:先想",
    "reasoning:再想",
    "delta:你好",
    "delta:世界",
    "done",
  ]);
  doneOf(events);
});

test("未声明 reasoning 输出能力的兼容端点忽略同名字段，只产出正文与 done", async () => {
  const provider = createProvider(DEFAULT_PROVIDER_REGISTRY.get("openrouter"), {
    apiKey: () => "openrouter-secret",
    fetchImpl: async () =>
      sseResponse([
        { data: JSON.stringify({ choices: [{ delta: { reasoning_content: "不可信伪过程" } }] }) },
        { data: JSON.stringify({ choices: [{ delta: { content: "可信正文", reasoning_content: "仍不可信" } }] }) },
        { data: "[DONE]" },
      ]),
  });
  const events = await collect(provider.completeStream!({ prompt: "问题", model: "openai/gpt-4.1-mini" }));
  assert.equal(deltasOf(events), "可信正文");
  assert.equal(events.some((event) => event.type === "reasoning"), false);
  assert.deepEqual(events.map((event) => event.type), ["delta", "done"]);
});

test("网关 writeResearchBodyStream：供应商 reasoning 在正文边界丢弃且不污染输出", async () => {
  const provider = new FakeProvider([{ content: "  正文内容", reasoning: "深度推理过程", model: "fake-model", usage: { inputTokens: 10, outputTokens: 20 } }]);
  const gateway = new ModelGateway(provider, { model: "fake-model" });
  const deltas: string[] = [];
  for await (const delta of gateway.writeResearchBodyStream([{ role: "user", content: "问题" }])) {
    deltas.push(delta);
  }
  assert.doesNotMatch(deltas.join(""), /深度推理过程/);
  assert.equal(deltas.join(""), "正文内容");
  // thinking 控制模型计算方式，不授权返回或保存原始推理。
  assert.equal(provider.calls[0]?.thinking, false);
});

test("网关 writeResearchBodyStream：thinking 显式开启时透传到请求", async () => {
  const provider = new FakeProvider(["回答"]);
  Object.assign(provider, { supportsThinking: () => true });
  const gateway = new ModelGateway(provider, { model: "fake-model" });
  for await (const _delta of gateway.writeResearchBodyStream([{ role: "user", content: "问题" }], { thinking: true })) { void _delta; }
  assert.equal(provider.calls[0]?.thinking, true);
});

test("网关把引用候选从正文分片旁路输出，并按 trim 与续写前缀映射精确范围", async () => {
  const provider: ModelProvider = {
    name: "citation-fake",
    async complete(request) { return { content: "", model: request.model }; },
    async *completeStream(request) {
      yield { type: "delta", text: "  正文" };
      yield { type: "citation", sourceOrdinal: 1, startOffset: 2, endOffset: 6, providerCitationId: "native-1" };
      yield { type: "delta", text: "内容  " };
      yield { type: "citation", sourceOrdinal: 2 };
      yield { type: "done", model: request.model, finishReason: "stop" };
    },
  };
  const gateway = new ModelGateway(provider, { model: "citation-model" });
  const citations: Array<{ sourceOrdinal: number; startOffset?: number; endOffset?: number; providerCitationId?: string }> = [];
  const deltas: string[] = [];
  for await (const delta of gateway.writeResearchBodyStream([{ role: "user", content: "问题" }], {
    citationOffsetBase: 10,
    onCitation: (candidate) => citations.push(candidate),
  })) deltas.push(delta);

  assert.equal(deltas.join(""), "正文内容");
  assert.deepEqual(citations, [
    { sourceOrdinal: 1, startOffset: 10, endOffset: 14, providerCitationId: "native-1" },
    { sourceOrdinal: 2 },
  ]);
});

test("OpenAI Responses provider 流式：output_text.delta 逐字、completed 帧 usage、failed 只抛稳定错误", async () => {
  const provider = createProvider(DEFAULT_PROVIDER_REGISTRY.get("openai"), {
    apiKey: () => "openai-secret",
    fetchImpl: async () =>
      sseResponse([
        { event: "response.output_text.delta", data: JSON.stringify({ type: "response.output_text.delta", delta: "有来" }) },
        { event: "response.output_text.delta", data: JSON.stringify({ type: "response.output_text.delta", delta: "源回答" }) },
        { event: "response.output_text.annotation.added", data: JSON.stringify({ type: "response.output_text.annotation.added", annotation: { id: "oa-citation-1", type: "url_citation", url: "https://example.com/source", start_index: 0, end_index: 5 } }) },
        { event: "response.completed", data: JSON.stringify({ type: "response.completed", response: { model: "gpt-4.1", usage: { input_tokens: 5, output_tokens: 9, input_tokens_details: { cached_tokens: 2 } } } }) },
      ]),
  });
  assert.ok(provider instanceof OpenAiResponsesProvider);
  const events = await collect(provider.completeStream!({
    prompt: "问题",
    model: "gpt-4.1",
    citationSources: [{ sourceOrdinal: 3, title: "Source", url: "https://example.com/source" }],
  }));
  assert.equal(deltasOf(events), "有来源回答");
  assert.deepEqual(events.find((event) => event.type === "citation"), {
    type: "citation", sourceOrdinal: 3, startOffset: 0, endOffset: 5, providerCitationId: "oa-citation-1",
  });
  const done = doneOf(events);
  assert.equal(done.model, "gpt-4.1");
  assert.deepEqual(done.usage, { inputTokens: 5, outputTokens: 9, inputCacheHitTokens: 2, inputCacheMissTokens: 5 });

  const failing = createProvider(DEFAULT_PROVIDER_REGISTRY.get("openai"), {
    apiKey: () => "openai-secret",
    fetchImpl: async () => sseResponse([{ event: "response.failed", data: JSON.stringify({ type: "response.failed", response: { error: { message: "token=secret 私人正文" } } }) }]),
  });
  await assert.rejects(
    collect(failing.completeStream!({ prompt: "问题", model: "gpt-4.1" })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "OpenAI streaming failed");
      assert.doesNotMatch(error.message, /secret|私人正文|token=/);
      return true;
    },
  );
});

test("Gemini provider 流式：parts[].text 逐字、usageMetadata 终帧", async () => {
  const provider = createProvider(DEFAULT_PROVIDER_REGISTRY.get("gemini"), {
    apiKey: () => "AIza-test-key",
    fetchImpl: async () =>
      sseResponse([
        { data: JSON.stringify({ candidates: [{
          content: { parts: [{ text: "Gemini " }] },
          groundingMetadata: {
            groundingChunks: [{ web: { uri: "https://example.com/gemini" } }],
            groundingSupports: [{ segment: { startIndex: 0, endIndex: 6 }, groundingChunkIndices: [0] }],
          },
        }] }) },
        { data: JSON.stringify({ candidates: [{ content: { parts: [{ text: "流式回答" }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 13 } }) },
      ]),
  });
  assert.ok(provider instanceof GeminiGroundingProvider);
  const events = await collect(provider.completeStream!({
    prompt: "问题",
    model: "gemini-2.5-flash",
    citationSources: [{ sourceOrdinal: 2, title: "Gemini source", url: "https://example.com/gemini" }],
  }));
  assert.equal(deltasOf(events), "Gemini 流式回答");
  assert.deepEqual(events.find((event) => event.type === "citation"), {
    type: "citation", sourceOrdinal: 2, startOffset: 0, endOffset: 6,
  });
  const done = doneOf(events);
  assert.deepEqual(done.usage, { inputTokens: 7, outputTokens: 13 });
});

test("Anthropic provider 流式：content_block_delta 逐字、message_start/delta 合成 usage", async () => {
  const provider = createProvider(DEFAULT_PROVIDER_REGISTRY.get("anthropic"), {
    apiKey: () => "anthropic-secret",
    fetchImpl: async () =>
      sseResponse([
        { event: "message_start", data: JSON.stringify({ type: "message_start", message: { model: "claude-x", usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 } } }) },
        { event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "逐字" } }) },
        { event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "生成" } }) },
        { event: "message_delta", data: JSON.stringify({ type: "message_delta", usage: { output_tokens: 6 } }) },
        { event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
      ]),
  });
  assert.ok(provider instanceof AnthropicMessagesProvider);
  const events = await collect(provider.completeStream!({ prompt: "问题", model: "claude-x" }));
  assert.equal(deltasOf(events), "逐字生成");
  const done = doneOf(events);
  assert.equal(done.model, "claude-x");
  assert.deepEqual(done.usage, { inputTokens: 15, outputTokens: 6, inputCacheHitTokens: 4, inputCacheMissTokens: 11 });
});

test("流式响应非 2xx 时抛 HTTP 错误", async () => {
  const provider = createProvider(DEFAULT_PROVIDER_REGISTRY.get("deepseek"), {
    apiKey: () => "deepseek-secret",
    fetchImpl: async () => new Response("upstream error", { status: 500 }),
  });
  await assert.rejects(collect((provider as OpenAiCompatibleProvider).completeStream!({ prompt: "问题", model: "deepseek-v4-flash" })), /HTTP 500/);
});

test("FakeProvider 流式：按 80 字切片逐段、终帧带 usage/model", async () => {
  const long = "字".repeat(200);
  const provider = new FakeProvider([long]);
  const events = await collect(provider.completeStream!({ prompt: "问题", model: "fake-model" }));
  assert.equal(deltasOf(events), long);
  // 200 字 → 80/80/40 共 3 个 delta + 1 个 done
  assert.equal(events.filter((event) => event.type === "delta").length, 3);
  const done = doneOf(events);
  assert.equal(done.model, "fake-model");
  assert.deepEqual(done.usage, { inputTokens: 10, outputTokens: 20 });
});

/** 推出若干帧后挂起（不关闭流），用于触发空闲超时。abort 时 reject 挂起读（真实 fetch 响应绑在 signal 上，中止即报错）。 */
function sseHangResponse(frames: Array<{ event?: string; data: string }>, signal?: AbortSignal | null): Response {
  const text = frames.map((frame) => `${frame.event ? `event: ${frame.event}\n` : ""}data: ${frame.data}\n\n`).join("");
  const encoded = new TextEncoder().encode(text);
  let index = 0;
  const chunkSize = 7;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < encoded.length) {
        controller.enqueue(encoded.slice(index, index + chunkSize));
        index += chunkSize;
        return;
      }
      // 数据推完后不再 enqueue、也不 close —— 流挂起。注册 abort：模拟网络层对中止的响应。
      if (signal?.aborted) controller.error(signal.reason ?? new Error("aborted"));
      else signal?.addEventListener("abort", () => controller.error(signal.reason ?? new Error("aborted")), { once: true });
    },
  });
  return new Response(stream, { status: 200 });
}

test("OpenAI 兼容流式接入外部中止信号，暂停/停止不会退化为空闲超时", async () => {
  const external = new AbortController();
  let requestSignal: AbortSignal | null | undefined;
  let markFetchStarted: (() => void) | undefined;
  const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
  const provider = createProvider(DEFAULT_PROVIDER_REGISTRY.get("deepseek"), {
    apiKey: () => "deepseek-secret",
    fetchImpl: async (_input, init) => {
      requestSignal = init?.signal;
      markFetchStarted?.();
      return sseHangResponse([{ data: JSON.stringify({ choices: [{ delta: { reasoning_content: "已收到过程" } }] }) }], init?.signal);
    },
  });
  const pending = collect(provider.completeStream!({
    prompt: "问题",
    model: "deepseek-v4-flash",
    signal: external.signal,
    timeoutMs: 1_000,
  }));
  await fetchStarted;
  await new Promise((resolve) => setImmediate(resolve));
  external.abort();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ModelProviderAbortedError);
    return true;
  });
  assert.equal(requestSignal?.aborted, true);
});

/** 按 intervalMs 间隔逐块推流（间隔 > timeoutMs 时总时长远超 timeoutMs，但单块间隔 < timeoutMs）。 */
function sseDripResponse(frames: Array<{ event?: string; data: string }>, intervalMs: number): Response {
  const text = frames.map((frame) => `${frame.event ? `event: ${frame.event}\n` : ""}data: ${frame.data}\n\n`).join("");
  const encoded = new TextEncoder().encode(text);
  let index = 0;
  const chunkSize = 7;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= encoded.length) { controller.close(); return; }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      controller.enqueue(encoded.slice(index, index + chunkSize));
      index += chunkSize;
    },
  });
  return new Response(stream, { status: 200 });
}

test("流式空闲超时：推一帧后挂起，超时抛 ModelProviderTimeoutError", async () => {
  const provider = createProvider(DEFAULT_PROVIDER_REGISTRY.get("deepseek"), {
    apiKey: () => "deepseek-secret",
    fetchImpl: async (_input, init) => sseHangResponse([{ data: JSON.stringify({ choices: [{ delta: { content: "只推一帧" } }] }) }], init?.signal),
  });
  await assert.rejects(
    collect((provider as OpenAiCompatibleProvider).completeStream!({ prompt: "问题", model: "deepseek-v4-flash", timeoutMs: 60 })),
    (error: unknown) => {
      assert.ok(error instanceof ModelProviderTimeoutError, `应为空闲超时错误，实得 ${String(error)}`);
      return true;
    },
  );
});

test("流式空闲重置：单块间隔 < 超时但总长 > 超时，流仍完整完成（证闲时非总超时）", async () => {
  // 间隔 40ms、timeoutMs 100ms：全文数十块、总时长 > 100ms，但每块间隔 40ms < 100ms。
  const provider = createProvider(DEFAULT_PROVIDER_REGISTRY.get("deepseek"), {
    apiKey: () => "deepseek-secret",
    fetchImpl: async () =>
      sseDripResponse([
        { data: JSON.stringify({ choices: [{ delta: { content: "第一段" } }] }) },
        { data: JSON.stringify({ choices: [{ delta: { content: "第二段" } }] }) },
        { data: JSON.stringify({ choices: [{ delta: { content: "第三段" } }] }) },
        { data: "[DONE]" },
      ], 40),
  });
  const events = await collect((provider as OpenAiCompatibleProvider).completeStream!({ prompt: "问题", model: "deepseek-v4-flash", timeoutMs: 100 }));
  assert.equal(deltasOf(events), "第一段第二段第三段");
});

test("OpenAI 兼容流式 done 事件携带 finishReason（length = 被截断）", async () => {
  const provider = createProvider(DEFAULT_PROVIDER_REGISTRY.get("deepseek"), {
    apiKey: () => "deepseek-secret",
    fetchImpl: async () =>
      sseResponse([
        { data: JSON.stringify({ choices: [{ delta: { content: "被截断的正文" } }] }) },
        { data: JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }) },
        { data: "[DONE]" },
      ]),
  });
  const events = await collect((provider as OpenAiCompatibleProvider).completeStream!({ prompt: "问题", model: "deepseek-v4-flash" }));
  assert.equal(doneOf(events).finishReason, "length");
});

test("Anthropic 流式 done 事件把 max_tokens 映射为 length", async () => {
  const provider = createProvider(DEFAULT_PROVIDER_REGISTRY.get("anthropic"), {
    apiKey: () => "anthropic-secret",
    fetchImpl: async () =>
      sseResponse([
        { event: "message_start", data: JSON.stringify({ type: "message_start", message: { model: "claude-x", usage: { input_tokens: 3 } } }) },
        { event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "截断" } }) },
        { event: "message_delta", data: JSON.stringify({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 4 } }) },
        { event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
      ]),
  });
  const events = await collect(provider.completeStream!({ prompt: "问题", model: "claude-x" }));
  assert.equal(doneOf(events).finishReason, "length");
});

test("Gemini 流式 done 事件把 MAX_TOKENS 映射为 length", async () => {
  const provider = createProvider(DEFAULT_PROVIDER_REGISTRY.get("gemini"), {
    apiKey: () => "AIza-test-key",
    fetchImpl: async () =>
      sseResponse([
        { data: JSON.stringify({ candidates: [{ content: { parts: [{ text: "截断" }] }, finishReason: "MAX_TOKENS" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 } }) },
      ]),
  });
  const events = await collect(provider.completeStream!({ prompt: "问题", model: "gemini-2.5-flash" }));
  assert.equal(doneOf(events).finishReason, "length");
});

test("OpenAI Responses 流式 incomplete 帧映射 finishReason 为 length", async () => {
  const provider = createProvider(DEFAULT_PROVIDER_REGISTRY.get("openai"), {
    apiKey: () => "openai-secret",
    fetchImpl: async () =>
      sseResponse([
        { event: "response.output_text.delta", data: JSON.stringify({ type: "response.output_text.delta", delta: "截断" }) },
        { event: "response.incomplete", data: JSON.stringify({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }) },
      ]),
  });
  const events = await collect(provider.completeStream!({ prompt: "问题", model: "gpt-4.1" }));
  assert.equal(doneOf(events).finishReason, "length");
});

test("非 2xx 响应抛出带 status 的 ModelProviderHttpError（429 与 400）", async () => {
  const rateLimited = createProvider(DEFAULT_PROVIDER_REGISTRY.get("deepseek"), {
    apiKey: () => "deepseek-secret",
    fetchImpl: async () => new Response("rate limited", { status: 429 }),
  });
  await assert.rejects(
    collect((rateLimited as OpenAiCompatibleProvider).completeStream!({ prompt: "问题", model: "deepseek-v4-flash" })),
    (error: unknown) => {
      assert.ok(error instanceof ModelProviderHttpError);
      assert.equal(error.status, 429);
      return true;
    },
  );
  const badRequest = createProvider(DEFAULT_PROVIDER_REGISTRY.get("deepseek"), {
    apiKey: () => "deepseek-secret",
    fetchImpl: async () => new Response("bad request", { status: 400 }),
  });
  await assert.rejects(
    collect((badRequest as OpenAiCompatibleProvider).completeStream!({ prompt: "问题", model: "deepseek-v4-flash" })),
    (error: unknown) => {
      assert.ok(error instanceof ModelProviderHttpError);
      assert.equal(error.status, 400);
      return true;
    },
  );
});
