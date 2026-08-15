import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import { ServicesProvider, type AppServices } from "../../app/services";
import { makeSession } from "../../test/fakes";
import { ResearchMapLandingPage } from "./ResearchMapLandingPage";

function renderPage(api: Partial<ApiClient>) {
  const services = { api, connectTaskEvents: vi.fn() } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={["/map"]}>
        <Routes>
          <Route path="map" element={<ResearchMapLandingPage />} />
          <Route path="research/new" element={<p>新建会话页</p>} />
          <Route path="research/:sessionId/node/:nodeId" element={<p>节点页</p>} />
        </Routes>
      </MemoryRouter>
    </ServicesProvider>,
  );
}

describe("ResearchMapLandingPage", () => {
  it("读取期间呈现明确的加载状态", () => {
    renderPage({ listResearchSessions: () => new Promise(() => {}) });
    expect(screen.getByLabelText("正在打开研究图谱")).toHaveAttribute("aria-busy", "true");
  });

  it("读取失败时说明状态并允许重试", async () => {
    const listResearchSessions = vi
      .fn<() => Promise<ReturnType<typeof makeSession>[]>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([]);
    renderPage({ listResearchSessions });

    expect(await screen.findByRole("heading", { name: "暂时无法打开研究图谱" })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText(/还没有可继续的会话/)).toBeInTheDocument();
    expect(listResearchSessions).toHaveBeenCalledTimes(2);
  });

  it("空状态可直接开始第一次研究", async () => {
    renderPage({ listResearchSessions: async () => [] });
    const link = await screen.findByRole("link", { name: "开始第一次研究" });
    expect(link).toHaveAttribute("href", "/research/new");
  });

  it("只列活动且未进回收站的会话，并可进入根节点", async () => {
    renderPage({
      listResearchSessions: async () => [
        makeSession({ id: "active", title: "注意力机制", status: "active" }),
        makeSession({ id: "archived", title: "已归档会话", status: "archived" }),
        makeSession({ id: "trashed", title: "回收站会话", status: "active", trashedAt: "2026-08-10T00:00:00.000Z" }),
      ],
    });

    const active = await screen.findByRole("link", { name: /注意力机制/ });
    expect(active).toHaveAttribute("href", "/nodes/active");
    expect(screen.queryByText("已归档会话")).not.toBeInTheDocument();
    expect(screen.queryByText("回收站会话")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "新建会话" })).toHaveAttribute("href", "/research/new");
  });
});
