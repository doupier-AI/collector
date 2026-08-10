import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeLaterItem, makeLaterItemView, makeSelection } from "../../test/fakes";
import { LATER_CHANGED_EVENT } from "../navigation/later-event";
import { SessionMarksDialog } from "./SessionMarksDialog";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-probe">{`${location.pathname}${location.search}`}</output>;
}

function renderDialog(api: Partial<ApiClient>, onClose = vi.fn()) {
  const services = { api: api as ApiClient } as unknown as AppServices;
  render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={["/research/session-1/node/session-1"]}>
        <LocationProbe />
        <SessionMarksDialog sessionId="session-1" onClose={onClose} />
      </MemoryRouter>
    </ServicesProvider>,
  );
  return onClose;
}

describe("当前会话标记弹窗", () => {
  it("只呈现当前会话标记，并显示摘要、笔记、来源与时间", async () => {
    const current = makeLaterItemView({
      item: makeLaterItem({ id: "later-1", sessionId: "session-1", note: "回头比较两个实现" }),
      selection: makeSelection({ id: "selection-1", sessionId: "session-1", text: "注意力的核心是对输入进行加权求和。" }),
      sourceNode: { id: "node-1", label: "注意力机制分支" },
    });
    const other = makeLaterItemView({
      item: makeLaterItem({ id: "later-2", sessionId: "session-2" }),
      selection: makeSelection({ id: "selection-2", sessionId: "session-2", text: "其他会话内容" }),
    });
    renderDialog({ listResearchLaterItems: vi.fn(async () => [current, other]) });

    const dialog = await screen.findByRole("dialog", { name: "本会话标记" });
    expect(within(dialog).getByText("注意力的核心是对输入进行加权求和。")).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue("回头比较两个实现")).toBeInTheDocument();
    expect(within(dialog).getByText("来源节点：注意力机制分支")).toBeInTheDocument();
    expect(within(dialog).queryByText("其他会话内容")).not.toBeInTheDocument();
    expect(screen.getByTestId("mark-count")).toHaveTextContent("1 条标记");
  });

  it("可编辑笔记、全选并永久删除", async () => {
    const user = userEvent.setup();
    let current = makeLaterItemView({ item: makeLaterItem({ id: "later-1", note: "旧笔记" }) });
    const updateResearchLaterItem = vi.fn(async (_id: string, update: { note?: string }) => {
      current = { ...current, item: { ...current.item, note: update.note } };
      return current;
    });
    const deleteResearchLaterItem = vi.fn(async () => undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderDialog({ listResearchLaterItems: vi.fn(async () => [current]), updateResearchLaterItem, deleteResearchLaterItem });

    const note = await screen.findByLabelText(/编辑标记笔记/);
    await user.clear(note);
    await user.type(note, "新的核验笔记");
    await user.tab();
    await waitFor(() => expect(updateResearchLaterItem).toHaveBeenCalledWith("later-1", { note: "新的核验笔记" }));

    await user.click(screen.getByRole("checkbox", { name: "全选" }));
    await user.click(screen.getByRole("button", { name: "删除所选" }));
    await waitFor(() => expect(deleteResearchLaterItem).toHaveBeenCalledWith("later-1"));
    expect(await screen.findByTestId("mark-empty")).toBeInTheDocument();
  });

  it("点击标记关闭弹窗并返回原选区；Escape 关闭并保留焦点约定", async () => {
    const user = userEvent.setup();
    const onClose = renderDialog({
      listResearchLaterItems: vi.fn(async () => [
        makeLaterItemView({
          item: makeLaterItem({ id: "later-1" }),
          selection: makeSelection({ id: "selection-9", sessionId: "session-1" }),
        }),
      ]),
    });

    await user.click(await screen.findByTestId("mark-open-later-1"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("location-probe")).toHaveTextContent("/research/session-1/node/session-1?sel=selection-9");

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("标记变更事件触发刷新，空列表给出当前会话引导", async () => {
    const view = makeLaterItemView({ selection: makeSelection({ text: "新增标记" }) });
    const listResearchLaterItems = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([view]);
    renderDialog({ listResearchLaterItems });

    expect(await screen.findByTestId("mark-empty")).toBeInTheDocument();
    act(() => window.dispatchEvent(new Event(LATER_CHANGED_EVENT)));
    expect(await screen.findByText("新增标记")).toBeInTheDocument();
    expect(listResearchLaterItems).toHaveBeenCalledTimes(2);
  });
});
