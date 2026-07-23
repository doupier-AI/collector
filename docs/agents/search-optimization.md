# 联网搜索策略改进

日期：2026-07-23
状态：第二阶段（A1+B）已实现，待提交；第三阶段待启动

## 1. 本文定位

专题实施基线。记录 Collector 联网搜索当前架构、已知问题、DeerFlow 参考分析、设计决策、实施路线和待确认事项。

本文件属于 `docs/agents/` 下的专题基线。实施完成后，结果转入 `docs/PROJECT_DEVELOPMENT_RECORD.md`，本文件可归档。

## 2. 当前架构

Collector 的联网搜索分两条路径：

**路径一：Agent 式多轮搜索（`web-search-agent.ts` + `model-gateway/src/index.ts`）**

当前 Chat 和深入研究第一轮使用的搜索路径。F2 改造后的完整链路：

```
用户消息 → 提取最后一条 user message 作为用户输入
  → gateway.runAgentSearchLoop(userMessage, { webSearch, webFetch })
    → 循环（最多 10 轮）：
      → provider.agentChat(messages, AGENT_SEARCH_TOOLS)
        → 模型返回 tool_calls → 执行 web_search(query) 或 web_fetch(url)
        → 工具结果追入 messages → 继续循环
        → 模型返回 stop → 退出循环
    → 跨多轮搜索的 URL 去重全局序号
    → 返回 { content, queries, sources }
  → parseAgentCitations(content, sourceRecords)  ← 解析 [来源n] 引用标记
  → 写入 SQLite（research_grounding_runs / sources / citations）
```

关键特征：
- 搜索是 Agent 可调用的工具，不再是前置一次性步骤
- 模型通过 Agent tool-use 循环自主决定搜索/抓取策略（对标 DeerFlow）
- web_search 只搜不抓，web_fetch 只抓不搜（独立工具）
- 多轮换词重搜、信息不足再次搜索均由模型自主控制
- 来源按 URL 去重全局编号，跨多轮搜索一致
- 日志完整：`[web-search] agentLoop` 每轮记录 turn/finishReason/query/resultCount
- 搜索上限：5 次 web_search 调用后阻止继续搜索（防无限循环）
- 数据写入 SQLite（三张表：`research_grounding_runs`、`research_grounding_sources`、`research_citations`）但无 HTTP API 查询

**路径二：供应商原生 Grounding（`model-gateway/src/index.ts`）**

当使用的 AI 供应商（OpenAI/Anthropic/Gemini）支持原生联网时，`researchProviderFor` 的路由规则会调用 `gateway.generateGroundedResearch()`，使用供应商侧的工具调用（如 Anthropic `web_search_20260209`、OpenAI Responses `web_search` tool）。

当前 MVP 中此路径未激活：唯一已配置的模型 DeepSeek（`deepseek-v4-flash`）不支持原生联网（`webGrounding: "unsupported"`）。Anthropic/OpenAI/Gemini 的代码已实现，待真实验收。

## 3. 已知问题

### 3.1 中文分词导致的搜索失真（核心问题）

用户搜索「什么是loop engineering」时，Bing 将中文词「什么」作为核心信号，返回的全部结果都是关于「什么」的汉语词典解释、百度百科词条、购物网站——与 loop engineering 完全无关。

根本原因：Bing 对中英混合查询优先匹配中文词，没有查询预处理或改写步骤。

### 3.2 零可观测性（F1 已修复）

- `web-search-agent.ts` 中所有关键节点已有 `[web-search]` 日志
- Agent 循环中每轮记录 `turn/finishReason/query/resultCount/latency`

### 3.3 架构僵化（F2 已修复）

- web_search 和 web_fetch 已拆分为独立工具
- Agent 可通过多轮 tool-use 循环换词重搜、按需抓取
- 仍仅支持 Bing HTML 抓取（F3 多后端补充）

## 4. DeerFlow 参考分析

对 ByteDance DeerFlow（v2.0，`C:\Users\Administrator\deer-flow`）的完整源码分析。

### 4.1 架构对比

| 维度 | Collector 当前 | DeerFlow |
|------|---------------|----------|
| 搜索与模型的关系 | 前置步骤，结果注入 prompt | Agent 的工具，自主调用 |
| 搜索次数 | 固定 1 次 | Agent 自主决定（典型 3-8 次） |
| 查询构建 | 用户原始消息直传 | Agent 自己构思搜索关键词 |
| 内容抓取 | 固定抓取 Top 5 全文 | Agent 看 snippet 后自己挑 |
| 搜索引擎 | 仅 Bing HTML 抓取 | 10 种后端（DDG/Tavily/Brave/Firecrawl/…）通过配置切换 |
| 可观测性 | 零 | Langfuse/LangSmith tracing + Python logging |
| 搜索+抓取关系 | 同一函数中完成 | 两个独立工具（`web_search` + `web_fetch`） |
| 结果格式 | 纯文本塞 prompt | 标准化 JSON `{query, results: [{title, url, snippet}]}` |
| 引用机制 | `[来源n]` | `[citation:Title](URL)` Markdown 链接 |

### 4.2 核心洞察

DeerFlow 搜索效果好的根本原因不是用了哪个搜索引擎，而是**让 Agent 自己控制搜索过程**：
- Agent 看到 snippet 后决定是否深读
- 第一轮结果不好就换关键词重搜
- 信息不够继续搜，直到自己判断充分

### 4.3 Collector 可采用的改进

| 改进方向 | DeerFlow 模式 | Collector 适配 |
|---------|--------------|---------------|
| 拆分搜索/抓取 | 两个独立 LangChain tool | Agent 循环中拆为两个可调用函数 |
| 多轮搜索 | Agent ReAct 循环自主决定 | 需引入 tool-use loop |
| 多后端 | config.yaml 一行切换 | 参考 Collector 已有的 Provider 机制 |
| 查询改写 | Agent 自己构思关键词（隐式） | 前置 LLM 改写 query（低成本替代） |
| SKILL.md 方法论 | Deep Research 四阶段搜索方法论 | 可内化为 prompt 模板 |
| tool_search 延迟加载 | 大量工具按需发现 | 当前工具数量少，暂不需要 |

## 5. 设计决策

### 5.1 优先级排序

经过分析和讨论，确认改进优先级为 **D > A2 > A1+B > C**：

| 阶段 | 代号 | 内容 | 改动量 | 效果 |
|------|------|------|--------|------|
| 第一阶段 | D + A2 | 日志 + 查询改写 | 小 | 能看见 + 直接修复分词问题 |
| 第二阶段 | A1 + B | 拆分搜索/抓取工具 + Agent 循环 | 中-大 | 质的飞跃，对标 DeerFlow |
| 第三阶段 | C | 多搜索后端 | 中 | 锦上添花，解除 Bing 单点依赖 |

### 5.2 第一阶段（D + A2）设计

**D（日志）**：
- 在 `runWebSearch`、`searchBing`、`fetchPageContent` 关键节点加 `console.log`
- 输出：搜索 query、返回结果数、每条抓取成功/失败、总耗时
- 不改架构，纯加日志

**A2（查询改写）**：
- 在 `runWebSearch` 之前，用当前模型做一次轻量 query reformulation
- 输入：用户原始消息 → 输出：适合搜索的关键词
- Prompt 示例："将以下用户问题改写为适合搜索引擎的查询关键词（中文关键词在前，英文术语保留），只返回改写后的查询词，不要解释"
- 效果：用户说「什么是loop engineering」→ 改写为「loop engineering 定义 概念 原理」

### 5.3 第二阶段（A1 + B）设计

**A1（拆分工具）**：
- `web_search(query, maxResults)` → 返回 `{query, results: [{title, url, snippet}]}`（不抓正文）
- `web_fetch(url)` → 返回页面的 Markdown/纯文本（截断到适当长度）

**B（Agent 循环）**：
- 搜索从"前置注入 prompt"变为"Agent 可调用的工具"
- Agent 可以：搜 → 看结果 → 决定抓哪些 → 信息不够 → 换词再搜 → 循环直到满意
- 需要 Agent 框架支持 tool-use loop（或多轮 function calling）

### 5.4 第三阶段（C）设计

- 至少支持 DuckDuckGo（免费，无需 API Key）作为 Bing 回退
- 可选支持 Tavily（AI 专用搜索 API，需 Key）
- 后端选择通过配置切换，接口统一

## 6. 实施切片

详见 `docs/MVP_IMPLEMENTATION_PLAN.md` 阶段 F。

## 7. 待确认事项

- **Agent 工具循环的实现框架**：Collector 当前使用单轮 `complete(prompt)` 模式，`responseFormat: "json_object"` 强制 JSON 输出。引入 tool-use loop 需要框架层面的改造。候选方案：
  1. Vercel AI SDK 的 `generateText` + `maxSteps`（如已在依赖中）
  2. 手写 ReAct 循环
  3. 使用 Anthropic/OpenAI 原生 tool-use API
- **第二阶段是否为当前最高优先级**：核心闭环 MVP 已可体验，搜索改进是否优先于其他待推进功能
- **Tavily API Key 的获取和管理**：第三阶段使用 Tavily 需要申请 API Key，是否需要

## 8. 参考来源

- DeerFlow 源码：`C:\Users\Administrator\deer-flow`
- Collector 搜索实现：`apps/api/src/web-search-agent.ts`
- Collector 研究服务：`apps/api/src/service.ts` (§136-230)
- Collector 模型网关：`packages/model-gateway/src/index.ts`
- 搜索链路数据库验证：`.collector-data/collector.sqlite`（run `baac9a28-...`）
