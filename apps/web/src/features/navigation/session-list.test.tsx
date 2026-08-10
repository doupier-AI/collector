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

  it("收藏会话在各自分组内置顶，并保留已收藏标识", async () => {
    const projects = [makeProject({ id: "p-1", name: "学习项目" })];
    const sessions = [
      makeSession({ id: "s-new", title: "较新普通会话", projectId: "p-1", isFavorite: false, updatedAt: "2026-08-10T10:00:00.000Z" }),
      makeSession({ id: "s-favorite", title: "收藏会话", projectId: "p-1", isFavorite: true, updatedAt: "2026-08-09T10:00:00.000Z" }),
    ];
    renderPanel(apiWith({ listProjects: async () => projects, listResearchSessions: async () => sessions }));

    const links = await screen.findAllByRole("link");
    const sessionLinks = links.filter((link) => link.getAttribute("href")?.startsWith("/research/"));
    expect(sessionLinks.map((link) => link.textContent)).toEqual([
      expect.stringContaining("收藏会话"),
      expect.stringContaining("较新普通会话"),
    ]);
    expect(screen.getByLabelText("已收藏")).toHaveTextContent("★");
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

  it("项目菜单：重命名 inline 提交并刷新项目名", async () => {
    const user = userEvent.setup();
    const renameProject = vi.fn<() => ReturnType<ApiClient["renameProject"]>>(
      async () => makeProject({ id: "p-1", name: "新项目名" }),
    );
    const listProjects = vi
      .fn<() => ReturnType<ApiClient["listProjects"]>>(async () => [])
      .mockResolvedValueOnce([makeProject({ id: "p-1", name: "旧项目名" })])
      .mockResolvedValueOnce([makeProject({ id: "p-1", name: "新项目名" })]);
    renderPanel(apiWith({ renameProject, listProjects }));

    await user.click(await screen.findByLabelText("旧项目名 的菜单"));
    await user.click(screen.getByRole("menuitem", { name: "重命名" }));
    const input = screen.getByRole("textbox", { name: "重命名" });
    await user.clear(input);
    await user.type(input, "新项目名");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(renameProject).toHaveBeenCalledWith("p-1", "新项目名"));
    expect(await screen.findByRole("button", { name: /新项目名\(/ })).toBeInTheDocument();
  });

  it("临时输入框点击外部时取消并丢弃未提交内容", async () => {
    const user = userEvent.setup();
    const createProject = vi.fn<() => ReturnType<ApiClient["createProject"]>>();
    const renameProject = vi.fn<() => ReturnType<ApiClient["renameProject"]>>();
    const projects = [makeProject({ id: "p-1", name: "工作项目" })];
    const sessions = [makeSession({ id: "s-1", title: "会话", projectId: "p-1" })];
    renderPanel(apiWith({ createProject, renameProject, listProjects: async () => projects, listResearchSessions: async () => sessions }));

    // 新建项目：输入草稿后点击同一区域外的“选择”，输入框消失且不会创建。
    await user.click(await screen.findByRole("button", { name: /新建项目/ }));
    await user.type(screen.getByLabelText("新项目名称"), "不应创建");
    await user.click(screen.getByRole("button", { name: "选择" }));
    expect(screen.queryByLabelText("新项目名称")).not.toBeInTheDocument();
    expect(createProject).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /新建项目/ }));
    expect(screen.getByLabelText("新项目名称")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "选择" }));

    // 项目重命名：输入草稿后点击始终存在的“选择”按钮，编辑器取消且不会提交改名。
    await user.click(screen.getByLabelText("工作项目 的菜单"));
    await user.click(screen.getByRole("menuitem", { name: "重命名" }));
    const renameInput = screen.getByRole("textbox", { name: "重命名" });
    await user.clear(renameInput);
    await user.type(renameInput, "不应改名");
    await user.click(screen.getByRole("button", { name: "选择" }));
    expect(screen.queryByRole("textbox", { name: "重命名" })).not.toBeInTheDocument();
    expect(renameProject).not.toHaveBeenCalled();
    await user.click(screen.getByLabelText("工作项目 的菜单"));
    await user.click(screen.getByRole("menuitem", { name: "重命名" }));
    expect(screen.getByRole("textbox", { name: "重命名" })).toHaveValue("工作项目");
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

  it("选择模式：勾选多个会话批量移动到项目", async () => {
    const user = userEvent.setup();
    const updateResearchSession = vi.fn<() => ReturnType<ApiClient["updateResearchSession"]>>(
      async () => makeSession({ id: "s-1" }),
    );
    const projects = [makeProject({ id: "p-1", name: "工作项目" })];
    const sessions = [
      makeSession({ id: "s-1", title: "会话甲" }),
      makeSession({ id: "s-2", title: "会话乙" }),
    ];
    const listResearchSessions = vi
      .fn<() => ReturnType<ApiClient["listResearchSessions"]>>(async () => [])
      .mockResolvedValueOnce(sessions)
      .mockResolvedValueOnce(sessions.map((item) => ({ ...item, projectId: "p-1" })));
    renderPanel(apiWith({ updateResearchSession, listProjects: async () => projects, listResearchSessions }));

    // 进入选择模式并勾选两个会话
    await user.click(await screen.findByRole("button", { name: "选择" }));
    await user.click(screen.getByRole("button", { name: "选择会话甲" }));
    await user.click(screen.getByRole("button", { name: "选择会话乙" }));
    await waitFor(() => expect(screen.getByText("已选 2 项")).toBeInTheDocument());

    // 批量移动到工作项目（批量栏内的项目按钮）
    await user.click(screen.getByRole("button", { name: "移动到…" }));
    const batchMenu = document.querySelector(".drawer__batch-move");
    expect(batchMenu).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "工作项目" }));

    await waitFor(() => {
      expect(updateResearchSession).toHaveBeenCalledWith("s-1", { projectId: "p-1" });
      expect(updateResearchSession).toHaveBeenCalledWith("s-2", { projectId: "p-1" });
    });
    // 完成后退出选择模式（批量栏消失）
    await waitFor(() => expect(screen.queryByText("已选 2 项")).not.toBeInTheDocument());
  });

  it("选择模式：批量删除需确认，确认后软删并退出", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const trashResearchSession = vi.fn<() => ReturnType<ApiClient["trashResearchSession"]>>(
      async () => makeSession({ id: "s-1" }),
    );
    const sessions = [
      makeSession({ id: "s-1", title: "会话甲" }),
      makeSession({ id: "s-2", title: "会话乙" }),
    ];
    const listResearchSessions = vi
      .fn<() => ReturnType<ApiClient["listResearchSessions"]>>(async () => [])
      .mockResolvedValueOnce(sessions)
      .mockResolvedValueOnce([]);
    renderPanel(apiWith({ trashResearchSession, listResearchSessions }));

    await user.click(await screen.findByRole("button", { name: "选择" }));
    await user.click(screen.getByRole("button", { name: "选择会话甲" }));
    await user.click(screen.getByRole("button", { name: "选择会话乙" }));
    await user.click(screen.getByRole("button", { name: "删除" }));

    expect(confirmSpy.mock.calls[0][0]).toContain("2 个会话");
    await waitFor(() => {
      expect(trashResearchSession).toHaveBeenCalledWith("s-1");
      expect(trashResearchSession).toHaveBeenCalledWith("s-2");
    });
    await waitFor(() => expect(screen.queryByText("已选 2 项")).not.toBeInTheDocument());
    confirmSpy.mockRestore();
  });

  it("选择模式：组头选整组一次勾选组内全部", async () => {
    const user = userEvent.setup();
    const projects = [makeProject({ id: "p-1", name: "工作项目" })];
    const sessions = [
      makeSession({ id: "s-1", title: "会话甲", projectId: "p-1" }),
      makeSession({ id: "s-2", title: "会话乙", projectId: "p-1" }),
    ];
    renderPanel(apiWith({ listProjects: async () => projects, listResearchSessions: async () => sessions }));

    await user.click(await screen.findByRole("button", { name: "选择" }));
    await user.click(screen.getByRole("button", { name: "选择整个工作项目" }));
    await waitFor(() => expect(screen.getByText("已选 2 项")).toBeInTheDocument());
  });

  it("⋯ 菜单用 fixed + 按钮锚点坐标定位，脱离侧栏滚动容器（#10）", async () => {
    const user = userEvent.setup();
    renderPanel(apiWith({ listResearchSessions: async () => [makeSession({ id: "s-1", title: "会话" })] }));

    const trigger = (await screen.findByLabelText("会话 的菜单")) as HTMLButtonElement;
    // 给一个确定的视口坐标，模拟按钮在滚动容器内的位置
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 128,
      left: 40,
      right: 72,
      width: 32,
      height: 28,
      x: 40,
      y: 100,
      toJSON: () => ({}),
    } as DOMRect);

    await user.click(trigger);
    const menu = (await screen.findByRole("menu", { name: "会话 的操作" })) as HTMLElement;
    // 锚点内联坐标：top = 按钮下缘(128) +4，left = 按钮右缘(72)；fixed 由 .session-menu 类承担
    expect(menu.style.top).toBe("132px");
    expect(menu.style.left).toBe("72px");
    expect(menu.className).toContain("session-menu");

    // Escape 关闭菜单
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "会话 的操作" })).not.toBeInTheDocument();
  });
});
