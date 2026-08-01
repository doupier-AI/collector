import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeMessage, makeNode, makeNodeView, makeSession, makeTask } from "../../test/fakes";
import { ResearchNodePage } from "./ResearchNodePage";
import type { ResearchNodeView, ResearchSliceRecord } from "@collector/capture-contracts";
import { captureSelection, readContentContext, resolveBlockRange } from "../selection/selection-capture";

function renderNodePage(api: Partial<ApiClient>) {
  const services = {
    api: api as ApiClient,
    connectTaskEvents: vi.fn(() => ({ close: () => {}, syncNow: () => {}, mode: "closed", lastEventId: 0 })),
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

function viewWithAssistant(content: string): ResearchNodeView {
  return makeNodeView({
    node: makeNode({ id: "session-1", sessionId: "session-1" }),
    session: makeSession({ id: "session-1" }),
    messages: [
      makeMessage({ id: "m-in", role: "user", content: "一个问题" }),
      makeMessage({ id: "m-out", role: "assistant", status: "completed", content }),
    ],
    tasks: [makeTask({ id: "task-1", status: "completed", inputMessageId: "m-in", outputMessageId: "m-out" })],
  });
}

describe("AI 回答分块渲染", () => {
  it("多段回答按确定性段落块渲染并带稳定块 ID", async () => {
    renderNodePage({
      getResearchNodeView: async () => viewWithAssistant("第一段。\n\n第二段。"),
    });

    const first = await screen.findByText("第一段。");
    const second = screen.getByText("第二段。");
    expect(first.closest("[data-block-id]")).toHaveAttribute("data-block-id", "m-out#p0");
    expect(second.closest("[data-block-id]")).toHaveAttribute("data-block-id", "m-out#p1");
    expect(first.closest("[data-content-kind]")).toHaveAttribute("data-content-kind", "message");
  });

  it("单段回答仍渲染为单个稳定块", async () => {
    renderNodePage({
      getResearchNodeView: async () => viewWithAssistant("只有一段。"),
    });

    const el = await screen.findByText("只有一段。");
    expect(el.closest("[data-block-id]")).toHaveAttribute("data-block-id", "m-out#p0");
  });

  it("弱标记可见但不改变正文 textContent，选区捕获仍按可见文字偏移精确定位", async () => {
    const content = "**REST API** 在中文中也可读，HTTP 继续出现。";
    const terms = ["REST", "API", "HTTP"].map((text) => ({
      text,
      blockOrdinal: 0,
      startOffset: content.indexOf(text),
      endOffset: content.indexOf(text) + text.length,
      category: "abbreviation" as const,
    }));
    const view = viewWithAssistant(content);
    view.termDetections = {
      "m-out": {
        messageId: "m-out",
        detectedAt: "2026-07-31T00:00:00.000Z",
        terms,
        convergence: { termDensity: "full", nodeDepth: 0, reason: "none" },
        suppressedCount: 0,
      },
    };

    const { container } = renderNodePage({ getResearchNodeView: async () => view });
    await screen.findByText("REST", { selector: "[data-term-marker]" });
    const block = container.querySelector<HTMLElement>("[data-block-text]")!;
    expect(block.textContent).toBe("REST API 在中文中也可读，HTTP 继续出现。");
    expect(Array.from(block.querySelectorAll<HTMLElement>("[data-term-marker]"), (marker) => marker.textContent)).toEqual([
      "REST",
      "API",
      "HTTP",
    ]);

    const contentRoot = container.querySelector<HTMLElement>('[data-content-kind="message"]');
    expect(contentRoot).not.toBeNull();
    const context = readContentContext(contentRoot!);
    expect(context).toBeDefined();
    const termText = block.querySelector<HTMLElement>("[data-term-marker]")!.firstChild!;
    const range = document.createRange();
    range.setStart(termText, 0);
    range.setEnd(termText, 4);
    const resolved = resolveBlockRange(
      {
        collapsed: false,
        startContainer: range.startContainer,
        startOffset: range.startOffset,
        endContainer: range.endContainer,
        endOffset: range.endOffset,
        toString: () => range.toString(),
      },
      context!,
    );
    expect(resolved).toMatchObject({ startOffset: 0, endOffset: 4, text: "REST", blockCount: 1 });
    expect(captureSelection(resolved!, context!).anchor).toMatchObject({ exact: "REST", startOffset: 0, endOffset: 4 });
  });

  it("没有术语数据或偏移失效时保留原文，不渲染弱标记", async () => {
    const content = "REST API 在中文中也可读，HTTP 继续出现。";
    const view = viewWithAssistant(content);
    view.termDetections = {
      "m-out": {
        messageId: "m-out",
        detectedAt: "2026-07-31T00:00:00.000Z",
        terms: [{ text: "REST", blockOrdinal: 0, startOffset: 999, endOffset: 1003, category: "abbreviation" }],
        convergence: { termDensity: "full", nodeDepth: 0, reason: "none" },
        suppressedCount: 0,
      },
    };
    const { container } = renderNodePage({ getResearchNodeView: async () => view });
    const block = (await screen.findByText(content)).closest("[data-block-text]") as HTMLElement;
    expect(block.textContent).toBe(content);
    expect(block.querySelector("[data-term-marker]")).toBeNull();
  });

  it("引用标记由 remark 插件从 [来源n] token 渲染为可悬停角标，编号与文末列表一致", async () => {
    const view = viewWithAssistant("[来源1]第一段文字。[来源2]\n\n第二段文字。");
    view.tasks[0] = makeTask({
      id: "task-1",
      status: "completed",
      inputMessageId: "m-in",
      outputMessageId: "m-out",
      groundingScope: { status: "grounded", sourceCount: 2, citationCount: 2, runId: "run-1" },
    });
    view.groundingSources = [
      { id: "source-1", runId: "run-1", ordinal: 1, title: "第一个来源", url: "https://example.com/one", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "source-2", runId: "run-1", ordinal: 2, title: "第二个来源", url: "https://example.com/two", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    view.citations = [
      { id: "citation-1", messageId: "m-out", runId: "run-1", sourceId: "source-1", blockOrdinal: 0, markerOffset: 2, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "citation-2", messageId: "m-out", runId: "run-1", sourceId: "source-2", blockOrdinal: 0, markerOffset: 12, createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    renderNodePage({ getResearchNodeView: async () => view });

    const firstMarker = await screen.findByLabelText("打开来源 1：第一个来源");
    const secondMarker = screen.getByLabelText("打开来源 2：第二个来源");
    expect(firstMarker).toHaveAttribute("href", "https://example.com/one");
    expect(firstMarker).toHaveAttribute("rel", "noopener noreferrer");
    expect(firstMarker.querySelector("sup")).toHaveTextContent("");
    expect(firstMarker.querySelector("sup")).toHaveAttribute("data-citation-index", "1");
    expect(secondMarker.querySelector("sup")).toHaveAttribute("data-citation-index", "2");
    expect(firstMarker.closest("[data-block-id]")).toHaveAttribute("data-block-id", "m-out#p0");
    expect(screen.getByText("本轮可核验来源")).toBeInTheDocument();
  });
});

describe("模型状态显示", () => {
  it("真实模型显示供应商与模型名", async () => {
    renderNodePage({
      getResearchNodeView: async () => viewWithAssistant("回答。"),
      getAiConfiguration: async () => ({ consent: true, configured: true, mode: "real", provider: "deepseek", model: "deepseek-v4-pro" }),
    });

    expect(await screen.findByText("模型：deepseek · deepseek-v4-pro")).toBeInTheDocument();
  });

  it("演示模式明确标识非真实 AI", async () => {
    renderNodePage({
      getResearchNodeView: async () => viewWithAssistant("回答。"),
      getAiConfiguration: async () => ({ consent: false, configured: false, mode: "demo" }),
    });

    expect(await screen.findByText(/本地演示模式｜非真实 AI｜未联网检索/)).toBeInTheDocument();
  });

  it("未配置模型时给出明确状态", async () => {
    renderNodePage({
      getResearchNodeView: async () => viewWithAssistant("回答。"),
      getAiConfiguration: async () => ({ consent: false, configured: false, mode: "unconfigured" }),
    });

    expect(await screen.findByText(/未配置模型/)).toBeInTheDocument();
  });

  it("状态接口不可用时静默省略，不阻塞会话内容", async () => {
    renderNodePage({
      getResearchNodeView: async () => viewWithAssistant("回答。"),
      getAiConfiguration: async () => {
        throw new Error("network down");
      },
    });

    expect(await screen.findByText("回答。")).toBeInTheDocument();
    expect(screen.queryByText(/模型：/)).not.toBeInTheDocument();
  });
});

function makeSlice(overrides: Partial<ResearchSliceRecord> = {}): ResearchSliceRecord {
  return {
    id: "slice:node-1:msg-out:0",
    nodeId: "session-1",
    messageId: "m-out",
    ordinal: 0,
    title: "段落 1",
    content: "第一段。",
    normalizedConcepts: [],
    sourceRefs: [],
    isProvisional: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("E1 切片化呈现", () => {
  function viewWithSlices(content: string, slices: ResearchSliceRecord[]): ResearchNodeView {
    const view = viewWithAssistant(content);
    view.slices = { "m-out": slices };
    return view;
  }

  it("有切片时按序号合成连续长文，保留 data-block-id", async () => {
    const content = "第一段。\n\n第二段。";
    const slices = [
      makeSlice({ id: "slice:session-1:m-out:0", ordinal: 0, content: "第一段。" }),
      makeSlice({ id: "slice:session-1:m-out:1", ordinal: 1, title: "段落 2", content: "第二段。" }),
    ];
    const { container } = renderNodePage({ getResearchNodeView: async () => viewWithSlices(content, slices) });

    const first = await screen.findByText("第一段。");
    const second = screen.getByText("第二段。");
    expect(first.closest("[data-block-id]")).toHaveAttribute("data-block-id", "m-out#p0");
    expect(second.closest("[data-block-id]")).toHaveAttribute("data-block-id", "m-out#p1");
    // Both blocks are within the same message container
    expect(first.closest('[data-content-kind="message"]')).not.toBeNull();
    expect(second.closest('[data-content-kind="message"]')).not.toBeNull();
  });

  it("切片边界为装饰性 DOM：aria-hidden + data-decorative，不包含文本", async () => {
    const content = "第一段。\n\n第二段。\n\n第三段。";
    const slices = [
      makeSlice({ id: "slice:session-1:m-out:0", ordinal: 0, content: "第一段。" }),
      makeSlice({ id: "slice:session-1:m-out:1", ordinal: 1, title: "段落 2", content: "第二段。" }),
      makeSlice({ id: "slice:session-1:m-out:2", ordinal: 2, title: "段落 3", content: "第三段。" }),
    ];
    const { container } = renderNodePage({ getResearchNodeView: async () => viewWithSlices(content, slices) });

    await screen.findByText("第一段。");
    const boundaries = container.querySelectorAll("[data-slice-boundary]");
    // First slice has no boundary, subsequent ones do
    expect(boundaries.length).toBe(2);
    for (const boundary of boundaries) {
      expect(boundary).toHaveAttribute("aria-hidden", "true");
      expect(boundary).toHaveAttribute("data-decorative", "true");
      expect(boundary.textContent).toBe("");
    }
  });

  it("切片边界不影响可读文本投影——选区锚点偏移不受干扰", async () => {
    const content = "REST API 测试。\n\n第二段内容。";
    const slices = [
      makeSlice({ id: "slice:session-1:m-out:0", ordinal: 0, content: "REST API 测试。" }),
      makeSlice({ id: "slice:session-1:m-out:1", ordinal: 1, title: "段落 2", content: "第二段内容。" }),
    ];
    const { container } = renderNodePage({ getResearchNodeView: async () => viewWithSlices(content, slices) });

    await screen.findByText("REST API 测试。");
    const contentRoot = container.querySelector<HTMLElement>('[data-content-kind="message"]');
    expect(contentRoot).not.toBeNull();
    const block = container.querySelector<HTMLElement>("[data-block-text]")!;
    // The block text is just the slice content, boundary elements don't add text
    expect(block.textContent).toBe("REST API 测试。");

    // Selection capture should still work
    const context = readContentContext(contentRoot!);
    expect(context).toBeDefined();
  });

  it("无切片时沿用原有块级渲染", async () => {
    const content = "无切片的段落一。\n\n无切片的段落二。";
    const { container } = renderNodePage({ getResearchNodeView: async () => viewWithAssistant(content) });

    const first = await screen.findByText("无切片的段落一。");
    const second = screen.getByText("无切片的段落二。");
    expect(first.closest("[data-block-id]")).toHaveAttribute("data-block-id", "m-out#p0");
    expect(second.closest("[data-block-id]")).toHaveAttribute("data-block-id", "m-out#p1");
    // No slice boundaries
    expect(container.querySelectorAll("[data-slice-boundary]").length).toBe(0);
  });
});
