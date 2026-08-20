import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { makeEdge, makeGraphObservation, makeGraphObservationNode } from "../../test/fakes";
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

describe("GlobalResearchMap stable organic canvas", () => {
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
    expect(canvas.querySelectorAll("line.global-map__edge")).toHaveLength(1);
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
    const connection = canvas.querySelector("[data-connection-id] line.global-map__edge");

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

  it("只有搜索结果 reveal 会把目标移到视口中央并转移键盘焦点", async () => {
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
        <GlobalResearchMap observation={observation} initialScene={initialScene} revealNodeId="b" revealRequestId={1} />
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
        <GlobalResearchMap observation={observation} initialScene={initialScene} revealNodeId="b" revealRequestId={2} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      const [x, y, width, height] = (svg.getAttribute("viewBox") ?? "").split(" ").map(Number);
      expect(x + width / 2).toBeCloseTo(800);
      expect(y + height / 2).toBeCloseTo(400);
    });
    vi.unstubAllGlobals();
  });
});
