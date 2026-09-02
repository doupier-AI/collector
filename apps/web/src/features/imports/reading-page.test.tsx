import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ResearchChapterParseView, ResearchContentSnapshotRecord, ResearchSelectionRecord, ResearchTurnAccepted } from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { ApiRequestError } from "../../api/errors";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { projectMarkdownVisibleText } from "../../components/markdown-projection";
import { makeSession } from "../../test/fakes";
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
      { id: "b-1", ordinal: 0, text: "# 第一章", anchor: { kind: "markdown", startLine: 1, endLine: 1, blockType: "heading", heading: "第一章", exact: "# 第一章" } },
      { id: "b-2", ordinal: 1, text: "正文段落", anchor: { kind: "markdown", startLine: 3, endLine: 5, blockType: "paragraph", exact: "正文段落" } },
      { id: "b-3", ordinal: 2, text: "```ts\nconst a = 1;\n```", anchor: { kind: "markdown", startLine: 7, endLine: 9, blockType: "code", exact: "```ts\nconst a = 1;\n```" } },
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
    expect(screen.getByRole("heading", { name: "第一章", level: 1 })).toBeInTheDocument();
    expect(document.querySelector("pre code")?.textContent).toBe("const a = 1;");
    expect(screen.getByText("第 3–5 行")).toBeInTheDocument();
    expect(screen.getByText("第 12 行")).toBeInTheDocument();
    expect(screen.getByText("段落 3")).toBeInTheDocument();
    expect(screen.getByText("第 4 页")).toBeInTheDocument();
    expect(screen.getByText("共 6 个内容块")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回研究会话" })).toHaveAttribute("href", "/nodes/session-1");
  });

  it("Markdown 导入与回答使用同一投影渲染表格、换行、代码和公式", async () => {
    const source = [
      "## 统一投影",
      "",
      "第一行  ",
      "第二行含 $E = mc^2$。",
      "",
      "| 列 | 值 |",
      "| --- | --- |",
      "| A | `code` |",
    ].join("\n");
    const snapshot = snapshotWithAllAnchors();
    snapshot.blocks = [{
      id: "b-mixed",
      ordinal: 0,
      text: source,
      anchor: { kind: "markdown", startLine: 1, endLine: 8, blockType: "paragraph", exact: source.slice(0, 500) },
    }];
    const { container } = renderReadingPage({ getResearchContent: async () => snapshot });

    expect(await screen.findByRole("heading", { name: "统一投影", level: 2 })).toBeInTheDocument();
    const rendered = container.querySelector('[data-block-id="b-mixed"] .markdown-content');
    expect(rendered?.textContent).toBe(projectMarkdownVisibleText(source).text);
    expect(rendered?.querySelector("br")).not.toBeNull();
    expect(rendered?.querySelector("table")).not.toBeNull();
    expect(rendered?.querySelector("code")?.textContent).toBe("code");
    expect(rendered?.querySelector(".katex")).not.toBeNull();
  });

  it("快照不存在时显示可返回的 404 状态", async () => {
    const getResearchContent = vi.fn(async () => {
      throw new ApiRequestError(404, "not_found", "not found");
    });
    renderReadingPage({ getResearchContent });

    expect(await screen.findByText("这份内容不存在或已经清理")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回研究" })).toHaveAttribute("href", "/nodes/session-1");
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
  it("语义搜索命中直接按稳定 block 与字符范围定位，不创建选区记录", async () => {
    const { container } = renderReadingPage(
      { getResearchContent: async () => snapshotWithAllAnchors() },
      "/research/session-1/reading/snap-1?searchBlock=b-2&searchStart=2&searchEnd=4",
    );

    expect(await screen.findByText("段落", { selector: "[data-selection-mark]" })).toBeInTheDocument();
    expect(container.querySelector('[data-block-id="b-2"] [data-block-text]')?.textContent).toBe("正文段落");
    expect(container.querySelector("article.reading[data-turn-card]")).toHaveClass("fragment-target--focused");
  });

  it("携带选区参数时按锚点重定位并高亮原选区，只读提醒不重开胶囊", async () => {
    const createResearchSelection = vi.fn(async () => ({
      selection: snapshotSelection(),
    }));
    const { container } = renderReadingPage(
      {
        getResearchContent: async () => snapshotWithAllAnchors(),
        getResearchSelection: async () => snapshotSelection(),
        createResearchSelection,
      },
      "/research/session-1/reading/snap-1?sel=sel-1",
    );

    const mark = await screen.findByText("正文", { selector: "[data-selection-mark]" });
    expect(mark.tagName).toBe("MARK");
    // 导入阅读页整篇正文是一张轮次卡片；块/章节仍只承担精确落点。
    const card = container.querySelector("article.reading[data-turn-card]");
    expect(card).toHaveClass("fragment-target--focused");
    expect(mark.closest("[data-block-id]")).not.toHaveClass("fragment-target--focused");
    // 高亮只包住选区范围，块内其余文字仍在
    expect(container.querySelector('[data-block-id="b-2"] [data-block-text]')?.textContent).toBe("正文段落");
    // #48：返回定位是只读临时提醒——不重开浮动胶囊，不进入引用态
    expect(screen.queryByTestId("floating-selection-capsule")).not.toBeInTheDocument();
    expect(screen.queryByTestId("selection-capsule")).not.toBeInTheDocument();
    expect(createResearchSelection).not.toHaveBeenCalled();
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
        }),
      },
      "/research/session-1/reading/snap-1?sel=sel-1",
    );

    expect(await screen.findByText("正文", { selector: "[data-selection-mark]" })).toBeInTheDocument();
  });

  it("搜索命中的快照版本变化时只打开资料并明确降级，不猜同名块", async () => {
    const { container } = renderReadingPage(
      { getResearchContent: async () => snapshotWithAllAnchors() },
      "/research/session-1/reading/snap-1?searchBlock=b-2&searchStart=2&searchEnd=4&searchVersion=stale-snapshot",
    );

    expect(await screen.findByRole("status")).toHaveTextContent("精确位置已不存在");
    expect(container.querySelector("[data-selection-mark]")).toBeNull();
  });

  it("历史源码偏移在 Markdown 格式符附近恢复为可见高亮", async () => {
    const snapshot = snapshotWithAllAnchors();
    snapshot.blocks[1] = {
      ...snapshot.blocks[1],
      text: "**正文**段落",
      anchor: { kind: "markdown", startLine: 3, endLine: 3, blockType: "paragraph", exact: "**正文**段落" },
    };
    renderReadingPage(
      {
        getResearchContent: async () => snapshot,
        getResearchSelection: async () => snapshotSelection({
          anchor: {
            kind: "snapshot",
            contentSnapshotId: "snap-1",
            blockId: "b-2",
            startOffset: 2,
            endOffset: 4,
            exact: "正文",
          },
        }),
      },
      "/research/session-1/reading/snap-1?sel=sel-1",
    );

    const mark = await screen.findByText("正文", { selector: "[data-selection-mark]" });
    expect(mark.closest("strong")).not.toBeNull();
    expect(screen.queryByText("**", { exact: true })).not.toBeInTheDocument();
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
        }),
      },
      "/research/session-1/reading/snap-1?sel=sel-1",
    );

    const fallback = await screen.findByTestId("selection-restore-fallback");
    expect(fallback).toHaveTextContent("原选区位置未能精确恢复");
    expect(fallback).toHaveTextContent("第 3–5 行");
    expect(fallback).toHaveTextContent("正文");
    expect(screen.queryByText("正文", { selector: "[data-selection-mark]" })).not.toBeInTheDocument();
    expect(document.querySelector("article.reading[data-turn-card]")).not.toHaveClass("fragment-target--focused");
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
    expect(submitResearchMessage).toHaveBeenCalledWith("session-1", "总结这篇文章", expect.any(String), {
      webSearchMode: "off",
      thinkingEnabled: false,
    });
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

describe("阅读视图章节解析（T03）", () => {
  /** jsdom 没有 matchMedia：章节导航宽屏线列需要 900px 断点。 */
  function stubWide() {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("min-width: 900px") ? true : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  function chapterView(overrides: Partial<ResearchChapterParseView> = {}): ResearchChapterParseView {
    return {
      taskId: "chapter-task-1",
      status: "completed",
      retryable: false,
      source: "ai",
      chapters: [
        { ordinal: 0, title: "第一章", blockOrdinal: 0 },
        { ordinal: 1, title: "正文段落", blockOrdinal: 1 },
      ],
      updatedAt: createdAt,
      ...overrides,
    };
  }

  it("解析进行中每 2s 静默轮询，完成后章节导航出现", async () => {
    stubWide();
    const queued = { ...snapshotWithAllAnchors(), chapterParse: chapterView({ status: "queued", source: undefined, chapters: [] }) };
    const completed = { ...snapshotWithAllAnchors(), chapterParse: chapterView() };
    const getResearchContent = vi.fn<ApiClient["getResearchContent"]>()
      .mockResolvedValueOnce(queued)
      .mockResolvedValue(completed);
    renderReadingPage({ getResearchContent });

    expect(await screen.findByText("AI 正在通读全文，章节导航稍后补齐…")).toBeInTheDocument();
    await vi.waitFor(() => expect(getResearchContent).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    await waitFor(() => expect(screen.getByTestId("reading-chapter-nav")).toHaveAttribute("data-chapter-source", "ai"));
    expect(screen.getByText("章节由 AI 通读全文生成")).toBeInTheDocument();
    // 终态后轮询停止。
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(getResearchContent).toHaveBeenCalledTimes(2);
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("规则降级状态如实呈现，重试后替换为 AI 章节", async () => {
    stubWide();
    const degraded = { ...snapshotWithAllAnchors(), chapterParse: chapterView({ source: "rule", fallbackReason: "no_model", retryable: true, chapters: [{ ordinal: 0, title: "按原文结构", blockOrdinal: 0 }, { ordinal: 1, title: "首句标题", blockOrdinal: 1 }] }) };
    const aiDone = { ...snapshotWithAllAnchors(), chapterParse: chapterView() };
    const getResearchContent = vi.fn<ApiClient["getResearchContent"]>().mockResolvedValue(degraded);
    const retryResearchChapterParse = vi.fn<ApiClient["retryResearchChapterParse"]>().mockResolvedValue(aiDone);
    const user = userEvent.setup();
    renderReadingPage({ getResearchContent, retryResearchChapterParse });

    expect(await screen.findByText("未配置可用模型，章节按原文结构生成")).toBeInTheDocument();
    await user.click(screen.getByTestId("chapter-retry"));
    expect(retryResearchChapterParse).toHaveBeenCalledWith("snap-1");
    expect(await screen.findByText("章节由 AI 通读全文生成")).toBeInTheDocument();
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("无章节解析状态时不渲染任何章节导航", async () => {
    renderReadingPage({ getResearchContent: async () => snapshotWithAllAnchors() });
    expect(await screen.findByRole("heading", { name: "混合文档.md", level: 1 })).toBeInTheDocument();
    expect(screen.queryByTestId("reading-chapter-nav")).not.toBeInTheDocument();
  });
});
