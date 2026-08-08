import { act, render, screen } from "@testing-library/react";
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

describe("标记栏目", () => {
  it("呈现选区、笔记、来源节点、时间与标记数量", async () => {
    const view = makeLaterItemView({
      item: makeLaterItem({ id: "later-1", note: "回头比较两个实现" }),
      selection: makeSelection({ id: "selection-1", sessionId: "session-1", text: "注意力的核心是对输入进行加权求和。" }),
      sourceNode: { id: "node-1", label: "注意力机制分支" },
    });
    renderPanel({ listResearchLaterItems: vi.fn(async () => [view]) });

    expect(await screen.findByText("注意力的核心是对输入进行加权求和。")).toBeInTheDocument();
    expect(screen.getByText("回头比较两个实现")).toBeInTheDocument();
    expect(screen.getByText("来源节点：注意力机制分支")).toBeInTheDocument();
    expect(screen.getByText(/7月21日/)).toBeInTheDocument();
    expect(screen.getByTestId("mark-count")).toHaveTextContent("1");
    expect(screen.queryByText(/星优先级|标记完成|恢复待学/)).not.toBeInTheDocument();
  });

  it("空列表给出下一步引导，不伪造内容", async () => {
    renderPanel({ listResearchLaterItems: vi.fn(async () => []) });
    expect(await screen.findByTestId("mark-empty")).toHaveTextContent("还没有标记");
  });

  it("读取失败给出重试入口，重试后恢复", async () => {
    const user = userEvent.setup();
    const view = makeLaterItemView({ item: makeLaterItem({ id: "later-1" }) });
    const listResearchLaterItems = vi
      .fn()
      .mockRejectedValueOnce(new ApiRequestError(500, "internal_error", "boom"))
      .mockResolvedValueOnce([view]);
    renderPanel({ listResearchLaterItems });

    expect(await screen.findByText("暂时无法读取标记。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("一段选区文字")).toBeInTheDocument();
  });

  it("点击项目返回原内容原选区（携带选区参数）", async () => {
    const user = userEvent.setup();
    const view = makeLaterItemView({
      item: makeLaterItem({ id: "later-1" }),
      selection: makeSelection({ id: "selection-9", sessionId: "session-1" }),
    });
    renderPanel({ listResearchLaterItems: vi.fn(async () => [view]) });

    await user.click(await screen.findByTestId("mark-open-later-1"));
    expect(await screen.findByTestId("location-probe")).toHaveTextContent(
      "/research/session-1/node/session-1?sel=selection-9",
    );
  });

  it("标记变更事件触发列表刷新", async () => {
    const first = makeLaterItemView({ item: makeLaterItem({ id: "later-1" }), selection: makeSelection({ text: "第一条选区" }) });
    const second = makeLaterItemView({ item: makeLaterItem({ id: "later-2" }), selection: makeSelection({ text: "第二条选区" }) });
    const listResearchLaterItems = vi.fn().mockResolvedValueOnce([first]).mockResolvedValueOnce([second]);
    renderPanel({ listResearchLaterItems });

    expect(await screen.findByText("第一条选区")).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event(LATER_CHANGED_EVENT));
    });
    expect(await screen.findByText("第二条选区")).toBeInTheDocument();
    expect(listResearchLaterItems).toHaveBeenCalledTimes(2);
  });

  it("配对完成后自动刷新（先于配对挂载时初始 401）", async () => {
    const view = makeLaterItemView({ item: makeLaterItem({ id: "later-1" }), selection: makeSelection({ text: "配对后可见" }) });
    const listResearchLaterItems = vi
      .fn()
      .mockRejectedValueOnce(new ApiRequestError(401, "unauthorized", "unauthorized"))
      .mockResolvedValueOnce([view]);
    renderPanel({ listResearchLaterItems });

    expect(await screen.findByText("暂时无法读取标记。")).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event(PAIRED_EVENT));
    });
    expect(await screen.findByText("配对后可见")).toBeInTheDocument();
  });
});
