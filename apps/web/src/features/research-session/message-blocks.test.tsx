import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeMessage, makeNode, makeNodeView, makeSelection, makeSession, makeTask } from "../../test/fakes";
import { ResearchNodePage } from "./ResearchNodePage";
import type { ResearchNodeView, ResearchSliceRecord } from "@collector/capture-contracts";
import { deriveBodyVersion, deriveFragmentsFromSlices, deriveMessageSlices } from "@collector/capture-contracts";
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

describe("#36 连续语义卡片（长文路径，#91 后仅长文保留）", () => {
  function viewWithSlices(content: string, slices: ResearchSliceRecord[]): ResearchNodeView {
    const view = viewWithAssistant(content);
    view.slices = { "m-out": slices };
    return view;
  }

  it("每个正式切片一张卡片：h3 标题按 ordinal 顺序输出切片标题", async () => {
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

  it("卡片 region 的可访问名 = 标题（aria-labelledby）", async () => {
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
    // 空标题卡片仍渲染（不消失），但不输出空 <h3>。
    expect(container.querySelectorAll("section.slice-card").length).toBe(2);
    expect(container.querySelectorAll(".slice-card__title").length).toBe(0);
    // 无标题时不留悬空 aria-labelledby，改用 aria-label = 正文摘要作为可访问名。
    const firstCard = container.querySelectorAll<HTMLElement>("section.slice-card")[0]!;
    expect(firstCard).not.toHaveAttribute("aria-labelledby");
    expect(firstCard).toHaveAttribute("aria-label", "第一段没有标题的正文。");
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
    // 标题在块容器外、卡片内
    const card = first.closest("section.slice-card")!;
    const title = card.querySelector(".slice-card__title")!;
    expect(block.contains(title)).toBe(false);
    expect(card.contains(title)).toBe(true);
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
    // 每个卡片里该标题只出现一次（不重复渲染）。
    const firstCard = container.querySelectorAll<HTMLElement>("section.slice-card")[0]!;
    expect(firstCard.querySelectorAll(".slice-card__title").length).toBe(1);
    // 导航锚点挂在被提升的正文标题上。
    expect(firstCard.querySelector(".slice-card__title")).toHaveAttribute("id", "m-out#p0-title");
    // 选区偏移基准：正文 textContent 仍含标题行（标题字符留在 data-block-text 内）。
    const block = firstCard.querySelector<HTMLElement>("[data-block-text]")!;
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
    const card = first.closest("section.slice-card")!;
    const title = card.querySelector(".slice-card__title")!;
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
    expect(container.querySelectorAll("section.slice-card")).toHaveLength(1);
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
    // 等待卡片容器出现，再留出高亮应用的帧窗口，随后断言 mark 落在正确卡片。
    await waitFor(() => expect(container.querySelector("section.slice-card")).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const mark = container.querySelector<HTMLElement>("[data-selection-mark]");
    expect(mark).not.toBeNull();
    expect(mark).toHaveTextContent("高亮");
    expect(mark!.closest("[data-block-id]")).toHaveAttribute("data-block-id", "m-out#p1");
    expect(mark!.closest("section.slice-card")).not.toBeNull();
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
    expect(container.querySelectorAll(".slice-card").length).toBe(0);
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

  it("片段深链落点强调作用于轮次卡片内对应段落块（fragment-target--focused）", async () => {
    const content = "第一段。\n\n第二段。\n\n第三段。";
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
      `/nodes/session-1?fragment=${encodeURIComponent(fragments[1].id)}`,
    );

    await screen.findByText("第二段。");
    await waitFor(() => {
      const focused = container.querySelector(".fragment-target--focused");
      expect(focused).not.toBeNull();
      expect(focused).toHaveAttribute("id", "m-out#p1");
    });
  });
});
