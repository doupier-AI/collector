import type { ResearchMessageRecord, ResearchSessionRecord } from "@collector/capture-contracts";
import { RESEARCH_TITLE_MAX_CHARACTERS, deriveDefaultResearchTitle } from "@collector/capture-contracts";
import type { ModelGateway } from "@collector/model-gateway";

/** 未指定标题创建会话时的默认占位标题；首轮任务入队后由自动标题服务替换。 */
export const DEFAULT_RESEARCH_SESSION_TITLE = "新研究会话";

export interface SessionTitlingStore {
  getResearchSession(id: string): ResearchSessionRecord | undefined;
  /** 根节点的消息（nodeId === sessionId）；子节点消息不参与会话标题提炼。 */
  listResearchMessagesByNode(nodeId: string): ResearchMessageRecord[];
  updateResearchSessionTitle(sessionId: string, title: string): Promise<ResearchSessionRecord | undefined>;
}

/** 从根节点用户消息生成稳定标题；没有根用户消息时保留默认标题。 */
export function deterministicSessionTitle(messages: readonly Pick<ResearchMessageRecord, "role" | "content">[]): string {
  const firstUser = messages.find((message) => message.role === "user" && message.content.trim());
  if (!firstUser) return DEFAULT_RESEARCH_SESSION_TITLE;
  // deriveDefaultResearchTitle 超长时返回 40 字 + 省略号（41 字符），store 校验上限 40 字，这里收口到合法长度。
  const derived = deriveDefaultResearchTitle(firstUser.content);
  if (derived.length <= RESEARCH_TITLE_MAX_CHARACTERS) return derived;
  return `${derived.slice(0, RESEARCH_TITLE_MAX_CHARACTERS - 1)}…`;
}

export function validateSessionTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > RESEARCH_TITLE_MAX_CHARACTERS) return undefined;
  return normalized;
}

export interface SessionTitlingGateway {
  generateSessionTitle(
    input: { content: string },
    options?: { model?: string; maxTokens?: number; timeoutMs?: number; context?: { purpose?: string; promptVersion?: string } },
  ): Promise<string>;
}

/** 会话自动标题：根节点首轮任务入队即落库确定性标题，模型提炼后台覆盖。 */
export class SessionTitlingService {
  private readonly refining = new Set<string>();

  constructor(
    private readonly store: SessionTitlingStore,
    private readonly gatewayResolver: () => Promise<SessionTitlingGateway | undefined>,
  ) {}

  /**
   * 确定性标题落库，无模型 I/O：调用方 await 后即可依赖新标题。
   * 只替换默认占位标题；用户显式命名或已提炼过的会话不改动。
   */
  async nameSession(sessionId: string): Promise<ResearchSessionRecord | undefined> {
    const session = this.store.getResearchSession(sessionId);
    if (!session || session.title !== DEFAULT_RESEARCH_SESSION_TITLE) return session;
    const messages = this.store.listResearchMessagesByNode(sessionId);
    return this.store.updateResearchSessionTitle(sessionId, deterministicSessionTitle(messages));
  }

  /** 模型提炼覆盖确定性标题；失败或未配置模型时保留现状。幂等防重入。 */
  async refineSessionTitle(sessionId: string): Promise<ResearchSessionRecord | undefined> {
    if (this.refining.has(sessionId)) return this.store.getResearchSession(sessionId);
    this.refining.add(sessionId);
    try {
      const gateway = await this.gatewayResolver();
      if (!gateway) return this.store.getResearchSession(sessionId);
      const messages = this.store.listResearchMessagesByNode(sessionId);
      const generated = await gateway.generateSessionTitle(
        { content: messages.map((message) => `${message.role}: ${message.content}`).join("\n").slice(0, 4000) },
        { maxTokens: 128, timeoutMs: 30_000, context: { purpose: "research", promptVersion: "session-titling-v1" } },
      );
      const title = validateSessionTitle(generated);
      if (!title) return this.store.getResearchSession(sessionId);
      return this.store.updateResearchSessionTitle(sessionId, title);
    } catch {
      // 标题提炼失败不影响会话主流程，保留确定性标题。
      return this.store.getResearchSession(sessionId);
    } finally {
      this.refining.delete(sessionId);
    }
  }
}

export function isModelGateway(value: unknown): value is ModelGateway {
  return typeof value === "object" && value !== null && typeof (value as { generateSessionTitle?: unknown }).generateSessionTitle === "function";
}
