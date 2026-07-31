import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  ResearchLaterItemInput,
  ResearchLaterItemRecord,
  ResearchLaterItemUpdate,
  ResearchLaterItemView,
  ResearchSelectionAccepted,
  ResearchSelectionAnchor,
  ResearchSelectionInput,
} from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeSelection } from "../../test/fakes";
import { useSelectionMark } from "./useSelectionMark";

function makeAnchor(): ResearchSelectionAnchor {
  return {
    kind: "message",
    messageId: "m-out",
    blockOrdinal: 0,
    startOffset: 0,
    endOffset: 6,
    exact: "一段选区文字",
  };
}

function makeItemView(overrides: Partial<ResearchLaterItemRecord> = {}): ResearchLaterItemView {
  const item = {
    id: "later-1",
    selectionId: "sel-9",
    status: "pending",
    priority: 3,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  } as ResearchLaterItemRecord;
  return { item, selection: makeSelection({ id: "sel-9" }), sourceTitle: "一场研究" };
}

function renderMarkHook(api: Partial<ApiClient>, options: { sessionId?: string; nodeId?: string } = {}) {
  const services = { api: api as ApiClient } as unknown as AppServices;
  return renderHook(() => useSelectionMark({ sessionId: options.sessionId ?? "session-1", nodeId: options.nodeId }), {
    wrapper: ({ children }) => <ServicesProvider services={services}>{children}</ServicesProvider>,
  });
}

describe("useSelectionMark（修订二 #12）", () => {
  it("mark：先幂等创建选区，再以 mark:<选区id> 幂等键创建标记，返回记录", async () => {
    const createResearchSelection = vi.fn(
      async (_sessionId: string, _input: ResearchSelectionInput, _key: string): Promise<ResearchSelectionAccepted> => ({
        selection: makeSelection({ id: "sel-9" }),
        task: { id: "task-1", status: "queued", selectionId: "sel-9", retryable: false, idempotencyKey: "sel:key", createdAt: "", updatedAt: "" } as any,
      }),
    );
    const createResearchLaterItem = vi.fn(async (_input: ResearchLaterItemInput, _key: string) =>
      makeItemView({ id: "later-1", note: undefined }),
    );
    const { result } = renderMarkHook({ createResearchSelection, createResearchLaterItem });

    await expect(result.current.mark(makeAnchor(), "一段选区文字")).resolves.toEqual({ itemId: "later-1", note: undefined });

    // 选区创建使用锚点归一键，携带会话归属
    const [sessionId, input, selectionKey] = createResearchSelection.mock.calls[0]!;
    expect(sessionId).toBe("session-1");
    expect(input).toEqual({ anchor: makeAnchor() });
    expect(selectionKey).toContain("m-out");

    // 标记创建以 mark:<选区id> 为幂等键，只带选区 id（纯标记无 priority/summary）
    const [laterInput, laterKey] = createResearchLaterItem.mock.calls[0]!;
    expect(laterInput).toEqual({ selectionId: "sel-9" });
    expect(laterKey).toBe("mark:sel-9");
  });

  it("mark：节点页传入 nodeId 时选区携带节点归属", async () => {
    const createResearchSelection = vi.fn(
      async (_sessionId: string, _input: ResearchSelectionInput, _key: string) => ({
        selection: makeSelection({ id: "sel-9" }),
        task: { id: "task-1", status: "queued" } as any,
      }),
    );
    const createResearchLaterItem = vi.fn(async () => makeItemView());
    const { result } = renderMarkHook({ createResearchSelection, createResearchLaterItem }, { nodeId: "node-child-1" });

    await result.current.mark(makeAnchor(), "一段选区文字");

    const [, input] = createResearchSelection.mock.calls[0]!;
    expect(input).toEqual({ anchor: makeAnchor(), nodeId: "node-child-1" });
  });

  it("mark：重复标记返回既有记录（含既有笔记，供输入框回填）", async () => {
    const createResearchSelection = vi.fn(async () => ({
      selection: makeSelection({ id: "sel-9" }),
      task: { id: "task-1", status: "queued" } as any,
    }));
    const createResearchLaterItem = vi.fn(async (_input: ResearchLaterItemInput) =>
      makeItemView({ id: "later-1", note: "上次留下的笔记" }),
    );
    const { result } = renderMarkHook({ createResearchSelection, createResearchLaterItem });

    await expect(result.current.mark(makeAnchor(), "一段选区文字")).resolves.toEqual({
      itemId: "later-1",
      note: "上次留下的笔记",
    });
  });

  it("mark：任一步失败返回 null，不抛出", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const createResearchSelection = vi.fn(async () => {
      throw new Error("network down");
    });
    const { result } = renderMarkHook({ createResearchSelection });

    await expect(result.current.mark(makeAnchor(), "一段选区文字")).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("saveNote：经 PUT 保存笔记并返回 true", async () => {
    const updateResearchLaterItem = vi.fn(
      async (_itemId: string, _update: ResearchLaterItemUpdate) => makeItemView({ id: "later-1", note: "这一段要反复验证" }),
    );
    const { result } = renderMarkHook({ updateResearchLaterItem });

    await expect(result.current.saveNote("later-1", "这一段要反复验证")).resolves.toBe(true);
    expect(updateResearchLaterItem).toHaveBeenCalledWith("later-1", { note: "这一段要反复验证" });
  });

  it("saveNote：更新失败返回 false，不抛出", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const updateResearchLaterItem = vi.fn(async () => {
      throw new Error("boom");
    });
    const { result } = renderMarkHook({ updateResearchLaterItem });

    await expect(result.current.saveNote("later-1", "笔记")).resolves.toBe(false);
    errorSpy.mockRestore();
  });
});
