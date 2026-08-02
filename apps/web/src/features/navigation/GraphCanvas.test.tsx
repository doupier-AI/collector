import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeEdge, makeGraphNodeSummary, makeGraphProjection } from "../../test/fakes";
import { computeNodePositions, GraphCanvas } from "./GraphCanvas";
import {
  filterEdgesByKind,
  filterNodesByEdges,
  navigationNodeIds,
} from "./useRelationships";

function projectionAtDepth(maxDepth = 1) {
  const focus = makeGraphNodeSummary("focus", "Transformer 架构", 0);
  const parent = makeGraphNodeSummary("parent", "深度学习基础", -1);
  const child = makeGraphNodeSummary("child", "注意力头", 1, { parentNodeId: "focus" });
  const related = makeGraphNodeSummary("related", "位置编码", 1);
  const fused = makeGraphNodeSummary("fused", "编码器融合", 1);
  const grandchild = makeGraphNodeSummary("grandchild", "多头机制", 2, { parentNodeId: "child" });
  const nodes = maxDepth >= 2
    ? [focus, parent, child, related, fused, grandchild]
    : [focus, parent, child, related, fused];
  const edges = [
    makeEdge("parent-child", "parent", "focus"),
    makeEdge("parent-child", "focus", "child"),
    makeEdge("semantic-related", "focus", "related"),
    makeEdge("fused-from", "fused", "focus"),
    ...(maxDepth >= 2 ? [makeEdge("parent-child", "child", "grandchild")] : []),
  ];
  return makeGraphProjection({ nodes, edges, focusNodeId: "focus" });
}

function renderCanvas(
  getResearchGraph = vi.fn(async (_sessionId: string, _focusNodeId?: string, maxDepth?: number) => projectionAtDepth(maxDepth)),
  focusNodeId = "focus",
) {
  const services = {
    api: { getResearchGraph } as Partial<ApiClient> as ApiClient,
  } as unknown as AppServices;
  const onClose = vi.fn();
  const rendered = render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={[`/research/session-1/node/${focusNodeId}`]}>
        <GraphCanvas sessionId="session-1" focusNodeId={focusNodeId} onClose={onClose} />
        <LocationProbe />
      </MemoryRouter>
    </ServicesProvider>,
  );
  return { ...rendered, getResearchGraph, onClose };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}</div>;
}

function stubReducedMotion(enabled: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? enabled : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  Reflect.deleteProperty(window, "matchMedia");
});

describe("computeNodePositions", () => {
  it("将当前节点稳定放在原点，其余节点按深度分层", () => {
    const focus = makeGraphNodeSummary("focus", "当前", 0);
    const neighbor = makeGraphNodeSummary("neighbor", "邻居", 1);
    const positions = computeNodePositions([focus, neighbor]);

    expect(positions.get("focus")).toEqual({ x: 0, y: 0 });
    expect(positions.get("neighbor")).toEqual({ x: 0, y: -130 });
  });
});

describe("图筛选纯函数", () => {
  it("只返回选中的 active 边，并保留原始投影数据不变", () => {
    const projection = projectionAtDepth();
    const filtered = filterEdgesByKind(projection.edges, ["semantic-related"]);

    expect(filtered.map((edge) => edge.kind)).toEqual(["semantic-related"]);
    expect(projection.edges).toHaveLength(4);
  });

  it("过滤节点只保留当前节点和关系端点，空筛选仍保留当前节点", () => {
    const projection = projectionAtDepth();
    const semanticEdges = filterEdgesByKind(projection.edges, ["semantic-related"]);

    expect(filterNodesByEdges(projection.nodes, semanticEdges, "focus").map((node) => node.node.id)).toEqual([
      "focus",
      "related",
    ]);
    expect(navigationNodeIds(projection.nodes, [], "focus")).toEqual(["focus"]);
  });
});

describe("GraphCanvas", () => {
  it("初始只请求直接邻居，并以线型、双线和可读关系摘要区分三类边", async () => {
    const { getResearchGraph } = renderCanvas();

    await screen.findByRole("group", { name: "研究关系网状图" });
    expect(getResearchGraph).toHaveBeenCalledWith("session-1", "focus", 1);
    expect(screen.getByTestId("graph-node-focus")).toHaveAttribute("transform", "translate(0 0)");

    expect(document.querySelector('[data-edge-kind="parent-child"]')).toHaveAttribute("stroke-dasharray", "none");
    expect(document.querySelector('[data-edge-kind="semantic-related"]')).toHaveAttribute("stroke-dasharray", "7 4");
    expect(document.querySelectorAll('[data-edge-kind="fused-from"] line')).toHaveLength(2);
    expect(screen.getByRole("group", { name: "边类型图例" })).toHaveTextContent("父子关系（实线）");
    expect(screen.getByRole("group", { name: "边类型图例" })).toHaveTextContent("语义相关（虚线）");
    expect(screen.getByRole("group", { name: "边类型图例" })).toHaveTextContent("融合来源（双点划线）");

    const summary = screen.getByRole("region", { name: "关系列表" });
    expect(summary).toHaveTextContent("父子关系：深度学习基础");
    expect(summary).toHaveTextContent("语义相关：Transformer 架构");
    expect(summary).toHaveTextContent("融合来源：编码器融合");
  });

  it("展开时将 maxDepth 加一，新增层加载后可收缩", async () => {
    const user = userEvent.setup();
    const { getResearchGraph } = renderCanvas();

    await screen.findByTestId("graph-node-child");
    await user.click(screen.getByTestId("graph-expand"));
    expect(await screen.findByTestId("graph-node-grandchild")).toBeInTheDocument();
    expect(getResearchGraph).toHaveBeenLastCalledWith("session-1", "focus", 2);
    expect(screen.getByTestId("graph-collapse")).toHaveTextContent("收缩到 1 层");

    await user.click(screen.getByTestId("graph-collapse"));
    await waitFor(() => expect(screen.queryByTestId("graph-node-grandchild")).not.toBeInTheDocument());
    expect(getResearchGraph).toHaveBeenLastCalledWith("session-1", "focus", 1);
  });

  it("键盘和鼠标只聚焦邻居，明确打开后才导航；回到当前节点恢复中心焦点", async () => {
    const user = userEvent.setup();
    renderCanvas();

    const focus = await screen.findByTestId("graph-node-focus");
    await waitFor(() => expect(focus).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByTestId("graph-node-parent")).toHaveFocus();
    expect(screen.getByText(/已聚焦：/)).toHaveTextContent("深度学习基础");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent("/research/session-1/node/parent"),
    );

    await user.click(screen.getByTestId("graph-node-related"));
    expect(screen.getByTestId("location-probe")).toHaveTextContent("/research/session-1/node/parent");
    expect(screen.getByText(/已聚焦：/)).toHaveTextContent("位置编码");

    await user.click(screen.getByTestId("graph-return-current"));
    await waitFor(() => expect(focus).toHaveFocus());

    await user.click(screen.getByTestId("graph-node-related"));
    await user.click(screen.getByTestId("graph-open-focused"));
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent("/research/session-1/node/related"),
    );
  });

  it("按边类型筛选画布并将键盘焦点限制在筛选后的邻居", async () => {
    const user = userEvent.setup();
    renderCanvas();

    await screen.findByTestId("graph-node-focus");
    await user.click(screen.getByTestId("graph-filter-semantic-related"));
    await user.click(screen.getByTestId("graph-filter-fused-from"));

    expect(screen.queryByTestId("graph-node-related")).not.toBeInTheDocument();
    expect(screen.queryByTestId("graph-node-fused")).not.toBeInTheDocument();
    expect(screen.getByTestId("graph-node-child")).toBeInTheDocument();
    expect(screen.getByTestId("graph-filter-parent-child")).toHaveAttribute("aria-pressed", "true");

    await user.keyboard("{ArrowDown}");
    expect(screen.getByTestId("graph-node-parent")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByTestId("graph-node-child")).toHaveFocus();
  });

  it("提供父节点和返回当前页面安全出口", async () => {
    const user = userEvent.setup();
    const getResearchGraph = vi.fn(async () => ({
      ...projectionAtDepth(),
      focusNodeId: "child",
    }));
    const { onClose } = renderCanvas(getResearchGraph, "child");

    await screen.findByTestId("graph-node-child");
    expect(screen.getByTestId("graph-open-parent")).toBeInTheDocument();

    await user.click(screen.getByTestId("graph-open-parent"));
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent("/research/session-1/node/focus"),
    );
    expect(onClose).toHaveBeenCalled();

    await user.click(screen.getByTestId("graph-return-page"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("在减弱动效设置下禁用画布变换过渡", async () => {
    stubReducedMotion(true);
    renderCanvas();

    await screen.findByTestId("graph-canvas-svg");
    const transform = document.querySelector(".graph-canvas__transform");
    expect(transform).toHaveStyle({ transition: "none" });
  });

  it("加载失败时显示可重试状态", async () => {
    const user = userEvent.setup();
    const getResearchGraph = vi
      .fn<(_: string, __?: string, ___?: number) => Promise<ReturnType<typeof projectionAtDepth>>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(projectionAtDepth(1));
    renderCanvas(getResearchGraph);

    expect(await screen.findByText(/暂时无法加载网状图/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByTestId("graph-canvas-svg")).toBeInTheDocument();
  });
});
