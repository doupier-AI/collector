import type { ResearchMessageBodyRecord, ResearchNodeRecord } from "@collector/capture-contracts";
import type { ModelGateway, ResearchParentChainContext } from "@collector/model-gateway";
import { extractNodeGrowthSelectionText } from "./deep-research.js";
import { ParentChainContextService } from "./parent-chain-context.js";

export const NODE_DISPLAY_NAME_MAX_CHARACTERS = 20;

export interface NodeNamingStore {
  getResearchNode(id: string): ResearchNodeRecord | undefined;
  listResearchMessageBodiesByNode(nodeId: string): ResearchMessageBodyRecord[];
  updateResearchNodeDisplayName(nodeId: string, displayName: string): Promise<ResearchNodeRecord | undefined>;
}

/** 从已有用户内容生成稳定短名，模型不可用时也能保证导航可读。 */
export function deterministicNodeDisplayName(messages: readonly Pick<ResearchMessageBodyRecord, "role" | "content">[]): string {
  const source = messages.find((message) => message.role === "user" && message.content.trim())
    ?? messages.find((message) => message.role === "assistant" && message.content.trim());
  let normalized = source?.content
    .replace(/^\s{0,3}(?:#+|[-*>])\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "研究节点";
  // 节点生长首轮用户消息是包装提示（深入研究这段内容：“选区摘录”）：
  // 还原引用的选区正文再截断，避免包装前缀吃掉命名预算、导航出现无意义短名。
  normalized = extractNodeGrowthSelectionText(normalized) ?? normalized;
  return normalized.slice(0, NODE_DISPLAY_NAME_MAX_CHARACTERS);
}

export function validateNodeDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > NODE_DISPLAY_NAME_MAX_CHARACTERS) return undefined;
  return normalized;
}

export interface NodeNamingGateway {
  generateNodeDisplayName(
    input: { content: string; parentChainContext?: ResearchParentChainContext },
    options?: { model?: string; maxTokens?: number; timeoutMs?: number; context?: { purpose?: string; promptVersion?: string } },
  ): Promise<string>;
}

export class NodeNamingService {
  private readonly running = new Set<string>();

  constructor(
    private readonly store: NodeNamingStore,
    private readonly gatewayResolver: () => Promise<NodeNamingGateway | undefined>,
    private readonly parentChainContext: ParentChainContextService,
  ) {}

  async nameNode(nodeId: string): Promise<ResearchNodeRecord | undefined> {
    if (this.running.has(nodeId)) return this.store.getResearchNode(nodeId);
    const node = this.store.getResearchNode(nodeId);
    if (!node || node.displayName) return node;
    this.running.add(nodeId);
    try {
      const messages = this.store.listResearchMessageBodiesByNode(nodeId);
      const fallback = deterministicNodeDisplayName(messages);
      let displayName = fallback;
      try {
        const gateway = await this.gatewayResolver();
        if (gateway) {
          const parentChain = this.parentChainContext.buildParentChainContext(nodeId);
          const generated = await gateway.generateNodeDisplayName(
            {
              content: messages.map((message) => `${message.role}: ${message.content}`).join("\n").slice(0, 4000),
              parentChainContext: parentChain.ancestors.length > 0 ? parentChain : undefined,
            },
            { maxTokens: 128, timeoutMs: 30_000, context: { purpose: "research", promptVersion: "node-naming-v1" } },
          );
          displayName = validateNodeDisplayName(generated) ?? fallback;
        }
      } catch {
        // 命名失败不影响节点主流程，保留确定性回退。
      }
      return this.store.updateResearchNodeDisplayName(nodeId, displayName);
    } finally {
      this.running.delete(nodeId);
    }
  }
}

export function isModelGateway(value: unknown): value is ModelGateway {
  return typeof value === "object" && value !== null && typeof (value as { generateNodeDisplayName?: unknown }).generateNodeDisplayName === "function";
}
