import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatComposer } from "../chat-composer/ChatComposer";
import { MessageItem } from "./MessageItem";
import { makeMessage, makeTask } from "../../test/fakes";

describe("输入区生成控制（ADR-0035）", () => {
  it("生成中由「暂停」占用发送按钮原位，点击回调暂停", async () => {
    const onPause = vi.fn();
    const task = makeTask({ outputMessageId: "answer", status: "running" });
    const user = userEvent.setup();
    render(
      <ChatComposer
        draftScope="generation-running"
        submitLabel="发送"
        onSubmit={async () => true}
        generationTask={task}
        onPauseTask={onPause}
      />,
    );
    expect(screen.queryByRole("button", { name: "发送" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "暂停" }));
    expect(onPause).toHaveBeenCalledWith(task);
    expect(screen.queryByRole("button", { name: "继续" })).not.toBeInTheDocument();
  });

  it("暂停后在同一控制位显示「停止」+「继续」", async () => {
    const onResume = vi.fn();
    const onStop = vi.fn();
    const task = makeTask({ outputMessageId: "answer", status: "paused" });
    const user = userEvent.setup();
    render(
      <ChatComposer
        draftScope="generation-paused"
        submitLabel="发送"
        onSubmit={async () => true}
        generationTask={task}
        onResumeTask={onResume}
        onStopTask={onStop}
      />,
    );
    await user.click(screen.getByRole("button", { name: "继续" }));
    expect(onResume).toHaveBeenCalledWith(task);
    await user.click(screen.getByRole("button", { name: "停止" }));
    expect(onStop).toHaveBeenCalledWith(task);
  });

  it("停止后消息保留「已停止」，输入区恢复发送按钮", () => {
    const task = makeTask({ outputMessageId: "answer", status: "stopped" });
    render(
      <>
        <ChatComposer
          draftScope="generation-stopped"
          submitLabel="发送"
          onSubmit={async () => true}
          generationTask={task}
        />
        <ul>
        <MessageItem
          message={makeMessage({ id: "answer", role: "assistant", status: "stopped", content: "部分正文" })}
          task={task}
        />
        </ul>
      </>,
    );
    expect(screen.getByText("已停止")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "暂停" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
  });

  it("没有进行中任务时不替换发送按钮", () => {
    render(
      <ChatComposer draftScope="generation-idle" submitLabel="发送" onSubmit={async () => true} />,
    );
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "暂停" })).not.toBeInTheDocument();
  });
});
