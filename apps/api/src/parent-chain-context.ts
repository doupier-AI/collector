import type {
  ResearchMessageRecord,
  ResearchNodeRecord,
  ResearchSelectionRecord,
  ResearchSessionRecord,
} from "@collector/capture-contracts";

// ── 配置默认值 ──────────────────────────────────────────────

/** 最大祖先遍历层数（防无限循环兜底）。 */
export const PARENT_CHAIN_MAX_ANCESTORS = 20;

/** 单个祖先节点每项文本的最大字符数。 */
export const PARENT_CHAIN_PER_ANCESTOR_CHARACTERS = 200;

/** 整条父链所有文本累计的最大字符数。 */
export const PARENT_CHAIN_TOTAL_CHARACTERS = 2000;

// ── 依赖接口 ────────────────────────────────────────────────

/** 父链上下文组装所需的最小 store 能力。 */
export interface ParentChainContextStore {
  getResearchNode(id: string): ResearchNodeRecord | undefined;
  getResearchSession(id: string): ResearchSessionRecord | undefined;
  getResearchSelection(id: string): ResearchSelectionRecord | undefined;
  listResearchMessagesByNode(nodeId: string): ResearchMessageRecord[];
}

// ── 结果类型 ────────────────────────────────────────────────

/** 单个祖先节点的有界上下文。 */
export interface AncestorContext {
  /** 祖先节点 ID。 */
  nodeId: string;
  /** 距起始节点的深度（直接父 = 1，祖父 = 2，……）。 */
  depth: number;
  /** 是否为根节点（parentNodeId 为空）。 */
  isRoot: boolean;
  /** 节点标签 / 主题：根节点为会话标题，子节点为来源选区摘要或首条用户消息摘要。 */
  label: string;
  /** 来源选区引用文本（有 originSelectionId 时）。 */
  originText?: string;
  /** 该节点首条用户消息摘要。 */
  firstUserMessage?: string;
}

/** 父链上下文组装结果。 */
export interface ParentChainContextResult {
  /** 起始节点 ID。 */
  startNodeId: string;
  /** 有序祖先上下文，从根节点到直接父节点。 */
  ancestors: AncestorContext[];
  /** 总链文本是否因预算耗尽被截断。 */
  truncated: boolean;
  /** 是否检测到 parentNodeId 环路。 */
  cycleDetected: boolean;
}

// ── 有界配置 ────────────────────────────────────────────────

/** 父链上下文的有界配置。 */
export interface ParentChainContextBounds {
  /** 最大祖先层数。 */
  maxAncestors: number;
  /** 单个祖先每项文本的最大字符数。 */
  perAncestorCharacters: number;
  /** 整条父链所有文本累计的最大字符数。 */
  totalCharacters: number;
}

export const DEFAULT_PARENT_CHAIN_BOUNDS: ParentChainContextBounds = {
  maxAncestors: PARENT_CHAIN_MAX_ANCESTORS,
  perAncestorCharacters: PARENT_CHAIN_PER_ANCESTOR_CHARACTERS,
  totalCharacters: PARENT_CHAIN_TOTAL_CHARACTERS,
};

// ── 服务实现 ────────────────────────────────────────────────

/**
 * 父链上下文组装服务（H5a）。
 *
 * 从任意节点沿 parentNodeId 向上遍历到根节点，收集每个祖先的有界上下文
 * （标签/主题、来源选区引用文本、首条用户消息摘要），组装为结构化上下文链。
 *
 * 后续提示词注入（票据 02）和 AI 节点命名（票据 09）均依赖此层。
 *
 * 安全机制：
 * - parentNodeId 环路检测（已访问集合），安全截断；
 * - 链长度上限（maxAncestors）；
 * - 总文本预算（totalCharacters），逐项累加，超限后停止收录更远祖先。
 */
export class ParentChainContextService {
  constructor(
    private readonly store: ParentChainContextStore,
    private readonly bounds: ParentChainContextBounds = DEFAULT_PARENT_CHAIN_BOUNDS,
  ) {}

  /**
   * 组装从起始节点到根节点的父链上下文。
   *
   * @param nodeId 起始节点 ID（其自身不进入祖先列表）。
   * @returns 有序祖先上下文（根节点在前，直接父节点在后）与截断/循环标志。
   */
  buildParentChainContext(nodeId: string): ParentChainContextResult {
    const startNode = this.store.getResearchNode(nodeId);
    if (!startNode) {
      return { startNodeId: nodeId, ancestors: [], truncated: false, cycleDetected: false };
    }

    // 第一阶段：沿 parentNodeId 上溯，收集原始祖先序列（近→远）。
    const rawAncestors: Array<{ node: ResearchNodeRecord; depth: number }> = [];
    const visited = new Set<string>([nodeId]);
    let currentId = startNode.parentNodeId;
    let cycleDetected = false;
    let truncated = false;

    while (currentId && rawAncestors.length < this.bounds.maxAncestors) {
      if (visited.has(currentId)) {
        cycleDetected = true;
        break;
      }
      visited.add(currentId);
      const node = this.store.getResearchNode(currentId);
      if (!node) break;
      rawAncestors.push({ node, depth: rawAncestors.length + 1 });
      currentId = node.parentNodeId;
    }

    if (rawAncestors.length >= this.bounds.maxAncestors && currentId) {
      truncated = true;
    }

    // 第二阶段：反转为根→近序，提取有界上下文，按总预算截断。
    rawAncestors.reverse();

    const ancestors: AncestorContext[] = [];
    let totalChars = 0;

    for (const { node, depth } of rawAncestors) {
      const ctx = this.extractNodeContext(node, depth);
      const entryChars = this.measureContextChars(ctx);
      const remaining = this.bounds.totalCharacters - totalChars;

      if (remaining <= 0) {
        truncated = true;
        break;
      }

      ancestors.push(remaining < entryChars ? this.truncateContext(ctx, remaining) : ctx);
      totalChars += Math.min(entryChars, remaining);
    }

    return { startNodeId: nodeId, ancestors, truncated, cycleDetected };
  }

  // ── 内部：节点上下文提取 ──────────────────────────────────

  private extractNodeContext(node: ResearchNodeRecord, depth: number): AncestorContext {
    const isRoot = !node.parentNodeId;
    const maxChars = this.bounds.perAncestorCharacters;

    // 标签：根节点取会话标题；子节点优先来源选区摘要，其次首条用户消息。
    let label: string;
    if (isRoot) {
      const session = this.store.getResearchSession(node.sessionId);
      label = this.excerpt(session?.title ?? "", maxChars) || "研究会话";
    } else {
      label = this.deriveChildLabel(node, maxChars);
    }

    // 来源选区引用文本。
    let originText: string | undefined;
    if (node.originSelectionId) {
      const selection = this.store.getResearchSelection(node.originSelectionId);
      if (selection?.text) originText = this.excerpt(selection.text, maxChars);
    }

    // 首条用户消息摘要。
    let firstUserMessage: string | undefined;
    const firstUser = this.store.listResearchMessagesByNode(node.id)
      .find((m) => m.role === "user");
    if (firstUser?.content) {
      firstUserMessage = this.excerpt(firstUser.content, maxChars);
    }

    return {
      nodeId: node.id,
      depth,
      isRoot,
      label,
      ...(originText ? { originText } : {}),
      ...(firstUserMessage ? { firstUserMessage } : {}),
    };
  }

  private deriveChildLabel(node: ResearchNodeRecord, maxChars: number): string {
    if (node.originSelectionId) {
      const selection = this.store.getResearchSelection(node.originSelectionId);
      if (selection?.text) return this.excerpt(selection.text, maxChars);
    }
    const firstUser = this.store.listResearchMessagesByNode(node.id)
      .find((m) => m.role === "user");
    if (firstUser?.content) return this.excerpt(firstUser.content, maxChars);
    return "子节点";
  }

  // ── 内部：预算度量与截断 ──────────────────────────────────

  private measureContextChars(ctx: AncestorContext): number {
    return ctx.label.length
      + (ctx.originText?.length ?? 0)
      + (ctx.firstUserMessage?.length ?? 0);
  }

  private truncateContext(ctx: AncestorContext, budget: number): AncestorContext {
    let remaining = budget;
    const label = this.excerpt(ctx.label, remaining);
    remaining -= label.length;
    let originText: string | undefined;
    if (ctx.originText && remaining > 0) {
      originText = this.excerpt(ctx.originText, remaining);
      remaining -= originText.length;
    }
    let firstUserMessage: string | undefined;
    if (ctx.firstUserMessage && remaining > 0) {
      firstUserMessage = this.excerpt(ctx.firstUserMessage, remaining);
    }
    return {
      ...ctx,
      label,
      ...(originText ? { originText } : {}),
      ...(firstUserMessage ? { firstUserMessage } : {}),
    };
  }

  // ── 内部：文本截取 ────────────────────────────────────────

  private excerpt(text: string, maxCharacters: number): string {
    const trimmed = text.trim().replace(/\s+/g, " ");
    if (!trimmed) return "";
    return trimmed.length > maxCharacters
      ? `${trimmed.slice(0, maxCharacters)}…`
      : trimmed;
  }
}
