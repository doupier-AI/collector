import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { makeEdge, makeGraphObservation, makeGraphObservationNode } from "../../test/fakes";
import { GlobalResearchMap } from "./GlobalResearchMap";

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

function renderConnectedMap() {
  const observation = makeGraphObservation({
    nodes: [
      makeGraphObservationNode("a", "节点 A"),
      makeGraphObservationNode("b", "节点 B"),
      makeGraphObservationNode("c", "节点 C"),
    ],
    edges: [{ edge: { ...makeEdge("parent-child", "a", "b"), kind: "parent-child" as const }, connectivity: "default" }],
  });
  render(
    <MemoryRouter>
      <GlobalResearchMap observation={observation} />
    </MemoryRouter>,
  );
  return observation;
}

describe("GlobalResearchMap keyboard navigation", () => {
  it("wide canvas moves focus only among SVG nodes", async () => {
    renderMap();
    const canvas = screen.getByTestId("global-map-canvas");
    const first = within(canvas).getByLabelText(/节点 A/);
    const second = within(canvas).getByLabelText(/节点 B/);
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
});

describe("GlobalResearchMap stable organic canvas", () => {
  it("用独立形状、归档文字、项目名和焦点环解码地图状态", () => {
    const observation = makeGraphObservation({
      nodes: [
        makeGraphObservationNode("regular", "普通节点", { projectName: "琥珀项目", projectColorRole: "amber" }),
        makeGraphObservationNode("fusion", "融合节点", {
          projectName: "紫色项目",
          projectColorRole: "violet",
          role: "fusion",
          lifecycle: "archived",
          fusionEvidenceHealth: "available",
          node: { ...makeGraphObservationNode("fusion-base", "融合基础").node, id: "fusion", isFusionNode: true },
        }),
        makeGraphObservationNode("uncategorized", "未分类节点"),
      ],
    });
    render(<MemoryRouter><GlobalResearchMap observation={observation} /></MemoryRouter>);
    const canvas = screen.getByTestId("global-map-canvas");
    const regular = within(canvas).getByLabelText(/普通节点，琥珀项目，研究节点，活跃/);
    const fusion = within(canvas).getByLabelText(/融合节点，紫色项目，融合成果，已归档/);
    const uncategorized = within(canvas).getByLabelText(/未分类节点，未分类，研究节点，活跃/);

    expect(regular).toHaveClass("global-map__node--project-amber", "global-map__node--research");
    expect(fusion).toHaveClass("global-map__node--project-violet", "global-map__node--fusion", "global-map__node--archived");
    expect(fusion).toHaveTextContent("紫色项目 · 融合成果 · 已归档");
    expect(uncategorized.getAttribute("class")).not.toContain("global-map__node--project-");
    fusion.focus();
    fireEvent.click(fusion);
    expect(fusion).toHaveClass("global-map__node--selected");
    expect(fusion.querySelector(".global-map__node-selection-halo")).not.toBeNull();
    expect(fusion.querySelector(".global-map__node-focus-ring")).not.toBeNull();

    const narrowList = screen.getByTestId("global-map-list");
    const fusionLink = within(narrowList).getByLabelText(/融合节点，紫色项目，融合成果，已归档/);
    expect(fusionLink).toHaveTextContent("紫色项目 · 融合节点 · 融合成果 · 已归档");
    expect(fusionLink.querySelector(".global-map__list-dot")).toHaveClass(
      "global-map__list-dot--project-violet",
      "global-map__list-dot--fusion",
      "global-map__list-dot--archived",
    );
  });

  it("observation 增加孤立节点时既有 SVG 坐标不变，并让 viewBox 消费扩展世界", () => {
    const base = makeGraphObservation({ nodes: [makeGraphObservationNode("a", "节点 A"), makeGraphObservationNode("b", "节点 B")] });
    const rendered = render(<MemoryRouter><GlobalResearchMap observation={base} /></MemoryRouter>);
    const canvas = screen.getByTestId("global-map-canvas");
    const before = within(canvas).getByLabelText(/节点 A/).getAttribute("transform");
    rendered.rerender(<MemoryRouter><GlobalResearchMap observation={makeGraphObservation({ nodes: [...base.nodes, makeGraphObservationNode("c", "节点 C")] })} /></MemoryRouter>);
    expect(within(canvas).getByLabelText(/节点 A/)).toHaveAttribute("transform", before);
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
  it("hover only emphasizes the direct neighborhood without moving nodes", () => {
    renderConnectedMap();
    const canvas = screen.getByTestId("global-map-canvas");
    const first = within(canvas).getByLabelText(/节点 A/);
    const second = within(canvas).getByLabelText(/节点 B/);
    const unrelated = within(canvas).getByLabelText(/节点 C/);
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

  it("single click selects in place and zoom controls only change the viewport", async () => {
    const observation = renderConnectedMap();
    const serializedBefore = JSON.stringify(observation);
    const canvas = screen.getByTestId("global-map-canvas");
    const first = within(canvas).getByLabelText(/节点 A/);
    const transformBefore = first.getAttribute("transform");
    const svg = within(canvas).getByRole("group", { name: "跨会话研究关系画布" });
    const viewBoxBefore = svg.getAttribute("viewBox");

    fireEvent.click(first);
    expect(first).toHaveClass("global-map__node--selected");
    expect(first).toHaveAttribute("transform", transformBefore);
    fireEvent.click(within(canvas).getByRole("button", { name: "放大地图" }));
    expect(svg.getAttribute("viewBox")).not.toBe(viewBoxBefore);
    expect(first).toHaveAttribute("transform", transformBefore);
    expect(JSON.stringify(observation)).toBe(serializedBefore);
  });
});
