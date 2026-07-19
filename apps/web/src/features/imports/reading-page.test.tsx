import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ResearchContentSnapshotRecord } from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { ApiRequestError } from "../../api/errors";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
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
