import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import { ApiRequestError } from "../../api/errors";
import { ServicesProvider, type AppServices } from "../../app/services";
import { makeEdge, makeGraphObservation, makeGraphObservationNode } from "../../test/fakes";
import { ResearchMapLandingPage } from "./ResearchMapLandingPage";

function renderPage(api: Partial<ApiClient>, initialEntry = "/map") {
  const services = { api, connectTaskEvents: vi.fn() } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="map" element={<ResearchMapLandingPage />} />
          <Route path="map/focus/:focusNodeId" element={<ResearchMapLandingPage />} />
          <Route path="research/new" element={<p>新建会话页</p>} />
          <Route path="nodes/:nodeId" element={<p>节点页</p>} />
          <Route path="trash" element={<p>回收站页</p>} />
        </Routes>
      </MemoryRouter>
    </ServicesProvider>,
  );
}

describe("ResearchMapLandingPage", () => {
  it("读取期间呈现明确的加载状态", () => {
    renderPage({ getResearchMap: () => new Promise(() => {}) });
    expect(screen.getByLabelText("正在打开研究图谱")).toHaveAttribute("aria-busy", "true");
  });

  it("读取失败时说明状态并允许重试", async () => {
    const getResearchMap = vi
      .fn<() => Promise<ReturnType<typeof makeGraphObservation>>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(makeGraphObservation());
    renderPage({ getResearchMap });

    expect(await screen.findByRole("heading", { name: "暂时无法打开研究图谱" })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText(/还没有研究节点/)).toBeInTheDocument();
    expect(getResearchMap).toHaveBeenCalledTimes(2);
  });

  it("空状态可直接开始第一次研究", async () => {
    renderPage({ getResearchMap: async () => makeGraphObservation() });
    const link = await screen.findByRole("link", { name: "开始第一次研究" });
    expect(link).toHaveAttribute("href", "/research/new");
  });

  it("认证失效时回到可重新配对的安全入口", async () => {
    renderPage({ getResearchMap: async () => { throw new ApiRequestError(401, "unauthorized", "unauthorized"); } });
    expect(await screen.findByRole("heading", { name: "配对 Collector" })).toBeInTheDocument();
    expect(screen.getByLabelText("配对码")).toBeInTheDocument();
  });

  it("同一观察结果呈现跨会话、归档、孤立与融合节点，并只使用稳定节点地址", async () => {
    const active = makeGraphObservationNode("active", "注意力机制");
    const archived = makeGraphObservationNode("archived", "已归档会话", { lifecycle: "archived" });
    const isolated = makeGraphObservationNode("isolated", "孤立根节点");
    const fusion = makeGraphObservationNode("fusion", "跨会话综合", {
      role: "fusion",
      fusionEvidenceHealth: "available",
      node: { ...makeGraphObservationNode("fusion", "跨会话综合").node, isFusionNode: true },
    });
    renderPage({
      getResearchMap: async () => makeGraphObservation({
        nodes: [active, archived, isolated, fusion],
        edges: [{ edge: { ...makeEdge("fused-from", "active", "fusion"), kind: "fused-from" }, connectivity: "default" }],
      }),
    });

    expect(await screen.findByTestId("global-map-canvas")).toBeInTheDocument();
    expect(screen.getByTestId("global-map-list")).toBeInTheDocument();
    expect(screen.getAllByLabelText(/注意力机制，未分类，研究节点，活跃/)).toHaveLength(2);
    expect(screen.getAllByLabelText(/已归档会话，未分类，研究节点，已归档/)).toHaveLength(2);
    expect(screen.getAllByLabelText(/孤立根节点/)).toHaveLength(2);
    const fusionTargets = screen.getAllByLabelText(/跨会话综合，未分类，融合成果/);
    expect(fusionTargets).toHaveLength(2);
    expect(fusionTargets[1]).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("global-map-canvas").querySelector('[data-edge-kind="fused-from"]')).not.toBeNull();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "新建会话" })).toHaveAttribute("href", "/research/new");
    expect(screen.getByRole("link", { name: "查看回收站" })).toHaveAttribute("href", "/trash");
  });

  it("专注地址把焦点和永久关系开关交给同一观察请求，退出时回到全图", async () => {
    const focusObservation = {
      ...makeGraphObservation({
      nodes: [{ ...makeGraphObservationNode("focus", "焦点节点"), connectivity: "focus" as const }],
      }),
      focusNodeId: "focus",
    };
    const getResearchMap = vi.fn(async () => focusObservation);
    renderPage({ getResearchMap }, "/map/focus/focus");

    expect(await screen.findByText(/正在专注：/)).toHaveTextContent("焦点节点");
    expect(getResearchMap).toHaveBeenCalledWith({ focusNodeId: "focus", relationshipKinds: ["parent-child", "fused-from"] });
    await userEvent.setup().click(screen.getByRole("button", { name: "退出专注" }));
    await waitFor(() => expect(getResearchMap).toHaveBeenLastCalledWith({ relationshipKinds: ["parent-child", "fused-from"] }));
  });

  it("请求仍在进行时连续关闭两类关系，保留两次即时意图并最终请求空关系集", async () => {
    const focusObservation = {
      ...makeGraphObservation({
        nodes: [{ ...makeGraphObservationNode("focus", "焦点节点"), connectivity: "focus" as const }],
      }),
      focusNodeId: "focus",
    };
    const pending = new Promise<never>(() => {});
    const getResearchMap = vi.fn()
      .mockResolvedValueOnce(focusObservation)
      .mockReturnValue(pending);
    renderPage({ getResearchMap }, "/map/focus/focus");

    const parentToggle = await screen.findByRole("button", { name: "父子生长" });
    const fusionToggle = screen.getByRole("button", { name: "融合来源" });
    const user = userEvent.setup();
    await user.click(parentToggle);
    await user.click(fusionToggle);

    expect(parentToggle).toHaveAttribute("aria-pressed", "false");
    expect(fusionToggle).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(getResearchMap).toHaveBeenLastCalledWith({ focusNodeId: "focus", relationshipKinds: [] }));
  });
});
