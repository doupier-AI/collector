import type {
  ResearchAttachmentRecord,
  ResearchAssociationHintRecord,
  ResearchBodyVersionRecord,
  ResearchBranchRecord,
  ResearchBranchView,
  ResearchEdgeKind,
  ResearchEdgeRecord,
  ResearchFusionProposalRecord,
  ResearchGraphProjection,
  ResearchGraphObservation,
  ResearchGraphObservationNode,
  ResearchGraphNodeSummary,
  ResearchImportTaskRecord,
  ResearchLaterItemRecord,
  ResearchLaterItemView,
  ResearchMessageRecord,
  ResearchNodeRecord,
  ResearchNodeView,
  ResearchSelectionRecord,
  ResearchSemanticFragmentRecord,
  ResearchSessionRecord,
  ResearchTaskRecord,
  ResearchTemporaryFusionBundle,
  ProjectRecord,
} from "@collector/capture-contracts";
import type { EventSourceLike } from "../api/task-events";

/** 可注入的 EventSource 替身：手动推送 open / error / 命名事件。 */
export class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];

  static reset(): void {
    FakeEventSource.instances = [];
  }

  readonly url: string;
  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: Event) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  emitOpen(): void {
    this.readyState = 1;
    this.emitRaw("open");
  }

  emitError(readyState = 0): void {
    this.readyState = readyState;
    this.emitRaw("error");
  }

  emit(type: string, data: unknown): void {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      listener({ type, data: JSON.stringify(data) } as MessageEvent<string>);
    }
  }

  private emitRaw(type: string): void {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(new Event(type));
    }
  }
}

let sequence = 0;

export function makeSession(overrides: Partial<ResearchSessionRecord> = {}): ResearchSessionRecord {
  sequence += 1;
  return {
    id: `session-${sequence}`,
    title: `研究会话 ${sequence}`,
    status: "active",
    isFavorite: false,
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:01:00.000Z",
    ...overrides,
  };
}

export function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  sequence += 1;
  return {
    id: `project-${sequence}`,
    name: `项目 ${sequence}`,
    colorRole: "amber",
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:01:00.000Z",
    ...overrides,
  };
}

export function makeNode(overrides: Partial<ResearchNodeRecord> = {}): ResearchNodeRecord {
  sequence += 1;
  return {
    id: `node-${sequence}`,
    sessionId: "session-1",
    status: "active",
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:01:00.000Z",
    ...overrides,
  };
}

export function makeAssociationHint(overrides: Partial<ResearchAssociationHintRecord> = {}): ResearchAssociationHintRecord {
  sequence += 1;
  return {
    id: `hint-${sequence}`,
    anchorNodeId: "node-1",
    relatedNodeId: "node-2",
    relationType: "shared-concept",
    reason: "两处正文值得一起回看",
    anchorRanges: [{ nodeId: "node-1", bodyVersionId: "body:node-1:v1", fragmentId: "fragment:node-1:1" }],
    relatedRanges: [{ nodeId: "node-2", bodyVersionId: "body:node-2:v1", fragmentId: "fragment:node-2:1" }],
    evidenceContentKey: `evidence-content-${sequence}`,
    evidenceKey: `evidence-${sequence}`,
    status: "active",
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:01:00.000Z",
    ...overrides,
  };
}

export function makeTemporaryFusionBundle(overrides: Partial<ResearchTemporaryFusionBundle> = {}): ResearchTemporaryFusionBundle {
  sequence += 1;
  const id = overrides.node?.id ?? `temporary-fusion-${sequence}`;
  const node = overrides.node ?? {
    id,
    creationKey: `generation-${sequence}`,
    triggerProposalId: `proposal-${sequence}`,
    activeDraftVersionId: `${id}:draft:1`,
    status: "active" as const,
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:01:00.000Z",
  };
  return {
    node,
    activeDraft: overrides.activeDraft ?? {
      id: node.activeDraftVersionId,
      temporaryFusionNodeId: node.id,
      version: 1,
      body: "一条待审查的新认识",
      contentHash: `sha256:${node.id}`,
      evidenceStatus: "verified",
      createdAt: node.createdAt,
    },
    candidateSources: overrides.candidateSources ?? ["node-1", "node-2"].map((sourceNodeId, index) => ({
      id: `${node.id}:source:${index + 1}`,
      temporaryFusionNodeId: node.id,
      sourceNodeId,
      sourceKind: "formal" as const,
      bodyVersionId: `body:${sourceNodeId}:v1`,
      fragmentIds: [`fragment:${sourceNodeId}:1`],
      sourceHealth: "available" as const,
      createdAt: node.createdAt,
    })),
  };
}

export function makeNodeView(overrides: Partial<ResearchNodeView> = {}): ResearchNodeView {
  const node = overrides.node ?? makeNode();
  return {
    node,
    session: overrides.session ?? makeSession({ id: node.sessionId }),
    messages: overrides.messages ?? [],
    tasks: overrides.tasks ?? [],
    childNodes: overrides.childNodes ?? [],
    // 保留扩展字段（slices/bodyVersions/fusionProposals/termDetections 等）
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<ResearchMessageRecord> = {}): ResearchMessageRecord {
  sequence += 1;
  return {
    id: `message-${sequence}`,
    sessionId: "session-1",
    role: "user",
    content: "",
    status: "completed",
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:00:00.000Z",
    ...overrides,
  };
}

export function makeTask(overrides: Partial<ResearchTaskRecord> = {}): ResearchTaskRecord {
  sequence += 1;
  return {
    id: `task-${sequence}`,
    sessionId: "session-1",
    inputMessageId: "message-1",
    outputMessageId: "message-2",
    idempotencyKey: `key-${sequence}`,
    status: "queued",
    retryable: false,
    promptVersion: "test-prompt-v1",
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:00:00.000Z",
    ...overrides,
  };
}

export function makeAttachment(overrides: Partial<ResearchAttachmentRecord> = {}): ResearchAttachmentRecord {
  sequence += 1;
  return {
    id: `attachment-${sequence}`,
    sessionId: "session-1",
    fileName: "笔记.txt",
    mimeType: "text/plain",
    size: 128,
    checksum: `checksum-${sequence}`,
    status: "processing",
    importTaskId: `import-task-${sequence}`,
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:00:00.000Z",
    ...overrides,
  };
}

export function makeImportTask(overrides: Partial<ResearchImportTaskRecord> = {}): ResearchImportTaskRecord {
  sequence += 1;
  return {
    id: `import-task-${sequence}`,
    sessionId: "session-1",
    attachmentId: `attachment-${sequence}`,
    idempotencyKey: `import-key-${sequence}`,
    status: "queued",
    progress: { phase: "queued", completedUnits: 0, totalUnits: 0 },
    retryable: false,
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:00:00.000Z",
    ...overrides,
  };
}

export function makeSelection(overrides: Partial<ResearchSelectionRecord> = {}): ResearchSelectionRecord {
  sequence += 1;
  return {
    id: `selection-${sequence}`,
    sessionId: "session-1",
    anchor: { kind: "message", messageId: "m-out", blockOrdinal: 0, startOffset: 0, endOffset: 6, exact: "一段选区文字" },
    text: "一段选区文字",
    status: "active",
    createdAt: "2026-07-20T08:00:00.000Z",
    updatedAt: "2026-07-20T08:00:00.000Z",
    ...overrides,
  };
}

export function makeBranch(overrides: Partial<ResearchBranchRecord> = {}): ResearchBranchRecord {
  sequence += 1;
  return {
    id: `branch-${sequence}`,
    sessionId: "session-1",
    selectionId: "selection-1",
    status: "active",
    createdAt: "2026-07-21T08:00:00.000Z",
    updatedAt: "2026-07-21T08:00:00.000Z",
    ...overrides,
  };
}

export function makeBranchView(overrides: Partial<ResearchBranchView> = {}): ResearchBranchView {
  const branch = overrides.branch ?? makeBranch();
  const selection = overrides.selection ?? makeSelection({ id: branch.selectionId, sessionId: branch.sessionId });
  return {
    branch,
    session: overrides.session ?? makeSession({ id: branch.sessionId, title: "来源研究会话" }),
    selection,
    messages: overrides.messages ?? [],
    tasks: overrides.tasks ?? [],
  };
}

export function makeLaterItem(overrides: Partial<ResearchLaterItemRecord> = {}): ResearchLaterItemRecord {
  sequence += 1;
  return {
    id: `later-${sequence}`,
    sessionId: "session-1",
    selectionId: "selection-1",
    summary: "本地优先会先把输入保存在本机",
    priority: 3,
    status: "pending",
    createdAt: "2026-07-21T08:00:00.000Z",
    updatedAt: "2026-07-21T08:00:00.000Z",
    ...overrides,
  };
}

export function makeLaterItemView(overrides: {
  item?: ResearchLaterItemRecord;
  selection?: ResearchSelectionRecord;
  sourceTitle?: string;
  sourceNode?: { id: string; label: string };
} = {}): ResearchLaterItemView {
  const item = overrides.item ?? makeLaterItem();
  const selection = overrides.selection ?? makeSelection({ id: item.selectionId, sessionId: item.sessionId });
  return {
    item,
    selection,
    sourceTitle: overrides.sourceTitle ?? "理解注意力机制",
    sourceNode: overrides.sourceNode ?? { id: item.nodeId ?? item.sessionId, label: overrides.sourceTitle ?? "理解注意力机制" },
  };
}

/** 类型化边工厂：默认 active 状态，确定性 ID 由 kind + from + to 拼接。 */
export function makeEdge(
  kind: ResearchEdgeKind,
  fromNodeId: string,
  toNodeId: string,
  overrides: Partial<ResearchEdgeRecord> = {},
): ResearchEdgeRecord {
  return {
    id: overrides.id ?? `edge:${kind}:${fromNodeId}:${toNodeId}`,
    kind,
    fromNodeId,
    toNodeId,
    createdAt: "2026-08-01T08:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

/** 图投影工厂：接受节点摘要数组与边数组，焦点默认取第一个节点。 */
export function makeGraphProjection(
  overrides: {
    nodes?: ResearchGraphNodeSummary[];
    edges?: ResearchEdgeRecord[];
    focusNodeId?: string;
  } = {},
): ResearchGraphProjection {
  const nodes = overrides.nodes ?? [];
  return {
    focusNodeId: overrides.focusNodeId ?? (nodes[0]?.node.id ?? "focus"),
    edges: overrides.edges ?? [],
    nodes,
  };
}

/** #62 全局观察工厂：最小摘要，不携带正文或候选详情。 */
export function makeGraphObservation(
  overrides: Pick<Partial<ResearchGraphObservation>, "activeCandidateCount" | "associationHints" | "edges" | "nodes"> = {},
): ResearchGraphObservation {
  return {
    nodes: overrides.nodes ?? [],
    edges: overrides.edges ?? [],
    appliedRelationshipKinds: ["parent-child", "fused-from"],
    activeCandidateCount: overrides.activeCandidateCount ?? 0,
    ...(overrides.associationHints ? { associationHints: overrides.associationHints } : {}),
  };
}

export function makeGraphObservationNode(
  id: string,
  label: string,
  overrides: Partial<ResearchGraphObservationNode> = {},
): ResearchGraphObservationNode {
  return {
    node: makeNode({ id, sessionId: overrides.node?.sessionId ?? id, ...overrides.node }),
    label,
    sessionTitle: overrides.sessionTitle ?? label,
    lifecycle: "active",
    role: "research",
    scope: "inside-current-filter",
    connectivity: "default",
    candidateCount: 0,
    fusionEvidenceHealth: "not-applicable",
    ...overrides,
  };
}

/** 图节点摘要工厂：配合 makeNode 使用。 */
export function makeGraphNodeSummary(
  id: string,
  label: string,
  depth: number,
  options: { parentNodeId?: string; sessionId?: string; createdAt?: string } = {},
): ResearchGraphNodeSummary {
  return {
    node: makeNode({
      id,
      sessionId: options.sessionId ?? "session-1",
      parentNodeId: options.parentNodeId,
      createdAt: options.createdAt ?? "2026-08-01T08:00:00.000Z",
    }),
    label,
    depth,
  };
}

/** 融合提案工厂：默认带完整可定位触发依据（nodeId + bodyVersionId + fragmentId）。 */
export function makeFusionProposal(
  overrides: Partial<ResearchFusionProposalRecord> = {},
): ResearchFusionProposalRecord {
  sequence += 1;
  const loNodeId = overrides.loNodeId ?? "node-a";
  const hiNodeId = overrides.hiNodeId ?? "node-b";
  return {
    id: `fusion:${sequence}`,
    loNodeId,
    hiNodeId,
    relationType: "shared-concept",
    reason: "两处内容共享同一概念。",
    status: "pending",
    triggerSources:
      overrides.triggerSources ??
      [
        {
          nodeId: loNodeId,
          bodyVersionId: `body:message-${sequence}:abc`,
          fragmentId: `fragment:body:message-${sequence}:abc:0`,
        },
        {
          nodeId: hiNodeId,
          bodyVersionId: `body:message-${sequence + 1}:def`,
          fragmentId: `fragment:body:message-${sequence + 1}:def:0`,
        },
      ],
    verification: { promptVersion: "similarity-verify-v1", sourceSliceIds: [], sourceFragmentIds: [], tokenBudget: 800 },
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

/** 正文版本工厂（#35）：messageId 与 content 必填，ID 由消息与序号确定性派生风格。 */
export function makeBodyVersion(
  messageId: string,
  content: string,
  overrides: Partial<ResearchBodyVersionRecord> = {},
): ResearchBodyVersionRecord {
  sequence += 1;
  return {
    id: `body:${messageId}:${sequence}`,
    messageId,
    nodeId: overrides.nodeId ?? "node-a",
    version: 1,
    content,
    contentHash: `hash-${sequence}`,
    origin: "backfill",
    createdAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

/** 语义片段工厂（#35）：bodyVersionId/messageId/content 必填，默认 ordinal=0、范围覆盖整段正文、正式（非 provisional）。 */
export function makeFragment(
  bodyVersionId: string,
  messageId: string,
  content: string,
  overrides: Partial<ResearchSemanticFragmentRecord> = {},
): ResearchSemanticFragmentRecord {
  sequence += 1;
  return {
    id: `fragment:${bodyVersionId}:${overrides.ordinal ?? 0}`,
    bodyVersionId,
    messageId,
    nodeId: overrides.nodeId ?? "node-a",
    ordinal: overrides.ordinal ?? 0,
    startOffset: overrides.startOffset ?? 0,
    endOffset: overrides.endOffset ?? content.length,
    granularity: "paragraph",
    sourceRefs: [],
    isProvisional: false,
    excerptChecksum: `checksum-${sequence}`,
    createdAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}
