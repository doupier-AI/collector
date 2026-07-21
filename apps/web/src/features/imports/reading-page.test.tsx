import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ResearchContentSnapshotRecord, ResearchSelectionRecord, ResearchTurnAccepted } from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { ApiRequestError } from "../../api/errors";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeSelectionTask, makeSession } from "../../test/fakes";
import { ReadingPage } from "./ReadingPage";

function renderReadingPage(api: Partial<ApiClient>, entry = "/research/session-1/reading/snap-1") {
  const services = {
    api: api as ApiClient,
    connectTaskEvents: vi.fn(),
    connectImportEvents: vi.fn(),
  } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/research/:sessionId/reading/:contentSnapshotId" element={<ReadingPage />} />
          <Route path="/research/:sessionId" element={<p>研究会话页</p>} />
        </Routes>
      </MemoryRouter>
    </ServicesProvider>,
  );
}

const createdAt = "2026-07-19T09:00:00.000Z";

function snapshotWithAllAnchors(): ResearchContentSnapshotRecord {
  return {
    id: "snap-1",
    sessionId: "session-1",
    attachmentId: "att-1",
    mimeType: "text/markdown",
    title: "混合文档.md",
    createdAt,
    blocks: [
      { id: "b-1", ordinal: 0, text: "第一章", anchor: { kind: "markdown", startLine: 1, endLine: 1, blockType: "heading", heading: "第一章", exact: "第一章" } },
      { id: "b-2", ordinal: 1, text: "正文段落", anchor: { kind: "markdown", startLine: 3, endLine: 5, blockType: "paragraph", exact: "正文段落" } },
      { id: "b-3", ordinal: 2, text: "const a = 1;", anchor: { kind: "markdown", startLine: 7, endLine: 9, blockType: "code", exact: "const a = 1;" } },
      { id: "b-4", ordinal: 3, text: "纯文本行", anchor: { kind: "text", startLine: 12, endLine: 12, exact: "纯文本行" } },
      { id: "b-5", ordinal: 4, text: "DOCX 段落", anchor: { kind: "docx", paragraphIndex: 2, blockType: "paragraph", exact: "DOCX 段落" } },
      { id: "b-6", ordinal: 5, text: "PDF 页面文本", anchor: { kind: "pdf", pageNumber: 4, exact: "PDF 页面文本" } },
    ],
  };
}

describe("阅读视图", () => {
  it("按锚点联合类型渲染内容块：标题、代码、行号、段落号与页码", async () => {
    const getResearchContent = vi.fn(async () => snapshotWithAllAnchors());
    renderReadingPage({ getResearchContent });

    expect(await screen.findByRole("heading", { name: "混合文档.md", level: 1 })).toBeInTheDocument();
    expect(getResearchContent).toHaveBeenCalledWith("snap-1");

    // Markdown 标题块渲染为标题，其余按块类型渲染
    expect(screen.getByRole("heading", { name: "第一章", level: 2 })).toBeInTheDocument();
    expect(screen.getByText("const a = 1;").closest("pre")).not.toBeNull();
    expect(screen.getByText("第 3–5 行")).toBeInTheDocument();
    expect(screen.getByText("第 12 行")).toBeInTheDocument();
    expect(screen.getByText("段落 3")).toBeInTheDocument();
    expect(screen.getByText("第 4 页")).toBeInTheDocument();
    expect(screen.getByText("共 6 个内容块")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回研究会话" })).toHaveAttribute("href", "/research/session-1");
  });

  it("快照不存在时显示可返回的 404 状态", async () => {
    const getResearchContent = vi.fn(async () => {
      throw new ApiRequestError(404, "not_found", "not found");
    });
    renderReadingPage({ getResearchContent });

    expect(await screen.findByText("这份内容不存在或已经清理")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回研究" })).toHaveAttribute("href", "/research/session-1");
  });
});

function snapshotSelection(overrides: Partial<ResearchSelectionRecord> = {}): ResearchSelectionRecord {
  return {
    id: "sel-1",
    sessionId: "session-1",
    anchor: {
      kind: "snapshot",
      contentSnapshotId: "snap-1",
      blockId: "b-2",
      startOffset: 0,
      endOffset: 2,
      exact: "正文",
    },
    text: "正文",
    status: "active",
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

describe("阅读视图来源返回", () => {
  it("携带选区参数时按锚点重定位并高亮原选区", async () => {
    const { container } = renderReadingPage(
      {
        getResearchContent: async () => snapshotWithAllAnchors(),
        getResearchSelection: async () => snapshotSelection(),
        createResearchSelection: async () => ({
          selection: snapshotSelection(),
          task: makeSelectionTask({ id: "sel-task-1", status: "completed" }),
        }),
      },
      "/research/session-1/reading/snap-1?sel=sel-1",
    );

    const mark = await screen.findByText("正文", { selector: "[data-selection-mark]" });
    expect(mark.tagName).toBe("MARK");
    // 高亮只包住选区范围，块内其余文字仍在
    expect(container.querySelector('[data-block-id="b-2"] [data-block-text]')?.textContent).toBe("正文段落");
    // 来源返回同时自动重开选区智能窗口
    expect(await screen.findByTestId("selection-insight-panel")).toBeInTheDocument();
  });

  it("块内原文已变化时用原文在块内重新定位", async () => {
    const snapshot = snapshotWithAllAnchors();
    snapshot.blocks[1] = {
      ...snapshot.blocks[1],
      text: "前缀变化后的正文段落",
    };
    renderReadingPage(
      {
        getResearchContent: async () => snapshot,
        getResearchSelection: async () => snapshotSelection(),
        createResearchSelection: async () => ({
          selection: snapshotSelection(),
          task: makeSelectionTask({ id: "sel-task-1", status: "completed" }),
        }),
      },
      "/research/session-1/reading/snap-1?sel=sel-1",
    );

    expect(await screen.findByText("正文", { selector: "[data-selection-mark]" })).toBeInTheDocument();
  });

  it("原文无法匹配时降级展示保存原文与位置说明", async () => {
    const snapshot = snapshotWithAllAnchors();
    snapshot.blocks[1] = { ...snapshot.blocks[1], text: "整块内容已被替换" };
    renderReadingPage(
      {
        getResearchContent: async () => snapshot,
        getResearchSelection: async () => snapshotSelection(),
        createResearchSelection: async () => ({
          selection: snapshotSelection(),
          task: makeSelectionTask({ id: "sel-task-1", status: "completed" }),
        }),
      },
      "/research/session-1/reading/snap-1?sel=sel-1",
    );

    const fallback = await screen.findByTestId("selection-restore-fallback");
    expect(fallback).toHaveTextContent("原选区位置未能精确恢复");
    expect(fallback).toHaveTextContent("第 3–5 行");
    expect(fallback).toHaveTextContent("正文");
    expect(screen.queryByText("正文", { selector: "[data-selection-mark]" })).not.toBeInTheDocument();
  });

  it("选区属于其他内容时不呈现恢复内容", async () => {
    renderReadingPage(
      {
        getResearchContent: async () => snapshotWithAllAnchors(),
        getResearchSelection: async () =>
          snapshotSelection({
            anchor: {
              kind: "snapshot",
              contentSnapshotId: "other-snap",
              blockId: "b-2",
              startOffset: 0,
              endOffset: 2,
              exact: "正文",
            },
          }),
      },
      "/research/session-1/reading/snap-1?sel=sel-1",
    );

    expect(await screen.findByRole("heading", { name: "混合文档.md", level: 1 })).toBeInTheDocument();
    expect(screen.queryByTestId("selection-restore-fallback")).not.toBeInTheDocument();
    expect(screen.queryByText("正文", { selector: "[data-selection-mark]" })).not.toBeInTheDocument();
  });
});

describe("阅读视图 ChatComposer", () => {
  const turnAccepted: ResearchTurnAccepted = {
    session: makeSession({ id: "session-1" }),
    inputMessage: { id: "msg-in", sessionId: "session-1", role: "user" as const, status: "completed" as const, content: "总结这篇文章", createdAt: "2026-07-21T00:00:00Z", updatedAt: "2026-07-21T00:00:00Z" },
    outputMessage: { id: "msg-out", sessionId: "session-1", role: "assistant" as const, status: "pending" as const, content: "", createdAt: "2026-07-21T00:00:00Z", updatedAt: "2026-07-21T00:00:00Z" },
    task: { id: "task-1", sessionId: "session-1", inputMessageId: "msg-in", outputMessageId: "msg-out", idempotencyKey: "msg-key", status: "queued" as const, retryable: false, promptVersion: "", createdAt: "2026-07-21T00:00:00Z", updatedAt: "2026-07-21T00:00:00Z" },
  };

  it("阅读页渲染 ChatComposer 输入框，可发送消息", async () => {
    const user = userEvent.setup();
    const submitResearchMessage = vi.fn<ApiClient["submitResearchMessage"]>().mockResolvedValue(turnAccepted);
    renderReadingPage({
      getResearchContent: async () => snapshotWithAllAnchors(),
      submitResearchMessage,
    });

    expect(await screen.findByRole("heading", { name: "混合文档.md", level: 1 })).toBeInTheDocument();

    const textarea = screen.getByLabelText("你的问题");
    await user.type(textarea, "总结这篇文章");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(submitResearchMessage).toHaveBeenCalledTimes(1);
    expect(submitResearchMessage).toHaveBeenCalledWith("session-1", "总结这篇文章", expect.any(String));
  });

  it("提交失败时保留草稿不清理", async () => {
    const user = userEvent.setup();
    const submitResearchMessage = vi.fn<ApiClient["submitResearchMessage"]>().mockRejectedValue(new Error("network"));
    renderReadingPage({
      getResearchContent: async () => snapshotWithAllAnchors(),
      submitResearchMessage,
    });

    expect(await screen.findByRole("heading", { name: "混合文档.md", level: 1 })).toBeInTheDocument();

    const textarea = screen.getByLabelText("你的问题");
    await user.type(textarea, "保留我");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(textarea).toHaveValue("保留我");
  });

  it("未配对时显示 PairingGate", async () => {
    const user = userEvent.setup();
    const submitResearchMessage = vi.fn<ApiClient["submitResearchMessage"]>().mockRejectedValue(new ApiRequestError(401, "unauthorized", "unauthorized"));
    renderReadingPage({
      getResearchContent: async () => snapshotWithAllAnchors(),
      submitResearchMessage,
    });

    expect(await screen.findByRole("heading", { name: "混合文档.md", level: 1 })).toBeInTheDocument();

    const textarea = screen.getByLabelText("你的问题");
    await user.type(textarea, "hi");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByRole("heading", { name: "配对 Collector" })).toBeInTheDocument();
  });
});
