import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { AppShell } from "./AppShell";

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

describe("AppShell 网状导航入口（阶段 I · D2）", () => {
  it("宽屏打开网状画布，窄屏回落到既有关系列表", async () => {
    const user = userEvent.setup();
    stubMatchMedia(true);
    const wideRender = renderShell("/research/session-1/node/node-1");

    const wideTrigger = screen.getByRole("button", { name: "网状导航（快捷键 G）" });
    expect(wideTrigger).toHaveAttribute("aria-controls", "graph-canvas-overlay");
    await user.click(wideTrigger);
    expect(screen.getByRole("dialog", { name: "网状导航" })).toBeInTheDocument();
    wideRender.unmount();

    stubMatchMedia(false);
    renderShell("/research/session-1/node/node-1");
    const narrowTrigger = screen.getByRole("button", { name: "网状导航（快捷键 G）" });
    expect(narrowTrigger).toHaveAttribute("aria-controls", "relationship-list-overlay");
    await user.click(narrowTrigger);
    expect(screen.getByRole("dialog", { name: "关系列表" })).toBeInTheDocument();
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
