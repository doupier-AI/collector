import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchChapterParseView, ResearchContentBlock } from "@collector/capture-contracts";
import { ReadingChapterNav, resolveChapterTarget } from "./ReadingChapterNav";

function stubMatchMedia(wide: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("min-width: 900px") ? wide : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  Reflect.deleteProperty(window, "matchMedia");
  for (const element of mountedRoots.splice(0)) element.remove();
});

const mountedRoots: HTMLElement[] = [];

function parse(overrides: Partial<ResearchChapterParseView> = {}): ResearchChapterParseView {
  return {
    taskId: "chapter-task-1",
    status: "completed",
    retryable: false,
    source: "ai",
    chapters: [
      { ordinal: 0, title: "绪论", blockOrdinal: 0 },
      { ordinal: 1, title: "方法与材料", blockOrdinal: 3 },
      { ordinal: 2, title: "结论", blockOrdinal: 7 },
    ],
    updatedAt: "2026-08-18T09:00:00.000Z",
    ...overrides,
  };
}

function blocks(): ResearchContentBlock[] {
  return Array.from({ length: 10 }, (_, ordinal) => ({
    id: `block-${ordinal}`,
    ordinal,
    text: `块${ordinal}`,
    anchor: { kind: "text", startLine: ordinal + 1, endLine: ordinal + 1, exact: `块${ordinal}` },
  }));
}

function renderNav(overrides: Partial<ResearchChapterParseView> = {}, options: { wide?: boolean; onRetry?: () => void; retryPending?: boolean } = {}) {
  const { wide = true, onRetry = vi.fn(), retryPending = false } = options;
  stubMatchMedia(wide);
  const wrapper = document.createElement("div");
  mountedRoots.push(wrapper);
  document.body.appendChild(wrapper);
  const blocksRoot = document.createElement("div");
  wrapper.appendChild(blocksRoot);
  for (let ordinal = 0; ordinal < 10; ordinal += 1) {
    const section = document.createElement("section");
    section.dataset.blockId = `block-${ordinal}`;
    section.scrollIntoView = vi.fn();
    blocksRoot.appendChild(section);
  }
  // React 挂载容器与块容器分离：首次渲染会清空 React 容器内的既有节点。
  const reactRoot = document.createElement("div");
  wrapper.appendChild(reactRoot);
  const view = render(
    <ReadingChapterNav
      parse={parse(overrides)}
      snapshotId="snapshot-current"
      blocks={blocks()}
      reducedMotion
      onRetry={onRetry}
      retryPending={retryPending}
    />,
    { container: reactRoot },
  );
  return { view, onRetry, container: wrapper };
}

describe("导入阅读页章节导航", () => {
  it("优先校验稳定位置，并在位置失效时只降级到原章节块", () => {
    const currentBlocks = blocks();
    const stable = resolveChapterTarget({
      ordinal: 1,
      title: "方法与材料",
      blockOrdinal: 3,
      location: {
        contentId: "block-7",
        bodyVersionId: "snapshot-current",
        sourceRange: { startOffset: 0, endOffset: 2 },
        exact: "块7",
      },
    }, "snapshot-current", currentBlocks);
    expect(stable).toEqual({ kind: "stable", blockId: "block-7", blockOrdinal: 7 });

    const stale = resolveChapterTarget({
      ordinal: 1,
      title: "方法与材料",
      blockOrdinal: 3,
      location: {
        contentId: "block-7",
        bodyVersionId: "snapshot-old",
        sourceRange: { startOffset: 0, endOffset: 2 },
        exact: "块7",
      },
    }, "snapshot-current", currentBlocks);
    expect(stale).toEqual({ kind: "coarse", blockId: "block-3", blockOrdinal: 3 });
  });

  it("宽屏渲染右侧线列与 AI 来源状态；点击锚点滚动到既有块", async () => {
    const user = userEvent.setup();
    const { onRetry, container } = renderNav();
    const nav = screen.getByTestId("reading-chapter-nav");
    expect(nav).toHaveAttribute("data-chapter-source", "ai");
    expect(screen.getByText("章节由 AI 通读全文生成")).toBeInTheDocument();
    expect(screen.queryByTestId("chapter-retry")).not.toBeInTheDocument();
    const item = screen.getByRole("button", { name: "方法与材料" });
    await user.click(item);
    const target = container.querySelector('[data-block-id="block-3"]') as HTMLElement;
    expect(target.scrollIntoView).toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("规则锚点来源如实呈现并给出重试入口", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderNav({ source: "rule", fallbackReason: "no_model", retryable: true }, { onRetry });
    expect(screen.getByText("未配置可用模型，章节按原文结构生成")).toBeInTheDocument();
    await user.click(screen.getByTestId("chapter-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("AI 失败与输出不可用分别诚实呈现降级原因", () => {
    const { view: failedView } = renderNav({ source: "rule", fallbackReason: "ai_failed", retryable: true, status: "failed" });
    expect(screen.getByText("AI 章节解析失败，已按原文结构生成")).toBeInTheDocument();
    failedView.unmount();

    renderNav({ source: "rule", fallbackReason: "ai_invalid", retryable: true, status: "failed" });
    expect(screen.getByText("AI 章节输出不可用，已按原文结构生成")).toBeInTheDocument();
  });

  it("解析进行中且无锚点时只显示状态行，不渲染线列", () => {
    renderNav({ status: "running", source: undefined, chapters: [] });
    expect(screen.getByText("AI 正在通读全文，章节导航稍后补齐…")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("窄屏浮动入口打开抽屉，Escape 关闭并归还焦点", async () => {
    const user = userEvent.setup();
    renderNav({}, { wide: false });
    const entry = screen.getByTestId("reading-chapter-entry");
    expect(entry).toHaveAttribute("aria-expanded", "false");
    await user.click(entry);
    const drawer = screen.getByTestId("reading-chapter-nav");
    expect(within(drawer).getByRole("button", { name: "方法与材料" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("reading-chapter-nav")).not.toBeInTheDocument();
    expect(entry).toHaveFocus();
  });

  it("抽屉内点击章节滚动并关闭抽屉", async () => {
    const user = userEvent.setup();
    const { container } = renderNav({}, { wide: false });
    await user.click(screen.getByTestId("reading-chapter-entry"));
    await user.click(screen.getByRole("button", { name: "绪论" }));
    expect(screen.queryByTestId("reading-chapter-nav")).not.toBeInTheDocument();
    const target = container.querySelector('[data-block-id="block-0"]') as HTMLElement;
    expect(target.scrollIntoView).toHaveBeenCalled();
  });

  it("重试进行中禁用按钮并显示进行中文案", () => {
    renderNav({ source: "rule", fallbackReason: "no_model", retryable: true }, { retryPending: true });
    expect(screen.getByTestId("chapter-retry")).toBeDisabled();
    expect(screen.getByText("重试中…")).toBeInTheDocument();
  });
});
