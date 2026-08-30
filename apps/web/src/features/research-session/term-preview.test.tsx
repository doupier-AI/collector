import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { researchBodyVersionId, type ResearchNodeView, type ResearchTermPreviewRecord, type TermMarker } from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeMessage, makeNode, makeNodeView, makeSelection, makeSession, makeTask } from "../../test/fakes";
import type { TermPreviewEventStream } from "../../api/term-preview-events";
import { ResearchNodePage } from "./ResearchNodePage";
import { termPreviewClientKey, useTermPreviews } from "./useTermPreviews";

function noopStream(): TermPreviewEventStream {
  return { close: () => {}, syncNow: () => {}, mode: "closed", lastEventId: 0 };
}

function markerFor(content: string, text: string, category: TermMarker["category"] = "abbreviation", messageId = "m-out"): TermMarker {
  const startOffset = content.indexOf(text);
  return {
    text,
    blockOrdinal: 0,
    startOffset,
    endOffset: startOffset + text.length,
    category,
    location: {
      contentId: messageId,
      bodyVersionId: researchBodyVersionId(messageId, content),
      sourceRange: { startOffset, endOffset: startOffset + text.length },
      exact: text,
    },
  };
}

function viewWithTerms(status: "completed" | "streaming" = "completed"): { view: ResearchNodeView; marker: TermMarker } {
  const content = "REST API is documented through HTTP.";
  const marker = markerFor(content, "REST");
  const view = makeNodeView({
    node: makeNode({ id: "session-1", sessionId: "session-1" }),
    session: makeSession({ id: "session-1", title: "Term preview" }),
    messages: [
      makeMessage({ id: "m-in", role: "user", content: "Explain REST" }),
      makeMessage({ id: "m-out", role: "assistant", status, content, termMarkers: [marker] }),
    ],
    tasks: [makeTask({ id: "task-1", status: status === "completed" ? "completed" : "running", inputMessageId: "m-in", outputMessageId: "m-out" })],
  });
  view.termDetections = {
    "m-out": {
      messageId: "m-out",
      detectedAt: "2026-08-01T00:00:00.000Z",
      terms: [marker],
      convergence: { termDensity: "full", nodeDepth: 0, reason: "none" },
      suppressedCount: 0,
    },
  };
  return { view, marker };
}

function previewFor(marker: TermMarker): ResearchTermPreviewRecord {
  return {
    id: "preview-1",
    sessionId: "session-1",
    nodeId: "session-1",
    messageId: "m-out",
    marker,
    markerKey: ["m-out", marker.location?.bodyVersionId ?? "legacy", marker.blockOrdinal, marker.startOffset, marker.endOffset, marker.text].join(":"),
    idempotencyKey: "term-preview-key",
    selectionId: "selection-1",
    status: "completed",
    content: "REST API 是一种通过 HTTP 交换资源的接口约定。",
    retryable: false,
    promptVersion: "term-preview-v1",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:01.000Z",
    completedAt: "2026-08-01T00:00:01.000Z",
  };
}

function renderPage(api: Partial<ApiClient>) {
  const services = {
    api: api as ApiClient,
    connectTaskEvents: vi.fn(() => ({ close: () => {}, syncNow: () => {}, mode: "closed", lastEventId: 0 })),
    connectTermPreviewEvents: vi.fn(noopStream),
  } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={["/nodes/session-1"]}>
        <Routes>
          <Route path="/nodes/:nodeId" element={<ResearchNodePage />} />
        </Routes>
      </MemoryRouter>
    </ServicesProvider>,
  );
}

function grownResult(view: ResearchNodeView, preview: ResearchTermPreviewRecord) {
  return {
    node: makeNode({ id: "child-1", sessionId: "session-1", parentNodeId: "session-1" }),
    session: view.session,
    selection: makeSelection({ id: "selection-1" }),
    inputMessage: makeMessage({ id: "child-input", role: "user" }),
    outputMessage: makeMessage({ id: "child-output", role: "assistant", status: "completed", content: preview.content }),
    task: makeTask({ id: "child-task", status: "completed" }),
  };
}

describe("术语预览交互", () => {
  it("独立抽取任务晚于回答完成时，页面无闪烁对齐并自动显示当前版本标记", async () => {
    const { view } = viewWithTerms();
    const beforeSidecar = structuredClone(view);
    beforeSidecar.messages = beforeSidecar.messages.map((message) => (
      message.id === "m-out" ? { ...message, termMarkers: [] } : message
    ));
    beforeSidecar.termDetections = {};
    const getResearchNodeView = vi.fn()
      .mockResolvedValueOnce(beforeSidecar)
      .mockResolvedValue(view);
    renderPage({ getResearchNodeView });

    expect(await screen.findByText(/REST API is documented/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "解释术语 REST" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "解释术语 REST" }, { timeout: 2_000 })).toBeInTheDocument();
    expect(getResearchNodeView).toHaveBeenCalledTimes(2);
  });

  it("客户端预览身份包含正文版本，消息重生成后不复用旧版本缓存", () => {
    const oldMarker = markerFor("REST old", "REST");
    const newMarker = markerFor("REST new", "REST");
    expect(termPreviewClientKey("m-out", oldMarker)).not.toBe(termPreviewClientKey("m-out", newMarker));
  });

  it("键盘可到达提及，Escape 只关闭弹层，首次点击会生成预览并直接进入概念节点", async () => {
    const { view, marker } = viewWithTerms();
    const preview = previewFor(marker);
    const startResearchTermPreview = vi.fn(async () => ({ preview, selection: makeSelection({ id: "selection-1" }) }));
    const growResearchTermPreview = vi.fn(async () => grownResult(view, preview));
    renderPage({ getResearchNodeView: async () => view, startResearchTermPreview, growResearchTermPreview });

    const markerElement = await screen.findByRole("button", { name: "解释术语 REST" });
    fireEvent.focus(markerElement);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(markerElement, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(startResearchTermPreview).not.toHaveBeenCalled();

    fireEvent.click(markerElement);
    await waitFor(() => expect(startResearchTermPreview).toHaveBeenCalledWith("session-1", { messageId: "m-out", marker }, expect.any(String)));
    await waitFor(() => expect(growResearchTermPreview).toHaveBeenCalledWith(
      "preview-1",
      "term-growth:preview-1",
      { mention: { messageId: "m-out", marker } },
    ));
  });

  it("弹层按实测高度定位：下方上方都放不下时贴视口底边钳制，按钮不被推出视口", async () => {
    const { view, marker } = viewWithTerms();
    const preview = previewFor(marker);
    const startResearchTermPreview = vi.fn(async () => ({ preview, selection: makeSelection({ id: "selection-1" }) }));
    renderPage({ getResearchNodeView: async () => view, startResearchTermPreview });

    const markerElement = await screen.findByRole("button", { name: "解释术语 REST" });
    // #86 回归：jsdom 视口 768px，标记下沿在 400px；弹层实测高 420——下方（410+420）与
    // 上方（380-430）都放不下，必须贴底钳制（768-420-12=336），否则 fixed 弹层不随页面滚动，
    // 底部的生长按钮永远不可达（真实验收曾因此点击等待到测试超时）。
    vi.spyOn(markerElement, "getBoundingClientRect").mockReturnValue({
      left: 100, right: 120, top: 380, bottom: 400, width: 20, height: 20, x: 100, y: 380, toJSON: () => ({}),
    } as DOMRect);
    const offsetHeightSpy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList?.contains("term-preview-popover") ? 420 : 0;
    });
    try {
      fireEvent.focus(markerElement);
      const popover = screen.getByRole("dialog");
      expect(popover.style.top).toBe("336px");
    } finally {
      offsetHeightSpy.mockRestore();
    }
  });

  it("流式生成中的标记同样可悬停启动预览、点击直接生长（ADR-0029）", async () => {
    const { view, marker } = viewWithTerms("streaming");
    const preview = previewFor(marker);
    const startResearchTermPreview = vi.fn(async () => ({ preview, selection: makeSelection({ id: "selection-1" }) }));
    const growResearchTermPreview = vi.fn(async () => grownResult(view, preview));
    renderPage({ getResearchNodeView: async () => view, startResearchTermPreview, growResearchTermPreview });

    const markerElement = await screen.findByRole("button", { name: "解释术语 REST" });
    fireEvent.pointerOver(markerElement);
    // 悬停沿用约 400ms 意图确认后启动预览，不等待整篇回答完成。
    await waitFor(
      () => expect(startResearchTermPreview).toHaveBeenCalledWith("session-1", { messageId: "m-out", marker }, expect.any(String)),
      { timeout: 3_000 },
    );
    expect(startResearchTermPreview).toHaveBeenCalledTimes(1);

    // 预览状态更新会重渲染正文并替换标记元素（流式期间每个增量亦如此），点击当前元素。
    fireEvent.click(screen.getByRole("button", { name: "解释术语 REST" }));
    await waitFor(() => expect(growResearchTermPreview).toHaveBeenCalledWith(
      "preview-1",
      "term-growth:preview-1",
      { mention: { messageId: "m-out", marker } },
    ));
    // 点击复用悬停启动的同一份预览，不重复调用启动端点。
    expect(startResearchTermPreview).toHaveBeenCalledTimes(1);
  });

  it("生长进行中的快速重复点击与回车只触发一次预览启动与一次生长", async () => {
    const { view, marker } = viewWithTerms();
    const preview = previewFor(marker);
    let resolveStart: ((accepted: { preview: ResearchTermPreviewRecord; selection: ReturnType<typeof makeSelection> }) => void) | undefined;
    const startResearchTermPreview = vi.fn(() => new Promise<{ preview: ResearchTermPreviewRecord; selection: ReturnType<typeof makeSelection> }>((resolve) => {
      resolveStart = resolve;
    }));
    const growResearchTermPreview = vi.fn(async () => grownResult(view, preview));
    renderPage({ getResearchNodeView: async () => view, startResearchTermPreview, growResearchTermPreview });

    const markerElement = await screen.findByRole("button", { name: "解释术语 REST" });
    fireEvent.click(markerElement);
    fireEvent.click(markerElement);
    fireEvent.keyDown(markerElement, { key: "Enter" });
    expect(startResearchTermPreview).toHaveBeenCalledTimes(1);

    resolveStart?.({ preview, selection: makeSelection({ id: "selection-1" }) });
    await waitFor(() => expect(growResearchTermPreview).toHaveBeenCalledTimes(1));
  });

  it("Enter 键激活标记：启动预览、等待完成后直接生长", async () => {
    const { view, marker } = viewWithTerms();
    const preview = previewFor(marker);
    const startResearchTermPreview = vi.fn(async () => ({ preview, selection: makeSelection({ id: "selection-1" }) }));
    const growResearchTermPreview = vi.fn(async () => grownResult(view, preview));
    renderPage({ getResearchNodeView: async () => view, startResearchTermPreview, growResearchTermPreview });

    const markerElement = await screen.findByRole("button", { name: "解释术语 REST" });
    fireEvent.keyDown(markerElement, { key: "Enter" });
    await waitFor(() => expect(startResearchTermPreview).toHaveBeenCalledWith("session-1", { messageId: "m-out", marker }, expect.any(String)));
    await waitFor(() => expect(growResearchTermPreview).toHaveBeenCalledWith(
      "preview-1",
      "term-growth:preview-1",
      { mention: { messageId: "m-out", marker } },
    ));
  });

  it("Escape 关闭弹层后焦点恢复到触发标记", async () => {
    const { view } = viewWithTerms();
    renderPage({ getResearchNodeView: async () => view });

    const markerElement = await screen.findByRole("button", { name: "解释术语 REST" });
    fireEvent.focus(markerElement);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(markerElement, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(markerElement));
  });

  it("悬停打开后按 Escape：焦点恢复不重新打开弹层，用户重新聚焦才再打开", async () => {
    const { view, marker } = viewWithTerms();
    const preview = previewFor(marker);
    renderPage({
      getResearchNodeView: async () => view,
      startResearchTermPreview: vi.fn(async () => ({ preview, selection: makeSelection({ id: "selection-1" }) })),
    });

    // 鼠标悬停打开弹层时焦点不在标记上；Escape 的焦点恢复不得被当成新的聚焦意图。
    const markerElement = await screen.findByRole("button", { name: "解释术语 REST" });
    fireEvent.pointerOver(markerElement);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument(), { timeout: 3_000 });

    // 预览状态更新会重渲染正文并替换标记元素，Escape 前重新取当前元素。
    fireEvent.keyDown(screen.getByRole("button", { name: "解释术语 REST" }), { key: "Escape" });
    // 焦点恢复到当前提及元素（预览完成触发的重渲染可能已替换原元素，不断言对象同一性）。
    await waitFor(() => {
      const focused = document.activeElement as HTMLElement | null;
      expect(focused?.getAttribute("data-term-text")).toBe("REST");
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // 用户主动移开焦点再聚焦：正常的键盘进入仍然打开弹层。
    const currentMarker = document.activeElement as HTMLElement;
    fireEvent.focusOut(currentMarker);
    fireEvent.focus(currentMarker);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("预览失败时弹层保留错误与重试入口，不生长子节点", async () => {
    const { view, marker } = viewWithTerms();
    const failedPreview: ResearchTermPreviewRecord = {
      ...previewFor(marker),
      status: "failed",
      retryable: true,
      content: "",
      error: { code: "provider_error", message: "AI 生成失败。术语和已生成内容已保留，可以稍后重试。" },
    };
    const startResearchTermPreview = vi.fn(async () => ({ preview: failedPreview, selection: makeSelection({ id: "selection-1" }) }));
    const retryResearchTermPreviewTask = vi.fn(async () => ({ ...failedPreview, status: "queued" as const, retryable: false }));
    const growResearchTermPreview = vi.fn();
    renderPage({ getResearchNodeView: async () => view, startResearchTermPreview, retryResearchTermPreviewTask, growResearchTermPreview });

    const markerElement = await screen.findByRole("button", { name: "解释术语 REST" });
    fireEvent.click(markerElement);
    const retryButton = await screen.findByRole("button", { name: "重试" });
    expect(screen.getByText(/解释生成失败/)).toBeInTheDocument();
    expect(growResearchTermPreview).not.toHaveBeenCalled();

    fireEvent.click(retryButton);
    await waitFor(() => expect(retryResearchTermPreviewTask).toHaveBeenCalledWith("preview-1"));
  });

  it("同节点另一条消息复用既有预览时仍映射到当前提及", async () => {
    const oldMarker = { ...markerFor("REST was introduced earlier.", "REST", "abbreviation", "m-old"), entityId: "entity-rest" };
    const currentMarker = { ...markerFor("REST is used again here.", "REST", "abbreviation", "m-current"), entityId: "entity-rest" };
    const reused = previewFor(oldMarker);
    reused.messageId = "m-old";
    const startResearchTermPreview = vi.fn(async () => ({ preview: reused, selection: makeSelection({ id: "selection-1" }) }));
    const grown = {
      node: makeNode({ id: "child-1", sessionId: "session-1", parentNodeId: "session-1" }),
      session: makeSession({ id: "session-1" }),
      selection: makeSelection({ id: "selection-1" }),
      inputMessage: makeMessage({ id: "child-input", role: "user" }),
      outputMessage: makeMessage({ id: "child-output", role: "assistant", status: "completed", content: reused.content }),
      task: makeTask({ id: "child-task", status: "completed" }),
    };
    const growResearchTermPreview = vi.fn(async () => grown);
    const services = {
      api: { startResearchTermPreview, growResearchTermPreview } as unknown as ApiClient,
      connectTermPreviewEvents: vi.fn(noopStream),
    } as unknown as AppServices;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ServicesProvider services={services}>{children}</ServicesProvider>
    );
    const { result } = renderHook(() => useTermPreviews("session-1"), { wrapper });

    await act(async () => {
      await result.current.growMarker("m-current", currentMarker);
    });

    expect(result.current.previews[termPreviewClientKey("m-current", currentMarker)]?.id).toBe(reused.id);
    // 跨消息复用预览时，生长携带用户实际点击的提及作为子节点来源锚点（ADR-0029）。
    expect(growResearchTermPreview).toHaveBeenCalledWith(reused.id, `term-growth:${reused.id}`, {
      mention: { messageId: "m-current", marker: currentMarker },
    });
  });
});
