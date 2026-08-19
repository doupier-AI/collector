import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SliceRailNav, findSliceCardElement } from "./SliceRailNav";
import type { SliceRailItem } from "./SliceRailNav";

/**
 * SliceRailNav 章节导航（#95，ADR-0032 右侧轨道）组件测试。
 *
 * 覆盖票据针对旧导航三类缺陷的新实现规则：
 * - 锚点恒存在：线绑定恒渲染的卡片容器（cardId），现场解析，不缓存 DOM 引用；
 *   无标题卡片也能跳转（旧实现只在有标题时挂标题锚点，无标题点击静默失败）。
 * - 精确索引跳转：点击来自线自身的扁平下标（无 Y 比例估算，组件也不提供拖动映射）。
 * - 高亮粘住：点击后保持高亮，resize 等不夺走；用户自己滚动才交还跟随。
 * - 跟随当前阅读轮次：多长文轮并存时线列只渲染当前高亮所在那一轮的节。
 * - 预览不遮挡热区 + 键盘：聚焦出预览、Escape 关闭并恢复焦点。
 * - 窄屏（<900px）：浮动入口 + 覆盖抽屉，Escape/遮罩关闭，断点翻转重置。
 * - reduced-motion：跳转 behavior 退化为 auto。
 *
 * jsdom 无真实布局：mock 锚点 getBoundingClientRect 注入矩形，派发 scroll/resize 触发裁决；
 * matchMedia 由可控 stub 提供（jsdom 无 matchMedia），支撑宽/窄屏与断点翻转用例。
 */

/** 单长文轮：三节，用于几何决胜与交互用例。 */
const ITEMS_SINGLE: SliceRailItem[] = [
  { cardId: "m-out#p0-card", groupKey: "m-out", title: "第一节", excerpt: "一" },
  { cardId: "m-out#p1-card", groupKey: "m-out", title: "第二节", excerpt: "二" },
  { cardId: "m-out#p2-card", groupKey: "m-out", title: "第三节", excerpt: "三" },
];

/** 两个长文轮（mA 两节 + mB 两节），用于「跟随当前阅读轮次」用例。 */
const ITEMS_MULTI: SliceRailItem[] = [
  { cardId: "mA#p0-card", groupKey: "mA", title: "上篇一节", excerpt: "上一" },
  { cardId: "mA#p1-card", groupKey: "mA", title: "上篇二节", excerpt: "上二" },
  { cardId: "mB#p0-card", groupKey: "mB", title: "下篇一节", excerpt: "下一" },
  { cardId: "mB#p1-card", groupKey: "mB", title: "下篇二节", excerpt: "下二" },
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

/** 可控 matchMedia stub：按查询区分——900px 断点由 setWide 控制（触发 change 监听），
    prefers-reduced-motion 由 reducedMotion 固定，其余查询一律不匹配。 */
function stubMatchMedia(options: { wide?: boolean; reducedMotion?: boolean } = {}) {
  let wide = options.wide ?? true;
  const reducedMotion = options.reducedMotion ?? false;
  const listeners = new Set<() => void>();
  const makeMql = (query: string): MediaQueryList => {
    const isWidth = query.includes("min-width: 900px");
    return {
      get matches() {
        if (isWidth) return wide;
        if (query.includes("prefers-reduced-motion")) return reducedMotion;
        return false;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, cb: () => void) => {
        if (isWidth) listeners.add(cb);
      },
      removeEventListener: (_type: string, cb: () => void) => {
        listeners.delete(cb);
      },
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => makeMql(query)),
  });
  return {
    setWide(next: boolean) {
      wide = next;
      act(() => {
        listeners.forEach((cb) => cb());
      });
    },
  };
}

/** 渲染各节卡片（只有恒在的容器，不挂标题锚点）+ 导航，返回卡片元素（按传入顺序）。 */
function setup(items: SliceRailItem[], options: { wide?: boolean; reducedMotion?: boolean } = {}) {
  observedElements = [];
  const media = stubMatchMedia(options);
  const { container } = render(
    <div>
      {items.map((item) => (
        <section key={item.cardId} id={item.cardId} className="slice-card">
          {item.title}
        </section>
      ))}
      <SliceRailNav items={items} />
    </div>,
  );
  const cards = items.map((item) => container.querySelector<HTMLElement>(`#${CSS.escape(item.cardId)}`)!);
  return { container, cards, media };
}

/** 设定各卡片矩形（mock getBoundingClientRect），再派发 scroll 触发一次裁决 + rAF。 */
function fireRects(rects: Array<{ index: number; top: number }>) {
  setRects(rects);
  act(() => {
    window.dispatchEvent(new Event("scroll"));
    // 跑掉 rAF（jsdom 里 rAF 走 setTimeout ~16ms）
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
  return document.querySelector<HTMLElement>('.slice-rail__tick[aria-current="location"]');
}

describe("SliceRailNav 章节导航", () => {
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
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("宽屏观察目标是整张卡片容器（cardId），不是标题行", () => {
    setup(ITEMS_SINGLE);
    expect(observedElements.map((el) => el.id)).toEqual(["m-out#p0-card", "m-out#p1-card", "m-out#p2-card"]);
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(activeTick()?.className).toContain("slice-rail__tick");
  });

  it("findSliceCardElement 现场解析卡片容器，不缓存", () => {
    setup(ITEMS_SINGLE);
    expect(findSliceCardElement("m-out#p1-card")?.textContent).toBe("第二节");
    expect(findSliceCardElement("不存在")).toBeNull();
  });

  it("滚动跟随：取卡片顶 ≤ 阅读线中最靠下（正在读）的那节", () => {
    setup(ITEMS_SINGLE);
    fireRects([
      { index: 0, top: -200 },
      { index: 1, top: 100 },
      { index: 2, top: 600 },
    ]);
    // 阅读线 350：顶 ≤350 的是第 0、1 节，最靠下的是第 1 节 → 亮第二节。
    expect(activeTick()).toHaveAttribute("aria-label", "第二节");
  });

  it("标题滚出屏幕、正文仍压注视区时仍亮当前节（观察整卡而非标题行）", () => {
    setup(ITEMS_SINGLE);
    fireRects([
      { index: 0, top: -500 },
      { index: 1, top: 400 },
      { index: 2, top: 900 },
    ]);
    expect(activeTick()).toHaveAttribute("aria-label", "第一节");
  });

  it("未滚到首节前兜底亮首节；滚到底亮末节", () => {
    setup(ITEMS_SINGLE);
    fireRects([
      { index: 0, top: 500 },
      { index: 1, top: 900 },
      { index: 2, top: 1300 },
    ]);
    expect(activeTick()).toHaveAttribute("aria-label", "第一节");

    const scrollingEl = document.scrollingElement ?? document.documentElement;
    // scrollTop(4004) + innerHeight(1000) >= scrollHeight(5000) - 4 → 触底。
    (scrollingEl as { scrollTop: number }).scrollTop = 4004;
    fireRects([{ index: 2, top: 800 }]);
    expect(activeTick()).toHaveAttribute("aria-label", "第三节");
  });

  it("点击精确跳转到该节卡片并粘住高亮：resize 不夺走，用户自己滚动才交还跟随", () => {
    const { cards } = setup(ITEMS_SINGLE);
    // jsdom 无 scrollIntoView：点击不触发程序性滚动，直接验证粘住状态机。
    const ticks = document.querySelectorAll<HTMLElement>(".slice-rail__tick");
    act(() => {
      fireEvent.click(ticks[1]);
    });
    expect(activeTick()).toBe(ticks[1]);
    expect(ticks[1].className).toContain("slice-rail__tick--active");

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

    // 用户自己的滚动：交还粘住，恢复跟随裁决（此时 rect 判给第 0 节）。
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
    // cards 仅用于确认卡片容器恒在文档中（点击目标可现场解析）。
    expect(cards).toHaveLength(3);
  });

  it("无标题卡片点击也跳转：目标是恒在的卡片容器（旧实现的死链修复）", () => {
    const noTitle: SliceRailItem[] = [
      { cardId: "m-out#p0-card", groupKey: "m-out", title: "", excerpt: "无标题正文开头" },
      { cardId: "m-out#p1-card", groupKey: "m-out", title: "有标题", excerpt: "二" },
    ];
    const { cards } = setup(noTitle);
    const scrollIntoView = vi.fn();
    for (const el of cards) el.scrollIntoView = scrollIntoView;

    const first = screen.getByRole("button", { name: "无标题正文开头" });
    act(() => {
      fireEvent.click(first);
    });
    // 目标是卡片容器（cards[0]），不依赖可能缺省的标题锚点。
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  it("点击跳转调用卡片 scrollIntoView：默认 smooth，reduced-motion 退化为 auto", () => {
    const { cards } = setup(ITEMS_SINGLE);
    const scrollIntoView = vi.fn();
    for (const el of cards) el.scrollIntoView = scrollIntoView;
    const ticks = document.querySelectorAll<HTMLElement>(".slice-rail__tick");
    act(() => {
      fireEvent.click(ticks[2]);
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });

    // reduced-motion：跳转无平滑动画。
    cleanup();
    const second = setup(ITEMS_SINGLE, { reducedMotion: true });
    const scrollReduced = vi.fn();
    for (const el of second.cards) el.scrollIntoView = scrollReduced;
    const ticksAgain = document.querySelectorAll<HTMLElement>(".slice-rail__tick");
    act(() => {
      fireEvent.click(ticksAgain[0]);
    });
    expect(scrollReduced).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
  });

  it("跟随当前阅读轮次：多长文轮并存时线列只渲染当前高亮所在那一轮的节", () => {
    setup(ITEMS_MULTI);
    // 初始 spyIndex=0 → 当前组 mA，只渲染 mA 的两节。
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["上篇一节", "上篇二节"]);

    // 滚动让 mB 首节成为「顶 ≤ 阅读线中最靠下」者 → 当前组翻到 mB，线列整组替换。
    fireRects([
      { index: 0, top: -500 },
      { index: 1, top: -300 },
      { index: 2, top: 100 },
      { index: 3, top: 600 },
    ]);
    expect(activeTick()).toHaveAttribute("aria-label", "下篇一节");
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["下篇一节", "下篇二节"]);
  });

  it("悬停约半秒后出预览：标题 + 正文开头；无标题只显示正文开头", () => {
    const { container } = setup(ITEMS_SINGLE);
    const ticks = container.querySelectorAll<HTMLElement>(".slice-rail__tick");
    act(() => {
      fireEvent.mouseEnter(ticks[1]);
      vi.advanceTimersByTime(499);
    });
    expect(container.querySelector(".slice-rail__preview")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    const preview = container.querySelector<HTMLElement>(".slice-rail__preview");
    expect(preview).not.toBeNull();
    expect(preview?.querySelector(".slice-rail__preview-title")?.textContent).toBe("第二节");
    expect(preview?.querySelector(".slice-rail__preview-excerpt")?.textContent).toContain("二");
    // 移开即收起（预览框 pointer-events:none，鼠标直接穿过）。
    act(() => {
      fireEvent.mouseLeave(ticks[1]);
    });
    expect(container.querySelector(".slice-rail__preview")).toBeNull();
  });

  it("悬停出预览后 Escape：关闭、焦点恢复到线，且不因程序性焦点恢复立即重开", () => {
    const { container } = setup(ITEMS_SINGLE);
    const ticks = container.querySelectorAll<HTMLElement>(".slice-rail__tick");
    act(() => {
      fireEvent.mouseEnter(ticks[1]);
      vi.advanceTimersByTime(501);
    });
    expect(container.querySelector(".slice-rail__preview")).not.toBeNull();

    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(container.querySelector(".slice-rail__preview")).toBeNull();
    expect(document.activeElement).toBe(ticks[1]);
    // 程序性焦点恢复被抑制：半秒后预览不得重新弹出。
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(container.querySelector(".slice-rail__preview")).toBeNull();
    // 用户主动移入仍可正常打开预览（抑制是一次性的）。
    act(() => {
      fireEvent.mouseEnter(ticks[1]);
      vi.advanceTimersByTime(501);
    });
    expect(container.querySelector(".slice-rail__preview")).not.toBeNull();
  });

  it("预览框按实测尺寸固定在视口内：滚动后仍与被预览线中心对齐", () => {
    const { container } = setup(ITEMS_SINGLE);
    const rail = container.querySelector<HTMLElement>(".slice-rail")!;
    const tick = rail.querySelectorAll<HTMLElement>(".slice-rail__tick")[1];
    rail.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    tick.getBoundingClientRect = () => ({ top: 400, bottom: 432, left: 900, right: 920, width: 20, height: 32 }) as DOMRect;
    const dimensions = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList?.contains("slice-rail__preview") ? 132 : 0;
    });
    act(() => {
      fireEvent.mouseEnter(tick);
      vi.advanceTimersByTime(501);
    });
    try {
      const preview = container.querySelector<HTMLElement>(".slice-rail__preview")!;
      expect(preview).not.toBeNull();
      expect(preview.style.top).toBe("350px");
    } finally {
      dimensions.mockRestore();
    }
  });

  it("窄屏浮动入口打开抽屉，点击节跳转并关闭抽屉", () => {
    const { container } = setup(ITEMS_SINGLE, { wide: false });
    // 窄屏不渲染宽屏线列。
    expect(container.querySelector(".slice-rail")).toBeNull();
    const entry = screen.getByTestId("slice-chapter-entry");
    expect(entry).toHaveAttribute("aria-expanded", "false");

    const scrollIntoView = vi.fn();
    for (const el of container.querySelectorAll<HTMLElement>(".slice-card")) el.scrollIntoView = scrollIntoView;

    act(() => {
      fireEvent.click(entry);
    });
    const drawer = screen.getByTestId("slice-chapter-drawer");
    expect(entry).toHaveAttribute("aria-expanded", "true");
    // 抽屉列出当前轮的节标题。
    expect(drawer).not.toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "第二节" }));
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(screen.queryByTestId("slice-chapter-drawer")).toBeNull();
  });

  it("窄屏抽屉 Escape 关闭并归还焦点给浮动入口", () => {
    setup(ITEMS_SINGLE, { wide: false });
    const entry = screen.getByTestId("slice-chapter-entry");
    act(() => {
      fireEvent.click(entry);
    });
    expect(screen.getByTestId("slice-chapter-drawer")).not.toBeNull();

    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByTestId("slice-chapter-drawer")).toBeNull();
    expect(entry).toHaveFocus();
  });

  it("窄屏抽屉点击遮罩关闭", () => {
    const { container } = setup(ITEMS_SINGLE, { wide: false });
    act(() => {
      fireEvent.click(screen.getByTestId("slice-chapter-entry"));
    });
    expect(screen.getByTestId("slice-chapter-drawer")).not.toBeNull();

    act(() => {
      fireEvent.click(container.querySelector(".panel-backdrop")!);
    });
    expect(screen.queryByTestId("slice-chapter-drawer")).toBeNull();
  });

  it("断点翻回宽屏时收起抽屉（残留覆盖层重置）", () => {
    const { container, media } = setup(ITEMS_SINGLE, { wide: false });
    act(() => {
      fireEvent.click(screen.getByTestId("slice-chapter-entry"));
    });
    expect(screen.getByTestId("slice-chapter-drawer")).not.toBeNull();

    // 翻到宽屏：抽屉关闭，改渲染右侧线列。
    media.setWide(true);
    expect(screen.queryByTestId("slice-chapter-drawer")).toBeNull();
    expect(container.querySelector(".slice-rail")).not.toBeNull();
  });
});
