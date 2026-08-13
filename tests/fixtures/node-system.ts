import {
  researchEdgeId,
  type ProjectRecord,
  type ResearchPermanentEdgeRecord,
  type ResearchSessionRecord,
  type ResearchNodeRecord,
  type ResearchTemporaryFusionBundle,
} from "@collector/capture-contracts";

const CREATED_AT = "2026-08-13T00:00:00.000Z";

export interface NodeSystemFixture {
  projects: ProjectRecord[];
  sessions: ResearchSessionRecord[];
  nodes: ResearchNodeRecord[];
  permanentEdges: ResearchPermanentEdgeRecord[];
  temporaryFusions: ResearchTemporaryFusionBundle[];
  components: Array<{ componentId: string; nodeIds: string[] }>;
  growthOriginNodeIds: Record<"mention" | "selection" | "deep-research", string>;
  mentionOutcomes: Array<{ caseId: string; result: "empty" | "invalid" | "failed" }>;
  crossProjectBridgeEdgeIds: string[];
}

export type NodeSystemFixtureSize = "small" | "medium" | "large";
export const NODE_SYSTEM_FIXTURE_NODE_COUNTS: Record<NodeSystemFixtureSize, number> = {
  small: 12,
  medium: 120,
  large: 1_200,
};

function session(id: string, projectId?: string, overrides: Partial<ResearchSessionRecord> = {}): ResearchSessionRecord {
  return {
    id,
    title: `Fixture ${id}`,
    status: "active",
    isFavorite: false,
    projectId,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function node(id: string, sessionId: string, overrides: Partial<ResearchNodeRecord> = {}): ResearchNodeRecord {
  return { id, sessionId, status: "active", createdAt: CREATED_AT, updatedAt: CREATED_AT, ...overrides };
}

function edge(kind: ResearchPermanentEdgeRecord["kind"], fromNodeId: string, toNodeId: string): ResearchPermanentEdgeRecord {
  return { id: researchEdgeId(kind, fromNodeId, toNodeId), kind, fromNodeId, toNodeId, status: "active", createdAt: CREATED_AT };
}

function temporaryFusion(
  id: string,
  evidenceStatus: "verified" | "invalid",
  sources: Array<{ nodeId: string; health?: "available" | "deleted" }>,
): ResearchTemporaryFusionBundle {
  return {
    node: {
      id,
      creationKey: `generation:${id}`,
      activeDraftVersionId: `${id}:draft:1`,
      status: "active",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    activeDraft: {
      id: `${id}:draft:1`,
      temporaryFusionNodeId: id,
      version: 1,
      body: `Deterministic draft for ${id}`,
      contentHash: `sha256:${id}:draft:1`,
      evidenceStatus,
      createdAt: CREATED_AT,
    },
    candidateSources: sources.map(({ nodeId, health = "available" }, index) => ({
      id: `${id}:source:${index + 1}`,
      temporaryFusionNodeId: id,
      sourceNodeId: nodeId,
      sourceKind: "formal",
      bodyVersionId: `body:${nodeId}:v1`,
      fragmentIds: [`fragment:${nodeId}:1`],
      sourceHealth: health,
      createdAt: CREATED_AT,
    })),
  };
}

/**
 * NS-00 共用的小型确定性样本。所有 ID、时间、正文、关系与异常状态均为固定字面量；
 * 后续规模样本可以重复拼接该结构，但不得随机生成产品语义。
 */
export function createNodeSystemFixture(): NodeSystemFixture {
  const projects: ProjectRecord[] = [
    { id: "project-amber", name: "Amber", colorRole: "amber", createdAt: CREATED_AT, updatedAt: CREATED_AT },
    { id: "project-violet", name: "Violet", colorRole: "violet", createdAt: CREATED_AT, updatedAt: CREATED_AT },
  ];
  const sessions = [
    session("session-isolated", "project-amber"),
    session("session-growth-root", "project-amber"),
    session("session-growth-mention", "project-amber"),
    session("session-growth-selection", "project-amber"),
    session("session-growth-deep", "project-violet"),
    session("session-cycle-root", "project-violet"),
    session("session-cycle-fusion"),
    session("session-bridge-a", "project-amber"),
    session("session-bridge-b", "project-violet"),
    session("session-bridge-fusion"),
    session("session-archived", "project-amber", { status: "archived" }),
    session("session-trashed", "project-violet", { trashedAt: "2026-08-13T01:00:00.000Z" }),
  ];
  const growthOriginNodeIds = {
    mention: "growth-child-mention",
    selection: "growth-child-selection",
    "deep-research": "growth-child-deep",
  } as const;
  const nodes = [
    node("isolated-node", "session-isolated"),
    node("growth-root", "session-growth-root"),
    node(growthOriginNodeIds.mention, "session-growth-mention", { parentNodeId: "growth-root" }),
    node(growthOriginNodeIds.selection, "session-growth-selection", { parentNodeId: "growth-root", originSelectionId: "selection-1" }),
    node(growthOriginNodeIds["deep-research"], "session-growth-deep", { parentNodeId: "growth-root", originSelectionId: "selection-2" }),
    node("cycle-root", "session-cycle-root", { parentNodeId: "cycle-fusion" }),
    node("cycle-fusion", "session-cycle-fusion", { isFusionNode: true }),
    node("bridge-a", "session-bridge-a"),
    node("bridge-b", "session-bridge-b"),
    node("bridge-fusion", "session-bridge-fusion", { isFusionNode: true }),
    node("archived-node", "session-archived"),
    node("trashed-source", "session-trashed"),
  ];
  const permanentEdges = [
    edge("parent-child", "growth-root", growthOriginNodeIds.mention),
    edge("parent-child", "growth-root", growthOriginNodeIds.selection),
    edge("parent-child", "growth-root", growthOriginNodeIds["deep-research"]),
    edge("parent-child", "cycle-fusion", "cycle-root"),
    edge("fused-from", "cycle-root", "cycle-fusion"),
    edge("fused-from", "bridge-a", "bridge-fusion"),
    edge("fused-from", "bridge-b", "bridge-fusion"),
  ];
  const crossProjectBridgeEdgeIds = permanentEdges
    .filter((item) => item.toNodeId === "bridge-fusion")
    .map((item) => item.id);
  return {
    projects,
    sessions,
    nodes,
    permanentEdges,
    temporaryFusions: [
      temporaryFusion("temporary-valid", "verified", [{ nodeId: "growth-root" }, { nodeId: "archived-node" }]),
      temporaryFusion("temporary-invalid", "invalid", [{ nodeId: "bridge-a" }, { nodeId: "deleted-source", health: "deleted" }]),
    ],
    components: [
      { componentId: "isolated", nodeIds: ["isolated-node"] },
      { componentId: "growth", nodeIds: ["growth-root", growthOriginNodeIds.mention, growthOriginNodeIds.selection, growthOriginNodeIds["deep-research"]] },
      { componentId: "cycle", nodeIds: ["cycle-root", "cycle-fusion"] },
      { componentId: "bridge", nodeIds: ["bridge-a", "bridge-b", "bridge-fusion"] },
      { componentId: "lifecycle", nodeIds: ["archived-node", "trashed-source"] },
    ],
    growthOriginNodeIds,
    mentionOutcomes: [
      { caseId: "mention-empty", result: "empty" },
      { caseId: "mention-invalid", result: "invalid" },
      { caseId: "mention-failed", result: "failed" },
    ],
    crossProjectBridgeEdgeIds,
  };
}

/** NS-10 性能测量复用的确定性规模样本；扩大数量，不改变小样本的语义覆盖。 */
export function createNodeSystemScaleFixture(size: NodeSystemFixtureSize): NodeSystemFixture {
  const fixture = createNodeSystemFixture();
  const targetCount = NODE_SYSTEM_FIXTURE_NODE_COUNTS[size];
  const scaleNodeIds: string[] = [];
  let parentNodeId: string | undefined;
  for (let index = fixture.nodes.length; index < targetCount; index += 1) {
    const ordinal = String(index + 1).padStart(4, "0");
    const sessionId = `session-scale-${size}-${ordinal}`;
    const nodeId = `node-scale-${size}-${ordinal}`;
    fixture.sessions.push(session(sessionId, index % 2 === 0 ? "project-amber" : "project-violet"));
    fixture.nodes.push(node(nodeId, sessionId, parentNodeId ? { parentNodeId } : {}));
    if (parentNodeId) fixture.permanentEdges.push(edge("parent-child", parentNodeId, nodeId));
    scaleNodeIds.push(nodeId);
    parentNodeId = nodeId;
  }
  if (scaleNodeIds.length > 0) fixture.components.push({ componentId: `scale-${size}`, nodeIds: scaleNodeIds });
  return fixture;
}
