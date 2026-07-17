import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import { ApiRequestError } from "../../api/errors";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeSession } from "../../test/fakes";
import { SessionListPanel } from "./SessionListPanel";

function renderPanel(api: Partial<ApiClient>) {
  const services = {
    api: api as ApiClient,
    connectTaskEvents: vi.fn(),
  } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <MemoryRouter>
        <SessionListPanel />
      </MemoryRouter>
    </ServicesProvider>,
  );
}

describe("SessionListPanel 会话列表", () => {
  it("空状态时给出下一步", async () => {
    renderPanel({ listResearchSessions: async () => [] });
    expect(await screen.findByText(/还没有研究会话/)).toBeInTheDocument();
  });

  it("成功时列出最近研究会话", async () => {
    const sessions = [
      makeSession({ id: "s-1", title: "理解注意力机制" }),
      makeSession({ id: "s-2", title: "比较两种索引结构" }),
    ];
    renderPanel({ listResearchSessions: async () => sessions });

    const first = await screen.findByRole("link", { name: /理解注意力机制/ });
    expect(first).toHaveAttribute("href", "/research/s-1");
    expect(screen.getByRole("link", { name: /比较两种索引结构/ })).toHaveAttribute("href", "/research/s-2");
  });

  it("加载失败时可重试", async () => {
    const user = userEvent.setup();
    const listResearchSessions = vi
      .fn<() => ReturnType<ApiClient["listResearchSessions"]>>()
      .mockRejectedValueOnce(new ApiRequestError(500, "internal_error", "boom"))
      .mockResolvedValueOnce([makeSession({ id: "s-9", title: "恢复后的会话" })]);
    renderPanel({ listResearchSessions });

    expect(await screen.findByText("暂时无法读取最近研究。")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("link", { name: /恢复后的会话/ })).toBeInTheDocument();
    expect(listResearchSessions).toHaveBeenCalledTimes(2);
  });
});
