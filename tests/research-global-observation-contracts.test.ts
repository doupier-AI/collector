import assert from "node:assert/strict";
import test from "node:test";
import {
  buildResearchGraphObservation,
  researchEdgeId,
  type ResearchGraphLifecycle,
  type ProjectRecord,
  type ResearchEdgeRecord,
  type ResearchAssociationHintRecord,
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

test("observation derives unique active candidate totals, endpoint satellites, and opt-in details only after visible nodes are known", () => {
  const sessions = [session("a"), session("b"), session("hidden", { trashedAt: AT })];
  const nodes = [node("a", "a"), node("b", "b"), node("hidden", "hidden")];
  const hints: ResearchAssociationHintRecord[] = [
    {
      id: "hint:a-b", anchorNodeId: "a", relatedNodeId: "b", relationType: "contrast",
      reason: "同名概念在两处材料中形成对比。",
      anchorRanges: [{ nodeId: "a", bodyVersionId: "body:a", fragmentId: "fragment:a" }],
      relatedRanges: [{ nodeId: "b", bodyVersionId: "body:b", fragmentId: "fragment:b" }],
      evidenceContentKey: "content:a-b", evidenceKey: "evidence:a-b", status: "active", createdAt: AT, updatedAt: AT,
    },
    {
      id: "hint:a-hidden", anchorNodeId: "a", relatedNodeId: "hidden", relationType: "shared-concept",
      reason: "隐藏会话不应混入当前观察。",
      anchorRanges: [{ nodeId: "a", bodyVersionId: "body:a", fragmentId: "fragment:a" }],
      relatedRanges: [{ nodeId: "hidden", bodyVersionId: "body:hidden", fragmentId: "fragment:hidden" }],
      evidenceContentKey: "content:a-hidden", evidenceKey: "evidence:a-hidden", status: "active", createdAt: AT, updatedAt: AT,
    },
    {
      id: "hint:ignored", anchorNodeId: "a", relatedNodeId: "b", relationType: "contrast",
      reason: "已忽略提示不应返回。",
      anchorRanges: [{ nodeId: "a", bodyVersionId: "body:a", fragmentId: "fragment:a" }],
      relatedRanges: [{ nodeId: "b", bodyVersionId: "body:b", fragmentId: "fragment:b" }],
      evidenceContentKey: "content:ignored", evidenceKey: "evidence:ignored", status: "ignored", createdAt: AT, updatedAt: AT,
    },
  ];

  const summary = buildResearchGraphObservation(nodes, [], sessions, [], {}, { activeAssociationHints: hints });
  assert.equal(summary.activeCandidateCount, 1);
  assert.equal(summary.nodes.find((item) => item.node.id === "a")?.candidateCount, 1);
  assert.equal(summary.nodes.find((item) => item.node.id === "b")?.candidateCount, 1);
  assert.equal(summary.associationHints, undefined, "详情必须显式按需请求");

  const details = buildResearchGraphObservation(nodes, [], sessions, [], {
    includeAssociationHints: true,
    associationCandidateNodeId: "b",
  }, { activeAssociationHints: hints });
  assert.equal(details.activeCandidateCount, 1);
  assert.deepEqual(details.associationHints?.map((hint) => hint.id), ["hint:a-b"]);
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

test("lifecycle scope composes with project and creation time without treating later changes as range membership", () => {
  const sessions = [
    session("archived-in-project", { projectId: "p1", status: "archived" }),
    session("active-in-project", { projectId: "p1" }),
    session("archived-other-project", { projectId: "p2", status: "archived" }),
    session("archived-outside-time", { projectId: "p1", status: "archived" }),
  ];
  const nodes = [
    node("archived-in-project", "archived-in-project", { createdAt: "2026-08-10T00:00:00.000Z" }),
    node("active-in-project", "active-in-project", { createdAt: "2026-08-10T00:00:00.000Z" }),
    node("archived-other-project", "archived-other-project", { createdAt: "2026-08-10T00:00:00.000Z" }),
    node("archived-outside-time", "archived-outside-time", { createdAt: "2026-08-11T00:00:00.000Z" }),
  ];

  const result = buildResearchGraphObservation(nodes, [], sessions, [], {
    projectIds: ["p1"],
    lifecycles: ["archived"],
    createdFrom: "2026-08-10T00:00:00.000Z",
    createdBefore: "2026-08-11T00:00:00.000Z",
  });

  assert.deepEqual(result.nodes.map((item) => item.node.id), ["archived-in-project"]);
});

test("archived-only scope preserves an active bridge but explicit both keeps both endpoints in scope", () => {
  const sessions = [
    session("archived-focus", { projectId: "p1", status: "archived" }),
    session("active-bridge", { projectId: "p2" }),
    session("archived-target", { projectId: "p1", status: "archived" }),
  ];
  const nodes = sessions.map((item) => node(item.id, item.id));
  const edges = [
    edge("parent-child", "archived-focus", "active-bridge"),
    edge("parent-child", "active-bridge", "archived-target"),
  ];
  const archivedOnly = buildResearchGraphObservation(nodes, edges, sessions, [], {
    focusNodeId: "archived-focus", lifecycles: ["archived"],
  });
  assert.equal(archivedOnly.nodes.find((item) => item.node.id === "active-bridge")?.scope, "outside-bridge");

  const both = buildResearchGraphObservation(nodes, edges, sessions, [], { lifecycles: ["active", "archived"] });
  assert.ok(both.nodes.every((item) => item.scope === "inside-current-filter"));
});

test("shared lifecycle input rejects empty, duplicated, and invalid explicit values", () => {
  const sessions = [session("node")];
  const nodes = [node("node", "node")];

  assert.throws(
    () => buildResearchGraphObservation(nodes, [], sessions, [], { lifecycles: [] }),
    /non-empty, non-duplicated active or archived/,
  );
  assert.throws(
    () => buildResearchGraphObservation(nodes, [], sessions, [], { lifecycles: ["active", "active"] }),
    /non-empty, non-duplicated active or archived/,
  );
  assert.throws(
    () => buildResearchGraphObservation(nodes, [], sessions, [], {
      lifecycles: ["retired"] as unknown as ResearchGraphLifecycle[],
    }),
    /non-empty, non-duplicated active or archived/,
  );
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

test("unfocused range scope keeps only one-hop endpoints of enabled permanent boundary relations", () => {
  const sessions = [
    session("inside", { projectId: "p1" }),
    session("boundary", { projectId: "p2" }),
    session("outside", { projectId: "p2" }),
  ];
  const nodes = sessions.map((item) => node(item.id, item.id));
  const edges = [
    edge("parent-child", "inside", "boundary"),
    edge("parent-child", "boundary", "outside"),
  ];

  const boundary = buildResearchGraphObservation(nodes, edges, sessions, [], { projectIds: ["p1"] });
  assert.deepEqual(boundary.nodes.map((item) => item.node.id), ["boundary", "inside"]);
  assert.equal(boundary.nodes.find((item) => item.node.id === "boundary")?.scope, "outside-boundary");
  assert.equal(boundary.nodes.find((item) => item.node.id === "outside"), undefined);
  assert.deepEqual(boundary.edges.map((item) => item.edge.id), [researchEdgeId("parent-child", "inside", "boundary")]);

  const noEnabledBoundary = buildResearchGraphObservation(nodes, edges, sessions, [], {
    projectIds: ["p1"], relationshipKinds: ["fused-from"],
  });
  assert.deepEqual(noEnabledBoundary.nodes.map((item) => item.node.id), ["inside"]);
  assert.deepEqual(noEnabledBoundary.edges, []);
});

test("focused range scope picks the same lexicographic shortest bridge path from shuffled nodes and edges", () => {
  const sessions = [
    session("focus", { projectId: "p1" }),
    session("inside", { projectId: "p1" }),
    session("bridge-b", { projectId: "p2" }),
    session("bridge-c", { projectId: "p2" }),
  ];
  const nodes = sessions.map((item) => node(item.id, item.id));
  const edges = [
    edge("parent-child", "focus", "bridge-c"),
    edge("parent-child", "bridge-c", "inside"),
    edge("parent-child", "focus", "bridge-b"),
    edge("parent-child", "bridge-b", "inside"),
  ];
  const input = { focusNodeId: "focus", projectIds: ["p1"] };
  const first = buildResearchGraphObservation(nodes, edges, sessions, [], input);
  const shuffled = buildResearchGraphObservation([...nodes].reverse(), [...edges].reverse(), [...sessions].reverse(), [], input);

  assert.deepEqual(shuffled, first);
  assert.deepEqual(first.nodes.map((item) => item.node.id), ["bridge-b", "focus", "inside"]);
  assert.equal(first.nodes.find((item) => item.node.id === "bridge-b")?.scope, "outside-bridge");
  assert.equal(first.nodes.find((item) => item.node.id === "bridge-c"), undefined);
  assert.ok(first.nodes.every((item) => item.scope !== "outside-boundary"), "bridge classification wins while focused");
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
    buildResearchGraphObservation(nodes, [], sessions, projects).nodes.map((item) => item.node.id),
    ["p1", "p2", "uncategorized"],
  );
  assert.deepEqual(
    buildResearchGraphObservation(nodes, [], sessions, projects, { includeUncategorized: true }).nodes.map((item) => item.node.id),
    ["uncategorized"],
  );
  assert.deepEqual(
    buildResearchGraphObservation(nodes, [], sessions, projects, { projectIds: ["p1"] }).nodes.map((item) => item.node.id),
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
