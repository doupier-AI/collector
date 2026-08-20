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
  assert.ok(result.edges.every((item) => item.connectivity === "connected"));
});

test("creation time scope includes its lower boundary, excludes its upper boundary, and ignores later node updates", () => {
  const sessions = [session("lower"), session("upper"), session("outside")];
  const nodes = [
    node("lower", "lower", { createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-19T00:00:00.000Z" }),
    node("upper", "upper", { createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" }),
    node("outside", "outside", { createdAt: "2026-08-09T23:59:59.999Z", updatedAt: "2026-08-20T00:00:00.000Z" }),
  ];

  const result = buildResearchGraphObservation(nodes, [], sessions, [], {
    createdFrom: "2026-08-10T00:00:00.000Z",
    createdBefore: "2026-08-11T00:00:00.000Z",
  });

  assert.deepEqual(result.nodes.map((item) => item.node.id), ["lower"]);
});

test("mixed permanent paths, cycles and disabled parallel facts keep one server-classified observation", () => {
  const sessions = [session("a"), session("b"), session("c"), session("d")];
  const nodes = sessions.map((item) => node(item.id, item.id));
  const result = buildResearchGraphObservation(nodes, [
    edge("parent-child", "a", "b"),
    edge("fused-from", "a", "b"),
    edge("parent-child", "b", "c"),
    edge("parent-child", "c", "a"),
    edge("fused-from", "c", "d"),
  ], sessions, [], { focusNodeId: "a", relationshipKinds: ["parent-child"] });

  assert.deepEqual(result.appliedRelationshipKinds, ["parent-child"]);
  assert.equal(result.nodes.find((item) => item.node.id === "c")?.connectivity, "connected");
  assert.equal(result.nodes.find((item) => item.node.id === "d")?.connectivity, "unconnected");
  assert.equal(result.edges.length, 5, "disabled facts remain visible background instead of disappearing");
  assert.equal(result.edges.find((item) => item.edge.id === researchEdgeId("fused-from", "a", "b"))?.connectivity, "unconnected");
  assert.equal(result.edges.find((item) => item.edge.id === researchEdgeId("fused-from", "c", "d"))?.connectivity, "unconnected");
  assert.ok(result.edges.filter((item) => item.edge.kind === "parent-child")
    .every((item) => item.connectivity === "connected"));
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
  assert.equal(result.nodes.find((item) => item.node.id === "b")?.projectName, "项目二");
  assert.equal(result.nodes.find((item) => item.node.id === "b")?.projectColorRole, "blue");
  assert.equal(result.edges.length, 2);
});

test("project scope distinguishes all projects, uncategorized-only, project-only, and their union while retaining bridges", () => {
  const projects: ProjectRecord[] = [
    { id: "p1", name: "项目一", colorRole: "amber", createdAt: AT, updatedAt: AT },
    { id: "p2", name: "项目二", colorRole: "blue", createdAt: AT, updatedAt: AT },
  ];
  const sessions = [
    session("p1", { projectId: "p1" }),
    session("p2", { projectId: "p2" }),
    session("uncategorized"),
  ];
  const nodes = sessions.map((item) => node(item.id, item.id));
  const edgeChain = [edge("parent-child", "p1", "p2"), edge("parent-child", "p2", "uncategorized")];

  assert.deepEqual(
    buildResearchGraphObservation(nodes, edgeChain, sessions, projects).nodes.map((item) => item.node.id),
    ["p1", "p2", "uncategorized"],
  );
  assert.deepEqual(
    buildResearchGraphObservation(nodes, edgeChain, sessions, projects, { includeUncategorized: true }).nodes.map((item) => item.node.id),
    ["uncategorized"],
  );
  assert.deepEqual(
    buildResearchGraphObservation(nodes, edgeChain, sessions, projects, { projectIds: ["p1"] }).nodes.map((item) => item.node.id),
    ["p1"],
  );

  const combined = buildResearchGraphObservation(nodes, edgeChain, sessions, projects, {
    focusNodeId: "p1",
    projectIds: ["p1"],
    includeUncategorized: true,
  });
  assert.equal(combined.nodes.find((item) => item.node.id === "p2")?.scope, "outside-bridge");
  assert.deepEqual(combined.nodes.map((item) => item.node.id), ["p1", "p2", "uncategorized"]);
});

test("a focused fusion keeps every direct source visible across the project filter", () => {
  const projects: ProjectRecord[] = [
    { id: "p1", name: "项目一", colorRole: "amber", createdAt: AT, updatedAt: AT },
    { id: "p2", name: "项目二", colorRole: "blue", createdAt: AT, updatedAt: AT },
  ];
  const sessions = [session("fusion", { projectId: "p1" }), session("source", { projectId: "p2" })];
  const nodes = [node("fusion", "fusion", { isFusionNode: true }), node("source", "source")];
  const result = buildResearchGraphObservation(
    nodes,
    [edge("fused-from", "source", "fusion")],
    sessions,
    projects,
    { focusNodeId: "fusion", projectIds: ["p1"], relationshipKinds: ["fused-from"] },
  );

  assert.equal(result.nodes.find((item) => item.node.id === "source")?.scope, "outside-bridge");
  assert.equal(result.nodes.find((item) => item.node.id === "source")?.connectivity, "connected");
  assert.equal(result.edges[0]?.connectivity, "connected");
});

test("an explicit empty relationship selection keeps only the focus emphasized", () => {
  const sessions = [session("a"), session("b"), session("island")];
  const nodes = sessions.map((item) => node(item.id, item.id));
  const result = buildResearchGraphObservation(
    nodes,
    [edge("parent-child", "a", "b")],
    sessions,
    [],
    { focusNodeId: "a", relationshipKinds: [] },
  );

  assert.deepEqual(result.appliedRelationshipKinds, []);
  assert.equal(result.edges.length, 1);
  assert.equal(result.edges[0]?.connectivity, "unconnected");
  assert.equal(result.nodes.find((item) => item.node.id === "a")?.connectivity, "focus");
  assert.equal(result.nodes.find((item) => item.node.id === "b")?.connectivity, "unconnected");
  assert.equal(result.nodes.find((item) => item.node.id === "island")?.connectivity, "unconnected");
});

test("a 1200-node permanent chain is classified as one complete component without a depth cutoff", () => {
  const sessions = Array.from({ length: 1_200 }, (_, index) => session(`scale-${index.toString().padStart(4, "0")}`));
  const nodes = sessions.map((item) => node(item.id, item.id));
  const edges = sessions.slice(1).map((item, index) => edge(
    index % 2 === 0 ? "parent-child" : "fused-from",
    sessions[index]!.id,
    item.id,
  ));
  const result = buildResearchGraphObservation(nodes, edges, sessions, [], { focusNodeId: sessions[0]!.id });

  assert.equal(result.nodes.length, 1_200);
  assert.equal(result.edges.length, 1_199);
  assert.equal(result.nodes.at(-1)?.connectivity, "connected");
  assert.ok(result.edges.every((item) => item.connectivity === "connected"));
});
