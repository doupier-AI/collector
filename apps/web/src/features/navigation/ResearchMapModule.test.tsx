import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeEdge, makeGraphNodeSummary, makeGraphProjection, makeNode, makeNodeView, makeSession } from "../../test/fakes";
import { ResearchMapModule } from "./ResearchMapModule";
import type { ResearchMapMode } from "./useResearchMap";

/** 焦点 + 父 + 子 + 语义邻居的投影：专注模式血统链与关联区都有内容。 */
function moduleProjection() {
  const parent = makeGraphNodeSummary("parent", "父节点", 1);
  const focus = makeGraphNodeSummary("focus", "当前节点", 0, { parentNodeId: "parent" });
  const child = makeGraphNodeSummary("child", "子节点", 1, { parentNodeId: "focus" });
  const related = makeGraphNodeSummary("related", "语义邻居", 1);
  const edges = [
    makeEdge("parent-child", "parent", "focus"),
    makeEdge("parent-child", "focus", "child"),
    makeEdge("semantic-related", "focus", "related"),
  ];
  return makeGraphProjection({ nodes: [parent, focus, child, related], edges, focusNodeId: "focus" });
}

/** 用真实 state 驱动 mode prop，使模式切换按钮可测试。 */
function ModuleHarness({ api, initialMode, wide }: { api: Partial<ApiClient>; initialMode: ResearchMapMode; wide: boolean }) {
  const [mode, setMode] = useState<ResearchMapMode>(initialMode);
  const [open, setOpen] = useState(true);
  return (
    <ServicesProvider services={{ api: api as ApiClient } as unknown as AppServices}>
      <MemoryRouter initialEntries={["/research/session-1/node/focus"]}>
        {open ? (
          <ResearchMapModule
            sessionId="session-1"
            focusNodeId="focus"
            mode={mode}
            wide={wide}
            onModeChange={setMode}
            onClose={() => setOpen(false)}
          />
        ) : null}
        <LocationProbe />
      </MemoryRouter>
    </ServicesProvider>
  );
}

function renderModule(
  api: Partial<ApiClient>,
  options: { mode?: "focus" | "assoc"; wide?: boolean } = {},
) {
  const onClose = vi.fn();
  const onModeChange = vi.fn();
  const rendered = render(
    <ServicesProvider services={{ api: api as ApiClient } as unknown as AppServices}>
      <MemoryRouter initialEntries={["/research/session-1/node/focus"]}>
        <ResearchMapModule
          sessionId="session-1"
          focusNodeId="focus"
          mode={options.mode ?? "focus"}
          wide={options.wide ?? true}
          onModeChange={onModeChange}
          onClose={onClose}
        />
        <LocationProbe />
      </MemoryRouter>
    </ServicesProvider>,
  );
  return { ...rendered, onClose, onModeChange };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}</div>;
}

describe("ResearchMapModule", () => {
  it("默认专注模式：标题、模式切换按钮与筛选工具栏齐全，当前节点为锚点", async () => {
    renderModule({ getResearchGraph: async () => moduleProjection() });

    const dialog = screen.getByRole("dialog", { name: "研究地图" });
    expect(within(dialog).getByTestId("map-mode-focus")).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByTestId("map-mode-assoc")).toHaveAttribute("aria-pressed", "false");
    expect(within(dialog).getByRole("toolbar", { name: "关系筛选" })).toBeInTheDocument();
    expect(within(dialog).getByTestId("map-filter-parent-child")).toHaveAttribute("aria-pressed", "true");
    expect(await within(dialog).findByRole("list", { name: "专注脉络" })).toBeInTheDocument();
  });

  it("模式切换：点「关联」后宽屏渲染画布，窄屏渲染关系列表", async () => {
    const user = userEvent.setup();
    render(<ModuleHarness api={{ getResearchGraph: async () => moduleProjection() }} initialMode="focus" wide />);

    const dialog = screen.getByRole("dialog", { name: "研究地图" });
    await within(dialog).findByRole("list", { name: "专注脉络" });
    await user.click(within(dialog).getByTestId("map-mode-assoc"));
    expect(within(dialog).getByRole("region", { name: "关系网状画布" })).toBeInTheDocument();
  });

  it("窄屏关联模式渲染关系列表", async () => {
    render(<ModuleHarness api={{ getResearchGraph: async () => moduleProjection() }} initialMode="assoc" wide={false} />);

    const dialog = screen.getByRole("dialog", { name: "研究地图" });
    expect(await within(dialog).findByRole("list", { name: "节点关系列表" })).toBeInTheDocument();
  });

  it("筛选工具栏共享一份状态：专注模式关闭语义后，血统链与关联区同步更新", async () => {
    const user = userEvent.setup();
    renderModule({ getResearchGraph: async () => moduleProjection() });

    const dialog = screen.getByRole("dialog", { name: "研究地图" });
    await within(dialog).findByRole("list", { name: "专注脉络" });
    // 语义邻居在关联区可见
    expect(within(dialog).getByRole("button", { name: "语义邻居" })).toBeInTheDocument();

    await user.click(within(dialog).getByTestId("map-filter-semantic-related"));
    expect(within(dialog).getByTestId("map-filter-semantic-related")).toHaveAttribute("aria-pressed", "false");
    // 关联区空态（语义被过滤）
    expect(await within(dialog).findByText("当前筛选没有可见的关系。")).toBeInTheDocument();

    // 全部复位后语义邻居回来
    await user.click(within(dialog).getByTestId("map-filter-all"));
    expect(await within(dialog).findByRole("button", { name: "语义邻居" })).toBeInTheDocument();
  });

  it("Escape 关闭并回调 onClose；遮罩点击同样关闭", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModule({ getResearchGraph: async () => moduleProjection() });

    const dialog = screen.getByRole("dialog", { name: "研究地图" });
    dialog.focus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    // 遮罩点击
    await user.click(document.querySelector(".panel-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("「返回当前页面」安全出口调用 onClose，不产生路由", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModule({ getResearchGraph: async () => moduleProjection() });

    const dialog = screen.getByRole("dialog", { name: "研究地图" });
    await within(dialog).findByRole("list", { name: "专注脉络" });
    await user.click(within(dialog).getByTestId("map-return-page"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("location-probe")).toHaveTextContent("/research/session-1/node/focus");
  });

  it("局部焦点不产生路由：专注模式 roving 移动只改焦点", async () => {
    const user = userEvent.setup();
    renderModule({ getResearchGraph: async () => moduleProjection() });

    const dialog = screen.getByRole("dialog", { name: "研究地图" });
    const chain = await within(dialog).findByRole("list", { name: "专注脉络" });
    const rows = within(chain).getAllByRole("listitem");
    const currentRow = rows.find((row) => row.textContent?.includes("当前节点"));
    await waitFor(() => expect(currentRow).toHaveFocus());

    await user.keyboard("{ArrowDown}");
    await user.keyboard("{ArrowDown}");
    expect(screen.getByTestId("location-probe")).toHaveTextContent("/research/session-1/node/focus");
  });

  it("切到关联模式后键盘焦点锚定画布当前节点（不落在对话框容器）", async () => {
    const user = userEvent.setup();
    render(<ModuleHarness api={{ getResearchGraph: async () => moduleProjection() }} initialMode="focus" wide />);

    const dialog = screen.getByRole("dialog", { name: "研究地图" });
    await within(dialog).findByRole("list", { name: "专注脉络" });
    await user.click(within(dialog).getByTestId("map-mode-assoc"));

    const canvas = within(dialog).getByRole("region", { name: "关系网状画布" });
    const currentNode = within(canvas).getByTestId("graph-node-focus");
    await waitFor(() => expect(currentNode).toHaveFocus());
    expect(dialog).not.toHaveFocus();
  });

  it("切回专注模式后焦点锚定当前节点行", async () => {
    const user = userEvent.setup();
    render(<ModuleHarness api={{ getResearchGraph: async () => moduleProjection() }} initialMode="assoc" wide />);

    const dialog = screen.getByRole("dialog", { name: "研究地图" });
    await within(dialog).findByRole("region", { name: "关系网状画布" });
    await user.click(within(dialog).getByTestId("map-mode-focus"));

    const chain = within(dialog).getByRole("list", { name: "专注脉络" });
    const rows = within(chain).getAllByRole("listitem");
    const currentRow = rows.find((row) => row.textContent?.includes("当前节点"));
    await waitFor(() => expect(currentRow).toHaveFocus());
  });
});

describe("ResearchMapModule 稳定地址会话解析（#61）", () => {
  /** sessionId 为 null 的渲染：稳定地址不含会话，由模块按节点视图解析。 */
  function renderDerivedModule(api: Partial<ApiClient>) {
    return render(
      <ServicesProvider services={{ api: api as ApiClient } as unknown as AppServices}>
        <MemoryRouter initialEntries={["/nodes/focus"]}>
          <ResearchMapModule
            sessionId={null}
            focusNodeId="focus"
            mode="focus"
            wide
            onModeChange={() => {}}
            onClose={() => {}}
          />
        </MemoryRouter>
      </ServicesProvider>,
    );
  }

  it("sessionId 为空时先显示加载态，按节点视图解析所属会话后渲染地图", async () => {
    const getResearchNodeView = vi.fn(async (nodeId: string) =>
      makeNodeView({
        node: makeNode({ id: nodeId, sessionId: "session-9" }),
        session: makeSession({ id: "session-9" }),
      }));
    const getResearchGraph = vi.fn(async () => moduleProjection());
    renderDerivedModule({ getResearchNodeView, getResearchGraph });

    expect(screen.getByText("正在打开研究地图…")).toBeInTheDocument();
    // 解析完成后按解析出的会话取图投影并渲染专注脉络
    const chain = await screen.findByRole("list", { name: "专注脉络" });
    expect(within(chain).getByText("当前节点")).toBeInTheDocument();
    expect(getResearchNodeView).toHaveBeenCalledWith("focus");
    expect(getResearchGraph).toHaveBeenCalledWith("session-9", "focus");
  });

  it("解析失败显示可理解错误，点重试后重新解析", async () => {
    let attempt = 0;
    const getResearchNodeView = vi.fn(async (nodeId: string) => {
      attempt += 1;
      if (attempt === 1) throw new Error("network down");
      return makeNodeView({
        node: makeNode({ id: nodeId, sessionId: "session-9" }),
        session: makeSession({ id: "session-9" }),
      });
    });
    const getResearchGraph = vi.fn(async () => moduleProjection());
    const user = userEvent.setup();
    renderDerivedModule({ getResearchNodeView, getResearchGraph });

    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法打开研究地图，请重试。");
    await user.click(screen.getByRole("button", { name: "重试" }));
    const chain = await screen.findByRole("list", { name: "专注脉络" });
    expect(within(chain).getByText("当前节点")).toBeInTheDocument();
    expect(getResearchNodeView).toHaveBeenCalledTimes(2);
  });
});

  it("#94 修复：模式切换卸载被聚焦的脉络行后，对话框重新接管焦点（Escape 保持可达）", async () => {
    const api: Partial<ApiClient> = { getResearchGraph: async () => moduleProjection() };
    const renderWithMode = (mode: "focus" | "assoc") => (
      <ServicesProvider services={{ api: api as ApiClient } as unknown as AppServices}>
        <MemoryRouter initialEntries={["/research/session-1/node/focus"]}>
          <ResearchMapModule
            sessionId="session-1"
            focusNodeId="focus"
            mode={mode}
            wide
            onModeChange={() => {}}
            onClose={() => {}}
          />
        </MemoryRouter>
      </ServicesProvider>
    );
    const { rerender } = render(renderWithMode("focus"));

    const dialog = screen.getByRole("dialog", { name: "研究地图" });
    const chain = await within(dialog).findByRole("list", { name: "专注脉络" });
    // 真实时序：数据就绪后 roving 焦点抢到当前节点行（#94 门禁取证——约 100ms 后焦点离开对话框）。
    const currentRow = within(chain).getByRole("listitem", { name: /当前节点/ });
    await waitFor(() => expect(currentRow).toHaveFocus());

    // 键盘切模式（不经过按钮点击转移焦点）：key={mode} 重建视图，被聚焦的行随视图卸载。
    rerender(renderWithMode("assoc"));
    expect(within(dialog).getByRole("region", { name: "关系网状画布" })).toBeInTheDocument();

    // 修复：焦点已不在对话框内（浏览器回落 body）→ 恢复到对话框，Escape 关闭路径保持可达。
    await waitFor(() => expect(dialog).toHaveFocus());
  });
