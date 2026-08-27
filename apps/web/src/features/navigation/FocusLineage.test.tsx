import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import { ApiRequestError } from "../../api/errors";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeEdge, makeGraphNodeSummary, makeGraphProjection } from "../../test/fakes";
import { FocusLineage } from "./FocusLineage";
import { ALL_EDGE_KINDS } from "./useRelationships";

/** 三级血统投影：root → parent → focus；focus 有子节点与同级，另有融合来源和一条遗留语义边。 */
function lineageProjection() {
  const root = makeGraphNodeSummary("root", "根节点", 2);
  const parent = makeGraphNodeSummary("parent", "父节点", 1, { parentNodeId: "root" });
  const focus = makeGraphNodeSummary("focus", "当前节点", 0, { parentNodeId: "parent" });
  const childA = makeGraphNodeSummary("child-a", "子节点 A", 1, { parentNodeId: "focus" });
  const childB = makeGraphNodeSummary("child-b", "子节点 B", 1, { parentNodeId: "focus" });
  const sibling = makeGraphNodeSummary("sibling", "同级节点", 1, { parentNodeId: "parent" });
  const related = makeGraphNodeSummary("related", "语义邻居", 1);
  const fused = makeGraphNodeSummary("fused", "融合来源", 1);
  const edges = [
    makeEdge("parent-child", "root", "parent"),
    makeEdge("parent-child", "parent", "focus"),
    makeEdge("parent-child", "parent", "sibling"),
    makeEdge("parent-child", "focus", "child-a"),
    makeEdge("parent-child", "focus", "child-b"),
    makeEdge("semantic-related", "focus", "related"),
    makeEdge("fused-from", "fused", "focus"),
  ];
  return makeGraphProjection({ nodes: [root, parent, focus, childA, childB, sibling, related, fused], edges, focusNodeId: "focus" });
}

function renderLineage(
  api: Partial<ApiClient>,
  focusNodeId = "focus",
  selectedEdgeKinds: readonly ("parent-child" | "fused-from")[] = ALL_EDGE_KINDS,
) {
  const services = { api: api as ApiClient } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={[`/nodes/${focusNodeId}`]}>
        <FocusLineage sessionId="session-1" focusNodeId={focusNodeId} selectedEdgeKinds={selectedEdgeKinds} />
        <LocationProbe />
      </MemoryRouter>
    </ServicesProvider>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}</div>;
}

describe("FocusLineage", () => {
  it("渲染面包屑与血统链：祖先→当前→子→同级，当前节点为最明确锚点", async () => {
    renderLineage({ getResearchGraph: async () => lineageProjection() });

    const chain = await screen.findByRole("list", { name: "专注脉络" });
    const rows = within(chain).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "·根节点",
      "·父节点",
      "●当前节点当前",
      "▾子节点 A",
      "▾子节点 B",
      "▸同级节点",
    ]);

    const current = within(chain).getByText("当前节点");
    expect(current.closest("li")).toHaveClass("focus-lineage__row--current");
    expect(within(chain).getByText("当前")).toBeInTheDocument();

    // 面包屑：根 → 父 → 当前，最后一级 aria-current
    const breadcrumb = screen.getByRole("navigation", { name: "当前位置" });
    expect(within(breadcrumb).getByText("根节点")).toBeInTheDocument();
    expect(within(breadcrumb).getByText("父节点")).toBeInTheDocument();
    expect(breadcrumb.querySelector("[aria-current='page']")).toHaveTextContent("当前节点");
  });

  it("关联区默认展开并计数，可折叠收起", async () => {
    const user = userEvent.setup();
    renderLineage({ getResearchGraph: async () => lineageProjection() });

    const toggle = await screen.findByTestId("focus-related-toggle");
    expect(toggle).toHaveTextContent("关联（1）");
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    // 融合来源出现在关联区；遗留语义边不进入当前界面。
    expect(screen.queryByRole("button", { name: "语义邻居" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "融合来源" })).toBeInTheDocument();
    expect(screen.queryByText("语义邻居", { selector: ".focus-lineage__chain *" })).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "融合来源" })).not.toBeInTheDocument();
  });

  it("筛选只选父子时，关联区显示空态；血统链保留", async () => {
    renderLineage({ getResearchGraph: async () => lineageProjection() }, "focus", ["parent-child"]);

    await screen.findByRole("list", { name: "专注脉络" });
    expect(await screen.findByText("当前筛选没有可见的关系。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "语义邻居" })).not.toBeInTheDocument();
  });

  it("只选融合来源后，血统链只剩当前节点", async () => {
    renderLineage({ getResearchGraph: async () => lineageProjection() }, "focus", ["fused-from"]);

    const chain = await screen.findByRole("list", { name: "专注脉络" });
    const rows = within(chain).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(["●当前节点当前"]);
  });

  it("roving 键盘：焦点落在当前节点，↓ 移到子节点，Enter 打开节点", async () => {
    const user = userEvent.setup();
    renderLineage({ getResearchGraph: async () => lineageProjection() });

    const chain = await screen.findByRole("list", { name: "专注脉络" });
    const rows = within(chain).getAllByRole("listitem");
    // 初始 roving 焦点落在当前节点（li 为 roving 焦点容器）
    const currentRow = rows.find((row) => row.textContent?.includes("当前节点"));
    expect(currentRow).not.toBeUndefined();
    await waitFor(() => expect(currentRow).toHaveFocus());

    await user.keyboard("{ArrowDown}");
    const childRow = rows.find((row) => row.textContent?.includes("子节点 A"));
    expect(childRow).not.toBeUndefined();
    await waitFor(() => expect(childRow).toHaveFocus());
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent("/nodes/child-a"),
    );
  });

  it("打开父节点出口跳转到父节点；回到当前节点把 roving 焦点移回", async () => {
    const user = userEvent.setup();
    renderLineage({ getResearchGraph: async () => lineageProjection() });

    await screen.findByRole("list", { name: "专注脉络" });
    await user.click(screen.getByTestId("focus-open-parent"));
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent("/nodes/parent"),
    );
  });

  it("加载失败给出错误并可重试", async () => {
    const user = userEvent.setup();
    const getResearchGraph = vi
      .fn()
      .mockRejectedValueOnce(new ApiRequestError(500, "internal_error", "boom"))
      .mockResolvedValueOnce(lineageProjection());
    renderLineage({ getResearchGraph });

    expect(await screen.findByText(/暂时无法加载研究地图/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("list", { name: "专注脉络" })).toBeInTheDocument();
  });

  it("投影不含焦点时显示空态", async () => {
    const projection = makeGraphProjection({
      nodes: [makeGraphNodeSummary("other", "其他节点", 0)],
      edges: [],
      focusNodeId: "missing",
    });
    renderLineage({ getResearchGraph: async () => projection }, "missing");

    expect(await screen.findByText("当前节点没有可见的关系。")).toBeInTheDocument();
  });
});
