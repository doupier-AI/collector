import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { makeGraphObservation, makeGraphObservationNode } from "../../test/fakes";
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
