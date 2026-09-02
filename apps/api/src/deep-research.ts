import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_COMPOSER_PREFERENCES,
  normalizeComposerPreferences,
  buildGraphProjection,
  buildResearchGraphObservation,
  isResearchPermanentEdge,
  deriveDefaultResearchTitle,
  type CreateChildNodeInput,
  type ComposerPreferences,
  type DeepResearchAccepted,
  type DeepResearchInput,
  type NodeGrowthAccepted,
  type ResearchBranchRecord,
  type ResearchBranchView,
  type ResearchGraphProjection,
  type ResearchGraphObservation,
  type ResearchGraphObservationInput,
  type ResearchEdgeRecord,
  type ResearchMessageRecord,
  type ResearchNodeRecord,
  type ResearchNodeView,
  type ResearchSelectionRecord,
  type ResearchSessionNodeTreeItem,
  type ResearchSessionRecord,
  type ResearchTaskRecord,
  type ResearchExecutionIntent,
  type ResearchTermPreviewInput,
  type ResearchTermPreviewRecord,
  type ResearchTurnAccepted,
  type ResearchTemporaryFusionMapNode,
} from "@collector/capture-contracts";
import type { DeepResearchStore } from "./store.js";
import { citedGroundingSources, DEEP_RESEARCH_PROMPT_VERSION, RESEARCH_CHAT_PROMPT_VERSION, isTrashed, type ResearchSessionService, type ResearchTurnOptions } from "./research.js";
import { buildTermMentionSelection, normalizeMentionText } from "./term-preview.js";
import { validateTermMarkers } from "./term-detection.js";

/** 分支模式首轮用户消息中选区原文的摘录长度。 */
const SELECTION_EXCERPT_CHARACTERS = 120;

/** 树导航节点标签的摘录长度（H2，H6 节点命名落地前的确定性标签）。 */
const TREE_LABEL_CHARACTERS = 48;

function frozenDeepResearchContext(
  selection: ResearchSelectionRecord,
  mode: "branch" | "session",
  contentTitle?: string,
): ResearchExecutionIntent["deepResearch"] {
  const context = {
    mode,
    selectionText: selection.text,
    ...(contentTitle ? { contentTitle } : {}),
    ...(selection.contextBefore ? { contextBefore: selection.contextBefore } : {}),
    ...(selection.contextAfter ? { contextAfter: selection.contextAfter } : {}),
  };
  return {
    mode,
    selectionId: selection.id,
    sourceMessageId: selection.anchor.kind === "message" ? selection.anchor.messageId : selection.anchor.contentSnapshotId,
    context,
    contextFingerprint: createHash("sha256").update(JSON.stringify(context)).digest("hex"),
  };
}

/** 节点生长首轮用户消息的包装前缀（选区生长模板，见 defaultFirstTurnContent）。 */
export const NODE_GROWTH_FIRST_TURN_PREFIX = "深入研究这段内容：";

/**
 * 若内容是节点生长首轮的包装提示（深入研究这段内容：“选区摘录”），返回其中引用的选区摘录正文；否则返回 undefined。
 * 供确定性节点命名等场景还原用户真正引用的文本，避免把包装前缀当作节点名。
 */
export function extractNodeGrowthSelectionText(content: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith(NODE_GROWTH_FIRST_TURN_PREFIX)) return undefined;
  const match = trimmed.slice(NODE_GROWTH_FIRST_TURN_PREFIX.length).trim().match(/^“([\s\S]+)”$/);
  if (!match) return undefined;
  const inner = match[1].trim();
  return inner || undefined;
}

export interface DeepResearchServiceOptions {
  /** 深入研究任务复用研究会话任务管线（claim / 事件 / 重试 / 重启恢复）。 */
  research: ResearchSessionService;
  autoRunTasks?: boolean;
}

/** 融合证据健康只从来源节点与会话生命周期派生，绝不回写确认正文、快照或永久边。 */
export function deriveFusionEvidenceHealth(
  nodes: readonly ResearchNodeRecord[],
  edges: readonly ResearchEdgeRecord[],
  sessions: readonly ResearchSessionRecord[] = [],
  confirmedSourceHealth: readonly { fusionNodeId: string; sourceHealth: "available" | "temporarily-unavailable" | "deleted" }[] = [],
): Map<string, "available" | "temporarily-unavailable" | "deleted" | "incomplete"> {
  const liveNodeIds = new Set(nodes.map((node) => node.id));
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const sourcesByFusionNodeId = new Map<string, Array<"available" | "temporarily-unavailable" | "deleted">>();
  for (const node of nodes) if (node.isFusionNode) sourcesByFusionNodeId.set(node.id, []);
  for (const edge of edges) {
    if (edge.status !== "active" || edge.kind !== "fused-from") continue;
    const source = nodeById.get(edge.fromNodeId);
    const health = !liveNodeIds.has(edge.fromNodeId)
      ? "deleted"
      : sessionById.get(source?.sessionId ?? "")?.trashedAt
        ? "temporarily-unavailable"
        : "available";
    sourcesByFusionNodeId.get(edge.toNodeId)?.push(health);
  }
  return new Map([...sourcesByFusionNodeId].map(([nodeId, sourceHealth]) => [
    nodeId,
    (() => {
      const projectedHealth = confirmedSourceHealth
        .filter((source) => source.fusionNodeId === nodeId)
        .map((source) => source.sourceHealth);
      const effectiveHealth = projectedHealth.length > 0 ? projectedHealth : sourceHealth;
      return effectiveHealth.includes("deleted")
        ? "deleted" as const
        : effectiveHealth.includes("temporarily-unavailable")
          ? "temporarily-unavailable" as const
          : effectiveHealth.filter((health) => health === "available").length >= 2
            ? "available" as const
            : "incomplete" as const;
    })(),
  ]));
}

export class DeepResearchService {
  constructor(private readonly store: DeepResearchStore, private readonly options: DeepResearchServiceOptions) {}

  /**
   * 从选区发起深入研究：先在同一事务保存来源关系（分支或带 origin 的新会话）
   * 与第一轮消息、任务，再排队异步生成。幂等键命中时返回首次创建的分支 / 会话
   * 与任务，不重复创建。生成失败不删除来源关系。
   */
  async startDeepResearch(selectionId: string, input: DeepResearchInput, idempotencyKey: string): Promise<DeepResearchAccepted> {
    if (!idempotencyKey.trim()) throw new DeepResearchValidationError("Idempotency-Key is required");
    if (idempotencyKey.length > 200) throw new DeepResearchValidationError("Idempotency-Key must not exceed 200 characters");
    const selection = this.store.getResearchSelection(selectionId);
    if (!selection) throw new DeepResearchNotFoundError("Research selection not found");
    const originSession = this.store.getResearchSession(selection.sessionId);
    if (!originSession) throw new Error("Research selection references a missing session");
    if (isTrashed(originSession)) throw new DeepResearchConflictError("Research session is in trash");

    const now = new Date().toISOString();
    const firstTurnContent = input.direction?.trim() || defaultFirstTurnContent(selection);
    const sourceNode = this.store.getResearchNode(selection.nodeId ?? selection.sessionId);
    const inherited = normalizeComposerPreferences(sourceNode?.composerPreferences);
    const preferences: ComposerPreferences = {
      webSearchMode: input.webSearchMode ?? (input.allowWebSearch === undefined ? inherited.webSearchMode : input.allowWebSearch ? "required" : "off") ?? "off",
      thinkingEnabled: input.thinkingEnabled ?? inherited.thinkingEnabled,
    };
    const contentTitle = selection.anchor.kind === "snapshot"
      ? this.store.getResearchContentSnapshot(selection.anchor.contentSnapshotId)?.title
      : originSession.title;
    const deepContext = frozenDeepResearchContext(selection, input.mode, contentTitle);
    const executionIntent = await this.options.research.resolveExecutionIntent("deep_research", preferences, deepContext);

    let accepted: DeepResearchAccepted;
    if (input.mode === "branch") {
      const branch: ResearchBranchRecord = {
        id: randomUUID(), sessionId: selection.sessionId, selectionId: selection.id,
        status: "active", createdAt: now, updatedAt: now,
      };
      const { inputMessage, outputMessage, task } = await this.buildFirstTurn(selection.sessionId, branch.id, firstTurnContent, idempotencyKey, now, preferences, executionIntent);
      accepted = await this.store.createResearchBranch(originSession, branch, inputMessage, outputMessage, task, preferences);
    } else {
      const session: ResearchSessionRecord = {
        id: randomUUID(),
        title: input.title?.trim() || deriveDefaultResearchTitle(selection.text),
        status: "active",
        isFavorite: false,
        originSelectionId: selection.id,
        originSessionId: selection.sessionId,
        createdAt: now,
        updatedAt: now,
      };
      const { inputMessage, outputMessage, task } = await this.buildFirstTurn(session.id, undefined, firstTurnContent, idempotencyKey, now, preferences, executionIntent);
      accepted = await this.store.createOriginResearchSession(session, inputMessage, outputMessage, task, preferences);
    }
    this.scheduleTask(accepted.task.id);
    return accepted;
  }

  getBranchView(id: string): ResearchBranchView {
    const branch = this.store.getResearchBranch(id);
    if (!branch) throw new DeepResearchNotFoundError("Research branch not found");
    const session = this.store.getResearchSession(branch.sessionId);
    const selection = this.store.getResearchSelection(branch.selectionId);
    if (!session || !selection) throw new Error("Research branch references incomplete persisted state");
    const messages = this.store.listResearchMessages(branch.sessionId).filter((message) => message.branchId === branch.id);
    const messageIds = new Set(messages.map((message) => message.id));
    const tasks = this.store.listResearchTasks(branch.sessionId).filter((task) => messageIds.has(task.inputMessageId));
    const runIds = tasks.flatMap((task) => task.groundingScope?.runId ? [task.groundingScope.runId] : []);
    const citations = messages.length ? this.store.listResearchCitationsForMessages(messages.map((message) => message.id)) : [];
    const groundingSources = citedGroundingSources(
      runIds.flatMap((runId) => this.store.listResearchGroundingSources(runId)),
      citations,
    );
    return { branch, session, selection, messages, tasks, ...(groundingSources.length ? { groundingSources } : {}), ...(messages.length ? { citations } : {}) };
  }

  /** 分支内继续追问：消息带 branchId 与 nodeId，复用节点任务管线与幂等规则。 */
  async submitBranchMessage(branchId: string, content: string, idempotencyKey: string, options: ResearchTurnOptions = {}): Promise<ResearchTurnAccepted> {
    const branch = this.store.getResearchBranch(branchId);
    if (!branch) throw new DeepResearchNotFoundError("Research branch not found");
    if (!idempotencyKey.trim()) throw new DeepResearchValidationError("Idempotency-Key is required");
    if (idempotencyKey.length > 200) throw new DeepResearchValidationError("Idempotency-Key must not exceed 200 characters");

    const existing = this.store.findResearchTaskByIdempotencyKey(branch.sessionId, idempotencyKey);
    if (existing) {
      const session = this.store.getResearchSession(existing.sessionId);
      const inputMessage = this.store.getResearchMessage(existing.inputMessageId);
      const outputMessage = this.store.getResearchMessage(existing.outputMessageId);
      if (!session || !inputMessage || !outputMessage) throw new Error("Research task references incomplete persisted state");
      return { session, inputMessage, outputMessage, task: existing };
    }

    const session = this.store.getResearchSession(branch.sessionId);
    if (!session) throw new Error("Research branch references a missing session");
    const node = this.store.getResearchNode(branchId);
    if (!node) throw new Error("Research branch references a missing node");
    const now = new Date().toISOString();
    const inputMessage: ResearchMessageRecord = {
      id: randomUUID(), sessionId: branch.sessionId, nodeId: branch.id, branchId: branch.id, role: "user",
      content: content.trim(), status: "completed", createdAt: now, updatedAt: now,
    };
    const outputMessage: ResearchMessageRecord = {
      id: randomUUID(), sessionId: branch.sessionId, nodeId: branch.id, branchId: branch.id, role: "assistant",
      content: "", status: "pending", createdAt: now, updatedAt: now,
    };
    const currentPreferences = normalizeComposerPreferences(node.composerPreferences);
    const preferences: ComposerPreferences = {
      webSearchMode: options.webSearchMode ?? (options.allowWebSearch === undefined ? currentPreferences.webSearchMode : options.allowWebSearch ? "required" : "off") ?? "off",
      thinkingEnabled: options.thinkingEnabled ?? currentPreferences.thinkingEnabled,
    };
    const originSelection = this.store.getResearchSelection(branch.selectionId);
    if (!originSelection) throw new DeepResearchValidationError("深入研究上下文已不可用，无法继续该分支。");
    const executionIntent = await this.options.research.resolveExecutionIntent(
      "deep_research",
      preferences,
      frozenDeepResearchContext(originSelection, "branch", session.title),
    );
    const task: ResearchTaskRecord = {
      id: randomUUID(), sessionId: branch.sessionId, nodeId: branch.id, inputMessageId: inputMessage.id, outputMessageId: outputMessage.id,
      idempotencyKey, status: "queued", retryable: false,
      provider: executionIntent.model.provider,
      model: executionIntent.model.model,
      promptVersion: RESEARCH_CHAT_PROMPT_VERSION,
      webSearchMode: executionIntent.webSearch.mode,
      executionIntent,
      thinkingEnabled: executionIntent.thinking.applied,
      ...(executionIntent.webSearch.mode === "required" ? {} : { groundingScope: { status: "not_requested", sourceCount: 0, citationCount: 0 } }),
      createdAt: now, updatedAt: now,
    };
    const accepted = await this.store.createResearchTurnForNode({
      ...node,
      composerPreferences: preferences,
    }, inputMessage, outputMessage, task);
    this.scheduleTask(accepted.task.id);
    return accepted;
  }

  private async buildFirstTurn(
    sessionId: string,
    branchId: string | undefined,
    content: string,
    idempotencyKey: string,
    now: string,
    preferences: ComposerPreferences,
    executionIntent: ResearchExecutionIntent,
  ): Promise<{ inputMessage: ResearchMessageRecord; outputMessage: ResearchMessageRecord; task: ResearchTaskRecord }> {
    const inputMessage: ResearchMessageRecord = {
      id: randomUUID(), sessionId, branchId, role: "user",
      content, status: "completed", createdAt: now, updatedAt: now,
    };
    const outputMessage: ResearchMessageRecord = {
      id: randomUUID(), sessionId, branchId, role: "assistant",
      content: "", status: "pending", createdAt: now, updatedAt: now,
    };
    const task: ResearchTaskRecord = {
      id: randomUUID(), sessionId, inputMessageId: inputMessage.id, outputMessageId: outputMessage.id,
      idempotencyKey, status: "queued", retryable: false,
      provider: executionIntent.model.provider,
      model: executionIntent.model.model,
      promptVersion: DEEP_RESEARCH_PROMPT_VERSION,
      webSearchMode: executionIntent.webSearch.mode,
      executionIntent,
      thinkingEnabled: executionIntent.thinking.applied,
      ...(executionIntent.webSearch.mode === "required" ? {} : { groundingScope: { status: "not_requested", sourceCount: 0, citationCount: 0 } }),
      createdAt: now, updatedAt: now,
    };
    return { inputMessage, outputMessage, task };
  }

  private scheduleTask(id: string): void {
    if (this.options.autoRunTasks === false) return;
    setImmediate(() => void this.options.research.processTask(id).catch(() => undefined));
  }
}

/**
 * 节点生长服务（阶段 H）。
 * 从选区/弱标记生长子节点，并在同一事务中创建第一轮消息与任务；
 * 生成失败不删除节点与来源关系。
 */
export class NodeGrowthService {
  constructor(private readonly store: DeepResearchStore, private readonly options: DeepResearchServiceOptions) {}

  async startChildNode(selectionId: string, input: CreateChildNodeInput, idempotencyKey: string): Promise<NodeGrowthAccepted> {
    if (!idempotencyKey.trim()) throw new DeepResearchValidationError("Idempotency-Key is required");
    if (idempotencyKey.length > 200) throw new DeepResearchValidationError("Idempotency-Key must not exceed 200 characters");
    const selection = this.store.getResearchSelection(selectionId);
    if (!selection) throw new DeepResearchNotFoundError("Research selection not found");

    const parentNodeId = selection.nodeId ?? selection.sessionId;
    const parentNode = this.store.getResearchNode(parentNodeId);
    const session = this.store.getResearchSession(selection.sessionId);
    if (!parentNode) throw new Error("Research selection references a missing node");
    if (!session) throw new Error("Research selection references a missing session");

    const now = new Date().toISOString();
    const firstTurnContent = input.query?.trim() || defaultFirstTurnContent(selection);
    const inherited = normalizeComposerPreferences(parentNode.composerPreferences);
    const preferences: ComposerPreferences = {
      webSearchMode: input.webSearchMode ?? (input.allowWebSearch === undefined ? inherited.webSearchMode : input.allowWebSearch ? "required" : "off") ?? "off",
      thinkingEnabled: input.thinkingEnabled ?? inherited.thinkingEnabled,
    };
    const node: ResearchNodeRecord = {
      id: randomUUID(),
      sessionId: selection.sessionId,
      parentNodeId: parentNode.id,
      originSelectionId: selection.id,
      composerPreferences: preferences,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    const inputMessage: ResearchMessageRecord = {
      id: randomUUID(), sessionId: selection.sessionId, nodeId: node.id, role: "user",
      content: firstTurnContent, status: "completed", createdAt: now, updatedAt: now,
    };
    const outputMessage: ResearchMessageRecord = {
      id: randomUUID(), sessionId: selection.sessionId, nodeId: node.id, role: "assistant",
      content: "", status: "pending", createdAt: now, updatedAt: now,
    };
    const contentTitle = selection.anchor.kind === "snapshot"
      ? this.store.getResearchContentSnapshot(selection.anchor.contentSnapshotId)?.title
      : session.title;
    const executionIntent = await this.options.research.resolveExecutionIntent(
      "deep_research",
      preferences,
      frozenDeepResearchContext(selection, "branch", contentTitle),
    );
    const task: ResearchTaskRecord = {
      id: randomUUID(), sessionId: selection.sessionId, nodeId: node.id,
      inputMessageId: inputMessage.id, outputMessageId: outputMessage.id,
      idempotencyKey, status: "queued", retryable: false,
      provider: executionIntent.model.provider,
      model: executionIntent.model.model,
      promptVersion: DEEP_RESEARCH_PROMPT_VERSION,
      webSearchMode: executionIntent.webSearch.mode,
      executionIntent,
      thinkingEnabled: executionIntent.thinking.applied,
      ...(executionIntent.webSearch.mode === "required" ? {} : { groundingScope: { status: "not_requested", sourceCount: 0, citationCount: 0 } }),
      createdAt: now, updatedAt: now,
    };
    const accepted = await this.store.createResearchChildNode(parentNode, node, selection, inputMessage, outputMessage, task);
    this.scheduleTask(accepted.task.id);
    return accepted;
  }

  /** 点击已完成的术语预览：复用同一份内容创建子节点，不再发起第二次模型调用。 */
  async startChildNodeFromTermPreview(previewId: string, idempotencyKey: string, mention?: ResearchTermPreviewInput): Promise<NodeGrowthAccepted> {
    if (!idempotencyKey.trim()) throw new DeepResearchValidationError("Idempotency-Key is required");
    if (idempotencyKey.length > 200) throw new DeepResearchValidationError("Idempotency-Key must not exceed 200 characters");
    const preview = this.store.getResearchTermPreview(previewId);
    if (!preview) throw new DeepResearchNotFoundError("Research term preview not found");
    if (preview.status !== "completed" || !preview.content.trim()) {
      throw new DeepResearchValidationError("Research term preview is not ready");
    }
    // ADR-0029：子节点来源锚定用户实际点击的那次提及；未提供时回落为预览最初生成时的提及位置。
    const selection = mention
      ? this.resolveGrowthMentionSelection(preview, mention)
      : this.store.getResearchSelection(preview.selectionId);
    if (!selection) throw new Error("Research term preview references a missing selection");
    const parentNodeId = selection.nodeId ?? selection.sessionId;
    const parentNode = this.store.getResearchNode(parentNodeId);
    const session = this.store.getResearchSession(selection.sessionId);
    if (!parentNode || !session) throw new Error("Research term preview references incomplete node state");

    // 即使客户端丢失幂等键，也不允许同一术语来源重复生长多个子节点。
    // 三道防重：点击提及锚点、预览原始锚点（兼容无 mention 的旧客户端），
    // 以及真实客户端按预览派生幂等键的约定（`term-growth:{previewId}`）。
    const childNodes = this.store.listChildNodes(parentNode.id);
    const growthKeyConvention = `term-growth:${preview.id}`;
    const existingNode = childNodes.find((node) =>
      node.originSelectionId === selection.id || node.originSelectionId === preview.selectionId)
      ?? childNodes.find((node) =>
        this.store.listResearchTasksByNode(node.id)[0]?.idempotencyKey === growthKeyConvention);
    if (existingNode) {
      const existingTask = this.store.listResearchTasksByNode(existingNode.id)[0];
      const existingMessages = this.store.listResearchMessageBodiesByNode(existingNode.id);
      const inputMessage = existingTask ? this.store.getResearchMessage(existingTask.inputMessageId) : undefined;
      const outputMessage = existingTask ? this.store.getResearchMessage(existingTask.outputMessageId) : undefined;
      if (existingTask && inputMessage && outputMessage) return { node: existingNode, session, selection, inputMessage, outputMessage, task: existingTask };
      if (!existingMessages.length) throw new Error("Existing term child node is incomplete");
    }

    const now = new Date().toISOString();
    const node: ResearchNodeRecord = {
      id: randomUUID(),
      sessionId: selection.sessionId,
      parentNodeId: parentNode.id,
      originSelectionId: selection.id,
      status: "active",
      composerPreferences: normalizeComposerPreferences(parentNode.composerPreferences),
      createdAt: now,
      updatedAt: now,
    };
    const inputMessage: ResearchMessageRecord = {
      id: randomUUID(), sessionId: selection.sessionId, nodeId: node.id, role: "user",
      content: defaultFirstTurnContent(selection), status: "completed", createdAt: now, updatedAt: now,
    };
    const outputMessage: ResearchMessageRecord = {
      id: randomUUID(), sessionId: selection.sessionId, nodeId: node.id, role: "assistant",
      content: preview.content, status: "completed", createdAt: now, updatedAt: now,
    };
    const task: ResearchTaskRecord = {
      id: randomUUID(), sessionId: selection.sessionId, nodeId: node.id,
      inputMessageId: inputMessage.id, outputMessageId: outputMessage.id,
      idempotencyKey, status: "completed", retryable: false,
      provider: preview.provider, model: preview.model,
      promptVersion: preview.promptVersion,
      webSearchMode: "off",
      groundingScope: { status: "not_requested", sourceCount: 0, citationCount: 0 },
      createdAt: now, updatedAt: now, startedAt: now, completedAt: now,
    };
    return this.store.createResearchChildNode(parentNode, node, selection, inputMessage, outputMessage, task);
  }

  /**
   * 把用户实际点击的提及解析为子节点来源选区（ADR-0029）。
   * 同一锚点的选区复用既有记录；没有则构建新记录（由子节点创建事务一并落库）。
   */
  private resolveGrowthMentionSelection(preview: ResearchTermPreviewRecord, mention: ResearchTermPreviewInput): ResearchSelectionRecord {
    const node = this.store.getResearchNode(preview.nodeId);
    const session = this.store.getResearchSession(preview.sessionId);
    if (!node || !session) throw new Error("Research term preview references incomplete node state");
    const message = this.store.getResearchMessageBody(mention.messageId);
    // 点击后可以等待预览完成再生长，此时正文可能仍在流式追加；失败消息不提供生长入口。
    if (!message || message.nodeId !== node.id || message.role !== "assistant" || message.status === "failed") {
      throw new DeepResearchValidationError("Growth mention must reference a streaming or completed assistant message in the same node");
    }
    const marker = validateTermMarkers(message.content, [mention.marker])[0];
    if (!marker) throw new DeepResearchValidationError("Growth mention no longer matches the message");
    // 提及必须是该消息上真实存在的弱标记，不能把任意正文位置伪装成生长来源。
    const available = validateTermMarkers(
      message.content,
      this.store.getResearchTermMarkerTaskByMessage(message.id)?.markers ?? [],
    );
    const matches = available.some((candidate) =>
      candidate.text === marker.text
      && candidate.blockOrdinal === marker.blockOrdinal
      && candidate.startOffset === marker.startOffset
      && candidate.endOffset === marker.endOffset);
    if (!matches) throw new DeepResearchValidationError("Growth mention is not a term marker of the message");
    // 点击提及必须与预览指向同一对象（跨消息复用已在预览启动时按同文同类候选核验）。
    if (normalizeMentionText(marker.text) !== normalizeMentionText(preview.marker.text) || marker.category !== preview.marker.category) {
      throw new DeepResearchValidationError("Growth mention does not match the preview entity");
    }
    const existing = this.store.listResearchSelections(session.id).find((candidate) =>
      candidate.nodeId === node.id
      && candidate.anchor.kind === "message"
      && candidate.anchor.messageId === message.id
      && candidate.anchor.blockOrdinal === marker.blockOrdinal
      && candidate.anchor.startOffset === marker.startOffset
      && candidate.anchor.endOffset === marker.endOffset);
    if (existing) return existing;
    return buildTermMentionSelection(session, node, message, marker);
  }

  getNodeView(id: string): ResearchNodeView {
    const node = this.store.getResearchNode(id);
    if (!node) throw new DeepResearchNotFoundError("Research node not found");
    const session = this.store.getResearchSession(node.sessionId);
    if (!session) throw new Error("Research node references a missing session");
    const messages = this.store.listResearchMessagesByNode(id);
    const tasks = this.store.listResearchTasksByNode(id);
    const childNodes = this.store.listChildNodes(id);
    const runIds = tasks.flatMap((task) => task.groundingScope?.runId ? [task.groundingScope.runId] : []);
    const citations = messages.length ? this.store.listResearchCitationsForMessages(messages.map((message) => message.id)) : [];
    const groundingSources = citedGroundingSources(
      runIds.flatMap((runId) => this.store.listResearchGroundingSources(runId)),
      citations,
    );
    return {
      node,
      session,
      messages,
      tasks,
      childNodes,
      ...(groundingSources.length ? { groundingSources } : {}),
      ...(messages.length ? { citations } : {}),
      attachments: this.store.listResearchAttachments(node.sessionId),
      importTasks: this.store.listResearchImportTasks(node.sessionId),
    };
  }

  listChildNodes(parentNodeId: string): ResearchNodeRecord[] {
    return this.store.listChildNodes(parentNodeId);
  }

  /**
   * 会话节点树（H2 全屏树导航）：一次性返回整个会话的全部节点与确定性标签。
   * 返回扁平数组，客户端按 parentNodeId 自行构建树；label 不依赖 AI。
   */
  getNodeTree(sessionId: string): ResearchSessionNodeTreeItem[] {
    const session = this.store.getResearchSession(sessionId);
    if (!session) throw new DeepResearchNotFoundError("Research session not found");
    return this.store.listResearchNodes(sessionId).map((node) => {
      if (!node.parentNodeId) return { node, label: session.title };
      const selection = node.originSelectionId ? this.store.getResearchSelection(node.originSelectionId) : undefined;
      const originText = selection ? excerptText(selection.text, TREE_LABEL_CHARACTERS) : undefined;
      if (node.displayName) return { node, label: node.displayName, ...(originText ? { originText } : {}) };
      if (originText) return { node, label: originText, originText };
      const firstUser = this.store.listResearchMessageBodiesByNode(node.id).find((message) => message.role === "user");
      const firstMessage = firstUser ? excerptText(firstUser.content, TREE_LABEL_CHARACTERS) : undefined;
      return { node, label: firstMessage ?? "子节点", ...(firstMessage ? { firstMessage } : {}) };
    });
  }

  /**
   * 图投影（D1）：以 focusNodeId 为中心的关系视图。
   * 缺省焦点为会话根节点（sessionId === 根节点 id）。
   * 标签规则与节点树一致：displayName > 来源选区摘要 > 首条用户消息摘要 > 回退。
   */
  /** 图投影最大展开深度；省略时由共享投影使用默认深度。 */
  getGraphProjection(sessionId: string, focusNodeId?: string, maxDepth?: number): ResearchGraphProjection {
    const session = this.store.getResearchSession(sessionId);
    if (!session) throw new DeepResearchNotFoundError("Research session not found");
    const nodes = this.store.listResearchNodes(sessionId);
    const nodeIds = new Set(nodes.map((node) => node.id));
    const allEdges = this.store.listAllResearchEdges();
    const sessionEdges = allEdges.filter((edge) => isResearchPermanentEdge(edge) && nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId));
    const focus = focusNodeId ?? sessionId;
    return buildGraphProjection(nodes, sessionEdges, focus, {
      ...(maxDepth === undefined ? {} : { maxDepth }),
      nodeLabel: (node) => {
        if (!node.parentNodeId) return session.title;
        if (node.displayName) return node.displayName;
        const selection = node.originSelectionId ? this.store.getResearchSelection(node.originSelectionId) : undefined;
        const originText = selection ? excerptText(selection.text, TREE_LABEL_CHARACTERS) : undefined;
        if (originText) return originText;
        const firstUser = this.store.listResearchMessageBodiesByNode(node.id).find((message) => message.role === "user");
        if (firstUser) return excerptText(firstUser.content, TREE_LABEL_CHARACTERS);
        return "子节点";
      },
    });
  }

  /**
   * #62：统一 A 面全局观察。会话只提供生命周期与项目归属，不再截断节点或跨会话永久边；
   * 旧 semantic-related 由共享契约排除，候选只以数量摘要进入结果。
   */
  getGraphObservation(input: ResearchGraphObservationInput = {}): ResearchGraphObservation {
    const sessions = this.store.listResearchSessions();
    const trashedSessions = this.store.listTrashedResearchSessions();
    if (input.focusNodeId) {
      const focusNode = this.store.getResearchNode(input.focusNodeId);
      if (!focusNode || !sessions.some((session) => session.id === focusNode.sessionId)) {
        throw new DeepResearchNotFoundError("Research node is not available in the global map");
      }
    }
    const nodes = sessions.flatMap((session) => this.store.listResearchNodes(session.id));
    const activeAssociationHints = this.store.listAssociationHints("active");
    const allEdges = this.store.listAllResearchEdges();
    const sourceHealthNodes = [...nodes, ...trashedSessions.flatMap((session) => this.store.listResearchNodes(session.id))];
    const evidenceHealthByFusionNodeId = deriveFusionEvidenceHealth(
      sourceHealthNodes,
      allEdges,
      [...sessions, ...trashedSessions],
      this.store.listConfirmedFusionSourceHealth(),
    );
    const observation = buildResearchGraphObservation(
      nodes,
      allEdges,
      sessions,
      this.store.listProjects(),
      input,
      {
        activeAssociationHints,
        evidenceHealthByFusionNodeId,
        nodeLabel: (node, session) => {
          if (node.displayName) return node.displayName;
          if (!node.parentNodeId) return session.title;
          const selection = node.originSelectionId ? this.store.getResearchSelection(node.originSelectionId) : undefined;
          const originText = selection ? excerptText(selection.text, TREE_LABEL_CHARACTERS) : undefined;
          if (originText) return originText;
          const firstUser = this.store.listResearchMessageBodiesByNode(node.id).find((message) => message.role === "user");
          return firstUser ? excerptText(firstUser.content, TREE_LABEL_CHARACTERS) : "子节点";
        },
      },
    );
    const temporaryFusions = input.includeTemporaryFusions
      ? this.listTemporaryFusionMapNodes()
      : undefined;
    return {
      ...observation,
      temporaryFusionCount: this.store.listTemporaryFusionNodes().length,
      ...(temporaryFusions ? { temporaryFusions } : {}),
    };
  }

  private listTemporaryFusionMapNodes(): ResearchTemporaryFusionMapNode[] {
    return this.store.listTemporaryFusionNodes().flatMap((node) => {
      const bundle = this.store.getTemporaryFusionBundle(node.id);
      if (!bundle) return [];
      return [{
        node: bundle.node,
        label: temporaryFusionLabel(bundle.activeDraft.body),
        evidenceStatus: bundle.activeDraft.evidenceStatus,
        candidateSources: bundle.candidateSources,
      }];
    });
  }

  private scheduleTask(id: string): void {
    if (this.options.autoRunTasks === false) return;
    setImmediate(() => void this.options.research.processTask(id).catch(() => undefined));
  }
}

function defaultFirstTurnContent(selection: ResearchSelectionRecord): string {
  const text = selection.text.trim();
  const excerpt = text.length > SELECTION_EXCERPT_CHARACTERS ? `${text.slice(0, SELECTION_EXCERPT_CHARACTERS)}…` : text;
  return `${NODE_GROWTH_FIRST_TURN_PREFIX}“${excerpt}”`;
}

function excerptText(text: string, maxCharacters: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > maxCharacters ? `${trimmed.slice(0, maxCharacters)}…` : trimmed;
}

function temporaryFusionLabel(body: string): string {
  const firstLine = body.split(/\r?\n/).map((line) => line.replace(/^#{1,6}\s*/, "").trim()).find(Boolean) ?? "临时融合";
  return excerptText(firstLine, TREE_LABEL_CHARACTERS);
}

export class DeepResearchNotFoundError extends Error {}
export class DeepResearchValidationError extends Error {}
/** 会话处于回收站时研究生长/深入研究等变更类请求拒绝。 */
export class DeepResearchConflictError extends Error {}
