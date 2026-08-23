import assert from "node:assert/strict";
import test from "node:test";
import { ModelGateway, parseBodyOutline, parseSliceAnnotation, trimStream, type GroundingModelProvider, type ModelCallEvent, type ModelProvider, type ModelProviderRequest, type ModelProviderStreamEvent } from "@collector/model-gateway";

async function* toAsync(chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) yield chunk;
}

/** 记录每次 complete 请求、按 prompt 内容返回可编程响应的假供应商。 */
function makeProvider(respond: (request: ModelProviderRequest) => string): { provider: ModelProvider; requests: ModelProviderRequest[] } {
  const requests: ModelProviderRequest[] = [];
  const provider: ModelProvider = {
    name: "fake",
    async complete(request: ModelProviderRequest) {
      requests.push(request);
      return { model: request.model, content: respond(request) };
    },
  };
  return { provider, requests };
}

function assertUnifiedMentionContract(prompt: string): void {
  assert.match(prompt, /\[\[concept:concept-1:短语\]\]/);
  assert.match(prompt, /\[\[entity:entity-1:短语\]\]/);
  assert.match(prompt, /\[\[abbreviation:abbr-1:短语\]\]/);
  assert.match(prompt, /\[\[notation:notation-1:短语\]\]/);
  assert.match(prompt, /同一对象的重复提及必须复用同一个对象身份/);
  assert.match(prompt, /同名异义对象必须使用不同对象身份/);
}

test("writeResearchBody 以自由文本请求正文，不强制 JSON 输出", async () => {
  const { provider, requests } = makeProvider(() => "第一节连贯正文。\n\n第二节继续展开。");
  const gateway = new ModelGateway(provider);
  const body = await gateway.writeResearchBody([{ role: "user", content: "介绍本地优先软件" }]);
  assert.equal(body, "第一节连贯正文。\n\n第二节继续展开。");
  assert.equal(requests.length, 1);
  // 自由正文不携带 responseFormat，传输层不再强制 JSON。
  assert.equal(requests[0]?.responseFormat, undefined);
  assert.match(requests[0]?.prompt ?? "", /连贯、完整/);
});

test("T02：普通回答提示词收敛为连续行文，不再鼓励 ## 分节（#92）", async () => {
  const { provider, requests } = makeProvider(() => "连续正文。");
  const gateway = new ModelGateway(provider);
  await gateway.writeResearchBody([{ role: "user", content: "解释本地优先这个概念" }]);
  const prompt = requests[0]?.prompt ?? "";
  // 旧「需要分节时…二级标题」鼓励措辞整体移除。
  assert.doesNotMatch(prompt, /需要分节时/);
  assert.doesNotMatch(prompt, /二级标题/);
  // 新的连续行文约束在场。
  assert.match(prompt, /连续的行文/);
  assert.match(prompt, /不要用 Markdown 标题把内容拆成小节/);
  assert.match(prompt, /碎片化的小标题/);
  // 弱标记契约不受提示词收敛影响（四类对象与身份规则原样保留）。
  assertUnifiedMentionContract(prompt);
});

test("T02：长文扩写提示词保留首行 ## 节标题硬约束（#92）", async () => {
  const { provider, requests } = makeProvider(() => "## 引言\n\n本节正文。");
  const gateway = new ModelGateway(provider);
  const outline = parseBodyOutline(JSON.stringify({ sections: [{ heading: "引言", summary: "开端", targetChars: 500 }] }));
  await gateway.expandBodySection({ goal: "写一篇长文", outline, sectionIndex: 0, writtenSoFar: "" });
  const prompt = requests[0]?.prompt ?? "";
  assert.match(prompt, /第一行输出该节标题/);
  assert.match(prompt, /## 引言/);
});

test("research body prompt uses the four explainable-object types and stops mention markup at depth four", async () => {
  const shallow = makeProvider(() => "正文");
  const shallowGateway = new ModelGateway(shallow.provider);
  await shallowGateway.writeResearchBody([{ role: "user", content: "解释" }]);
  const shallowPrompt = shallow.requests[0]?.prompt ?? "";
  assert.match(shallowPrompt, /\[\[concept:concept-1:短语\]\]/);
  assert.match(shallowPrompt, /\[\[entity:entity-1:短语\]\]/);
  assert.match(shallowPrompt, /\[\[abbreviation:abbr-1:短语\]\]/);
  assert.match(shallowPrompt, /\[\[notation:notation-1:短语\]\]/);
  assert.match(shallowPrompt, /同一对象的重复提及必须复用同一个对象身份/);
  assert.match(shallowPrompt, /同名异义对象必须使用不同对象身份/);
  // 浅层（full 密度）：每段首次出现的重要概念应标尽标，完整标题不得拆成碎片。
  assert.match(shallowPrompt, /每个段落中首次出现的重要概念都要标记/);
  assert.match(shallowPrompt, /完整标题作为一个整体标记，不得拆成碎片/);

  for (const currentNodeDepth of [2, 3]) {
    const reduced = makeProvider(() => "短正文");
    const reducedGateway = new ModelGateway(reduced.provider);
    await reducedGateway.writeResearchBody([{ role: "user", content: "继续" }], {
      parentChainContext: {
        currentNodeDepth,
        ancestors: [{ depth: 1, isRoot: true, label: "根" }],
        truncated: false,
        cycleDetected: false,
      },
    });
    assert.match(reduced.requests[0]?.prompt ?? "", /最多标记 4 个/);
  }

  const deep = makeProvider(() => "正文");
  const deepGateway = new ModelGateway(deep.provider);
  await deepGateway.writeResearchBody([{ role: "user", content: "继续" }], {
    parentChainContext: {
      currentNodeDepth: 4,
      ancestors: [{ depth: 1, isRoot: true, label: "根" }],
      truncated: false,
      cycleDetected: false,
    },
  });
  assert.match(deep.requests[0]?.prompt ?? "", /不要输出任何 \[\[/);
});

test("answerResearchConversation 可按需关闭弱标记指令（术语预览路径）", async () => {
  // 术语预览显式关闭（mentionMarkup: false）：预览内容不经标记管线解析，
  // 注入指令只会让模型输出无法解析的原始控制串（#86 真实验收复现）。
  const parentChain = {
    currentNodeDepth: 1,
    ancestors: [{ depth: 1, isRoot: true, label: "Transformer 架构", coveredTerms: ["注意力机制"] }],
    truncated: false,
    cycleDetected: false,
  };
  const off = makeProvider(() => "预览解释正文");
  await new ModelGateway(off.provider).answerResearchConversation(
    [{ role: "user", content: "请解释当前回答中的概念" }],
    { mentionMarkup: false, parentChainContext: parentChain },
  );
  const offPrompt = off.requests[0]?.prompt ?? "";
  assert.doesNotMatch(offPrompt, /\[\[concept:/);
  assert.doesNotMatch(offPrompt, /重要概念都要标记/);
  // 父链去重规则同步省略标记措辞，但保留内容层面的"不要重复展开解释"。
  assert.doesNotMatch(offPrompt, /不要再为它们输出弱标记/);
  assert.match(offPrompt, /不要重复展开解释/);

  // 缺省行为不变：普通回答仍注入统一弱标记契约与完整的去重规则措辞。
  const on = makeProvider(() => "普通回答");
  await new ModelGateway(on.provider).answerResearchConversation(
    [{ role: "user", content: "解释" }],
    { parentChainContext: parentChain },
  );
  const onPrompt = on.requests[0]?.prompt ?? "";
  assert.match(onPrompt, /每个段落中首次出现的重要概念都要标记/);
  assert.match(onPrompt, /不要再为它们输出弱标记/);
});

test("普通回答、深研、长文分节与融合正文共用回答内弱标记契约", async () => {
  const regular = makeProvider(() => "普通回答");
  await new ModelGateway(regular.provider).answerResearchConversation([{ role: "user", content: "解释" }]);
  assertUnifiedMentionContract(regular.requests[0]?.prompt ?? "");

  const deepResearch = makeProvider(() => "深入研究回答");
  await new ModelGateway(deepResearch.provider).generateDeepResearchRound({
    mode: "branch",
    selectionText: "选区",
    direction: "继续研究",
  });
  assertUnifiedMentionContract(deepResearch.requests[0]?.prompt ?? "");

  const section = makeProvider(() => "分节正文");
  await new ModelGateway(section.provider).expandBodySection({
    goal: "写长文",
    outline: parseBodyOutline(JSON.stringify({ sections: [{ heading: "一", summary: "说明", targetChars: 500 }] })),
    sectionIndex: 0,
    writtenSoFar: "",
  });
  assertUnifiedMentionContract(section.requests[0]?.prompt ?? "");

  const fusion = makeProvider(() => "## 共同核心\n\n融合正文。[来源1]\n\n## 差异\n\n差异。[来源2]\n\n## 综合推导\n\n结论。");
  await new ModelGateway(fusion.provider).composeFusion({
    sources: [
      { nodeId: "a", title: "A", excerpt: "来源 A" },
      { nodeId: "b", title: "B", excerpt: "来源 B" },
    ],
    relationType: "contrast",
  });
  assertUnifiedMentionContract(fusion.requests[0]?.prompt ?? "");
});

test("原生联网请求由网关注入统一弱标记契约和深度规则", async () => {
  let prompt = "";
  const provider: GroundingModelProvider = {
    name: "grounded-fake",
    async complete() { throw new Error("complete should not be called"); },
    async generateGroundedResearch(request) {
      prompt = request.prompt;
      return { bodyKind: "confirmed_final", content: "联网回答", status: "grounded", queries: [], sources: [], citations: [] };
    },
  };
  const gateway = new ModelGateway(provider);
  await gateway.generateGroundedResearch("需要联网回答的问题", {
    taskId: "task-1",
    scenario: "chat",
    requireGrounding: true,
    promptVersion: "grounding-v1",
  }, { nodeDepth: 3 });

  assertUnifiedMentionContract(prompt);
  assert.match(prompt, /最多标记 4 个/);
});

test("generateBodyOutline 用 JSON 输出有序有界大纲", async () => {
  const { provider, requests } = makeProvider(() => JSON.stringify({
    sections: [
      { heading: "起源", summary: "概念起源", targetChars: 600 },
      { heading: "实践", summary: "落地方式", targetChars: 800 },
    ],
  }));
  const gateway = new ModelGateway(provider);
  const outline = await gateway.generateBodyOutline([{ role: "user", content: "写一篇长文" }]);
  assert.equal(outline.sections.length, 2);
  assert.equal(outline.sections[0]?.heading, "起源");
  // 大纲是程序消费的结构数据，保留 JSON 输出格式。
  assert.deepEqual(requests[0]?.responseFormat, { type: "json_object" });
});

test("expandBodySection 串行扩写指定节并携带前文以保持连贯", async () => {
  const { provider, requests } = makeProvider(() => "该节扩写的正文段落。");
  const gateway = new ModelGateway(provider);
  const outline = parseBodyOutline(JSON.stringify({ sections: [{ heading: "起", summary: "开端", targetChars: 500 }, { heading: "承", summary: "发展", targetChars: 500 }] }));
  const section = await gateway.expandBodySection({ goal: "写长文", outline, sectionIndex: 1, writtenSoFar: "第一节已写内容。" });
  assert.equal(section.content, "该节扩写的正文段落。");
  assert.match(requests[0]?.prompt ?? "", /第 2 节「承」/);
  assert.match(requests[0]?.prompt ?? "", /第一节已写内容。/);
  assert.equal(requests[0]?.responseFormat, undefined);
});

test("expandBodySection 续写模式携带断点前文尾部且不重发节标题", async () => {
  const { provider, requests } = makeProvider(() => "续写补上的后半段。");
  const gateway = new ModelGateway(provider);
  const outline = parseBodyOutline(JSON.stringify({ sections: [{ heading: "起", summary: "开端", targetChars: 500 }] }));
  const prior = "前半段正文。".repeat(60); // 长度 > 500，验证只取尾部
  const result = await gateway.expandBodySection({ goal: "g", outline, sectionIndex: 0, writtenSoFar: "", continuation: { priorSectionContent: prior } });
  assert.equal(result.content, "续写补上的后半段。");
  const prompt = requests[0]?.prompt ?? "";
  // 断点前文尾部（后 500 字）进入提示。
  assert.ok(prompt.includes(prior.slice(-500)), "提示应携带断点前文尾部");
  // 续写不再要求重发节标题（提示结构，非具体措辞）。
  assert.ok(!prompt.includes("第一行输出该节标题"), "续写不应再要求输出节标题");
});

test("expandBodySection repairHint 写入上次失败原因并直接要求正文", async () => {
  const { provider, requests } = makeProvider(() => "修复后的节正文。");
  const gateway = new ModelGateway(provider);
  const outline = parseBodyOutline(JSON.stringify({ sections: [{ heading: "起", summary: "开端", targetChars: 500 }] }));
  await gateway.expandBodySection({ goal: "g", outline, sectionIndex: 0, writtenSoFar: "", repairHint: "上次输出为空" });
  assert.ok((requests[0]?.prompt ?? "").includes("上次输出为空"), "提示应携带修复提示");
});

test("expandBodySection targetCharsOverride 下调目标字数用于降级重试", async () => {
  const { provider, requests } = makeProvider(() => "降级后的节正文。");
  const gateway = new ModelGateway(provider);
  const outline = parseBodyOutline(JSON.stringify({ sections: [{ heading: "起", summary: "开端", targetChars: 800 }] }));
  await gateway.expandBodySection({ goal: "g", outline, sectionIndex: 0, writtenSoFar: "", targetCharsOverride: 400 });
  assert.ok((requests[0]?.prompt ?? "").includes("400"), "提示应使用下调后的目标字数");
  assert.ok(!(requests[0]?.prompt ?? "").includes("800"), "提示不应再用原目标字数");
});

test("expandBodySection 对越界节抛错", async () => {
  const { provider } = makeProvider(() => "");
  const gateway = new ModelGateway(provider);
  const outline = parseBodyOutline(JSON.stringify({ sections: [{ heading: "起", summary: "开端", targetChars: 500 }] }));
  await assert.rejects(() => gateway.expandBodySection({ goal: "g", outline, sectionIndex: 5, writtenSoFar: "" }), /out of range/);
});

test("deriveSliceAnnotations 以 temperature=0 抽取标题与概念", async () => {
  const { provider, requests } = makeProvider(() => JSON.stringify({ title: "本地优先", concepts: ["本地优先", "数据主权"] }));
  const gateway = new ModelGateway(provider);
  const annotation = await gateway.deriveSliceAnnotations({ content: "本地优先让数据留在用户环境。" });
  assert.deepEqual(annotation, { title: "本地优先", concepts: ["本地优先", "数据主权"] });
  assert.equal(requests[0]?.temperature, 0);
  assert.deepEqual(requests[0]?.responseFormat, { type: "json_object" });
});

test("deriveSliceAnnotations 对空内容直接返回空标注、不调模型", async () => {
  const { provider, requests } = makeProvider(() => "unreachable");
  const gateway = new ModelGateway(provider);
  const annotation = await gateway.deriveSliceAnnotations({ content: "   " });
  assert.deepEqual(annotation, { title: "", concepts: [] });
  assert.equal(requests.length, 0);
});

test("verifyTermIdentity performs a bounded deterministic context check", async () => {
  const { provider, requests } = makeProvider(() => JSON.stringify({ sameEntity: true }));
  const gateway = new ModelGateway(provider);
  const sameEntity = await gateway.verifyTermIdentity({
    left: { text: "REST", category: "abbreviation", context: `${"左".repeat(700)}LEFT_SECRET` },
    right: { text: "REST", category: "abbreviation", context: `${"右".repeat(700)}RIGHT_SECRET` },
  });

  assert.equal(sameEntity, true);
  assert.equal(requests[0]?.temperature, 0);
  assert.deepEqual(requests[0]?.responseFormat, { type: "json_object" });
  assert.doesNotMatch(requests[0]?.prompt ?? "", /LEFT_SECRET|RIGHT_SECRET/);
  assert.match(requests[0]?.prompt ?? "", /只有指向同一对象才返回 true/);
});

test("parseBodyOutline 限制节数上限并拒绝空标题节", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ heading: `节${i}`, summary: "s", targetChars: 100 }));
  const outline = parseBodyOutline(JSON.stringify({ sections: many }));
  assert.equal(outline.sections.length, 12);
  assert.throws(() => parseBodyOutline(JSON.stringify({ sections: [{ heading: "  ", summary: "s", targetChars: 1 }] })), /non-empty heading/);
  assert.throws(() => parseBodyOutline(JSON.stringify({ sections: [] })), /non-empty sections/);
});

test("parseSliceAnnotation 截断超长标题与概念并过滤空概念", () => {
  const annotation = parseSliceAnnotation(JSON.stringify({ title: "x".repeat(300), concepts: ["有效", "", "  ", "也有效"] }));
  assert.equal(annotation.title.length, 200);
  assert.deepEqual(annotation.concepts, ["有效", "也有效"]);
});

/** 可编程的流式假供应商：completeStream 产出给定事件序列。 */
function makeStreamProvider(events: ModelProviderStreamEvent[]): { provider: ModelProvider; requests: ModelProviderRequest[] } {
  const requests: ModelProviderRequest[] = [];
  const provider: ModelProvider = {
    name: "fake-stream",
    async complete() {
      throw new Error("complete() should not be called on a streaming provider");
    },
    async *completeStream(request: ModelProviderRequest) {
      requests.push(request);
      yield* events;
    },
  };
  return { provider, requests };
}

test("writeResearchBodyStream 逐字产出 delta、done 帧 usage 恰好一次记账", async () => {
  const { provider } = makeStreamProvider([
    { type: "delta", text: "第一段连贯正文。" },
    { type: "delta", text: "\n\n第二段继续。" },
    { type: "done", model: "stream-model", usage: { inputTokens: 12, outputTokens: 34 } },
  ]);
  const calls: ModelCallEvent[] = [];
  const gateway = new ModelGateway(provider, { onCall: (event) => { calls.push(event); } });
  const chunks: string[] = [];
  for await (const delta of gateway.writeResearchBodyStream([{ role: "user", content: "介绍本地优先" }])) chunks.push(delta);
  assert.equal(chunks.join(""), "第一段连贯正文。\n\n第二段继续。");
  // 记账恰好一次，且带 done 帧的 usage/model。
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.status, "completed");
  assert.equal(calls[0]?.model, "stream-model");
  assert.deepEqual(calls[0]?.usage, { inputTokens: 12, outputTokens: 34 });
});

test("writeResearchBodyStream 对无 completeStream 的 provider 退回非流式单发", async () => {
  const { provider, requests } = makeProvider(() => "原子正文。");
  const calls: ModelCallEvent[] = [];
  const gateway = new ModelGateway(provider, { onCall: (event) => { calls.push(event); } });
  const chunks: string[] = [];
  for await (const delta of gateway.writeResearchBodyStream([{ role: "user", content: "问题" }])) chunks.push(delta);
  assert.deepEqual(chunks, ["原子正文。"]);
  assert.equal(requests.length, 1);
  // 回退路径走 complete() 自带记账，仍恰好一次。
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.status, "completed");
});

test("writeResearchBodyStream resumeFrom 追加续写提示且 onDone 回报 finishReason", async () => {
  const { provider, requests } = makeStreamProvider([
    { type: "delta", text: "续写的后半正文。" },
    { type: "done", model: "m", usage: { inputTokens: 1, outputTokens: 2 }, finishReason: "length" },
  ]);
  const gateway = new ModelGateway(provider);
  const doneReports: Array<{ finishReason?: string }> = [];
  const chunks: string[] = [];
  for await (const delta of gateway.writeResearchBodyStream(
    [{ role: "user", content: "问题" }],
    { resumeFrom: "已写正文尾部衔接。", onDone: (done) => { doneReports.push(done); } },
  )) chunks.push(delta);
  assert.equal(chunks.join(""), "续写的后半正文。");
  // resumeFrom 尾部进入提示（结构，不断言具体措辞）。
  assert.ok((requests[0]?.prompt ?? "").includes("已写正文尾部衔接。"), "提示应携带断点前文");
  assert.deepEqual(doneReports, [{ finishReason: "length" }], "onDone 应回报终帧 finishReason");
});

test("writeResearchBodyStream 流式产出空正文时抛错并记失败", async () => {
  const { provider } = makeStreamProvider([{ type: "done", model: "m", usage: undefined }]);
  const calls: ModelCallEvent[] = [];
  const gateway = new ModelGateway(provider, { onCall: (event) => { calls.push(event); } });
  await assert.rejects(async () => {
    for await (const _ of gateway.writeResearchBodyStream([{ role: "user", content: "问题" }])) { /* drain */ }
  }, /empty body/);
});

test("trimStream 保证 concat(输出) === concat(输入).trim()", async () => {
  const cases: string[][] = [
    ["  前导空白"],
    ["尾随空白  "],
    ["  两侧都有  "],
    ["第一段", "\n\n", "第二段"],
    ["  ", "中段内容", "  "],
    ["跨块尾随：", "  更多", "  "],
    ["无空白"],
  ];
  for (const chunks of cases) {
    const out: string[] = [];
    for await (const piece of trimStream(toAsync(chunks))) out.push(piece);
    assert.equal(out.join(""), chunks.join("").trim(), `case ${JSON.stringify(chunks)}`);
  }
  // 内部段落分隔 \n\n 原样保留。
  const inner: string[] = [];
  for await (const piece of trimStream(toAsync(["甲", "\n\n", "乙"]))) inner.push(piece);
  assert.equal(inner.join(""), "甲\n\n乙");
});
