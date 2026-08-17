import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnRailNav, findMessageElement } from "./TurnRailNav";
import type { TurnRailItem } from "./TurnRailNav";

/**
 * TurnRailNav 轮次导航（#94，ADR-0032 左侧轨道）组件测试。
 *
 * 覆盖票据针对旧导航三类缺陷的新实现规则：
 * - 锚点恒存在：线绑定消息元素（data-message-id），现场解析，不缓存 DOM 引用；
 * - 精确索引跳转：点击来自线自身索引（无 Y 比例估算，组件也不提供拖动映射）；
 * - 高亮粘住：点击后保持高亮，resize 等不夺走；用户自己滚动才交还跟随；
 * - 预览不遮挡热区 + 键盘：聚焦出预览、Escape 关闭并恢复焦点；
 * - reduced-motion：跳转 behavior 退化为 auto。
 *
 * jsdom 无真实布局：mock 锚点 getBoundingClientRect 注入矩形，派发 scroll/resize 触发裁决。
 */

const ITEMS: TurnRailItem[] = [
  { anchorMessageId: "m-in-1", messageId: "m-out-1", excerpt: "第一个问题：什么是本地优先研究？" },
  { anchorMessageId: "m-in-2", messageId: "m-out-2", excerpt: "第二个问题：渐进事件如何落地？" },
  { anchorMessageId: "m-in-3", messageId: "m-out-3", excerpt: "第三个问题：如何收口？" },
];

let observedElements: Element[] = [];

class MockIntersectionObserver {
  constructor(_cb: IntersectionObserverCallback) {}
  observe(el: Element) {
    observedElements.push(el);
  }
  unobserve(el: Element) {
    observedElements = observedElements.filter((e) => e !== el);
  }
  disconnect() {
    observedElements = [];
  }
}

/** 渲染三轮消息（用户提问 + AI 回答）与导航，返回锚点元素（按 ITEMS 顺序）。 */
function setup() {
  observedElements = [];
  const { container } = render(
    <div>
      <ol className="message-list">
        {ITEMS.map((item, index) => (
          <li key={item.messageId}>
            <div data-message-id={item.anchorMessageId}>用户提问 {index + 1}</div>
            <div data-message-id={item.messageId}>AI 回答 {index + 1}</div>
          </li>
        ))}
      </ol>
      <TurnRailNav items={ITEMS} />
    </div>,
  );
  const anchors = ITEMS.map((item) => container.querySelector<HTMLElement>(`[data-message-id="${item.anchorMessageId}"]`)!);
  return { container, anchors };
}

/** 设定各锚点矩形，再派发 scroll 触发一次裁决 + rAF。 */
function fireRects(rects: Array<{ index: number; top: number }>) {
  setRects(rects);
  act(() => {
    window.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(32);
  });
}

/** 只注入矩形不派发事件（供粘住/resize 用例精细控制触发源）。 */
function setRects(rects: Array<{ index: number; top: number }>) {
  for (const { index, top } of rects) {
    const el = observedElements[index] as HTMLElement;
    el.getBoundingClientRect = () => ({ top }) as DOMRect;
  }
}

function activeTick(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.turn-rail__tick[aria-current="location"]');
}

function stubMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: () => false,
    })),
  });
}

describe("TurnRailNav 轮次导航", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    // 视口高 1000 → 阅读线在 350px。
    Object.defineProperty(window, "innerHeight", { value: 1000, configurable: true, writable: true });
    const scrollingEl = document.scrollingElement ?? document.documentElement;
    Object.defineProperty(scrollingEl, "scrollHeight", { value: 5000, configurable: true, writable: true });
    Object.defineProperty(scrollingEl, "scrollTop", { value: 1000, configurable: true, writable: true });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("观察目标是轮次起始消息元素（data-message-id），现场解析不缓存", () => {
    setup();
    expect(observedElements.map((el) => (el as HTMLElement).dataset.messageId)).toEqual([
      "m-in-1",
      "m-in-2",
      "m-in-3",
    ]);
    expect(screen.getAllByRole("button")).toHaveLength(3);
    // 线的可访问名含轮次序号与开头摘录
    expect(screen.getByRole("button", { name: "第 2 轮：第二个问题：渐进事件如何落地？" })).toBeInTheDocument();
  });

  it("findMessageElement 按 dataset 现场解析消息元素", () => {
    setup();
    expect(findMessageElement("m-out-2")?.textContent).toBe("AI 回答 2");
    expect(findMessageElement("不存在")).toBeNull();
  });

  it("滚动跟随：取锚点顶 ≤ 阅读线中最靠下（正在读）的那轮", () => {
    setup();
    fireRects([
      { index: 0, top: -200 },
      { index: 1, top: 100 },
      { index: 2, top: 600 },
    ]);
    // 阅读线 350：顶 ≤350 的是第 0、1 轮，最靠下的是第 1 轮 → 亮第二轮。
    expect(activeTick()).toHaveAttribute("aria-label", expect.stringContaining("第 2 轮"));
  });

  it("未滚到首轮之前兜底亮首轮；滚到底亮末轮", () => {
    setup();
    fireRects([
      { index: 0, top: 500 },
      { index: 1, top: 900 },
      { index: 2, top: 1300 },
    ]);
    expect(activeTick()).toHaveAttribute("aria-label", expect.stringContaining("第 1 轮"));

    const scrollingEl = document.scrollingElement ?? document.documentElement;
    // scrollTop(4004) + innerHeight(1000) >= scrollHeight(5000) - 4 → 触底。
    (scrollingEl as { scrollTop: number }).scrollTop = 4004;
    fireRects([{ index: 2, top: 800 }]);
    expect(activeTick()).toHaveAttribute("aria-label", expect.stringContaining("第 3 轮"));
  });

  it("点击线精确跳转并粘住高亮：resize 不夺走，用户自己滚动才交还跟随", () => {
    const { anchors } = setup();
    // jsdom 无 scrollIntoView：点击不触发程序性滚动，直接验证粘住状态机。
    const ticks = document.querySelectorAll<HTMLElement>(".turn-rail__tick");
    act(() => {
      fireEvent.click(ticks[1]);
    });
    expect(activeTick()).toBe(ticks[1]);
    expect(ticks[1].className).toContain("turn-rail__tick--active");

    // resize 只触发裁决调度——粘住期间裁决被压制，高亮不被夺走。
    setRects([
      { index: 0, top: -200 },
      { index: 1, top: 600 },
      { index: 2, top: 900 },
    ]);
    act(() => {
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(32);
    });
    expect(activeTick()).toBe(ticks[1]);

    // 用户自己的滚动：交还粘住，恢复跟随裁决（此时 rect 判给第 1 轮）。
    setRects([
      { index: 0, top: 100 },
      { index: 1, top: 600 },
      { index: 2, top: 900 },
    ]);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(32);
    });
    expect(activeTick()).toBe(ticks[0]);
    // anchors 仅用于确认锚点恒在文档中（点击目标可现场解析）
    expect(anchors).toHaveLength(3);
  });

  it("点击跳转调用 scrollIntoView：默认 smooth，reduced-motion 退化为 auto", () => {
    const { anchors } = setup();
    const scrollIntoView = vi.fn();
    for (const el of anchors) el.scrollIntoView = scrollIntoView;

    const ticks = document.querySelectorAll<HTMLElement>(".turn-rail__tick");
    act(() => {
      fireEvent.click(ticks[2]);
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });

    cleanup();
    stubMatchMedia(true);
    const second = setup();
    const scrollReduced = vi.fn();
    for (const el of second.anchors) el.scrollIntoView = scrollReduced;
    const ticksAgain = document.querySelectorAll<HTMLElement>(".turn-rail__tick");
    act(() => {
      fireEvent.click(ticksAgain[0]);
    });
    expect(scrollReduced).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
  });

  it("悬停约半秒后出预览：标题为轮次序号，正文为该轮开头摘录", () => {
    const { container } = setup();
    const ticks = container.querySelectorAll<HTMLElement>(".turn-rail__tick");
    act(() => {
      fireEvent.mouseEnter(ticks[1]);
      vi.advanceTimersByTime(499);
    });
    expect(container.querySelector(".turn-rail__preview")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    const preview = container.querySelector<HTMLElement>(".turn-rail__preview");
    expect(preview).not.toBeNull();
    expect(preview?.querySelector(".turn-rail__preview-title")?.textContent).toBe("第 2 轮");
    expect(preview?.querySelector(".turn-rail__preview-excerpt")?.textContent).toContain("第二个问题");
    // 移开即收起（预览框 pointer-events:none，鼠标直接穿过）
    act(() => {
      fireEvent.mouseLeave(ticks[1]);
    });
    expect(container.querySelector(".turn-rail__preview")).toBeNull();
  });

  it("聚焦出预览；Escape 关闭预览并把焦点恢复到线", () => {
    const { container } = setup();
    const ticks = container.querySelectorAll<HTMLElement>(".turn-rail__tick");
    act(() => {
      ticks[2].focus();
      vi.advanceTimersByTime(501);
    });
    expect(container.querySelector(".turn-rail__preview")).not.toBeNull();

    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(container.querySelector(".turn-rail__preview")).toBeNull();
    expect(document.activeElement).toBe(ticks[2]);
    // 焦点恢复不重开预览
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(container.querySelector(".turn-rail__preview")).toBeNull();
  });

  it("悬停出预览后 Escape：关闭、焦点恢复到线，且不因程序性焦点恢复立即重开", () => {
    const { container } = setup();
    const ticks = container.querySelectorAll<HTMLElement>(".turn-rail__tick");
    act(() => {
      fireEvent.mouseEnter(ticks[1]);
      vi.advanceTimersByTime(501);
    });
    expect(container.querySelector(".turn-rail__preview")).not.toBeNull();

    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(container.querySelector(".turn-rail__preview")).toBeNull();
    expect(document.activeElement).toBe(ticks[1]);
    // 程序性焦点恢复被抑制：半秒后预览不得重新弹出
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(container.querySelector(".turn-rail__preview")).toBeNull();
    // 用户主动移入仍可正常打开预览（抑制是一次性的）
    act(() => {
      fireEvent.mouseEnter(ticks[1]);
      vi.advanceTimersByTime(501);
    });
    expect(container.querySelector(".turn-rail__preview")).not.toBeNull();
  });

  it("预览框参考系为线列自身：滚动后仍与被预览线中心对齐（不漂移）", () => {
    const { container } = setup();
    const rail = container.querySelector<HTMLElement>(".turn-rail")!;
    const tick = rail.querySelectorAll<HTMLElement>(".turn-rail__tick")[1];
    rail.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    tick.getBoundingClientRect = () => ({ top: 400, height: 32 }) as DOMRect;
    const expected = 400 + 32 / 2 - 132 / 2 - 100; // = 250
    act(() => {
      fireEvent.mouseEnter(tick);
      vi.advanceTimersByTime(501);
    });
    const preview = container.querySelector<HTMLElement>(".turn-rail__preview")!;
    expect(preview).not.toBeNull();
    expect(preview.style.top).toBe(`${expected}px`);
  });
});
