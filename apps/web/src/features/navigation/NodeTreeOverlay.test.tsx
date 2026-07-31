import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ResearchSessionNodeTreeItem } from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { ApiRequestError } from "../../api/errors";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeNode } from "../../test/fakes";
import { nodeTreeTargetForPath } from "../../components/AppShell/AppShell";
import { NodeTreeOverlay } from "./NodeTreeOverlay";
import { ancestorPath, buildNodeTree, defaultExpanded, flattenVisibleTree } from "./useNodeTree";

function treeItem(
  id: string,
  label: string,
  options: { parentNodeId?: string; createdAt?: string } = {},
): ResearchSessionNodeTreeItem {
  return {
    node: makeNode({
      id,
      sessionId: "session-1",
      parentNodeId: options.parentNodeId,
      createdAt: options.createdAt ?? "2026-07-29T08:00:00.000Z",
    }),
    label,
  };
}

function sampleTree(): ResearchSessionNodeTreeItem[] {
  return [
    treeItem("session-1", "理解注意力机制", { createdAt: "2026-07-29T08:00:00.000Z" }),
    treeItem("node-a", "多头注意力的作用", { parentNodeId: "session-1", createdAt: "2026-07-29T09:00:00.000Z" }),
    treeItem("node-b", "位置编码", { parentNodeId: "session-1", createdAt: "2026-07-29T10:00:00.000Z" }),
    treeItem("node-a-1", "注意力头的并行性", { parentNodeId: "node-a", createdAt: "2026-07-29T11:00:00.000Z" }),
  ];
}

describe("useNodeTree 纯函数", () => {
  it("buildNodeTree 按 parentNodeId 组织子节点并按创建时间排序", () => {
    const model = buildNodeTree(sampleTree());
    expect(model.roots.map((entry) => entry.node.id)).toEqual(["session-1"]);
    expect(model.childrenOf.get("session-1")?.map((entry) => entry.node.id)).toEqual(["node-a", "node-b"]);
    expect(model.childrenOf.get("node-a")?.map((entry) => entry.node.id)).toEqual(["node-a-1"]);
  });

  it("父节点缺失的节点按根处理，不丢弃数据", () => {
    const model = buildNodeTree([treeItem("orphan", "孤儿节点", { parentNodeId: "missing" })]);
    expect(model.roots.map((entry) => entry.node.id)).toEqual(["orphan"]);
  });

  it("flattenVisibleTree 只展开指定集合，展开后子节点紧随父节点", () => {
    const model = buildNodeTree(sampleTree());
    const collapsed = flattenVisibleTree(model, new Set());
    expect(collapsed.map((row) => row.item.node.id)).toEqual(["session-1"]);

    const expanded = flattenVisibleTree(model, new Set(["session-1", "node-a"]));
    expect(expanded.map((row) => row.item.node.id)).toEqual(["session-1", "node-a", "node-a-1", "node-b"]);
    expect(expanded.map((row) => row.depth)).toEqual([1, 2, 3, 2]);
    expect(expanded[0].hasChildren).toBe(true);
    expect(expanded[2].hasChildren).toBe(false);
  });

  it("ancestorPath 返回根到当前节点的路径", () => {
    const model = buildNodeTree(sampleTree());
    expect(ancestorPath(model, "node-a-1").map((entry) => entry.node.id)).toEqual(["session-1", "node-a", "node-a-1"]);
    expect(ancestorPath(model, "missing")).toEqual([]);
  });

  it("defaultExpanded 展开当前节点的祖先链；当前节点是根时展开根", () => {
    const model = buildNodeTree(sampleTree());
    expect([...defaultExpanded(model, "node-a-1")].sort()).toEqual(["node-a", "session-1"]);
    expect([...defaultExpanded(model, "session-1")]).toEqual(["session-1"]);
  });
});

function renderOverlay(api: Partial<ApiClient>, currentNodeId = "node-a") {
  const services = { api: api as ApiClient } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={[`/research/session-1/node/${currentNodeId}`]}>
        <NodeTreeOverlay sessionId="session-1" currentNodeId={currentNodeId} onClose={() => {}} />
        <LocationProbe />
      </MemoryRouter>
    </ServicesProvider>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}</div>;
}

describe("NodeTreeOverlay", () => {
  it("呈现面包屑与树，当前节点高亮并自动展开祖先链", async () => {
    renderOverlay({ getResearchSessionNodeTree: async () => sampleTree() });

    await screen.findByRole("tree", { name: "研究节点树" });
    // 展开状态由被动副作用应用：先等兄弟节点出现再断言，避免采样竞态
    await screen.findByRole("treeitem", { name: /位置编码/ });

    // 祖先链展开：根展开后 node-a 与兄弟 node-b 并列可见；
    // 当前节点自身不自动展开（node-a-1 隐藏），避免一打开就把注意力拉走。
    // textContent 含展开箭头与“当前”标记
    const items = screen.getAllByRole("treeitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "▾理解注意力机制",
      "▸多头注意力的作用当前",
      "位置编码",
    ]);

    const current = screen.getByRole("treeitem", { name: /多头注意力的作用/ });
    expect(current).toHaveAttribute("aria-selected", "true");
    // 当前节点自身默认不展开
    expect(current).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(current).toHaveFocus());

    const breadcrumb = screen.getByRole("navigation", { name: "当前位置" });
    expect(breadcrumb).toHaveTextContent("理解注意力机制");
    expect(breadcrumb).toHaveTextContent("多头注意力的作用");
    expect(screen.getByText("多头注意力的作用", { selector: "[aria-current='page']" })).toBeInTheDocument();
  });

  it("方向键导航：↓ 移到下一行，→ 折叠节点先展开，← 折叠后回到父节点", async () => {
    const user = userEvent.setup();
    renderOverlay({ getResearchSessionNodeTree: async () => sampleTree() }, "node-b");

    await screen.findByRole("tree", { name: "研究节点树" });
    // 当前节点 node-b：祖先只有根，根展开，node-a 折叠
    const rootItem = await screen.findByRole("treeitem", { name: /理解注意力机制/ });
    await screen.findByRole("treeitem", { name: /位置编码/ });
    expect(rootItem).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("treeitem", { name: /注意力头的并行性/ })).not.toBeInTheDocument();

    // 焦点在 node-b，↑ 移到 node-a
    screen.getByRole("treeitem", { name: /位置编码/ }).focus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("treeitem", { name: /多头注意力的作用/ })).toHaveFocus();

    // → 展开 node-a，子节点出现；再 → 进入第一个子节点
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("treeitem", { name: /多头注意力的作用/ })).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("treeitem", { name: /注意力头的并行性/ })).toHaveFocus();

    // ← 回到父节点
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("treeitem", { name: /多头注意力的作用/ })).toHaveFocus();
  });

  it("Enter 跳转到焦点节点并导航到统一节点页", async () => {
    const user = userEvent.setup();
    renderOverlay({ getResearchSessionNodeTree: async () => sampleTree() }, "session-1");

    await screen.findByRole("tree", { name: "研究节点树" });
    await waitFor(() => expect(screen.getByRole("treeitem", { name: /理解注意力机制/ })).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent("/research/session-1/node/node-a"),
    );
  });

  it("点击节点标签跳转到对应节点页", async () => {
    const user = userEvent.setup();
    renderOverlay({ getResearchSessionNodeTree: async () => sampleTree() }, "session-1");

    await user.click(await screen.findByRole("button", { name: "位置编码" }));
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent("/research/session-1/node/node-b"),
    );
  });

  it("加载失败给出错误并可重试", async () => {
    const user = userEvent.setup();
    const getResearchSessionNodeTree = vi
      .fn<() => Promise<ResearchSessionNodeTreeItem[]>>()
      .mockRejectedValueOnce(new ApiRequestError(500, "internal_error", "boom"))
      .mockResolvedValueOnce(sampleTree());
    renderOverlay({ getResearchSessionNodeTree });

    expect(await screen.findByText(/暂时无法打开节点树/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("tree", { name: "研究节点树" })).toBeInTheDocument();
    expect(getResearchSessionNodeTree).toHaveBeenCalledTimes(2);
  });

  it("根节点是当前节点时面包屑只有一级且无链接", async () => {
    renderOverlay({ getResearchSessionNodeTree: async () => sampleTree() }, "session-1");

    await screen.findByRole("tree", { name: "研究节点树" });
    const breadcrumb = screen.getByRole("navigation", { name: "当前位置" });
    expect(breadcrumb.querySelectorAll("a")).toHaveLength(0);
    expect(screen.getByText("理解注意力机制", { selector: "[aria-current='page']" })).toBeInTheDocument();
  });
});

describe("nodeTreeTargetForPath", () => {
  it("节点页解析出会话与当前节点", () => {
    expect(nodeTreeTargetForPath("/research/session-1/node/node-a")).toEqual({ sessionId: "session-1", nodeId: "node-a" });
  });

  it("会话旧路由与阅读页回退到根节点", () => {
    expect(nodeTreeTargetForPath("/research/session-1")).toEqual({ sessionId: "session-1", nodeId: "session-1" });
    expect(nodeTreeTargetForPath("/research/session-1/reading/snap-1")).toEqual({ sessionId: "session-1", nodeId: "session-1" });
  });

  it("开始页与设置页不提供树入口", () => {
    expect(nodeTreeTargetForPath("/research/new")).toBeNull();
    expect(nodeTreeTargetForPath("/settings/ai-model")).toBeNull();
    expect(nodeTreeTargetForPath("/")).toBeNull();
  });
});
