import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectionSurface } from "./SelectionSurface";

function buildDom(): { first: Node; second: Node } {
  document.body.innerHTML = `
    <div data-content-kind="message" data-message-id="m-out">
      <p data-block-id="m-out#p0" data-block-text="true">Alpha 段落一的内容。</p>
      <p data-block-id="m-out#p1" data-block-text="true">Beta 段落二的内容。</p>
    </div>
  `;
  const first = document.querySelector("[data-block-id='m-out#p0']")!.firstChild!;
  const second = document.querySelector("[data-block-id='m-out#p1']")!.firstChild!;
  return { first, second };
}

function mockSelection(range: Range): void {
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: range.collapsed,
    rangeCount: range.collapsed ? 0 : 1,
    getRangeAt: () => range,
    removeAllRanges: vi.fn(),
  } as unknown as Selection);
}

function makeRange(node: Node, start: number, end: number): Range {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range;
}

function makeCrossBlockRange(startNode: Node, start: number, endNode: Node, end: number): Range {
  const range = document.createRange();
  range.setStart(startNode, start);
  range.setEnd(endNode, end);
  return range;
}

function mouseup(): void {
  act(() => {
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
}

function collapseSelection(): void {
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: true,
    rangeCount: 0,
    getRangeAt: () => {
      throw new Error("没有选区");
    },
    removeAllRanges: vi.fn(),
  } as unknown as Selection);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

describe("SelectionSurface（修订一 #9）", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  });

  it("有效选区呈现浮动胶囊，选区本身不再自动引用", () => {
    const { first } = buildDom();
    const onCite = vi.fn();
    render(<SelectionSurface sessionId="session-1" onCite={onCite} />);

    mockSelection(makeRange(first, 6, 12));
    mouseup();

    expect(screen.getByTestId("floating-selection-capsule")).toBeInTheDocument();
    // 自动引用已废除：只有显式点击【引用】才上报
    expect(onCite).not.toHaveBeenCalled();
  });

  it("点击【引用】上报锚点与原文，胶囊淡出后卸载（修订一 #11 过渡）", async () => {
    const user = userEvent.setup();
    const { first } = buildDom();
    const onCite = vi.fn();
    render(<SelectionSurface sessionId="session-1" onCite={onCite} />);

    mockSelection(makeRange(first, 6, 12));
    mouseup();
    await user.click(screen.getByTestId("floating-capsule-cite"));

    expect(onCite).toHaveBeenCalledTimes(1);
    const [anchor, text] = onCite.mock.calls[0]!;
    expect(text).toBe("段落一的内容");
    expect(anchor).toMatchObject({
      kind: "message",
      messageId: "m-out",
      blockOrdinal: 0,
      startOffset: 6,
      endOffset: 12,
    });

    // 引用后胶囊进入 closing 淡出（不再交互），动画结束后卸载
    const closing = screen.getByTestId("floating-selection-capsule");
    expect(closing).toHaveAttribute("aria-hidden", "true");
    fireEvent.animationEnd(closing);
    expect(screen.queryByTestId("floating-selection-capsule")).not.toBeInTheDocument();
  });

  it("点击【标记】上报锚点、原文与选区矩形，胶囊淡出后卸载（修订二 #12）", async () => {
    const user = userEvent.setup();
    const { first } = buildDom();
    const onMark = vi.fn();
    render(<SelectionSurface sessionId="session-1" onCite={vi.fn()} onMark={onMark} />);

    mockSelection(makeRange(first, 6, 12));
    mouseup();
    await user.click(screen.getByTestId("floating-capsule-mark"));

    expect(onMark).toHaveBeenCalledTimes(1);
    const [anchor, text, rect] = onMark.mock.calls[0]!;
    expect(text).toBe("段落一的内容");
    expect(anchor).toMatchObject({ kind: "message", messageId: "m-out", startOffset: 6, endOffset: 12 });
    expect(rect).toMatchObject({ top: 0, bottom: 0, left: 0, right: 0 });

    // 标记同样消费选区：胶囊 closing 淡出，动画结束后卸载
    const closing = screen.getByTestId("floating-selection-capsule");
    expect(closing).toHaveAttribute("aria-hidden", "true");
    fireEvent.animationEnd(closing);
    expect(screen.queryByTestId("floating-selection-capsule")).not.toBeInTheDocument();
  });

  it("未传 onMark 时浮动胶囊不渲染【标记】按钮（修订一引用路径不受影响）", () => {
    const { first } = buildDom();
    render(<SelectionSurface sessionId="session-1" onCite={vi.fn()} />);

    mockSelection(makeRange(first, 6, 12));
    mouseup();

    expect(screen.getByTestId("floating-selection-capsule")).toBeInTheDocument();
    expect(screen.queryByTestId("floating-capsule-mark")).not.toBeInTheDocument();
  });

  it("原生选区坍缩只关闭浮动胶囊；重新选取后胶囊再次呈现", () => {
    const { first } = buildDom();
    const onCite = vi.fn();
    render(<SelectionSurface sessionId="session-1" onCite={onCite} />);

    mockSelection(makeRange(first, 6, 12));
    mouseup();
    expect(screen.getByTestId("floating-selection-capsule")).toBeInTheDocument();

    // 点击别处：浏览器坍缩选区，selectionchange 触发
    collapseSelection();
    // 淡出结束后卸载
    fireEvent.animationEnd(screen.getByTestId("floating-selection-capsule"));
    expect(screen.queryByTestId("floating-selection-capsule")).not.toBeInTheDocument();
    expect(onCite).not.toHaveBeenCalled();

    // 重新选取：胶囊再次呈现，可引用新选区
    mockSelection(makeRange(first, 0, 5));
    mouseup();
    expect(screen.getByTestId("floating-selection-capsule")).toBeInTheDocument();
  });

  it("引用后选区仍存活时胶囊保持关闭；坍缩再选取同一段可再次引用", async () => {
    const user = userEvent.setup();
    const { first } = buildDom();
    const onCite = vi.fn();
    render(<SelectionSurface sessionId="session-1" onCite={onCite} />);

    mockSelection(makeRange(first, 6, 12));
    mouseup();
    await user.click(screen.getByTestId("floating-capsule-cite"));
    expect(onCite).toHaveBeenCalledTimes(1);

    // 淡出结束卸载
    fireEvent.animationEnd(screen.getByTestId("floating-selection-capsule"));

    // 选区仍存活：胶囊不重新出现
    mouseup();
    expect(screen.queryByTestId("floating-selection-capsule")).not.toBeInTheDocument();

    // 坍缩后重选同一段：可以再次显式引用
    collapseSelection();
    mockSelection(makeRange(first, 6, 12));
    mouseup();
    await user.click(screen.getByTestId("floating-capsule-cite"));
    expect(onCite).toHaveBeenCalledTimes(2);
  });

  it("选区坍缩时胶囊同样淡出后卸载", () => {
    const { first } = buildDom();
    render(<SelectionSurface sessionId="session-1" onCite={vi.fn()} />);

    mockSelection(makeRange(first, 6, 12));
    mouseup();
    expect(screen.getByTestId("floating-selection-capsule")).toBeInTheDocument();

    collapseSelection();
    // 进入 closing 而非立即消失
    const closing = screen.getByTestId("floating-selection-capsule");
    expect(closing).toHaveAttribute("aria-hidden", "true");
    fireEvent.animationEnd(closing);
    expect(screen.queryByTestId("floating-selection-capsule")).not.toBeInTheDocument();
  });

  it("新的有效选区出现时通过 onSelectionActivity 通知页面", () => {
    const { first } = buildDom();
    const onSelectionActivity = vi.fn();
    render(<SelectionSurface sessionId="session-1" onCite={vi.fn()} onSelectionActivity={onSelectionActivity} />);

    mockSelection(makeRange(first, 6, 12));
    mouseup();
    expect(onSelectionActivity).toHaveBeenCalledTimes(1);
  });

  it("单字选区同样呈现浮动胶囊（修订一 #10：非空即有效）", () => {
    const { first } = buildDom();
    const onCite = vi.fn();
    render(<SelectionSurface sessionId="session-1" onCite={onCite} />);

    mockSelection(makeRange(first, 6, 7));
    mouseup();

    expect(screen.getByTestId("floating-selection-capsule")).toBeInTheDocument();
    expect(screen.queryByTestId("selection-quality-hint")).not.toBeInTheDocument();
    expect(onCite).not.toHaveBeenCalled();
  });

  it("跨块选区只给质量提示，不出现浮动胶囊", () => {
    const { first, second } = buildDom();
    const onCite = vi.fn();
    render(<SelectionSurface sessionId="session-1" onCite={onCite} />);

    mockSelection(makeCrossBlockRange(first, 6, second, 6));
    mouseup();

    expect(screen.getByTestId("selection-quality-hint")).toBeInTheDocument();
    expect(screen.queryByTestId("floating-selection-capsule")).not.toBeInTheDocument();
    expect(onCite).not.toHaveBeenCalled();
  });
});
