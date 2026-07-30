import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FloatingSelectionCapsule } from "./FloatingSelectionCapsule";

const RECT = { top: 200, bottom: 220, left: 100, right: 300 };

describe("浮动选区胶囊", () => {
  it("渲染在 body 根部，绝对定位于选区上方（jsdom 零尺寸胶囊）", () => {
    render(<FloatingSelectionCapsule rect={RECT} onCite={() => {}} />);
    const capsule = screen.getByTestId("floating-selection-capsule");
    // jsdom 无布局：胶囊尺寸按 0 计算，top = 200 - 8 = 192，left = 200（选区中心）
    expect(capsule.style.position).toBe("absolute");
    expect(capsule.style.top).toBe("192px");
    expect(capsule.style.left).toBe("200px");
    // Portal 到 body，不受页面容器定位影响
    expect(capsule.parentElement).toBe(document.body);
  });

  it("点击【引用】触发 onCite", async () => {
    const user = userEvent.setup();
    const onCite = vi.fn();
    render(<FloatingSelectionCapsule rect={RECT} onCite={onCite} />);
    await user.click(screen.getByTestId("floating-capsule-cite"));
    expect(onCite).toHaveBeenCalledTimes(1);
  });

  it("容器 mousedown 阻止默认行为：点击胶囊不坍缩原生选区", () => {
    render(<FloatingSelectionCapsule rect={RECT} onCite={() => {}} />);
    const event = fireEvent.mouseDown(screen.getByTestId("floating-selection-capsule"));
    // fireEvent 返回 false 表示事件被 preventDefault
    expect(event).toBe(false);
  });

  it("标记 data-selection-ui，供捕获层跳过胶囊内部交互", () => {
    render(<FloatingSelectionCapsule rect={RECT} onCite={() => {}} />);
    expect(screen.getByTestId("floating-selection-capsule")).toHaveAttribute("data-selection-ui");
  });

  it("【引用】按钮键盘可达（role toolbar 内原生 button）", async () => {
    const user = userEvent.setup();
    const onCite = vi.fn();
    render(<FloatingSelectionCapsule rect={RECT} onCite={onCite} />);
    await user.tab();
    expect(screen.getByTestId("floating-capsule-cite")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onCite).toHaveBeenCalledTimes(1);
  });

  it("closing 状态播放淡出：动画结束回调 onExited，按钮退出 Tab 序列", () => {
    const onExited = vi.fn();
    render(<FloatingSelectionCapsule rect={RECT} onCite={() => {}} state="closing" onExited={onExited} />);
    const capsule = screen.getByTestId("floating-selection-capsule");
    expect(capsule.className).toContain("floating-capsule--closing");
    expect(capsule).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("floating-capsule-cite")).toHaveAttribute("tabindex", "-1");
    fireEvent.animationEnd(capsule);
    expect(onExited).toHaveBeenCalledTimes(1);
  });

  it("open 状态不触发 onExited（只有 closing 淡出结束才退出）", () => {
    const onExited = vi.fn();
    render(<FloatingSelectionCapsule rect={RECT} onCite={() => {}} onExited={onExited} />);
    fireEvent.animationEnd(screen.getByTestId("floating-selection-capsule"));
    expect(onExited).not.toHaveBeenCalled();
  });
});
