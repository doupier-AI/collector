import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeMessage, makeNode, makeNodeView, makeSelection, makeSession, makeTask } from "../../test/fakes";
import { ResearchNodePage } from "./ResearchNodePage";
import type { ResearchNodeView, ResearchSliceRecord } from "@collector/capture-contracts";
import { deriveBodyVersion, deriveFragmentsFromSlices, deriveMessageSlices, researchBodyVersionId } from "@collector/capture-contracts";
import { captureSelection, readContentContext, resolveBlockRange } from "../selection/selection-capture";

function renderNodePage(api: Partial<ApiClient>, entry = "/nodes/session-1") {
  const services = {
    api: api as ApiClient,
    connectTaskEvents: vi.fn(() => ({ close: () => {}, syncNow: () => {}, mode: "closed", lastEventId: 0 })),
  } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/nodes/:nodeId" element={<ResearchNodePage />} />
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

function citationFor(content: string, input: { id: string; sourceId: string; start: number; end: number; blockOrdinal?: number }) {
  return {
    id: input.id,
    messageId: "m-out",
    runId: "run-1",
    sourceId: input.sourceId,
    blockOrdinal: input.blockOrdinal ?? 0,
    markerOffset: 0,
    location: {
      contentId: "m-out",
      bodyVersionId: researchBodyVersionId("m-out", content),
      sourceRange: { startOffset: input.start, endOffset: input.end },
      exact: content.slice(input.start, input.end),
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
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

  it("同名文字只标记被标记的那一次出现，不误标前一次同名文字（同名异义）", async () => {
    const content = "苹果是水果，苹果发布了手机。";
    const secondOccurrence = content.indexOf("苹果", 1);
    const view = viewWithAssistant(content);
    view.termDetections = {
      "m-out": {
        messageId: "m-out",
        detectedAt: "2026-07-31T00:00:00.000Z",
        terms: [{ text: "苹果", blockOrdinal: 0, startOffset: secondOccurrence, endOffset: secondOccurrence + 2, category: "entity" }],
        convergence: { termDensity: "full", nodeDepth: 0, reason: "none" },
        suppressedCount: 0,
      },
    };
    const { container } = renderNodePage({ getResearchNodeView: async () => view });
    const marked = await screen.findByText("苹果", { selector: "[data-term-marker]" });
    const block = marked.closest("[data-block-text]") as HTMLElement;
    expect(block.querySelectorAll("[data-term-marker]")).toHaveLength(1);
    const before = document.createRange();
    before.setStart(block, 0);
    before.setEndBefore(marked);
    expect(before.toString()).toBe("苹果是水果，");
    expect(block.textContent).toBe("苹果是水果，苹果发布了手机。");
    expect(container.querySelectorAll("[data-term-marker]")).toHaveLength(1);
  });

  it("前一次同名出现落在内联代码中时，仍命中后一次被标记的出现", async () => {
    const content = "`苹果`是代号，苹果发布了手机。";
    const plainOccurrence = content.indexOf("苹果", 2);
    const view = viewWithAssistant(content);
    view.termDetections = {
      "m-out": {
        messageId: "m-out",
        detectedAt: "2026-07-31T00:00:00.000Z",
        terms: [{ text: "苹果", blockOrdinal: 0, startOffset: plainOccurrence, endOffset: plainOccurrence + 2, category: "entity" }],
        convergence: { termDensity: "full", nodeDepth: 0, reason: "none" },
        suppressedCount: 0,
      },
    };
    renderNodePage({ getResearchNodeView: async () => view });
    const marked = await screen.findByText("苹果", { selector: "[data-term-marker]" });
    const block = marked.closest("[data-block-text]") as HTMLElement;
    expect(block.querySelectorAll("[data-term-marker]")).toHaveLength(1);
    const before = document.createRange();
    before.setStart(block, 0);
    before.setEndBefore(marked);
    expect(before.toString()).toBe("苹果是代号，");
    expect(block.querySelector("code")?.textContent).toBe("苹果");
    expect(block.textContent).toBe("苹果是代号，苹果发布了手机。");
  });

  it("被标记的出现落在代码内时丢弃该标记且正文保持不变", async () => {
    const content = "苹果发布了手机，`苹果`是代号。";
    const codeOccurrence = content.indexOf("苹果", 2);
    const view = viewWithAssistant(content);
    view.termDetections = {
      "m-out": {
        messageId: "m-out",
        detectedAt: "2026-07-31T00:00:00.000Z",
        terms: [{ text: "苹果", blockOrdinal: 0, startOffset: codeOccurrence, endOffset: codeOccurrence + 2, category: "entity" }],
        convergence: { termDensity: "full", nodeDepth: 0, reason: "none" },
        suppressedCount: 0,
      },
    };
    const { container } = renderNodePage({ getResearchNodeView: async () => view });
    const codeElement = await screen.findByText("苹果", { selector: "code" });
    const block = codeElement.closest("[data-block-text]") as HTMLElement;
    expect(block.querySelector("[data-term-marker]")).toBeNull();
    expect(block.textContent).toBe("苹果发布了手机，苹果是代号。");
    expect(container.querySelector("[data-term-marker]")).toBeNull();
  });

  it("引用角标按稳定旁路范围渲染，编号与文末列表一致且正文没有控制串", async () => {
    const content = "第一段文字。\n\n第二段文字。";
    const view = viewWithAssistant(content);
    view.tasks[0] = makeTask({
      id: "task-1",
      status: "completed",
      inputMessageId: "m-in",
      outputMessageId: "m-out",
      groundingScope: { status: "grounded", sourceCount: 5, citationCount: 2, runId: "run-1" },
    });
    view.groundingSources = [
      { id: "source-2", runId: "run-1", ordinal: 2, title: "第二个来源", url: "https://example.com/two", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "source-5", runId: "run-1", ordinal: 5, title: "第五个来源", url: "https://example.com/five", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    view.citations = [
      citationFor(content, { id: "citation-2", sourceId: "source-2", start: 0, end: 6 }),
      citationFor(content, { id: "citation-5", sourceId: "source-5", start: 8, end: content.length, blockOrdinal: 1 }),
    ];
    renderNodePage({ getResearchNodeView: async () => view });

    const firstMarker = await screen.findByLabelText("打开来源 2：第二个来源");
    const secondMarker = screen.getByLabelText("打开来源 5：第五个来源");
    expect(firstMarker).toHaveAttribute("href", "https://example.com/two");
    expect(firstMarker).toHaveAttribute("rel", "noopener noreferrer");
    expect(firstMarker.querySelector("sup")).toHaveTextContent("");
    expect(firstMarker.querySelector("sup")).toHaveAttribute("data-citation-index", "2");
    expect(secondMarker.querySelector("sup")).toHaveAttribute("data-citation-index", "5");
    expect(firstMarker.closest("[data-block-id]")).toHaveAttribute("data-block-id", "m-out#p0");
    const toggle = screen.getByRole("button", { name: "本轮引用了 2 个来源" });
    const list = document.getElementById(toggle.getAttribute("aria-controls") ?? "") as HTMLOListElement;
    expect(list).toHaveAttribute("aria-label", "本轮引用来源列表");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", list.id);
    expect(list).not.toBeVisible();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(list).toBeVisible();
    expect(screen.getByText("第二个来源")).toBeVisible();
    expect(screen.getByText("第五个来源")).toBeVisible();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(list).not.toBeVisible();
    expect(screen.getByTestId("grounding-scope-note")).toHaveTextContent("本轮已联网核验。");
    expect(screen.getByTestId("grounding-scope-note")).not.toHaveTextContent("2 个");
  });

  it("无 URL 引用点击后先展开来源区域，再定位并短暂强调对应条目", async () => {
    const content = "这条结论来自供应商定位信息。";
    const view = viewWithAssistant(content);
    view.tasks[0] = makeTask({
      id: "task-1",
      status: "completed",
      inputMessageId: "m-in",
      outputMessageId: "m-out",
      groundingScope: { status: "grounded", sourceCount: 1, citationCount: 1, runId: "run-1" },
    });
    view.groundingSources = [
      { id: "source-4", runId: "run-1", ordinal: 4, title: "无链接来源", locator: "第 4 段", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    view.citations = [
      citationFor(content, { id: "citation-4", sourceId: "source-4", start: 0, end: content.length }),
    ];
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderNodePage({ getResearchNodeView: async () => view });

    const marker = await screen.findByLabelText("查看来源 4：无链接来源");
    const toggle = screen.getByRole("button", { name: "本轮引用了 1 个来源" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(marker);

    await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "true"));
    const target = document.getElementById("grounding-source-source-4");
    expect(target).toHaveClass("grounding-source--target");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "nearest" }));
  });

  it("正文版本失效时不猜角标位置，缺失来源仍提供可点击的明确降级说明", async () => {
    const content = "当前正文包含两条可核验陈述。";
    const view = viewWithAssistant(content);
    view.tasks[0] = makeTask({
      id: "task-1",
      status: "completed",
      inputMessageId: "m-in",
      outputMessageId: "m-out",
      groundingScope: { status: "grounded", sourceCount: 2, citationCount: 2, runId: "run-1" },
    });
    view.groundingSources = [
      { id: "source-stale", runId: "run-1", ordinal: 1, title: "仍可查看的来源", url: "https://example.test/stale", createdAt: "2026-08-31T00:00:00.000Z" },
    ];
    const stale = citationFor(content, { id: "citation-1", sourceId: "source-stale", start: 0, end: 4 });
    view.citations = [
      { ...stale, location: { ...stale.location, bodyVersionId: "body:m-out:stale" } },
      citationFor(content, { id: "citation-2", sourceId: "source-deleted", start: 4, end: content.length }),
    ];
    renderNodePage({ getResearchNodeView: async () => view });

    expect(await screen.findByLabelText("查看来源 2：来源记录已失效")).toBeInTheDocument();
    expect(screen.queryByLabelText("打开来源 1：仍可查看的来源")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "本轮引用了 2 个来源" })).toBeInTheDocument();
    expect(screen.getByText("正文中的精确引用位置已失效；现有来源信息仍可查看。")).toBeInTheDocument();
    expect(screen.getByText("这条引用的来源记录已不可用，无法打开或精确返回。")).toBeInTheDocument();
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
    normalizedConcepts: [],
    sourceRefs: [],
    isProvisional: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

/** 把最后一段拉长到超过共享长文阈值（>2000 字），前文断言文本保持逐字不变。 */
function asLong(content: string): string {
  const filler = "填充".repeat(1_200);
  const blocks = content.split("\n\n");
  const last = blocks[blocks.length - 1] ?? "";
  return [...blocks.slice(0, -1), `${last}${filler}`].join("\n\n");
}

describe("长文轮次卡片内章节结构", () => {
  function viewWithSlices(content: string, slices: ResearchSliceRecord[]): ResearchNodeView {
    const view = viewWithAssistant(content);
    view.slices = { "m-out": slices };
    return view;
  }

  it("每个正式切片形成一个卡内章节：h3 标题按 ordinal 顺序输出切片标题", async () => {
    const content = asLong("第一段。\n\n第二段。\n\n第三段。");
    const slices = [
      makeSlice({ id: "slice:session-1:m-out:0", ordinal: 0, title: "起点" }),
      makeSlice({ id: "slice:session-1:m-out:1", ordinal: 1, title: "推进" }),
      makeSlice({ id: "slice:session-1:m-out:2", ordinal: 2, title: "收束" }),
    ];
    renderNodePage({ getResearchNodeView: async () => viewWithSlices(content, slices) });

    await screen.findByText("第一段。");
    const headings = screen.getAllByRole("heading", { level: 3 }).filter((h) => h.classList.contains("slice-card__title"));
    expect(headings.map((h) => h.textContent)).toEqual(["起点", "推进", "收束"]);
  });

  it("章节 region 的可访问名 = 标题（aria-labelledby）", async () => {
    const content = asLong("第一段。\n\n第二段。");
    const slices = [
      makeSlice({ id: "slice:session-1:m-out:0", ordinal: 0, title: "起点" }),
      makeSlice({ id: "slice:session-1:m-out:1", ordinal: 1, title: "推进" }),
    ];
    renderNodePage({ getResearchNodeView: async () => viewWithSlices(content, slices) });

    const heading = await screen.findByRole("heading", { name: "起点", level: 3 });
    const card = heading.closest("section");
    expect(card).toHaveAttribute("aria-labelledby", heading.id);
    expect(card).toHaveAttribute("data-slice-id", "slice:session-1:m-out:0");
  });

  it("生成自由化：空标题派生切片仍渲染卡片，改用 aria-label=正文摘要（无悬空 aria-labelledby）", async () => {
    const content = asLong("第一段没有标题的正文。\n\n第二段也没有标题的正文。");
    const slices = [
      makeSlice({ id: "slice:session-1:m-out:0", ordinal: 0, title: "" }),
      makeSlice({ id: "slice:session-1:m-out:1", ordinal: 1, title: "  " }),
    ];
    const { container } = renderNodePage({ getResearchNodeView: async () => viewWithSlices(content, slices) });

    await screen.findByText("第一段没有标题的正文。");
    // 空标题章节仍渲染（不消失），但不输出空 <h3>。
    expect(container.querySelectorAll("section.turn-card__section").length).toBe(2);
    expect(container.querySelectorAll(".slice-card__title").length).toBe(0);
    // 无标题时不留悬空 aria-labelledby，改用 aria-label = 正文摘要作为可访问名。
    const firstSection = container.querySelectorAll<HTMLElement>("section.turn-card__section")[0]!;
    expect(firstSection).not.toHaveAttribute("aria-labelledby");
    expect(firstSection).toHaveAttribute("aria-label", "第一段没有标题的正文。");
  });

  it("防回归锁：标题是正文容器外的兄弟节点，data-block-text 的 textContent 不含标题", async () => {
    const content = asLong("第一段。\n\n第二段。");
    const slices = [
      makeSlice({ id: "slice:session-1:m-out:0", ordinal: 0, title: "起点" }),
      makeSlice({ id: "slice:session-1:m-out:1", ordinal: 1, title: "推进" }),
    ];
    const { container } = renderNodePage({ getResearchNodeView: async () => viewWithSlices(content, slices) });

    const first = await screen.findByText("第一段。");
    const block = first.closest<HTMLElement>("[data-block-text]")!;
    // 选区锚点偏移基准：块文本恰为切片正文，标题绝不混入
    expect(block.textContent).toBe("第一段。");
    expect(block).toHaveAttribute("data-block-id", "m-out#p0");
    // 标题在块容器外、卡内章节中
    const section = first.closest("section.turn-card__section")!;
    const title = section.querySelector(".slice-card__title")!;
    expect(block.contains(title)).toBe(false);
    expect(section.contains(title)).toBe(true);
    // 祖先仍带选区锚点定位所需标记
    expect(first.closest("[data-content-kind]")).toHaveAttribute("data-content-kind", "message");
    expect(first.closest("[data-message-id]")).toHaveAttribute("data-message-id", "m-out");
  });

  it("正文含节标题时：标题只渲染一次（提升正文标题），锚点正确，正文 textContent 仍含标题行", async () => {
    // plan-then-write 形态：节单元 content 首行即节标题，title 与之同源。
    const sectionContent = "## 背景与起源\n\n背景正文第一段。";
    const content = asLong(`${sectionContent}\n\n## 核心创新\n\n创新正文第一段。`);
    const slices = [
      makeSlice({ id: "slice:session-1:m-out:0", ordinal: 0, title: "背景与起源" }),
      makeSlice({ id: "slice:session-1:m-out:1", ordinal: 1, title: "核心创新" }),
    ];
    const { container } = renderNodePage({ getResearchNodeView: async () => viewWithSlices(content, slices) });

    await screen.findByText("背景正文第一段。");
    // 同一标题只出现一次：没有独立补题 <h3>，标题由正文里的标题元素提升而来。
    const titles = container.querySelectorAll(".slice-card__title");
    expect(titles.length).toBe(2);
    expect([...titles].map((t) => t.textContent)).toEqual(["背景与起源", "核心创新"]);
    // 每个章节里该标题只出现一次（不重复渲染）。
    const firstSection = container.querySelectorAll<HTMLElement>("section.turn-card__section")[0]!;
    expect(firstSection.querySelectorAll(".slice-card__title").length).toBe(1);
    // 导航锚点挂在被提升的正文标题上。
    expect(firstSection.querySelector(".slice-card__title")).toHaveAttribute("id", "m-out#p0-title");
    // 选区偏移基准：正文 textContent 仍含标题行（标题字符留在 data-block-text 内）。
    const block = firstSection.querySelector<HTMLElement>("[data-block-text]")!;
    expect(block.textContent).toContain("背景与起源");
    expect(block.textContent).toContain("背景正文第一段。");
  });

  it("正文无标题行、title 为事后补题时：独立 <h3> 在正文容器外，不重复、不混入偏移基准", async () => {
    const content = asLong("第一段。\n\n第二段。");
    const slices = [
      makeSlice({ id: "slice:session-1:m-out:0", ordinal: 0, title: "起点" }),
    ];
    const { container } = renderNodePage({ getResearchNodeView: async () => viewWithSlices(content, slices) });

    const first = await screen.findByText("第一段。");
    const block = first.closest<HTMLElement>("[data-block-text]")!;
    const section = first.closest("section.turn-card__section")!;
    const title = section.querySelector(".slice-card__title")!;
    // 补题 <h3> 留在正文容器外；正文 textContent 不含补题文字。
    expect(block.contains(title)).toBe(false);
    expect(block.textContent).toBe("第一段。");
    expect(title).toHaveAttribute("id", "m-out#p0-title");
  });

  it("术语标记按块 ordinal 落在对应卡片正文，且不混入标题", async () => {
    const content = asLong("REST 第一段。\n\nHTTP 第二段。");
    const slices = [
      makeSlice({ id: "slice:session-1:m-out:0", ordinal: 0, title: "起点" }),
      makeSlice({ id: "slice:session-1:m-out:1", ordinal: 1, title: "推进" }),
    ];
    const view = viewWithSlices(content, slices);
    view.termDetections = {
      "m-out": {
        messageId: "m-out",
        detectedAt: "2026-08-01T00:00:00.000Z",
        terms: [
          { text: "REST", blockOrdinal: 0, startOffset: 0, endOffset: 4, category: "abbreviation" },
          { text: "HTTP", blockOrdinal: 1, startOffset: 0, endOffset: 4, category: "abbreviation" },
        ],
        convergence: { termDensity: "full", nodeDepth: 0, reason: "none" },
        suppressedCount: 0,
      },
    };
    const { container } = renderNodePage({ getResearchNodeView: async () => view });

    await screen.findByText("REST", { selector: "[data-term-marker]" });
    const restMarker = container.querySelector<HTMLElement>('[data-term-block-ordinal="0"]')!;
    const httpMarker = container.querySelector<HTMLElement>('[data-term-block-ordinal="1"]')!;
    expect(restMarker).not.toBeNull();
    expect(httpMarker).not.toBeNull();
    // 术语标记在各自卡片正文块内
    expect(restMarker.closest("[data-block-id]")).toHaveAttribute("data-block-id", "m-out#p0");
    expect(httpMarker.closest("[data-block-id]")).toHaveAttribute("data-block-id", "m-out#p1");
  });

  it("标题与后续多段合并成一张卡片时，每个原始正文块的弱标记都保留", async () => {
    const content = asLong("## 核心\n\n第一段解释反向传播。\n\n第二段解释 RAG。");
    const slices = [makeSlice({ id: "slice:session-1:m-out:0", ordinal: 0, title: "核心" })];
    const view = viewWithSlices(content, slices);
    view.termDetections = {
      "m-out": {
        messageId: "m-out",
        detectedAt: "2026-08-13T00:00:00.000Z",
        terms: [
          { text: "反向传播", blockOrdinal: 1, startOffset: 5, endOffset: 9, category: "concept" },
          { text: "RAG", blockOrdinal: 2, startOffset: 6, endOffset: 9, category: "abbreviation" },
        ],
        convergence: { termDensity: "full", nodeDepth: 0, reason: "none" },
        suppressedCount: 0,
      },
    };

    const { container } = renderNodePage({ getResearchNodeView: async () => view });
    await screen.findByText("反向传播", { selector: "[data-term-marker]" });
    expect(screen.getByText("RAG", { selector: "[data-term-marker]" })).toBeInTheDocument();
    expect(container.querySelectorAll("section.turn-card__section")).toHaveLength(1);
    expect(container.querySelector('[data-term-block-ordinal="1"]')).not.toBeNull();
    expect(container.querySelector('[data-term-block-ordinal="2"]')).not.toBeNull();
  });

  it("传入 highlight 后 [data-selection-mark] 落在对应卡片正文内", async () => {
    const content = asLong("第一段。\n\n需要高亮的第二段。");
    const slices = [
      makeSlice({ id: "slice:session-1:m-out:0", ordinal: 0, title: "起点" }),
      makeSlice({ id: "slice:session-1:m-out:1", ordinal: 1, title: "推进" }),
    ];
    const selection = makeSelection({
      id: "sel-1",
      sessionId: "session-1",
      text: "高亮",
      anchor: { kind: "message", messageId: "m-out", blockOrdinal: 1, startOffset: 2, endOffset: 4, exact: "高亮" },
    });
    const { container } = renderNodePage(
      {
        getResearchNodeView: async () => viewWithSlices(content, slices),
        getResearchSelection: async () => selection,
      },
      "/nodes/session-1?sel=sel-1",
    );

    // 高亮在渲染后由 useLayoutEffect + rAF 重试圈 <mark>（?sel= 经 getResearchSelection 异步恢复）。
    // 等待卡内章节出现，再留出高亮应用的帧窗口。
    await waitFor(() => expect(container.querySelector("section.turn-card__section")).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const mark = container.querySelector<HTMLElement>("[data-selection-mark]");
    expect(mark).not.toBeNull();
    expect(mark).toHaveTextContent("高亮");
    expect(mark!.closest("[data-block-id]")).toHaveAttribute("data-block-id", "m-out#p1");
    expect(mark!.closest("section.turn-card__section")).not.toBeNull();
  });

  it("?sel 选区跨来源角标时恢复为两个文字标记，角标仍保持独立可点击", async () => {
    const content = "前后";
    const selection = makeSelection({
      id: "sel-citation",
      sessionId: "session-1",
      text: "前后",
      anchor: { kind: "message", messageId: "m-out", blockOrdinal: 0, startOffset: 0, endOffset: 2, exact: "前后" },
    });
    const view = makeNodeView({
      node: makeNode({ id: "session-1", sessionId: "session-1" }),
      session: makeSession({ id: "session-1" }),
      messages: [makeMessage({ id: "m-in", role: "user", content: "问题" }), makeMessage({ id: "m-out", role: "assistant", status: "completed", content })],
      tasks: [makeTask({ id: "task-1", status: "completed", inputMessageId: "m-in", outputMessageId: "m-out", groundingScope: { status: "grounded", sourceCount: 1, citationCount: 1, runId: "run-1" } })],
      groundingSources: [{ id: "source-1", runId: "run-1", ordinal: 1, title: "来源一", url: "https://example.test/one", createdAt: "2026-08-02T00:00:00.000Z" }],
      citations: [citationFor(content, { id: "citation-1", sourceId: "source-1", start: 0, end: 1 })],
    });
    const { container } = renderNodePage(
      { getResearchNodeView: async () => view, getResearchSelection: async () => selection },
      "/nodes/session-1?sel=sel-citation",
    );

    await waitFor(() => expect(container.querySelectorAll("[data-selection-mark]")).toHaveLength(2));
    expect([...container.querySelectorAll("[data-selection-mark]")].map((mark) => mark.textContent)).toEqual(["前", "后"]);
    const citation = screen.getByLabelText("打开来源 1：来源一");
    expect(citation.closest("[data-selection-mark]")).toBeNull();
    expect(container.querySelector(".turn-card.fragment-target--focused")).toHaveAttribute("id", "m-out-turn");
  });

  it("降级：切片为空或全是临时切片时纯文本连续渲染，不渲染标题卡", async () => {
    const content = "无正式切片的段落一。\n\n无正式切片的段落二。";
    const provisionalOnly = [
      makeSlice({ id: "slice:session-1:m-out:0", ordinal: 0, isProvisional: true }),
      makeSlice({ id: "slice:session-1:m-out:1", ordinal: 1, isProvisional: true }),
    ];
    const { container } = renderNodePage({ getResearchNodeView: async () => viewWithSlices(content, provisionalOnly) });

    await screen.findByText("无正式切片的段落一。");
    expect(container.querySelectorAll(".slice-card__title").length).toBe(0);
    expect(screen.queryByRole("heading", { level: 3, name: "段落 1" })).not.toBeInTheDocument();
    expect(container.querySelectorAll(".turn-card__section").length).toBe(0);
  });

  it("无装饰性边界元素", async () => {
    const content = "第一段。\n\n第二段。";
    const slices = [
      makeSlice({ id: "slice:session-1:m-out:0", ordinal: 0 }),
      makeSlice({ id: "slice:session-1:m-out:1", ordinal: 1 }),
    ];
    const { container } = renderNodePage({ getResearchNodeView: async () => viewWithSlices(content, slices) });

    await screen.findByText("第一段。");
    expect(container.querySelector(".message__slice-boundary")).toBeNull();
    expect(container.querySelector("[data-slice-boundary]")).toBeNull();
    expect(container.querySelectorAll("hr").length).toBe(0);
  });
});

describe("#91 普通回答轮次卡片", () => {
  it("普通回答即使有正式切片也渲染为一张轮次卡片，连续正文不再逐段拆卡", async () => {
    const content = "第一段。\n\n第二段。\n\n第三段。";
    const slices = [
      makeSlice({ id: "slice:session-1:m-out:0", ordinal: 0, title: "起点" }),
      makeSlice({ id: "slice:session-1:m-out:1", ordinal: 1, title: "推进" }),
      makeSlice({ id: "slice:session-1:m-out:2", ordinal: 2, title: "收束" }),
    ];
    const view = viewWithAssistant(content);
    view.slices = { "m-out": slices };
    const { container } = renderNodePage({ getResearchNodeView: async () => view });

    await screen.findByText("第一段。");
    expect(container.querySelectorAll("section.turn-card")).toHaveLength(1);
    expect(container.querySelectorAll("section.slice-card")).toHaveLength(0);
    // 轮次卡片容器 id 稳定：普通回答的 ?fragment=/来源落点不依赖节卡。
    expect(container.querySelector("section.turn-card")).toHaveAttribute("id", "m-out-turn");
    // 连续正文内部仍保留段落块稳定锚点（选区/弱标记/引用基线不变）。
    const blocks = container.querySelectorAll<HTMLElement>("section.turn-card [data-block-id]");
    expect(blocks).toHaveLength(3);
    expect([...blocks].map((block) => block.getAttribute("data-block-id"))).toEqual(["m-out#p0", "m-out#p1", "m-out#p2"]);
    // 切片标题不再渲染成节卡标题。
    expect(container.querySelectorAll(".slice-card__title")).toHaveLength(0);
  });

  it("长文分节也只渲染一张轮次卡片，章节仅作为卡内结构", async () => {
    const content = asLong("## 起点\n\n第一节正文。\n\n## 推进\n\n第二节正文。\n\n## 收束\n\n第三节正文。");
    const slices = [
      makeSlice({ id: "slice:session-1:m-out:0", ordinal: 0, title: "起点" }),
      makeSlice({ id: "slice:session-1:m-out:1", ordinal: 1, title: "推进" }),
      makeSlice({ id: "slice:session-1:m-out:2", ordinal: 2, title: "收束" }),
    ];
    const view = viewWithAssistant(content);
    view.slices = { "m-out": slices };
    const { container } = renderNodePage({ getResearchNodeView: async () => view });

    await screen.findByText("第一节正文。");
    expect(container.querySelectorAll("section.turn-card")).toHaveLength(1);
    expect(container.querySelectorAll("section.slice-card")).toHaveLength(0);
    expect(container.querySelectorAll("section.turn-card__section")).toHaveLength(3);
    expect(container.querySelector("section.turn-card")).toContainElement(
      container.querySelector("section.turn-card__section"),
    );
  });

  it("普通回答不显示章节导航线", async () => {
    const view = viewWithAssistant("只有一段的普通回答。");
    view.slices = {
      "m-out": [makeSlice({ id: "slice:session-1:m-out:0", ordinal: 0, title: "起点" })],
    };
    const { container } = renderNodePage({ getResearchNodeView: async () => view });

    await screen.findByText("只有一段的普通回答。");
    expect(screen.queryByRole("navigation", { name: "章节导航" })).not.toBeInTheDocument();
    expect(container.querySelectorAll(".slice-rail__tick")).toHaveLength(0);
  });

  it("片段深链与选区同块重叠：轮次卡片承载强调，精确落点保留且文字范围合并为一层", async () => {
    const content = "第一段。\n\n第二段。\n\n第三段。";
    const version = deriveBodyVersion({ messageId: "m-out", nodeId: "session-1", content, origin: "backfill", createdAt: "2026-08-02T00:00:00.000Z" });
    const slices = deriveMessageSlices("session-1", "m-out", content, 0, []);
    const fragments = deriveFragmentsFromSlices(version, slices, []);
    const selection = makeSelection({
      id: "sel-overlap",
      sessionId: "session-1",
      text: "二段",
      anchor: { kind: "message", messageId: "m-out", blockOrdinal: 1, startOffset: 1, endOffset: 3, exact: "二段" },
    });
    const view = makeNodeView({
      node: makeNode({ id: "session-1", sessionId: "session-1" }),
      session: makeSession({ id: "session-1" }),
      messages: [makeMessage({ id: "m-in", role: "user", content: "一个问题" }), makeMessage({ id: "m-out", role: "assistant", status: "completed", content })],
      tasks: [makeTask({ id: "task-1", status: "completed", inputMessageId: "m-in", outputMessageId: "m-out" })],
      slices: { "m-out": slices },
      bodyVersions: { "m-out": version },
    });
    const { container } = renderNodePage(
      {
        getResearchNodeView: async () => view,
        getResearchSelection: async () => selection,
        getResearchBodyVersion: async () => ({ version, fragments: fragments.map((fragment) => ({ ...fragment, excerpt: content.slice(fragment.startOffset, fragment.endOffset) })) }),
      },
      `/nodes/session-1?fragment=${encodeURIComponent(fragments[1].id)}&sel=${selection.id}`,
    );

    await screen.findByText("第二段。");
    await waitFor(() => {
      const focused = container.querySelector(".fragment-target--focused");
      expect(focused).not.toBeNull();
      expect(focused).toHaveAttribute("id", "m-out-turn");
    });
    expect(container.querySelector("#m-out\\#p1")).not.toHaveClass("fragment-target--focused");
    const marks = container.querySelectorAll("[data-selection-mark]");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent("第二段。");
    expect(marks[0]?.querySelector("[data-selection-mark]")).toBeNull();
  });

  it("片段跨来源角标时分别高亮角标两侧正文，不把引用按钮包进 mark", async () => {
    const content = "前文后文";
    const version = deriveBodyVersion({ messageId: "m-out", nodeId: "session-1", content, origin: "backfill", createdAt: "2026-08-02T00:00:00.000Z" });
    const slices = deriveMessageSlices("session-1", "m-out", content, 0, []);
    const fragments = deriveFragmentsFromSlices(version, slices, []);
    const view = makeNodeView({
      node: makeNode({ id: "session-1", sessionId: "session-1" }),
      session: makeSession({ id: "session-1" }),
      messages: [makeMessage({ id: "m-in", role: "user", content: "一个问题" }), makeMessage({ id: "m-out", role: "assistant", status: "completed", content })],
      tasks: [makeTask({ id: "task-1", status: "completed", inputMessageId: "m-in", outputMessageId: "m-out", groundingScope: { status: "grounded", sourceCount: 1, citationCount: 1, runId: "run-1" } })],
      slices: { "m-out": slices },
      bodyVersions: { "m-out": version },
      groundingSources: [{ id: "source-1", runId: "run-1", ordinal: 1, title: "来源一", url: "https://example.test/one", createdAt: "2026-08-02T00:00:00.000Z" }],
      citations: [citationFor(content, { id: "citation-1", sourceId: "source-1", start: 0, end: 2 })],
    });
    view.termDetections = {
      "m-out": {
        messageId: "m-out",
        detectedAt: "2026-08-02T00:00:00.000Z",
        terms: [{ text: "前文", blockOrdinal: 0, startOffset: 0, endOffset: 2, category: "concept" }],
        convergence: { termDensity: "full", nodeDepth: 0, reason: "none" },
        suppressedCount: 0,
      },
    };
    const { container } = renderNodePage(
      {
        getResearchNodeView: async () => view,
        getResearchBodyVersion: async () => ({ version, fragments: fragments.map((fragment) => ({ ...fragment, excerpt: content.slice(fragment.startOffset, fragment.endOffset) })) }),
      },
      `/nodes/session-1?fragment=${encodeURIComponent(fragments[0]!.id)}`,
    );

    await screen.findByText("前文");
    await waitFor(() => expect(container.querySelectorAll("[data-selection-mark]")).toHaveLength(2));
    expect([...container.querySelectorAll("[data-selection-mark]")].map((mark) => mark.textContent)).toEqual(["前文", "后文"]);
    const citation = screen.getByLabelText("打开来源 1：来源一");
    expect(citation.closest("[data-selection-mark]")).toBeNull();
    expect(container.querySelector(".turn-card.fragment-target--focused")).toHaveAttribute("id", "m-out-turn");
  });

  it("片段高亮自动消失时不破坏 React 正文树，来源页保持可读", async () => {
    const content = asLong("## 引言\n\n注意力机制连接查询向量、键向量和值向量。\n\nTransformer 架构通过自注意力聚合上下文。\n\nBERT 使用掩码语言模型训练双向编码器。");
    const version = deriveBodyVersion({ messageId: "m-out", nodeId: "session-1", content, origin: "backfill", createdAt: "2026-08-02T00:00:00.000Z" });
    const slices = [makeSlice({ id: "slice:session-1:m-out:0", ordinal: 0, title: "引言" })];
    const fragments = deriveFragmentsFromSlices(version, slices, []);
    const view = makeNodeView({
      node: makeNode({ id: "session-1", sessionId: "session-1" }),
      session: makeSession({ id: "session-1" }),
      messages: [makeMessage({ id: "m-in", role: "user", content: "一个问题" }), makeMessage({ id: "m-out", role: "assistant", status: "completed", content })],
      tasks: [makeTask({ id: "task-1", status: "completed", inputMessageId: "m-in", outputMessageId: "m-out" })],
      slices: { "m-out": slices },
      bodyVersions: { "m-out": version },
    });
    view.termDetections = {
      "m-out": {
        messageId: "m-out",
        detectedAt: "2026-08-02T00:00:00.000Z",
        terms: [
          { text: "注意力机制", blockOrdinal: 1, startOffset: 0, endOffset: 5, category: "concept" },
          { text: "查询向量", blockOrdinal: 1, startOffset: 7, endOffset: 11, category: "concept" },
          { text: "Transformer", blockOrdinal: 2, startOffset: 0, endOffset: 11, category: "entity" },
          { text: "掩码语言模型", blockOrdinal: 3, startOffset: 8, endOffset: 14, category: "concept" },
        ],
        convergence: { termDensity: "full", nodeDepth: 0, reason: "none" },
        suppressedCount: 0,
      },
    };
    const startResearchTermPreview = vi.fn<NonNullable<ApiClient["startResearchTermPreview"]>>(() => new Promise(() => {}));
    const { container } = renderNodePage(
      {
        getResearchNodeView: async () => view,
        getResearchBodyVersion: async () => ({ version, fragments: fragments.map((fragment) => ({ ...fragment, excerpt: content.slice(fragment.startOffset, fragment.endOffset) })) }),
        startResearchTermPreview,
      },
      `/nodes/session-1?fragment=${encodeURIComponent(fragments[0]!.id)}`,
    );

    await waitFor(() => expect(container.querySelectorAll("[data-selection-mark]").length).toBeGreaterThan(0));
    const marker = await screen.findByRole("button", { name: "解释术语 注意力机制" });
    expect(marker.querySelector("[data-selection-mark]")).not.toBeNull();
    marker.focus();
    fireEvent.keyDown(marker, { key: "Enter" });
    await waitFor(() => expect(startResearchTermPreview).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector(".fragment-target--focused")).toBeNull(), { timeout: 3_000 });
    expect(screen.getByRole("button", { name: "解释术语 注意力机制" })).toBe(marker);
    expect(document.activeElement).toBe(marker);
    expect(container.querySelector('[data-block-id="m-out#p0"]')).toHaveTextContent("注意力机制连接查询向量、键向量和值向量");
    expect(container.querySelectorAll('[data-term-marker]').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole("heading", { name: "引言" })).toBeVisible();
  });

  it("短标题与后续正文分块的片段在同一轮次卡内分别标到两个实际 DOM 块", async () => {
    const content = "## 标题\n\n**正文** [链接](https://example.test)";
    const version = deriveBodyVersion({ messageId: "m-out", nodeId: "session-1", content, origin: "backfill", createdAt: "2026-08-02T00:00:00.000Z" });
    const slices = deriveMessageSlices("session-1", "m-out", content, 0, []);
    const fragments = deriveFragmentsFromSlices(version, slices, []);
    const view = makeNodeView({
      node: makeNode({ id: "session-1", sessionId: "session-1" }),
      session: makeSession({ id: "session-1" }),
      messages: [makeMessage({ id: "m-in", role: "user", content: "一个问题" }), makeMessage({ id: "m-out", role: "assistant", status: "completed", content })],
      tasks: [makeTask({ id: "task-1", status: "completed", inputMessageId: "m-in", outputMessageId: "m-out" })],
      slices: { "m-out": slices },
      bodyVersions: { "m-out": version },
    });
    const { container } = renderNodePage(
      {
        getResearchNodeView: async () => view,
        getResearchBodyVersion: async () => ({ version, fragments: fragments.map((fragment) => ({ ...fragment, excerpt: content.slice(fragment.startOffset, fragment.endOffset) })) }),
      },
      `/nodes/session-1?fragment=${encodeURIComponent(fragments[0]!.id)}`,
    );

    await screen.findByRole("heading", { name: "标题" });
    await waitFor(() => expect(container.querySelectorAll("[data-selection-mark]").length).toBeGreaterThanOrEqual(4));
    const titleBlock = container.querySelector<HTMLElement>('[data-block-id="m-out#p0"]')!;
    const bodyBlock = container.querySelector<HTMLElement>('[data-block-id="m-out#p1"]')!;
    expect([...titleBlock.querySelectorAll<HTMLElement>("[data-selection-mark]")].map((mark) => mark.textContent).join("")).toBe("标题");
    expect([...bodyBlock.querySelectorAll<HTMLElement>("[data-selection-mark]")].map((mark) => mark.textContent).join("")).toBe("正文 链接");
    expect(container.querySelector(".turn-card.fragment-target--focused")).toHaveAttribute("id", "m-out-turn");
  });
});
