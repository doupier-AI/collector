import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatComposer } from "./ChatComposer";
import { loadDraft } from "./draft";

function renderComposer(onSubmit: (content: string) => Promise<boolean>, scope = "test-scope") {
  render(<ChatComposer draftScope={scope} submitLabel="发送" onSubmit={onSubmit} />);
}

describe("ChatComposer", () => {
  it("后端确认前保留输入文字，确认后清空", async () => {
    const user = userEvent.setup();
    let release!: (accepted: boolean) => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    renderComposer(onSubmit);

    const textarea = screen.getByLabelText("你的问题");
    await user.type(textarea, "什么是本地优先");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(onSubmit).toHaveBeenCalledWith("什么是本地优先");
    expect(textarea).toHaveValue("什么是本地优先");

    release(true);
    await waitFor(() => expect(textarea).toHaveValue(""));
  });

  it("提交失败保留文字并提示尚未确认保存", async () => {
    const user = userEvent.setup();
    renderComposer(async () => false);

    const textarea = screen.getByLabelText("你的问题");
    await user.type(textarea, "保留这段草稿");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("尚未确认保存，请检查连接后重试。")).toBeInTheDocument();
    expect(textarea).toHaveValue("保留这段草稿");
  });

  it("空输入禁用发送，输入后可用", async () => {
    const user = userEvent.setup();
    renderComposer(async () => true);

    const button = screen.getByRole("button", { name: "发送" });
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText("你的问题"), "  ");
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText("你的问题"), "一个问题");
    expect(button).toBeEnabled();
  });

  it("Enter 发送，Shift+Enter 换行不发送", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => true);
    renderComposer(onSubmit);

    const textarea = screen.getByLabelText("你的问题");
    await user.click(textarea);
    await user.keyboard("第一行");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onSubmit).not.toHaveBeenCalled();

    await user.keyboard("第二行");
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("草稿写入带版本的本地存储，确认成功后清除", async () => {
    const user = userEvent.setup();
    renderComposer(async () => true, "draft-scope");

    const textarea = screen.getByLabelText("你的问题");
    await user.type(textarea, "未发送的内容");
    expect(loadDraft("draft-scope")).toBe("未发送的内容");

    const raw = window.localStorage.getItem("collector.web.draft.v1");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { version: number };
    expect(parsed.version).toBe(1);

    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(loadDraft("draft-scope")).toBe(""));
  });

  it("附件按钮功能未就绪，点击显示克制提示，再次点击收起", async () => {
    const user = userEvent.setup();
    renderComposer(async () => true);

    const attach = screen.getByRole("button", { name: "添加附件（后续版本提供）" });
    await user.click(attach);
    expect(await screen.findByText("附件等功能将在后续版本提供")).toBeInTheDocument();

    await user.click(attach);
    expect(screen.queryByText("附件等功能将在后续版本提供")).not.toBeInTheDocument();
  });

  it("键盘提示在输入框外并保持与输入框的无障碍关联", () => {
    renderComposer(async () => true);

    const hint = screen.getByText("Enter 发送，Shift+Enter 换行");
    const textarea = screen.getByLabelText("你的问题");
    expect(hint).not.toBeNull();
    expect(textarea.getAttribute("aria-describedby")).toContain(hint.id);
  });
});
