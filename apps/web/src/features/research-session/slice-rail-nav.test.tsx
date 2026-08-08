import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SliceRailNav } from "./SliceRailNav";
import type { SliceRailItem } from "./SliceRailNav";

/**
 * SliceRailNav 章节导航：scrollspy 几何决胜组件测试。
 *
 * 高亮规则：
 * - 观察目标是整张卡片 <section>，不是标题行；
 * - 阅读线固定在视口 35% 高度（读者自然注视区）；
 * - 同屏多卡只亮一条：取"卡片顶 ≤ 阅读线"中最靠下（最贴近当前阅读位置）者；
 * - 兜底：未滚到首节前亮首节、滚到底亮末节。
 *
 * 触发源：裁决挂在 window scroll/resize 上（整文档滚动），每次滚动对已登记卡片现场
 * getBoundingClientRect() 重测并裁决；IntersectionObserver 仅负责"发现并登记卡片元素"。
 *
 * jsdom 无真实布局，getBoundingClientRect 恒回 0：这里 mock 各卡片该方法注入矩形，再派发
 * scroll 事件触发裁决，验证决胜逻辑与 aria-current 落点。
 */

const ITEMS: SliceRailItem[] = [
  { anchorId: "m-out#p0-title", cardId: "m-out#p0-card", title: "第一节", excerpt: "一" },
  { anchorId: "m-out#p1-title", cardId: "m-out#p1-card", title: "第二节", excerpt: "二" },
  { anchorId: "m-out#p2-title", cardId: "m-out#p2-card", title: "第三节", excerpt: "三" },
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

/** 渲染三张卡片 + 导航，返回各卡片元素（按 cardId）。 */
function setup() {
  observedElements = [];
  const { container } = render(
    <div>
      {ITEMS.map((item) => (
        <section key={item.cardId} id={item.cardId} className="slice-card">
          <h3 id={item.anchorId} className="slice-card__title">
            {item.title}
          </h3>
        </section>
      ))}
      <SliceRailNav items={ITEMS} />
    </div>,
  );
  const cards = ITEMS.map((item) => container.querySelector<HTMLElement>(`#${CSS.escape(item.cardId)}`)!);
  return { container, cards };
}

/** 设定各卡片矩形（mock getBoundingClientRect），再派发 scroll 触发一次裁决 + rAF。 */
function fireRects(rects: Array<{ index: number; top: number }>) {
  for (const { index, top } of rects) {
    const el = observedElements[index] as HTMLElement;
    el.getBoundingClientRect = () => ({ top }) as DOMRect;
  }
  act(() => {
    window.dispatchEvent(new Event("scroll"));
    // 跑掉 rAF（jsdom 里 rAF 走 setTimeout ~16ms）
    vi.advanceTimersByTime(32);
  });
}

function activeTick(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.slice-rail__tick[aria-current="location"]');
}

describe("SliceRailNav 章节导航·几何决胜", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    // 视口高 1000 → 阅读线在 350px。
    Object.defineProperty(window, "innerHeight", { value: 1000, configurable: true, writable: true });
    // 默认"内容很高、未触底"：避免 jsdom scrollHeight=0 误判触发触底兜底。触底用例单独覆盖。
    const scrollingEl = document.scrollingElement ?? document.documentElement;
    Object.defineProperty(scrollingEl, "scrollHeight", { value: 5000, configurable: true, writable: true });
    Object.defineProperty(scrollingEl, "scrollTop", { value: 1000, configurable: true, writable: true });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("观察目标是整张卡片（cardId），不是标题行（anchorId）", () => {
    setup();
    expect(observedElements.map((el) => el.id)).toEqual(["m-out#p0-card", "m-out#p1-card", "m-out#p2-card"]);
    // aria-current 挂在导航线上，整列三条
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("多卡同屏只亮一条：取卡片顶 ≤ 阅读线中最靠下（正在读）的那节", () => {
    setup();
    // 三节都在视口：第一节顶 -200（已滚上去），第二节顶 100（压线），第三节顶 600（线下方）。
    fireRects([
      { index: 0, top: -200 },
      { index: 1, top: 100 },
      { index: 2, top: 600 },
    ]);
    // 阅读线 350：顶 ≤350 的是第 0、1 节，最靠下的是第 1 节 → 亮第二节。
    expect(activeTick()).toHaveAttribute("aria-label", "第二节");
  });

  it("标题滚出屏幕、正文仍压注视区时仍亮当前节（不跳到下一节）", () => {
    setup();
    // 第一节卡片很高：标题在 -500（滚出屏幕），但卡片顶 -500 ≤ 350，仍算在读；
    // 第二节顶 400（阅读线 350 之下），尚未进入阅读位置。
    fireRects([
      { index: 0, top: -500 },
      { index: 1, top: 400 },
      { index: 2, top: 900 },
    ]);
    expect(activeTick()).toHaveAttribute("aria-label", "第一节");
  });

  it("未滚到首节之前兜底亮首节", () => {
    setup();
    // 所有卡片顶都在阅读线（350）下方。
    fireRects([
      { index: 0, top: 500 },
      { index: 1, top: 900 },
      { index: 2, top: 1300 },
    ]);
    expect(activeTick()).toHaveAttribute("aria-label", "第一节");
  });

  it("滚到页面底部兜底亮末节", () => {
    setup();
    const scrollingEl = document.scrollingElement ?? document.documentElement;
    // scrollTop(4004) + innerHeight(1000) >= scrollHeight(5000) - 4 → 触底。
    (scrollingEl as { scrollTop: number }).scrollTop = 4004;
    fireRects([{ index: 2, top: 800 }]);
    expect(activeTick()).toHaveAttribute("aria-label", "第三节");
  });

  it("预览框定位以线列自身为参考系：滚动后仍与被预览线中心对齐（不漂移）", () => {
    // 无 .page 容器（旧逻辑 closest(".page") 返回 null 直接跳过，正是此前 bug 的验证盲区）。
    const { container } = setup();
    // rail 顶在视口 100 处；被预览线中心在视口 416 处（rail 内 316）。
    // 预览框顶 = 416 − 66（预览框半高 132/2）− 100 = 250。
    // 视口钳制上限 = 1000 − 100 − 132 − 12 = 756，250 未越界，公式不被钳制掩盖。
    const rail = container.querySelector<HTMLElement>(".slice-rail")!;
    const tick = rail.querySelectorAll<HTMLElement>(".slice-rail__tick")[1];
    rail.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    tick.getBoundingClientRect = () => ({ top: 400, height: 32 }) as DOMRect;
    const expected = 400 + 32 / 2 - 132 / 2 - 100; // = 250
    act(() => {
      fireEvent.mouseEnter(tick);
      vi.advanceTimersByTime(400);
    });
    const preview = container.querySelector<HTMLElement>(".slice-rail__preview")!;
    expect(preview).not.toBeNull();
    expect(preview.style.top).toBe(`${expected}px`);
  });
});
