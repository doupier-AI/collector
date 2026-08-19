import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkNoteEditor, MARK_AUTO_COLLAPSE_MS } from "./MarkNoteEditor";

const RECT = { top: 200, bottom: 220, left: 100, right: 300 };

function renderEditor(props: {
  onAutoCollapse?: () => void;
  onSaveNote?: (note: string) => void;
  existingNote?: Promise<{ note?: string } | null>;
} = {}) {
  return render(
    <MarkNoteEditor
      rect={RECT}
      selectedText="本地优先会先把输入保存在本机"
      onAutoCollapse={props.onAutoCollapse ?? vi.fn()}
      onSaveNote={props.onSaveNote ?? vi.fn()}
      existingNote={props.existingNote}
    />,
  );
}

describe("MarkNoteEditor（修订二 #12）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("展开为输入框：选区原文作浅色占位提示，输入值初始为空", () => {
    renderEditor();
    const input = screen.getByTestId("mark-note-input");
    expect(input).toHaveAttribute("placeholder", "本地优先会先把输入保存在本机");
    expect(input).toHaveValue("");
    expect(screen.getByTestId("mark-note-editor")).toHaveTextContent("已标记");
  });

  it("1 秒内未点击输入框 → 自动收起（纯标记已保存）", () => {
    const onAutoCollapse = vi.fn();
    renderEditor({ onAutoCollapse });

    act(() => {
      vi.advanceTimersByTime(MARK_AUTO_COLLAPSE_MS - 1);
    });
    expect(onAutoCollapse).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onAutoCollapse).toHaveBeenCalledTimes(1);
  });

  it("聚焦输入框取消计时，并锁定为 fixed 视口坐标", () => {
    const onAutoCollapse = vi.fn();
    renderEditor({ onAutoCollapse });

    fireEvent.focus(screen.getByTestId("mark-note-input"));
    act(() => {
      vi.advanceTimersByTime(MARK_AUTO_COLLAPSE_MS * 5);
    });
    expect(onAutoCollapse).not.toHaveBeenCalled();
    expect(screen.getByTestId("mark-note-editor").style.position).toBe("fixed");
  });

  it("已锁定的编辑器在视口缩小时重新钳制，不会推出边界", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 800 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 800 });
    renderEditor();
    const editor = screen.getByTestId("mark-note-editor");
    vi.spyOn(editor, "getBoundingClientRect").mockReturnValue({ top: 600, left: 600, width: 240, height: 40 } as DOMRect);
    fireEvent.focus(screen.getByTestId("mark-note-input"));
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 320 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 500 });
    fireEvent(window, new Event("resize"));
    expect(editor.style.top).toBe("452px");
    expect(editor.style.left).toBe("72px");
  });

  it("点击编辑器以外区域：以当前笔记内容保存并关闭", () => {
    const onSaveNote = vi.fn();
    renderEditor({ onSaveNote });

    fireEvent.change(screen.getByTestId("mark-note-input"), { target: { value: "这一段要反复验证" } });
    fireEvent.pointerDown(document.body);
    expect(onSaveNote).toHaveBeenCalledTimes(1);
    expect(onSaveNote).toHaveBeenCalledWith("这一段要反复验证");
  });

  it("空笔记同样触发保存回调（页面按纯标记处理，不再请求更新）", () => {
    const onSaveNote = vi.fn();
    renderEditor({ onSaveNote });

    fireEvent.pointerDown(document.body);
    expect(onSaveNote).toHaveBeenCalledWith("");
  });

  it("编辑器内部的 pointerdown 不触发保存", () => {
    const onSaveNote = vi.fn();
    renderEditor({ onSaveNote });

    fireEvent.pointerDown(screen.getByTestId("mark-note-input"));
    expect(onSaveNote).not.toHaveBeenCalled();
  });

  it("Escape 不关闭编辑器（聚焦后计时已取消，Escape 之后仍停留）", () => {
    const onAutoCollapse = vi.fn();
    const onSaveNote = vi.fn();
    renderEditor({ onAutoCollapse, onSaveNote });

    fireEvent.focus(screen.getByTestId("mark-note-input"));
    fireEvent.keyDown(screen.getByTestId("mark-note-input"), { key: "Escape" });
    act(() => {
      vi.advanceTimersByTime(MARK_AUTO_COLLAPSE_MS * 5);
    });
    expect(screen.getByTestId("mark-note-editor")).toBeInTheDocument();
    expect(onAutoCollapse).not.toHaveBeenCalled();
    expect(onSaveNote).not.toHaveBeenCalled();
  });

  it("重复标记：既有笔记解析完成后回填输入框", async () => {
    renderEditor({ existingNote: Promise.resolve({ note: "上次留下的笔记" }) });
    await act(async () => {});
    expect(screen.getByTestId("mark-note-input")).toHaveValue("上次留下的笔记");
  });

  it("重复标记：用户已动手输入时既有笔记不覆盖", async () => {
    const existing = new Promise<{ note?: string } | null>(() => {});
    renderEditor({ existingNote: existing });
    fireEvent.change(screen.getByTestId("mark-note-input"), { target: { value: "新写的" } });
    await act(async () => {});
    expect(screen.getByTestId("mark-note-input")).toHaveValue("新写的");
  });
});
