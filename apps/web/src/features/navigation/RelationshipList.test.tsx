import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type {
  ResearchEdgeRecord,
  ResearchGraphProjection,
  ResearchGraphNodeSummary,
} from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { ApiRequestError } from "../../api/errors";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeNode } from "../../test/fakes";
import { RelationshipList } from "./RelationshipList";
import { EDGE_KIND_LABELS, groupRelationships } from "./useRelationships";

function graphNode(
  id: string,
  label: string,
  depth: number,
  options: { parentNodeId?: string } = {},
): ResearchGraphNodeSummary {
  return {
    node: makeNode({
      id,
      sessionId: "session-1",
      parentNodeId: options.parentNodeId,
      createdAt: "2026-08-01T08:00:00.000Z",
    }),
    label,
    depth,
  };
}

function edge(
  kind: ResearchEdgeRecord["kind"],
  fromNodeId: string,
  toNodeId: string,
  status: ResearchEdgeRecord["status"] = "active",
): ResearchEdgeRecord {
  return {
    id: `edge:${kind}:${fromNodeId}:${toNodeId}`,
    kind,
    fromNodeId,
    toNodeId,
    createdAt: "2026-08-01T08:00:00.000Z",
    status,
  };
}

function sampleProjection(): ResearchGraphProjection {
  return {
    focusNodeId: "focus-node",
    nodes: [
      graphNode("focus-node", "Transformer 架构", 0),
      graphNode("parent-node", "深度学习基础", -1, { parentNodeId: undefined }),
      graphNode("child-node", "注意力头", 1, { parentNodeId: "focus-node" }),
      graphNode("related-node", "位置编码", 1),
      graphNode("fused-node", "编码器融合", 1),
    ],
    edges: [
      edge("parent-child", "parent-node", "focus-node"),
      edge("parent-child", "focus-node", "child-node"),
      edge("semantic-related", "focus-node", "related-node"),
      edge("fused-from", "fused-node", "focus-node"),
    ],
  };
}

describe("groupRelationships 纯函数", () => {
  it("按边类型分组，区分出方向，跳过已删除的边", () => {
    const projection = sampleProjection();
    const groups = groupRelationships(projection);

    expect(groups).toHaveLength(3);
    expect(groups[0].kind).toBe("parent-child");
    expect(groups[0].label).toBe("父子关系");
    expect(groups[0].items).toHaveLength(2);

    // parent-child: parent-node → focus（incoming）, focus → child-node（outgoing）
    const incoming = groups[0].items.find((item) => item.direction === "incoming");
    const outgoing = groups[0].items.find((item) => item.direction === "outgoing");
    expect(incoming?.neighbor.label).toBe("深度学习基础");
    expect(outgoing?.neighbor.label).toBe("注意力头");

    // 语义相关
    expect(groups[1].kind).toBe("semantic-related");
    expect(groups[1].items).toHaveLength(1);
    expect(groups[1].items[0].neighbor.label).toBe("位置编码");

    // 融合来源
    expect(groups[2].kind).toBe("fused-from");
    expect(groups[2].items).toHaveLength(1);
    expect(groups[2].items[0].neighbor.label).toBe("编码器融合");
  });

  it("只包含有数据的边类型分组", () => {
    const projection: ResearchGraphProjection = {
      focusNodeId: "focus",
      nodes: [graphNode("focus", "焦点", 0), graphNode("neighbor", "邻居", 1)],
      edges: [edge("semantic-related", "focus", "neighbor")],
    };
    const groups = groupRelationships(projection);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("semantic-related");
  });

  it("过滤掉已删除的边", () => {
    const projection: ResearchGraphProjection = {
      focusNodeId: "focus",
      nodes: [graphNode("focus", "焦点", 0), graphNode("neighbor", "邻居", 1)],
      edges: [edge("semantic-related", "focus", "neighbor", "deleted")],
    };
    const groups = groupRelationships(projection);
    expect(groups).toHaveLength(0);
  });
});

function renderList(api: Partial<ApiClient>, focusNodeId = "focus-node") {
  const services = { api: api as ApiClient } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={[`/research/session-1/node/${focusNodeId}`]}>
        <RelationshipList sessionId="session-1" focusNodeId={focusNodeId} onClose={() => {}} />
        <LocationProbe />
      </MemoryRouter>
    </ServicesProvider>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}</div>;
}

describe("RelationshipList 组件", () => {
  it("渲染焦点节点与三种边类型的分组", async () => {
    renderList({ getResearchGraph: async () => sampleProjection() });

    // 等待加载完成
    await screen.findByRole("list", { name: "节点关系列表" });

    // 焦点节点显示
    expect(screen.getByText(/焦点：/)).toHaveTextContent("Transformer 架构");

    // 三个分组标题
    expect(screen.getByText("父子关系")).toBeInTheDocument();
    expect(screen.getByText("语义相关")).toBeInTheDocument();
    expect(screen.getByText("融合来源")).toBeInTheDocument();

    // 各邻居节点标签可见
    expect(screen.getByRole("button", { name: "深度学习基础" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "注意力头" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "位置编码" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编码器融合" })).toBeInTheDocument();
  });

  it("按边类型筛选分组，并在全部关闭时保留清晰空态", async () => {
    const user = userEvent.setup();
    renderList({ getResearchGraph: async () => sampleProjection() });

    await screen.findByRole("list", { name: "节点关系列表" });
    await user.click(screen.getByTestId("relationship-filter-semantic-related"));
    await user.click(screen.getByTestId("relationship-filter-fused-from"));

    expect(screen.getByTestId("relationship-filter-parent-child")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "注意力头" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "深度学习基础" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "位置编码" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编码器融合" })).not.toBeInTheDocument();
    expect(screen.queryByText("语义相关")).not.toBeInTheDocument();
    expect(screen.queryByText("融合来源")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("relationship-filter-parent-child"));
    expect(await screen.findByText("当前节点没有可见的关系。")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "节点关系列表" })).not.toBeInTheDocument();
  });

  it("键盘导航：↓ 在条目之间移动，Enter 跳转到节点", async () => {
    const user = userEvent.setup();
    renderList({ getResearchGraph: async () => sampleProjection() });

    await screen.findByRole("list", { name: "节点关系列表" });

    // 焦点自动落在第一个条目
    const items = screen.getAllByRole("listitem");
    expect(items.length).toBeGreaterThanOrEqual(4);
    await waitFor(() => expect(items[0]).toHaveFocus());

    // ↓ 移到第二个条目
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(items[1]).toHaveFocus());

    // ↓ 再移到第三个
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(items[2]).toHaveFocus());

    // ↑ 回到第二个
    await user.keyboard("{ArrowUp}");
    await waitFor(() => expect(items[1]).toHaveFocus());

    // Enter 跳转到第二个条目对应的节点
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent("/research/session-1/node/"),
    );
  });


  it("每个条目的 aria-label 包含边类型、方向和深度信息", async () => {
    renderList({ getResearchGraph: async () => sampleProjection() });

    await screen.findByRole("list", { name: "节点关系列表" });

    const items = screen.getAllByRole("listitem");

    // 第一个条目：父子关系 incoming（parent → focus），深度 -1 → "上层"
    const parentChildIncoming = items.find((item) =>
      item.getAttribute("aria-label")?.includes("深度学习基础"),
    );
    expect(parentChildIncoming).toHaveAttribute(
      "aria-label",
      expect.stringContaining("父子关系"),
    );
    expect(parentChildIncoming).toHaveAttribute(
      "aria-label",
      expect.stringContaining("←"),
    );
    expect(parentChildIncoming).toHaveAttribute(
      "aria-label",
      expect.stringContaining("上层"),
    );

    // 语义相关 outgoing（focus → related），深度 1 → "邻居"
    const semanticItem = items.find((item) =>
      item.getAttribute("aria-label")?.includes("位置编码"),
    );
    expect(semanticItem).toHaveAttribute(
      "aria-label",
      expect.stringContaining("语义相关"),
    );
    expect(semanticItem).toHaveAttribute(
      "aria-label",
      expect.stringContaining("→"),
    );
    expect(semanticItem).toHaveAttribute(
      "aria-label",
      expect.stringContaining("邻居"),
    );
  });

  it("Escape 关闭覆盖层", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const services = {
      api: { getResearchGraph: async () => sampleProjection() } as unknown as ApiClient,
    } as unknown as AppServices;
    render(
      <ServicesProvider services={services}>
        <MemoryRouter>
          <RelationshipList sessionId="session-1" focusNodeId="focus-node" onClose={onClose} />
        </MemoryRouter>
      </ServicesProvider>,
    );

    await screen.findByRole("list", { name: "节点关系列表" });

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("加载失败显示错误和重试按钮", async () => {
    const user = userEvent.setup();
    const getResearchGraph = vi
      .fn<() => Promise<ResearchGraphProjection>>()
      .mockRejectedValueOnce(new ApiRequestError(500, "internal_error", "boom"))
      .mockResolvedValueOnce(sampleProjection());
    renderList({ getResearchGraph });

    expect(await screen.findByText(/暂时无法加载关系列表/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("list", { name: "节点关系列表" })).toBeInTheDocument();
    expect(getResearchGraph).toHaveBeenCalledTimes(2);
  });

  it("空投影显示空状态提示", async () => {
    renderList({
      getResearchGraph: async () => ({
        focusNodeId: "lonely",
        nodes: [graphNode("lonely", "孤立节点", 0)],
        edges: [],
      }),
    });

    expect(await screen.findByText(/当前节点没有可见的关系/)).toBeInTheDocument();
  });

  it("点击邻居节点标签跳转到对应节点页", async () => {
    const user = userEvent.setup();
    renderList({ getResearchGraph: async () => sampleProjection() });

    await screen.findByRole("list", { name: "节点关系列表" });
    await user.click(screen.getByRole("button", { name: "位置编码" }));
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent(
        "/research/session-1/node/related-node",
      ),
    );
  });
});

describe("EDGE_KIND_LABELS", () => {
  it("三种边类型都有中文标签", () => {
    expect(EDGE_KIND_LABELS["parent-child"]).toBe("父子关系");
    expect(EDGE_KIND_LABELS["semantic-related"]).toBe("语义相关");
    expect(EDGE_KIND_LABELS["fused-from"]).toBe("融合来源");
  });
});
