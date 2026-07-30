import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SelectionCapsule } from "./SelectionCapsule";

describe("引用胶囊", () => {
  it("显示选区截取文本，超出长度截断并加省略号", () => {
    const shortText = "一段短文本";
    render(<SelectionCapsule text={shortText} onRemove={() => {}} />);
    expect(screen.getByTestId("selection-capsule")).toBeInTheDocument();
    expect(screen.getByText(shortText)).toBeInTheDocument();
  });

  it("长文本截取到 36 字符并加省略号", () => {
    const longText = "这是一段非常非常长的选区文本内容，用来测试截取功能是否正常工作并且显示省略号";
    render(<SelectionCapsule text={longText} onRemove={() => {}} />);
    const capsule = screen.getByTestId("selection-capsule");
    const textSpan = capsule.querySelector(".selection-capsule__text");
    expect(textSpan?.textContent).toContain("…");
    expect(textSpan?.textContent!.length).toBeLessThanOrEqual(37); // 36 + ellipsis
  });

  it("点击移除按钮触发 onRemove", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(<SelectionCapsule text="测试文本" onRemove={onRemove} />);
    await user.click(screen.getByRole("button", { name: "移除引用" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("Escape 键触发移除", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(<SelectionCapsule text="测试文本" onRemove={onRemove} />);
    const capsule = screen.getByTestId("selection-capsule");
    capsule.focus();
    await user.keyboard("{Escape}");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("键盘可达：Tab 聚焦胶囊", async () => {
    const user = userEvent.setup();
    render(<SelectionCapsule text="测试文本" onRemove={() => {}} />);
    await user.tab();
    expect(screen.getByTestId("selection-capsule")).toHaveFocus();
  });

  it("role 为 status 以通知辅助技术", () => {
    render(<SelectionCapsule text="测试文本" onRemove={() => {}} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("原文通过 title 属性完整展示（hover 提示）", () => {
    const fullText = "这是一段很长的文本，需要完整展示在 hover 提示中";
    render(<SelectionCapsule text={fullText} onRemove={() => {}} />);
    const textSpan = screen.getByTestId("selection-capsule").querySelector(".selection-capsule__text");
    expect(textSpan).toHaveAttribute("title", fullText);
  });
});
