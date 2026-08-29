import { describe, expect, it } from "vitest";
import type { ResearchGraphObservation } from "@collector/capture-contracts";
import { makeEdge, makeGraphObservation, makeGraphObservationNode } from "../../test/fakes";
import { filterResearchMapObservation, focusResearchMapObservation, researchMapRootMarkerNodeIds, researchMapRootNodeIds, withResearchMapRevealTarget } from "./research-map-observation";

describe("research map observation derivation", () => {
  it("identifies one root per parent-child tree, including single-node and fusion-result trees", () => {
    const observation = makeGraphObservation({
      nodes: [
        makeGraphObservationNode("root", "根节点"),
        makeGraphObservationNode("middle", "中间节点"),
        makeGraphObservationNode("leaf", "叶节点"),
        makeGraphObservationNode("fusion", "空融合根节点", { role: "fusion" }),
        makeGraphObservationNode("grown-fusion", "已生长融合根节点", { role: "fusion" }),
        makeGraphObservationNode("fusion-child", "融合后续节点"),
        makeGraphObservationNode("single", "单节点树"),
      ],
      edges: [
        { edge: { ...makeEdge("parent-child", "root", "middle"), kind: "parent-child" as const }, connectivity: "default" },
        { edge: { ...makeEdge("parent-child", "middle", "leaf"), kind: "parent-child" as const }, connectivity: "default" },
        { edge: { ...makeEdge("fused-from", "leaf", "fusion"), kind: "fused-from" as const }, connectivity: "default" },
        { edge: { ...makeEdge("parent-child", "grown-fusion", "fusion-child"), kind: "parent-child" as const }, connectivity: "default" },
      ],
    });

    expect([...researchMapRootNodeIds(observation)].sort()).toEqual(["fusion", "grown-fusion", "root", "single"]);
    expect([...researchMapRootMarkerNodeIds(observation)].sort()).toEqual(["grown-fusion", "root", "single"]);
  });

  it("temporarily projects a selected search result outside the active filter without restoring its relationships", () => {
    const full = makeGraphObservation({
      nodes: [makeGraphObservationNode("inside", "范围内"), makeGraphObservationNode("outside", "范围外")],
      edges: [{ edge: { ...makeEdge("parent-child", "inside", "outside"), kind: "parent-child" as const }, connectivity: "default" as const }],
    });
    const filtered = { ...full, nodes: [full.nodes[0]!], edges: [] };

    const revealed = withResearchMapRevealTarget(filtered, full, "outside");

    expect(revealed.nodes.map(({ node }) => node.id)).toEqual(["inside", "outside"]);
    expect(revealed.nodes[1]).toMatchObject({ scope: "outside-boundary", connectivity: "default" });
    expect(revealed.edges).toEqual([]);
  });

  it("父子专注只标记祖先与后代，不把兄弟或融合来源带入脉络边", () => {
    const nodes = [
      makeGraphObservationNode("parent", "父节点"),
      makeGraphObservationNode("focus", "焦点"),
      makeGraphObservationNode("sibling", "兄弟"),
      makeGraphObservationNode("child", "子节点"),
      makeGraphObservationNode("fusion-source", "融合来源"),
    ];
    const observation = makeGraphObservation({
      nodes,
      edges: [
        { edge: { ...makeEdge("parent-child", "parent", "focus"), kind: "parent-child" as const }, connectivity: "default" },
        { edge: { ...makeEdge("parent-child", "parent", "sibling"), kind: "parent-child" as const }, connectivity: "default" },
        { edge: { ...makeEdge("parent-child", "focus", "child"), kind: "parent-child" as const }, connectivity: "default" },
        { edge: { ...makeEdge("fused-from", "fusion-source", "focus"), kind: "fused-from" as const }, connectivity: "default" },
      ],
    });

    const focused = focusResearchMapObservation(observation, "focus");

    expect(Object.fromEntries(focused.nodes.map((node) => [node.node.id, node.connectivity]))).toEqual({
      parent: "connected",
      focus: "focus",
      sibling: "unconnected",
      child: "connected",
      "fusion-source": "unconnected",
    });
    expect(focused.edges.map(({ edge }) => [edge.kind, edge.fromNodeId, edge.toNodeId])).toEqual([
      ["parent-child", "parent", "focus"],
      ["parent-child", "focus", "child"],
    ]);
  });

  it("临时层开启时保留筛选范围外的可用直接来源，却不带回其永久关系", () => {
    const source = makeGraphObservationNode("source", "直接来源", { projectId: "project-outside" });
    const selected = makeGraphObservationNode("selected", "当前项目", { projectId: "project-in" });
    const temporaryFusions: NonNullable<ResearchGraphObservation["temporaryFusions"]> = [{
      node: { id: "temporary", creationKey: "key", triggerProposalId: "proposal", activeDraftVersionId: "draft", status: "active", createdAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-26T00:00:00.000Z" },
      label: "临时融合",
      evidenceStatus: "verified",
      candidateSources: [{ id: "temporary-source", temporaryFusionNodeId: "temporary", sourceNodeId: "source", sourceKind: "formal", bodyVersionId: "body", fragmentIds: ["fragment"], sourceHealth: "available", createdAt: "2026-08-26T00:00:00.000Z" }],
    }];
    const observation: ResearchGraphObservation = {
      ...makeGraphObservation({
      nodes: [source, selected],
      edges: [{ edge: { ...makeEdge("parent-child", "source", "selected"), kind: "parent-child" as const }, connectivity: "default" }],
      }),
      temporaryFusions,
    };

    const filtered = filterResearchMapObservation(observation, { projectIds: ["project-in"] }, true);

    expect(filtered.nodes.map((node) => [node.node.id, node.scope])).toEqual([
      ["source", "outside-boundary"],
      ["selected", "inside-current-filter"],
    ]);
    expect(filtered.edges).toEqual([]);
  });

  it("仅勾选未分类时不会把所有项目节点误当成未筛选", () => {
    const observation = makeGraphObservation({
      nodes: [
        makeGraphObservationNode("project", "项目节点", { projectId: "project-a" }),
        makeGraphObservationNode("uncategorized", "未分类节点", { projectId: undefined }),
      ],
    });

    const filtered = filterResearchMapObservation(observation, { includeUncategorized: true }, false);

    expect(filtered.nodes.map((summary) => summary.node.id)).toEqual(["uncategorized"]);
  });
});
