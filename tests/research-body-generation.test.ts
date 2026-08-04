import assert from "node:assert/strict";
import test from "node:test";
import { ModelGateway, parseBodyOutline, parseSliceAnnotation, type ModelProvider, type ModelProviderRequest } from "@collector/model-gateway";

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
  assert.equal(section, "该节扩写的正文段落。");
  assert.match(requests[0]?.prompt ?? "", /第 2 节「承」/);
  assert.match(requests[0]?.prompt ?? "", /第一节已写内容。/);
  assert.equal(requests[0]?.responseFormat, undefined);
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
