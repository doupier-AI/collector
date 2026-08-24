import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  ResearchSelectionAccepted,
  ResearchSelectionAnchor,
  ResearchSelectionInput,
} from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeSelection } from "../../test/fakes";
import { useSelectionCitation } from "./useSelectionCitation";

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

function renderCitationHook(api: Partial<ApiClient>, options: { sessionId?: string; nodeId?: string } = {}) {
  const services = { api: api as ApiClient } as unknown as AppServices;
  return renderHook(
    () =>
      useSelectionCitation({
        sessionId: options.sessionId ?? "session-1",
        nodeId: options.nodeId,
      }),
    {
      wrapper: ({ children }) => <ServicesProvider services={services}>{children}</ServicesProvider>,
    },
  );
}

describe("useSelectionCitation", () => {
  it("capture 创建选区记录后返回引用数据", async () => {
    const createResearchSelection = vi.fn(
      async (_sessionId: string, _input: ResearchSelectionInput, _key: string): Promise<ResearchSelectionAccepted> => ({
        selection: makeSelection({ id: "sel-1", text: "一段选区文字" }),
      }),
    );
    const { result } = renderCitationHook({ createResearchSelection });

    expect(result.current.citation).toBeNull();

    act(() => {
      result.current.capture(makeAnchor(), "一段选区文字");
    });

    await waitFor(() => expect(result.current.citation).not.toBeNull());
    expect(result.current.citation?.text).toBe("一段选区文字");
    expect(result.current.citation?.selectionId).toBe("sel-1");
    expect(result.current.citation?.anchor).toEqual(makeAnchor());
    expect(createResearchSelection).toHaveBeenCalledTimes(1);
  });

  it("同一锚点不重复创建（幂等）", async () => {
    const createResearchSelection = vi.fn(async () => ({
      selection: makeSelection({ id: "sel-1" }),
    }));
    const { result } = renderCitationHook({ createResearchSelection });

    act(() => {
      result.current.capture(makeAnchor(), "一段选区文字");
    });
    act(() => {
      result.current.capture(makeAnchor(), "一段选区文字");
    });

    await waitFor(() => expect(result.current.citation).not.toBeNull());
    expect(createResearchSelection).toHaveBeenCalledTimes(1);
  });

  it("remove 清除引用；显式再次 capture 同一锚点可重新引用（修订一 #9）", async () => {
    const createResearchSelection = vi.fn(async () => ({
      selection: makeSelection({ id: "sel-1" }),
    }));
    const { result } = renderCitationHook({ createResearchSelection });

    act(() => {
      result.current.capture(makeAnchor(), "一段选区文字");
    });
    await waitFor(() => expect(result.current.citation).not.toBeNull());

    act(() => {
      result.current.remove();
    });
    expect(result.current.citation).toBeNull();

    // 捕获改为显式后，移除后再次点击【引用】即是用户意图：允许重新创建
    // （幂等键不变，服务端返回既有记录）
    act(() => {
      result.current.capture(makeAnchor(), "一段选区文字");
    });
    await waitFor(() => expect(result.current.citation).not.toBeNull());
    expect(createResearchSelection).toHaveBeenCalledTimes(2);
  });

  it("clear 重置所有状态，允许同一锚点重新创建", async () => {
    const createResearchSelection = vi.fn(async () => ({
      selection: makeSelection({ id: "sel-1" }),
    }));
    const { result } = renderCitationHook({ createResearchSelection });

    act(() => {
      result.current.capture(makeAnchor(), "一段选区文字");
    });
    await waitFor(() => expect(result.current.citation).not.toBeNull());

    act(() => {
      result.current.remove();
    });
    expect(result.current.citation).toBeNull();

    // clear 后，同一锚点可以重新创建
    act(() => {
      result.current.clear();
    });

    act(() => {
      result.current.capture(makeAnchor(), "一段选区文字");
    });
    await waitFor(() => expect(createResearchSelection).toHaveBeenCalledTimes(2));
  });

  it("不同锚点各自独立创建", async () => {
    const createResearchSelection = vi.fn(async (_s: string, input: ResearchSelectionInput) => ({
      selection: makeSelection({ id: `sel-${input.anchor.startOffset}`, text: input.anchor.exact }),
    }));
    const { result } = renderCitationHook({ createResearchSelection });

    const anchor1 = makeAnchor();
    const anchor2: ResearchSelectionAnchor = { ...makeAnchor(), startOffset: 10, endOffset: 16, exact: "另一段文字" };

    act(() => {
      result.current.capture(anchor1, "一段选区文字");
    });
    await waitFor(() => expect(result.current.citation?.selectionId).toBe("sel-0"));

    act(() => {
      result.current.capture(anchor2, "另一段文字");
    });
    await waitFor(() => expect(result.current.citation?.selectionId).toBe("sel-10"));
    expect(createResearchSelection).toHaveBeenCalledTimes(2);
  });

  it("节点页传入 nodeId 时，创建选区携带该节点归属", async () => {
    const createResearchSelection = vi.fn(
      async (_sessionId: string, _input: ResearchSelectionInput, _key: string) => ({
        selection: makeSelection({ id: "sel-1" }),
      }),
    );
    const { result } = renderCitationHook({ createResearchSelection }, { nodeId: "node-child-1" });

    act(() => {
      result.current.capture(makeAnchor(), "一段选区文字");
    });

    await waitFor(() => expect(createResearchSelection).toHaveBeenCalledTimes(1));
    const [, input] = createResearchSelection.mock.calls[0];
    expect(input).toEqual({ anchor: makeAnchor(), nodeId: "node-child-1" });
  });
});
