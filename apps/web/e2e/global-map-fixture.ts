import type { Page } from "@playwright/test";
import type { ResearchGraphObservation } from "@collector/capture-contracts";

const AT = "2026-08-20T00:00:00.000Z";

const node = (
  id: string,
  label: string,
  options: {
    projectId?: string;
    projectName?: string;
    projectColorRole?: "amber" | "violet" | "blue" | "teal" | "rose";
    lifecycle?: "active" | "archived";
    role?: "research" | "fusion";
    fusionEvidenceHealth?: "available" | "incomplete";
  } = {},
): ResearchGraphObservation["nodes"][number] => ({
  node: {
    id,
    sessionId: `session-${id}`,
    status: "active",
    ...(options.role === "fusion" ? { isFusionNode: true } : {}),
    createdAt: AT,
    updatedAt: AT,
  },
  label,
  sessionTitle: `${label}会话`,
  ...(options.projectId ? { projectId: options.projectId } : {}),
  ...(options.projectName ? { projectName: options.projectName } : {}),
  ...(options.projectColorRole ? { projectColorRole: options.projectColorRole } : {}),
  lifecycle: options.lifecycle ?? "active",
  role: options.role ?? "research",
  scope: "inside-current-filter",
  connectivity: "default",
  candidateCount: 0,
  fusionEvidenceHealth: options.role === "fusion" ? options.fusionEvidenceHealth ?? "available" : "not-applicable",
});

export const GLOBAL_MAP_VISUAL_OBSERVATION: ResearchGraphObservation = {
  nodes: [
    node("map-amber", "检索架构", { projectId: "project-amber", projectName: "知识工程", projectColorRole: "amber" }),
    node("map-blue", "证据链", { projectId: "project-blue", projectName: "研究方法", projectColorRole: "blue" }),
    node("map-violet", "跨域综合", {
      projectId: "project-violet",
      projectName: "综合成果",
      projectColorRole: "violet",
      lifecycle: "archived",
      role: "fusion",
      fusionEvidenceHealth: "incomplete",
    }),
    node("map-neutral", "未分类观察"),
  ],
  edges: [
    {
      edge: {
        id: "edge-map-parent",
        kind: "parent-child",
        fromNodeId: "map-amber",
        toNodeId: "map-blue",
        status: "active",
        createdAt: AT,
      },
      connectivity: "default",
    },
    {
      edge: {
        id: "edge-map-fusion",
        kind: "fused-from",
        fromNodeId: "map-blue",
        toNodeId: "map-violet",
        status: "active",
        createdAt: AT,
      },
      connectivity: "default",
    },
  ],
  appliedRelationshipKinds: ["parent-child", "fused-from"],
};

function observationForRequest(requestUrl: string): ResearchGraphObservation {
  const url = new URL(requestUrl);
  const focusNodeId = url.searchParams.get("focusNodeId") ?? undefined;
  const kindsWereSpecified = url.searchParams.has("relationshipKind");
  const requestedKinds = url.searchParams.getAll("relationshipKind").filter(Boolean);
  const appliedRelationshipKinds = (kindsWereSpecified
    ? ["parent-child", "fused-from"].filter((kind) => requestedKinds.includes(kind))
    : ["parent-child", "fused-from"]) as ResearchGraphObservation["appliedRelationshipKinds"];
  const enabledKinds = new Set(appliedRelationshipKinds);
  const connectedIds = new Set<string>();

  if (focusNodeId && GLOBAL_MAP_VISUAL_OBSERVATION.nodes.some((summary) => summary.node.id === focusNodeId)) {
    const adjacency = new Map(GLOBAL_MAP_VISUAL_OBSERVATION.nodes.map((summary) => [summary.node.id, new Set<string>()]));
    for (const { edge } of GLOBAL_MAP_VISUAL_OBSERVATION.edges) {
      if (!enabledKinds.has(edge.kind)) continue;
      adjacency.get(edge.fromNodeId)?.add(edge.toNodeId);
      adjacency.get(edge.toNodeId)?.add(edge.fromNodeId);
    }
    const queue = [focusNodeId];
    while (queue.length) {
      const current = queue.shift()!;
      if (connectedIds.has(current)) continue;
      connectedIds.add(current);
      queue.push(...(adjacency.get(current) ?? []));
    }
  }

  return {
    nodes: GLOBAL_MAP_VISUAL_OBSERVATION.nodes.map((summary) => ({
      ...summary,
      connectivity: !focusNodeId
        ? "default"
        : summary.node.id === focusNodeId
          ? "focus"
          : connectedIds.has(summary.node.id) ? "connected" : "unconnected",
    })),
    edges: GLOBAL_MAP_VISUAL_OBSERVATION.edges.map((summary) => ({
      ...summary,
      connectivity: !focusNodeId
        ? "default"
        : enabledKinds.has(summary.edge.kind)
            && connectedIds.has(summary.edge.fromNodeId)
            && connectedIds.has(summary.edge.toNodeId)
          ? "connected"
          : "unconnected",
    })),
    ...(focusNodeId ? { focusNodeId } : {}),
    appliedRelationshipKinds,
  };
}

export async function installGlobalMapVisualFixture(page: Page): Promise<void> {
  await page.route("**/v1/research-map*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(observationForRequest(route.request().url())),
  }));
}
