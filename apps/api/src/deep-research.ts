import { randomUUID } from "node:crypto";
import {
  buildGraphProjection,
  deriveDefaultResearchTitle,
  type CreateChildNodeInput,
  type DeepResearchAccepted,
  type DeepResearchInput,
  type NodeGrowthAccepted,
  type ResearchBranchRecord,
  type ResearchBranchView,
  type ResearchGraphProjection,
  type ResearchMessageRecord,
  type ResearchNodeRecord,
  type ResearchNodeView,
  type ResearchSelectionRecord,
  type ResearchSessionNodeTreeItem,
  type ResearchSessionRecord,
  type ResearchTaskRecord,
  type ResearchTurnAccepted,
} from "@collector/capture-contracts";
import type { DeepResearchStore } from "./store.js";
import { DEEP_RESEARCH_PROMPT_VERSION, RESEARCH_CHAT_PROMPT_VERSION, type ResearchSessionService, type ResearchTurnOptions } from "./research.js";

/** 分支模式首轮用户消息中选区原文的摘录长度。 */
const SELECTION_EXCERPT_CHARACTERS = 120;

/** 树导航节点标签的摘录长度（H2，H6 节点命名落地前的确定性标签）。 */
const TREE_LABEL_CHARACTERS = 48;

export interface DeepResearchServiceOptions {
  /** 深入研究任务复用研究会话任务管线（claim / 事件 / 重试 / 重启恢复）。 */
  research: ResearchSessionService;
  autoRunTasks?: boolean;
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

    const now = new Date().toISOString();
    const firstTurnContent = input.direction?.trim() || defaultFirstTurnContent(selection);

    let accepted: DeepResearchAccepted;
    if (input.mode === "branch") {
      const branch: ResearchBranchRecord = {
        id: randomUUID(), sessionId: selection.sessionId, selectionId: selection.id,
        status: "active", createdAt: now, updatedAt: now,
      };
      const { inputMessage, outputMessage, task } = this.buildFirstTurn(selection.sessionId, branch.id, firstTurnContent, idempotencyKey, now, input);
      accepted = await this.store.createResearchBranch(originSession, branch, inputMessage, outputMessage, task);
    } else {
      const session: ResearchSessionRecord = {
        id: randomUUID(),
        title: input.title?.trim() || deriveDefaultResearchTitle(selection.text),
        status: "active",
        originSelectionId: selection.id,
        originSessionId: selection.sessionId,
        createdAt: now,
        updatedAt: now,
      };
      const { inputMessage, outputMessage, task } = this.buildFirstTurn(session.id, undefined, firstTurnContent, idempotencyKey, now, input);
      accepted = await this.store.createOriginResearchSession(session, inputMessage, outputMessage, task);
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
    const groundingSources = runIds.flatMap((runId) => this.store.listResearchGroundingSources(runId));
    return { branch, session, selection, messages, tasks, ...(groundingSources.length ? { groundingSources } : {}), ...(messages.length ? { citations: this.store.listResearchCitationsForMessages(messages.map((message) => message.id)) } : {}) };
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
    const allowWebSearch = options.allowWebSearch === true;
    const task: ResearchTaskRecord = {
      id: randomUUID(), sessionId: branch.sessionId, nodeId: branch.id, inputMessageId: inputMessage.id, outputMessageId: outputMessage.id,
      idempotencyKey, status: "queued", retryable: false,
      provider: this.options.research.providerId,
      model: this.options.research.modelId,
      promptVersion: RESEARCH_CHAT_PROMPT_VERSION,
      allowWebSearch,
      ...(allowWebSearch ? {} : { groundingScope: { status: "not_requested", sourceCount: 0, citationCount: 0 } }),
      createdAt: now, updatedAt: now,
    };
    const accepted = await this.store.createResearchTurnForNode(node, inputMessage, outputMessage, task);
    this.scheduleTask(accepted.task.id);
    return accepted;
  }

  private buildFirstTurn(
    sessionId: string,
    branchId: string | undefined,
    content: string,
    idempotencyKey: string,
    now: string,
    options: ResearchTurnOptions,
  ): { inputMessage: ResearchMessageRecord; outputMessage: ResearchMessageRecord; task: ResearchTaskRecord } {
    const inputMessage: ResearchMessageRecord = {
      id: randomUUID(), sessionId, branchId, role: "user",
      content, status: "completed", createdAt: now, updatedAt: now,
    };
    const outputMessage: ResearchMessageRecord = {
      id: randomUUID(), sessionId, branchId, role: "assistant",
      content: "", status: "pending", createdAt: now, updatedAt: now,
    };
    const allowWebSearch = options.allowWebSearch === true;
    const task: ResearchTaskRecord = {
      id: randomUUID(), sessionId, inputMessageId: inputMessage.id, outputMessageId: outputMessage.id,
      idempotencyKey, status: "queued", retryable: false,
      promptVersion: DEEP_RESEARCH_PROMPT_VERSION,
      allowWebSearch,
      ...(allowWebSearch ? {} : { groundingScope: { status: "not_requested", sourceCount: 0, citationCount: 0 } }),
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
    const node: ResearchNodeRecord = {
      id: randomUUID(),
      sessionId: selection.sessionId,
      parentNodeId: parentNode.id,
      originSelectionId: selection.id,
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
    const allowWebSearch = input.allowWebSearch === true;
    const task: ResearchTaskRecord = {
      id: randomUUID(), sessionId: selection.sessionId, nodeId: node.id,
      inputMessageId: inputMessage.id, outputMessageId: outputMessage.id,
      idempotencyKey, status: "queued", retryable: false,
      provider: this.options.research.providerId,
      model: this.options.research.modelId,
      promptVersion: DEEP_RESEARCH_PROMPT_VERSION,
      allowWebSearch,
      ...(allowWebSearch ? {} : { groundingScope: { status: "not_requested", sourceCount: 0, citationCount: 0 } }),
      createdAt: now, updatedAt: now,
    };
    const accepted = await this.store.createResearchChildNode(parentNode, node, selection, inputMessage, outputMessage, task);
    this.scheduleTask(accepted.task.id);
    return accepted;
  }

  /** 点击已完成的术语预览：复用同一份内容创建子节点，不再发起第二次模型调用。 */
  async startChildNodeFromTermPreview(previewId: string, idempotencyKey: string): Promise<NodeGrowthAccepted> {
    if (!idempotencyKey.trim()) throw new DeepResearchValidationError("Idempotency-Key is required");
    if (idempotencyKey.length > 200) throw new DeepResearchValidationError("Idempotency-Key must not exceed 200 characters");
    const preview = this.store.getResearchTermPreview(previewId);
    if (!preview) throw new DeepResearchNotFoundError("Research term preview not found");
    if (preview.status !== "completed" || !preview.content.trim()) {
      throw new DeepResearchValidationError("Research term preview is not ready");
    }
    const selection = this.store.getResearchSelection(preview.selectionId);
    if (!selection) throw new Error("Research term preview references a missing selection");
    const parentNodeId = selection.nodeId ?? selection.sessionId;
    const parentNode = this.store.getResearchNode(parentNodeId);
    const session = this.store.getResearchSession(selection.sessionId);
    if (!parentNode || !session) throw new Error("Research term preview references incomplete node state");

    // 即使客户端丢失幂等键，也不允许同一术语来源重复生长多个子节点。
    const existingNode = this.store.listChildNodes(parentNode.id).find((node) => node.originSelectionId === selection.id);
    if (existingNode) {
      const existingTask = this.store.listResearchTasksByNode(existingNode.id)[0];
      const existingMessages = this.store.listResearchMessagesByNode(existingNode.id);
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
      allowWebSearch: false,
      groundingScope: { status: "not_requested", sourceCount: 0, citationCount: 0 },
      createdAt: now, updatedAt: now, startedAt: now, completedAt: now,
    };
    return this.store.createResearchChildNode(parentNode, node, selection, inputMessage, outputMessage, task);
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
    const groundingSources = runIds.flatMap((runId) => this.store.listResearchGroundingSources(runId));
    return {
      node,
      session,
      messages,
      tasks,
      childNodes,
      ...(groundingSources.length ? { groundingSources } : {}),
      ...(messages.length ? { citations: this.store.listResearchCitationsForMessages(messages.map((message) => message.id)) } : {}),
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
      const firstUser = this.store.listResearchMessagesByNode(node.id).find((message) => message.role === "user");
      const firstMessage = firstUser ? excerptText(firstUser.content, TREE_LABEL_CHARACTERS) : undefined;
      return { node, label: firstMessage ?? "子节点", ...(firstMessage ? { firstMessage } : {}) };
    });
  }

  /**
   * 图投影（D1）：以 focusNodeId 为中心的关系视图。
   * 缺省焦点为会话根节点（sessionId === 根节点 id）。
   * 标签规则与节点树一致：displayName > 来源选区摘要 > 首条用户消息摘要 > 回退。
   */
  getGraphProjection(sessionId: string, focusNodeId?: string): ResearchGraphProjection {
    const session = this.store.getResearchSession(sessionId);
    if (!session) throw new DeepResearchNotFoundError("Research session not found");
    const nodes = this.store.listResearchNodes(sessionId);
    const nodeIds = new Set(nodes.map((node) => node.id));
    const allEdges = this.store.listAllResearchEdges();
    const sessionEdges = allEdges.filter((edge) => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId));
    const focus = focusNodeId ?? sessionId;
    return buildGraphProjection(nodes, sessionEdges, focus, {
      nodeLabel: (node) => {
        if (!node.parentNodeId) return session.title;
        if (node.displayName) return node.displayName;
        const selection = node.originSelectionId ? this.store.getResearchSelection(node.originSelectionId) : undefined;
        const originText = selection ? excerptText(selection.text, TREE_LABEL_CHARACTERS) : undefined;
        if (originText) return originText;
        const firstUser = this.store.listResearchMessagesByNode(node.id).find((message) => message.role === "user");
        if (firstUser) return excerptText(firstUser.content, TREE_LABEL_CHARACTERS);
        return "子节点";
      },
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
  return `深入研究这段内容：“${excerpt}”`;
}

function excerptText(text: string, maxCharacters: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > maxCharacters ? `${trimmed.slice(0, maxCharacters)}…` : trimmed;
}

export class DeepResearchNotFoundError extends Error {}
export class DeepResearchValidationError extends Error {}
