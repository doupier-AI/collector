import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import { ServicesProvider, type AppServices } from "../../app/services";
import { makeGraphObservation, makeGraphObservationNode } from "../../test/fakes";
import { ResearchMapLandingPage } from "./ResearchMapLandingPage";

function renderPage(api: Partial<ApiClient>, entry = "/map") {
  const services = { api: { listProjects: async () => [], ...api }, connectTaskEvents: vi.fn() } as unknown as AppServices;
  return render(<ServicesProvider services={services}><MemoryRouter initialEntries={[entry]}><Routes><Route path="map" element={<ResearchMapLandingPage />} /><Route path="map/focus/:focusNodeId" element={<ResearchMapLandingPage />} /><Route path="/" element={<p>研究首页</p>} /></Routes></MemoryRouter></ServicesProvider>);
}

describe("ResearchMapLandingPage", () => {
  it("requests one complete observation and keeps filter state out of history", async () => {
    const getResearchMap = vi.fn(async () => makeGraphObservation({ nodes: [makeGraphObservationNode("a", "节点 A")] }));
    renderPage({ getResearchMap }); await screen.findByTestId("global-map-canvas");
    expect(getResearchMap).toHaveBeenCalledWith({}); expect(window.history.state?.usr?.mapSceneV2).toBeUndefined();
  });
  it("uses the identity button and Escape to leave the map", async () => {
    renderPage({ getResearchMap: async () => makeGraphObservation({ nodes: [makeGraphObservationNode("a", "节点 A")] }) });
    await screen.findByTestId("global-map-canvas"); await userEvent.setup().click(screen.getAllByRole("button", { name: "研究图谱" })[0]!);
    expect(screen.getByText("研究首页")).toBeVisible();
  });
  it("keeps visual settings in an independent right-side panel with semantic density", async () => {
    renderPage({ getResearchMap: async () => ({ ...makeGraphObservation({ nodes: [makeGraphObservationNode("a", "节点 A")] }), temporaryFusionCount: 1 }) });
    await screen.findByTestId("global-map-canvas");
    const user = userEvent.setup();
    expect(screen.queryByRole("button", { name: "更多地图功能" })).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "图谱呈现与布局" });
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByRole("region", { name: "图谱呈现与布局" });
    expect(panel).toHaveTextContent("呈现");
    expect(panel).toHaveTextContent("布局");
    expect(screen.getByLabelText("显示关系箭头")).not.toBeChecked();
    await user.click(screen.getByLabelText("显示关系箭头"));
    expect(screen.getByLabelText("显示关系箭头")).toBeChecked();
    await user.selectOptions(screen.getByLabelText("布局密度"), "spacious");
    expect(screen.getByLabelText("布局密度")).toHaveValue("spacious");
    expect(panel).toHaveTextContent("疏朗");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "图谱呈现与布局" })).not.toBeInTheDocument();
    const closedTrigger = screen.getByRole("button", { name: "图谱呈现与布局" });
    expect(closedTrigger).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(closedTrigger).toHaveFocus());
  });
});
