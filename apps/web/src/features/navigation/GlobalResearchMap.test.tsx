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
    expect(canvas().querySelector("svg")).toHaveAttribute("viewBox", expect.stringMatching(/^0 0 /));
  });
  it("draws straight lines and only renders arrows when switched on", () => {
    const observation = makeGraphObservation({ nodes: [makeGraphObservationNode("a", "节点 A"), makeGraphObservationNode("b", "节点 B")], edges: [{ edge: { ...makeEdge("parent-child", "a", "b"), kind: "parent-child" as const }, connectivity: "default" }] });
    const { rerender } = render(<MemoryRouter><GlobalResearchMap observation={observation} /></MemoryRouter>);
    expect(canvas().querySelector("[data-edge-kind]")?.getAttribute("d")).toMatch(/^M .* L /);
    rerender(<MemoryRouter><GlobalResearchMap observation={observation} showArrows /></MemoryRouter>);
    expect(canvas().querySelector(".global-map__edge-arrow")).not.toBeNull();
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
