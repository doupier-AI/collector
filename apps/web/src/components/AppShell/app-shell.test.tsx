import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { AppShell, researchMapTargetForPath } from "./AppShell";

/** jsdom 没有 matchMedia，按宽/窄屏桩掉（useMediaQuery 只识别 900px 断点）。 */
function stubMatchMedia(wide: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("min-width: 900px") ? wide : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function renderShell(initialEntry = "/") {
  const services = {
    api: {
      listResearchSessions: async () => [],
      listProjects: async () => [],
      listResearchLaterItems: async () => [],
      getResearchGraph: async (_sessionId: string, focusNodeId?: string) => ({
        focusNodeId: focusNodeId ?? "node-1",
        nodes: [],
        edges: [],
      }),
    } as Partial<ApiClient> as ApiClient,
    connectTaskEvents: vi.fn(),
  } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<p>主页内容</p>} />
            <Route path="research/:sessionId/node/:nodeId" element={<p>节点内容</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ServicesProvider>,
  );
}

afterEach(() => {
  // 恢复 jsdom 原生状态（无 matchMedia）
  Reflect.deleteProperty(window, "matchMedia");
  // 清理侧栏收展/分组折叠持久化，避免在用例间泄漏
  localStorage.clear();
});

describe("AppShell 宽屏（≥900px）固定侧栏", () => {
  it("左侧栏常驻展开，顶栏不再有整体隐藏左侧栏入口", async () => {
    stubMatchMedia(true);
    renderShell();

    // 顶栏不再有「内容」按钮（旧的「点了整个侧栏连带按钮消失」入口已删除）
    expect(screen.queryByRole("button", { name: "内容" })).not.toBeInTheDocument();
    // 左侧栏常驻展开、右侧栏初始展开
    expect(await screen.findByRole("navigation", { name: "内容导航" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "标记" })).toBeInTheDocument();
    expect(await screen.findByTestId("mark-empty")).toBeInTheDocument();
    // 不再出现旧的弹层提示
    expect(screen.queryByText(/将在后续版本提供/)).not.toBeInTheDocument();
  });

  it("底部设置聚合菜单真实导航并给当前页激活态", async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    renderShell();

    const nav = await screen.findByRole("navigation", { name: "内容导航" });
    // 设置聚合在底部「设置」菜单内：先展开
    await user.click(within(nav).getByRole("button", { name: "设置" }));
    const menu = within(nav).getByRole("menu", { name: "设置" });
    const aiSettings = within(menu).getByRole("menuitem", { name: "AI 模型设置" });
    expect(aiSettings).toHaveAttribute("href", "/settings/ai-model");
    expect(within(menu).getByRole("menuitem", { name: "融合设置" })).toHaveAttribute("href", "/settings/fusion");
    expect(within(menu).getByRole("menuitem", { name: "运行记录" })).toHaveAttribute("href", "/run-records");
    expect(within(menu).getByRole("menuitem", { name: "回收站" })).toHaveAttribute("href", "/trash");
  });

  it("处于研究页时会话入口标记当前区", async () => {
    stubMatchMedia(true);
    renderShell("/research/session-1/node/node-1");
    const nav = await screen.findByRole("navigation", { name: "内容导航" });
    // 收起为 rail 后「会话」入口为真实导航链接并标记当前区
    await userEvent.setup().click(within(nav).getByRole("button", { name: "收起侧栏" }));
    expect(within(nav).getByRole("link", { name: "会话" })).toHaveAttribute("aria-current", "page");
  });

  it("固定侧栏宽度默认 264，拖拽手柄可键盘调宽并钳制", async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    renderShell();

    const handle = await screen.findByRole("separator", { name: "调整内容侧栏宽度" });
    expect(handle).toHaveAttribute("aria-valuenow", "264");
    expect(handle).toHaveAttribute("aria-valuemin", "208");
    expect(handle).toHaveAttribute("aria-valuemax", "400");

    handle.focus();
    await user.keyboard("{ArrowRight}");
    expect(handle).toHaveAttribute("aria-valuenow", "280");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(handle).toHaveAttribute("aria-valuenow", "248");
    for (let index = 0; index < 20; index += 1) await user.keyboard("{ArrowRight}");
    expect(handle).toHaveAttribute("aria-valuenow", "400");

    // 右侧栏手柄方向相反：ArrowLeft 变宽
    const rightHandle = screen.getByRole("separator", { name: "调整标记侧栏宽度" });
    rightHandle.focus();
    await user.keyboard("{ArrowLeft}");
    expect(rightHandle).toHaveAttribute("aria-valuenow", "280");
  });

  it("点击图标按钮收起/展开右侧标记栏（左侧栏常驻无此入口）", async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    renderShell();

    // 左侧栏常驻，顶栏无「内容」按钮
    expect(screen.queryByRole("button", { name: "内容" })).not.toBeInTheDocument();
    expect(await screen.findByRole("navigation", { name: "内容导航" })).toBeInTheDocument();

    // 右侧标记栏仍由顶栏「标记」按钮开合
    await user.click(screen.getByRole("button", { name: "标记" }));
    expect(screen.queryByRole("complementary", { name: "标记" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "标记" }));
    expect(screen.getByRole("complementary", { name: "标记" })).toBeInTheDocument();
  });

  it("单层级收展：收起为干净图标 rail 无残留详情，再展开恢复完整侧栏", async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    renderShell();

    const nav = await screen.findByRole("navigation", { name: "内容导航" });
    // 展开态：有完整侧栏（最近研究分组 + 拖拽手柄），顶部有收起/搜索/新建会话按钮组
    expect(within(nav).getByText("最近研究")).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "收起侧栏" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "搜索会话" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "新建会话" })).toHaveAttribute("href", "/research/new");
    expect(within(nav).getByRole("separator", { name: "调整内容侧栏宽度" })).toBeInTheDocument();

    // 收起：真实整体收起为 rail——详情（最近研究/手柄）消失，只剩图标 rail
    await user.click(within(nav).getByRole("button", { name: "收起侧栏" }));
    expect(within(nav).queryByText("最近研究")).not.toBeInTheDocument();
    expect(within(nav).queryByRole("separator", { name: "调整内容侧栏宽度" })).not.toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "会话" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "展开侧栏" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "主题：跟随系统" })).toBeInTheDocument();
    // 再展开：恢复完整侧栏
    await user.click(within(nav).getByRole("button", { name: "展开侧栏" }));
    expect(within(nav).getByText("最近研究")).toBeInTheDocument();
  });

  it("收起态点击设置：一次展开完整侧栏并保持设置菜单打开", async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    renderShell();

    const nav = await screen.findByRole("navigation", { name: "内容导航" });
    await user.click(within(nav).getByRole("button", { name: "收起侧栏" }));

    await user.click(within(nav).getByRole("button", { name: "设置" }));

    expect(within(nav).getByText("最近研究")).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "收起侧栏" })).toBeInTheDocument();
    expect(within(nav).getByRole("menu", { name: "设置" })).toBeInTheDocument();
  });

  it("收展两态顶部按钮组同序：收起/展开恒为最上方第一个，顶部集群顺序一致（位置不跳变的 DOM 前提）", async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    renderShell();

    const nav = await screen.findByRole("navigation", { name: "内容导航" });
    const labels = (container: HTMLElement) =>
      Array.from(container.querySelectorAll(".side-rail__button")).map((el) => el.getAttribute("aria-label"));

    // 展开态顶部按钮组：收起在最上方第一个，随后 会话/搜索/新建
    const detailTop = nav.querySelector(".side-detail__top") as HTMLElement;
    expect(labels(detailTop)).toEqual(["收起侧栏", "会话", "搜索会话", "新建会话"]);

    // 收起态 rail 顶部集群与展开态同序：展开在最上方第一个
    await user.click(within(nav).getByRole("button", { name: "收起侧栏" }));
    const rail = nav.querySelector(".side-rail") as HTMLElement;
    // rail 顶部四个与展开态顶部一一对应（收起↔展开是同一开关的两态）
    expect(labels(rail).slice(0, 4)).toEqual(["展开侧栏", "会话", "搜索会话", "新建会话"]);
  });

  it("顶部搜索：展开输入框按标题过滤会话", async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    const services = {
      api: {
        listResearchSessions: async () => [
          { id: "s-1", title: "苏格拉底追问", updatedAt: "2026-08-09T10:00:00.000Z", status: "active" },
          { id: "s-2", title: "庄子蝴蝶梦", updatedAt: "2026-08-09T11:00:00.000Z", status: "active" },
        ],
        listProjects: async () => [],
        listResearchLaterItems: async () => [],
        getResearchGraph: async () => ({ focusNodeId: "n", nodes: [], edges: [] }),
      } as unknown as ApiClient,
      connectTaskEvents: vi.fn(),
    } as unknown as AppServices;
    render(
      <ServicesProvider services={services}>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<p>主页内容</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ServicesProvider>,
    );

    const nav = await screen.findByRole("navigation", { name: "内容导航" });
    // 两个会话都在
    expect(await within(nav).findByText("苏格拉底追问")).toBeInTheDocument();
    expect(within(nav).getByText("庄子蝴蝶梦")).toBeInTheDocument();

    // 打开搜索并输入「苏格拉底」：只剩命中会话
    await user.click(within(nav).getByRole("button", { name: "搜索会话" }));
    await user.type(within(nav).getByRole("searchbox", { name: "搜索会话标题" }), "苏格拉底");
    expect(within(nav).getByText("苏格拉底追问")).toBeInTheDocument();
    expect(within(nav).queryByText("庄子蝴蝶梦")).not.toBeInTheDocument();
  });
});

describe("AppShell 研究地图入口（#40）", () => {
  it("宽屏与窄屏都从单一“研究地图”按钮打开统一覆盖层，默认专注模式", async () => {
    const user = userEvent.setup();
    stubMatchMedia(true);
    const wideRender = renderShell("/research/session-1/node/node-1");

    const wideTrigger = screen.getByRole("button", { name: "研究地图" });
    expect(wideTrigger).toHaveAttribute("aria-controls", "research-map-overlay");
    await user.click(wideTrigger);
    const dialog = screen.getByRole("dialog", { name: "研究地图" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByTestId("map-mode-focus")).toHaveAttribute("aria-pressed", "true");
    wideRender.unmount();

    stubMatchMedia(false);
    renderShell("/research/session-1/node/node-1");
    const narrowTrigger = screen.getByRole("button", { name: "研究地图" });
    await user.click(narrowTrigger);
    const narrowDialog = screen.getByRole("dialog", { name: "研究地图" });
    expect(narrowDialog).toBeInTheDocument();
    expect(within(narrowDialog).getByTestId("map-mode-focus")).toHaveAttribute("aria-pressed", "true");
  });

  it("快捷键 t 打开专注模式、g 打开关联模式；打开中按键切换模式", async () => {
    const user = userEvent.setup();
    stubMatchMedia(true);
    renderShell("/research/session-1/node/node-1");

    await user.keyboard("t");
    const dialog = screen.getByRole("dialog", { name: "研究地图" });
    expect(within(dialog).getByTestId("map-mode-focus")).toHaveAttribute("aria-pressed", "true");

    await user.keyboard("g");
    expect(within(dialog).getByTestId("map-mode-assoc")).toHaveAttribute("aria-pressed", "true");

    await user.keyboard("t");
    expect(within(dialog).getByTestId("map-mode-focus")).toHaveAttribute("aria-pressed", "true");
  });

  it("Escape 关闭研究地图，焦点回到入口按钮", async () => {
    const user = userEvent.setup();
    stubMatchMedia(true);
    renderShell("/research/session-1/node/node-1");

    const trigger = screen.getByRole("button", { name: "研究地图" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "研究地图" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "研究地图" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("输入框内按 t/g 不误触研究地图", async () => {
    const user = userEvent.setup();
    stubMatchMedia(true);
    renderShell("/research/session-1/node/node-1");

    await user.tab();
    // 焦点落到某处后直接在 body 上按 t 应打开
    await user.keyboard("t");
    expect(screen.getByRole("dialog", { name: "研究地图" })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    // 在输入框内按 t 不应打开
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    await user.keyboard("t");
    expect(screen.queryByRole("dialog", { name: "研究地图" })).not.toBeInTheDocument();
    input.remove();
  });

  it("不在研究页面时不显示研究地图入口", () => {
    stubMatchMedia(true);
    renderShell("/");
    expect(screen.queryByRole("button", { name: "研究地图" })).not.toBeInTheDocument();
  });
});

describe("researchMapTargetForPath", () => {
  it("节点页解析出会话与当前节点", () => {
    expect(researchMapTargetForPath("/research/session-1/node/node-a")).toEqual({
      sessionId: "session-1",
      nodeId: "node-a",
    });
  });

  it("会话旧路由与阅读页回退到根节点", () => {
    expect(researchMapTargetForPath("/research/session-1")).toEqual({ sessionId: "session-1", nodeId: "session-1" });
    expect(researchMapTargetForPath("/research/session-1/reading/snap-1")).toEqual({
      sessionId: "session-1",
      nodeId: "session-1",
    });
  });

  it("开始页与设置页不提供研究地图入口", () => {
    expect(researchMapTargetForPath("/research/new")).toBeNull();
    expect(researchMapTargetForPath("/settings/ai-model")).toBeNull();
    expect(researchMapTargetForPath("/")).toBeNull();
  });
});

describe("AppShell 窄屏（<900px）窄 rail 常驻 + 覆盖抽屉", () => {
  it("窄屏默认常驻窄 rail，点设置直接开覆盖抽屉与菜单，逐层 Escape 收起", async () => {
    stubMatchMedia(false);
    const user = userEvent.setup();
    renderShell();

    // 初始：窄 rail 常驻（内容导航可见但为收起 rail，无遮罩），右侧标记栏默认收起
    const nav = await screen.findByRole("navigation", { name: "内容导航" });
    expect(within(nav).getByRole("button", { name: "展开侧栏" })).toBeInTheDocument();
    expect(document.querySelector(".panel-backdrop")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "标记" })).not.toBeInTheDocument();

    // 点 rail 上的「设置」：一次展开覆盖抽屉并打开设置菜单
    await user.click(within(nav).getByRole("button", { name: "设置" }));
    expect(within(nav).getByText("最近研究")).toBeInTheDocument();
    expect(within(nav).getByRole("menu", { name: "设置" })).toBeInTheDocument();
    expect(document.querySelector(".panel-backdrop")).not.toBeNull();

    // 第一次 Escape 只关闭设置菜单，侧栏保持展开
    await user.keyboard("{Escape}");
    expect(within(nav).queryByRole("menu", { name: "设置" })).not.toBeInTheDocument();
    expect(within(nav).getByText("最近研究")).toBeInTheDocument();

    // 第二次 Escape：收起回窄 rail，遮罩消失
    await user.keyboard("{Escape}");
    expect(within(nav).queryByText("最近研究")).not.toBeInTheDocument();
    expect(document.querySelector(".panel-backdrop")).toBeNull();
  });

  it("窄屏左侧栏常驻，标记覆盖抽屉开合不影响左侧 rail", async () => {
    stubMatchMedia(false);
    const user = userEvent.setup();
    renderShell();

    // 左侧窄 rail 常驻
    const nav = await screen.findByRole("navigation", { name: "内容导航" });
    expect(within(nav).getByRole("button", { name: "展开侧栏" })).toBeInTheDocument();

    // 打开右侧标记覆盖抽屉：左侧 rail 仍在
    await user.click(screen.getByRole("button", { name: "标记" }));
    expect(await screen.findByRole("complementary", { name: "标记" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "内容导航" })).toBeInTheDocument();
  });
});
