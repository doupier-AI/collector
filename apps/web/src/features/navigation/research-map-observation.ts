import type {
  ResearchGraphObservation,
  ResearchGraphObservationInput,
  ResearchGraphObservationNode,
} from "@collector/capture-contracts";

/** 根节点由完整正式父子关系确定；融合来源不改变节点树的根身份。 */
export function researchMapRootNodeIds(observation: ResearchGraphObservation): ReadonlySet<string> {
  const childNodeIds = new Set(observation.edges
    .filter(({ edge }) => edge.kind === "parent-child")
    .map(({ edge }) => edge.toNodeId));
  return new Set(observation.nodes
    .map(({ node }) => node.id)
    .filter((nodeId) => !childNodeIds.has(nodeId)));
}

/** 空的正式融合树暂不显示根节点色标；融合来源不算父子生长。 */
export function researchMapRootMarkerNodeIds(observation: ResearchGraphObservation): ReadonlySet<string> {
  const rootNodeIds = researchMapRootNodeIds(observation);
  const parentNodeIds = new Set(observation.edges
    .filter(({ edge }) => edge.kind === "parent-child")
    .map(({ edge }) => edge.fromNodeId));
  return new Set(observation.nodes
    .filter((summary) => rootNodeIds.has(summary.node.id)
      && (summary.role !== "fusion" || parentNodeIds.has(summary.node.id)))
    .map(({ node }) => node.id));
}

/**
 * 全局观察只请求一次完整正式图，再在当前打开的组件实例中派生筛选结果。
 * 临时融合仍不是正式节点；开启临时层时，仅把可用的直接来源补作弱化背景。
 */
export function filterResearchMapObservation(
  observation: ResearchGraphObservation,
  input: ResearchGraphObservationInput,
  includeTemporarySources: boolean,
): ResearchGraphObservation {
  const selectedProjectIds = input.projectIds?.length ? new Set(input.projectIds) : undefined;
  const hasProjectFilter = Boolean(selectedProjectIds || input.includeUncategorized === true);
  const selectedLifecycles = new Set(input.lifecycles ?? ["active", "archived"]);
  const inScope = (summary: ResearchGraphObservationNode) => {
    if (!selectedLifecycles.has(summary.lifecycle)) return false;
    if (hasProjectFilter) {
      const included = summary.projectId
        ? selectedProjectIds?.has(summary.projectId) === true
        : input.includeUncategorized === true;
      if (!included) return false;
    }
    if (input.createdFrom && summary.node.createdAt < input.createdFrom) return false;
    if (input.createdBefore && summary.node.createdAt >= input.createdBefore) return false;
    return true;
  };

  const primaryIds = new Set(observation.nodes.filter(inScope).map((summary) => summary.node.id));
  const temporarySourceIds = includeTemporarySources
    ? new Set((observation.temporaryFusions ?? [])
      .flatMap((fusion) => fusion.candidateSources)
      .filter((source) => source.sourceHealth === "available")
      .map((source) => source.sourceNodeId))
    : new Set<string>();
  const nodes: ResearchGraphObservationNode[] = [];
  for (const summary of observation.nodes) {
    if (primaryIds.has(summary.node.id)) {
      nodes.push({ ...summary, scope: "inside-current-filter", connectivity: "default" });
    } else if (temporarySourceIds.has(summary.node.id)) {
      nodes.push({ ...summary, scope: "outside-boundary", connectivity: "default", candidateCount: 0 });
    }
  }
  return {
    ...observation,
    nodes,
    // 背景来源只辅助理解临时观察，不能把其正式关系一并带回当前筛选。
    edges: observation.edges.filter(({ edge }) => primaryIds.has(edge.fromNodeId) && primaryIds.has(edge.toNodeId)),
  };
}

/** 搜索定位可临时把完整观察中的一个范围外节点投影回画布；筛选和永久关系保持不变。 */
export function withResearchMapRevealTarget(
  observation: ResearchGraphObservation,
  fullObservation: ResearchGraphObservation,
  nodeId: string | undefined,
): ResearchGraphObservation {
  if (!nodeId || observation.nodes.some((summary) => summary.node.id === nodeId)) return observation;
  const target = fullObservation.nodes.find((summary) => summary.node.id === nodeId);
  if (!target) return observation;
  return {
    ...observation,
    nodes: [...observation.nodes, {
      ...target,
      scope: "outside-boundary",
      connectivity: "default",
      candidateCount: 0,
    }],
  };
}

/** 父子专注只沿永久 parent-child 边计算全部祖先和后代，融合来源不参与。 */
export function focusResearchMapObservation(
  observation: ResearchGraphObservation,
  focusNodeId: string | undefined,
): ResearchGraphObservation {
  if (!focusNodeId || !observation.nodes.some((summary) => summary.node.id === focusNodeId)) return observation;
  const parentsByChild = new Map<string, string[]>();
  const childrenByParent = new Map<string, string[]>();
  for (const { edge } of observation.edges) {
    if (edge.kind !== "parent-child") continue;
    const parents = parentsByChild.get(edge.toNodeId) ?? [];
    parents.push(edge.fromNodeId);
    parentsByChild.set(edge.toNodeId, parents);
    const children = childrenByParent.get(edge.fromNodeId) ?? [];
    children.push(edge.toNodeId);
    childrenByParent.set(edge.fromNodeId, children);
  }
  const focusIds = new Set([focusNodeId]);
  const visit = (from: ReadonlyMap<string, readonly string[]>) => {
    const queue = [focusNodeId];
    while (queue.length) {
      const current = queue.shift()!;
      for (const next of from.get(current) ?? []) {
        if (focusIds.has(next)) continue;
        focusIds.add(next);
        queue.push(next);
      }
    }
  };
  visit(parentsByChild);
  visit(childrenByParent);
  return {
    ...observation,
    focusNodeId,
    nodes: observation.nodes.map((summary) => ({
      ...summary,
      connectivity: summary.node.id === focusNodeId
        ? "focus"
        : focusIds.has(summary.node.id) ? "connected" : "unconnected",
    })),
    // 专注底图只展示脉络里的父子边；融合来源与外围关系均不参与。
    edges: observation.edges.filter(({ edge }) => edge.kind === "parent-child" && focusIds.has(edge.fromNodeId) && focusIds.has(edge.toNodeId)),
  };
}

/** 隐藏真正孤立的正式节点，不改变其余节点或边；临时观察所需的弱化来源始终保留。 */
export function withResearchMapIsolates(
  observation: ResearchGraphObservation,
  showIsolates: boolean,
  focusNodeId: string | undefined,
): ResearchGraphObservation {
  if (showIsolates) return observation;
  const connected = new Set(observation.edges.flatMap(({ edge }) => [edge.fromNodeId, edge.toNodeId]));
  const keptIds = new Set(observation.nodes
    .filter((summary) => connected.has(summary.node.id) || summary.scope !== "inside-current-filter" || summary.node.id === focusNodeId)
    .map((summary) => summary.node.id));
  return {
    ...observation,
    nodes: observation.nodes.filter((summary) => keptIds.has(summary.node.id)),
    edges: observation.edges.filter(({ edge }) => keptIds.has(edge.fromNodeId) && keptIds.has(edge.toNodeId)),
  };
}
