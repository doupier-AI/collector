import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import { ServicesProvider, type AppServices } from "../../app/services";
import { ResearchMapSearch } from "./ResearchMapSearch";

function renderSearch(api: Partial<ApiClient>, search?: { query: string; matchedNodeIds?: readonly string[]; selectedNodeId?: string }) {
  const onSearchChange = vi.fn();
  const onRevealNode = vi.fn();
  const onOpenMatch = vi.fn();
  const services = { api, connectTaskEvents: vi.fn() } as unknown as AppServices;
  render(
    <ServicesProvider services={services}>
      <MemoryRouter>
        <ResearchMapSearch
          search={search}
          insideNodeIds={["inside"]}
          onSearchChange={onSearchChange}
          onRevealNode={onRevealNode}
          onOpenMatch={onOpenMatch}
        />
      </MemoryRouter>
    </ServicesProvider>,
  );
  return { onSearchChange, onRevealNode, onOpenMatch };
}

describe("ResearchMapSearch", () => {
  it("打开地图不会自动搜索或下载，只有提交后才保存查询", async () => {
    const searchResearch = vi.fn();
    const { onSearchChange } = renderSearch({ searchResearch });

    expect(searchResearch).not.toHaveBeenCalled();
    const input = screen.getByRole("searchbox", { name: "搜索全部研究内容" });
    await userEvent.setup().type(input, "  向量数据库  ");
    await userEvent.setup().click(screen.getByRole("button", { name: "搜索" }));

    expect(onSearchChange).toHaveBeenCalledWith({ query: "向量数据库" });
    expect(searchResearch).not.toHaveBeenCalled();
  });

  it("恢复查询后重跑当前索引，诚实分组范围内外并提供稳定命中入口", async () => {
    const searchResearch = vi.fn(async () => ({
      query: "向量数据库",
      mode: "keyword-only" as const,
      degradationReason: "model-not-installed" as const,
      groups: [
        {
          scope: "inside-current-scope" as const,
          nodes: [{
            nodeId: "inside",
            nodeLabel: "向量检索笔记",
            matches: [
              { field: "ai-body" as const, preview: "向量数据库可以减少重复扫描", locator: { kind: "message-semantic-range" as const, nodeId: "inside", messageId: "message-a", bodyVersionId: "body-a", fragmentId: "fragment-a", startOffset: 0, endOffset: 4 } },
              { field: "ai-body" as const, preview: "使用向量索引缩小候选范围", locator: { kind: "message-semantic-range" as const, nodeId: "inside", messageId: "message-a", bodyVersionId: "body-a", fragmentId: "fragment-b", startOffset: 20, endOffset: 24 } },
            ],
          }],
        },
        {
          scope: "outside-current-scope" as const,
          nodes: [{ nodeId: "outside", nodeLabel: "成本分析", matches: [{ field: "node-title" as const, preview: "成本分析", locator: { kind: "node-title" as const, nodeId: "outside" } }] }],
        },
      ],
    }));
    const callbacks = renderSearch({ searchResearch }, { query: "向量数据库" });

    expect(await screen.findByText("当前地图范围")).toBeInTheDocument();
    expect(screen.getByText("范围外相关内容")).toBeInTheDocument();
    expect(screen.getAllByText(/意思相近但用词不同的内容可能找不到/).length).toBeGreaterThan(0);
    expect(searchResearch).toHaveBeenCalledWith({ query: "向量数据库", insideNodeIds: ["inside"] });
    expect(callbacks.onSearchChange).toHaveBeenCalledWith({ query: "向量数据库", matchedNodeIds: ["inside", "outside"] });

    await userEvent.setup().click(screen.getByRole("button", { name: /向量检索笔记/ }));
    expect(callbacks.onRevealNode).toHaveBeenCalledWith("inside");
    const matches = screen.getByLabelText("向量检索笔记 的命中位置");
    expect(within(matches).getByText("向量数据库可以减少重复扫描")).toBeInTheDocument();
    expect(within(matches).getByText("使用向量索引缩小候选范围")).toBeInTheDocument();
    expect(within(matches).getAllByRole("button", { name: /打开 AI 正文第 [12] 处/ })).toHaveLength(2);
    await userEvent.setup().click(within(matches).getByRole("button", { name: /^打开 AI 正文第 1 处/ }));
    expect(callbacks.onOpenMatch).toHaveBeenCalledWith("inside", expect.objectContaining({ field: "ai-body" }));
  });

  it("请求失败时保留查询并允许原地重试", async () => {
    const searchResearch = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ query: "知识图谱", mode: "hybrid", groups: [] });
    renderSearch({ searchResearch }, { query: "知识图谱" });

    expect(await screen.findByRole("alert")).toHaveTextContent("操作没有完成，请重试。");
    await userEvent.setup().click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(searchResearch).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("没有找到相关内容")).toBeInTheDocument();
  });

  it.each(["model-not-installed", "model-downloading", "model-unavailable", "index-unavailable"] as const)(
    "%s 降级都说明不同措辞可能漏检",
    async (degradationReason) => {
      renderSearch({ searchResearch: async () => ({ query: "同义词", mode: "keyword-only", degradationReason, groups: [] }) }, { query: "同义词" });
      expect((await screen.findAllByText(/当前仅使用关键词搜索/)).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/意思相近但用词不同的内容可能找不到/).length).toBeGreaterThan(0);
    },
  );

  it("范围节点超过契约上限时省略分组信息而不是让搜索整体失败", async () => {
    const searchResearch = vi.fn(async () => ({ query: "向量数据库", mode: "keyword-only" as const, degradationReason: "model-not-installed" as const, groups: [] }));
    const services = { api: { searchResearch }, connectTaskEvents: vi.fn() } as unknown as AppServices;
    render(
      <ServicesProvider services={services}>
        <MemoryRouter>
          <ResearchMapSearch
            search={{ query: "向量数据库" }}
            insideNodeIds={Array.from({ length: 10_001 }, (_, index) => `node-${index}`)}
            onSearchChange={vi.fn()}
            onRevealNode={vi.fn()}
            onOpenMatch={vi.fn()}
          />
        </MemoryRouter>
      </ServicesProvider>,
    );

    await waitFor(() => expect(searchResearch).toHaveBeenCalledTimes(1));
    expect(searchResearch).toHaveBeenCalledWith({ query: "向量数据库" });
  });
});
