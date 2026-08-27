import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAssociationHint, makeEdge, makeGraphObservation, makeGraphObservationNode } from "../../test/fakes";
import { GlobalResearchMap } from "./GlobalResearchMap";
import { serializeMapScene } from "./map-scene";
import { DEFAULT_RESEARCH_MAP_FILTER_STATE } from "./research-map-filters";

function renderMap() {
  render(
    <MemoryRouter>
      <GlobalResearchMap observation={makeGraphObservation({ nodes: [
        makeGraphObservationNode("a", "节点 A"),
        makeGraphObservationNode("b", "节点 B"),
        makeGraphObservationNode("c", "节点 C"),
      ] })} />
    </MemoryRouter>,
  );
}

function renderConnectedMap(onFocusNode = vi.fn()) {
  const observation = makeGraphObservation({
    nodes: [
      makeGraphObservationNode("a", "节点 A"),
      makeGraphObservationNode("b", "节点 B"),
      makeGraphObservationNode("c", "节点 C"),
    ],
    edges: [{ edge: { ...makeEdge("parent-child", "a", "b"), kind: "parent-child" as const }, connectivity: "default" }],
  });
  const rendered = render(
    <MemoryRouter>
      <GlobalResearchMap observation={observation} onFocusNode={onFocusNode} />
    </MemoryRouter>,
  );
  return { observation, onFocusNode, rendered };
}

function canvasNode(canvas: HTMLElement, label: string): HTMLElement {
  return within(canvas).getByRole("button", { name: new RegExp(`^${label}，`) });
}

function installControlledAnimationFrames() {
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextId;
    callbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  return {
    flush(timestamp: number) {
      const frame = [...callbacks.values()];
      callbacks.clear();
      act(() => frame.forEach((callback) => callback(timestamp)));
    },
    pending: () => callbacks.size,
  };
}

describe("GlobalResearchMap keyboard navigation", () => {
  it("筛选移除当前 roving 节点后把桌面 Tab 入口收敛到仍可见节点", async () => {
    const initial = makeGraphObservation({ nodes: [
      makeGraphObservationNode("a", "节点 A"),
      makeGraphObservationNode("b", "节点 B"),
    ] });
    const rendered = render(
      <MemoryRouter>
        <GlobalResearchMap observation={initial} />
      </MemoryRouter>,
    );
    const initialCanvas = screen.getByTestId("global-map-canvas");
    canvasNode(initialCanvas, "节点 A").focus();

    rendered.rerender(
      <MemoryRouter>
        <GlobalResearchMap observation={makeGraphObservation({ nodes: [makeGraphObservationNode("b", "节点 B")] })} />
      </MemoryRouter>,
    );

    const remaining = canvasNode(screen.getByTestId("global-map-canvas"), "节点 B");
    await waitFor(() => expect(remaining).toHaveAttribute("tabindex", "0"));
    expect(screen.getByTestId("global-map-canvas").querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it("wide canvas moves focus only among SVG nodes", async () => {
    renderMap();
    const canvas = screen.getByTestId("global-map-canvas");
    const first = canvasNode(canvas, "节点 A");
    const second = canvasNode(canvas, "节点 B");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(second));
    expect(screen.getByTestId("global-map-list")).not.toContainElement(document.activeElement as HTMLElement);
  });

  it("narrow list moves focus only among list links", async () => {
    renderMap();
    const list = screen.getByTestId("global-map-list");
    const first = within(list).getByLabelText(/节点 A/);
    const second = within(list).getByLabelText(/节点 B/);
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(second));
    expect(screen.getByTestId("global-map-canvas")).not.toContainElement(document.activeElement as HTMLElement);
  });

  it("打开或卸载地图会取消尚未执行的单击专注", () => {
    vi.useFakeTimers();
    try {
      const focus = vi.fn();
      const open = vi.fn();
      const observation = makeGraphObservation({ nodes: [makeGraphObservationNode("a", "节点 A")] });
      const rendered = render(
        <MemoryRouter>
          <GlobalResearchMap observation={observation} onFocusNode={focus} onOpenNode={open} />
        </MemoryRouter>,
      );
      const node = canvasNode(screen.getByTestId("global-map-canvas"), "节点 A");
      fireEvent.click(node, { detail: 1 });
      fireEvent.keyDown(node, { key: "Enter" });
      vi.advanceTimersByTime(200);
      expect(open).toHaveBeenCalledWith("a");
      expect(focus).not.toHaveBeenCalled();

      fireEvent.click(node, { detail: 1 });
      rendered.unmount();
      vi.advanceTimersByTime(200);
      expect(focus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GlobalResearchMap association candidate observation", () => {
  it("shows one exact satellite per node and opens its node-scoped candidate list by keyboard", () => {
    const onOpenCandidates = vi.fn();
    const observation = makeGraphObservation({ nodes: [
      makeGraphObservationNode("a", "节点 A", { candidateCount: 2 }),
      makeGraphObservationNode("b", "节点 B", { candidateCount: 1 }),
    ] });
    render(<MemoryRouter><GlobalResearchMap observation={observation} onOpenCandidates={onOpenCandidates} /></MemoryRouter>);
    const canvas = screen.getByTestId("global-map-canvas");
    const satellite = within(canvas).getByRole("button", { name: "查看节点 A的2条关联候选" });

    satellite.focus();
    expect(satellite).toHaveFocus();
    fireEvent.keyDown(satellite, { key: "Enter" });

    expect(onOpenCandidates).toHaveBeenCalledWith({ kind: "node", nodeId: "a" }, satellite);
    expect([...canvas.querySelectorAll("title")].some((title) => title.textContent === "2 条关联候选")).toBe(true);
    expect(satellite.querySelector("text")).toBeNull();
    expect(satellite.querySelectorAll(".global-map__candidate-satellite-core")).toHaveLength(1);
  });

  it("draws temporary hints over unchanged coordinates without adding permanent layout edges", async () => {
    const onSceneChange = vi.fn();
    const observation = makeGraphObservation({ nodes: [
      makeGraphObservationNode("a", "节点 A", { candidateCount: 1 }),
      makeGraphObservationNode("b", "节点 B", { candidateCount: 1 }),
    ] });
    const hint = makeAssociationHint({ anchorNodeId: "a", relatedNodeId: "b" });
    const rendered = render(<MemoryRouter><GlobalResearchMap observation={observation} onSceneChange={onSceneChange} /></MemoryRouter>);
    const before = [...screen.getByTestId("global-map-canvas").querySelectorAll<SVGGElement>("[data-node-id]")].map((node) => node.getAttribute("transform"));

    rendered.rerender(<MemoryRouter><GlobalResearchMap observation={observation} associationHints={[hint]} candidateMode onSceneChange={onSceneChange} /></MemoryRouter>);

    const canvas = screen.getByTestId("global-map-canvas");
    expect(canvas.querySelector(`[data-candidate-id="${hint.id}"]`)).not.toBeNull();
    expect(canvas.closest(".global-map")).toHaveClass("global-map--candidate-mode");
    expect([...canvas.querySelectorAll<SVGGElement>("[data-node-id]")].map((node) => node.getAttribute("transform"))).toEqual(before);
    await waitFor(() => expect(onSceneChange).toHaveBeenCalled());
    expect(onSceneChange.mock.calls.at(-1)?.[0].layout.edgeKeys).toEqual([]);
  });
});

describe("GlobalResearchMap stable organic canvas", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("范围筛选隐藏再恢复节点时保留全部已知坐标", () => {
    const nodes = [
      makeGraphObservationNode("a", "节点 A"),
      makeGraphObservationNode("b", "节点 B"),
      makeGraphObservationNode("c", "节点 C"),
      makeGraphObservationNode("d", "节点 D"),
    ];
    const edges = [
      { edge: { ...makeEdge("parent-child", "a", "b"), kind: "parent-child" as const }, connectivity: "default" as const },
      { edge: { ...makeEdge("parent-child", "b", "c"), kind: "parent-child" as const }, connectivity: "default" as const },
    ];
    const full = makeGraphObservation({ nodes, edges });
    const filtered = makeGraphObservation({ nodes: nodes.slice(0, 2), edges: edges.slice(0, 1) });
    const selectedFilters = {
      ...DEFAULT_RESEARCH_MAP_FILTER_STATE,
      projectScope: { kind: "selected" as const, projectIds: ["project-one"], includeUncategorized: false },
    };
    const rendered = render(<MemoryRouter><GlobalResearchMap observation={full} /></MemoryRouter>);
    const initial = Object.fromEntries(nodes.map(({ node }) => [node.id, screen.getByTestId("global-map-canvas").querySelector(`[data-node-id="${node.id}"]`)?.getAttribute("transform")]));

    rendered.rerender(<MemoryRouter><GlobalResearchMap observation={filtered} filters={selectedFilters} /></MemoryRouter>);
    rendered.rerender(<MemoryRouter><GlobalResearchMap observation={full} /></MemoryRouter>);

    for (const { node } of nodes) {
      expect(screen.getByTestId("global-map-canvas").querySelector(`[data-node-id="${node.id}"]`)).toHaveAttribute("transform", initial[node.id]);
    }
  });

  it("从当前 history entry 恢复视口、坐标和边快照，并继续把现场交回页面", () => {
    const observation = makeGraphObservation({
      nodes: [makeGraphObservationNode("a", "节点 A"), makeGraphObservationNode("b", "节点 B")],
      edges: [{ edge: { ...makeEdge("parent-child", "a", "b"), kind: "parent-child" as const }, connectivity: "default" }],
    });
    const initialScene = serializeMapScene({
      filters: DEFAULT_RESEARCH_MAP_FILTER_STATE,
      relationshipKinds: ["parent-child"],
      viewBox: { x: 40, y: 20, width: 480, height: 270 },
      layout: {
        world: { width: 960, height: 540 },
        positions: new Map([["a", { x: 144, y: 188 }], ["b", { x: 322, y: 266 }]]),
        edgeKeys: new Map([["edge:parent-child:a:b:a:b", ["a", "b"] as const]]),
      },
    });
    const onSceneChange = vi.fn();
    render(<MemoryRouter><GlobalResearchMap observation={observation} initialScene={initialScene} onSceneChange={onSceneChange} /></MemoryRouter>);
    const canvas = screen.getByTestId("global-map-canvas");
    expect(canvasNode(canvas, "节点 A")).toHaveAttribute("transform", "translate(144 188)");
    expect(within(canvas).getByRole("group", { name: "跨会话研究关系画布" })).toHaveAttribute("viewBox", "40 20 480 270");
    expect(onSceneChange).toHaveBeenLastCalledWith(expect.objectContaining({
      layout: expect.objectContaining({ edgeKeys: [["edge:parent-child:a:b:a:b", "a", "b"]] }),
    }));
  });

  it("专注观察保留全图坐标：单击或 Space 选择焦点，连通与未连通状态同源呈现", () => {
    const focus = vi.fn();
    const base = {
      ...makeGraphObservation({
      nodes: [
        { ...makeGraphObservationNode("a", "节点 A"), connectivity: "focus" as const },
        { ...makeGraphObservationNode("b", "节点 B"), connectivity: "connected" as const },
        { ...makeGraphObservationNode("c", "节点 C"), connectivity: "unconnected" as const },
      ],
      edges: [
        { edge: { ...makeEdge("parent-child", "a", "b"), kind: "parent-child" as const }, connectivity: "connected" as const },
        { edge: { ...makeEdge("fused-from", "a", "b"), kind: "fused-from" as const }, connectivity: "connected" as const },
      ],
      }),
      focusNodeId: "a",
    };
    render(<MemoryRouter><GlobalResearchMap observation={base} onFocusNode={focus} /></MemoryRouter>);
    const canvas = screen.getByTestId("global-map-canvas");
    const first = canvasNode(canvas, "节点 A");
    const connected = canvasNode(canvas, "节点 B");
    const unconnected = canvasNode(canvas, "节点 C");

    expect(first).toHaveClass("global-map__node--focus");
    expect(connected).toHaveClass("global-map__node--connected");
    expect(unconnected).toHaveClass("global-map__node--unconnected");
    expect(canvas.querySelectorAll("path.global-map__edge")).toHaveLength(1);
    expect(canvas.querySelector("path.global-map__edge")?.getAttribute("d")).toContain(" Q ");
    expect(canvas.querySelector(".global-map__edge--connected")).toHaveClass("global-map__edge--fused-from");

    fireEvent.click(unconnected);
    fireEvent.keyDown(connected, { key: " " });
    expect(focus).toHaveBeenNthCalledWith(1, "c");
    expect(focus).toHaveBeenNthCalledWith(2, "b");
  });

  it("用独立形状、归档文字、项目名和焦点环解码地图状态", () => {
    const observation = makeGraphObservation({
      nodes: [
        { ...makeGraphObservationNode("regular", "普通节点", { projectName: "琥珀项目", projectColorRole: "amber" }), connectivity: "unconnected" as const },
        { ...makeGraphObservationNode("fusion", "融合节点", {
          projectName: "紫色项目",
          projectColorRole: "violet",
          role: "fusion",
          lifecycle: "archived",
          fusionEvidenceHealth: "available",
          node: { ...makeGraphObservationNode("fusion-base", "融合基础").node, id: "fusion", isFusionNode: true },
        }), connectivity: "focus" as const },
        { ...makeGraphObservationNode("incomplete", "证据缺失融合", {
          projectName: "蓝色项目",
          projectColorRole: "blue",
          role: "fusion",
          fusionEvidenceHealth: "incomplete",
          node: { ...makeGraphObservationNode("incomplete-base", "融合基础").node, id: "incomplete", isFusionNode: true },
        }), connectivity: "unconnected" as const },
        { ...makeGraphObservationNode("uncategorized", "未分类节点"), connectivity: "unconnected" as const },
      ],
    });
    render(<MemoryRouter><GlobalResearchMap observation={{ ...observation, focusNodeId: "fusion" }} /></MemoryRouter>);
    const canvas = screen.getByTestId("global-map-canvas");
    const regular = within(canvas).getByLabelText(/普通节点，琥珀项目，研究节点，活跃/);
    const fusion = within(canvas).getByLabelText(/融合节点，紫色项目，融合成果，已归档，证据可用/);
    const incomplete = within(canvas).getByLabelText(/证据缺失融合，蓝色项目，融合成果，活跃，证据不完整，未与焦点连通/);
    const uncategorized = within(canvas).getByLabelText(/未分类节点，未分类，研究节点，活跃/);

    expect(regular).toHaveClass("global-map__node--project-amber", "global-map__node--research");
    expect(fusion).toHaveClass("global-map__node--project-violet", "global-map__node--fusion", "global-map__node--archived");
    expect(fusion).toHaveTextContent("紫色项目 · 融合成果 · 已归档");
    expect(fusion.querySelector(".global-map__node-evidence")).toHaveTextContent("证据可用");
    expect(incomplete.querySelector(".global-map__node-evidence--incomplete")).toHaveTextContent("证据不完整");
    expect(uncategorized.getAttribute("class")).not.toContain("global-map__node--project-");
    fusion.focus();
    expect(fusion).toHaveClass("global-map__node--selected");
    expect(fusion.querySelector(".global-map__node-selection-halo")).not.toBeNull();
    expect(fusion.querySelector(".global-map__node-focus-ring")).not.toBeNull();

    const narrowList = screen.getByTestId("global-map-list");
    const fusionLink = within(narrowList).getByLabelText(/融合节点，紫色项目，融合成果，已归档/);
    const incompleteLink = within(narrowList).getByLabelText(/证据缺失融合，蓝色项目，融合成果，活跃，证据不完整/);
    expect(fusionLink).toHaveTextContent("紫色项目 · 融合节点 · 融合成果 · 已归档");
    expect(incompleteLink).toHaveTextContent("证据不完整 · 未连通");
    expect(fusionLink.querySelector(".global-map__list-dot")).toHaveClass(
      "global-map__list-dot--project-violet",
      "global-map__list-dot--fusion",
      "global-map__list-dot--archived",
    );
  });

  it("为范围外桥接保留真实归属与既有状态，并在画布和窄屏列表明确说明原因", () => {
    const observation = {
      ...makeGraphObservation({
        nodes: [
          makeGraphObservationNode("inside", "当前范围节点", { projectName: "琥珀项目", projectColorRole: "amber" }),
          { ...makeGraphObservationNode("bridge", "范围外归档融合", {
            projectName: "紫色项目",
            projectColorRole: "violet",
            role: "fusion",
            lifecycle: "archived",
            fusionEvidenceHealth: "incomplete",
            scope: "outside-bridge",
            node: { ...makeGraphObservationNode("bridge-base", "融合基础").node, id: "bridge", isFusionNode: true },
          }), connectivity: "focus" as const },
          { ...makeGraphObservationNode("boundary", "范围边界节点", {
            projectName: "蓝色项目",
            projectColorRole: "blue",
            scope: "outside-boundary",
          }), connectivity: "connected" as const },
          { ...makeGraphObservationNode("uncategorized-bridge", "范围外未分类", { scope: "outside-bridge" }), connectivity: "connected" as const },
        ],
      }),
      focusNodeId: "bridge",
    };
    render(<MemoryRouter><GlobalResearchMap observation={observation} /></MemoryRouter>);

    const canvas = screen.getByTestId("global-map-canvas");
    const inside = within(canvas).getByLabelText(/当前范围节点，琥珀项目，研究节点，活跃/);
    const bridge = within(canvas).getByLabelText(/范围外归档融合，紫色项目，融合成果，已归档，证据不完整，范围外桥接，当前专注/);
    const boundary = within(canvas).getByLabelText(/范围边界节点，蓝色项目，研究节点，活跃，范围边界，与焦点连通/);
    const uncategorizedBridge = within(canvas).getByLabelText(/范围外未分类，未分类，研究节点，活跃，范围外桥接，与焦点连通/);

    expect(inside).not.toHaveClass("global-map__node--outside-boundary", "global-map__node--outside-bridge");
    expect(inside).not.toHaveTextContent("范围边界");
    expect(bridge).toHaveClass("global-map__node--outside-bridge", "global-map__node--project-violet", "global-map__node--fusion", "global-map__node--archived", "global-map__node--focus");
    expect(bridge).not.toHaveClass("global-map__node--outside-boundary");
    expect(bridge.querySelector(".global-map__node-scope")).toHaveTextContent("范围外桥接");
    expect(bridge.querySelector(".global-map__node-evidence--incomplete")).toHaveTextContent("证据不完整");
    expect(boundary).toHaveClass("global-map__node--outside-boundary", "global-map__node--project-blue", "global-map__node--connected");
    expect(boundary).not.toHaveClass("global-map__node--outside-bridge");
    expect(boundary.querySelector(".global-map__node-scope")).toHaveTextContent("范围边界");
    expect(uncategorizedBridge).toHaveClass("global-map__node--outside-bridge");
    expect(uncategorizedBridge.getAttribute("class")).not.toContain("global-map__node--project-");

    const narrowList = screen.getByTestId("global-map-list");
    const bridgeLink = within(narrowList).getByLabelText(/范围外归档融合，紫色项目，融合成果，已归档，证据不完整，范围外桥接，当前专注/);
    const boundaryLink = within(narrowList).getByLabelText(/范围边界节点，蓝色项目，研究节点，活跃，范围边界，与焦点连通/);
    const insideLink = within(narrowList).getByLabelText(/当前范围节点，琥珀项目，研究节点，活跃/);
    expect(bridgeLink).toHaveClass("global-map__list-link--outside-bridge");
    expect(bridgeLink).toHaveTextContent("紫色项目 · 范围外归档融合 · 融合成果 · 已归档 · 证据不完整 · 当前专注");
    expect(bridgeLink.querySelector(".global-map__scope-badge")).toHaveTextContent("范围外桥接");
    expect(bridgeLink.querySelector(".global-map__list-dot")).toHaveClass("global-map__list-dot--outside-bridge", "global-map__list-dot--fusion", "global-map__list-dot--archived");
    expect(boundaryLink).toHaveClass("global-map__list-link--outside-boundary");
    expect(boundaryLink).not.toHaveClass("global-map__list-link--outside-bridge");
    expect(boundaryLink.querySelector(".global-map__scope-badge")).toHaveTextContent("范围边界");
    expect(boundaryLink.querySelector(".global-map__list-dot")).toHaveClass("global-map__list-dot--outside-boundary", "global-map__list-dot--project-blue");
    expect(insideLink).not.toHaveTextContent("范围边界");
    expect(insideLink).not.toHaveClass("global-map__list-link--outside-boundary", "global-map__list-link--outside-bridge");
  });

  it("observation 增加孤立节点时既有 SVG 坐标不变，并让 viewBox 消费扩展世界", () => {
    const base = makeGraphObservation({ nodes: [makeGraphObservationNode("a", "节点 A"), makeGraphObservationNode("b", "节点 B")] });
    const rendered = render(<MemoryRouter><GlobalResearchMap observation={base} /></MemoryRouter>);
    const canvas = screen.getByTestId("global-map-canvas");
    const before = canvasNode(canvas, "节点 A").getAttribute("transform");
    rendered.rerender(<MemoryRouter><GlobalResearchMap observation={makeGraphObservation({ nodes: [...base.nodes, makeGraphObservationNode("c", "节点 C")] })} /></MemoryRouter>);
    expect(canvasNode(canvas, "节点 A")).toHaveAttribute("transform", before);
  });

  it("世界扩容时保留用户当前缩放视图", () => {
    const nodes = Array.from({ length: 64 }, (_, index) => makeGraphObservationNode(`n-${index}`, `节点 ${index}`));
    const rendered = render(<MemoryRouter><GlobalResearchMap observation={makeGraphObservation({ nodes })} /></MemoryRouter>);
    const svg = within(screen.getByTestId("global-map-canvas")).getByRole("group", { name: "跨会话研究关系画布" });
    fireEvent.click(screen.getByRole("button", { name: "放大地图" }));
    const before = svg.getAttribute("viewBox");
    rendered.rerender(<MemoryRouter><GlobalResearchMap observation={makeGraphObservation({ nodes: [...nodes, makeGraphObservationNode("n-64", "节点 64")] })} /></MemoryRouter>);
    expect(svg).toHaveAttribute("viewBox", before);
  });

  it("窄屏关系列表消费 edges，明确类型和相邻节点并保留打开链接", () => {
    renderConnectedMap();
    const relations = screen.getByTestId("global-map-relations");
    expect(relations).toHaveTextContent("父子生长：节点 A → 节点 B");
    expect(within(relations).getByRole("link", { name: "父子生长：节点 A 指向 节点 B" })).toHaveAttribute("href", "/nodes/b");
  });

  it("同一节点对只画一条连接，并以任一已连通事实决定连接状态", () => {
    const observation = makeGraphObservation({
      nodes: [
        { ...makeGraphObservationNode("a", "节点 A"), connectivity: "focus" as const },
        { ...makeGraphObservationNode("b", "节点 B"), connectivity: "connected" as const },
      ],
      edges: [
        { edge: { ...makeEdge("parent-child", "a", "b"), kind: "parent-child" as const }, connectivity: "unconnected" as const },
        { edge: { ...makeEdge("fused-from", "a", "b"), kind: "fused-from" as const }, connectivity: "connected" as const },
      ],
    });
    render(<MemoryRouter><GlobalResearchMap observation={{ ...observation, focusNodeId: "a" }} /></MemoryRouter>);
    const canvas = screen.getByTestId("global-map-canvas");
    const connection = canvas.querySelector("[data-connection-id] path.global-map__edge");

    expect(canvas.querySelectorAll("[data-connection-id]")).toHaveLength(1);
    expect(connection).toHaveClass("global-map__edge--connected", "global-map__edge--fused-from");
    expect(connection).toHaveAttribute("data-edge-kind", expect.stringContaining("parent-child"));
    expect(connection).toHaveAttribute("data-edge-kind", expect.stringContaining("fused-from"));
    expect(canvas.querySelectorAll(".global-map__edge-direction-flow")).toHaveLength(1);
  });

  it("同一节点对的相反方向事实保留可访问语义，但不伪造单向流动", () => {
    const observation = makeGraphObservation({
      nodes: [
        { ...makeGraphObservationNode("a", "节点 A"), connectivity: "focus" as const },
        { ...makeGraphObservationNode("b", "节点 B"), connectivity: "connected" as const },
      ],
      edges: [
        { edge: { ...makeEdge("parent-child", "a", "b"), kind: "parent-child" as const }, connectivity: "connected" as const },
        { edge: { ...makeEdge("fused-from", "b", "a"), kind: "fused-from" as const }, connectivity: "connected" as const },
      ],
    });
    render(<MemoryRouter><GlobalResearchMap observation={{ ...observation, focusNodeId: "a" }} /></MemoryRouter>);
    const canvas = screen.getByTestId("global-map-canvas");
    const connection = within(canvas).getByRole("img", { name: /父子生长：节点 A 指向 节点 B/ });

    expect(connection).toHaveAccessibleName(expect.stringContaining("融合来源：节点 B 指向 节点 A"));
    expect(canvas.querySelectorAll(".global-map__edge-direction-flow")).toHaveLength(0);
    expect(canvas.querySelectorAll(".global-map__edge-direction-static")).toHaveLength(0);
  });
  it("hover only emphasizes the direct neighborhood without moving nodes", () => {
    renderConnectedMap();
    const canvas = screen.getByTestId("global-map-canvas");
    const first = canvasNode(canvas, "节点 A");
    const second = canvasNode(canvas, "节点 B");
    const unrelated = canvasNode(canvas, "节点 C");
    const before = [first, second, unrelated].map((node) => node.getAttribute("transform"));

    fireEvent.pointerEnter(first);
    expect(first).toHaveClass("global-map__node--emphasized");
    expect(second).toHaveClass("global-map__node--neighbor");
    expect(unrelated).toHaveClass("global-map__node--muted");
    expect(canvas.querySelector(".global-map__edge--emphasized")).not.toBeNull();
    expect([first, second, unrelated].map((node) => node.getAttribute("transform"))).toEqual(before);

    fireEvent.pointerLeave(first);
    expect(unrelated).not.toHaveClass("global-map__node--muted");
  });

  it("single click requests a server focus while coordinates and zoom remain controlled locally", async () => {
    const { observation, onFocusNode, rendered } = renderConnectedMap();
    const serializedBefore = JSON.stringify(observation);
    const canvas = screen.getByTestId("global-map-canvas");
    const first = canvasNode(canvas, "节点 A");
    const transformBefore = first.getAttribute("transform");
    const svg = within(canvas).getByRole("group", { name: "跨会话研究关系画布" });
    const viewBoxBefore = svg.getAttribute("viewBox");

    fireEvent.click(first);
    expect(onFocusNode).toHaveBeenCalledWith("a");
    expect(first).not.toHaveClass("global-map__node--selected");
    expect(first).toHaveAttribute("transform", transformBefore);
    const focusedObservation = {
      ...observation,
      focusNodeId: "a",
      nodes: observation.nodes.map((summary) => ({
        ...summary,
        connectivity: summary.node.id === "a" ? "focus" as const : summary.node.id === "b" ? "connected" as const : "unconnected" as const,
      })),
      edges: observation.edges.map((summary) => ({ ...summary, connectivity: "connected" as const })),
    };
    rendered.rerender(<MemoryRouter><GlobalResearchMap observation={focusedObservation} onFocusNode={onFocusNode} /></MemoryRouter>);
    expect(canvasNode(canvas, "节点 A")).toHaveClass("global-map__node--selected");
    expect(svg).toHaveAttribute("viewBox", viewBoxBefore);
    fireEvent.click(within(canvas).getByRole("button", { name: "放大地图" }));
    expect(svg.getAttribute("viewBox")).not.toBe(viewBoxBefore);
    expect(first).toHaveAttribute("transform", transformBefore);
    expect(JSON.stringify(observation)).toBe(serializedBefore);
  });

  it("搜索结果 reveal 会把目标移到视口中央，并在画布与列表态聚焦可见节点", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    const observation = makeGraphObservation({ nodes: [makeGraphObservationNode("a", "节点 A"), makeGraphObservationNode("b", "节点 B")] });
    const initialScene = serializeMapScene({
      filters: DEFAULT_RESEARCH_MAP_FILTER_STATE,
      relationshipKinds: ["parent-child", "fused-from"],
      viewBox: { x: 0, y: 0, width: 480, height: 270 },
      layout: { world: { width: 960, height: 540 }, positions: new Map([["a", { x: 100, y: 100 }], ["b", { x: 800, y: 400 }]]), edgeKeys: new Map() },
    });
    const rendered = render(
      <MemoryRouter>
        <GlobalResearchMap observation={observation} initialScene={initialScene} presentation="canvas" revealNodeId="b" revealRequestId={1} />
      </MemoryRouter>,
    );

    const canvas = screen.getByTestId("global-map-canvas");
    const svg = within(canvas).getByRole("group", { name: "跨会话研究关系画布" });
    await waitFor(() => expect(svg).toHaveAttribute("viewBox", "560 265 480 270"));
    await waitFor(() => expect(document.activeElement).toBe(canvasNode(canvas, "节点 B")));

    fireEvent.wheel(svg, { clientX: 0, clientY: 0, deltaY: -1 });
    await waitFor(() => expect(svg).not.toHaveAttribute("viewBox", "560 265 480 270"));
    rendered.rerender(
      <MemoryRouter>
        <GlobalResearchMap observation={observation} initialScene={initialScene} presentation="list" revealNodeId="b" revealRequestId={2} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      const [x, y, width, height] = (svg.getAttribute("viewBox") ?? "").split(" ").map(Number);
      expect(x + width / 2).toBeCloseTo(800);
      expect(y + height / 2).toBeCloseTo(400);
    });
    const list = screen.getByTestId("global-map-list");
    await waitFor(() => expect(document.activeElement).toBe(within(list).getByLabelText(/^节点 B，/)));
    vi.unstubAllGlobals();
  });

  it("非 reduced-motion 下专注聚拢逐帧更新时，搜索定位仍会完成并消费请求", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const frames = installControlledAnimationFrames();
    const nodes = [makeGraphObservationNode("a", "节点 A"), makeGraphObservationNode("b", "节点 B")];
    const observation = {
      ...makeGraphObservation({
        nodes,
        edges: [{ edge: { ...makeEdge("parent-child", "a", "b"), kind: "parent-child" as const }, connectivity: "connected" as const }],
      }),
      focusNodeId: "a",
    };
    const initialScene = serializeMapScene({
      filters: DEFAULT_RESEARCH_MAP_FILTER_STATE,
      relationshipKinds: ["parent-child", "fused-from"],
      viewBox: { x: 0, y: 0, width: 480, height: 270 },
      layout: { world: { width: 960, height: 540 }, positions: new Map([["a", { x: 300, y: 270 }], ["b", { x: 760, y: 270 }]]), edgeKeys: new Map() },
    });
    const onRevealHandled = vi.fn();
    render(
      <MemoryRouter>
        <GlobalResearchMap observation={observation} initialScene={initialScene} revealNodeId="b" revealRequestId={9} onRevealHandled={onRevealHandled} />
      </MemoryRouter>,
    );

    const startedAt = performance.now();
    frames.flush(startedAt + 16);
    expect(onRevealHandled).not.toHaveBeenCalled();
    frames.flush(startedAt + 400);

    await waitFor(() => expect(onRevealHandled).toHaveBeenCalledWith("b", 9));
    expect(document.activeElement).toBe(canvasNode(screen.getByTestId("global-map-canvas"), "节点 B"));
    vi.unstubAllGlobals();
  });

  it("搜索定位动画中切换相同节点集的 history scene，会消费旧请求且不覆盖目标视口", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const frames = installControlledAnimationFrames();
    const observation = makeGraphObservation({ nodes: [makeGraphObservationNode("a", "节点 A"), makeGraphObservationNode("b", "节点 B")] });
    const makeScene = (viewBox: { x: number; y: number; width: number; height: number }) => serializeMapScene({
      filters: DEFAULT_RESEARCH_MAP_FILTER_STATE,
      relationshipKinds: ["parent-child", "fused-from"],
      viewBox,
      layout: { world: { width: 960, height: 540 }, positions: new Map([["a", { x: 100, y: 100 }], ["b", { x: 800, y: 400 }]]), edgeKeys: new Map() },
    });
    const sceneA = makeScene({ x: 0, y: 0, width: 480, height: 270 });
    const sceneB = makeScene({ x: 20, y: 30, width: 480, height: 270 });
    const onRevealHandled = vi.fn();
    const rendered = render(
      <MemoryRouter>
        <GlobalResearchMap observation={observation} initialScene={sceneA} sceneKey="entry-a" revealNodeId="b" revealRequestId={10} onRevealHandled={onRevealHandled} />
      </MemoryRouter>,
    );
    const svg = within(screen.getByTestId("global-map-canvas")).getByRole("group", { name: "跨会话研究关系画布" });
    const startedAt = performance.now();
    frames.flush(startedAt + 16);

    rendered.rerender(
      <MemoryRouter>
        <GlobalResearchMap observation={observation} initialScene={sceneB} sceneKey="entry-b" revealNodeId="b" revealRequestId={10} onRevealHandled={onRevealHandled} />
      </MemoryRouter>,
    );
    frames.flush(startedAt + 500);

    expect(onRevealHandled).toHaveBeenCalledTimes(1);
    expect(onRevealHandled).toHaveBeenCalledWith("b", 10);
    expect(svg).toHaveAttribute("viewBox", "20 30 480 270");
    vi.unstubAllGlobals();
  });

  it("离开地图时消费尚未完成的 reveal 请求，返回旧现场不会重放居中", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    const observation = makeGraphObservation({ nodes: [makeGraphObservationNode("a", "节点 A"), makeGraphObservationNode("b", "节点 B")] });
    const initialScene = serializeMapScene({
      filters: DEFAULT_RESEARCH_MAP_FILTER_STATE,
      relationshipKinds: ["parent-child", "fused-from"],
      viewBox: { x: 0, y: 0, width: 480, height: 270 },
      layout: { world: { width: 960, height: 540 }, positions: new Map([["a", { x: 100, y: 100 }], ["b", { x: 800, y: 400 }]]), edgeKeys: new Map() },
    });
    const onRevealHandled = vi.fn();
    const rendered = render(
      <MemoryRouter>
        <GlobalResearchMap observation={observation} initialScene={initialScene} revealNodeId="b" revealRequestId={7} onRevealHandled={onRevealHandled} />
      </MemoryRouter>,
    );

    const canvas = screen.getByTestId("global-map-canvas");
    const svg = within(canvas).getByRole("group", { name: "跨会话研究关系画布" });
    await waitFor(() => expect(svg).toHaveAttribute("viewBox", "560 265 480 270"));

    rendered.unmount();
    expect(onRevealHandled).toHaveBeenCalledTimes(1);
    expect(onRevealHandled).toHaveBeenCalledWith("b", 7);
    vi.unstubAllGlobals();
  });
});

describe("GlobalResearchMap ADR-0042 活体物理交互", () => {
  function stubReducedMotion() {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  }

  function nodeLayout(canvas: HTMLElement, nodeId: string): { x: number; y: number } {
    const element = canvas.querySelector(`[data-node-id="${nodeId}"]`);
    if (!element) throw new Error(`missing node ${nodeId}`);
    return { x: Number(element.getAttribute("data-layout-x")), y: Number(element.getAttribute("data-layout-y")) };
  }

  it("专注时直接关系节点自然聚拢且不形成机械等距环，预览位不写入持久现场；退出专注复原", () => {
    stubReducedMotion();
    const nodes = [
      makeGraphObservationNode("a", "节点 A"),
      makeGraphObservationNode("b", "节点 B"),
      makeGraphObservationNode("c", "节点 C"),
    ];
    const edges = [
      { edge: { ...makeEdge("parent-child", "a", "b"), kind: "parent-child" as const }, connectivity: "default" as const },
      { edge: { ...makeEdge("fused-from", "a", "c"), kind: "fused-from" as const }, connectivity: "default" as const },
    ];
    const plain = makeGraphObservation({ nodes, edges });
    const onSceneChange = vi.fn();
    const rendered = render(
      <MemoryRouter>
        <GlobalResearchMap observation={plain} onSceneChange={onSceneChange} />
      </MemoryRouter>,
    );
    const canvas = screen.getByTestId("global-map-canvas");
    const baseB = nodeLayout(canvas, "b");
    const baseC = nodeLayout(canvas, "c");
    const baseA = nodeLayout(canvas, "a");

    rendered.rerender(
      <MemoryRouter>
        <GlobalResearchMap observation={{ ...makeGraphObservation({ nodes, edges }), focusNodeId: "a" }} onSceneChange={onSceneChange} />
      </MemoryRouter>,
    );
    const gatheredB = nodeLayout(canvas, "b");
    const gatheredC = nodeLayout(canvas, "c");
    const focusPoint = nodeLayout(canvas, "a");
    const radiusB = Math.hypot(gatheredB.x - focusPoint.x, gatheredB.y - focusPoint.y);
    const radiusC = Math.hypot(gatheredC.x - focusPoint.x, gatheredC.y - focusPoint.y);
    expect(radiusB).toBeLessThanOrEqual(171);
    expect(radiusC).toBeLessThanOrEqual(171);
    const gap = Math.hypot(gatheredB.x - gatheredC.x, gatheredB.y - gatheredC.y);
    expect(gap).toBeGreaterThanOrEqual(51);
    expect(Math.abs(radiusB - radiusC)).toBeGreaterThan(0.1);

    const persisted = onSceneChange.mock.calls.at(-1)![0];
    const persistedB = [...persisted.layout.positions].find(([id]) => id === "b");
    expect(persistedB).toEqual(["b", baseB.x, baseB.y]);

    rendered.rerender(
      <MemoryRouter>
        <GlobalResearchMap observation={makeGraphObservation({ nodes, edges })} onSceneChange={onSceneChange} />
      </MemoryRouter>,
    );
    expect(nodeLayout(canvas, "b")).toEqual(baseB);
    expect(nodeLayout(canvas, "c")).toEqual(baseC);
    expect(nodeLayout(canvas, "a")).toEqual(baseA);
    vi.unstubAllGlobals();
  });

  it("专注聚拢后拖动只把真实手势位移叠加到持久坐标，不把编排偏移写入现场", async () => {
    stubReducedMotion();
    const nodes = [makeGraphObservationNode("a", "节点 A"), makeGraphObservationNode("b", "节点 B")];
    const edges = [{ edge: { ...makeEdge("parent-child", "a", "b"), kind: "parent-child" as const }, connectivity: "default" as const }];
    const plain = makeGraphObservation({ nodes, edges });
    const focused = { ...plain, focusNodeId: "a" };
    const initialScene = serializeMapScene({
      filters: DEFAULT_RESEARCH_MAP_FILTER_STATE,
      relationshipKinds: ["parent-child", "fused-from"],
      viewBox: { x: 0, y: 0, width: 960, height: 540 },
      layout: {
        world: { width: 960, height: 540 },
        positions: new Map([["a", { x: 100, y: 270 }], ["b", { x: 420, y: 270 }]]),
        edgeKeys: new Map(),
      },
    });
    const onSceneChange = vi.fn();
    const rendered = render(
      <MemoryRouter><GlobalResearchMap observation={focused} initialScene={initialScene} onSceneChange={onSceneChange} /></MemoryRouter>,
    );
    const canvas = screen.getByTestId("global-map-canvas");
    const svg = canvas.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 960, height: 540, top: 0, left: 0, right: 960, bottom: 540, toJSON: () => ({}) } as DOMRect);
    const gatheredB = nodeLayout(canvas, "b");
    const baseScene = onSceneChange.mock.calls.at(-1)![0];
    const basePersistedB = [...baseScene.layout.positions].find(([id]) => id === "b")!;
    expect(Math.abs(gatheredB.x - basePersistedB[1])).toBeGreaterThan(10);
    const nodeB = canvasNode(canvas, "节点 B");
    const pointer = (type: string, x: number, y: number) => nodeB.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
    pointer("pointerdown", gatheredB.x, gatheredB.y);
    pointer("pointermove", gatheredB.x + 24, gatheredB.y);
    pointer("pointerup", gatheredB.x + 24, gatheredB.y);

    await waitFor(() => expect(canvas).toHaveAttribute("data-node-physics", "idle"));
    const expectedPersistedX = basePersistedB[1] + 24;
    let persistedB: [string, number, number] | undefined;
    await waitFor(() => {
      const scene = onSceneChange.mock.calls.at(-1)![0];
      persistedB = [...scene.layout.positions].find(([id]) => id === "b");
      expect(persistedB![1]).toBeCloseTo(expectedPersistedX, 0);
    });
    expect(Math.abs(persistedB![1] - gatheredB.x)).toBeGreaterThan(10);

    rendered.rerender(
      <MemoryRouter><GlobalResearchMap observation={plain} initialScene={initialScene} onSceneChange={onSceneChange} /></MemoryRouter>,
    );
    expect(nodeLayout(canvas, "b").x).toBeCloseTo(persistedB![1], 0);
    vi.unstubAllGlobals();
  });

  it("拖动节点带动邻域并在松手后持久化，位置随 Map Scene 保存", async () => {
    stubReducedMotion();
    const observation = makeGraphObservation({
      nodes: [makeGraphObservationNode("a", "节点 A"), makeGraphObservationNode("b", "节点 B")],
      edges: [{ edge: { ...makeEdge("parent-child", "a", "b"), kind: "parent-child" as const }, connectivity: "default" as const }],
    });
    const onSceneChange = vi.fn();
    const onFocusNode = vi.fn();
    render(
      <MemoryRouter>
        <GlobalResearchMap observation={observation} onSceneChange={onSceneChange} onFocusNode={onFocusNode} />
      </MemoryRouter>,
    );
    const canvas = screen.getByTestId("global-map-canvas");
    const svg = canvas.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 960, height: 540, top: 0, left: 0, right: 960, bottom: 540, toJSON: () => ({}) } as DOMRect);
    const nodeB = canvasNode(canvas, "节点 B");
    const before = nodeLayout(canvas, "b");
    const neighborBefore = nodeLayout(canvas, "a");
    const startX = before.x + 8;
    const startY = before.y + 4;
    const pointer = (type: string, x: number, y: number) => nodeB.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));

    pointer("pointerdown", startX, startY);
    pointer("pointermove", startX + 40, startY);
    pointer("pointerup", startX + 40, startY);

    let after = before;
    await waitFor(() => {
      after = nodeLayout(canvas, "b");
      expect(after.x - before.x).toBeCloseTo(40, 0);
    });
    expect(after.y - before.y).toBeCloseTo(0, 0);
    const neighborAfter = nodeLayout(canvas, "a");
    expect(neighborAfter.x).toBeGreaterThan(neighborBefore.x);

    await waitFor(() => {
      const persisted = onSceneChange.mock.calls.at(-1)![0];
      const persistedB = [...persisted.layout.positions].find(([id]) => id === "b");
      const persistedA = [...persisted.layout.positions].find(([id]) => id === "a");
      expect(persistedB![1]).toBeCloseTo(after.x, 0);
      expect(persistedA![1]).toBeCloseTo(neighborAfter.x, 0);
    });

    fireEvent.click(nodeB);
    expect(onFocusNode).not.toHaveBeenCalled();
    fireEvent.click(nodeB);
    expect(onFocusNode).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("指针和键盘物理都忽略现场中不可见节点，同时无关系可见近邻会持久化但不产生连线", async () => {
    stubReducedMotion();
    const observation = makeGraphObservation({
      nodes: [makeGraphObservationNode("a", "节点 A"), makeGraphObservationNode("b", "节点 B")],
    });
    const initialScene = serializeMapScene({
      filters: DEFAULT_RESEARCH_MAP_FILTER_STATE,
      relationshipKinds: ["parent-child", "fused-from"],
      viewBox: { x: 0, y: 0, width: 960, height: 540 },
      layout: {
        world: { width: 960, height: 540 },
        positions: new Map([["a", { x: 100, y: 120 }], ["b", { x: 150, y: 120 }], ["hidden", { x: 170, y: 120 }]]),
        edgeKeys: new Map(),
      },
    });
    const visibleScene = serializeMapScene({
      filters: DEFAULT_RESEARCH_MAP_FILTER_STATE,
      relationshipKinds: ["parent-child", "fused-from"],
      viewBox: { x: 0, y: 0, width: 960, height: 540 },
      layout: {
        world: { width: 960, height: 540 },
        positions: new Map([["a", { x: 100, y: 120 }], ["b", { x: 150, y: 120 }]]),
        edgeKeys: new Map(),
      },
    });
    const onSceneChange = vi.fn();
    const rendered = render(
      <MemoryRouter>
        <GlobalResearchMap observation={observation} initialScene={visibleScene} sceneKey="entry-visible" preserveExistingLayout onSceneChange={onSceneChange} />
      </MemoryRouter>,
    );
    rendered.rerender(
      <MemoryRouter>
        <GlobalResearchMap observation={observation} initialScene={initialScene} sceneKey="entry-with-hidden" preserveExistingLayout onSceneChange={onSceneChange} />
      </MemoryRouter>,
    );
    const canvas = screen.getByTestId("global-map-canvas");
    const svg = canvas.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 960, height: 540, top: 0, left: 0, right: 960, bottom: 540, toJSON: () => ({}) } as DOMRect);
    const nodeA = canvasNode(canvas, "节点 A");
    await waitFor(() => {
      const scene = onSceneChange.mock.calls.at(-1)![0];
      expect([...scene.layout.positions].find(([id]) => id === "hidden")).toEqual(["hidden", 170, 120]);
    });
    const beforeB = nodeLayout(canvas, "b");
    const pointer = (type: string, x: number, y: number) => nodeA.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));

    pointer("pointerdown", 100, 120);
    pointer("pointermove", 128, 120);
    pointer("pointerup", 128, 120);

    await waitFor(() => expect(nodeLayout(canvas, "b").x).toBeGreaterThan(beforeB.x));
    expect(canvas.querySelectorAll("path.global-map__edge")).toHaveLength(0);
    await waitFor(() => {
      const persisted = onSceneChange.mock.calls.at(-1)![0];
      const persistedB = [...persisted.layout.positions].find(([id]) => id === "b");
      expect(persistedB![1]).toBeGreaterThan(beforeB.x);
      expect([...persisted.layout.positions].find(([id]) => id === "hidden")).toEqual(["hidden", 170, 120]);
    });
    fireEvent.keyDown(nodeA, { key: "ArrowRight", shiftKey: true });
    const afterKeyboard = onSceneChange.mock.calls.at(-1)![0];
    expect([...afterKeyboard.layout.positions].find(([id]) => id === "hidden")).toEqual(["hidden", 170, 120]);
    vi.unstubAllGlobals();
  });

  it("沉浸式窄屏在同一地图实例中切换画布和列表", () => {
    const observation = makeGraphObservation({ nodes: [makeGraphObservationNode("a", "节点 A")] });
    const rendered = render(<MemoryRouter><GlobalResearchMap observation={observation} immersive presentation="canvas" /></MemoryRouter>);
    const region = screen.getByRole("region", { name: "全部研究节点" });
    expect(region).toHaveClass("global-map--immersive", "global-map--presentation-canvas");

    rendered.rerender(<MemoryRouter><GlobalResearchMap observation={observation} immersive presentation="list" /></MemoryRouter>);
    expect(region).toHaveClass("global-map--presentation-list");
    expect(screen.getByTestId("global-map-canvas")).toBeInTheDocument();
    expect(screen.getByTestId("global-map-list")).toBeInTheDocument();
  });

  it("切换 history scene 时目标现场已有的节点不重播入场动画", async () => {
    const nodeA = makeGraphObservationNode("a", "节点 A");
    const nodeB = makeGraphObservationNode("b", "节点 B");
    const makeScene = (positions: ReadonlyArray<readonly [string, { x: number; y: number }]>) => serializeMapScene({
      filters: DEFAULT_RESEARCH_MAP_FILTER_STATE,
      relationshipKinds: ["parent-child", "fused-from"],
      viewBox: { x: 0, y: 0, width: 960, height: 540 },
      layout: { world: { width: 960, height: 540 }, positions: new Map(positions), edgeKeys: new Map() },
    });
    const sceneA = makeScene([]);
    const sceneAB = makeScene([["a", { x: 100, y: 120 }], ["b", { x: 180, y: 120 }]]);
    const rendered = render(
      <MemoryRouter><GlobalResearchMap observation={makeGraphObservation()} initialScene={sceneA} sceneKey="entry-empty" /></MemoryRouter>,
    );
    const canvas = screen.getByTestId("global-map-canvas");
    expect(canvas).toHaveAttribute("data-entry-animation", "complete");

    rendered.rerender(
      <MemoryRouter><GlobalResearchMap observation={makeGraphObservation({ nodes: [nodeA, nodeB] })} initialScene={sceneAB} sceneKey="entry-ab" /></MemoryRouter>,
    );
    expect(canvas).toHaveAttribute("data-entry-animation", "complete");
    expect(nodeLayout(canvas, "b")).toEqual({ x: 180, y: 120 });
  });

  it("节点仍在松手回弹时切换 history scene，会原子取消旧现场而不提交旧位移", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const frames = installControlledAnimationFrames();
    const observation = makeGraphObservation({ nodes: [makeGraphObservationNode("a", "节点 A")] });
    const makeScene = (x: number) => serializeMapScene({
      filters: DEFAULT_RESEARCH_MAP_FILTER_STATE,
      relationshipKinds: ["parent-child", "fused-from"],
      viewBox: { x: 0, y: 0, width: 960, height: 540 },
      layout: { world: { width: 960, height: 540 }, positions: new Map([["a", { x, y: 120 }]]), edgeKeys: new Map() },
    });
    const sceneA = makeScene(100);
    const sceneB = makeScene(500);
    const onSceneChange = vi.fn();
    const rendered = render(
      <MemoryRouter>
        <GlobalResearchMap observation={observation} initialScene={sceneA} sceneKey="entry-a" preserveExistingLayout onSceneChange={onSceneChange} />
      </MemoryRouter>,
    );
    const canvas = screen.getByTestId("global-map-canvas");
    const svg = canvas.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 960, height: 540, top: 0, left: 0, right: 960, bottom: 540, toJSON: () => ({}) } as DOMRect);
    frames.flush(performance.now() + 400);
    const nodeA = canvasNode(canvas, "节点 A");
    const pointer = (type: string, x: number) => nodeA.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 120 }));
    pointer("pointerdown", 100);
    pointer("pointermove", 180);
    pointer("pointerup", 180);
    expect(frames.pending()).toBeGreaterThan(0);

    onSceneChange.mockClear();
    rendered.rerender(
      <MemoryRouter>
        <GlobalResearchMap observation={observation} initialScene={sceneB} sceneKey="entry-b" preserveExistingLayout onSceneChange={onSceneChange} />
      </MemoryRouter>,
    );
    frames.flush(performance.now() + 1_000);

    await waitFor(() => expect(nodeLayout(canvas, "a")).toEqual({ x: 500, y: 120 }));
    await waitFor(() => {
      const persisted = onSceneChange.mock.calls.at(-1)![0];
      expect([...persisted.layout.positions].find(([id]) => id === "a")).toEqual(["a", 500, 120]);
    });
    expect(canvas).toHaveAttribute("data-node-physics", "idle");
    vi.unstubAllGlobals();
  });

  it("离开地图会取消专注聚拢与节点拖动帧，不在卸载后继续调度", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const frames = installControlledAnimationFrames();
    const nodes = [makeGraphObservationNode("a", "节点 A"), makeGraphObservationNode("b", "节点 B")];
    const edges = [{ edge: { ...makeEdge("parent-child", "a", "b"), kind: "parent-child" as const }, connectivity: "connected" as const }];
    const focused = { ...makeGraphObservation({ nodes, edges }), focusNodeId: "a" };
    const focusedRender = render(<MemoryRouter><GlobalResearchMap observation={focused} /></MemoryRouter>);
    expect(frames.pending()).toBeGreaterThan(0);
    focusedRender.unmount();
    expect(frames.pending()).toBe(0);

    const plainRender = render(<MemoryRouter><GlobalResearchMap observation={makeGraphObservation({ nodes })} /></MemoryRouter>);
    frames.flush(performance.now() + 400);
    const canvas = screen.getByTestId("global-map-canvas");
    const svg = canvas.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 960, height: 540, top: 0, left: 0, right: 960, bottom: 540, toJSON: () => ({}) } as DOMRect);
    const nodeA = canvasNode(canvas, "节点 A");
    nodeA.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: nodeLayout(canvas, "a").x, clientY: nodeLayout(canvas, "a").y }));
    expect(frames.pending()).toBeGreaterThan(0);
    plainRender.unmount();
    expect(frames.pending()).toBe(0);
    frames.flush(performance.now() + 800);
    expect(frames.pending()).toBe(0);
    vi.unstubAllGlobals();
  });

  it("reduced-motion 下入场同步完成并暴露稳定标记", () => {
    stubReducedMotion();
    render(
      <MemoryRouter>
        <GlobalResearchMap observation={makeGraphObservation({ nodes: [makeGraphObservationNode("a", "节点 A")] })} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("global-map-canvas")).toHaveAttribute("data-entry-animation", "complete");
    vi.unstubAllGlobals();
  });

  it("Esc 取消本次拖动，持久位置保持不变", () => {
    stubReducedMotion();
    const observation = makeGraphObservation({
      nodes: [makeGraphObservationNode("a", "节点 A"), makeGraphObservationNode("b", "节点 B")],
      edges: [{ edge: { ...makeEdge("parent-child", "a", "b"), kind: "parent-child" as const }, connectivity: "default" as const }],
    });
    const onSceneChange = vi.fn();
    render(
      <MemoryRouter>
        <GlobalResearchMap observation={observation} onSceneChange={onSceneChange} />
      </MemoryRouter>,
    );
    const canvas = screen.getByTestId("global-map-canvas");
    const svg = canvas.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 960, height: 540, top: 0, left: 0, right: 960, bottom: 540, toJSON: () => ({}) } as DOMRect);
    const nodeB = canvasNode(canvas, "节点 B");
    const before = nodeLayout(canvas, "b");

    const pointer = (type: string, x: number, y: number) => nodeB.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
    pointer("pointerdown", before.x + 5, before.y + 5);
    pointer("pointermove", before.x + 60, before.y + 5);
    fireEvent.keyDown(window, { key: "Escape" });

    expect(nodeLayout(canvas, "b")).toEqual(before);
    const persisted = onSceneChange.mock.calls.at(-1)![0];
    const persistedB = [...persisted.layout.positions].find(([id]) => id === "b");
    expect(persistedB).toEqual(["b", before.x, before.y]);
    vi.unstubAllGlobals();
  });

  it("Shift+方向键微调焦点节点位置并带动邻域，普通方向键仍是焦点导航", () => {
    stubReducedMotion();
    const observation = makeGraphObservation({
      nodes: [makeGraphObservationNode("a", "节点 A"), makeGraphObservationNode("b", "节点 B")],
      edges: [{ edge: { ...makeEdge("parent-child", "a", "b"), kind: "parent-child" as const }, connectivity: "default" as const }],
    });
    const onSceneChange = vi.fn();
    render(
      <MemoryRouter>
        <GlobalResearchMap observation={observation} onSceneChange={onSceneChange} />
      </MemoryRouter>,
    );
    const canvas = screen.getByTestId("global-map-canvas");
    const nodeB = canvasNode(canvas, "节点 B");
    const beforeB = nodeLayout(canvas, "b");
    const beforeA = nodeLayout(canvas, "a");

    fireEvent.keyDown(nodeB, { key: "ArrowRight", shiftKey: true });
    const afterB = nodeLayout(canvas, "b");
    const afterA = nodeLayout(canvas, "a");
    expect(afterB.x - beforeB.x).toBeCloseTo(12, 0);
    expect(afterA.x - beforeA.x).toBeGreaterThan(2);
    expect(afterA.x - beforeA.x).toBeLessThanOrEqual(12);

    nodeB.focus();
    fireEvent.keyDown(nodeB, { key: "ArrowRight" });
    expect(nodeLayout(canvas, "b")).toEqual(afterB);
    vi.unstubAllGlobals();
  });
});
