import { describe, expect, it } from "vitest";
import { makeEdge, makeGraphNodeSummary, makeGraphProjection } from "../../test/fakes";
import { buildFocusLineage, focusLineageBySelectedKinds, focusLineageRovingIds } from "./focus-lineage";

/** 三级血统投影：root → parent → focus，focus 有两个子节点、一个同级，另带语义/融合邻居。 */
function lineageProjection() {
  const root = makeGraphNodeSummary("root", "根节点", 2);
  const parent = makeGraphNodeSummary("parent", "父节点", 1, { parentNodeId: "root" });
  const focus = makeGraphNodeSummary("focus", "当前节点", 0, { parentNodeId: "parent" });
  const childA = makeGraphNodeSummary("child-a", "子节点 A", 1, { parentNodeId: "focus" });
  const childB = makeGraphNodeSummary("child-b", "子节点 B", 1, { parentNodeId: "focus" });
  const sibling = makeGraphNodeSummary("sibling", "同级节点", 1, { parentNodeId: "parent" });
  const related = makeGraphNodeSummary("related", "语义邻居", 1);
  const fused = makeGraphNodeSummary("fused", "融合来源", 1);
  const edges = [
    makeEdge("parent-child", "root", "parent"),
    makeEdge("parent-child", "parent", "focus"),
    makeEdge("parent-child", "parent", "sibling"),
    makeEdge("parent-child", "focus", "child-a"),
    makeEdge("parent-child", "focus", "child-b"),
    makeEdge("semantic-related", "focus", "related"),
    makeEdge("fused-from", "fused", "focus"),
  ];
  return makeGraphProjection({
    nodes: [root, parent, focus, childA, childB, sibling, related, fused],
    edges,
    focusNodeId: "focus",
  });
}

describe("buildFocusLineage", () => {
  it("祖先链按 根→父 排序，子与同级按创建时间升序", () => {
    const lineage = buildFocusLineage(lineageProjection(), "focus");

    expect(lineage.current?.node.id).toBe("focus");
    expect(lineage.ancestors.map((summary) => summary.node.id)).toEqual(["root", "parent"]);
    expect(lineage.children.map((summary) => summary.node.id)).toEqual(["child-a", "child-b"]);
    expect(lineage.siblings.map((summary) => summary.node.id)).toEqual(["sibling"]);
  });

  it("同级仅当父节点在投影内时存在；孤儿节点无祖先无同级", () => {
    const projection = makeGraphProjection({
      nodes: [makeGraphNodeSummary("orphan", "孤儿节点", 0), makeGraphNodeSummary("peer", "无关节点", 1)],
      edges: [],
      focusNodeId: "orphan",
    });
    const lineage = buildFocusLineage(projection, "orphan");

    expect(lineage.ancestors).toEqual([]);
    expect(lineage.siblings).toEqual([]);
    expect(lineage.children).toEqual([]);
  });

  it("父节点缺失（边指向投影外）时按孤儿容错，不抛错", () => {
    const projection = makeGraphProjection({
      nodes: [makeGraphNodeSummary("focus", "当前", 0, { parentNodeId: "missing-parent" })],
      edges: [],
      focusNodeId: "focus",
    });
    const lineage = buildFocusLineage(projection, "focus");

    expect(lineage.current?.node.id).toBe("focus");
    expect(lineage.ancestors).toEqual([]);
    expect(lineage.siblings).toEqual([]);
  });

  it("血统链成环时安全截断（不无限循环）", () => {
    const a = makeGraphNodeSummary("a", "节点 A", 1, { parentNodeId: "b" });
    const b = makeGraphNodeSummary("b", "节点 B", 1, { parentNodeId: "a" });
    const projection = makeGraphProjection({
      nodes: [a, b, makeGraphNodeSummary("focus", "当前", 0, { parentNodeId: "a" })],
      edges: [],
      focusNodeId: "focus",
    });
    const lineage = buildFocusLineage(projection, "focus");

    // 焦点 → a → b →（a 已访问，停止）：回环被 visited 集合截断，不会无限循环
    expect(lineage.ancestors.map((summary) => summary.node.id)).toEqual(["b", "a"]);
  });

  it("自环（父节点指向自身）同样安全截断", () => {
    const a = makeGraphNodeSummary("a", "节点 A", 1, { parentNodeId: "a" });
    const projection = makeGraphProjection({
      nodes: [a, makeGraphNodeSummary("focus", "当前", 0, { parentNodeId: "a" })],
      edges: [],
      focusNodeId: "focus",
    });
    const lineage = buildFocusLineage(projection, "focus");

    expect(lineage.ancestors.map((summary) => summary.node.id)).toEqual(["a"]);
  });

  it("焦点不在投影内时返回空脉络", () => {
    const projection = makeGraphProjection({
      nodes: [makeGraphNodeSummary("other", "其他节点", 0)],
      edges: [],
      focusNodeId: "missing",
    });
    const lineage = buildFocusLineage(projection, "missing");

    expect(lineage.current).toBeNull();
    expect(lineage.ancestors).toEqual([]);
    expect(lineage.children).toEqual([]);
    expect(lineage.siblings).toEqual([]);
  });

  it("多根会话：两个根各自成脉络，彼此不串", () => {
    const rootA = makeGraphNodeSummary("root-a", "根 A", 2);
    const focusA = makeGraphNodeSummary("focus-a", "A 的子", 1, { parentNodeId: "root-a" });
    const rootB = makeGraphNodeSummary("root-b", "根 B", 2);
    const projection = makeGraphProjection({
      nodes: [rootA, focusA, rootB],
      edges: [makeEdge("parent-child", "root-a", "focus-a")],
      focusNodeId: "focus-a",
    });
    const lineage = buildFocusLineage(projection, "focus-a");

    expect(lineage.ancestors.map((summary) => summary.node.id)).toEqual(["root-a"]);
    expect(lineage.siblings).toEqual([]);
    expect(lineage.current?.node.id).toBe("focus-a");
  });
});

describe("focusLineageRovingIds", () => {
  it("候选顺序固定为 祖先→当前→子→同级，与渲染一致", () => {
    const ids = focusLineageRovingIds(buildFocusLineage(lineageProjection(), "focus"));

    expect(ids).toEqual(["root", "parent", "focus", "child-a", "child-b", "sibling"]);
  });

  it("空脉络返回空候选", () => {
    expect(focusLineageRovingIds({ ancestors: [], current: null, children: [], siblings: [] })).toEqual([]);
  });
});

describe("focusLineageBySelectedKinds", () => {
  it("只选融合来源时，血统只剩当前节点（父子边被过滤）", () => {
    const lineage = focusLineageBySelectedKinds(lineageProjection(), "focus", ["fused-from"]);

    expect(lineage.current?.node.id).toBe("focus");
    expect(lineage.ancestors).toEqual([]);
    expect(lineage.children).toEqual([]);
    expect(lineage.siblings).toEqual([]);
  });

  it("关闭全部筛选时仍保留当前节点", () => {
    const lineage = focusLineageBySelectedKinds(lineageProjection(), "focus", []);

    expect(lineage.current?.node.id).toBe("focus");
    expect(lineage.ancestors).toEqual([]);
    expect(lineage.children).toEqual([]);
  });

  it("选父子时保留血统，但不引入语义/融合邻居", () => {
    const lineage = focusLineageBySelectedKinds(lineageProjection(), "focus", ["parent-child"]);

    expect(lineage.ancestors.map((summary) => summary.node.id)).toEqual(["root", "parent"]);
    expect(lineage.children.map((summary) => summary.node.id)).toEqual(["child-a", "child-b"]);
    expect(lineage.current?.node.id).toBe("focus");
  });
});
