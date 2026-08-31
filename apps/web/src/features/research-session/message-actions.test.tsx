import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MessageItem } from "./MessageItem";
import { makeMessage, makeTask } from "../../test/fakes";
import { researchBodyVersionId } from "@collector/capture-contracts";

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
    const content = "正文回答";
    const task = makeTask({ outputMessageId: "answer", status: "completed", groundingScope: { status: "grounded", sourceCount: 1, citationCount: 1, runId: "run" } });
    // userEvent.setup 会接管剪贴板，mock 必须在 setup 之后。
    const user = userEvent.setup();
    const written = mockClipboard();
    render(
      <ul>
        <MessageItem
          message={makeMessage({ id: "answer", role: "assistant", status: "completed", content })}
          task={task}
          groundingSources={[{ id: "source", runId: "run", ordinal: 1, title: "来源", url: "https://example.test/source", createdAt: "2026-08-31T00:00:00.000Z" }]}
          citations={[{
            id: "citation",
            messageId: "answer",
            runId: "run",
            sourceId: "source",
            blockOrdinal: 0,
            markerOffset: 0,
            location: {
              contentId: "answer",
              bodyVersionId: researchBodyVersionId("answer", content),
              sourceRange: { startOffset: 0, endOffset: content.length },
              exact: content,
            },
            createdAt: "2026-08-31T00:00:00.000Z",
          }]}
          onRegenerateTask={onRegenerate}
        />
      </ul>,
    );
    expect(screen.getByLabelText("打开来源 1：来源")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "复制" }));
    expect(written).toEqual(["正文回答"]);
    expect(await screen.findByRole("button", { name: "已复制" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重新生成" }));
    expect(onRegenerate).toHaveBeenCalledWith(task);
  });

  it("版本切换：有旧版本时显示左右箭头，可查看旧版并回到最新", async () => {
    const versions = [{ content: "## 旧版正文\n\n| 列 | 值 |\n| --- | --- |\n| A | 1 |", createdAt: "2026-08-19T00:00:00.000Z" }];
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
    expect(screen.getByRole("heading", { name: "旧版正文", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.queryByText("新版正文")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "回到最新版本" }));
    expect(screen.getByText("新版正文")).toBeInTheDocument();
  });

  it("历史版本保持只读，不借用当前正文的术语标记与生长入口", async () => {
    const content = "当前正文包含 REST。";
    const startOffset = content.indexOf("REST");
    const marker = {
      text: "REST",
      blockOrdinal: 0,
      startOffset,
      endOffset: startOffset + 4,
      category: "abbreviation" as const,
      location: {
        contentId: "answer",
        bodyVersionId: researchBodyVersionId("answer", content),
        sourceRange: { startOffset, endOffset: startOffset + 4 },
        exact: "REST",
      },
    };
    const onStart = vi.fn();
    const user = userEvent.setup();
    render(
      <ul>
        <MessageItem
          message={makeMessage({
            id: "answer",
            role: "assistant",
            status: "completed",
            content,
            versions: [{ content: "历史正文同样写了 REST。", createdAt: "2026-08-19T00:00:00.000Z" }],
          })}
          task={makeTask({ outputMessageId: "answer", status: "completed" })}
          terms={[marker]}
          onStartTermPreview={onStart}
        />
      </ul>,
    );

    expect(screen.getByRole("button", { name: "解释术语 REST" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "上一个版本" }));
    expect(screen.getByText("历史正文同样写了 REST。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "解释术语 REST" })).not.toBeInTheDocument();
    expect(onStart).not.toHaveBeenCalled();
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
