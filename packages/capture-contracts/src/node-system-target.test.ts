import { describe, expect, it } from "vitest";
import {
  RESEARCH_PERMANENT_EDGE_KINDS,
  nextProjectColorRole,
  isResearchPermanentEdge,
  validateTemporaryFusionBundle,
  type ResearchAssociationHintRecord,
  type ResearchCandidateSourceConnectionRecord,
  type ResearchEdgeRecord,
  type ResearchFusionDraftVersionRecord,
  type ResearchNodeSearchResult,
  type ResearchTemporaryFusionNodeRecord,
} from "./index.js";

describe("node system target contracts", () => {
  it("recognizes only parent-child and fused-from as permanent facts", () => {
    expect(RESEARCH_PERMANENT_EDGE_KINDS).toEqual(["parent-child", "fused-from"]);

    const legacySemanticEdge: ResearchEdgeRecord = {
      id: "edge:legacy-semantic",
      kind: "semantic-related",
      fromNodeId: "node-a",
      toNodeId: "node-b",
      createdAt: "2026-08-13T00:00:00.000Z",
      status: "active",
    };

    expect(isResearchPermanentEdge(legacySemanticEdge)).toBe(false);
    expect(isResearchPermanentEdge({ ...legacySemanticEdge, kind: "parent-child" })).toBe(true);
    expect(isResearchPermanentEdge({ ...legacySemanticEdge, kind: "fused-from" })).toBe(true);
  });

  it("assigns project color roles deterministically by least current use", () => {
    expect(nextProjectColorRole([])).toBe("amber");
    expect(nextProjectColorRole([
      { id: "p1", name: "P1", colorRole: "amber", createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z" },
      { id: "p2", name: "P2", colorRole: "violet", createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z" },
      { id: "p3", name: "P3", colorRole: "amber", createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z" },
    ])).toBe("blue");
  });

  it("keeps search, association hints, and temporary fusion evidence independent from weak mentions", () => {
    const range = {
      nodeId: "node-a",
      bodyVersionId: "body-a-v1",
      fragmentId: "fragment-a-1",
    };
    const searchResult: ResearchNodeSearchResult = {
      nodeId: "node-a",
      matchedRanges: [range],
      scope: "inside-current-filter",
    };
    const hint: ResearchAssociationHintRecord = {
      id: "hint-1",
      anchorNodeId: "node-a",
      relatedNodeId: "node-b",
      reason: "两段内容从不同角度解释同一个限制",
      anchorRanges: [range],
      relatedRanges: [{ ...range, nodeId: "node-b", bodyVersionId: "body-b-v1", fragmentId: "fragment-b-1" }],
      evidenceKey: "evidence-1",
      status: "active",
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    };

    expect(searchResult.matchedRanges).toEqual([range]);
    expect(hint.anchorRanges).toEqual([range]);
    expect(Object.keys({ searchResult, hint }).join(" ")).not.toMatch(/mention|marker|term/i);
  });

  it("requires two distinct locatable sources without treating evidence health as confirmation", () => {
    const node: ResearchTemporaryFusionNodeRecord = {
      id: "temporary-fusion-1",
      creationKey: "generation-task-1",
      activeDraftVersionId: "draft-1",
      status: "active",
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    };
    const draft: ResearchFusionDraftVersionRecord = {
      id: "draft-1",
      temporaryFusionNodeId: node.id,
      version: 1,
      body: "来源 A 与来源 B 共同支持一条可核验的新认识。",
      contentHash: "sha256:draft-1",
      evidenceStatus: "verified",
      createdAt: "2026-08-13T00:00:00.000Z",
    };
    const source = (sourceNodeId: string): ResearchCandidateSourceConnectionRecord => ({
      id: `candidate:${sourceNodeId}`,
      temporaryFusionNodeId: node.id,
      sourceNodeId,
      sourceKind: "formal",
      bodyVersionId: `body:${sourceNodeId}:v1`,
      fragmentIds: [`fragment:${sourceNodeId}:1`],
      sourceHealth: "available",
      createdAt: "2026-08-13T00:00:00.000Z",
    });

    expect(() => validateTemporaryFusionBundle(node, draft, [source("node-a")])).toThrow(/two distinct/i);
    expect(() => validateTemporaryFusionBundle(node, draft, [source("node-a"), source("node-a")])).toThrow(/two distinct/i);
    expect(() => validateTemporaryFusionBundle(node, draft, [source("node-a"), source("node-b")])).not.toThrow();
    expect(() => validateTemporaryFusionBundle(node, { ...draft, evidenceStatus: "pending" }, [source("node-a"), source("node-b")])).not.toThrow();
    expect(() => validateTemporaryFusionBundle(node, { ...draft, evidenceStatus: "invalid" }, [
      source("node-a"),
      { ...source("node-b"), sourceHealth: "deleted" },
    ])).not.toThrow();
  });
});
