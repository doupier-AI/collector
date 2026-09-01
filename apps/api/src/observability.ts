import {
  CONTEXT_PURPOSES,
  contextExplanationCodes,
  redactGroundingValue,
  sanitizeGroundingUrl,
  type ModelCallRecord,
  type AppliedModelBudget,
  type ContextAssemblyObservation,
  type ContextExplanationCode,
  type PromptEnvelopeObservation,
  type RequestedModelBudget,
  type ResolvedModelBudget,
  type ResearchGroundingRunRecord,
  type ResearchGroundingSourceRecord,
  type ResearchGroundingTraceEntry,
  type ResearchChapterTaskRecord,
  type ResearchImportTaskRecord,
  type ResearchTaskRecord,
  type RunRecordDetail,
  type RunRecordErrorCategory,
  type RunRecordErrorView,
  type RunRecordExportFilters,
  type RunRecordModelCallView,
  type RunRecordOperationType,
  type RunRecordOutcome,
  type RunRecordPage,
  type RunRecordSearchView,
  type RunRecordSource,
  type RunRecordStatus,
  type RunRecordSummary,
  type RunRecordTaskView,
} from "@collector/capture-contracts";
import {
  type CollectorStore,
  type ObservabilityRecordQuery,
  type ObservabilityRecordRow,
  type ObservabilityRelatedRow,
  type ObservabilityRecordSource,
} from "./store.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const CURSOR_VERSION = 1;
const SAFE_TEXT_LIMIT = 2_000;
const SAFE_QUERY_LIMIT = 400;

const OPERATION_TYPES: readonly RunRecordOperationType[] = [
  "research",
  "document_import",
  "similarity_verification",
  "chapter_parse",
];
const SOURCES: readonly RunRecordSource[] = ["research", "import", "fusion", "chapter"];
const STATUSES: readonly RunRecordStatus[] = ["queued", "running", "completed", "failed", "cancelled", "corrupt"];
const OUTCOMES: readonly RunRecordOutcome[] = ["success", "failure", "active", "cancelled", "unavailable"];

const SECRET_KEY = /(?:api[-_]?key|authorization|cookie|credential|idempotency[-_]?key|password|refresh[-_]?token|secret|set[-_]?cookie|token)/i;
const SECRET_VALUE = /(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+|\b(?:sk|AIza|ghp|xox[baprs]-)[-_A-Za-z0-9]{8,}\b/gi;

export interface RunRecordListInput {
  limit?: number;
  cursor?: string;
  from?: string;
  to?: string;
  operationType?: string;
  outcome?: string;
  status?: string;
}

export interface RunRecordExportPage {
  items: RunRecordDetail[];
  nextCursor?: string;
}

interface ParsedRunRecordListInput {
  limit: number;
  operation?: RunRecordOperationType;
  outcome?: RunRecordOutcome;
  status?: RunRecordStatus;
  cursor?: Cursor;
  dateRange: { from?: string; to?: string };
}

export class RunRecordsValidationError extends Error {}

interface Cursor {
  v: typeof CURSOR_VERSION;
  createdAt: string;
  id: string;
}

interface ParsedRecord {
  value: Record<string, unknown>;
  corrupt: boolean;
}

export class RunRecordsService {
  constructor(private readonly store: CollectorStore) {}

  /** 把 HTTP 查询参数规范化为可写入导出头的筛选条件，并复用列表接口校验。 */
  normalizeExportFilters(input: RunRecordListInput = {}): RunRecordExportFilters {
    return normalizeRunRecordExportFilters(input);
  }

  list(input: RunRecordListInput = {}): RunRecordPage {
    const parsed = parseRunRecordListInput(input);
    const { pageRows, nextCursor } = this.pageRows(parsed);
    const items = pageRows.map((row) => this.summary(row));
    return {
      items,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  /** 导出复用同一筛选查询，但返回详情页所需的脱敏记录；调用方按 nextCursor 分段消费。 */
  exportPage(input: RunRecordListInput = {}): RunRecordExportPage {
    const parsed = parseRunRecordListInput(input);
    const { pageRows, nextCursor } = this.pageRows(parsed);
    return { items: pageRows.map((row) => this.detail(row)), ...(nextCursor ? { nextCursor } : {}) };
  }

  get(publicId: string): RunRecordDetail | undefined {
    const reference = parsePublicId(publicId);
    const row = this.store.getRunRecordRow(reference.source, reference.id);
    if (!row) return undefined;
    return this.detail(row);
  }

  private queryFor(input: {
    limit: number;
    operation?: RunRecordOperationType;
    outcome?: RunRecordOutcome;
    status?: RunRecordStatus;
    cursor?: Cursor;
    dateRange: { from?: string; to?: string };
  }): ObservabilityRecordQuery {
    const source = input.operation ? sourceForOperation(input.operation) : undefined;
    const statuses = input.status ? statusesForStatus(input.status) : input.outcome ? statusesForOutcome(input.outcome) : undefined;
    return {
      limit: input.limit,
      ...(source ? { source } : {}),
      ...(input.operation ? { operationType: input.operation } : {}),
      ...(statuses ? { statuses } : {}),
      ...(input.dateRange.from ? { createdAfter: input.dateRange.from } : {}),
      ...(input.dateRange.to ? { createdBefore: input.dateRange.to } : {}),
      ...(input.cursor ? { before: { createdAt: input.cursor.createdAt, id: input.cursor.id } } : {}),
    };
  }

  private pageRows(input: ParsedRunRecordListInput): { pageRows: ObservabilityRecordRow[]; nextCursor?: string } {
    const rows = this.store.listRunRecordRows(this.queryFor({
      limit: input.limit + 1,
      operation: input.operation,
      outcome: input.outcome,
      status: input.status,
      cursor: input.cursor,
      dateRange: input.dateRange,
    }));
    const pageRows = rows.slice(0, input.limit);
    const hasMore = rows.length > input.limit;
    return {
      pageRows,
      ...(hasMore && pageRows.length > 0
        ? { nextCursor: encodeCursor({ v: CURSOR_VERSION, createdAt: pageRows[pageRows.length - 1].createdAt, id: pageRows[pageRows.length - 1].id }) }
        : {}),
    };
  }

  private summary(row: ObservabilityRecordRow): RunRecordSummary {
    const parsed = parseRecord(row.recordJson);
    if (parsed.corrupt) {
      return {
        id: publicId(row.source, row.id),
        source: row.source,
        operationType: operationTypeForRow(row),
        status: "corrupt",
        outcome: "unavailable",
        createdAt: row.createdAt,
        modelCallCount: 0,
        searchCount: 0,
        retryCount: 0,
      };
    }
    const status = statusForRow(row, parsed.value);
    const times = timesFor(parsed.value, row.createdAt);
    const related = this.relatedCounts(row, parsed.value);
    return {
      id: publicId(row.source, row.id),
      source: row.source,
      operationType: operationTypeForRow(row),
      ...(titleFor(parsed.value) ? { title: titleFor(parsed.value) } : row.source === "fusion" ? { title: "相似概念核验" } : {}),
      status,
      outcome: outcomeForStatus(status),
      createdAt: row.createdAt,
      ...(times.startedAt ? { startedAt: times.startedAt } : {}),
      ...(times.completedAt ? { completedAt: times.completedAt } : {}),
      ...(times.durationMs !== undefined ? { durationMs: times.durationMs } : {}),
      modelCallCount: related.modelCallCount,
      searchCount: related.searchCount,
      retryCount: related.retryCount,
    };
  }

  private detail(row: ObservabilityRecordRow): RunRecordDetail {
    const parsed = parseRecord(row.recordJson);
    if (parsed.corrupt) {
      return {
        ...this.summary(row),
        status: "corrupt",
        outcome: "unavailable",
        modelCalls: [],
        searches: [],
        errors: [{ source: "record", category: "storage", message: "这条运行记录无法读取，原始内容已隐藏。" }],
      };
    }
    const summary = this.summary(row);
    const task = taskView(row.source, parsed.value);
    const modelCalls = this.modelCalls(row.id);
    const searches = row.source === "research" ? this.searches(row.id) : [];
    const errors = errorsFor(row.source, parsed.value, modelCalls, searches);
    const observedContexts = modelCalls.flatMap((call) => call.contextAssembly ? [call.contextAssembly] : []);
    const retrievalDegraded = searches.some((search) => !["grounded", "evidence_prepared", "completed"].includes(search.status));
    const contextExplanations = [...new Set([
      ...(task?.contextExplanations ?? []),
      ...contextExplanationCodes(observedContexts, retrievalDegraded),
    ])];
    return {
      ...summary,
      ...(task ? { task } : {}),
      modelCalls,
      searches,
      errors,
      ...(contextExplanations.length ? { contextExplanations } : {}),
    };
  }

  private relatedCounts(row: ObservabilityRecordRow, record: Record<string, unknown>): { modelCallCount: number; searchCount: number; retryCount: number } {
    const modelCalls = safeRows(() => this.store.listRunModelCallRows(row.id));
    const searches = row.source === "research" ? safeRows(() => this.store.listRunGroundingRunRows(row.id)) : [];
    let searchCount = 0;
    let retryCount = numberValue(record.retryCount);
    for (const search of searches) {
      const parsed = parseRecord(search.recordJson);
      if (parsed.corrupt) continue;
      const queries = arrayValue(parsed.value.queries);
      searchCount += queries.length;
      retryCount += Math.max(0, numberValue(parsed.value.attempt) - 1);
    }
    for (const model of modelCalls) {
      const parsed = parseRecord(model.recordJson);
      if (!parsed.corrupt) retryCount += Math.max(0, numberValue(parsed.value.retryCount));
    }
    return { modelCallCount: modelCalls.length, searchCount, retryCount };
  }

  private modelCalls(runId: string): RunRecordModelCallView[] {
    return safeRows(() => this.store.listRunModelCallRows(runId)).map((row) => modelCallView(row));
  }

  private searches(taskId: string): RunRecordSearchView[] {
    return safeRows(() => this.store.listRunGroundingRunRows(taskId)).map((row) => {
      const parsed = parseRecord(row.recordJson);
      if (parsed.corrupt) return corruptSearch(row);
      const run = parsed.value;
      const sources = safeRows(() => this.store.listRunGroundingSourceRows(stringValue(run.id) || row.id))
        .map((source) => sourceView(source));
      return {
        id: safeId(run.id, row.id),
        provider: safeText(run.provider),
        model: safeText(run.model),
        scenario: safeText(run.scenario),
        status: safeText(run.status),
        attempt: positiveNumber(run.attempt, 1),
        queries: arrayValue(run.queries).map((query) => safeQuery(query)),
        sourceCount: numberValue(run.sourceCount) || sources.length,
        citationCount: numberValue(run.citationCount),
        ...(run.responseSummary && typeof run.responseSummary === "object" ? { responseSummary: safeObject(run.responseSummary) } : {}),
        ...(run.trace && Array.isArray(run.trace) ? { trace: safeSearchTrace(run.trace) } : {}),
        ...(run.errorMessage ? { errorMessage: safeText(run.errorMessage) } : {}),
        createdAt: safeText(run.createdAt, row.createdAt),
        ...(stringValue(run.completedAt) ? { completedAt: safeText(run.completedAt) } : {}),
        sources,
      };
    });
  }
}

function sourceForOperation(operation: RunRecordOperationType): ObservabilityRecordSource {
  if (operation === "research") return "research";
  if (operation === "document_import") return "import";
  if (operation === "chapter_parse") return "chapter";
  return "fusion"; // similarity_verification
}

function statusesForStatus(status: RunRecordStatus): string[] {
  if (status === "running") return ["running", "processing", "waiting_for_budget"];
  if (status === "corrupt") return [];
  return [status];
}

function statusesForOutcome(outcome: RunRecordOutcome): string[] {
  if (outcome === "active") return ["queued", "running", "processing", "waiting_for_budget"];
  if (outcome === "success") return ["completed"];
  if (outcome === "failure") return ["failed"];
  if (outcome === "cancelled") return ["cancelled"];
  return [];
}

function parseLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) throw new RunRecordsValidationError("limit must be between 1 and 50");
  return value;
}

function parseRunRecordListInput(input: RunRecordListInput): ParsedRunRecordListInput {
  return {
    limit: parseLimit(input.limit),
    operation: parseOperationType(input.operationType),
    outcome: parseOutcome(input.outcome),
    status: parseStatus(input.status),
    ...(input.cursor ? { cursor: decodeCursor(input.cursor) } : {}),
    dateRange: parseDateRange(input.from, input.to),
  };
}

function normalizeRunRecordExportFilters(input: RunRecordListInput): RunRecordExportFilters {
  const parsed = parseRunRecordListInput({ ...input, limit: 1, cursor: undefined });
  return {
    ...(parsed.dateRange.from ? { from: parsed.dateRange.from } : {}),
    ...(parsed.dateRange.to ? { to: parsed.dateRange.to } : {}),
    ...(parsed.operation ? { operationType: parsed.operation } : {}),
    ...(parsed.outcome ? { outcome: parsed.outcome } : {}),
    ...(parsed.status ? { status: parsed.status } : {}),
  };
}

function parseDateRange(from: string | undefined, to: string | undefined): { from?: string; to?: string } {
  const result: { from?: string; to?: string } = {};
  if (from !== undefined) result.from = parseDate(from, "from");
  if (to !== undefined) result.to = parseDate(to, "to");
  if (result.from && result.to && result.from >= result.to) throw new RunRecordsValidationError("from must be earlier than to");
  return result;
}

function parseDate(value: string, name: string): string {
  const date = new Date(value);
  if (!value.trim() || Number.isNaN(date.getTime())) throw new RunRecordsValidationError(`${name} must be a valid date`);
  return date.toISOString();
}

function parseOperationType(value: string | undefined): RunRecordOperationType | undefined {
  if (!value || value === "all") return undefined;
  if ((OPERATION_TYPES as readonly string[]).includes(value)) return value as RunRecordOperationType;
  throw new RunRecordsValidationError("operationType is not supported");
}

function parseOutcome(value: string | undefined): RunRecordOutcome | undefined {
  if (!value || value === "all") return undefined;
  if ((OUTCOMES as readonly string[]).includes(value)) return value as RunRecordOutcome;
  throw new RunRecordsValidationError("outcome is not supported");
}

function parseStatus(value: string | undefined): RunRecordStatus | undefined {
  if (!value || value === "all") return undefined;
  if ((STATUSES as readonly string[]).includes(value)) return value as RunRecordStatus;
  throw new RunRecordsValidationError("status is not supported");
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (parsed.v !== CURSOR_VERSION || typeof parsed.createdAt !== "string" || typeof parsed.id !== "string" || !parsed.id) throw new Error();
    if (Number.isNaN(new Date(parsed.createdAt).getTime())) throw new Error();
    return { v: CURSOR_VERSION, createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new RunRecordsValidationError("cursor is invalid");
  }
}

function parsePublicId(value: string): { source: ObservabilityRecordSource; id: string } {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) throw new RunRecordsValidationError("run record id is invalid");
  const source = value.slice(0, separator);
  if (!(SOURCES as readonly string[]).includes(source)) throw new RunRecordsValidationError("run record id is invalid");
  return { source: source as ObservabilityRecordSource, id: value.slice(separator + 1) };
}

function publicId(source: ObservabilityRecordSource, id: string): string { return `${source}:${id}`; }

function parseRecord(recordJson: string): ParsedRecord {
  try {
    const parsed: unknown = JSON.parse(recordJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return { value: parsed as Record<string, unknown>, corrupt: false };
  } catch {
    return { value: {}, corrupt: true };
  }
}

function operationTypeForRow(row: ObservabilityRecordRow): RunRecordOperationType {
  if (OPERATION_TYPES.includes(row.operationType as RunRecordOperationType)) return row.operationType as RunRecordOperationType;
  if (row.source === "research") return "research";
  if (row.source === "import") return "document_import";
  if (row.source === "fusion") return "similarity_verification";
  return "chapter_parse";
}

function statusForRow(row: ObservabilityRecordRow, record: Record<string, unknown>): RunRecordStatus {
  // 相似性核验记录写入时模型调用已经结束；其 pending 审计形态不代表运行中。
  if (row.source === "fusion") return "completed";
  const status = stringValue(record.status) || row.status;
  if (status === "processing" || status === "waiting_for_budget") return "running";
  if (status === "queued" || status === "running" || status === "completed" || status === "failed" || status === "cancelled") return status;
  return "corrupt";
}

function outcomeForStatus(status: RunRecordStatus): RunRecordOutcome {
  if (status === "completed") return "success";
  if (status === "failed") return "failure";
  if (status === "cancelled") return "cancelled";
  if (status === "queued" || status === "running") return "active";
  return "unavailable";
}

function timesFor(record: Record<string, unknown>, createdAt: string): { startedAt?: string; completedAt?: string; durationMs?: number } {
  const startedAt = validDate(record.startedAt);
  const completedAt = validDate(record.completedAt);
  if (!startedAt) return completedAt ? { completedAt } : {};
  if (completedAt) return { startedAt, completedAt, durationMs: durationBetween(startedAt, completedAt) };
  const updatedAt = validDate(record.updatedAt);
  return { startedAt, ...(updatedAt ? { durationMs: durationBetween(startedAt, updatedAt) } : {}), ...(createdAt ? {} : {}) };
}

function durationBetween(startedAt: string, completedAt: string): number | undefined {
  const duration = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function titleFor(record: Record<string, unknown>): string | undefined {
  const title = stringValue(record.title);
  return title ? safeText(title, undefined, 160) : undefined;
}

function taskView(source: ObservabilityRecordSource, record: Record<string, unknown>): RunRecordTaskView | undefined {
  if (source === "research") {
    const task = record as Partial<ResearchTaskRecord>;
    return { id: safeId(task.id), ...(safeText(task.sessionId) ? { sessionId: safeText(task.sessionId) } : {}), ...(safeText(task.provider) ? { provider: safeText(task.provider) } : {}), ...(safeText(task.model) ? { model: safeText(task.model) } : {}), ...(safeText(task.promptVersion) ? { promptVersion: safeText(task.promptVersion) } : {}), ...(Number.isSafeInteger(task.sliceCount) && (task.sliceCount ?? -1) >= 0 ? { sliceCount: task.sliceCount ?? 0 } : {}), ...(typeof task.retryable === "boolean" ? { retryable: task.retryable } : {}), ...(safeContextExplanationCodes(task.contextExplanations).length ? { contextExplanations: safeContextExplanationCodes(task.contextExplanations) } : {}) };
  }
  if (source === "import") {
    const task = record as Partial<ResearchImportTaskRecord>;
    return { id: safeId(task.id), ...(safeText(task.sessionId) ? { sessionId: safeText(task.sessionId) } : {}), ...(typeof task.retryable === "boolean" ? { retryable: task.retryable } : {}) };
  }
  if (source === "chapter") {
    const task = record as Partial<ResearchChapterTaskRecord>;
    return { id: safeId(task.id), ...(safeText(task.sessionId) ? { sessionId: safeText(task.sessionId) } : {}), ...(safeText(task.provider) ? { provider: safeText(task.provider) } : {}), ...(safeText(task.model) ? { model: safeText(task.model) } : {}), ...(safeText(task.promptVersion) ? { promptVersion: safeText(task.promptVersion) } : {}), ...(typeof task.retryable === "boolean" ? { retryable: task.retryable } : {}) };
  }
  // fusion（相似性核验）提议记录：仅取 id。
  return { id: safeId(record.id) };
}

function modelCallView(row: ObservabilityRelatedRow): RunRecordModelCallView {
  const parsed = parseRecord(row.recordJson);
  if (parsed.corrupt) return { id: publicRelatedId(row.id), provider: "unknown", model: "unknown", purpose: "unknown", promptVersion: "unknown", status: "corrupt", inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, latencyMs: 0, retryCount: 0, createdAt: row.createdAt, errorMessage: "这次模型调用无法读取，原始内容已隐藏。" };
  const call = parsed.value as Partial<ModelCallRecord>;
  const status = call.status === "completed" || call.status === "failed" ? call.status : "corrupt";
  const contextAssembly = safeContextObservation(call.contextAssembly);
  const envelope = safeEnvelopeObservation(call.envelope);
  const requestedBudget = safeRequestedBudget(call.requestedBudget);
  const resolvedBudget = safeResolvedBudget(call.resolvedBudget);
  const appliedBudget = safeAppliedBudget(call.appliedBudget);
  return {
    id: publicRelatedId(safeId(call.id, row.id)),
    provider: safeText(call.provider),
    model: safeText(call.model),
    purpose: safeText(call.purpose),
    promptVersion: safeText(call.promptVersion),
    ...(call.answerPlanId ? { answerPlanId: safeId(call.answerPlanId) } : {}),
    ...(envelope ? { envelope } : {}),
    ...(call.availability?.status === "available" || call.availability?.status === "unavailable" ? { availability: { status: call.availability.status, ...(call.availability.reason ? { reason: safeText(call.availability.reason) } : {}) } } : {}),
    ...(requestedBudget ? { requestedBudget } : {}),
    ...(resolvedBudget ? { resolvedBudget } : {}),
    ...(appliedBudget ? { appliedBudget } : {}),
    ...(Array.isArray(call.sourceSliceIds) ? { sourceSliceIds: call.sourceSliceIds.map((id) => safeId(id)).filter((id) => id !== "unknown").slice(0, 200) } : {}),
    ...(Array.isArray(call.sourceFragmentIds) ? { sourceFragmentIds: call.sourceFragmentIds.map((id) => safeId(id)).filter((id) => id !== "unknown").slice(0, 200) } : {}),
    ...(typeof call.tokenBudget === "number" && Number.isFinite(call.tokenBudget) && call.tokenBudget >= 0 ? { tokenBudget: Math.trunc(call.tokenBudget) } : {}),
    ...(contextAssembly ? { contextAssembly } : {}),
    ...(call.finishReason ? { finishReason: safeText(call.finishReason, "unknown", 80) } : {}),
    ...(["length", "empty_body", "task_mismatch_truncation"].includes(call.completionDiagnostic ?? "")
      ? { completionDiagnostic: call.completionDiagnostic as RunRecordModelCallView["completionDiagnostic"] }
      : {}),
    ...(typeof call.toolCallCount === "number" ? { toolCallCount: Math.trunc(nonNegativeNumber(call.toolCallCount)) } : {}),
    ...(safeModelCallErrorCategory(call.errorCategory) ? { errorCategory: safeModelCallErrorCategory(call.errorCategory) } : {}),
    ...(call.buildFingerprint ? { buildFingerprint: safeText(call.buildFingerprint, "development", 200) } : {}),
    status,
    inputTokens: nonNegativeNumber(call.inputTokens),
    outputTokens: nonNegativeNumber(call.outputTokens),
    cacheHitTokens: nonNegativeNumber(call.cacheHitTokens),
    ...(typeof call.estimatedCostUsd === "number" ? { estimatedCostUsd: nonNegativeNumber(call.estimatedCostUsd) } : {}),
    ...(call.costStatus === "estimated" || call.costStatus === "unknown" ? { costStatus: call.costStatus } : {}),
    latencyMs: nonNegativeNumber(call.latencyMs),
    retryCount: nonNegativeNumber(call.retryCount),
    ...(call.errorMessage ? { errorMessage: safeText(call.errorMessage) } : {}),
    createdAt: safeText(call.createdAt, row.createdAt),
    ...(validDate(call.completedAt) ? { completedAt: safeText(call.completedAt) } : {}),
  };
}

function safeEnvelopeObservation(value: unknown): PromptEnvelopeObservation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  if (input.version !== "prompt-envelope-v1") return undefined;
  const output = input.outputContract && typeof input.outputContract === "object"
    ? input.outputContract as Record<string, unknown>
    : undefined;
  if (!output || !["text", "json_object", "tool_calls"].includes(stringValue(output.format) ?? "")) return undefined;
  const roles = input.roleCounts && typeof input.roleCounts === "object"
    ? input.roleCounts as Record<string, unknown>
    : {};
  return {
    version: "prompt-envelope-v1",
    purpose: safeText(input.purpose, "unknown", 120),
    promptVersion: safeText(input.promptVersion, "unknown", 120),
    messageCount: Math.trunc(nonNegativeNumber(input.messageCount)),
    roleCounts: {
      ...positiveRoleCount("system", roles.system),
      ...positiveRoleCount("user", roles.user),
      ...positiveRoleCount("assistant", roles.assistant),
      ...positiveRoleCount("tool", roles.tool),
    },
    estimatedInputTokens: Math.trunc(nonNegativeNumber(input.estimatedInputTokens)),
    outputContract: {
      format: stringValue(output.format) as PromptEnvelopeObservation["outputContract"]["format"],
      contractVersion: safeText(output.contractVersion, "unknown", 120),
      minimumBodyTokens: Math.trunc(nonNegativeNumber(output.minimumBodyTokens)),
    },
  };
}

function positiveRoleCount(role: "system" | "user" | "assistant" | "tool", value: unknown): Partial<Record<typeof role, number>> {
  const count = Math.trunc(nonNegativeNumber(value));
  return count > 0 ? { [role]: count } : {};
}

function safeRequestedBudget(value: unknown): RequestedModelBudget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.thinking !== "boolean") return undefined;
  return {
    maxInputTokens: Math.trunc(nonNegativeNumber(input.maxInputTokens)),
    maxOutputTokens: Math.trunc(nonNegativeNumber(input.maxOutputTokens)),
    minimumBodyTokens: Math.trunc(nonNegativeNumber(input.minimumBodyTokens)),
    thinking: input.thinking,
  };
}

function safeResolvedBudget(value: unknown): ResolvedModelBudget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  if (input.status !== "resolved" || typeof input.thinking !== "boolean"
    || !["none", "shared_output", "separate"].includes(stringValue(input.reasoningBudgetMode) ?? "")) return undefined;
  return {
    status: "resolved",
    budgetResolutionAttemptId: safeId(input.budgetResolutionAttemptId),
    ...(typeof input.previousBudgetResolutionAttemptId === "string"
      ? { previousBudgetResolutionAttemptId: safeId(input.previousBudgetResolutionAttemptId) }
      : {}),
    estimatedInputTokens: Math.trunc(nonNegativeNumber(input.estimatedInputTokens)),
    maxInputTokens: Math.trunc(nonNegativeNumber(input.maxInputTokens)),
    maxOutputTokens: Math.trunc(nonNegativeNumber(input.maxOutputTokens)),
    minimumBodyTokens: Math.trunc(nonNegativeNumber(input.minimumBodyTokens)),
    thinking: input.thinking,
    reasoningBudgetMode: stringValue(input.reasoningBudgetMode) as ResolvedModelBudget["reasoningBudgetMode"],
  };
}

function safeAppliedBudget(value: unknown): AppliedModelBudget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.thinking !== "boolean") return undefined;
  return {
    maxOutputTokens: Math.trunc(nonNegativeNumber(input.maxOutputTokens)),
    thinking: input.thinking,
  };
}

function safeModelCallErrorCategory(value: unknown): ModelCallRecord["errorCategory"] | undefined {
  return typeof value === "string" && ["authentication", "network", "validation", "provider", "budget", "unknown"].includes(value)
    ? value as ModelCallRecord["errorCategory"]
    : undefined;
}

const SAFE_CONTEXT_CHANNELS = new Set(["behavior_rule", "factual_evidence", "user_adaptation"]);
const SAFE_CONTEXT_CATEGORIES = new Set([
  "product_boundary", "task_contract", "safety", "turn_instruction", "project_instruction", "global_instruction",
  "current_question", "explicit_material", "conversation_history", "research_context", "imported_material", "web_evidence", "tool_result", "continuation_state",
  "user_profile", "long_term_memory", "mastered_knowledge",
]);
const SAFE_CONTEXT_SOURCE_KINDS = new Set(["product_rule", "task_rule", "user_instruction", "conversation", "research_content", "imported_material", "web_source", "tool_result", "continuation", "user_profile", "long_term_memory", "mastered_knowledge", "system_probe"]);
const SAFE_CONTEXT_REJECTION_REASONS = new Set(["unknown_purpose", "channel_not_allowed", "purpose_not_allowed", "permission_denied", "scope_mismatch", "source_revoked", "sensitivity_not_allowed", "secret", "invalid_candidate", "duplicate", "conflict", "budget_exhausted", "lower_priority"]);
const SAFE_CONTEXT_EXPLANATIONS = new Set<ContextExplanationCode>(["imported_material_used", "history_used", "personalization_used", "personalization_not_used", "context_reduced", "retrieval_degraded"]);

function safeContextExplanationCodes(value: unknown): ContextExplanationCode[] {
  return Array.isArray(value) ? [...new Set(value.filter((code): code is ContextExplanationCode => typeof code === "string" && SAFE_CONTEXT_EXPLANATIONS.has(code as ContextExplanationCode)))].slice(0, 6) : [];
}

function safeContextObservation(value: unknown): ContextAssemblyObservation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  if (input.status !== "assembled" && input.status !== "rejected") return undefined;
  const purpose = typeof input.purpose === "string" && (CONTEXT_PURPOSES as readonly string[]).includes(input.purpose) ? input.purpose : "unknown";
  const categories = (items: unknown, rejected: boolean) => Array.isArray(items) ? items.slice(0, 50).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.channel !== "string" || !SAFE_CONTEXT_CHANNELS.has(item.channel)
      || typeof item.sourceKind !== "string" || !SAFE_CONTEXT_SOURCE_KINDS.has(item.sourceKind)) return [];
    const count = nonNegativeNumber(item.count);
    if (count < 1) return [];
    const category = typeof item.category === "string" && SAFE_CONTEXT_CATEGORIES.has(item.category) ? item.category : undefined;
    const reason = typeof item.reason === "string" && SAFE_CONTEXT_REJECTION_REASONS.has(item.reason) ? item.reason : undefined;
    if (rejected && !reason) return [];
    return [{ channel: item.channel, ...(category ? { category } : {}), sourceKind: item.sourceKind, count, ...(reason ? { reason } : {}) }];
  }) : [];
  const adoptedCategories = categories(input.adoptedCategories, false) as ContextAssemblyObservation["adoptedCategories"];
  const rejectedCategories = categories(input.rejectedCategories, true) as ContextAssemblyObservation["rejectedCategories"];
  const budgetInput = input.budget && typeof input.budget === "object" ? input.budget as Record<string, unknown> : undefined;
  const budget = budgetInput ? {
    maxInputTokens: nonNegativeNumber(budgetInput.maxInputTokens),
    reservedOutputTokens: nonNegativeNumber(budgetInput.reservedOutputTokens),
    usedInputTokens: nonNegativeNumber(budgetInput.usedInputTokens),
    remainingInputTokens: nonNegativeNumber(budgetInput.remainingInputTokens),
  } : undefined;
  return {
    status: input.status,
    assemblyAttemptId: safeId(input.assemblyAttemptId, "legacy"),
    ...(typeof input.previousAssemblyAttemptId === "string" ? { previousAssemblyAttemptId: safeId(input.previousAssemblyAttemptId) } : {}),
    purpose,
    adoptedCount: nonNegativeNumber(input.adoptedCount),
    rejectedCount: nonNegativeNumber(input.rejectedCount),
    adoptedCategories,
    rejectedCategories,
    ...(budget ? { budget } : {}),
  };
}

function sourceView(row: ObservabilityRelatedRow): { title: string; url?: string; snippet?: string; evidenceStatus?: "full" | "partial" | "none" } {
  const parsed = parseRecord(row.recordJson);
  if (parsed.corrupt) return { title: "来源无法读取" };
  const source = parsed.value as Partial<ResearchGroundingSourceRecord>;
  const url = sanitizeGroundingUrl(stringValue(source.url));
  const evidenceStatus = source.evidenceStatus === "full" || source.evidenceStatus === "partial" || source.evidenceStatus === "none" ? source.evidenceStatus : undefined;
  return {
    title: safeText(source.title, "未命名来源"),
    ...(url ? { url } : {}),
    ...(safeText(source.snippet) ? { snippet: safeText(source.snippet) } : {}),
    ...(evidenceStatus ? { evidenceStatus } : {}),
  };
}

function corruptSearch(row: ObservabilityRelatedRow): RunRecordSearchView {
  return { id: publicRelatedId(row.id), provider: "unknown", model: "unknown", scenario: "unknown", status: "corrupt", attempt: 0, queries: [], sourceCount: 0, citationCount: 0, createdAt: row.createdAt, sources: [], errorMessage: "这次搜索无法读取，原始内容已隐藏。" };
}

function errorsFor(source: ObservabilityRecordSource, record: Record<string, unknown>, modelCalls: RunRecordModelCallView[], searches: RunRecordSearchView[]): RunRecordErrorView[] {
  const errors: RunRecordErrorView[] = [];
  const taskError = record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>).message : record.errorMessage;
  if (taskError) errors.push(errorView("task", taskError));
  for (const call of modelCalls) if (call.errorMessage) errors.push(errorView("model", call.errorMessage));
  for (const search of searches) if (search.errorMessage) errors.push(errorView("search", search.errorMessage));
  return errors;
}

function errorView(source: RunRecordErrorView["source"], message: unknown): RunRecordErrorView {
  const safeMessage = safeText(message);
  return { source, category: classifyError(source, safeMessage), message: safeMessage };
}

function classifyError(source: RunRecordErrorView["source"], message: string): RunRecordErrorCategory {
  if (source === "record") return "storage";
  if (/(?:authorization|authenticate|credential|cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|bearer|unauthorized|forbidden)/i.test(message)) return "authentication";
  if (/(?:invalid|validation|required|missing|malformed|schema|input)/i.test(message)) return "validation";
  if (/(?:timeout|timed out|network|connect|fetch|dns|econn|offline|unreachable)/i.test(message)) return "network";
  if (source === "search") return "search";
  if (source === "model" || /(?:provider|model|gateway|unsupported)/i.test(message)) return "provider";
  return "unknown";
}

function safeRows(read: () => ObservabilityRelatedRow[]): ObservabilityRelatedRow[] {
  try { return read(); } catch { return []; }
}

function safeText(value: unknown, fallback = "未记录", maxCharacters = SAFE_TEXT_LIMIT): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const redacted = String(redactGroundingValue(value, maxCharacters)).replace(SECRET_VALUE, "[REDACTED]");
  return redacted.length > maxCharacters ? `${redacted.slice(0, maxCharacters)}…` : redacted;
}

function safeQuery(value: unknown): string {
  return safeText(value, "未记录", SAFE_QUERY_LIMIT);
}

/** #49 失败留痕脱敏：每条 URL 经 sanitizeGroundingUrl，消息字段经 safeText，整体再走密钥键脱敏。 */
function safeSearchTrace(trace: unknown): ResearchGroundingTraceEntry[] {
  return arrayValue(trace).slice(0, 50).map((entry) => {
    const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const url = stringValue(item.url);
    const safeUrl = url ? sanitizeGroundingUrl(url) : undefined;
    return redactSensitiveKeys({
      stage: safeText(item.stage, "search", 20),
      domain: safeText(item.domain, "unknown", 180),
      ...(safeUrl ? { url: safeUrl } : {}),
      status: safeText(item.status, "unknown", 40),
      ...(numberValue(item.attempts) > 0 ? { attempts: numberValue(item.attempts) } : {}),
      latencyMs: nonNegativeNumber(item.latencyMs),
      ...(stringValue(item.errorCategory) ? { errorCategory: safeText(item.errorCategory, "", 40) } : {}),
      ...(numberValue(item.httpStatus) > 0 ? { httpStatus: numberValue(item.httpStatus) } : {}),
      ...(stringValue(item.retryReason) ? { retryReason: safeText(item.retryReason) } : {}),
      ...(stringValue(item.fallbackReason) ? { fallbackReason: safeText(item.fallbackReason) } : {}),
      ...(stringValue(item.evidenceStatus) ? { evidenceStatus: safeText(item.evidenceStatus, "", 20) } : {}),
    }) as ResearchGroundingTraceEntry;
  });
}

function safeObject(value: unknown): Record<string, unknown> {
  const redacted = redactGroundingValue(value, SAFE_TEXT_LIMIT);
  return redactSensitiveKeys(redacted) as Record<string, unknown>;
}

function redactSensitiveKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveKeys);
  if (!value || typeof value !== "object") return typeof value === "string" ? value.replace(SECRET_VALUE, "[REDACTED]") : value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : redactSensitiveKeys(item)]));
}

function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function numberValue(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function nonNegativeNumber(value: unknown): number { return Math.max(0, numberValue(value)); }
function positiveNumber(value: unknown, fallback: number): number { const number = numberValue(value); return number > 0 ? number : fallback; }
function validDate(value: unknown): string | undefined { const text = stringValue(value); return text && !Number.isNaN(new Date(text).getTime()) ? new Date(text).toISOString() : undefined; }
function safeId(value: unknown, fallback = "unknown"): string { return safeText(value, fallback, 180).replace(/[^A-Za-z0-9._:-]/g, "_"); }
function publicRelatedId(value: string): string { return `related:${safeId(value)}`; }
