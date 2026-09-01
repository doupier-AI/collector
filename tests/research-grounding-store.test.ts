import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CaptureService, EvidencePreparationModule, ResearchSessionService, RunRecordsService, SqliteStore, citedGroundingSources, formatFinalWriterEvidence, type ResearchGenerationProvider, type ResearchTermMarkerExtractionProvider } from "@collector/api";

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "collector-grounding-store-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  return { root, store, close: async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}

const acceptNativeAttributions: NonNullable<ResearchGenerationProvider["attributeCitations"]> = async (assembly) => {
  const payload = JSON.parse(assembly.adopted.map((item) => item.candidate.content).join("\n")) as {
    nativeCandidates: Array<{ candidateId: string; sourceOrdinal: number; startOffset: number; endOffset: number; claimText: string }>;
    sources: Array<{ sourceOrdinal: number; content: string }>;
  };
  return {
    output: JSON.stringify({
      attributions: payload.nativeCandidates.map((candidate) => {
        const source = payload.sources.find((item) => item.sourceOrdinal === candidate.sourceOrdinal);
        const evidenceText = source?.content ?? "";
        return {
          nativeCandidateId: candidate.candidateId,
          sourceOrdinal: candidate.sourceOrdinal,
          claimStartOffset: candidate.startOffset,
          claimEndOffset: candidate.endOffset,
          claimText: candidate.claimText,
          evidenceStartOffset: 0,
          evidenceEndOffset: evidenceText.length,
          evidenceText,
          support: true,
          confidence: 0.95,
        };
      }),
    }),
    provider: "attribution-fake",
    model: "attribution-model",
    producerVersion: "citation-attribution-producer-v1",
  };
};

const acceptDiscoveredAttribution: NonNullable<ResearchGenerationProvider["attributeCitations"]> = async (assembly) => {
  const payload = JSON.parse(assembly.adopted.map((item) => item.candidate.content).join("\n")) as {
    body: { startOffset: number; content: string };
    sources: Array<{ sourceOrdinal: number; content: string }>;
  };
  const source = payload.sources[0]!;
  return {
    output: JSON.stringify({
      attributions: [{
        sourceOrdinal: source.sourceOrdinal,
        claimStartOffset: payload.body.startOffset,
        claimEndOffset: payload.body.startOffset + payload.body.content.length,
        claimText: payload.body.content,
        evidenceStartOffset: 0,
        evidenceEndOffset: source.content.length,
        evidenceText: source.content,
        support: true,
        confidence: 0.95,
      }],
    }),
    provider: "attribution-fake",
    model: "attribution-model",
    producerVersion: "citation-attribution-producer-v1",
  };
};

test("引用来源过滤同时匹配 runId 与 sourceId", () => {
  const createdAt = "2026-01-01T00:00:00.000Z";
  const sources = [
    { id: "shared", runId: "run-a", ordinal: 2, title: "A", createdAt },
    { id: "shared", runId: "run-b", ordinal: 5, title: "B", createdAt },
  ];
  const citations = [{ id: "citation", messageId: "message", runId: "run-b", sourceId: "shared", blockOrdinal: 0, markerOffset: 0, createdAt }];

  assert.deepEqual(citedGroundingSources(sources, citations).map((source) => [source.runId, source.ordinal]), [["run-b", 5]]);
});

test("EvidenceBundle policy remains separate while accepted attribution derives grounded", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  let admittedEvidenceIds: string[] = [];
  let finalWriterSourceIds: Array<string | undefined> = [];
  const provider: ResearchGenerationProvider = {
    provider: "evidence-fake", model: "evidence-model", promptVersion: "evidence-test-v1",
    async *generate() { yield "ordinary fallback"; },
    async prepareGrounded(request) {
      assert.ok(request.answerPlan);
      const url = "https://docs.example/node";
      const result = await new EvidencePreparationModule({
        async search(query) { return { query, results: [{ title: "Current Node release", url, snippet: "Current Node release" }] }; },
        async fetch() { return { url, content: "The current Node release documentation contains complete release information." }; },
      }, () => new Date("2026-09-01T00:00:00.000Z")).prepare({
        currentQuestion: request.messages[0]?.content ?? "",
        answerPlan: request.answerPlan,
        webAuthorization: "authorized",
        budget: { maxQueries: 2, maxCandidates: 5, maxFetches: 5, maxPackedTokens: 2_000 },
      });
      return {
        kind: "evidence" as const,
        evidence: result.writerEvidence,
        evidenceBundle: result.bundle,
        evidencePolicyStatus: result.bundle.evidencePolicyStatus,
        status: "evidence_prepared" as const,
        queries: [...result.bundle.queries],
        sources: result.bundle.evidence.map((item) => ({
          providerSourceId: item.id,
          title: item.title,
          url: item.finalUrl,
          snippet: item.excerpt,
          evidenceStatus: item.availability,
        })),
        citations: [],
      };
    },
    async *writeGroundedFinalStream(request, _evidence, options) {
      admittedEvidenceIds = request.contextAssembly.adopted
        .filter((item) => item.candidate.source.kind === "web_source")
        .map((item) => item.candidate.source.id);
      finalWriterSourceIds = options.sources.map((source) => source.providerSourceId);
      yield "The current Node release documentation contains complete release information.";
      options.onStreamDone?.({ finishReason: "stop" });
    },
    attributeCitations: acceptDiscoveredAttribution,
  };
  const service = new ResearchSessionService(harness.store, { provider, autoRunTasks: false, buildFingerprint: "build:test" });
  const session = await service.createSession("Evidence", "evidence-session");
  const turn = await service.submitMessage(session.id, "Verify the latest Node release", "evidence-turn", { allowWebSearch: true });
  await service.processTask(turn.task.id);

  const task = service.getTask(turn.task.id);
  assert.equal(task.status, "completed");
  assert.equal(task.groundingScope?.status, "grounded");
  assert.equal(task.groundingScope?.evidencePolicyStatus, "policy_satisfied");
  assert.equal(task.groundingScope?.sourceCount, 1);
  assert.equal(task.groundingScope?.citationCount, 1);
  assert.equal(admittedEvidenceIds.length, 1);
  assert.deepEqual(admittedEvidenceIds, finalWriterSourceIds);
  const run = harness.store.listResearchGroundingRuns(turn.task.id)[0];
  assert.ok(run.evidenceBundle);
  assert.equal(run.evidenceBundle.evidencePolicyStatus, "policy_satisfied");
  assert.equal(Object.hasOwn(run.evidenceBundle, "grounded"), false);
  assert.notEqual(run.status, "grounded");
  assert.equal(run.citationAttribution?.attributions[0]?.status, "accepted");
  assert.equal(run.citationAttribution?.attributions[0]?.candidateProducer.kind, "independent_model");
  assert.equal(run.citationAttribution?.attributions[0]?.bodyVersionId, harness.store.getBodyVersionForMessage(turn.task.outputMessageId)?.id);
  const viewTask = service.getSession(session.id).tasks.find((item) => item.id === turn.task.id);
  assert.equal(viewTask?.groundingScope?.evidencePolicyStatus, "policy_satisfied");
  assert.equal(viewTask?.groundingScope?.status, "grounded");
});

test("最终写作证据保留原来源序号，并在发送前限额、净化 URL 与脱敏", () => {
  const evidence = formatFinalWriterEvidence([
    {
      sourceOrdinal: 1,
      source: { title: "来源一 token=title-secret", url: "https://user:pass@example.com/a?token=url-secret&keep=yes", evidenceStatus: "full" },
      content: `api_key=body-secret ${"甲".repeat(3_000)}`,
    },
    { sourceOrdinal: 2, source: { title: "不可用来源", evidenceStatus: "none" }, content: "不得进入" },
    { sourceOrdinal: 3, source: { title: "来源三", evidenceStatus: "partial" }, content: "保留原序号" },
    ...Array.from({ length: 17 }, (_, index) => ({
      sourceOrdinal: index + 4,
      source: { title: `来源${index + 4}`, evidenceStatus: "full" as const },
      content: "乙".repeat(2_000),
    })),
    { sourceOrdinal: 21, source: { title: "越界来源", evidenceStatus: "full" }, content: "不得进入" },
  ]);

  assert.ok(evidence.length <= 24_000, "最终写作证据总预算不超过 24000 字符");
  const structured = JSON.parse(evidence) as { sources: Array<{ sourceOrdinal: number; title: string; evidenceStatus: string; evidence: string; url?: string }> };
  assert.deepEqual(structured.sources.slice(0, 2).map((source) => source.sourceOrdinal), [1, 3]);
  assert.equal(structured.sources[1]?.title, "来源三");
  assert.equal(structured.sources[1]?.evidenceStatus, "partial");
  assert.equal(structured.sources[1]?.evidence, "保留原序号");
  assert.equal(structured.sources.some((source) => source.sourceOrdinal === 2 || source.sourceOrdinal === 21), false);
  assert.doesNotMatch(evidence, /不得进入/);
  assert.doesNotMatch(evidence, /title-secret|body-secret|url-secret|user:pass/);
  assert.equal(structured.sources[0]?.url, "https://example.com/a?keep=yes");
  assert.match(evidence, /…/, "单条证据超过 2000 字符时截断");
});

test("provider-native citations cannot bypass final-context admission", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const provider: ResearchGenerationProvider = {
    provider: "grounding-fake", model: "grounding-model", promptVersion: "grounding-test-v1",
    async *generate() { yield "ordinary fallback"; },
    async prepareGrounded() {
      const content = "联网回答内容与补充证据。";
      const firstCitation = content.indexOf("内容");
      const secondCitation = content.indexOf("证据");
      return {
        kind: "confirmed_final" as const, content, status: "grounded", queries: ["collector web search"],
        sources: [
          {
            title: "Uncited search result",
            url: "https://example.com/search-result",
            snippet: "搜索到但没有写入正文依据",
          },
          {
            title: "Source api-key=secret-value",
            url: "https://example.com/source?token=hidden",
            snippet: "摘要 authorization=Bearer-secret",
            locator: "页码 2 cookie=session-secret",
          },
          { title: "No evidence", url: "https://example.com/none", evidenceStatus: "none" },
          { title: "Another uncited result", url: "https://example.com/uncited" },
          { title: "Second cited source", url: "https://example.com/second-cited" },
        ],
        citations: [
          { sourceOrdinal: 2, startOffset: firstCitation, endOffset: firstCitation + 2 },
          { sourceOrdinal: 5, startOffset: secondCitation, endOffset: secondCitation + 2 },
        ],
        responseSummary: { result: "ok", authorization: "Bearer secret" },
        errorMessage: "token=error-secret 用户私人正文不应进入运行记录",
      };
    },
  };
  const termMarkerExtractionProvider: ResearchTermMarkerExtractionProvider = {
    provider: "term-marker-fake",
    model: "term-marker-1",
    async extractTermMarkers(input) {
      const block = input.blocks.find((candidate) => candidate.text.includes("联网回答"));
      if (!block) return '{"mentions":[]}';
      const startOffset = block.text.indexOf("联网回答");
      return JSON.stringify({ mentions: [{
        blockOrdinal: block.ordinal,
        startOffset,
        endOffset: startOffset + "联网回答".length,
        text: "联网回答",
        entityId: "web-grounding",
        category: "concept",
      }] });
    },
  };
  const capture = new CaptureService(harness.store, join(harness.root, "artifacts"), undefined, {
    autoRunResearchTasks: false,
    autoRunRecentOrganization: false,
    researchProvider: provider,
    termMarkerExtractionProvider,
  });
  const service = capture.research;
  const session = await service.createSession("测试", "session-key");
  const turn = await service.submitMessage(session.id, "解释联网研究", "turn-key", { allowWebSearch: true });
  await service.processTask(turn.task.id);
  let termMarkerTask = harness.store.getResearchTermMarkerTaskByMessage(turn.task.outputMessageId);
  for (let attempt = 0; attempt < 100 && !termMarkerTask; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    termMarkerTask = harness.store.getResearchTermMarkerTaskByMessage(turn.task.outputMessageId);
  }
  assert.ok(termMarkerTask);
  await capture.termMarkers.processTask(termMarkerTask.id);
  const task = service.getTask(turn.task.id);
  assert.deepEqual(task.groundingScope && { status: task.groundingScope.status, sourceCount: task.groundingScope.sourceCount, citationCount: task.groundingScope.citationCount }, { status: "no_verifiable_sources", sourceCount: 0, citationCount: 0 });
  const run = harness.store.listResearchGroundingRuns(turn.task.id)[0];
  assert.equal(run.queries[0], "collector web search");
  assert.equal(run.responseSummary?.authorization, "[REDACTED]");
  assert.equal(run.errorMessage, "联网核验完成，但供应商报告了部分错误");
  assert.doesNotMatch(JSON.stringify(run), /error-secret|用户私人正文/);
  const storedSources = harness.store.listResearchGroundingSources(run.id);
  assert.equal(storedSources.length, 5);
  const source = storedSources[1];
  assert.equal(source.url, "https://example.com/source");
  assert.equal(source.title, "Source api-key=[REDACTED]");
  assert.equal(source.snippet, "摘要 authorization=[REDACTED]");
  assert.equal(source.locator, "页码 2 cookie=[REDACTED]");
  const output = harness.store.getResearchMessage(turn.task.outputMessageId);
  assert.ok(output);
  assert.equal(output.content, "联网回答内容与补充证据。");
  assert.deepEqual(harness.store.getResearchTermMarkerTaskByMessage(output.id)?.markers.map((marker) => marker.text), ["联网回答"]);
  const citations = harness.store.listResearchCitationsForMessages([output.id]);
  assert.equal(citations.length, 0);
  assert.deepEqual(run.citationAttribution?.attributions.map((item) => item.rejectionReasons), [
    ["source_not_admitted"],
    ["source_not_admitted", "source_content_unavailable"],
  ]);
  const view = service.getSession(session.id);
  assert.equal(view.groundingSources, undefined);
  assert.deepEqual(view.citations, []);
  const nodeView = new CaptureService(harness.store, join(harness.root, "artifacts"), undefined, {
    autoRunRecentOrganization: false,
    autoRunResearchTasks: false,
    autoRunResearchImports: false,
    autoRunResearchChapters: false,
  }).nodeGrowth.getNodeView(session.id);
  assert.equal(nodeView.groundingSources, undefined);
});

test("联网引用端点越过干净正文范围时不伪造精确位置", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const content = "结论来自本地优先。";
  const invalidStart = content.length + 5;
  const provider: ResearchGenerationProvider = {
    provider: "grounding-fake", model: "grounding-model",
    async *generate() { yield "ordinary fallback"; },
    async prepareGrounded() {
      return {
        kind: "confirmed_final" as const, content, status: "grounded", queries: [],
        sources: [{ title: "Source", url: "https://example.com/source" }],
        citations: [{ sourceOrdinal: 1, startOffset: invalidStart, endOffset: invalidStart + 4 }],
      };
    },
  };
  const service = new ResearchSessionService(harness.store, { provider, autoRunTasks: false });
  const session = await service.createSession("测试", "invalid-range-session");
  const turn = await service.submitMessage(session.id, "解释", "invalid-range-turn", { allowWebSearch: true });
  await service.processTask(turn.task.id);

  const output = harness.store.getResearchMessage(turn.task.outputMessageId);
  assert.equal(output?.content, content);
  assert.equal(harness.store.listResearchCitationsForMessages([turn.task.outputMessageId]).length, 0);
  assert.equal(service.getTask(turn.task.id).groundingScope?.citationCount, 0);
  assert.equal(harness.store.listResearchGroundingSources(service.getTask(turn.task.id).groundingScope!.runId!).length, 1);
  assert.equal(service.getSession(session.id).groundingSources, undefined);
});

test("供应商原生定位未进入最终上下文时只保留拒绝记录", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const provider: ResearchGenerationProvider = {
    provider: "agent-fake", model: "agent-model",
    async *generate() { yield "ordinary fallback"; },
    async prepareGrounded() {
      const content = "本地优先强调数据留在设备上。";
      const startOffset = content.indexOf("数据");
      return {
        kind: "confirmed_final" as const, content,
        status: "grounded", queries: ["本地优先"],
        sources: [{ title: "Source", url: "https://example.com/source", evidenceStatus: "full" }],
        citations: [{ sourceOrdinal: 1, startOffset, endOffset: startOffset + "数据留在设备上".length, providerCitationId: "native-1" }],
      };
    },
  };
  const service = new ResearchSessionService(harness.store, { provider, autoRunTasks: false });
  const session = await service.createSession("测试", "agent-citation-session");
  const turn = await service.submitMessage(session.id, "解释", "agent-citation-turn", { allowWebSearch: true });
  await service.processTask(turn.task.id);

  const output = harness.store.getResearchMessage(turn.task.outputMessageId);
  assert.equal(output?.content, "本地优先强调数据留在设备上。");
  const citation = harness.store.listResearchCitationsForMessages([turn.task.outputMessageId])[0];
  assert.equal(citation, undefined);
  const run = harness.store.listResearchGroundingRuns(turn.task.id)[0];
  assert.equal(run.citationAttribution?.attributions[0]?.candidateProducer.kind, "provider_native");
  assert.deepEqual(run.citationAttribution?.attributions[0]?.rejectionReasons, ["source_not_admitted", "source_content_unavailable"]);
});

test("仅证据的联网准备必须经独立最终写作，工作区文本永不写入正文", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const finalInputs: string[] = [];
  const finalAssemblies: unknown[] = [];
  const finalSources: unknown[] = [];
  const provider: ResearchGenerationProvider = {
    provider: "agent-fake", model: "agent-model",
    async *generate() { yield "ordinary fallback"; },
    async prepareGrounded() {
      return {
        kind: "evidence" as const,
        evidence: '{"sources":[{"sourceOrdinal":1,"evidence":"可回读的证据摘录。"}]}',
        status: "grounded", queries: ["查询"],
        sources: [{ title: "Source", url: "https://example.com/source", snippet: "可回读的证据摘录。", evidenceStatus: "partial" }], citations: [],
      };
    },
    async *writeGroundedFinalStream(request, evidence, options) {
      finalInputs.push(evidence);
      finalAssemblies.push(structuredClone(request.contextAssembly));
      finalSources.push(structuredClone(options.sources));
      options.onCitation?.({ sourceOrdinal: 1, startOffset: 0, endOffset: 12, providerCitationId: "provider-citation-1" });
      yield "这是独立最终";
      yield "写作的正文。";
      options.onStreamDone?.({ finishReason: "stop" });
    },
    attributeCitations: acceptNativeAttributions,
  };
  const service = new ResearchSessionService(harness.store, { provider, autoRunTasks: false });
  const session = await service.createSession("测试", "final-writer-session");
  const turn = await service.submitMessage(session.id, "解释", "final-writer-turn", { allowWebSearch: true });
  await service.processTask(turn.task.id);

  assert.deepEqual(finalInputs, ['{"sources":[{"sourceOrdinal":1,"evidence":"可回读的证据摘录。"}]}']);
  const finalAssembly = finalAssemblies[0] as { purpose?: string; adopted?: Array<{ candidate?: { channel?: string; evidenceKind?: string; ruleKind?: string; content?: string } }> };
  assert.equal(finalAssembly.purpose, "research_body");
  assert.ok(finalAssembly.adopted?.some((item) => item.candidate?.evidenceKind === "web_evidence"));
  assert.ok(finalAssembly.adopted?.some((item) => item.candidate?.ruleKind === "task_contract"));
  assert.deepEqual(finalSources, [[{
    sourceOrdinal: 1,
    title: "Source",
    url: "https://example.com/source",
    evidenceStatus: "partial",
  }]]);
  assert.equal(harness.store.getResearchMessage(turn.task.outputMessageId)?.content, "这是独立最终写作的正文。");
  const citation = harness.store.listResearchCitationsForMessages([turn.task.outputMessageId])[0];
  assert.equal(citation?.location?.exact, "这是独立最终写作的正文。");
  assert.equal(citation?.providerCitationId, "provider-citation-1");
  const sidecar = harness.store.listResearchSidecarRecords({ bodyVersionId: citation?.location?.bodyVersionId, kind: "citation" })[0];
  assert.equal(sidecar?.status, "ready");
  assert.equal(sidecar?.precision, "exact");
  assert.ok(harness.store.listResearchTaskEvents(turn.task.id).some((event) => event.type === "citation_candidate"));
  assert.equal(service.getTask(turn.task.id).status, "completed");
});

test("独立最终写作在 length 截断后从断点续写，仍只保存最终正文", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const resumes: Array<string | undefined> = [];
  let writes = 0;
  const provider: ResearchGenerationProvider = {
    provider: "agent-fake", model: "agent-model",
    async *generate() { yield "ordinary fallback"; },
    async prepareGrounded() {
      return { kind: "evidence" as const, evidence: "有界证据。", status: "grounded", queries: ["查询"], sources: [{ title: "Source", evidenceStatus: "full" }], citations: [] };
    },
    async *writeGroundedFinalStream(_request, _evidence, options) {
      resumes.push(options.resumeFrom);
      writes += 1;
      if (writes === 1) {
        yield "前半段";
        options.onStreamDone?.({ finishReason: "length" });
        return;
      }
      yield "，续写完成。";
      options.onStreamDone?.({ finishReason: "stop" });
    },
  };
  const service = new ResearchSessionService(harness.store, { provider, autoRunTasks: false });
  const session = await service.createSession("测试", "grounded-length-session");
  const turn = await service.submitMessage(session.id, "解释", "grounded-length-turn", { allowWebSearch: true });
  await service.processTask(turn.task.id);

  assert.equal(service.getTask(turn.task.id).status, "completed");
  assert.equal(harness.store.getResearchMessage(turn.task.outputMessageId)?.content, "前半段，续写完成。");
  assert.equal(writes, 2);
  assert.equal(resumes[1], "前半段", "续写携带同一最终回答前缀");
  assert.equal(service.getTask(turn.task.id).streamCheckpoint, undefined, "完成后清断点");
});

test("独立最终写作连续 length 超上限时失败为 partial，不派生切片或版本", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  let calls = 0;
  const provider: ResearchGenerationProvider = {
    provider: "agent-fake", model: "agent-model", async *generate() { yield "unused"; },
    async prepareGrounded() { return { kind: "evidence" as const, evidence: "证据", status: "grounded", queries: [], sources: [{ title: "S", evidenceStatus: "full" }], citations: [] }; },
    async *writeGroundedFinalStream(_request, _evidence, options) { calls += 1; yield `片段${calls}`; options.onStreamDone?.({ finishReason: "length" }); },
  };
  const service = new ResearchSessionService(harness.store, { provider, autoRunTasks: false });
  const session = await service.createSession("测试", "grounded-length-limit-session");
  const turn = await service.submitMessage(session.id, "解释", "grounded-length-limit-turn", { allowWebSearch: true });
  await service.processTask(turn.task.id);
  const task = service.getTask(turn.task.id);
  assert.equal(task.status, "failed");
  assert.equal(harness.store.getResearchMessage(turn.task.outputMessageId)?.content, "片段1片段2片段3片段4");
  assert.equal(harness.store.listSlicesByMessage(turn.task.outputMessageId).length, 0);
  assert.equal(harness.store.getBodyVersionForMessage(turn.task.outputMessageId), undefined);
});

test("独立最终写作暂停后重新取证并清空旧正文，来源和正文属于同一次尝试", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const evidences: string[] = [];
  let preparations = 0;
  let writes = 0;
  const provider: ResearchGenerationProvider = {
    provider: "agent-fake", model: "agent-model",
    async *generate() { yield "ordinary fallback"; },
    async prepareGrounded() {
      preparations += 1;
      const current = preparations === 1 ? "A" : "B";
      return { kind: "evidence" as const, evidence: `证据${current}。`, status: "grounded", queries: ["查询"], sources: [{ title: `Source ${current}`, snippet: `证据${current}。`, evidenceStatus: "full" }], citations: [] };
    },
    async *writeGroundedFinalStream(_request, _evidence, options) {
      evidences.push(_evidence);
      writes += 1;
      if (writes === 1) {
        options.onCitation?.({ sourceOrdinal: 1 });
        yield "已确认前缀。";
        await new Promise((resolve) => setTimeout(resolve, 35));
        yield "旧流不得写入。";
        return;
      }
      options.onCitation?.({ sourceOrdinal: 1, startOffset: 0, endOffset: 4 });
      yield "正文B。";
      options.onStreamDone?.({ finishReason: "stop" });
    },
    attributeCitations: acceptNativeAttributions,
  };
  const service = new ResearchSessionService(harness.store, { provider, autoRunTasks: false });
  const session = await service.createSession("测试", "grounded-pause-session");
  const turn = await service.submitMessage(session.id, "解释", "grounded-pause-turn", { allowWebSearch: true });
  const firstRun = service.processTask(turn.task.id);
  for (let i = 0; i < 200 && harness.store.getResearchMessage(turn.task.outputMessageId)?.content !== "已确认前缀。"; i++) await new Promise((r) => setImmediate(r));
  await service.pauseTask(turn.task.id);
  await firstRun;
  assert.equal(service.getTask(turn.task.id).status, "paused");
  assert.equal(harness.store.getResearchMessage(turn.task.outputMessageId)?.content, "已确认前缀。", "暂停后旧流增量不落库");
  assert.ok(harness.store.listResearchTaskEvents(turn.task.id).some((event) => event.type === "citation_candidate"), "暂停尝试已持久化粗粒度候选");

  await service.resumeTask(turn.task.id);
  assert.equal(harness.store.listResearchTaskEvents(turn.task.id).some((event) => event.type === "citation_candidate"), false, "重新取证清除旧尝试候选");
  await service.processTask(turn.task.id);
  assert.equal(service.getTask(turn.task.id).status, "completed");
  assert.equal(harness.store.getResearchMessage(turn.task.outputMessageId)?.content, "正文B。");
  assert.deepEqual(evidences, ["证据A。", "证据B。"]);
  const runId = service.getTask(turn.task.id).groundingScope?.runId;
  assert.equal(harness.store.listResearchGroundingSources(runId!)[0]?.title, "Source B");
  assert.equal(harness.store.listResearchCitationsForMessages([turn.task.outputMessageId])[0]?.location?.exact, "正文B。");
});

test("独立最终写作仅产生思考时暂停，恢复也会清空旧思考和事件后重新取证", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  let preparations = 0;
  const oldReasoning = "旧推理A".repeat(100);
  const provider: ResearchGenerationProvider = {
    provider: "agent-fake", model: "agent-model",
    async *generate() { yield "ordinary fallback"; },
    async prepareGrounded() {
      preparations += 1;
      const current = preparations === 1 ? "A" : "B";
      return { kind: "evidence" as const, evidence: `证据${current}。`, status: "grounded", queries: ["查询"], sources: [{ title: `Source ${current}`, evidenceStatus: "full" }], citations: [] };
    },
    async *writeGroundedFinalStream(_request, _evidence, options) {
      if (preparations === 1) {
        options.onReasoning?.(oldReasoning);
        await new Promise((resolve) => setTimeout(resolve, 35));
        yield "旧流不得写入。";
        return;
      }
      yield "正文B。";
      options.onStreamDone?.({ finishReason: "stop" });
    },
  };
  const service = new ResearchSessionService(harness.store, { provider, autoRunTasks: false });
  const session = await service.createSession("测试", "grounded-reasoning-pause-session");
  const turn = await service.submitMessage(session.id, "解释", "grounded-reasoning-pause-turn", { allowWebSearch: true });
  const firstRun = service.processTask(turn.task.id);
  for (let i = 0; i < 200 && harness.store.getResearchMessage(turn.task.outputMessageId)?.reasoning !== oldReasoning; i++) await new Promise((r) => setImmediate(r));
  assert.equal(harness.store.getResearchMessage(turn.task.outputMessageId)?.reasoning, oldReasoning);
  assert.ok(service.getTaskEvents(turn.task.id).length > 0, "暂停前已有旧尝试事件");
  await service.pauseTask(turn.task.id);
  await firstRun;

  await service.resumeTask(turn.task.id);
  assert.equal(harness.store.getResearchMessage(turn.task.outputMessageId)?.reasoning, undefined, "恢复入队时清空旧思考");
  assert.equal(service.getTaskEvents(turn.task.id).length, 0, "恢复入队时清空旧事件");
  await service.processTask(turn.task.id);

  assert.equal(service.getTask(turn.task.id).status, "completed");
  assert.equal(harness.store.getResearchMessage(turn.task.outputMessageId)?.content, "正文B。");
  assert.equal(harness.store.getResearchMessage(turn.task.outputMessageId)?.reasoning, undefined);
  assert.equal(preparations, 2);
});

test("Agent 证据最终写作暂停重启后遇到显式 think 协议，只保留新尝试的干净前缀", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  let preparations = 0;
  const provider: ResearchGenerationProvider = {
    provider: "agent-fake", model: "agent-model",
    async *generate() { yield "ordinary fallback"; },
    async prepareGrounded() {
      preparations += 1;
      const current = preparations === 1 ? "A" : "B";
      return { kind: "evidence" as const, evidence: `Agent 证据${current}。`, status: "grounded", queries: ["查询"], sources: [{ title: `Source ${current}`, evidenceStatus: "full" }], citations: [] };
    },
    async *writeGroundedFinalStream(_request, _evidence, options) {
      if (preparations === 1) {
        yield "来源A旧前缀。";
        await new Promise((resolve) => setTimeout(resolve, 35));
        yield "旧流不得写入。";
        return;
      }
      yield "来源B干净前缀。<think>匿名 Agent 草稿</think>";
      options.onStreamDone?.({ finishReason: "stop" });
    },
  };
  const service = new ResearchSessionService(harness.store, { provider, autoRunTasks: false });
  const session = await service.createSession("测试", "agent-protocol-pause-session");
  const turn = await service.submitMessage(session.id, "解释", "agent-protocol-pause-turn", { allowWebSearch: true });
  const firstRun = service.processTask(turn.task.id);
  for (let i = 0; i < 200 && harness.store.getResearchMessage(turn.task.outputMessageId)?.content !== "来源A旧前缀。"; i++) await new Promise((r) => setImmediate(r));
  await service.pauseTask(turn.task.id);
  await firstRun;

  await service.resumeTask(turn.task.id);
  await service.processTask(turn.task.id);

  assert.equal(service.getTask(turn.task.id).status, "failed");
  const message = harness.store.getResearchMessage(turn.task.outputMessageId);
  assert.equal(message?.content, "来源B干净前缀。");
  assert.doesNotMatch(message?.content ?? "", /来源A|think|匿名 Agent 草稿/);
  assert.equal(harness.store.listSlicesByMessage(turn.task.outputMessageId).length, 0);
  assert.equal(harness.store.getBodyVersionForMessage(turn.task.outputMessageId), undefined);
});

test("独立最终写作失败重试后重新取证并清空旧正文，来源和正文属于同一次尝试", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const evidences: string[] = [];
  let preparations = 0;
  let physicalWrites = 0;
  const provider: ResearchGenerationProvider = {
    provider: "agent-fake", model: "agent-model",
    async *generate() { yield "ordinary fallback"; },
    async prepareGrounded() {
      preparations += 1;
      const current = preparations === 1 ? "A" : "B";
      return { kind: "evidence" as const, evidence: `证据${current}。`, status: "grounded", queries: ["查询"], sources: [{ title: `Source ${current}`, evidenceStatus: "full" }], citations: [] };
    },
    async *writeGroundedFinalStream(_request, evidence, options) {
      evidences.push(evidence);
      physicalWrites += 1;
      if (preparations === 1) {
        if (physicalWrites === 1) yield "来源A的半篇正文。";
        throw new TypeError("simulated network interruption");
      }
      yield "正文B。";
      options.onStreamDone?.({ finishReason: "stop" });
    },
  };
  const service = new ResearchSessionService(harness.store, { provider, autoRunTasks: false, retrySleep: async () => {} });
  const session = await service.createSession("测试", "grounded-failure-retry-session");
  const turn = await service.submitMessage(session.id, "解释", "grounded-failure-retry-turn", { allowWebSearch: true });

  await service.processTask(turn.task.id);
  assert.equal(service.getTask(turn.task.id).status, "failed");
  assert.equal(harness.store.getResearchMessage(turn.task.outputMessageId)?.content, "来源A的半篇正文。");

  await service.retryTask(turn.task.id);
  assert.equal(harness.store.getResearchMessage(turn.task.outputMessageId)?.content, "", "重新取证前清空旧正文");
  assert.equal(service.getTask(turn.task.id).streamCheckpoint, undefined, "重新取证前清空旧断点");
  await service.processTask(turn.task.id);

  assert.equal(service.getTask(turn.task.id).status, "completed");
  assert.equal(harness.store.getResearchMessage(turn.task.outputMessageId)?.content, "正文B。");
  assert.equal(evidences.filter((item) => item.includes("证据A")).length, 4, "首次证据只用于该次有界物理重试");
  assert.equal(evidences.at(-1), "证据B。");
  const runId = service.getTask(turn.task.id).groundingScope?.runId;
  assert.equal(harness.store.listResearchGroundingSources(runId!)[0]?.title, "Source B");
});

test("仅证据最终写作不沿用原生草稿偏移，粗粒度候选留下拒绝记录", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const provider: ResearchGenerationProvider = {
    provider: "agent-fake", model: "agent-model",
    async *generate() { yield "unused"; },
    async prepareGrounded() {
      return { kind: "evidence" as const, evidence: "证据", status: "grounded", queries: [], sources: [{ title: "Source", evidenceStatus: "full" }], citations: [{ sourceOrdinal: 1, startOffset: 0, endOffset: 3 }] };
    },
    async *writeGroundedFinalStream(_request, _evidence, options) {
      options.onCitation?.({ sourceOrdinal: 1 });
      yield "不带来源标记的独立正文。";
      options.onStreamDone?.({ finishReason: "stop" });
    },
  };
  const service = new ResearchSessionService(harness.store, { provider, autoRunTasks: false });
  const session = await service.createSession("测试", "evidence-no-citation-session");
  const turn = await service.submitMessage(session.id, "解释", "evidence-no-citation-turn", { allowWebSearch: true });
  await service.processTask(turn.task.id);
  assert.equal(harness.store.listResearchCitationsForMessages([turn.task.outputMessageId]).length, 0);
  const runId = service.getTask(turn.task.id).groundingScope?.runId;
  assert.equal(harness.store.listResearchGroundingSources(runId!).length, 1);
  const candidateEvent = harness.store.listResearchTaskEvents(turn.task.id).find((event) => event.type === "citation_candidate");
  assert.deepEqual(candidateEvent?.type === "citation_candidate" ? candidateEvent.candidate : undefined, { sourceOrdinal: 1 });
  const run = harness.store.getResearchGroundingRun(runId!);
  assert.deepEqual(run?.citationAttribution?.attributions[0]?.rejectionReasons, ["source_not_admitted", "source_content_unavailable", "claim_range_missing"]);
});

test("结构化引用旁路去重重复候选，并保留同一来源支撑多处陈述", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const provider: ResearchGenerationProvider = {
    provider: "agent-fake", model: "agent-model",
    async *generate() { yield "unused"; },
    async prepareGrounded() {
      return {
        kind: "evidence" as const,
        evidence: '{"sources":[{"sourceOrdinal":1,"evidence":"证据"}]}',
        status: "grounded", queries: [],
        sources: [{ title: "Source", snippet: "证据", evidenceStatus: "full" }],
        citations: [],
      };
    },
    async *writeGroundedFinalStream(_request, _evidence, options) {
      options.onCitation?.({ sourceOrdinal: 1, startOffset: 0, endOffset: 4, providerCitationId: "c-1" });
      yield "第一句。";
      options.onCitation?.({ sourceOrdinal: 1, startOffset: 4, endOffset: 8, providerCitationId: "c-2" });
      options.onCitation?.({ sourceOrdinal: 1, startOffset: 0, endOffset: 4, providerCitationId: "c-1" });
      yield "第二句。";
      options.onStreamDone?.({ finishReason: "stop" });
    },
    attributeCitations: acceptNativeAttributions,
  };
  const service = new ResearchSessionService(harness.store, { provider, autoRunTasks: false });
  const session = await service.createSession("测试", "citation-repeat-session");
  const turn = await service.submitMessage(session.id, "解释", "citation-repeat-turn", { allowWebSearch: true });
  await service.processTask(turn.task.id);

  const citations = harness.store.listResearchCitationsForMessages([turn.task.outputMessageId]);
  assert.deepEqual(citations.map((citation) => citation.location?.exact), ["第一句。", "第二句。"]);
  assert.equal(new Set(citations.map((citation) => citation.sourceId)).size, 1);
  assert.equal(harness.store.listResearchSidecarRecords({ kind: "citation" }).length, 2);
});

test("已确认原生最终回答仍须经过正文准入边界", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const provider: ResearchGenerationProvider = {
    provider: "native-fake", model: "native-model",
    async *generate() { yield "ordinary fallback"; },
    async prepareGrounded() {
      return {
        kind: "confirmed_final" as const,
        content: "干净前缀。<think>不应展示</think>",
        status: "grounded", queries: [],
        sources: [{ title: "Source", url: "https://example.com/source" }],
        citations: [],
      };
    },
  };
  const service = new ResearchSessionService(harness.store, { provider, autoRunTasks: false });
  const session = await service.createSession("测试", "native-sink-session");
  const turn = await service.submitMessage(session.id, "解释", "native-sink-turn", { allowWebSearch: true });
  await service.processTask(turn.task.id);

  assert.equal(service.getTask(turn.task.id).status, "failed");
  assert.equal(harness.store.getResearchMessage(turn.task.outputMessageId)?.content, "干净前缀。");
});

test("已确认原生终稿按多个正文 delta 渐进发布，事件拼接与保存正文一致", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const content = `${"原生联网终稿按稳定小段渐进发布。".repeat(200)}`;
  const provider: ResearchGenerationProvider = {
    provider: "native-fake", model: "native-model",
    async *generate() { yield "ordinary fallback"; },
    async prepareGrounded() {
      return {
        kind: "confirmed_final" as const,
        content,
        status: "grounded", queries: [],
        sources: [{ title: "Source", url: "https://example.com/source" }],
        citations: [],
      };
    },
  };
  const service = new ResearchSessionService(harness.store, { provider, autoRunTasks: false });
  const session = await service.createSession("测试", "native-progressive-session");
  const turn = await service.submitMessage(session.id, "解释", "native-progressive-turn", { allowWebSearch: true });

  await service.processTask(turn.task.id);

  const deltas = service.getTaskEvents(turn.task.id)
    .filter((event) => event.type === "delta" && event.delta)
    .map((event) => event.type === "delta" ? event.delta : "");
  assert.ok(deltas.length > 1, "原生整篇终稿不得只产生一个正文 delta");
  assert.ok(deltas.length <= 32, "超长原生终稿的 delta 数必须有界，避免累计 SQLite 写放大");
  assert.equal(deltas.join(""), content);
  assert.equal(harness.store.getResearchMessage(turn.task.outputMessageId)?.content, content);
});

test("最终写作供应商错误不会把远端正文或凭证写进控制台", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const provider: ResearchGenerationProvider = {
    provider: "agent-fake", model: "agent-model",
    async *generate() { yield "unused"; },
    async prepareGrounded() {
      return {
        kind: "evidence" as const,
        evidence: "可追溯证据",
        status: "grounded", queries: [],
        sources: [{ title: "Source", url: "https://example.com/source", evidenceStatus: "full" }],
        citations: [],
      };
    },
    async *writeGroundedFinalStream() {
      throw new Error("token=secret 私人正文");
    },
  };
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    const service = new ResearchSessionService(harness.store, {
      provider,
      autoRunTasks: false,
      retrySleep: async () => undefined,
    });
    const session = await service.createSession("测试", "grounded-safe-log-session");
    const turn = await service.submitMessage(session.id, "解释", "grounded-safe-log-turn", { allowWebSearch: true });
    await service.processTask(turn.task.id);
    assert.equal(service.getTask(turn.task.id).status, "failed");
    const storedRun = harness.store.listResearchGroundingRuns(turn.task.id)[0];
    assert.equal(storedRun?.errorMessage, "联网核验失败（供应商错误）");
    const detail = new RunRecordsService(harness.store).get(`research:${turn.task.id}`);
    assert.ok(detail);
    assert.doesNotMatch(JSON.stringify(detail), /secret|私人正文|token=/);
  } finally {
    console.warn = originalWarn;
  }
  const output = warnings.join("\n");
  assert.match(output, /errorKind=provider/);
  assert.doesNotMatch(output, /secret|私人正文|token=/);
});

test("长文第二节协议污染清空 bodyPlan，重试从空正文重新完成", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  let outlines = 0;
  const provider: ResearchGenerationProvider = {
    provider: "long-fake", model: "long-model", async *generate() { yield "unused"; }, async writeBody() { return "fallback"; },
    async generateOutline() { outlines += 1; return { sections: [{ heading: "第一节", summary: "", targetChars: 10 }, { heading: "第二节", summary: "", targetChars: 10 }] }; },
    async expandSection(input) {
      if (outlines === 1 && input.sectionIndex === 1) return { content: "第二节前缀。<think>秘密</think>", finishReason: "stop" };
      return { content: input.sectionIndex === 0 ? "第一节新正文。" : "第二节新正文。", finishReason: "stop" };
    },
  };
  const service = new ResearchSessionService(harness.store, { provider, autoRunTasks: false });
  const session = await service.createSession("测试", "long-protocol-session");
  const turn = await service.submitMessage(session.id, "写一篇长文", "long-protocol-turn");
  await service.processTask(turn.task.id);
  assert.equal(service.getTask(turn.task.id).status, "failed");
  assert.equal(service.getTask(turn.task.id).bodyPlan?.sections.length, 0);
  assert.equal(harness.store.getResearchMessage(turn.task.outputMessageId)?.content, "## 第一节\n\n第一节新正文。\n\n## 第二节\n\n第二节前缀。");
  await service.retryTask(turn.task.id);
  await service.processTask(turn.task.id);
  assert.equal(service.getTask(turn.task.id).status, "completed");
  assert.equal(harness.store.getResearchMessage(turn.task.outputMessageId)?.content.includes("秘密"), false);
  assert.equal(outlines, 2, "重试重新生成大纲，不复用污染前完成节");
});

test("联网准备没有可追溯证据时诚实失败而不写工作区正文", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const provider: ResearchGenerationProvider = {
    provider: "agent-fake", model: "agent-model",
    async *generate() { yield "ordinary fallback"; },
    async prepareGrounded() {
      return { kind: "evidence" as const, evidence: "", status: "no_verifiable_sources", queries: [], sources: [], citations: [] };
    },
    async *writeGroundedFinalStream() { yield "不得调用"; },
  };
  const service = new ResearchSessionService(harness.store, { provider, autoRunTasks: false });
  const session = await service.createSession("测试", "empty-evidence-session");
  const turn = await service.submitMessage(session.id, "解释", "empty-evidence-turn", { allowWebSearch: true });
  await service.processTask(turn.task.id);

  assert.equal(service.getTask(turn.task.id).status, "failed");
  assert.equal(harness.store.getResearchMessage(turn.task.outputMessageId)?.content, "");
});

test("关闭联网开关时跳过 Agent 搜索并把任务标记为未请求联网", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  let groundedCalls = 0;
  let normalCalls = 0;
  const provider: ResearchGenerationProvider = {
    provider: "toggle-fake", model: "toggle-model", promptVersion: "toggle-test-v1",
    async *generate() {
      normalCalls += 1;
      yield "仅基于本地材料的回答";
    },
    async prepareGrounded() {
      groundedCalls += 1;
      throw new Error("联网搜索不应被调用");
    },
  };
  const service = new ResearchSessionService(harness.store, { provider, autoRunTasks: false });
  const session = await service.createSession("测试", "session-off-key");
  const turn = await service.submitMessage(session.id, "只看当前材料", "turn-off-key");

  assert.equal(turn.task.allowWebSearch, false);
  assert.deepEqual(turn.task.groundingScope, { status: "not_requested", sourceCount: 0, citationCount: 0 });
  await service.processTask(turn.task.id);

  const task = service.getTask(turn.task.id);
  assert.equal(task.status, "completed");
  assert.equal(task.groundingScope?.status, "not_requested");
  assert.equal(groundedCalls, 0);
  assert.equal(normalCalls, 1);
  assert.equal(harness.store.listResearchGroundingRuns(turn.task.id).length, 0);
});

test("用户开启联网但供应商没有联网实现时诚实标记为不支持", async (t) => {
  const harness = await createStore();
  t.after(() => harness.close());
  const provider: ResearchGenerationProvider = {
    provider: "unsupported-fake", model: "unsupported-model",
    async *generate() { yield "本地回答"; },
  };
  const service = new ResearchSessionService(harness.store, { provider, autoRunTasks: false });
  const session = await service.createSession("测试", "session-unsupported-key");
  const turn = await service.submitMessage(session.id, "允许联网但当前模型不支持", "turn-unsupported-key", { allowWebSearch: true });
  await service.processTask(turn.task.id);

  const task = service.getTask(turn.task.id);
  assert.equal(task.status, "completed");
  assert.equal(task.groundingScope?.status, "grounding_unsupported");
  assert.equal(harness.store.listResearchGroundingRuns(turn.task.id).length, 1);
});
