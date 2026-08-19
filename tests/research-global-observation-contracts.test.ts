import assert from "node:assert/strict";
import test from "node:test";
import {
  buildResearchGraphObservation,
  researchEdgeId,
  type ProjectRecord,
  type ResearchEdgeRecord,
  type ResearchNodeRecord,
  type ResearchSessionRecord,
} from "@collector/capture-contracts";

const AT = "2026-08-19T00:00:00.000Z";
const session = (id: string, overrides: Partial<ResearchSessionRecord> = {}): ResearchSessionRecord => ({
  id, title: `会话 ${id}`, status: "active", isFavorite: false, createdAt: AT, updatedAt: AT, ...overrides,
});
const node = (id: string, sessionId: string, overrides: Partial<ResearchNodeRecord> = {}): ResearchNodeRecord => ({
  id, sessionId, status: "active", createdAt: AT, updatedAt: AT, ...overrides,
});
const edge = (kind: ResearchEdgeRecord["kind"], fromNodeId: string, toNodeId: string): ResearchEdgeRecord => ({
  id: researchEdgeId(kind, fromNodeId, toNodeId), kind, fromNodeId, toNodeId, status: "active", createdAt: AT,
});

test("global observation includes cross-session roots, archived and isolated nodes but excludes trash and legacy semantic edges", () => {
  const sessions = [
    session("a", { projectId: "p1" }),
    session("b", { status: "archived", projectId: "p2" }),
    session("isolated"),
    session("trash", { trashedAt: AT }),
  ];
  const nodes = [node("a", "a"), node("b", "b"), node("isolated", "isolated"), node("trash", "trash")];
  const result = buildResearchGraphObservation(nodes, [edge("fused-from", "a", "b"), edge("semantic-related", "a", "isolated")], sessions, []);

  assert.deepEqual(result.nodes.map((item) => item.node.id), ["a", "b", "isolated"]);
  assert.equal(result.nodes.find((item) => item.node.id === "b")?.lifecycle, "archived");
  assert.deepEqual(result.edges.map((item) => item.edge.kind), ["fused-from"]);
  assert.ok(result.nodes.every((item) => item.connectivity === "default"));
});

test("focus traverses the complete permanent component without maxDepth and keeps unrelated nodes as unconnected context", () => {
  const sessions = [session("a"), session("b"), session("c"), session("d"), session("island")];
  const nodes = sessions.map((item) => node(item.id, item.id));
  const result = buildResearchGraphObservation(nodes, [
    edge("parent-child", "a", "b"),
    edge("parent-child", "b", "c"),
    edge("fused-from", "c", "d"),
  ], sessions, [], { focusNodeId: "a" });

  assert.equal(result.nodes.find((item) => item.node.id === "a")?.connectivity, "focus");
  assert.equal(result.nodes.find((item) => item.node.id === "d")?.connectivity, "connected");
  assert.equal(result.nodes.find((item) => item.node.id === "island")?.connectivity, "unconnected");
});

test("project scope keeps an outside node on the focus path as a bridge", () => {
  const projects: ProjectRecord[] = [
    { id: "p1", name: "项目一", colorRole: "amber", createdAt: AT, updatedAt: AT },
    { id: "p2", name: "项目二", colorRole: "blue", createdAt: AT, updatedAt: AT },
  ];
  const sessions = [session("a", { projectId: "p1" }), session("b", { projectId: "p2" }), session("c", { projectId: "p1" })];
  const nodes = sessions.map((item) => node(item.id, item.id));
  const result = buildResearchGraphObservation(nodes, [edge("parent-child", "a", "b"), edge("parent-child", "b", "c")], sessions, projects, {
    focusNodeId: "a", projectIds: ["p1"],
  });

  assert.equal(result.nodes.find((item) => item.node.id === "b")?.scope, "outside-bridge");
  assert.equal(result.nodes.find((item) => item.node.id === "b")?.projectColorRole, "blue");
  assert.equal(result.edges.length, 2);
});
