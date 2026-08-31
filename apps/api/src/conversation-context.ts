import { createHash } from "node:crypto";
import {
  CONVERSATION_CONTEXT_RESOLVER_VERSION,
  CONVERSATION_CONTEXT_SCHEMA_VERSION,
  researchBodyVersionId,
  type ConversationContext,
  type ConversationContextItem,
  type ConversationContextMessageReference,
  type ConversationContextRelation,
  type ConversationContextRelationCandidate,
  type ConversationContextSelectionReason,
  type ConversationContextSummary,
  type FactualEvidenceContextCandidate,
  type ResearchMessageBodyRecord,
} from "@collector/capture-contracts";
import { estimateContextTokens } from "./context-assembly.js";

export const DEFAULT_CONVERSATION_CONTEXT_INPUT_TOKENS = 2_000;
const DEFAULT_RECENT_USER_TURNS = 4;
const SUMMARY_STATEMENT_CHARACTERS = 180;

export interface ConversationContextResolveInput {
  taskId: string;
  generationAttempt: number;
  inputMessageId: string;
  outputMessageId?: string;
  nodeId: string;
  currentMessage: ResearchMessageBodyRecord;
  messages: readonly ResearchMessageBodyRecord[];
  maxInputTokens?: number;
  existing?: ConversationContext;
}

export interface ConversationContextResolverOptions {
  buildFingerprint?: string;
  resolverVersion?: string;
  recentUserTurns?: number;
}

type IndexedMessage = { message: ResearchMessageBodyRecord; index: number; source: ConversationContextMessageReference };
type RankedMessage = IndexedMessage & { relevance: number; reason: ConversationContextSelectionReason; protected: boolean };

const FORMAT_PATTERN = /(?:格式|结构|排版|表格|列表|要点|标题|段落|连续正文|语气|语言|字数|长度|简短|详细|缩短|压缩|精简)/i;
const CONSTRAINT_PATTERN = /(?:只|不要|不能|必须|需要|保持|沿用|继续|限制|预算|团队|时间|格式|结构|语气|语言|字数|长度|缩短|压缩|精简|一半)/i;
const SHORT_FOLLOW_UP_PATTERN = /^(?:继续|然后呢|再说说|展开|具体呢|为什么|怎么做|怎么办|还有吗|接着说)[？?。！!\s]*$/i;
const INTENT_PATTERN = /(?:我(?:要|想|希望|打算|准备|选择|决定|需要)|请(?:帮我|为我)|目的|目标|偏好|行程|计划)/i;
const INCOMPLETE_ASSISTANT_STATUSES = new Set<ResearchMessageBodyRecord["status"]>(["pending", "streaming", "paused", "failed"]);

const SYNONYM_GROUPS: ReadonlyArray<readonly string[]> = [
  ["检索", "搜索", "查询", "召回", "retrieval", "search"],
  ["知识库", "rag", "资料库", "文档库"],
  ["方案", "选项", "路径", "方法", "建议"],
  ["缩短", "压缩", "精简", "简洁", "简短"],
  ["格式", "结构", "排版", "样式"],
  ["事实", "证据", "来源", "依据"],
  ["回答", "答复", "正文", "结论"],
  ["错误", "问题", "故障", "异常"],
  ["规划", "计划", "路线", "步骤"],
];

/**
 * Conversation-only deep Module. Callers provide ordered node messages and receive one versioned
 * snapshot; windowing, recall, summary structure, relation resolution, validation and fallback stay
 * inside the Implementation.
 */
export class ConversationContextResolver {
  private readonly buildFingerprint: string;
  private readonly resolverVersion: string;
  private readonly recentUserTurns: number;

  constructor(options: ConversationContextResolverOptions = {}) {
    this.buildFingerprint = options.buildFingerprint?.trim() || "development";
    this.resolverVersion = options.resolverVersion?.trim() || CONVERSATION_CONTEXT_RESOLVER_VERSION;
    this.recentUserTurns = Math.max(1, Math.trunc(options.recentUserTurns ?? DEFAULT_RECENT_USER_TURNS));
  }

  resolve(input: ConversationContextResolveInput): ConversationContext {
    const ordered = this.orderedMessages(input);
    const sourceFingerprint = fingerprint(ordered.map(({ message }) => ({
      id: message.id,
      nodeId: message.nodeId ?? message.branchId ?? input.nodeId,
      role: message.role,
      status: message.status,
      updatedAt: message.updatedAt,
      content: message.content,
    })));
    if (this.canReuse(input, sourceFingerprint)) return structuredClone(input.existing!);

    const maxInputTokens = Math.trunc(input.maxInputTokens ?? DEFAULT_CONVERSATION_CONTEXT_INPUT_TOKENS);
    try {
      if (!Number.isFinite(maxInputTokens) || maxInputTokens <= 0) {
        return this.fallback(input, ordered, sourceFingerprint, "invalid_budget", Math.max(1, maxInputTokens || 1));
      }
      if (new Set(ordered.map(({ message }) => message.id)).size !== ordered.length
        || !input.currentMessage.id.trim()
        || input.currentMessage.role !== "user"
        || !input.currentMessage.content.trim()) {
        return this.fallback(input, ordered, sourceFingerprint, "invalid_history", maxInputTokens);
      }
      return this.resolveValidated(input, ordered, sourceFingerprint, maxInputTokens);
    } catch {
      return this.fallback(input, ordered, sourceFingerprint, "internal_error", Math.max(1, maxInputTokens));
    }
  }

  private orderedMessages(input: ConversationContextResolveInput): IndexedMessage[] {
    const messages = input.messages.some((message) => message.id === input.currentMessage.id)
      ? [...input.messages]
      : [...input.messages, input.currentMessage];
    const currentIndex = messages.findIndex((message) => message.id === input.currentMessage.id);
    return messages
      .slice(0, currentIndex < 0 ? messages.length : currentIndex + 1)
      .map((message, index) => ({ message, index, source: messageReference(message, index, input.nodeId) }));
  }

  private canReuse(input: ConversationContextResolveInput, sourceFingerprint: string): boolean {
    const current = input.existing;
    return Boolean(current
      && current.schemaVersion === CONVERSATION_CONTEXT_SCHEMA_VERSION
      && current.resolverVersion === this.resolverVersion
      && current.buildFingerprint === this.buildFingerprint
      && current.taskId === input.taskId
      && current.generationAttempt === input.generationAttempt
      && current.inputMessageId === input.inputMessageId
      && current.nodeId === input.nodeId
      && current.sourceFingerprint === sourceFingerprint);
  }

  private resolveValidated(
    input: ConversationContextResolveInput,
    ordered: readonly IndexedMessage[],
    sourceFingerprint: string,
    maxInputTokens: number,
  ): ConversationContext {
    const currentIndex = ordered.findIndex(({ message }) => message.id === input.currentMessage.id);
    const previous = ordered.filter(({ index }) => index < currentIndex);
    const current = ordered[currentIndex]!;
    const relations = resolveRelations(input.taskId, input.currentMessage.content, previous);
    const relationMessageIds = new Set(relations.flatMap((relation) => relation.candidates.map((candidate) => candidate.source.messageId)));
    const correctionMessageIds = new Set(relations
      .filter((relation) => relation.kind.includes("correction") || relation.kind.includes("replacement") || relation.kind.includes("rejected") || relation.kind.includes("retraction"))
      .flatMap((relation) => relation.candidates.map((candidate) => candidate.source.messageId)));
    const recentUserIds = new Set(previous.filter(({ message }) => message.role === "user").slice(-this.recentUserTurns).map(({ message }) => message.id));
    const hasShortFollowUp = SHORT_FOLLOW_UP_PATTERN.test(input.currentMessage.content.trim()) || /(?:刚才|之前|上一轮|前面|继续|它|这个|那个)/.test(input.currentMessage.content);

    const ranked: RankedMessage[] = previous.map((entry) => {
      if (entry.message.role === "assistant" && INCOMPLETE_ASSISTANT_STATUSES.has(entry.message.status)) {
        return { ...entry, relevance: 0, reason: "incomplete_assistant", protected: false };
      }
      const relevance = semanticRelevance(input.currentMessage.content, entry.message.content);
      if (correctionMessageIds.has(entry.message.id)) return { ...entry, relevance, reason: "explicit_correction", protected: true };
      if (relationMessageIds.has(entry.message.id)) return { ...entry, relevance, reason: "reference_candidate", protected: true };
      if (entry.message.role === "user" && CONSTRAINT_PATTERN.test(entry.message.content)) {
        return { ...entry, relevance, reason: "active_constraint", protected: true };
      }
      if (relevance >= (entry.message.role === "user" ? 2 : 3)) {
        return { ...entry, relevance, reason: "relevant_history", protected: false };
      }
      if (entry.message.role === "user" && recentUserIds.has(entry.message.id) && hasShortFollowUp) {
        return { ...entry, relevance, reason: "recent_user_fallback", protected: false };
      }
      return { ...entry, relevance, reason: "not_relevant", protected: false };
    });

    const currentTokens = estimateContextTokens(input.currentMessage.content);
    let usedInputTokens = currentTokens + estimateContextTokens(JSON.stringify(relations));
    const selected = new Map<string, ConversationContextSelectionReason>();
    const candidates = ranked
      .filter((entry) => entry.reason !== "not_relevant" && entry.reason !== "incomplete_assistant")
      .sort((left, right) => Number(right.protected) - Number(left.protected)
        || right.relevance - left.relevance
        || right.index - left.index);
    let budgetExhausted = false;
    for (const entry of candidates) {
      const tokens = estimateContextTokens(entry.message.content);
      if (entry.protected || usedInputTokens + tokens <= maxInputTokens) {
        selected.set(entry.message.id, entry.reason);
        usedInputTokens += tokens;
      } else {
        entry.reason = "budget_exhausted";
        budgetExhausted = true;
      }
    }

    const items: ConversationContextItem[] = [
      ...ranked.map((entry) => contextItem(entry, selected.get(entry.message.id) ?? entry.reason)),
      {
        id: `conversation-item:${input.currentMessage.id}`,
        content: input.currentMessage.content,
        source: current.source,
        semanticCategory: "current_request",
        authority: "current_user",
        selection: "selected",
        selectionReason: "current_request",
        estimatedTokens: currentTokens,
      },
    ];

    const summaries = buildSummaries(input.taskId, ranked, this.recentUserTurns * 2, maxInputTokens - usedInputTokens);
    for (const summary of summaries) {
      if (summary.selection === "selected") usedInputTokens += summary.estimatedTokens;
      if (summary.selectionReason === "budget_exhausted") budgetExhausted = true;
    }
    const status = budgetExhausted || usedInputTokens > maxInputTokens ? "degraded" : "resolved";
    return {
      schemaVersion: CONVERSATION_CONTEXT_SCHEMA_VERSION,
      contextId: contextId(input, sourceFingerprint, this.resolverVersion),
      resolverVersion: this.resolverVersion,
      buildFingerprint: this.buildFingerprint,
      taskId: input.taskId,
      generationAttempt: input.generationAttempt,
      inputMessageId: input.inputMessageId,
      ...(input.outputMessageId ? { outputMessageId: input.outputMessageId } : {}),
      nodeId: input.nodeId,
      sourceFingerprint,
      resolution: {
        status,
        mode: "deterministic",
        ...(status === "degraded" ? { reason: "budget_exhausted" as const } : {}),
      },
      budget: {
        maxInputTokens,
        usedInputTokens,
        remainingInputTokens: Math.max(0, maxInputTokens - usedInputTokens),
      },
      items,
      summaries,
      relations,
    };
  }

  private fallback(
    input: ConversationContextResolveInput,
    ordered: readonly IndexedMessage[],
    sourceFingerprint: string,
    reason: "invalid_history" | "invalid_budget" | "internal_error",
    maxInputTokens: number,
  ): ConversationContext {
    const currentIndex = Math.max(0, ordered.findIndex(({ message }) => message.id === input.currentMessage.id));
    const recentUsers = ordered
      .filter(({ index, message }) => index < currentIndex && message.role === "user")
      .slice(-this.recentUserTurns);
    const fallbackMessages = [...recentUsers, ordered[currentIndex] ?? {
      message: input.currentMessage,
      index: currentIndex,
      source: messageReference(input.currentMessage, currentIndex, input.nodeId),
    }];
    const items = fallbackMessages.map((entry, index): ConversationContextItem => ({
      id: `conversation-item:${entry.message.id}`,
      content: entry.message.content,
      source: entry.source,
      semanticCategory: entry.message.id === input.currentMessage.id ? "current_request" : "user_turn",
      authority: entry.message.id === input.currentMessage.id ? "current_user" : "user_source",
      selection: "selected",
      selectionReason: entry.message.id === input.currentMessage.id ? "current_request" : "recent_user_fallback",
      estimatedTokens: estimateContextTokens(entry.message.content),
    }));
    const usedInputTokens = items.reduce((sum, item) => sum + item.estimatedTokens, 0);
    return {
      schemaVersion: CONVERSATION_CONTEXT_SCHEMA_VERSION,
      contextId: contextId(input, sourceFingerprint, this.resolverVersion),
      resolverVersion: this.resolverVersion,
      buildFingerprint: this.buildFingerprint,
      taskId: input.taskId,
      generationAttempt: input.generationAttempt,
      inputMessageId: input.inputMessageId,
      ...(input.outputMessageId ? { outputMessageId: input.outputMessageId } : {}),
      nodeId: input.nodeId,
      sourceFingerprint,
      resolution: { status: "degraded", mode: "deterministic", reason },
      budget: { maxInputTokens, usedInputTokens, remainingInputTokens: Math.max(0, maxInputTokens - usedInputTokens) },
      items,
      summaries: [],
      relations: [],
    };
  }
}

/**
 * Converts only Resolver-selected content to one eligible conversation-history candidate. Omitted
 * text and internal message/source identities never enter the model projection.
 */
export function conversationContextCandidate(context: ConversationContext): FactualEvidenceContextCandidate | undefined {
  const selectedHistory = context.items.filter((item) => item.selection === "selected" && item.semanticCategory !== "current_request");
  const selectedSummaries = context.summaries.filter((summary) => summary.selection === "selected");
  if (!selectedHistory.length && !selectedSummaries.length && !context.relations.length) return undefined;
  const indexByMessageId = new Map(context.items.map((item, index) => [item.source.messageId, index]));
  const projection = {
    schemaVersion: context.schemaVersion,
    resolverVersion: context.resolverVersion,
    resolution: context.resolution,
    turns: selectedHistory.map((item) => ({
      ordinal: indexByMessageId.get(item.source.messageId),
      role: item.source.originalRole,
      semanticCategory: item.semanticCategory,
      authority: item.authority,
      content: item.content,
    })),
    summaries: selectedSummaries.map((summary) => ({
      summaryVersion: summary.summaryVersion,
      statements: summary.statements.map((statement) => ({
        role: statement.source.originalRole,
        semanticCategory: statement.semanticCategory,
        authority: statement.authority,
        content: statement.content,
      })),
    })),
    relations: context.relations.map((relation) => ({
      kind: relation.kind,
      status: relation.status,
      expression: relation.expression,
      ...(relation.fromValue ? { fromValue: relation.fromValue } : {}),
      ...(relation.toValue ? { toValue: relation.toValue } : {}),
      candidates: relation.candidates.map((candidate) => ({
        ordinal: indexByMessageId.get(candidate.source.messageId),
        role: candidate.source.originalRole,
        excerpt: candidate.excerpt,
      })),
    })),
  };
  return {
    id: `conversation-context:${context.contextId}`,
    channel: "factual_evidence",
    evidenceKind: "conversation_history",
    content: JSON.stringify(projection),
    source: { kind: "conversation", id: context.contextId, version: context.sourceFingerprint, scope: "turn" },
    permission: { status: "eligible", basis: "task_contract" },
    sensitivity: "private",
    priority: "turn",
    protection: context.relations.length ? "required" : "preferred",
    upstreamRank: { source: "conversation", rank: 1 },
  };
}

function contextItem(entry: RankedMessage, selectionReason: ConversationContextSelectionReason): ConversationContextItem {
  const selected = !["not_relevant", "incomplete_assistant", "budget_exhausted"].includes(selectionReason);
  return {
    id: `conversation-item:${entry.message.id}`,
    content: entry.message.content,
    source: entry.source,
    semanticCategory: entry.message.role === "assistant"
      ? "assistant_body"
      : CONSTRAINT_PATTERN.test(entry.message.content) ? "explicit_constraint" : "user_turn",
    authority: entry.message.role === "assistant" ? "assistant_body" : "user_source",
    selection: selected ? "selected" : "omitted",
    selectionReason,
    estimatedTokens: estimateContextTokens(entry.message.content),
  };
}

function buildSummaries(
  taskId: string,
  ranked: readonly RankedMessage[],
  recentWindow: number,
  remainingTokens: number,
): ConversationContextSummary[] {
  const older = ranked.slice(0, Math.max(0, ranked.length - recentWindow)).filter((entry) => entry.reason === "not_relevant");
  const summaries: ConversationContextSummary[] = [];
  for (let offset = 0; offset < older.length; offset += 4) {
    const group = older.slice(offset, offset + 4);
    if (!group.length) continue;
    const statements = group.map((entry) => ({
      content: excerpt(entry.message.content, SUMMARY_STATEMENT_CHARACTERS),
      source: entry.source,
      semanticCategory: "summary_statement" as const,
      authority: "derived_summary" as const,
    }));
    const estimatedTokens = estimateContextTokens(JSON.stringify(statements.map(({ content, source }) => ({ content, role: source.originalRole }))));
    const relevant = group.some((entry) => entry.relevance > 0);
    const selected = relevant && estimatedTokens <= remainingTokens;
    const selectionReason = !relevant ? "not_relevant" as const : selected ? "summary_recall" as const : "budget_exhausted" as const;
    if (selected) remainingTokens -= estimatedTokens;
    summaries.push({
      id: `conversation-summary:${fingerprint([taskId, ...group.map(({ message }) => message.id)])}`,
      summaryVersion: "conversation-summary-v1",
      resolutionStatus: "deterministic",
      sourceMessageRange: rangeFor(group),
      selection: selected ? "selected" : "omitted",
      selectionReason,
      statements,
      estimatedTokens,
    });
  }
  return summaries;
}

function resolveRelations(taskId: string, current: string, previous: readonly IndexedMessage[]): ConversationContextRelation[] {
  const relations: ConversationContextRelation[] = [];
  const ordinalMatch = current.match(/第\s*([一二两三四五六七八九十两\d]+)\s*(?:个|条|种)?\s*(方案|选项|路径|建议|方法)?/);
  if (ordinalMatch) {
    const ordinal = chineseOrdinal(ordinalMatch[1]!);
    const candidates = ordinal
      ? previous.flatMap((entry) => ordinalCandidate(entry, ordinal))
      : [];
    relations.push(relation(taskId, "ordinal_reference", ordinalMatch[0], candidates));
  }

  const pronoun = current.match(/[“"']?(它|这个|那个|该方案|该选项)[”"']?/);
  if (pronoun && !ordinalMatch) {
    const candidates = previous
      .map((entry) => ({ entry, relevance: semanticRelevance(current, entry.message.content) }))
      .filter(({ relevance }) => relevance > 0)
      .sort((left, right) => right.relevance - left.relevance || right.entry.index - left.entry.index)
      .slice(0, 3)
      .map(({ entry }) => relationCandidate(entry));
    relations.push(relation(taskId, "pronoun_reference", pronoun[1]!, candidates));
  }

  const correction = current.match(/(?:不是|并非)\s*([^，,。；;]+)[，,]\s*(?:是|而是)\s*([^，,。；;]+)/);
  if (correction) {
    const fromValue = correction[1]!.trim();
    const toValue = correction[2]!.trim();
    const target = [...previous].reverse().find(({ message }) => message.content.includes(fromValue));
    const kind = target?.message.role === "user" && INTENT_PATTERN.test(target.message.content)
      ? "user_intent_correction" as const
      : "external_fact_conflict" as const;
    relations.push(relation(taskId, kind, correction[0], target ? [relationCandidate(target)] : [], { fromValue, toValue }));
  }

  const carryover = current.match(/(?:保持|沿用|继续).{0,12}(?:刚才|之前|上一轮|前面).{0,12}(格式|结构|排版|语气|语言)/);
  if (carryover) {
    const target = [...previous].reverse().find(({ message }) => FORMAT_PATTERN.test(message.content));
    relations.push(relation(taskId, "constraint_carryover", carryover[0], target ? [relationCandidate(target)] : []));
  }

  const replacement = current.match(/(?:改成|换成|调整为|缩短|压缩|精简).{0,16}(?:表格|列表|要点|连续正文|一半|三分之一|更短|简短|精简)?/);
  if (replacement) {
    const target = [...previous].reverse().find(({ message }) => FORMAT_PATTERN.test(message.content));
    relations.push(relation(taskId, "constraint_replacement", replacement[0], target ? [relationCandidate(target)] : []));
  }

  const retraction = current.match(/(?:撤回|取消|不再采用).{0,20}(?:上一轮|之前|刚才|默认假设|要求|限制)?/);
  if (retraction) {
    const target = [...previous].reverse().find(({ message }) => message.role === "user");
    relations.push(relation(taskId, "instruction_retraction", retraction[0], target ? [relationCandidate(target)] : []));
  }

  const rejectAssistant = current.match(/(?:不要|不能|别).{0,12}(?:采用|沿用|接受).{0,12}(?:助手|你).{0,12}(?:结论|判断|推断)/);
  if (rejectAssistant) {
    const target = [...previous].reverse().find(({ message }) => message.role === "assistant" && !INCOMPLETE_ASSISTANT_STATUSES.has(message.status));
    relations.push(relation(taskId, "assistant_conclusion_rejected", rejectAssistant[0], target ? [relationCandidate(target)] : []));
  }
  return deduplicateRelations(relations);
}

function relation(
  taskId: string,
  kind: ConversationContextRelation["kind"],
  expression: string,
  candidates: readonly ConversationContextRelationCandidate[],
  values: { fromValue?: string; toValue?: string } = {},
): ConversationContextRelation {
  const status = candidates.length === 1 ? "resolved" : candidates.length > 1 ? "ambiguous" : "unresolved";
  return {
    id: `conversation-relation:${fingerprint([taskId, kind, expression, ...candidates.map(({ source }) => source.messageId)])}`,
    kind,
    status,
    expression,
    candidates,
    ...(status === "resolved" ? { resolvedMessageId: candidates[0]!.source.messageId } : {}),
    ...(values.fromValue ? { fromValue: values.fromValue } : {}),
    ...(values.toValue ? { toValue: values.toValue } : {}),
  };
}

function deduplicateRelations(relations: readonly ConversationContextRelation[]): ConversationContextRelation[] {
  const seen = new Set<string>();
  return relations.filter((item) => {
    const key = `${item.kind}\u0000${item.expression}\u0000${item.candidates.map(({ source }) => source.messageId).join("\u0000")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ordinalCandidate(entry: IndexedMessage, ordinal: number): ConversationContextRelationCandidate[] {
  if (INCOMPLETE_ASSISTANT_STATUSES.has(entry.message.status)) return [];
  const content = entry.message.content;
  const chinese = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"][ordinal] ?? String(ordinal);
  const patterns = [
    new RegExp(`(?:方案|选项|路径|建议|方法)\\s*(?:${ordinal}|${chinese})\\s*(?:是|[:：、.)-])\\s*([^。；\\n]+)`, "i"),
    new RegExp(`(?:^|\\n)\\s*(?:${ordinal}|${chinese})[.、)：:)\\s-]+([^\\n]+)`, "i"),
    new RegExp(`第\\s*(?:${ordinal}|${chinese})\\s*(?:个|条|种)?\\s*(?:方案|选项|路径|建议|方法)?\\s*(?:是|[:：、.)-])?\\s*([^。；\\n]+)`, "i"),
  ];
  const match = patterns.map((pattern) => content.match(pattern)).find(Boolean);
  return match ? [{ source: entry.source, excerpt: excerpt(match[1] ?? match[0], 240) }] : [];
}

function relationCandidate(entry: IndexedMessage): ConversationContextRelationCandidate {
  return { source: entry.source, excerpt: excerpt(entry.message.content, 240) };
}

function semanticRelevance(query: string, candidate: string): number {
  const queryTokens = semanticTokens(query);
  const candidateTokens = semanticTokens(candidate);
  let score = 0;
  for (const token of queryTokens) if (candidateTokens.has(token)) score += token.startsWith("syn:") ? 2 : 1;
  return score;
}

function semanticTokens(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, " ");
  const tokens = new Set<string>();
  for (const word of normalized.match(/[a-z0-9_+-]{2,}/g) ?? []) tokens.add(word);
  for (const sequence of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let index = 0; index < sequence.length - 1; index += 1) tokens.add(sequence.slice(index, index + 2));
  }
  SYNONYM_GROUPS.forEach((group, index) => {
    if (group.some((term) => normalized.includes(term))) tokens.add(`syn:${index}`);
  });
  for (const stop of ["这个", "那个", "什么", "怎么", "为什么", "一下", "说明", "请把", "继续", "前面", "刚才", "上一轮"]) tokens.delete(stop);
  return tokens;
}

function chineseOrdinal(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  const direct: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return direct[value];
}

function messageReference(message: ResearchMessageBodyRecord, index: number, nodeId: string): ConversationContextMessageReference {
  const resolvedNodeId = message.nodeId ?? message.branchId ?? nodeId;
  return {
    messageId: message.id,
    nodeId: resolvedNodeId,
    messageVersionId: `conversation-message:${fingerprint([message.id, message.updatedAt, message.content])}`,
    ...(message.role === "assistant" && message.content.trim() ? { bodyVersionId: researchBodyVersionId(message.id, message.content) } : {}),
    originalRole: message.role,
    sourceMessageRange: { startMessageId: message.id, endMessageId: message.id, startIndex: index, endIndex: index },
  };
}

function rangeFor(entries: readonly IndexedMessage[]): ConversationContextMessageReference["sourceMessageRange"] {
  const first = entries[0]!;
  const last = entries.at(-1)!;
  return { startMessageId: first.message.id, endMessageId: last.message.id, startIndex: first.index, endIndex: last.index };
}

function contextId(input: ConversationContextResolveInput, sourceFingerprint: string, resolverVersion: string): string {
  return `conversation-context:${fingerprint([input.taskId, input.generationAttempt, input.inputMessageId, sourceFingerprint, resolverVersion])}`;
}

function excerpt(value: string, maxCharacters: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= maxCharacters ? normalized : `${normalized.slice(0, maxCharacters - 1)}…`;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
