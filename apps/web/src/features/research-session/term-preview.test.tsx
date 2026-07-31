import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ResearchNodeView, ResearchTermPreviewRecord, TermMarker } from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeMessage, makeNode, makeNodeView, makeSelection, makeSession, makeTask } from "../../test/fakes";
import type { TermPreviewEventStream } from "../../api/term-preview-events";
import { ResearchNodePage } from "./ResearchNodePage";

function noopStream(): TermPreviewEventStream {
  return { close: () => {}, syncNow: () => {}, mode: "closed", lastEventId: 0 };
}

function markerFor(content: string, text: string, category: TermMarker["category"] = "abbreviation"): TermMarker {
  const startOffset = content.indexOf(text);
  return { text, blockOrdinal: 0, startOffset, endOffset: startOffset + text.length, category };
}

function viewWithTerms(): { view: ResearchNodeView; marker: TermMarker } {
  const content = "REST API is documented through HTTP.";
  const marker = markerFor(content, "REST");
  const view = makeNodeView({
    node: makeNode({ id: "session-1", sessionId: "session-1" }),
    session: makeSession({ id: "session-1", title: "Term preview" }),
    messages: [
      makeMessage({ id: "m-in", role: "user", content: "Explain REST" }),
      makeMessage({ id: "m-out", role: "assistant", status: "completed", content }),
    ],
    tasks: [makeTask({ id: "task-1", status: "completed", inputMessageId: "m-in", outputMessageId: "m-out" })],
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
    markerKey: ["m-out", marker.blockOrdinal, marker.startOffset, marker.endOffset, marker.text].join(":"),
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
      <MemoryRouter initialEntries={["/research/session-1/node/session-1"]}>
        <Routes>
          <Route path="/research/:sessionId/node/:nodeId" element={<ResearchNodePage />} />
        </Routes>
      </MemoryRouter>
    </ServicesProvider>,
  );
}

describe("术语预览交互", () => {
  it("键盘可到达术语，Enter 启动预览，Escape 只关闭弹层，完成后可进入概念节点", async () => {
    const { view, marker } = viewWithTerms();
    const preview = previewFor(marker);
    const startResearchTermPreview = vi.fn(async () => ({ preview, selection: makeSelection({ id: "selection-1" }) }));
    const growResearchTermPreview = vi.fn(async () => ({
      node: makeNode({ id: "child-1", sessionId: "session-1", parentNodeId: "session-1" }),
      session: view.session,
      selection: makeSelection({ id: "selection-1" }),
      inputMessage: makeMessage({ id: "child-input", role: "user" }),
      outputMessage: makeMessage({ id: "child-output", role: "assistant", status: "completed", content: preview.content }),
      task: makeTask({ id: "child-task", status: "completed" }),
    }));
    renderPage({ getResearchNodeView: async () => view, startResearchTermPreview, growResearchTermPreview });

    const markerElement = await screen.findByRole("button", { name: "解释术语 REST" });
    fireEvent.focus(markerElement);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(markerElement, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(startResearchTermPreview).not.toHaveBeenCalled();

    fireEvent.focus(markerElement);
    fireEvent.keyDown(markerElement, { key: "Enter" });
    await waitFor(() => expect(startResearchTermPreview).toHaveBeenCalledWith("session-1", { messageId: "m-out", marker }, expect.any(String)));
    expect(await screen.findByText("REST API 是一种通过 HTTP 交换资源的接口约定。")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "进入这个概念" }));
    await waitFor(() => expect(growResearchTermPreview).toHaveBeenCalledWith("preview-1", expect.any(String)));
  });
});
