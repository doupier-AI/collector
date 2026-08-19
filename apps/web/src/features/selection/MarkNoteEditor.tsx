import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clampOverlayToViewport } from "../../utils/anchored-overlay-position";
import { computeFloatingCapsulePlacement } from "./floating-capsule-position";
import type { FloatingPlacement } from "./floating-capsule-position";
import type { SelectionRect } from "./useSelection";

/** 未点击输入框的自动收起时限：到时判定为纯标记。 */
export const MARK_AUTO_COLLAPSE_MS = 1000;

/**
 * 标记笔记编辑器（修订二 #12）：点击【标记】后由按钮向右拉伸展开的输入框。
 *
 * 状态机：
 * - expanded：页面绝对定位（与浮动胶囊同一落点），1 秒内未聚焦则回调
 *   `onAutoCollapse`（纯标记已落库，编辑器收起）；
 * - locked：用户点击 / 聚焦输入框后计时取消，编辑器锁定在**当前视口坐标**
 *   （position: fixed）——滚轮滑动页面不移动，便于从容输入笔记；
 * - 点击编辑器以外区域：`onSaveNote(笔记)` 保存并关闭（空笔记 = 纯标记）；
 * - Escape 不关闭（与其他选区交互约束一致）。
 *
 * 选区原文以很浅的颜色作为占位提示，输入值初始为空（重复标记时由
 * `existingNote` 回填已保存笔记）。
 */
export function MarkNoteEditor({
  rect,
  selectedText,
  existingNote,
  onAutoCollapse,
  onSaveNote,
}: {
  /** 选区包围盒（视口坐标），用于初始绝对落点。 */
  rect: SelectionRect;
  /** 选区原文：输入框浅色占位提示。 */
  selectedText: string;
  /** 既有笔记（重复标记时解析自标记记录）；用户未输入时回填。 */
  existingNote?: Promise<{ note?: string } | null>;
  /** 1 秒内未聚焦：自动收起（纯标记已保存）。 */
  onAutoCollapse: () => void;
  /** 点击编辑器以外区域：保存笔记并关闭。 */
  onSaveNote: (note: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<FloatingPlacement | null>(null);
  const [locked, setLocked] = useState<{ top: number; left: number } | null>(null);
  const [note, setNote] = useState("");
  const [focused, setFocused] = useState(false);
  const touchedRef = useRef(false);
  const noteRef = useRef(note);
  noteRef.current = note;
  const finishedRef = useRef(false);
  // 以 ref 持有回调：副作用只依赖状态，不受父组件重渲染影响
  const onAutoCollapseRef = useRef(onAutoCollapse);
  onAutoCollapseRef.current = onAutoCollapse;
  const onSaveNoteRef = useRef(onSaveNote);
  onSaveNoteRef.current = onSaveNote;

  // 初始落点与浮动胶囊一致：选区上方优先、空间不足翻转、横向钳制（页面绝对坐标）
  useLayoutEffect(() => {
    const element = containerRef.current;
    const size = element
      ? { width: element.offsetWidth, height: element.offsetHeight }
      : { width: 0, height: 0 };
    setPlacement(
      computeFloatingCapsulePlacement(
        rect,
        size,
        { width: window.innerWidth, height: window.innerHeight },
        { x: window.scrollX, y: window.scrollY },
      ),
    );
  }, [rect]);

  // 1 秒未聚焦 → 自动收起（纯标记）。聚焦后计时取消
  useEffect(() => {
    if (focused) return;
    const timer = window.setTimeout(() => onAutoCollapseRef.current(), MARK_AUTO_COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [focused]);

  // 点击编辑器以外区域：保存笔记并关闭（Escape 无此效果——不监听键盘）
  useEffect(() => {
    function handlePointerDown(event: PointerEvent): void {
      const container = containerRef.current;
      if (container && event.target instanceof Node && container.contains(event.target)) return;
      if (finishedRef.current) return;
      finishedRef.current = true;
      onSaveNoteRef.current(noteRef.current);
    }
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, []);

  // 重复标记：既有笔记解析完成后回填（用户已动手输入则不覆盖）
  useEffect(() => {
    if (!existingNote) return;
    let stale = false;
    void existingNote.then((result) => {
      if (stale || touchedRef.current || !result?.note) return;
      setNote(result.note);
    });
    return () => {
      stale = true;
    };
  }, [existingNote]);

  function handleInputFocus(): void {
    if (focused) return;
    // 锁定当前视口坐标：fixed 定位，滚轮滑动页面不移动
    const box = containerRef.current?.getBoundingClientRect();
    if (box) setLocked(clampOverlayToViewport({ top: box.top, left: box.left }, { width: box.width, height: box.height }, { width: window.innerWidth, height: window.innerHeight }));
    setFocused(true);
  }

  useLayoutEffect(() => {
    if (!locked) return;
    const clampLockedPosition = () => {
      const box = containerRef.current?.getBoundingClientRect();
      if (!box) return;
      setLocked((current) => current
        ? clampOverlayToViewport(current, { width: box.width, height: box.height }, { width: window.innerWidth, height: window.innerHeight })
        : current);
    };
    window.addEventListener("resize", clampLockedPosition);
    return () => window.removeEventListener("resize", clampLockedPosition);
  }, [locked]);

  const style = locked
    ? { position: "fixed" as const, top: locked.top, left: locked.left }
    : placement
      ? { position: "absolute" as const, top: placement.top, left: placement.left }
      : { position: "absolute" as const, top: 0, left: 0, visibility: "hidden" as const };

  return createPortal(
    <div
      ref={containerRef}
      className={locked ? "mark-editor mark-editor--locked" : "mark-editor"}
      data-testid="mark-note-editor"
      data-selection-ui=""
      style={style}
    >
      <span className="mark-editor__label" aria-hidden="true">
        已标记
      </span>
      <input
        type="text"
        className="mark-editor__input"
        data-testid="mark-note-input"
        aria-label="笔记"
        placeholder={selectedText}
        value={note}
        onChange={(event) => {
          touchedRef.current = true;
          setNote(event.target.value);
        }}
        onFocus={handleInputFocus}
        onKeyDown={(event) => {
          // 明确的产品规则：Escape 不关闭笔记输入框
          if (event.key === "Escape") event.stopPropagation();
        }}
      />
    </div>,
    document.body,
  );
}
