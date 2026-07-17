import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMessage, makeTask } from "../../test/fakes";
import { MessageItem } from "./MessageItem";

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

describe("prefers-reduced-motion 下的 AI 占位", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("减少动态效果时占位无动画类", () => {
    stubMatchMedia(true);
    render(
      <ul>
        <MessageItem
          message={makeMessage({ id: "m-out", role: "assistant", status: "pending", content: "" })}
          task={makeTask({ id: "task-1", status: "running", outputMessageId: "m-out" })}
        />
      </ul>,
    );
    const placeholder = screen.getByTestId("ai-placeholder");
    expect(placeholder).not.toHaveClass("ai-placeholder--animated");
  });

  it("默认情况下占位带低对比度呼吸动画类", () => {
    stubMatchMedia(false);
    render(
      <ul>
        <MessageItem
          message={makeMessage({ id: "m-out", role: "assistant", status: "pending", content: "" })}
          task={makeTask({ id: "task-1", status: "running", outputMessageId: "m-out" })}
        />
      </ul>,
    );
    expect(screen.getByTestId("ai-placeholder")).toHaveClass("ai-placeholder--animated");
  });
});
