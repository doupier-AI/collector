import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MessageItem } from "./MessageItem";
import { makeMessage, makeTask } from "../../test/fakes";

describe("生成控制按钮组（ADR-0035）", () => {
  it("生成中显示「暂停」，点击回调暂停", async () => {
    const onPause = vi.fn();
    const task = makeTask({ outputMessageId: "answer", status: "running" });
    const user = userEvent.setup();
    render(
      <ul>
        <MessageItem
          message={makeMessage({ id: "answer", role: "assistant", status: "streaming", content: "部分正文" })}
          task={task}
          onPauseTask={onPause}
        />
      </ul>,
    );
    await user.click(screen.getByRole("button", { name: "暂停" }));
    expect(onPause).toHaveBeenCalledWith(task);
    expect(screen.queryByRole("button", { name: "继续" })).not.toBeInTheDocument();
  });

  it("暂停后显示「继续」+「停止」，状态行「已暂停」", async () => {
    const onResume = vi.fn();
    const onStop = vi.fn();
    const task = makeTask({ outputMessageId: "answer", status: "paused" });
    const user = userEvent.setup();
    render(
      <ul>
        <MessageItem
          message={makeMessage({ id: "answer", role: "assistant", status: "paused", content: "部分正文" })}
          task={task}
          onResumeTask={onResume}
          onStopTask={onStop}
        />
      </ul>,
    );
    expect(screen.getByText("已暂停")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "继续" }));
    expect(onResume).toHaveBeenCalledWith(task);
    await user.click(screen.getByRole("button", { name: "停止" }));
    expect(onStop).toHaveBeenCalledWith(task);
  });

  it("停止后状态行「已停止」，无暂停/继续/停止按钮", () => {
    render(
      <ul>
        <MessageItem
          message={makeMessage({ id: "answer", role: "assistant", status: "stopped", content: "部分正文" })}
          task={makeTask({ outputMessageId: "answer", status: "stopped" })}
        />
      </ul>,
    );
    expect(screen.getByText("已停止")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "暂停" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
  });

  it("未传入生成控制回调时不渲染按钮组", () => {
    render(
      <ul>
        <MessageItem
          message={makeMessage({ id: "answer", role: "assistant", status: "streaming", content: "部分正文" })}
          task={makeTask({ outputMessageId: "answer", status: "running" })}
        />
      </ul>,
    );
    expect(screen.queryByRole("button", { name: "暂停" })).not.toBeInTheDocument();
  });
});
