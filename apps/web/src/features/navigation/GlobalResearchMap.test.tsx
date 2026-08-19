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
