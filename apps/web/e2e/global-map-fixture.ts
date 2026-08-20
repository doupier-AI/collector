import type { Page } from "@playwright/test";
import type { ProjectRecord, ResearchGraphObservation } from "@collector/capture-contracts";

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
    createdAt?: string;
  } = {},
): ResearchGraphObservation["nodes"][number] => ({
  node: {
    id,
    sessionId: `session-${id}`,
    status: "active",
    ...(options.role === "fusion" ? { isFusionNode: true } : {}),
    createdAt: options.createdAt ?? AT,
    updatedAt: options.createdAt ?? AT,
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

const project = (id: string, name: string, colorRole: ProjectRecord["colorRole"]): ProjectRecord => ({
  id,
  name,
  colorRole,
  createdAt: AT,
  updatedAt: AT,
});

const GLOBAL_MAP_VISUAL_PROJECTS = [
  project("project-amber", "知识工程", "amber"),
  project("project-blue", "研究方法", "blue"),
  project("project-violet", "综合成果", "violet"),
];

const GLOBAL_MAP_FILTER_PROJECTS = [
  project("project-one", "项目一", "amber"),
  project("project-two", "项目二", "blue"),
];

const GLOBAL_MAP_FILTER_OBSERVATION: ResearchGraphObservation = {
  nodes: [
    node("filter-a", "项目一节点 A", { projectId: "project-one", projectName: "项目一", projectColorRole: "amber", createdAt: "2026-08-18T00:00:00.000Z" }),
    node("filter-b", "桥接节点 B", { projectId: "project-two", projectName: "项目二", projectColorRole: "blue", createdAt: "2026-08-19T00:00:00.000Z" }),
    node("filter-c", "项目一节点 C", { projectId: "project-one", projectName: "项目一", projectColorRole: "amber", lifecycle: "archived", createdAt: "2026-08-20T00:00:00.000Z" }),
    node("filter-u", "未分类节点", { createdAt: "2026-08-21T00:00:00.000Z" }),
  ],
  edges: [
    { edge: { id: "filter-edge-ab", kind: "parent-child", fromNodeId: "filter-a", toNodeId: "filter-b", status: "active", createdAt: AT }, connectivity: "default" },
    { edge: { id: "filter-edge-bc", kind: "parent-child", fromNodeId: "filter-b", toNodeId: "filter-c", status: "active", createdAt: AT }, connectivity: "default" },
  ],
  appliedRelationshipKinds: ["parent-child", "fused-from"],
};

function observationForRequest(source: ResearchGraphObservation, requestUrl: string): ResearchGraphObservation {
  const url = new URL(requestUrl);
  const focusNodeId = url.searchParams.get("focusNodeId") ?? undefined;
  const kindsWereSpecified = url.searchParams.has("relationshipKind");
  const requestedKinds = url.searchParams.getAll("relationshipKind").filter(Boolean);
  const appliedRelationshipKinds = (kindsWereSpecified
    ? ["parent-child", "fused-from"].filter((kind) => requestedKinds.includes(kind))
    : ["parent-child", "fused-from"]) as ResearchGraphObservation["appliedRelationshipKinds"];
  const enabledKinds = new Set(appliedRelationshipKinds);
  const selectedProjects = new Set(url.searchParams.getAll("projectId"));
  const includeUncategorized = url.searchParams.get("includeUncategorized") === "true";
  const lifecycleValues = url.searchParams.getAll("lifecycle");
  const enabledLifecycles = new Set(lifecycleValues.length ? lifecycleValues : ["active", "archived"]);
  const createdFrom = url.searchParams.get("createdFrom");
  const createdBefore = url.searchParams.get("createdBefore");
  const hasProjectScope = selectedProjects.size > 0 || includeUncategorized;
  const hasLifecycleScope = enabledLifecycles.size !== 2;
  const hasRangeScope = hasProjectScope || hasLifecycleScope || Boolean(createdFrom || createdBefore);
  const insideIds = new Set(source.nodes.filter((summary) => {
    const projectMatches = !hasProjectScope
      || (summary.projectId ? selectedProjects.has(summary.projectId) : includeUncategorized);
    const createdAt = summary.node.createdAt;
    return projectMatches
      && enabledLifecycles.has(summary.lifecycle)
      && (!createdFrom || createdAt >= createdFrom)
      && (!createdBefore || createdAt < createdBefore);
  }).map((summary) => summary.node.id));
  const connectedIds = new Set<string>();

  if (focusNodeId && source.nodes.some((summary) => summary.node.id === focusNodeId)) {
    const adjacency = new Map(source.nodes.map((summary) => [summary.node.id, new Set<string>()]));
    for (const { edge } of source.edges) {
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

  const includedIds = new Set(insideIds);
  if (focusNodeId) {
    includedIds.add(focusNodeId);
    for (const id of connectedIds) includedIds.add(id);
  } else if (hasRangeScope) {
    for (const { edge } of source.edges) {
      if (!enabledKinds.has(edge.kind)) continue;
      if (insideIds.has(edge.fromNodeId) || insideIds.has(edge.toNodeId)) {
        includedIds.add(edge.fromNodeId);
        includedIds.add(edge.toNodeId);
      }
    }
  }

  return {
    nodes: source.nodes.filter((summary) => includedIds.has(summary.node.id)).map((summary) => ({
      ...summary,
      scope: insideIds.has(summary.node.id)
        ? "inside-current-filter"
        : focusNodeId ? "outside-bridge" : "outside-boundary",
      connectivity: !focusNodeId
        ? "default"
        : summary.node.id === focusNodeId
          ? "focus"
          : connectedIds.has(summary.node.id) ? "connected" : "unconnected",
    })),
    edges: source.edges.filter(({ edge }) => includedIds.has(edge.fromNodeId) && includedIds.has(edge.toNodeId)).map((summary) => ({
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
  await installGlobalMapFixture(page, GLOBAL_MAP_VISUAL_OBSERVATION, GLOBAL_MAP_VISUAL_PROJECTS);
}

export async function installGlobalMapFilterFixture(page: Page): Promise<void> {
  await installGlobalMapFixture(page, GLOBAL_MAP_FILTER_OBSERVATION, GLOBAL_MAP_FILTER_PROJECTS);
}

async function installGlobalMapFixture(page: Page, observation: ResearchGraphObservation, projects: readonly ProjectRecord[]): Promise<void> {
  await page.route("**/v1/projects", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(projects),
  }));
  await page.route("**/v1/research-map*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(observationForRequest(observation, route.request().url())),
  }));
}
