import { render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import { ApiRequestError } from "../../api/errors";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeProject, makeSession } from "../../test/fakes";
import { PAIRED_EVENT } from "../auth/paired-event";
import { SessionListPanel } from "./SessionListPanel";
import { notifySessionsChanged } from "./session-events";

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

function apiWith(overrides: Partial<ApiClient> = {}): Partial<ApiClient> {
  return {
    listProjects: async () => [],
    listResearchSessions: async () => [],
    ...overrides,
  };
}

describe("SessionListPanel 会话分组树", () => {
  it("空状态时给出下一步与新建项目入口", async () => {
    renderPanel(apiWith());
    expect(await screen.findByText(/还没有研究会话/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新建项目/ })).toBeInTheDocument();
  });

  it("按项目分组展示会话，未分类兜底", async () => {
    const projects = [makeProject({ id: "p-1", name: "工作项目" }), makeProject({ id: "p-2", name: "学习项目" })];
    const sessions = [
      makeSession({ id: "s-1", title: "理解注意力机制", projectId: "p-1" }),
      makeSession({ id: "s-2", title: "比较两种索引结构", projectId: "p-2" }),
      makeSession({ id: "s-3", title: "零散想法" }),
    ];
    renderPanel(apiWith({ listProjects: async () => projects, listResearchSessions: async () => sessions }));

    expect(await screen.findByRole("button", { name: /工作项目\(/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /学习项目\(/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /理解注意力机制/ })).toHaveAttribute("href", "/research/s-1");
    expect(screen.getByRole("link", { name: /比较两种索引结构/ })).toHaveAttribute("href", "/research/s-2");
    expect(screen.getByRole("link", { name: /零散想法/ })).toHaveAttribute("href", "/research/s-3");
  });

  it("项目组可折叠，折叠态持久化到 localStorage", async () => {
    localStorage.setItem("collector:session-collapsed", JSON.stringify({ "p-1": true }));
    const projects = [makeProject({ id: "p-1", name: "工作项目" })];
    const sessions = [makeSession({ id: "s-1", title: "理解注意力机制", projectId: "p-1" })];
    renderPanel(apiWith({ listProjects: async () => projects, listResearchSessions: async () => sessions }));

    const toggle = await screen.findByRole("button", { name: /工作项目\(/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: /理解注意力机制/ })).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: /理解注意力机制/ })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("collector:session-collapsed") ?? "{}")).toEqual({ "p-1": false });
  });

  it("新建项目调用 API 并广播刷新", async () => {
    const user = userEvent.setup();
    const createProject = vi.fn<() => ReturnType<ApiClient["createProject"]>>(async () => makeProject({ id: "p-new", name: "新项目" }));
    const listProjects = vi
      .fn<() => ReturnType<ApiClient["listProjects"]>>(async () => [])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeProject({ id: "p-new", name: "新项目" })]);
    renderPanel(apiWith({ createProject, listProjects, listResearchSessions: async () => [] }));

    await user.click(await screen.findByRole("button", { name: /新建项目/ }));
    await user.type(screen.getByLabelText("新项目名称"), "新项目");
    await user.click(screen.getByRole("button", { name: /^创建$/ }));

    await waitFor(() => expect(createProject).toHaveBeenCalledWith("新项目", expect.any(String)));
    expect(await screen.findByRole("button", { name: /新项目\(/ })).toBeInTheDocument();
  });

  it("会话菜单：重命名 inline 提交并广播", async () => {
    const user = userEvent.setup();
    const updateResearchSession = vi.fn<() => ReturnType<ApiClient["updateResearchSession"]>>(async () => makeSession({ id: "s-1", title: "新名字" }));
    const listResearchSessions = vi
      .fn<() => ReturnType<ApiClient["listResearchSessions"]>>(async () => [])
      .mockResolvedValueOnce([makeSession({ id: "s-1", title: "旧名字" })])
      .mockResolvedValueOnce([makeSession({ id: "s-1", title: "新名字" })]);
    renderPanel(apiWith({ updateResearchSession, listResearchSessions }));

    await user.click((await screen.findByLabelText("旧名字 的菜单")) as HTMLButtonElement);
    await user.click(screen.getByRole("menuitem", { name: "重命名" }));
    const input = screen.getByLabelText("重命名");
    await user.clear(input);
    await user.type(input, "新名字");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(updateResearchSession).toHaveBeenCalledWith("s-1", { title: "新名字" }));
    expect(await screen.findByRole("link", { name: /新名字/ })).toBeInTheDocument();
  });

  it("会话菜单：移动到项目调用 API", async () => {
    const user = userEvent.setup();
    const updateResearchSession = vi.fn<() => ReturnType<ApiClient["updateResearchSession"]>>(async () => makeSession({ id: "s-1" }));
    const projects = [makeProject({ id: "p-1", name: "工作项目" })];
    const sessions = [makeSession({ id: "s-1", title: "会话" })];
    renderPanel(apiWith({ updateResearchSession, listProjects: async () => projects, listResearchSessions: async () => sessions }));

    await user.click(await screen.findByLabelText("会话 的菜单"));
    await user.click(screen.getByRole("menuitem", { name: "工作项目" }));

    await waitFor(() => expect(updateResearchSession).toHaveBeenCalledWith("s-1", { projectId: "p-1" }));
  });

  it("会话菜单：归档切换标记已归档", async () => {
    const user = userEvent.setup();
    const updateResearchSession = vi.fn<() => ReturnType<ApiClient["updateResearchSession"]>>(async () => makeSession({ id: "s-1", status: "archived" }));
    renderPanel(apiWith({ updateResearchSession, listResearchSessions: async () => [makeSession({ id: "s-1", title: "会话" })] }));

    await user.click(await screen.findByLabelText("会话 的菜单"));
    await user.click(screen.getByRole("menuitem", { name: "归档" }));

    await waitFor(() => expect(updateResearchSession).toHaveBeenCalledWith("s-1", { status: "archived" }));
  });

  it("会话菜单：删除需确认，确认后软删并广播", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const trashResearchSession = vi.fn<() => ReturnType<ApiClient["trashResearchSession"]>>(async () => makeSession({ id: "s-1" }));
    const listResearchSessions = vi
      .fn<() => ReturnType<ApiClient["listResearchSessions"]>>(async () => [])
      .mockResolvedValueOnce([makeSession({ id: "s-1", title: "会话" })])
      .mockResolvedValueOnce([]);
    renderPanel(apiWith({ trashResearchSession, listResearchSessions }));

    await user.click(await screen.findByLabelText("会话 的菜单"));
    await user.click(screen.getByRole("menuitem", { name: "删除…" }));

    await waitFor(() => expect(trashResearchSession).toHaveBeenCalledWith("s-1"));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/还没有研究会话/)).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("会话菜单：取消删除确认则不删除", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const trashResearchSession = vi.fn<() => ReturnType<ApiClient["trashResearchSession"]>>();
    renderPanel(apiWith({ trashResearchSession, listResearchSessions: async () => [makeSession({ id: "s-1", title: "会话" })] }));

    await user.click(await screen.findByLabelText("会话 的菜单"));
    await user.click(screen.getByRole("menuitem", { name: "删除…" }));

    expect(trashResearchSession).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("项目菜单：删除项目确认文案提醒会话回未分类", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const deleteProject = vi.fn<() => ReturnType<ApiClient["deleteProject"]>>(async () => undefined);
    const projects = [makeProject({ id: "p-1", name: "工作项目" })];
    const sessions = [makeSession({ id: "s-1", title: "会话", projectId: "p-1" })];
    const listProjects = vi
      .fn<() => ReturnType<ApiClient["listProjects"]>>(async () => [])
      .mockResolvedValueOnce(projects)
      .mockResolvedValueOnce([]);
    renderPanel(apiWith({ deleteProject, listProjects, listResearchSessions: async () => sessions }));

    await user.click(await screen.findByLabelText("工作项目 的菜单"));
    await user.click(screen.getByRole("menuitem", { name: /^删除项目…$/ }));

    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith("p-1"));
    expect(confirmSpy.mock.calls[0][0]).toContain("回到未分类");
    confirmSpy.mockRestore();
  });

  it("加载失败时可重试", async () => {
    const user = userEvent.setup();
    const listResearchSessions = vi
      .fn<() => ReturnType<ApiClient["listResearchSessions"]>>()
      .mockRejectedValueOnce(new ApiRequestError(500, "internal_error", "boom"))
      .mockResolvedValueOnce([makeSession({ id: "s-9", title: "恢复后的会话" })]);
    renderPanel(apiWith({ listResearchSessions }));

    expect(await screen.findByText("暂时无法读取最近研究。")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("link", { name: /恢复后的会话/ })).toBeInTheDocument();
    expect(listResearchSessions).toHaveBeenCalledTimes(2);
  });

  it("面板先于配对挂载失败时，配对完成后自动刷新", async () => {
    const listResearchSessions = vi
      .fn<() => ReturnType<ApiClient["listResearchSessions"]>>()
      .mockRejectedValueOnce(new ApiRequestError(401, "unauthorized", "unauthorized"))
      .mockResolvedValueOnce([makeSession({ id: "s-7", title: "配对后的会话" })]);
    const listProjects = vi.fn(async () => []);
    renderPanel(apiWith({ listProjects, listResearchSessions }));

    expect(await screen.findByText("暂时无法读取最近研究。")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event(PAIRED_EVENT));
    });
    expect(await screen.findByRole("link", { name: /配对后的会话/ })).toBeInTheDocument();
    expect(listResearchSessions).toHaveBeenCalledTimes(2);
  });

  it("SESSIONS_CHANGED 事件触发重新取数", async () => {
    const listResearchSessions = vi
      .fn<() => ReturnType<ApiClient["listResearchSessions"]>>(async () => [])
      .mockResolvedValueOnce([makeSession({ id: "s-1", title: "第一版" })])
      .mockResolvedValueOnce([makeSession({ id: "s-1", title: "改名后" })]);
    renderPanel(apiWith({ listResearchSessions }));

    expect(await screen.findByRole("link", { name: /第一版/ })).toBeInTheDocument();

    act(() => {
      notifySessionsChanged();
    });
    expect(await screen.findByRole("link", { name: /改名后/ })).toBeInTheDocument();
    expect(listResearchSessions).toHaveBeenCalledTimes(2);
  });
});
