import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MessageItem } from "./MessageItem";
import { makeMessage, makeTask } from "../../test/fakes";

/** navigator.clipboard 在测试环境不可用：覆盖 window.navigator.clipboard 记录复制内容。 */
function mockClipboard() {
  const written: string[] = [];
  const mock = { writeText: async (text: string) => { written.push(text); } };
  // vitest 环境下全局 navigator 与 window.navigator 可能是不同对象（组件引用全局 navigator），两个都覆盖。
  for (const nav of [globalThis.navigator, window.navigator]) {
    Object.defineProperty(nav, "clipboard", { configurable: true, value: mock });
  }
  return written;
}

describe("消息操作（ADR-0035）", () => {
  it("AI 回答：复制写入正文并显示「已复制」反馈；重新生成回调任务", async () => {
    const onRegenerate = vi.fn();
    const task = makeTask({ outputMessageId: "answer", status: "completed" });
    // userEvent.setup 会接管剪贴板，mock 必须在 setup 之后。
    const user = userEvent.setup();
    const written = mockClipboard();
    render(
      <ul>
        <MessageItem
          message={makeMessage({ id: "answer", role: "assistant", status: "completed", content: "正文回答" })}
          task={task}
          onRegenerateTask={onRegenerate}
        />
      </ul>,
    );
    await user.click(screen.getByRole("button", { name: "复制" }));
    expect(written).toEqual(["正文回答"]);
    expect(await screen.findByRole("button", { name: "已复制" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重新生成" }));
    expect(onRegenerate).toHaveBeenCalledWith(task);
  });

  it("版本切换：有旧版本时显示左右箭头，可查看旧版并回到最新", async () => {
    const versions = [{ content: "旧版正文", createdAt: "2026-08-19T00:00:00.000Z" }];
    const user = userEvent.setup();
    render(
      <ul>
        <MessageItem
          message={makeMessage({ id: "answer", role: "assistant", status: "completed", content: "新版正文", versions })}
          task={makeTask({ outputMessageId: "answer", status: "completed" })}
        />
      </ul>,
    );
    expect(screen.getByRole("group", { name: "回答版本" })).toBeInTheDocument();
    expect(screen.getByText("新版正文")).toBeInTheDocument();
    expect(screen.queryByText("旧版正文")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "上一个版本" }));
    expect(screen.getByText("旧版正文")).toBeInTheDocument();
    expect(screen.queryByText("新版正文")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "回到最新版本" }));
    expect(screen.getByText("新版正文")).toBeInTheDocument();
  });

  it("无旧版本时不显示版本切换器", () => {
    render(
      <ul>
        <MessageItem
          message={makeMessage({ id: "answer", role: "assistant", status: "completed", content: "正文" })}
          task={makeTask({ outputMessageId: "answer", status: "completed" })}
        />
      </ul>,
    );
    expect(screen.queryByRole("group", { name: "回答版本" })).not.toBeInTheDocument();
  });

  it("用户消息：复制原文；重新编辑进入编辑态，保存回调改写内容", async () => {
    const onEdit = vi.fn();
    // userEvent.setup 会接管剪贴板，mock 必须在 setup 之后。
    const user = userEvent.setup();
    const written = mockClipboard();
    render(
      <ul>
        <MessageItem
          message={makeMessage({ id: "question", role: "user", content: "原始问题" })}
          onEditMessage={onEdit}
        />
      </ul>,
    );
    await user.click(screen.getByRole("button", { name: "复制" }));
    expect(written).toEqual(["原始问题"]);

    await user.click(screen.getByRole("button", { name: "重新编辑" }));
    const textarea = screen.getByLabelText("修改问题");
    await user.clear(textarea);
    await user.type(textarea, "修改后的问题");
    await user.click(screen.getByRole("button", { name: "保存并重新生成" }));
    expect(onEdit).toHaveBeenCalledWith("question", "修改后的问题");
    expect(screen.queryByLabelText("修改问题")).not.toBeInTheDocument();
  });

  it("未传入回调时不渲染操作按钮", () => {
    render(
      <ul>
        <MessageItem
          message={makeMessage({ id: "question", role: "user", content: "原始问题" })}
        />
      </ul>,
    );
    expect(screen.queryByRole("button", { name: "复制" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新编辑" })).not.toBeInTheDocument();
  });
});
