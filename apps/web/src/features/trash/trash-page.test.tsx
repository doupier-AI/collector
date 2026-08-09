import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import { ApiRequestError } from "../../api/errors";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeSession } from "../../test/fakes";
import { TrashPage } from "./TrashPage";

function renderPage(api: Partial<ApiClient>) {
  const services = {
    api: api as ApiClient,
    connectTaskEvents: vi.fn(),
  } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <MemoryRouter>
        <TrashPage />
      </MemoryRouter>
    </ServicesProvider>,
  );
}

describe("TrashPage 回收站页", () => {
  it("空回收站提示 30 天规则", async () => {
    renderPage({ listResearchSessions: async () => [] });
    expect(await screen.findByText(/回收站是空的/)).toBeInTheDocument();
    expect(screen.getByText(/30 天到期后自动永久清理/)).toBeInTheDocument();
  });

  it("列出已删除会话，恢复调用 API 并广播", async () => {
    const user = userEvent.setup();
    const restoreResearchSession = vi.fn<() => ReturnType<ApiClient["restoreResearchSession"]>>(
      async () => makeSession({ id: "s-1", title: "已删会话" }),
    );
    const listResearchSessions = vi
      .fn<() => ReturnType<ApiClient["listResearchSessions"]>>(async () => [])
      .mockResolvedValueOnce([makeSession({ id: "s-1", title: "已删会话", trashedAt: "2026-08-08T10:00:00.000Z" })])
      .mockResolvedValueOnce([]);
    renderPage({ restoreResearchSession, listResearchSessions });

    expect(await screen.findByText("已删会话")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(restoreResearchSession).toHaveBeenCalledWith("s-1"));
    expect(await screen.findByText(/回收站是空的/)).toBeInTheDocument();
    expect(listResearchSessions).toHaveBeenCalledWith(true);
  });

  it("彻底删除需确认，确认后永久删除并广播", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const permanentDeleteResearchSession = vi.fn<() => ReturnType<ApiClient["permanentDeleteResearchSession"]>>(
      async () => undefined,
    );
    const listResearchSessions = vi
      .fn<() => ReturnType<ApiClient["listResearchSessions"]>>(async () => [])
      .mockResolvedValueOnce([makeSession({ id: "s-1", title: "已删会话", trashedAt: "2026-08-08T10:00:00.000Z" })])
      .mockResolvedValueOnce([]);
    renderPage({ permanentDeleteResearchSession, listResearchSessions });

    await user.click(await screen.findByRole("button", { name: "彻底删除" }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toContain("永久清除");
    await waitFor(() => expect(permanentDeleteResearchSession).toHaveBeenCalledWith("s-1"));
    expect(await screen.findByText(/回收站是空的/)).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("取消彻底删除确认则不删除", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const permanentDeleteResearchSession = vi.fn<() => ReturnType<ApiClient["permanentDeleteResearchSession"]>>();
    renderPage({
      permanentDeleteResearchSession,
      listResearchSessions: async () => [makeSession({ id: "s-1", title: "已删会话", trashedAt: "2026-08-08T10:00:00.000Z" })],
    });

    await user.click(await screen.findByRole("button", { name: "彻底删除" }));
    expect(permanentDeleteResearchSession).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("读取失败可重试", async () => {
    const user = userEvent.setup();
    const listResearchSessions = vi
      .fn<() => ReturnType<ApiClient["listResearchSessions"]>>()
      .mockRejectedValueOnce(new ApiRequestError(500, "internal_error", "boom"))
      .mockResolvedValueOnce([makeSession({ id: "s-1", title: "已删会话", trashedAt: "2026-08-08T10:00:00.000Z" })]);
    renderPage({ listResearchSessions });

    expect(await screen.findByText("暂时无法读取回收站。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新读取" }));
    expect(await screen.findByText("已删会话")).toBeInTheDocument();
  });

  it("选择模式：批量恢复", async () => {
    const user = userEvent.setup();
    const restoreResearchSession = vi.fn<() => ReturnType<ApiClient["restoreResearchSession"]>>(
      async () => makeSession({ id: "s-1" }),
    );
    const sessions = [
      makeSession({ id: "s-1", title: "会话甲", trashedAt: "2026-08-08T10:00:00.000Z" }),
      makeSession({ id: "s-2", title: "会话乙", trashedAt: "2026-08-08T10:00:00.000Z" }),
    ];
    const listResearchSessions = vi
      .fn<() => ReturnType<ApiClient["listResearchSessions"]>>(async () => [])
      .mockResolvedValueOnce(sessions)
      .mockResolvedValueOnce([]);
    renderPage({ restoreResearchSession, listResearchSessions });

    await user.click(await screen.findByRole("button", { name: "选择" }));
    await user.click(screen.getByRole("button", { name: "选择会话甲" }));
    await user.click(screen.getByRole("button", { name: "选择会话乙" }));
    await user.click(screen.getByRole("button", { name: "恢复" }));

    await waitFor(() => {
      expect(restoreResearchSession).toHaveBeenCalledWith("s-1");
      expect(restoreResearchSession).toHaveBeenCalledWith("s-2");
    });
    await waitFor(() => expect(screen.queryByText("已选 2 项")).not.toBeInTheDocument());
  });

  it("选择模式：批量彻底删除需确认", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const permanentDeleteResearchSession = vi.fn<() => ReturnType<ApiClient["permanentDeleteResearchSession"]>>(
      async () => undefined,
    );
    const sessions = [
      makeSession({ id: "s-1", title: "会话甲", trashedAt: "2026-08-08T10:00:00.000Z" }),
    ];
    const listResearchSessions = vi
      .fn<() => ReturnType<ApiClient["listResearchSessions"]>>(async () => [])
      .mockResolvedValueOnce(sessions)
      .mockResolvedValueOnce([]);
    renderPage({ permanentDeleteResearchSession, listResearchSessions });

    await user.click(await screen.findByRole("button", { name: "选择" }));
    await user.click(screen.getByRole("button", { name: "选择会话甲" }));
    await user.click(screen.getByRole("button", { name: "彻底删除" }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(permanentDeleteResearchSession).toHaveBeenCalledWith("s-1"));
    confirmSpy.mockRestore();
  });
});
