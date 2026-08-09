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
});

describe("AppShell 宽屏（≥900px）固定侧栏", () => {
  it("左右侧栏初始展开，顶栏为图标按钮", async () => {
    stubMatchMedia(true);
    renderShell();

    expect(screen.getByRole("button", { name: "内容" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "标记" })).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("navigation", { name: "内容导航" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "标记" })).toBeInTheDocument();
    expect(await screen.findByTestId("mark-empty")).toBeInTheDocument();
    // 不再出现旧的弹层提示
    expect(screen.queryByText(/将在后续版本提供/)).not.toBeInTheDocument();
  });

  it("rail 设置/工具入口真实导航并给当前页激活态", async () => {
    stubMatchMedia(true);
    renderShell();

    const nav = await screen.findByRole("navigation", { name: "内容导航" });
    const aiSettings = within(nav).getByRole("link", { name: "AI 模型设置" });
    expect(aiSettings).toHaveAttribute("href", "/settings/ai-model");
    expect(within(nav).getByRole("link", { name: "融合设置" })).toHaveAttribute("href", "/settings/fusion");
    expect(within(nav).getByRole("link", { name: "运行记录" })).toHaveAttribute("href", "/run-records");
    expect(within(nav).getByRole("link", { name: "回收站" })).toHaveAttribute("href", "/trash");
    // 不在对应页面时不带当前页标记
    expect(aiSettings).not.toHaveAttribute("aria-current");
  });

  it("处于设置页时对应 rail 入口标记当前页", async () => {
    stubMatchMedia(true);
    renderShell("/research/session-1/node/node-1");
    const nav = await screen.findByRole("navigation", { name: "内容导航" });
    // 研究页面上「会话」入口为当前区
    expect(within(nav).getByRole("button", { name: "会话" })).toHaveAttribute("aria-current", "page");
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

  it("点击图标按钮收起/展开对应侧栏", async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    renderShell();

    const nav = await screen.findByRole("navigation", { name: "内容导航" });
    await user.click(screen.getByRole("button", { name: "内容" }));
    expect(nav).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "内容" })).toHaveAttribute("aria-expanded", "false");

    await user.click(screen.getByRole("button", { name: "内容" }));
    expect(await screen.findByRole("navigation", { name: "内容导航" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "标记" }));
    expect(screen.queryByRole("complementary", { name: "标记" })).not.toBeInTheDocument();
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

describe("AppShell 窄屏（<900px）覆盖抽屉", () => {
  it("默认收起，点击展开带遮罩，Escape 关闭后焦点回到触发按钮", async () => {
    stubMatchMedia(false);
    const user = userEvent.setup();
    renderShell();

    expect(screen.queryByRole("navigation", { name: "内容导航" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "标记" })).not.toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: "内容" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);

    expect(await screen.findByRole("navigation", { name: "内容导航" })).toBeInTheDocument();
    expect(document.querySelector(".panel-backdrop")).not.toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("navigation", { name: "内容导航" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("窄屏一次只展开一个侧栏", async () => {
    stubMatchMedia(false);
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole("button", { name: "内容" }));
    expect(await screen.findByRole("navigation", { name: "内容导航" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "标记" }));
    expect(screen.queryByRole("navigation", { name: "内容导航" })).not.toBeInTheDocument();
    expect(await screen.findByRole("complementary", { name: "标记" })).toBeInTheDocument();
  });
});
