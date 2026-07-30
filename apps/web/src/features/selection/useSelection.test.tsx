import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSelectionCapture } from "./useSelection";
import type { SelectionCaptureState } from "./useSelection";

function CaptureProbe() {
  const { active } = useSelectionCapture();
  if (!active) return <p data-testid="probe">idle</p>;
  return (
    <p data-testid="probe">
      {active.quality.level}:{active.anchor ? "anchor" : "no-anchor"}:{active.range.text}
    </p>
  );
}

function buildSessionDom(): { first: Node; second: Node } {
  document.body.innerHTML = `
    <div data-content-kind="message" data-message-id="m-out">
      <p data-block-id="m-out#p0" data-block-text="true">Alpha 段落一的内容。</p>
      <p data-block-id="m-out#p1" data-block-text="true">Beta 段落二的内容。</p>
    </div>
    <div id="outside">容器之外的文字。</div>
  `;
  const first = document.querySelector("[data-block-id='m-out#p0']")!.firstChild!;
  const second = document.querySelector("[data-block-id='m-out#p1']")!.firstChild!;
  return { first, second };
}

function mockSelection(range: Range): ReturnType<typeof vi.fn> {
  const removeAllRanges = vi.fn();
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: range.collapsed,
    rangeCount: range.collapsed ? 0 : 1,
    getRangeAt: () => range,
    removeAllRanges,
  } as unknown as Selection);
  return removeAllRanges;
}

function makeRange(startNode: Node, startOffset: number, endNode: Node, endOffset: number): Range {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

describe("useSelectionCapture", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    // jsdom 未实现 Range.getBoundingClientRect；真实浏览器行为由 Playwright 覆盖，
    // 这里给测试环境一个确定性的零矩形实现
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  });

  it("鼠标抬起时捕获单块选区，得到锚点与 ok 质量", () => {
    const { first } = buildSessionDom();
    render(<CaptureProbe />);
    mockSelection(makeRange(first, 6, first, 12));

    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });

    // “段落一的内容”6 个字，达到最小长度
    expect(screen.getByTestId("probe").textContent).toBe("ok:anchor:段落一的内容");
  });

  it("选区太短时只给质量提示，不生成锚点路径之外的记录", () => {
    const { first } = buildSessionDom();
    render(<CaptureProbe />);
    mockSelection(makeRange(first, 6, first, 8));

    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });

    expect(screen.getByTestId("probe").textContent).toBe("too_short:anchor:段落");
  });

  it("跨块选区标记为 cross_block 且没有锚点", () => {
    const { first, second } = buildSessionDom();
    render(<CaptureProbe />);
    mockSelection(makeRange(first, 6, second, 6));

    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });

    expect(screen.getByTestId("probe").textContent).toContain("cross_block:no-anchor");
  });

  it("键盘 Shift 选择同样触发捕获", () => {
    const { first } = buildSessionDom();
    render(<CaptureProbe />);
    mockSelection(makeRange(first, 6, first, 12));

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", shiftKey: true, bubbles: true }));
    });

    expect(screen.getByTestId("probe").textContent).toBe("ok:anchor:段落一的内容");
  });

  it("容器之外的选区不触发捕获；选区折叠时清空状态", () => {
    const outside = buildSessionDom().first;
    render(<CaptureProbe />);

    const outsideRange = makeRange(document.querySelector("#outside")!.firstChild!, 0, document.querySelector("#outside")!.firstChild!, 4);
    mockSelection(outsideRange);
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    expect(screen.getByTestId("probe").textContent).toBe("idle");

    mockSelection(makeRange(outside, 6, outside, 12));
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    expect(screen.getByTestId("probe").textContent).toBe("ok:anchor:段落一的内容");

    mockSelection(makeRange(outside, 6, outside, 6));
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(screen.getByTestId("probe").textContent).toBe("idle");
  });

  it("Escape 键不关闭捕获（修订一 #9：取消方式唯一为点击选取以外区域）", () => {
    const { first } = buildSessionDom();
    render(<CaptureProbe />);
    const removeAllRanges = mockSelection(makeRange(first, 6, first, 12));
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    expect(screen.getByTestId("probe").textContent).toBe("ok:anchor:段落一的内容");

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
    });
    expect(screen.getByTestId("probe").textContent).toBe("ok:anchor:段落一的内容");
    expect(removeAllRanges).not.toHaveBeenCalled();
  });

  it("点击选区窗口内部不重新捕获", () => {
    const { first } = buildSessionDom();
    render(
      <>
        <div data-selection-ui>
          <button type="button">窗口按钮</button>
        </div>
        <CaptureProbe />
      </>,
    );
    mockSelection(makeRange(first, 6, first, 12));

    const button = screen.getByRole("button", { name: "窗口按钮" });
    act(() => {
      button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });

    expect(screen.getByTestId("probe").textContent).toBe("idle");
  });

  it("表单控件获得焦点时的 selectionchange 不清空已捕获选区", () => {
    const { first } = buildSessionDom();
    document.body.insertAdjacentHTML("beforeend", '<textarea id="direction" aria-label="研究方向"></textarea>');
    render(<CaptureProbe />);
    mockSelection(makeRange(first, 6, first, 12));
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    expect(screen.getByTestId("probe").textContent).toBe("ok:anchor:段落一的内容");

    // 点击窗口内输入框：浏览器触发 selectionchange 且文档选区已折叠，捕获应保留
    document.getElementById("direction")!.focus();
    mockSelection(makeRange(first, 6, first, 6));
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(screen.getByTestId("probe").textContent).toBe("ok:anchor:段落一的内容");
  });
});
