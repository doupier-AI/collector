import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { makeEdge, makeGraphObservation, makeGraphObservationNode } from "../../test/fakes";
import { GlobalResearchMap } from "./GlobalResearchMap";

function canvas() { return screen.getByTestId("global-map-canvas"); }
function node(label: string) { return within(canvas()).getByRole("button", { name: new RegExp(`^${label}，`) }); }

describe("GlobalResearchMap current-open scene", () => {
  it("uses fresh in-memory coordinates on every mount", () => {
    const observation = makeGraphObservation({ nodes: [makeGraphObservationNode("a", "节点 A")] });
    render(<MemoryRouter><GlobalResearchMap observation={observation} /></MemoryRouter>);
    const firstViewBox = canvas().querySelector("svg")?.getAttribute("viewBox");
    expect(firstViewBox).toMatch(/^-?\d+(?:\.\d+)? -?\d+(?:\.\d+)? \d+(?:\.\d+)? \d+(?:\.\d+)?$/);
  });
  it("draws straight lines and only renders arrows when switched on", () => {
    const observation = makeGraphObservation({ nodes: [makeGraphObservationNode("a", "节点 A"), makeGraphObservationNode("b", "节点 B")], edges: [{ edge: { ...makeEdge("parent-child", "a", "b"), kind: "parent-child" as const }, connectivity: "default" }] });
    const { rerender } = render(<MemoryRouter><GlobalResearchMap observation={observation} /></MemoryRouter>);
    expect(canvas().querySelector("[data-edge-kind]")?.getAttribute("d")).toMatch(/^M .* L /);
    rerender(<MemoryRouter><GlobalResearchMap observation={observation} showArrows /></MemoryRouter>);
    expect(canvas().querySelector(".global-map__edge-arrow")).not.toBeNull();
  });
  it("changes concentric node radii without moving node centers or title geometry", () => {
    const normal = makeGraphObservationNode("a", "普通节点", { candidateCount: 1 });
    const fusion = makeGraphObservationNode("fusion", "融合成果", {
      role: "fusion",
      node: { ...makeGraphObservationNode("fusion", "融合成果").node, isFusionNode: true },
    });
    const observation = makeGraphObservation({ nodes: [normal, fusion] });
    const { rerender } = render(<MemoryRouter><GlobalResearchMap observation={observation} /></MemoryRouter>);
    const normalGroup = canvas().querySelector<SVGGElement>('[data-node-id="a"]')!;
    const originalTransform = normalGroup.getAttribute("transform");
    const originalTitleY = normalGroup.querySelector(".global-map__node-title")?.getAttribute("y");

    rerender(<MemoryRouter><GlobalResearchMap observation={observation} nodeScale={1.5} /></MemoryRouter>);

    expect(normalGroup.getAttribute("transform")).toBe(originalTransform);
    expect(normalGroup.querySelector(".global-map__node-core")).toHaveAttribute("r", "10.5");
    expect(normalGroup.querySelector(".global-map__node-selection-halo")).toHaveAttribute("r", "17.5");
    expect(normalGroup.querySelector(".global-map__node-focus-ring")).toHaveAttribute("r", "20.5");
    expect(normalGroup.querySelector(".global-map__node-title")).toHaveAttribute("y", originalTitleY);
    expect(canvas().querySelector('[data-node-id="fusion"] .global-map__node-core')).toHaveAttribute("r", "13.5");
    const centerValues = [...normalGroup.getAttribute("transform")!.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
    const center = { x: centerValues[0]!, y: centerValues[1]! };
    expect(canvas().querySelector(".global-map__candidate-satellite")).toHaveAttribute("transform", `translate(${center.x + 20.5} ${center.y - 20.5})`);
  });
  it("clips arrowed relationships between the scaled source and target node boundaries", () => {
    const fusion = makeGraphObservationNode("fusion", "融合成果", {
      role: "fusion",
      node: { ...makeGraphObservationNode("fusion", "融合成果").node, isFusionNode: true },
    });
    const observation = makeGraphObservation({
      nodes: [makeGraphObservationNode("source", "来源"), fusion],
      edges: [{ edge: { ...makeEdge("parent-child", "source", "fusion"), kind: "parent-child" as const }, connectivity: "default" }],
    });
    render(<MemoryRouter><GlobalResearchMap observation={observation} nodeScale={1.5} showArrows /></MemoryRouter>);
    const source = canvas().querySelector<SVGGElement>('[data-node-id="source"]')!;
    const target = canvas().querySelector<SVGGElement>('[data-node-id="fusion"]')!;
    const path = canvas().querySelector("[data-edge-kind]")!.getAttribute("d")!;
    const values = [...path.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
    const sourceCenter = { x: Number(source.dataset.layoutX), y: Number(source.dataset.layoutY) };
    const targetCenter = { x: Number(target.dataset.layoutX), y: Number(target.dataset.layoutY) };

    expect(Math.hypot(values[0]! - sourceCenter.x, values[1]! - sourceCenter.y)).toBeCloseTo(12.5, 5);
    expect(Math.hypot(values[2]! - targetCenter.x, values[3]! - targetCenter.y)).toBeCloseTo(18.5, 5);
    expect(canvas().querySelector(".global-map__edge-arrow")).toHaveAttribute("d", path);
  });
  it("keeps every untouched node in its focused-tree position while a focused node starts dragging", () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    const nodes = [
      makeGraphObservationNode("root", "根节点"),
      makeGraphObservationNode("focus", "焦点"),
      makeGraphObservationNode("sibling", "兄弟"),
      makeGraphObservationNode("child", "后代"),
    ];
    const edges = [
      { edge: { ...makeEdge("parent-child", "root", "focus"), kind: "parent-child" as const }, connectivity: "default" as const },
      { edge: { ...makeEdge("parent-child", "root", "sibling"), kind: "parent-child" as const }, connectivity: "default" as const },
      { edge: { ...makeEdge("parent-child", "focus", "child"), kind: "parent-child" as const }, connectivity: "default" as const },
    ];
    const observation = { ...makeGraphObservation({ nodes, edges }), focusNodeId: "focus" };
    render(<MemoryRouter><GlobalResearchMap observation={observation} /></MemoryRouter>);
    const svg = canvas().querySelector("svg")!;
    Object.defineProperty(svg, "getScreenCTM", {
      configurable: true,
      value: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    });
    const untouched = canvas().querySelector<SVGGElement>('[data-node-id="root"]')!;
    const focusedTransform = untouched.getAttribute("transform");

    fireEvent.pointerDown(node("焦点"), { button: 0, pointerId: 7, clientX: 200, clientY: 100 });

    expect(untouched).toHaveAttribute("transform", focusedTransform);
    fireEvent.pointerCancel(node("焦点"), { pointerId: 7 });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  });
  it("emphasizes search matches in place and mutes non-matching nodes", () => {
    const observation = makeGraphObservation({
      nodes: [makeGraphObservationNode("a", "命中节点"), makeGraphObservationNode("b", "其他节点")],
    });

    render(<MemoryRouter><GlobalResearchMap observation={observation} search={{ query: "证据", matchedNodeIds: ["a"], selectedNodeId: "a" }} /></MemoryRouter>);

    expect(canvas().querySelector('[data-node-id="a"]')).toHaveClass("global-map__node--search-match", "global-map__node--search-selected");
    expect(canvas().querySelector('[data-node-id="b"]')).toHaveClass("global-map__node--search-muted");
  });
  it("adds an incremental isolate without moving or overlapping existing nodes", () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    const initialNodes = Array.from({ length: 4 }, (_, index) => makeGraphObservationNode(`node-${index}`, `节点 ${index}`));
    const { rerender } = render(<MemoryRouter><GlobalResearchMap observation={makeGraphObservation({ nodes: initialNodes })} /></MemoryRouter>);
    const before = new Map(initialNodes.map((summary) => [
      summary.node.id,
      canvas().querySelector(`[data-node-id="${summary.node.id}"]`)?.getAttribute("transform"),
    ]));
    const added = makeGraphObservationNode("node-4", "节点 4");

    rerender(<MemoryRouter><GlobalResearchMap observation={makeGraphObservation({ nodes: [...initialNodes, added] })} /></MemoryRouter>);

    for (const [id, transform] of before) expect(canvas().querySelector(`[data-node-id="${id}"]`)).toHaveAttribute("transform", transform);
    expect([...before.values()]).not.toContain(canvas().querySelector('[data-node-id="node-4"]')?.getAttribute("transform"));
    Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  });
  it("adds a third child on the established tree axis without moving existing nodes", () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    const initialNodes = ["root", "child-a", "child-b"].map((id) => makeGraphObservationNode(id, id));
    const edge = (to: string) => ({ edge: { ...makeEdge("parent-child", "root", to), kind: "parent-child" as const }, connectivity: "default" as const });
    const initial = makeGraphObservation({ nodes: initialNodes, edges: [edge("child-a"), edge("child-b")] });
    const { rerender } = render(<MemoryRouter><GlobalResearchMap observation={initial} /></MemoryRouter>);
    const before = new Map(initialNodes.map((summary) => [summary.node.id, canvas().querySelector(`[data-node-id="${summary.node.id}"]`)?.getAttribute("transform")]));
    const added = makeGraphObservationNode("child-c", "child-c");

    rerender(<MemoryRouter><GlobalResearchMap observation={makeGraphObservation({ nodes: [...initialNodes, added], edges: [...initial.edges, edge("child-c")] })} /></MemoryRouter>);

    for (const [id, transform] of before) expect(canvas().querySelector(`[data-node-id="${id}"]`)).toHaveAttribute("transform", transform);
    const coordinate = (id: string) => [...canvas().querySelector(`[data-node-id="${id}"]`)!.getAttribute("transform")!.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
    const root = coordinate("root");
    const first = coordinate("child-a");
    const next = coordinate("child-c");
    const horizontal = Math.abs(first[0]! - root[0]!) > Math.abs(first[1]! - root[1]!);
    expect(horizontal ? next[0] : next[1]).toBeCloseTo(horizontal ? first[0]! : first[1]!, 5);
    Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  });
  it("prepends a parent using the established descendant direction without folding the tree", () => {
    const oldNodes = [makeGraphObservationNode("root", "旧根"), makeGraphObservationNode("child", "旧子")];
    const edge = (from: string, to: string) => ({ edge: { ...makeEdge("parent-child", from, to), kind: "parent-child" as const }, connectivity: "default" as const });
    const initial = makeGraphObservation({ nodes: oldNodes, edges: [edge("root", "child")] });
    const { rerender } = render(<MemoryRouter><GlobalResearchMap observation={initial} /></MemoryRouter>);
    const before = oldNodes.map((summary) => canvas().querySelector(`[data-node-id="${summary.node.id}"]`)?.getAttribute("transform"));
    const parent = makeGraphObservationNode("a", "新父");

    rerender(<MemoryRouter><GlobalResearchMap observation={makeGraphObservation({ nodes: [parent, ...oldNodes], edges: [edge("a", "root"), ...initial.edges] })} /></MemoryRouter>);

    expect(canvas().querySelector('[data-node-id="root"]')).toHaveAttribute("transform", before[0]!);
    expect(canvas().querySelector('[data-node-id="child"]')).toHaveAttribute("transform", before[1]!);
    const coordinate = (id: string) => [...canvas().querySelector(`[data-node-id="${id}"]`)!.getAttribute("transform")!.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
    const added = coordinate("a");
    const root = coordinate("root");
    const child = coordinate("child");
    const firstVector = { x: root[0]! - added[0]!, y: root[1]! - added[1]! };
    const secondVector = { x: child[0]! - root[0]!, y: child[1]! - root[1]! };
    expect(firstVector.x * secondVector.x + firstVector.y * secondVector.y).toBeGreaterThan(0);
  });
  it("places an incrementally added earlier-sorting component without overlapping the retained scene", () => {
    const initialNodes = [makeGraphObservationNode("z-root", "旧根"), makeGraphObservationNode("z-child", "旧子")];
    const parentEdge = (from: string, to: string) => ({ edge: { ...makeEdge("parent-child", from, to), kind: "parent-child" as const }, connectivity: "default" as const });
    const initial = makeGraphObservation({ nodes: initialNodes, edges: [parentEdge("z-root", "z-child")] });
    const { rerender } = render(<MemoryRouter><GlobalResearchMap observation={initial} /></MemoryRouter>);
    const before = initialNodes.map((summary) => canvas().querySelector(`[data-node-id="${summary.node.id}"]`)?.getAttribute("transform"));
    const addedNodes = [makeGraphObservationNode("a-root", "新根"), makeGraphObservationNode("a-child", "新子")];

    rerender(<MemoryRouter><GlobalResearchMap observation={makeGraphObservation({ nodes: [...initialNodes, ...addedNodes], edges: [...initial.edges, parentEdge("a-root", "a-child")] })} /></MemoryRouter>);

    expect(canvas().querySelector('[data-node-id="z-root"]')).toHaveAttribute("transform", before[0]!);
    expect(canvas().querySelector('[data-node-id="z-child"]')).toHaveAttribute("transform", before[1]!);
    const transforms = [...canvas().querySelectorAll<SVGGElement>("[data-node-id]")].map((element) => element.getAttribute("transform"));
    expect(new Set(transforms).size).toBe(4);
  });
  it("enters parent-child focus and restores base positions on exit", () => {
    const onFocusNode = vi.fn();
    const base = makeGraphObservation({ nodes: [makeGraphObservationNode("root", "根"), makeGraphObservationNode("focus", "焦点"), makeGraphObservationNode("child", "后代"), makeGraphObservationNode("outside", "外围")], edges: [{ edge: { ...makeEdge("parent-child", "root", "focus"), kind: "parent-child" as const }, connectivity: "default" }, { edge: { ...makeEdge("parent-child", "focus", "child"), kind: "parent-child" as const }, connectivity: "default" }] });
    const { rerender } = render(<MemoryRouter><GlobalResearchMap observation={base} onFocusNode={onFocusNode} /></MemoryRouter>);
    const original = node("外围").getAttribute("transform"); fireEvent.click(node("焦点")); expect(onFocusNode).toHaveBeenCalledWith("focus");
    rerender(<MemoryRouter><GlobalResearchMap observation={{ ...base, focusNodeId: "focus" }} /></MemoryRouter>); expect(node("焦点")).toHaveAttribute("aria-pressed", "true");
    rerender(<MemoryRouter><GlobalResearchMap observation={base} /></MemoryRouter>); expect(node("外围").getAttribute("transform")).toEqual(original);
  });
});
