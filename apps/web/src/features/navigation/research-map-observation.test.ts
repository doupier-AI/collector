import { describe, expect, it } from "vitest";
import type { ResearchGraphObservation } from "@collector/capture-contracts";
import { makeEdge, makeGraphObservation, makeGraphObservationNode } from "../../test/fakes";
import { filterResearchMapObservation, focusResearchMapObservation } from "./research-map-observation";

describe("research map observation derivation", () => {
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
});
