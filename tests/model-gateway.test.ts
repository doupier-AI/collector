import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CaptureInput, FragmentRecord } from "@collector/capture-contracts";
import { CaptureService, JsonStore } from "@collector/api";
import { DeepSeekProvider, FakeProvider, ModelGateway } from "@collector/model-gateway";

const fragment: FragmentRecord = {
  id: "fragment-1", captureId: "capture-1", ordinal: 0, text: "SQLite provides transactional local persistence.",
  locator: { kind: "text", startLine: 1, endLine: 1 }, createdAt: new Date().toISOString(),
};

function validExtraction(fragmentId = fragment.id) {
  return JSON.stringify({
    summary: "SQLite is used for local persistence.",
    concepts: [{ name: "SQLite", text: "A local relational database", fragmentIds: [fragmentId] }],
    claims: [{ statement: "SQLite provides transactional persistence.", text: "Grounded claim", fragmentIds: [fragmentId] }],
    questions: [{ question: "How are migrations handled?", text: "Open question", fragmentIds: [fragmentId] }],
    topicSuggestions: [{ title: "Local persistence", text: "Suggested topic", fragmentIds: [fragmentId] }],
    relationSuggestions: [{ relationType: "independent", rationale: "No prior capture is required", confidence: 0.8, fragmentIds: [fragmentId] }],
  });
}

test("gateway retries malformed JSON once and then succeeds", async () => {
  const provider = new FakeProvider(["not json", validExtraction()]);
  const result = await new ModelGateway(provider).extract([fragment]);
  assert.equal(result.retryCount, 1);
  assert.equal(result.extraction?.claims.length, 1);
  assert.equal(provider.calls.length, 2);
  assert.deepEqual(provider.calls[0].responseFormat, { type: "json_object" });
  assert.equal(provider.calls[0].thinking, false);
  assert.match(provider.calls[0].prompt, /Produce json/);
  assert.match(provider.calls[1].prompt, /CORRECTION REQUIRED/);
});

test("gateway retry explains invalid fragment references and lists allowed IDs", async () => {
  const provider = new FakeProvider([validExtraction("capture-id-used-as-fragment"), validExtraction()]);
  const result = await new ModelGateway(provider).extract([fragment]);
  assert.equal(result.extraction?.claims.length, 1);
  assert.match(provider.calls[1].prompt, /Unknown evidence fragmentId/);
  assert.match(provider.calls[1].prompt, new RegExp(fragment.id));
  assert.equal(result.usage?.inputTokens, 20);
  assert.equal(result.usage?.outputTokens, 40);
});

test("gateway fails after two invalid responses without an extraction", async () => {
  const provider = new FakeProvider(["", "{invalid"]);
  const result = await new ModelGateway(provider).extract([fragment]);
  assert.equal(result.extraction, undefined);
  assert.equal(result.retryCount, 1);
  assert.equal(result.errorCode, "invalid_json");
});

test("gateway rejects unknown evidence fragment IDs", async () => {
  const provider = new FakeProvider([validExtraction("invented-fragment"), validExtraction("invented-fragment")]);
  const result = await new ModelGateway(provider).extract([fragment]);
  assert.equal(result.extraction, undefined);
  assert.equal(result.errorCode, "invalid_schema");
  assert.match(result.errorMessage ?? "", /Unknown evidence fragmentId/);
});

test("provider errors redact exposed API keys", async () => {
  const provider = new FakeProvider([new Error("request failed with sk-sensitive-secret-value"), new Error("request failed with sk-sensitive-secret-value")]);
  const result = await new ModelGateway(provider).extract([fragment]);
  assert.equal(result.errorCode, "provider_error");
  assert.doesNotMatch(result.errorMessage ?? "", /sk-sensitive/);
  assert.match(result.errorMessage ?? "", /REDACTED/);
});

test("DeepSeek provider sends JSON mode and keeps the key in the Authorization header", async () => {
  let request: RequestInit | undefined;
  const provider = new DeepSeekProvider({
    apiKey: () => "rotated-runtime-key",
    fetchImpl: async (_url, init) => {
      request = init;
      return new Response(JSON.stringify({ model: "deepseek-v4-flash", choices: [{ message: { content: validExtraction() } }], usage: { prompt_tokens: 11, completion_tokens: 22, prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: 6 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const response = await provider.complete({ model: "deepseek-v4-flash", prompt: "json extraction", responseFormat: { type: "json_object" } });
  assert.equal(new Headers(request?.headers).get("authorization"), "Bearer rotated-runtime-key");
  assert.equal(JSON.parse(String(request?.body)).response_format.type, "json_object");
  assert.equal(JSON.parse(String(request?.body)).thinking.type, "disabled");
  assert.equal(response.usage?.inputTokens, 11);
  assert.equal(response.usage?.inputCacheHitTokens, 5);
});

test("gateway supports explicit L3 model and thinking mode", async () => {
  const provider = new FakeProvider([validExtraction()]);
  const result = await new ModelGateway(provider).extract([fragment], [], { model: "deepseek-v4-pro", thinking: true });
  assert.equal(result.model, "deepseek-v4-pro");
  assert.equal(provider.calls[0].model, "deepseek-v4-pro");
  assert.equal(provider.calls[0].thinking, true);
});

test("capture AI disable flag prevents provider calls", async (t) => {
  const fixture = await serviceFixture([validExtraction("unused")]);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await fixture.service.createCapture(captureInput({ aiProcessingDisabled: true }));
  assert.equal(fixture.provider.calls.length, 0);
  assert.equal(fixture.service.listInbox()[0].agentRuns?.length, 0);
});

test("capture persistence does not wait for a slow model provider", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-model-background-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JsonStore(join(root, "store.json"));
  await store.init();
  let release: (() => void) | undefined;
  const provider = new class extends FakeProvider {
    constructor() { super([]); }
    override async complete(request: Parameters<FakeProvider["complete"]>[0]) {
      this.calls.push(request);
      await new Promise<void>((resolve) => { release = resolve; });
      return { content: validExtraction(extractFirstFragmentId(request.prompt)), model: request.model, usage: { inputTokens: 10, outputTokens: 20 } };
    }
  }();
  const service = new CaptureService(store, join(root, "artifacts"), undefined, new ModelGateway(provider));
  const capture = await Promise.race([
    service.createCapture(captureInput()),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("createCapture waited for the model provider")), 250)),
  ]);
  assert.equal(capture.status, "inbox");
  assert.match(service.listInbox()[0].agentRuns?.[0].status ?? "", /queued|running/);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  await service.drainBackgroundTasks();
  assert.equal(service.listInbox()[0].agentRuns?.[0].status, "succeeded");
});

test("validated model output creates AI items, proposals, and a successful AgentRun", async (t) => {
  const fixture = await serviceFixture((request) => validExtraction(extractFirstFragmentId(request.prompt)));
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const capture = await fixture.service.createCapture(captureInput());
  await fixture.service.drainBackgroundTasks();
  const inbox = fixture.service.listInbox()[0];
  assert.equal(inbox.agentRuns?.[0].status, "succeeded");
  assert.equal(inbox.agentRuns?.[0].inputTokens, 10);
  assert.equal(inbox.agentRuns?.[0].estimatedCostUsd, 0.000007);
  assert.equal(inbox.knowledgeItems.filter((item) => item.origin === "ai_inference").length, 3);
  assert.equal(inbox.reviewProposals.some((proposal) => proposal.rationale === "No prior capture is required"), true);
  const run = inbox.agentRuns![0];
  const evidenceFragmentIds = [inbox.fragments[0].id];
  const topic = await fixture.service.createTopic("Local persistence", { captureId: capture.id, agentRunId: run.id, evidenceFragmentIds });
  assert.equal(topic.origin, "ai_suggestion");
  assert.equal(fixture.service.getTopicWorkspace(topic.id).captures[0].capture.id, capture.id);
  assert.equal((await fixture.service.createTopic("Local persistence", { captureId: capture.id, agentRunId: run.id, evidenceFragmentIds })).id, topic.id);
});

test("invalid model output records a failed AgentRun without AI knowledge pollution", async (t) => {
  const fixture = await serviceFixture(["{invalid", "{invalid"]);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await fixture.service.createCapture(captureInput());
  await fixture.service.drainBackgroundTasks();
  const inbox = fixture.service.listInbox()[0];
  assert.equal(inbox.agentRuns?.[0].status, "failed");
  assert.equal(inbox.knowledgeItems.some((item) => item.origin === "ai_inference"), false);
});

test("deep analysis is explicit, queued as L3, and uses the pro model", async (t) => {
  const fixture = await serviceFixture((request) => validExtraction(extractFirstFragmentId(request.prompt)));
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const capture = await fixture.service.createCapture(captureInput());
  await fixture.service.drainBackgroundTasks();
  const queued = await fixture.service.requestDeepAnalysis(capture.id);
  assert.equal(queued.processingLevel, "L3");
  assert.equal(queued.model, "deepseek-v4-pro");
  await fixture.service.drainBackgroundTasks();
  const deepRun = fixture.service.listInbox()[0].agentRuns?.find((run) => run.processingLevel === "L3");
  assert.equal(deepRun?.status, "succeeded");
  assert.equal(deepRun?.model, "deepseek-v4-pro");
  assert.equal(fixture.provider.calls.at(-1)?.model, "deepseek-v4-pro");
  assert.equal(fixture.provider.calls.at(-1)?.thinking, true);
});

test("resumed legacy L3 runs normalize an incorrectly persisted flash model to pro", async (t) => {
  const fixture = await serviceFixture((request) => validExtraction(extractFirstFragmentId(request.prompt)));
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const capture = await fixture.service.createCapture(captureInput());
  await fixture.service.drainBackgroundTasks();
  const fragments = fixture.service.listInbox()[0].fragments;
  await fixture.store.saveAgentRun({
    id: crypto.randomUUID(), captureId: capture.id, provider: "deepseek", model: "deepseek-v4-flash",
    promptVersion: "knowledge-extraction-v1", processingLevel: "L3", status: "running", retryCount: 0,
    createdAt: new Date().toISOString(),
  });
  await fixture.service.resumePendingModelRuns();
  await fixture.service.drainBackgroundTasks();
  const resumed = fixture.service.listInbox()[0].agentRuns?.find((run) => run.processingLevel === "L3");
  assert.equal(resumed?.model, "deepseek-v4-pro");
  assert.equal(resumed?.status, "succeeded");
  assert.ok(fragments.length > 0);
});

async function serviceFixture(responses: ConstructorParameters<typeof FakeProvider>[0] | ((request: { prompt: string }) => string)) {
  const root = await mkdtemp(join(tmpdir(), "collector-model-"));
  const store = new JsonStore(join(root, "store.json"));
  await store.init();
  const provider = typeof responses === "function"
    ? new class extends FakeProvider {
        constructor() { super([]); }
        override async complete(request: Parameters<FakeProvider["complete"]>[0]) {
          this.calls.push(request);
          return { content: responses(request), model: request.model, usage: { inputTokens: 10, outputTokens: 20 } };
        }
      }()
    : new FakeProvider(responses);
  return { root, store, provider, service: new CaptureService(store, join(root, "artifacts"), undefined, new ModelGateway(provider)) };
}

function captureInput(overrides: Partial<CaptureInput> = {}): CaptureInput {
  return {
    captureType: "pasted_text", content: "SQLite provides transactional local persistence for Collector knowledge.",
    locator: { kind: "user_supplied", sourceLabel: "test" }, clientCaptureId: crypto.randomUUID(),
    capturedAt: new Date().toISOString(), ...overrides,
  };
}

function extractFirstFragmentId(prompt: string): string {
  const match = prompt.match(/\nFragments:\n\[FRAGMENT ([^\]]+)\]/);
  if (!match) throw new Error("Prompt did not contain a fragment ID");
  return match[1];
}
