import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleContext,
  ConversationContextResolver,
  conversationContextCandidate,
} from "@collector/api";
import type { ContextCandidate, ResearchMessageBodyRecord } from "@collector/capture-contracts";

const NOW = "2026-09-01T00:00:00.000Z";

function message(
  id: string,
  role: "user" | "assistant",
  content: string,
  status: ResearchMessageBodyRecord["status"] = "completed",
): ResearchMessageBodyRecord {
  return { id, sessionId: "session-1", nodeId: "node-1", role, content, status, createdAt: NOW, updatedAt: NOW };
}

function resolve(messages: ResearchMessageBodyRecord[], options: { budget?: number; existing?: ReturnType<ConversationContextResolver["resolve"]>; generationAttempt?: number } = {}) {
  const currentMessage = messages.at(-1)!;
  return new ConversationContextResolver({ buildFingerprint: "build:test" }).resolve({
    taskId: "task-1",
    generationAttempt: options.generationAttempt ?? 1,
    inputMessageId: currentMessage.id,
    outputMessageId: "output-1",
    nodeId: "node-1",
    currentMessage,
    messages,
    ...(options.budget === undefined ? {} : { maxInputTokens: options.budget }),
    ...(options.existing ? { existing: options.existing } : {}),
  });
}

test("ordinal references resolve only when one calibrated prior candidate exists", () => {
  const context = resolve([
    message("assistant-1", "assistant", "1. 快速打补丁\n2. 重构上下文模块"),
    message("user-current", "user", "继续第二个方案"),
  ]);
  const relation = context.relations.find((item) => item.kind === "ordinal_reference");
  assert.equal(relation?.status, "resolved");
  assert.equal(relation?.resolvedMessageId, "assistant-1");
  assert.equal(context.items.find((item) => item.source.messageId === "assistant-1")?.selectionReason, "reference_candidate");

  const ambiguous = resolve([
    message("assistant-1", "assistant", "1. 快速打补丁\n2. 重构上下文模块"),
    message("assistant-2", "assistant", "1. 本地部署\n2. 云端部署"),
    message("user-current", "user", "继续第二个方案"),
  ]);
  const ambiguousRelation = ambiguous.relations.find((item) => item.kind === "ordinal_reference");
  assert.equal(ambiguousRelation?.status, "ambiguous");
  assert.equal(ambiguousRelation?.candidates.length, 2);
  assert.equal(ambiguousRelation?.resolvedMessageId, undefined);
});

test("corrections preserve user-intent and external-fact conflicts as different relations", () => {
  const intent = resolve([
    message("user-1", "user", "我准备去北京调研"),
    message("user-current", "user", "不是北京，是上海"),
  ]);
  assert.equal(intent.relations[0]?.kind, "user_intent_correction");
  assert.deepEqual([intent.relations[0]?.fromValue, intent.relations[0]?.toValue], ["北京", "上海"]);

  const fact = resolve([
    message("assistant-1", "assistant", "目标城市是北京"),
    message("user-current", "user", "不是北京，是上海"),
  ]);
  assert.equal(fact.relations[0]?.kind, "external_fact_conflict");
  assert.equal(fact.relations[0]?.status, "resolved");
});

test("format carryover and replacement keep the effective prior constraint plus the new limit", () => {
  const context = resolve([
    message("user-1", "user", "请使用三列表格格式回答"),
    message("assistant-1", "assistant", "| 方案 | 成本 | 风险 |\n|---|---|---|"),
    message("user-current", "user", "保持刚才的格式，但缩短一半"),
  ]);
  assert.equal(context.relations.find((item) => item.kind === "constraint_carryover")?.status, "resolved");
  assert.equal(context.relations.find((item) => item.kind === "constraint_replacement")?.status, "resolved");
  assert.equal(context.items.find((item) => item.source.messageId === "user-1")?.selection, "selected");
});

test("semantic recall handles Chinese synonyms without selecting a nearby distractor", () => {
  const context = resolve([
    message("user-relevant", "user", "企业知识库要改善向量检索的召回策略"),
    message("assistant-distractor", "assistant", "搜索结果页面需要调整引用卡片颜色"),
    message("user-current", "user", "再说说 RAG 查询召回策略"),
  ]);
  assert.equal(context.items.find((item) => item.source.messageId === "user-relevant")?.selection, "selected");
  assert.equal(context.items.find((item) => item.source.messageId === "assistant-distractor")?.selection, "omitted");
});

test("omitted assistant text and structured summary internals never enter the model candidate", () => {
  const history = Array.from({ length: 10 }, (_, index) => message(
    `history-${index}`,
    index % 2 === 0 ? "user" : "assistant",
    index === 1 ? "OMITTED_ASSISTANT_SENTINEL unrelated weather report" : `unrelated archived topic ${index}`,
  ));
  const context = resolve([
    ...history,
    message("user-relevant", "user", "数据库索引通常使用 B 树组织数据"),
    message("user-current", "user", "请解释数据库索引"),
  ]);
  const candidate = conversationContextCandidate(context);
  assert.ok(context.summaries.length > 0);
  assert.ok(context.summaries.every((summary) => summary.sourceMessageRange.startMessageId));
  assert.ok(candidate);
  assert.doesNotMatch(candidate.content, /OMITTED_ASSISTANT_SENTINEL/);
  assert.doesNotMatch(candidate.content, /messageId|sourceFingerprint|admitted|rejected/);
});

test("snapshot identity is reused only for the same attempt, message versions, resolver and build", () => {
  const messages = [message("user-1", "user", "保留列表格式"), message("user-current", "user", "继续")];
  const first = resolve(messages);
  assert.deepEqual(resolve(messages, { existing: first }), first);
  assert.notEqual(resolve(messages, { existing: first, generationAttempt: 2 }).contextId, first.contextId);

  const edited = messages.map((entry) => entry.id === "user-1" ? { ...entry, content: "改用表格格式", updatedAt: "2026-09-01T00:00:01.000Z" } : entry);
  assert.notEqual(resolve(edited, { existing: first }).sourceFingerprint, first.sourceFingerprint);
  const newBuild = new ConversationContextResolver({ buildFingerprint: "build:new" }).resolve({
    taskId: "task-1", generationAttempt: 1, inputMessageId: "user-current", outputMessageId: "output-1",
    nodeId: "node-1", currentMessage: edited.at(-1)!, messages: edited, existing: first,
  });
  assert.equal(newBuild.buildFingerprint, "build:new");
});

test("messages created after the task input never enter its source window", () => {
  const current = message("user-current", "user", "解释当前问题");
  const messages = [message("user-old", "user", "旧要求"), current, message("assistant-future", "assistant", "FUTURE_TURN_SENTINEL")];
  const withFuture = new ConversationContextResolver({ buildFingerprint: "build:test" }).resolve({
    taskId: "task-1", generationAttempt: 1, inputMessageId: current.id, outputMessageId: "output-1",
    nodeId: "node-1", currentMessage: current, messages,
  });
  const withoutFuture = resolve([message("user-old", "user", "旧要求"), current]);
  assert.equal(withFuture.sourceFingerprint, withoutFuture.sourceFingerprint);
  assert.ok(withFuture.items.every((item) => item.source.messageId !== "assistant-future"));
});

test("budget and validation failures degrade to current plus recent user turns without a model call", () => {
  const current = message("user-current", "user", "不是旧方案，是新方案");
  const degraded = resolve([
    message("user-old", "user", "我选择旧方案并要求保持表格格式"),
    message("assistant-old", "assistant", "很长的回答".repeat(200)),
    current,
  ], { budget: 1 });
  assert.equal(degraded.resolution.status, "degraded");
  assert.equal(degraded.resolution.mode, "deterministic");
  assert.equal(degraded.items.at(-1)?.source.messageId, current.id);

  const fallback = resolve([message("user-old", "user", "最近的用户要求"), current], { budget: 0 });
  assert.equal(fallback.resolution.reason, "invalid_budget");
  assert.deepEqual(fallback.items.map((item) => item.source.originalRole), ["user", "user"]);
  assert.ok(fallback.items.every((item) => item.selection === "selected"));
});

test("ContextAssembly protects the current question from parent-chain displacement", () => {
  const context = resolve([
    message("assistant-1", "assistant", "1. 低成本方案\n2. 高质量方案"),
    message("user-current", "user", "继续第二个方案"),
  ]);
  const conversation = conversationContextCandidate(context)!;
  const current: ContextCandidate = {
    id: "current", channel: "factual_evidence", evidenceKind: "current_question", content: "继续第二个方案",
    source: { kind: "conversation", id: "user-current", scope: "turn" },
    permission: { status: "required", basis: "task_contract" }, sensitivity: "private",
    priority: "task_required", protection: "required", upstreamRank: { source: "conversation", rank: 0 },
  };
  const parent: ContextCandidate = {
    id: "parent", channel: "factual_evidence", evidenceKind: "research_context", content: "父链旧材料".repeat(1000),
    source: { kind: "research_content", id: "parent-1", scope: "project", projectId: "project-1" },
    permission: { status: "eligible", basis: "source_authorization" }, sensitivity: "standard",
    priority: "project", protection: "preferred", upstreamRank: { source: "research", rank: 0 },
  };
  const assembly = assembleContext({
    purpose: "research_body", workflowRunId: "task-1", projectId: "project-1",
    budget: { maxInputTokens: 300, reservedOutputTokens: 100 }, candidates: [parent, conversation, current],
  });
  assert.equal(assembly.status, "assembled");
  if (assembly.status !== "assembled") return;
  assert.ok(assembly.adopted.some((entry) => entry.candidate.id === "current"));
  assert.ok(assembly.rejected.some((entry) => entry.candidateId === "parent"));
});
