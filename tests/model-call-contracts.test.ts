import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PROVIDER_REGISTRY,
  ModelBudgetReassemblyRequiredError,
  ModelBudgetUnsatisfiableError,
  ModelGateway,
  OpenAiCompatibleProvider,
  appliedModelBudget,
  assertResolvedBudget,
  createPromptEnvelope,
  observePromptEnvelope,
  resolveModelBudget,
  type ModelCallEvent,
} from "@collector/model-gateway";

const envelope = createPromptEnvelope({
  purpose: "research_body",
  promptVersion: "test-prompt-v1",
  messages: [
    { role: "system", content: "stable rule" },
    { role: "user", content: "private question" },
    { role: "assistant", content: "prior answer" },
    { role: "tool", toolCallId: "call-1", content: "private evidence" },
  ],
  outputContract: { format: "text", contractVersion: "body-v1", minimumBodyTokens: 512 },
});

test("Prompt Envelope preserves roles while its observation excludes all message bodies", () => {
  const observation = observePromptEnvelope(envelope);
  assert.deepEqual(observation.roleCounts, { system: 1, user: 1, assistant: 1, tool: 1 });
  assert.equal(observation.messageCount, 4);
  assert.equal(observation.outputContract.minimumBodyTokens, 512);
  assert.doesNotMatch(JSON.stringify(observation), /stable rule|private question|prior answer|private evidence|call-1/);
});

test("Model Budget Policy makes resolved and unsatisfiable outcomes explicit", () => {
  const resolved = assertResolvedBudget(resolveModelBudget({
    envelope,
    requested: { maxInputTokens: 8_000, maxOutputTokens: 4_000, minimumBodyTokens: 512, thinking: true },
    limits: { contextWindowTokens: 12_000, maxOutputTokens: 3_000, reasoningBudgetMode: "shared_output" },
  }));
  assert.equal(resolved.maxOutputTokens, 3_000);
  assert.equal(resolved.reasoningBudgetMode, "shared_output");
  assert.deepEqual(appliedModelBudget(resolved), { maxOutputTokens: 3_000, thinking: true });

  assert.throws(() => assertResolvedBudget(resolveModelBudget({
    envelope,
    requested: { maxInputTokens: 8_000, maxOutputTokens: 4_000, minimumBodyTokens: 512, thinking: false },
    limits: { contextWindowTokens: 12_000, maxOutputTokens: 128, reasoningBudgetMode: "none" },
  })), ModelBudgetUnsatisfiableError);
});

test("Model Budget Policy requests one orchestration reassembly instead of truncating an oversized envelope", () => {
  const oversized = createPromptEnvelope({
    purpose: "research_body",
    promptVersion: "test-prompt-v1",
    system: "rule",
    user: "材料".repeat(2_000),
    outputContract: { format: "text", contractVersion: "body-v1", minimumBodyTokens: 512 },
  });
  const resolution = resolveModelBudget({
    envelope: oversized,
    requested: { maxInputTokens: 1_000, maxOutputTokens: 1_000, minimumBodyTokens: 512, thinking: false },
    limits: { contextWindowTokens: 2_000, maxOutputTokens: 1_000, reasoningBudgetMode: "none" },
  });
  assert.equal(resolution.status, "reassembly_required");
  assert.throws(() => assertResolvedBudget(resolution), ModelBudgetReassemblyRequiredError);
});

test("OpenAI-compatible Adapter maps roles and applies the exact resolved budget", async () => {
  let body: Record<string, unknown> | undefined;
  const provider = new OpenAiCompatibleProvider({
    definition: DEFAULT_PROVIDER_REGISTRY.get("deepseek"),
    apiKey: () => "secret",
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        model: "deepseek-v4-flash",
        choices: [{ finish_reason: "stop", message: { content: "answer" } }],
        usage: { prompt_tokens: 20, completion_tokens: 7 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  let event: ModelCallEvent | undefined;
  const gateway = new ModelGateway(provider, { thinking: true, buildFingerprint: "build-test", onCall: (value) => { event = value; } });

  await gateway.answerResearchConversation([{ role: "user", content: "question" }], {
    maxTokens: 1_234,
    context: { purpose: "research_chat", promptVersion: "chat-test-v1" },
  });

  assert.equal(body?.max_tokens, 1_234);
  assert.deepEqual((body?.messages as Array<{ role: string }>).map((message) => message.role), ["system", "user"]);
  assert.deepEqual(body?.thinking, { type: "enabled" });
  assert.equal(event?.requestedBudget.maxOutputTokens, 1_234);
  assert.equal(event?.resolvedBudget.maxOutputTokens, 1_234);
  assert.equal(event?.appliedBudget.maxOutputTokens, 1_234);
  assert.deepEqual(event?.usage, { inputTokens: 20, outputTokens: 7, inputCacheHitTokens: undefined, inputCacheMissTokens: undefined });
  assert.equal(event?.finishReason, "stop");
  assert.equal(event?.availability.status, "available");
  assert.equal(event?.buildFingerprint, "build-test");
});

test("empty and length-limited provider results produce stable diagnostics", async () => {
  const events: ModelCallEvent[] = [];
  let call = 0;
  const provider = {
    name: "diagnostic-provider",
    async complete() {
      call += 1;
      return call === 1
        ? { model: "diagnostic-model", content: "", finishReason: "stop" }
        : { model: "diagnostic-model", content: "partial", finishReason: "length" };
    },
  };
  const gateway = new ModelGateway(provider, { onCall: (event) => { events.push(event); } });
  await assert.rejects(() => gateway.answerResearchConversation([{ role: "user", content: "question" }]), /empty answer/);
  await gateway.answerResearchConversation([{ role: "user", content: "question" }]);
  assert.equal(events[0]?.completionDiagnostic, "empty_body");
  assert.equal(events[1]?.completionDiagnostic, "length");
});
