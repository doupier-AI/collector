import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelGateway,
  FakeProvider,
  type AgentChatMessage,
  type AgentChatResponse,
  type ToolDefinition,
} from "@collector/model-gateway";

/** 可编程的 FakeProvider，同时支持 complete() 和 agentChat()，用于测试 Agent 循环。 */
class ProgrammableAgentProvider extends FakeProvider {
  private agentChatResponses: AgentChatResponse[] = [];
  private agentCallCount = 0;
  readonly systemPrompts: string[] = [];

  constructor() {
    super([]);
  }

  /** 按调用顺序返回预设的 AgentChatResponse */
  setAgentChatSequence(responses: AgentChatResponse[]) {
    this.agentChatResponses = [...responses];
    this.agentCallCount = 0;
  }

  getAgentChatCallCount(): number {
    return this.agentCallCount;
  }

  async agentChat(
    messages: AgentChatMessage[],
    _tools: ToolDefinition[],
    _options: unknown,
  ): Promise<AgentChatResponse> {
    if (typeof messages[0]?.content === "string") this.systemPrompts.push(messages[0].content);
    if (this.agentCallCount >= this.agentChatResponses.length) {
      throw new Error(`Unexpected agentChat call #${this.agentCallCount} (only ${this.agentChatResponses.length} responses provided)`);
    }
    return this.agentChatResponses[this.agentCallCount++];
  }
}

/** 创建带可编程 provider 的 ModelGateway，用于注入到 runAgentSearchLoop。 */
function createTestGateway(provider: ProgrammableAgentProvider) {
  return new ModelGateway(provider as any, { model: "test-model", thinking: false });
}

/** 简化的工具上下文：内存中记录搜索/抓取调用并返回假数据。 */
function createTestTools() {
  const searchCalls: Array<{ query: string; maxResults: number }> = [];
  const fetchCalls: Array<{ url: string }> = [];
  const mockSearchResults = new Map<string, Array<{ title: string; url: string; snippet: string }>>();

  return {
    searchCalls,
    fetchCalls,
    mockSearchResults,
    tools: {
      webSearch: async (query: string, maxResults: number) => {
        searchCalls.push({ query, maxResults });
        const results = mockSearchResults.get(query) ?? [
          { title: "Test Result", url: `https://example.com/test?q=${encodeURIComponent(query)}`, snippet: `Snippet for ${query}` },
        ];
        return { query, total_results: results.length, results };
      },
      webFetch: async (url: string): Promise<{ url: string; content: string; errorMessage?: string }> => {
        fetchCalls.push({ url });
        return { url, content: `Full content of ${url}` };
      },
    },
  };
}

// ── 单轮搜索 → 直接回答 ──

test("agent loop: single turn — model searches once then answers", async () => {
  const provider = new ProgrammableAgentProvider();
  provider.setAgentChatSequence([
    {
      finishReason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        toolCalls: [{
          id: "tc-1",
          type: "function" as const,
          function: { name: "web_search", arguments: JSON.stringify({ query: "AI 技术", maxResults: 3 }) },
        }],
      },
      model: "test-model",
    },
    {
      finishReason: "stop",
      message: { role: "assistant", content: "根据搜索，AI 技术正在快速发展[来源1]。" },
      model: "test-model",
    },
  ]);

  const gateway = createTestGateway(provider);
  const { tools, searchCalls } = createTestTools();

  const result = await gateway.runAgentSearchLoop("最近 AI 技术进展", tools);

  assert.equal(provider.getAgentChatCallCount(), 2);
  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0].query, "AI 技术");
  assert.equal(result.queries.length, 1);
  assert.equal(result.queries[0], "AI 技术");
  assert.equal(result.sources.length, 1);
  assert.ok(result.content.includes("[来源1]"));
  assert.match(provider.systemPrompts[0] ?? "", /\[\[concept:concept-1:短语\]\]/);
  assert.match(provider.systemPrompts[0] ?? "", /同名异义对象必须使用不同对象身份/);
});

// ── 搜索 → 抓取 → 回答（两轮工具调用） ──

test("agent loop: search then fetch then answer", async () => {
  const provider = new ProgrammableAgentProvider();
  provider.setAgentChatSequence([
    {
      finishReason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        toolCalls: [{
          id: "tc-s1",
          type: "function" as const,
          function: { name: "web_search", arguments: JSON.stringify({ query: "TypeScript 5.8 新特性" }) },
        }],
      },
      model: "test-model",
    },
    {
      finishReason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        toolCalls: [{
          id: "tc-f1",
          type: "function" as const,
          function: { name: "web_fetch", arguments: JSON.stringify({ url: "https://example.com/test?q=TypeScript%205.8%20%E6%96%B0%E7%89%B9%E6%80%A7" }) },
        }],
      },
      model: "test-model",
    },
    {
      finishReason: "stop",
      message: { role: "assistant", content: "TypeScript 5.8 新增了诸多特性[来源1]。" },
      model: "test-model",
    },
  ]);

  const gateway = createTestGateway(provider);
  const { tools, searchCalls, fetchCalls } = createTestTools();

  const result = await gateway.runAgentSearchLoop("TypeScript 新版本有什么", tools);

  assert.equal(provider.getAgentChatCallCount(), 3);
  assert.equal(searchCalls.length, 1);
  assert.equal(fetchCalls.length, 1);
  assert.equal(result.queries.length, 1);
  assert.equal(result.sources.length, 1);
});

// ── 多轮换词重搜 ──

test("agent loop: re-search with different query when first attempt insufficient", async () => {
  const provider = new ProgrammableAgentProvider();
  provider.setAgentChatSequence([
    // First search
    {
      finishReason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        toolCalls: [{
          id: "tc-1",
          type: "function" as const,
          function: { name: "web_search", arguments: JSON.stringify({ query: "Python 性能" }) },
        }],
      },
      model: "test-model",
    },
    // Fetch one result
    {
      finishReason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        toolCalls: [{
          id: "tc-2",
          type: "function" as const,
          function: { name: "web_fetch", arguments: JSON.stringify({ url: "https://example.com/test?q=Python%20%E6%80%A7%E8%83%BD" }) },
        }],
      },
      model: "test-model",
    },
    // Not satisfied — re-search with different query
    {
      finishReason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        toolCalls: [{
          id: "tc-3",
          type: "function" as const,
          function: { name: "web_search", arguments: JSON.stringify({ query: "Python 性能优化 技巧" }) },
        }],
      },
      model: "test-model",
    },
    // Answer with all sources
    {
      finishReason: "stop",
      message: { role: "assistant", content: "Python 性能可以通过多种方式优化[来源1][来源2]。" },
      model: "test-model",
    },
  ]);

  const gateway = createTestGateway(provider);
  const { tools, searchCalls, mockSearchResults } = createTestTools();
  mockSearchResults.set("Python 性能优化 技巧", [
    { title: "Optimization Tips", url: "https://example.com/opt", snippet: "Performance optimization tips" },
  ]);

  const result = await gateway.runAgentSearchLoop("Python 怎么写更快", tools);

  assert.equal(searchCalls.length, 2);
  assert.equal(searchCalls[0].query, "Python 性能");
  assert.equal(searchCalls[1].query, "Python 性能优化 技巧");
  assert.equal(result.queries.length, 2);
  // Two unique URLs from two searches → 2 sources
  assert.equal(result.sources.length, 2);
  assert.ok(result.content.includes("[来源1]"));
  assert.ok(result.content.includes("[来源2]"));
});

// ── 搜索上限：第五次后被阻止 ──

test("agent loop: search cap at 5 — further searches blocked", async () => {
  const provider = new ProgrammableAgentProvider();
  const responses: AgentChatResponse[] = [];
  // Generate 6 web_search calls (the 6th should be blocked)
  for (let i = 0; i < 6; i++) {
    responses.push({
      finishReason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        toolCalls: [{
          id: `tc-${i}`,
          type: "function" as const,
          function: { name: "web_search", arguments: JSON.stringify({ query: `search query ${i}` }) },
        }],
      },
      model: "test-model",
    });
  }
  // The 6th search is blocked, so the model gets a "stop" message — it should then answer
  responses.push({
    finishReason: "stop",
    message: { role: "assistant", content: "基于已有信息，这里是我的回答[来源1]。" },
    model: "test-model",
  });
  provider.setAgentChatSequence(responses);

  const gateway = createTestGateway(provider);
  const { tools, searchCalls } = createTestTools();

  const result = await gateway.runAgentSearchLoop("test", tools);

  // Only 5 searches actually executed
  assert.equal(searchCalls.length, 5);
  assert.equal(result.queries.length, 5);
  assert.ok(result.content.length > 0);
});

// ── 空 tool_calls（模型直接回答，无工具调用） ──

test("agent loop: model answers immediately without calling any tools", async () => {
  const provider = new ProgrammableAgentProvider();
  provider.setAgentChatSequence([
    {
      finishReason: "stop",
      message: { role: "assistant", content: "这是一个不需要搜索的问题。" },
      model: "test-model",
    },
  ]);

  const gateway = createTestGateway(provider);
  const { tools, searchCalls } = createTestTools();

  const result = await gateway.runAgentSearchLoop("你好", tools);

  assert.equal(provider.getAgentChatCallCount(), 1);
  assert.equal(searchCalls.length, 0);
  assert.equal(result.queries.length, 0);
  assert.equal(result.sources.length, 0);
  assert.ok(result.content.length > 0);
});

// ── 多工具并行（同一轮调用 web_search + web_fetch） ──

test("agent loop: parallel tool calls in same turn", async () => {
  const provider = new ProgrammableAgentProvider();
  provider.setAgentChatSequence([
    {
      finishReason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "tc-s1",
            type: "function" as const,
            function: { name: "web_search", arguments: JSON.stringify({ query: "React 19" }) },
          },
          {
            id: "tc-f1",
            type: "function" as const,
            function: { name: "web_fetch", arguments: JSON.stringify({ url: "https://react.dev" }) },
          },
        ],
      },
      model: "test-model",
    },
    {
      finishReason: "stop",
      message: { role: "assistant", content: "React 19 带来了许多改进[来源1]。" },
      model: "test-model",
    },
  ]);

  const gateway = createTestGateway(provider);
  const { tools, searchCalls, fetchCalls } = createTestTools();

  const result = await gateway.runAgentSearchLoop("React 最新版本", tools);

  assert.equal(searchCalls.length, 1);
  assert.equal(fetchCalls.length, 1);
  // Both should execute in the same turn
  assert.equal(result.queries.length, 1);
});

// ── URL 去重：同一 URL 出现在两次搜索中 ──

test("agent loop: URL deduplication across multiple searches", async () => {
  const provider = new ProgrammableAgentProvider();
  const overlappingUrl = "https://example.com/shared-page";
  provider.setAgentChatSequence([
    {
      finishReason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        toolCalls: [{
          id: "tc-1",
          type: "function" as const,
          function: { name: "web_search", arguments: JSON.stringify({ query: "first" }) },
        }],
      },
      model: "test-model",
    },
    {
      finishReason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        toolCalls: [{
          id: "tc-2",
          type: "function" as const,
          function: { name: "web_search", arguments: JSON.stringify({ query: "second" }) },
        }],
      },
      model: "test-model",
    },
    {
      finishReason: "stop",
      message: { role: "assistant", content: "回答包含[来源1][来源2][来源3]。" },
      model: "test-model",
    },
  ]);

  const gateway = createTestGateway(provider);
  const { tools, searchCalls, mockSearchResults } = createTestTools();
  mockSearchResults.set("first", [
    { title: "Unique A", url: "https://example.com/unique-a", snippet: "A" },
    { title: "Shared Page", url: overlappingUrl, snippet: "Shared" },
  ]);
  mockSearchResults.set("second", [
    { title: "Unique B", url: "https://example.com/unique-b", snippet: "B" },
    { title: "Shared Page", url: overlappingUrl, snippet: "Shared" },
  ]);

  const result = await gateway.runAgentSearchLoop("test", tools);

  assert.equal(searchCalls.length, 2);
  // 2 unique URLs + 1 shared = 3 total unique sources (not 4)
  assert.equal(result.sources.length, 3);
});

// ── finishReason "length" 触发 continue 逻辑 ──

test("agent loop: length finish reason triggers wrap-up push", async () => {
  const provider = new ProgrammableAgentProvider();
  provider.setAgentChatSequence([
    {
      finishReason: "length",
      message: { role: "assistant", content: "部分回答了问题但未完成" },
      model: "test-model",
    },
    {
      finishReason: "stop",
      message: { role: "assistant", content: "基于已有信息给出简要回答。" },
      model: "test-model",
    },
  ]);

  const gateway = createTestGateway(provider);
  const { tools } = createTestTools();

  const result = await gateway.runAgentSearchLoop("test", tools);

  assert.ok(result.content.length > 0);
});

// ── 搜索上限后与 web_fetch 共存 ──

test("agent loop: web_fetch still works after search cap reached", async () => {
  const provider = new ProgrammableAgentProvider();
  // First 5 calls: web_search (fills the cap)
  const responses: AgentChatResponse[] = [];
  for (let i = 1; i <= 5; i++) {
    responses.push({
      finishReason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        toolCalls: [{
          id: `tc-s${i}`,
          type: "function" as const,
          function: { name: "web_search", arguments: JSON.stringify({ query: `q${i}` }) },
        }],
      },
      model: "test-model",
    });
  }
  // Turn 6: model tries another web_search (blocked) + web_fetch (allowed)
  responses.push({
    finishReason: "tool_calls",
    message: {
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "tc-s6",
          type: "function" as const,
          function: { name: "web_search", arguments: JSON.stringify({ query: "q6" }) },
        },
        {
          id: "tc-f1",
          type: "function" as const,
          function: { name: "web_fetch", arguments: JSON.stringify({ url: "https://example.com/test?q=q1" }) },
        },
      ],
    },
    model: "test-model",
  });
  // Turn 7: model answers
  responses.push({
    finishReason: "stop",
    message: { role: "assistant", content: "回答[来源1]。" },
    model: "test-model",
  });
  provider.setAgentChatSequence(responses);

  const gateway = createTestGateway(provider);
  const { tools, searchCalls, fetchCalls } = createTestTools();

  const result = await gateway.runAgentSearchLoop("test", tools);

  // 5 searches executed (6th blocked) + 1 fetch executed
  assert.equal(searchCalls.length, 5);
  assert.equal(fetchCalls.length, 1);
  assert.equal(result.queries.length, 5);
  assert.ok(result.content.length > 0);
});

// ── #49 部分证据：抓取失败但搜索摘要可作依据 ──

test("agent loop: failed fetch with snippet injects marked partial evidence into tool message", async () => {
  const provider = new ProgrammableAgentProvider();
  const failedUrl = "https://example.com/blocked-page";
  const toolMessagesSeen: string[] = [];
  provider.setAgentChatSequence([
    {
      finishReason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        toolCalls: [{
          id: "tc-s1",
          type: "function" as const,
          function: { name: "web_search", arguments: JSON.stringify({ query: "测试关键词" }) },
        }],
      },
      model: "test-model",
    },
    {
      finishReason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        toolCalls: [{
          id: "tc-f1",
          type: "function" as const,
          function: { name: "web_fetch", arguments: JSON.stringify({ url: failedUrl }) },
        }],
      },
      model: "test-model",
    },
    {
      finishReason: "stop",
      message: { role: "assistant", content: "结论基于摘要[来源1]。" },
      model: "test-model",
    },
  ]);

  const gateway = createTestGateway(provider);
  const { tools, mockSearchResults } = createTestTools();
  mockSearchResults.set("测试关键词", [
    { title: "Blocked Page", url: failedUrl, snippet: "这是搜索摘要内容" },
  ]);
  tools.webFetch = async (url: string) => {
    assert.equal(url, failedUrl);
    return { url, content: "", errorMessage: "页面疑似验证码或付费墙（内容被拦截）" };
  };
  // 捕获每次 agentChat 收到的完整消息历史，用于断言工具返回内容
  const originalAgentChat = provider.agentChat.bind(provider);
  provider.agentChat = async (messages, _tools, _options) => {
    for (const message of messages) {
      if (message.role === "tool" && typeof message.content === "string") toolMessagesSeen.push(message.content);
    }
    return originalAgentChat(messages, _tools as ToolDefinition[], _options);
  };

  const result = await gateway.runAgentSearchLoop("测试", tools);

  // 部分证据块被注入到 web_fetch 的工具返回中
  const partialMessage = toolMessagesSeen.find((text) => text.includes("部分证据（搜索摘要）"));
  assert.ok(partialMessage, "tool message contains partial evidence marker");
  assert.ok(partialMessage?.includes("这是搜索摘要内容"), "snippet content included");
  assert.ok(partialMessage?.includes("抓取失败"), "failure reason included");
  // sources[0] 被标记为 partial（搜索摘要）
  assert.equal(result.sources[0].evidenceStatus, "partial");
});

// ── #49 抓取成功：来源升级为 full ──

test("agent loop: successful fetch upgrades source evidenceStatus to full", async () => {
  const provider = new ProgrammableAgentProvider();
  provider.setAgentChatSequence([
    {
      finishReason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        toolCalls: [{
          id: "tc-s1",
          type: "function" as const,
          function: { name: "web_search", arguments: JSON.stringify({ query: "test" }) },
        }],
      },
      model: "test-model",
    },
    {
      finishReason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        toolCalls: [{
          id: "tc-f1",
          type: "function" as const,
          function: { name: "web_fetch", arguments: JSON.stringify({ url: "https://example.com/test?q=test" }) },
        }],
      },
      model: "test-model",
    },
    {
      finishReason: "stop",
      message: { role: "assistant", content: "回答[来源1]。" },
      model: "test-model",
    },
  ]);

  const gateway = createTestGateway(provider);
  const { tools } = createTestTools();

  const result = await gateway.runAgentSearchLoop("test", tools);

  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].evidenceStatus, "full", "fetch success upgrades to full");
});

// ── #49 失败无摘要：保持 none，不注入部分证据块 ──

test("agent loop: failed fetch without snippet keeps evidenceStatus none", async () => {
  const provider = new ProgrammableAgentProvider();
  const failedUrl = "https://example.com/no-snippet";
  provider.setAgentChatSequence([
    {
      finishReason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        toolCalls: [{
          id: "tc-s1",
          type: "function" as const,
          function: { name: "web_search", arguments: JSON.stringify({ query: "空摘要查询" }) },
        }],
      },
      model: "test-model",
    },
    {
      finishReason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        toolCalls: [{
          id: "tc-f1",
          type: "function" as const,
          function: { name: "web_fetch", arguments: JSON.stringify({ url: failedUrl }) },
        }],
      },
      model: "test-model",
    },
    {
      finishReason: "stop",
      message: { role: "assistant", content: "回答[来源1]。" },
      model: "test-model",
    },
  ]);

  const gateway = createTestGateway(provider);
  const { tools, mockSearchResults } = createTestTools();
  mockSearchResults.set("空摘要查询", [
    { title: "No Snippet", url: failedUrl, snippet: "" },
  ]);
  tools.webFetch = async (url: string) => {
    assert.equal(url, failedUrl);
    return { url, content: "", errorMessage: "URL returned HTTP 403" };
  };

  const result = await gateway.runAgentSearchLoop("测试", tools);

  // 无摘要来源保持 none（不注入部分证据块，模型不能基于它引用）
  assert.equal(result.sources[0].evidenceStatus, "none");
});
