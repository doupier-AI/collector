import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import { ApiRequestError } from "../../api/errors";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { PAIRED_EVENT } from "../auth/paired-event";
import { makeLaterItem, makeLaterItemView, makeSelection } from "../../test/fakes";
import { LATER_CHANGED_EVENT } from "./later-event";
import { LaterPanel } from "./LaterPanel";

function renderPanel(api: Partial<ApiClient>) {
  const services = { api: api as ApiClient } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={["/research/session-1"]}>
        <Routes>
          <Route
            path="/research/:sessionId"
            element={
              <>
                <LocationProbe />
                <LaterPanel mode="fixed" width={264} onWidthChange={() => {}} onClose={() => {}} />
              </>
            }
          />
          <Route path="/research/:sessionId/node/:nodeId" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </ServicesProvider>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{`${location.pathname}${location.search}`}</div>;
}

describe("稍后再学栏目", () => {
  it("呈现真实列表：概括、星级、来源、时间与待学数量徽标", async () => {
    const view = makeLaterItemView({
      item: makeLaterItem({ id: "later-1", summary: "注意力的核心是加权求和", priority: 4 }),
      selection: makeSelection({ id: "selection-1", sessionId: "session-1" }),
      sourceTitle: "理解注意力机制",
    });
    renderPanel({ listResearchLaterItems: vi.fn(async () => [view]) });

    expect(await screen.findByText("注意力的核心是加权求和")).toBeInTheDocument();
    expect(screen.getByText("《理解注意力机制》")).toBeInTheDocument();
    expect(screen.getByText("4 星优先级")).toBeInTheDocument();
    expect(screen.getByTestId("later-count")).toHaveTextContent("1");
    // 已完成数为 0 时不显示已完成分区
    expect(screen.queryByText(/已完成/)).not.toBeInTheDocument();
  });

  it("空列表给出下一步引导，不伪造内容", async () => {
    renderPanel({ listResearchLaterItems: vi.fn(async () => []) });
    expect(await screen.findByTestId("later-empty")).toHaveTextContent("还没有稍后再学项目");
  });

  it("读取失败给出重试入口，重试后恢复", async () => {
    const user = userEvent.setup();
    const view = makeLaterItemView({ item: makeLaterItem({ id: "later-1" }) });
    const listResearchLaterItems = vi
      .fn()
      .mockRejectedValueOnce(new ApiRequestError(500, "internal_error", "boom"))
      .mockResolvedValueOnce([view]);
    renderPanel({ listResearchLaterItems });

    expect(await screen.findByText("暂时无法读取稍后再学。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("本地优先会先把输入保存在本机")).toBeInTheDocument();
  });

  it("点击项目返回原内容原选区（携带选区参数）", async () => {
    const user = userEvent.setup();
    const view = makeLaterItemView({
      item: makeLaterItem({ id: "later-1" }),
      selection: makeSelection({ id: "selection-9", sessionId: "session-1" }),
    });
    renderPanel({ listResearchLaterItems: vi.fn(async () => [view]) });

    await user.click(await screen.findByTestId("later-open-later-1"));
    expect(await screen.findByTestId("location-probe")).toHaveTextContent(
      "/research/session-1/node/session-1?sel=selection-9",
    );
  });

  it("标记完成与恢复待学调用更新并通知刷新", async () => {
    const user = userEvent.setup();
    const view = makeLaterItemView({ item: makeLaterItem({ id: "later-1", status: "pending" }) });
    const updateResearchLaterItem = vi.fn(async () => view);
    renderPanel({
      listResearchLaterItems: vi.fn(async () => [view]),
      updateResearchLaterItem,
    });

    const laterEvents: Event[] = [];
    const listener = (event: Event) => laterEvents.push(event);
    window.addEventListener(LATER_CHANGED_EVENT, listener);

    await user.click(await screen.findByRole("button", { name: "标记完成" }));
    expect(updateResearchLaterItem).toHaveBeenCalledWith("later-1", { status: "done" });
    await waitFor(() => expect(laterEvents.length).toBeGreaterThan(0));

    window.removeEventListener(LATER_CHANGED_EVENT, listener);
  });

  it("稍后再学变更事件触发列表刷新", async () => {
    const first = makeLaterItemView({ item: makeLaterItem({ id: "later-1", summary: "第一条概括" }) });
    const second = makeLaterItemView({ item: makeLaterItem({ id: "later-2", summary: "第二条概括" }) });
    const listResearchLaterItems = vi.fn().mockResolvedValueOnce([first]).mockResolvedValueOnce([second]);
    renderPanel({ listResearchLaterItems });

    expect(await screen.findByText("第一条概括")).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event(LATER_CHANGED_EVENT));
    });
    expect(await screen.findByText("第二条概括")).toBeInTheDocument();
    expect(listResearchLaterItems).toHaveBeenCalledTimes(2);
  });

  it("配对完成后自动刷新（先于配对挂载时初始 401）", async () => {
    const view = makeLaterItemView({ item: makeLaterItem({ id: "later-1", summary: "配对后可见" }) });
    const listResearchLaterItems = vi
      .fn()
      .mockRejectedValueOnce(new ApiRequestError(401, "unauthorized", "unauthorized"))
      .mockResolvedValueOnce([view]);
    renderPanel({ listResearchLaterItems });

    expect(await screen.findByText("暂时无法读取稍后再学。")).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event(PAIRED_EVENT));
    });
    expect(await screen.findByText("配对后可见")).toBeInTheDocument();
  });
});
