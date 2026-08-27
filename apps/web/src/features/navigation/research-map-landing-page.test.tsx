import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ResearchGraphObservationInput } from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { ApiRequestError } from "../../api/errors";
import { ServicesProvider, type AppServices } from "../../app/services";
import { makeAssociationHint, makeEdge, makeGraphObservation, makeGraphObservationNode, makeProject } from "../../test/fakes";
import { ResearchMapLandingPage } from "./ResearchMapLandingPage";
import { serializeMapScene } from "./map-scene";
import { DEFAULT_RESEARCH_MAP_FILTER_STATE } from "./research-map-filters";

function renderPage(api: Partial<ApiClient>, initialEntry: string | { pathname: string; state: unknown } = "/map") {
  const services = { api: { listProjects: async () => [], ...api }, connectTaskEvents: vi.fn() } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="map" element={<ResearchMapLandingPage />} />
          <Route path="map/focus/:focusNodeId" element={<ResearchMapLandingPage />} />
          <Route path="research/new" element={<p>新建会话页</p>} />
          <Route path="nodes/:nodeId" element={<p>节点页</p>} />
          <Route path="trash" element={<p>回收站页</p>} />
        </Routes>
      </MemoryRouter>
    </ServicesProvider>,
  );
}

async function openMapTool(name: "搜索研究内容" | "筛选地图" | "显示的关系" | "临时融合（1）" | "更多地图功能") {
  const button = screen.getByRole("button", { name });
  if (button.getAttribute("aria-expanded") !== "true") await userEvent.setup().click(button);
}

describe("ResearchMapLandingPage", () => {
  it("临时融合只在当前地图现场显式开启，并通过详情读取当前草案", async () => {
    const source = { id: "source-1", temporaryFusionNodeId: "temporary-1", sourceNodeId: "a", sourceKind: "formal" as const, bodyVersionId: "body-a", fragmentIds: ["fragment-a"], sourceHealth: "available" as const, createdAt: "2026-08-26T00:00:00.000Z" };
    const item = { node: { id: "temporary-1", creationKey: "key", triggerProposalId: "proposal", activeDraftVersionId: "draft", status: "active" as const, createdAt: source.createdAt, updatedAt: source.createdAt }, label: "临时融合草稿", evidenceStatus: "verified" as const, candidateSources: [source] };
    const getResearchMap = vi.fn(async (input: ResearchGraphObservationInput = {}) => ({
      ...makeGraphObservation({ nodes: [makeGraphObservationNode("a", "节点 A")] }),
      temporaryFusionCount: 1,
      ...(input.includeTemporaryFusions ? { temporaryFusions: [item] } : {}),
    }));
    const getTemporaryFusion = vi.fn(async () => ({ ...item, activeDraft: { id: "draft", temporaryFusionNodeId: "temporary-1", version: 1, body: "当前临时草案", contentHash: "hash", evidenceStatus: "verified" as const, createdAt: source.createdAt } }));
    renderPage({ getResearchMap, listTemporaryFusions: async () => [item], getTemporaryFusion, searchTemporaryFusions: async () => ({ matches: [] }) });
    const user = userEvent.setup();
    await screen.findByTestId("global-map-canvas");
    await openMapTool("临时融合（1）");
    expect(screen.getByText(/开启后在同一张地图上查看待核验的临时融合/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开启临时层" }));
    await waitFor(() => expect(getResearchMap).toHaveBeenLastCalledWith(expect.objectContaining({ includeTemporaryFusions: true })));
    expect(screen.getByText("临时融合观察")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /临时融合草稿/ }));
    expect(await screen.findByText("当前临时草案")).toBeInTheDocument();
    expect(getTemporaryFusion).toHaveBeenCalledWith("temporary-1");
  });

  it("读取期间呈现明确的加载状态", () => {
    renderPage({ getResearchMap: () => new Promise(() => {}) });
    expect(screen.getByLabelText("正在打开研究图谱")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("navigation", { name: "研究图谱工具" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "筛选地图" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "新建会话" })).toHaveAttribute("href", "/research/new");
  });

  it("读取失败时说明状态并允许重试", async () => {
    const getResearchMap = vi
      .fn<() => Promise<ReturnType<typeof makeGraphObservation>>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(makeGraphObservation());
    renderPage({ getResearchMap });

    expect(await screen.findByRole("heading", { name: "暂时无法打开研究图谱" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "研究图谱工具" })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText(/还没有研究节点/)).toBeInTheDocument();
    expect(getResearchMap).toHaveBeenCalledTimes(2);
  });

  it("空状态可直接开始第一次研究", async () => {
    renderPage({ getResearchMap: async () => makeGraphObservation() });
    const link = await screen.findByRole("link", { name: "开始第一次研究" });
    expect(link).toHaveAttribute("href", "/research/new");
  });

  it("认证失效时回到可重新配对的安全入口", async () => {
    renderPage({ getResearchMap: async () => { throw new ApiRequestError(401, "unauthorized", "unauthorized"); } });
    expect(await screen.findByRole("heading", { name: "配对 Collector" })).toBeInTheDocument();
    expect(screen.getByLabelText("配对码")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "研究图谱工具" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "筛选地图" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "新建会话" })).toHaveAttribute("href", "/research/new");
  });

  it("同一观察结果呈现跨会话、归档、孤立与融合节点，并只使用稳定节点地址", async () => {
    const active = makeGraphObservationNode("active", "注意力机制");
    const archived = makeGraphObservationNode("archived", "已归档会话", { lifecycle: "archived" });
    const isolated = makeGraphObservationNode("isolated", "孤立根节点");
    const fusion = makeGraphObservationNode("fusion", "跨会话综合", {
      role: "fusion",
      fusionEvidenceHealth: "available",
      node: { ...makeGraphObservationNode("fusion", "跨会话综合").node, isFusionNode: true },
    });
    renderPage({
      getResearchMap: async () => makeGraphObservation({
        nodes: [active, archived, isolated, fusion],
        edges: [{ edge: { ...makeEdge("fused-from", "active", "fusion"), kind: "fused-from" }, connectivity: "default" }],
      }),
    });

    expect(await screen.findByTestId("global-map-canvas")).toBeInTheDocument();
    expect(screen.getByTestId("global-map-list")).toBeInTheDocument();
    expect(screen.getAllByLabelText(/注意力机制，未分类，研究节点，活跃/)).toHaveLength(2);
    expect(screen.getAllByLabelText(/已归档会话，未分类，研究节点，已归档/)).toHaveLength(2);
    expect(screen.getAllByLabelText(/孤立根节点/)).toHaveLength(2);
    const fusionTargets = screen.getAllByLabelText(/跨会话综合，未分类，融合成果/);
    expect(fusionTargets).toHaveLength(2);
    expect(fusionTargets[1]).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("global-map-canvas").querySelector('[data-edge-kind="fused-from"]')).not.toBeNull();
    await openMapTool("更多地图功能");
    expect(screen.getByLabelText("地图摘要")).toHaveTextContent("4 个节点");
    expect(screen.getByRole("link", { name: "新建会话" })).toHaveAttribute("href", "/research/new");
    expect(screen.getByRole("link", { name: "回收站" })).toHaveAttribute("href", "/trash");
  });

  it("边缘工具一次只展开一个，Escape 关闭并把焦点还给图标", async () => {
    renderPage({ getResearchMap: async () => makeGraphObservation({ nodes: [makeGraphObservationNode("a", "节点 A")] }) });
    const user = userEvent.setup();
    await screen.findByTestId("global-map-canvas");

    await user.click(screen.getByRole("button", { name: "搜索研究内容" }));
    expect(screen.getByRole("searchbox", { name: "搜索全部研究内容" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "筛选地图" }));
    expect(screen.queryByRole("searchbox", { name: "搜索全部研究内容" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "已归档" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("checkbox", { name: "已归档" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "筛选地图" })).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "筛选地图" }));
    Object.defineProperty(screen.getByTestId("global-map-canvas"), "setPointerCapture", { value: vi.fn() });
    fireEvent.pointerDown(document.querySelector(".global-map__pan-surface")!);
    expect(screen.queryByRole("checkbox", { name: "已归档" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "筛选地图" })).toHaveFocus());
  });

  it("窄屏默认保留画布，并可临时切换到同源节点列表", async () => {
    renderPage({ getResearchMap: async () => makeGraphObservation({ nodes: [makeGraphObservationNode("a", "节点 A")] }) });
    const user = userEvent.setup();
    await screen.findByTestId("global-map-canvas");
    const region = screen.getByRole("region", { name: "全部研究节点" });
    expect(region).toHaveClass("global-map--presentation-canvas");

    await user.click(screen.getByRole("button", { name: "切换到节点列表" }));
    expect(region).toHaveClass("global-map--presentation-list");
    expect(screen.getByRole("button", { name: "切换到地图画布" })).toBeInTheDocument();
  });

  it("点击专注时保留同一画布并用局部更新状态等待新观察", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const observation = makeGraphObservation({ nodes: [makeGraphObservationNode("a", "节点 A")] });
    const pending = new Promise<never>(() => {});
    const getResearchMap = vi.fn().mockResolvedValueOnce(observation).mockReturnValue(pending);
    renderPage({ getResearchMap });
    const user = userEvent.setup();
    const canvas = await screen.findByTestId("global-map-canvas");
    await user.click(within(canvas).getByRole("button", { name: /节点 A/ }));

    expect(await screen.findByText("正在更新地图…")).toBeInTheDocument();
    expect(screen.getByTestId("global-map-canvas")).toBe(canvas);
    expect(screen.queryByLabelText("正在打开研究图谱")).not.toBeInTheDocument();
    await waitFor(() => expect(getResearchMap).toHaveBeenCalledTimes(2));
    vi.unstubAllGlobals();
  });

  it("空结果也把筛选保存到当前 history entry，刷新可恢复同一现场", async () => {
    window.history.replaceState({ idx: 0, key: "map-empty", usr: null }, "");
    renderPage({
      getResearchMap: async () => makeGraphObservation(),
      searchResearch: async ({ query }) => ({ query, mode: "keyword-only", degradationReason: "model-not-installed", groups: [] }),
    });
    const user = userEvent.setup();

    await screen.findByRole("link", { name: "开始第一次研究" });
    await openMapTool("搜索研究内容");
    await user.type(screen.getByRole("searchbox", { name: "搜索全部研究内容" }), "量子纠缠");
    await user.click(screen.getByRole("button", { name: "搜索" }));
    await waitFor(() => expect(window.history.state.usr?.mapSceneV2?.search?.query).toBe("量子纠缠"));
    await openMapTool("筛选地图");
    await user.click(screen.getByRole("checkbox", { name: "已归档" }));

    await waitFor(() => expect(window.history.state.usr?.mapSceneV2?.filters?.lifecycles).toEqual(["active"]));
    expect(window.history.state.usr.mapSceneV2.search.query).toBe("量子纠缠");
    expect(window.history.state.usr.mapSceneV2.layout.positions).toEqual([]);
  });

  it("恢复的搜索选中项只保留现场，不会在新挂载时重新居中或抢焦点", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    const scene = serializeMapScene({
      filters: DEFAULT_RESEARCH_MAP_FILTER_STATE,
      relationshipKinds: ["parent-child", "fused-from"],
      search: { query: "量子", selectedNodeId: "b" },
      viewBox: { x: 0, y: 0, width: 480, height: 270 },
      layout: {
        world: { width: 960, height: 540 },
        positions: new Map([["a", { x: 100, y: 100 }], ["b", { x: 800, y: 400 }]]),
        edgeKeys: new Map(),
      },
    });
    renderPage({
      getResearchMap: async () => makeGraphObservation({ nodes: [makeGraphObservationNode("a", "节点 A"), makeGraphObservationNode("b", "节点 B")] }),
      searchResearch: async ({ query }) => ({ query, mode: "hybrid", groups: [] }),
    }, { pathname: "/map", state: { mapSceneV2: scene } });

    const canvas = await screen.findByTestId("global-map-canvas");
    const svg = within(canvas).getByRole("group", { name: "跨会话研究关系画布" });
    await waitFor(() => expect(svg).toHaveAttribute("viewBox", "0 0 480 270"));
    expect(document.activeElement).not.toBe(within(canvas).getByLabelText(/节点 B/));
    vi.unstubAllGlobals();
  });

  it("已有空结果后的更新失败仍明确显示网络错误", async () => {
    const getResearchMap = vi.fn()
      .mockResolvedValueOnce(makeGraphObservation())
      .mockRejectedValueOnce(new Error("offline"));
    renderPage({ getResearchMap });
    const user = userEvent.setup();

    await screen.findByRole("link", { name: "开始第一次研究" });
    await openMapTool("筛选地图");
    await user.click(screen.getByRole("checkbox", { name: "已归档" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("操作没有完成，请重试。");
    expect(screen.getByText("当前筛选没有匹配的研究节点，地图事实没有被删除。")).toBeInTheDocument();
  });

  it("专注地址把焦点和永久关系开关交给同一观察请求，退出时回到全图", async () => {
    const focusObservation = {
      ...makeGraphObservation({
      nodes: [{ ...makeGraphObservationNode("focus", "焦点节点"), connectivity: "focus" as const }],
      }),
      focusNodeId: "focus",
    };
    const getResearchMap = vi.fn(async () => focusObservation);
    renderPage({ getResearchMap }, "/map/focus/focus");

    expect(await screen.findByText(/正在专注：/)).toHaveTextContent("焦点节点");
    expect(getResearchMap).toHaveBeenCalledWith({ focusNodeId: "focus", lifecycles: ["active", "archived"], relationshipKinds: ["parent-child", "fused-from"] });
    await userEvent.setup().click(screen.getByRole("button", { name: "退出专注" }));
    await waitFor(() => expect(getResearchMap).toHaveBeenLastCalledWith({ lifecycles: ["active", "archived"], relationshipKinds: ["parent-child", "fused-from"] }));
  });

  it("请求仍在进行时连续关闭两类关系，保留两次即时意图并最终请求空关系集", async () => {
    const focusObservation = {
      ...makeGraphObservation({
        nodes: [{ ...makeGraphObservationNode("focus", "焦点节点"), connectivity: "focus" as const }],
      }),
      focusNodeId: "focus",
    };
    const pending = new Promise<never>(() => {});
    const getResearchMap = vi.fn()
      .mockResolvedValueOnce(focusObservation)
      .mockReturnValue(pending);
    renderPage({ getResearchMap }, "/map/focus/focus");

    await screen.findByTestId("global-map-canvas");
    await openMapTool("显示的关系");
    const parentToggle = screen.getByRole("button", { name: "父子生长" });
    const fusionToggle = screen.getByRole("button", { name: "融合来源" });
    const user = userEvent.setup();
    await user.click(parentToggle);
    await user.click(fusionToggle);

    expect(parentToggle).toHaveAttribute("aria-pressed", "false");
    expect(fusionToggle).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(getResearchMap).toHaveBeenLastCalledWith({ focusNodeId: "focus", lifecycles: ["active", "archived"], relationshipKinds: [] }));
  });

  it("把项目、未分类、日期和生命周期组合成同一地图观察请求", async () => {
    const getResearchMap = vi.fn(async () => makeGraphObservation({ nodes: [makeGraphObservationNode("a", "节点 A")] }));
    renderPage({
      listProjects: async () => [makeProject({ id: "project-a", name: "项目 A" })],
      getResearchMap,
    });
    const user = userEvent.setup();

    await screen.findByTestId("global-map-canvas");
    await openMapTool("筛选地图");
    await user.click(screen.getByRole("checkbox", { name: "项目 A" }));
    await user.click(screen.getByRole("checkbox", { name: "未分类" }));
    await user.click(screen.getByRole("checkbox", { name: "已归档" }));
    await user.type(screen.getByLabelText("开始日期"), "2026-08-20");
    await user.type(screen.getByLabelText("结束日期"), "2026-08-21");

    await waitFor(() => expect(getResearchMap).toHaveBeenLastCalledWith(expect.objectContaining({
      projectIds: ["project-a"],
      includeUncategorized: true,
      lifecycles: ["active"],
      createdFrom: new Date(2026, 7, 20).toISOString(),
      createdBefore: new Date(2026, 7, 22).toISOString(),
    })));
  });

  it("日期范围无效时保留当前地图且不发出错误请求", async () => {
    const getResearchMap = vi.fn(async () => makeGraphObservation({ nodes: [makeGraphObservationNode("a", "节点 A")] }));
    renderPage({ getResearchMap });
    const user = userEvent.setup();

    await screen.findByTestId("global-map-canvas");
    await openMapTool("筛选地图");
    await user.type(screen.getByLabelText("开始日期"), "2026-08-21");
    await waitFor(() => expect(getResearchMap).toHaveBeenCalledTimes(2));
    await user.type(screen.getByLabelText("结束日期"), "2026-08-20");

    expect(await screen.findByRole("alert")).toHaveTextContent("开始日期不能晚于结束日期。");
    expect(screen.getByTestId("global-map-canvas")).toBeInTheDocument();
    expect(getResearchMap).toHaveBeenCalledTimes(2);
  });

  it("opens exact global and node-scoped candidate observations without changing the A-plane scene", async () => {
    window.history.replaceState({ idx: 0, key: "candidate-map", usr: null }, "");
    const hint = makeAssociationHint({ anchorNodeId: "a", relatedNodeId: "b" });
    const base = {
      ...makeGraphObservation({ nodes: [
        makeGraphObservationNode("a", "节点 A", { candidateCount: 1 }),
        makeGraphObservationNode("b", "节点 B", { candidateCount: 1 }),
      ] }),
      activeCandidateCount: 1,
    };
    const getResearchMap = vi.fn(async (input: ResearchGraphObservationInput = {}) => input.includeAssociationHints
      ? { ...base, associationHints: [hint] }
      : base);
    renderPage({ getResearchMap, getResearchBodyVersion: async () => { throw new Error("preview unavailable"); } });
    const user = userEvent.setup();
    const canvas = await screen.findByTestId("global-map-canvas");
    const transformsBefore = [...canvas.querySelectorAll<SVGGElement>("[data-node-id]")].map((node) => node.getAttribute("transform"));

    await user.click(screen.getByRole("button", { name: "查看 1 条关联候选" }));

    expect(await screen.findByRole("region", { name: "关联候选" })).toHaveTextContent("临时观察");
    expect(screen.getByRole("region", { name: "关联候选" })).toHaveTextContent("不会建立永久关系");
    expect(canvas.closest(".global-map")).toHaveClass("global-map--candidate-mode");
    expect(getResearchMap).toHaveBeenCalledWith(expect.objectContaining({ includeAssociationHints: true }));
    expect(window.history.state.usr.mapSceneV2.associationCandidates).toEqual({ kind: "all" });

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("region", { name: "关联候选" })).not.toBeInTheDocument());
    expect([...canvas.querySelectorAll<SVGGElement>("[data-node-id]")].map((node) => node.getAttribute("transform"))).toEqual(transformsBefore);
    expect(window.history.state.usr.mapSceneV2.associationCandidates).toBeUndefined();

    await user.click(within(canvas).getByRole("button", { name: "查看节点 A的1条关联候选" }));
    await screen.findByText("节点 A的候选");
    expect(getResearchMap).toHaveBeenCalledWith(expect.objectContaining({
      includeAssociationHints: true,
      associationCandidateNodeId: "a",
    }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(within(canvas).getByRole("button", { name: "查看节点 A的1条关联候选" })).toHaveFocus());
  });

  it("候选读取使失效证据过期后同步刷新工具坞与节点卫星计数", async () => {
    const counted = {
      ...makeGraphObservation({ nodes: [
        makeGraphObservationNode("a", "节点 A", { candidateCount: 1 }),
        makeGraphObservationNode("b", "节点 B", { candidateCount: 1 }),
      ] }),
      activeCandidateCount: 1,
    };
    const reconciled = makeGraphObservation({ nodes: [
      makeGraphObservationNode("a", "节点 A"),
      makeGraphObservationNode("b", "节点 B"),
    ] });
    let detailsRead = false;
    const getResearchMap = vi.fn(async (input: ResearchGraphObservationInput = {}) => {
      if (input.includeAssociationHints) {
        detailsRead = true;
        return { ...reconciled, associationHints: [] };
      }
      return detailsRead ? reconciled : counted;
    });
    renderPage({ getResearchMap });
    const user = userEvent.setup();
    const canvas = await screen.findByTestId("global-map-canvas");

    await user.click(screen.getByRole("button", { name: "查看 1 条关联候选" }));
    expect(await screen.findByRole("region", { name: "关联候选" })).toHaveTextContent("当前没有可查看的关联候选");

    await waitFor(() => expect(screen.getByRole("button", { name: "查看 0 条关联候选" })).toBeDisabled());
    expect(within(canvas).queryByRole("button", { name: /查看节点 A的1条关联候选/ })).not.toBeInTheDocument();
    expect(getResearchMap).toHaveBeenCalledWith(expect.not.objectContaining({ includeAssociationHints: true }));
    await user.click(screen.getByRole("button", { name: "关闭关联候选" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "返回" })).toHaveFocus());
  });

  it("非空地图的新筛选请求失败时仍立即保存当前有效筛选", async () => {
    window.history.replaceState({ idx: 0, key: "map-filter-error", usr: null }, "");
    const getResearchMap = vi.fn()
      .mockResolvedValueOnce(makeGraphObservation({ nodes: [makeGraphObservationNode("a", "节点 A")] }))
      .mockRejectedValueOnce(new Error("offline"));
    renderPage({ getResearchMap });

    await screen.findByTestId("global-map-canvas");
    await openMapTool("筛选地图");
    await userEvent.setup().click(screen.getByRole("checkbox", { name: "已归档" }));

    await screen.findByRole("alert");
    await waitFor(() => expect(window.history.state.usr?.mapSceneV2?.filters?.lifecycles).toEqual(["active"]));
    expect(screen.getByTestId("global-map-canvas")).toBeInTheDocument();
  });

  it("清除筛选请求失败后再次保存仍保留筛选前隐藏节点的位置", async () => {
    window.history.replaceState({ idx: 0, key: "map-clear-error", usr: null }, "");
    const allNodes = [
      makeGraphObservationNode("a", "节点 A"),
      makeGraphObservationNode("b", "节点 B", { lifecycle: "archived" }),
      makeGraphObservationNode("c", "节点 C"),
      makeGraphObservationNode("u", "节点 U"),
    ];
    const allEdges = [{
      edge: { ...makeEdge("parent-child", "a", "b"), kind: "parent-child" as const },
      connectivity: "default" as const,
    }];
    const getResearchMap = vi.fn()
      .mockResolvedValueOnce(makeGraphObservation({ nodes: allNodes, edges: allEdges }))
      .mockResolvedValueOnce(makeGraphObservation({ nodes: allNodes.filter((node) => node.lifecycle === "active") }))
      .mockRejectedValueOnce(new Error("offline"));
    renderPage({ getResearchMap });
    const user = userEvent.setup();

    await screen.findByTestId("global-map-canvas");
    await openMapTool("筛选地图");
    await waitFor(() => {
      expect(window.history.state.usr?.mapSceneV2?.layout?.positions).toHaveLength(4);
      expect(window.history.state.usr?.mapSceneV2?.layout?.edgeKeys).toHaveLength(1);
    });
    const initialLayout = structuredClone(window.history.state.usr.mapSceneV2.layout);

    await user.click(screen.getByRole("checkbox", { name: "已归档" }));
    await waitFor(() => expect(screen.getByTestId("global-map-canvas").querySelector('[data-node-id="b"]')).toBeNull());

    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    await screen.findByRole("alert");
    const viewBoxBeforeZoom = structuredClone(window.history.state.usr.mapSceneV2.viewBox);
    await user.click(screen.getByRole("button", { name: "放大地图" }));

    await waitFor(() => {
      expect(window.history.state.usr?.mapSceneV2?.filters).toEqual({
        projectScope: { kind: "all" },
        lifecycles: ["active", "archived"],
      });
      expect(window.history.state.usr?.mapSceneV2?.viewBox.width).toBeLessThan(viewBoxBeforeZoom.width);
    });
    expect(window.history.state.usr.mapSceneV2.layout).toEqual(initialLayout);
  });
});
