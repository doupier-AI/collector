import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import { NetworkError } from "../../api/errors";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeSession } from "../../test/fakes";
import { StartPage } from "./StartPage";

function Destination() {
  const location = useLocation();
  return <p>{location.pathname}</p>;
}

function renderStartPage(api: Partial<ApiClient>) {
  const services = {
    api: api as ApiClient,
    connectTaskEvents: vi.fn(),
  } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={["/research/new"]}>
        <Routes>
          <Route path="/research/new" element={<StartPage />} />
          <Route path="/research/:sessionId" element={<Destination />} />
        </Routes>
      </MemoryRouter>
    </ServicesProvider>,
  );
}

describe("StartPage 会话创建", () => {
  it("结果不确定后重试复用同一个创建幂等键", async () => {
    const user = userEvent.setup();
    const createResearchSession = vi
      .fn<ApiClient["createResearchSession"]>()
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValueOnce(makeSession({ id: "recovered-session" }));
    renderStartPage({ createResearchSession });

    await user.type(screen.getByLabelText("你的问题"), "保留并重试这个问题");
    await user.click(screen.getByRole("button", { name: "开始研究" }));
    expect(await screen.findByText("连接失败，请重试。")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "开始研究" }));
    expect(await screen.findByText("/research/recovered-session")).toBeInTheDocument();
    expect(createResearchSession).toHaveBeenCalledTimes(2);
    expect(createResearchSession.mock.calls[0][0]).toBeTruthy();
    expect(createResearchSession.mock.calls[1][0]).toBe(createResearchSession.mock.calls[0][0]);
  });
});
