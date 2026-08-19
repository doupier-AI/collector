import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MessageItem } from "./MessageItem";
import { makeMessage, makeTask } from "../../test/fakes";

function renderMessage(reasoning: string | undefined, status: "streaming" | "completed") {
  return render(
    <ul>
      <MessageItem
        message={makeMessage({ id: "answer", role: "assistant", status, content: "正文回答", reasoning })}
        task={makeTask({ outputMessageId: "answer", status: status === "completed" ? "completed" : "running", groundingScope: { status: "not_requested", sourceCount: 0, citationCount: 0 } })}
      />
    </ul>,
  );
}

describe("深度思考折叠区（ADR-0035）", () => {
  it("生成中：默认折叠显示「深度思考中…」，展开后逐字显示推理内容", async () => {
    const user = userEvent.setup();
    renderMessage("推理过程片段", "streaming");

    expect(screen.getByRole("button", { name: "展开深度思考中…" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("推理过程片段")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "展开深度思考中…" }));
    expect(screen.getByRole("button", { name: "收起深度思考中…" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("推理过程片段")).toBeInTheDocument();
  });

  it("完成后：折叠区保留可回看，标题为「思考过程」", async () => {
    const user = userEvent.setup();
    renderMessage("完整推理记录", "completed");

    const toggle = screen.getByRole("button", { name: "展开思考过程" });
    expect(toggle).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.getByText("完整推理记录")).toBeInTheDocument();
  });

  it("无思考内容时不渲染折叠区", () => {
    renderMessage(undefined, "completed");
    expect(screen.queryByRole("button", { name: /思考过程|深度思考中/ })).not.toBeInTheDocument();
  });

  it("思考期间无正文时状态行显示「深度思考中」", () => {
    render(
      <ul>
        <MessageItem
          message={makeMessage({ id: "answer", role: "assistant", status: "streaming", content: "", reasoning: "推理中" })}
          task={makeTask({ outputMessageId: "answer", status: "running", groundingScope: { status: "not_requested", sourceCount: 0, citationCount: 0 } })}
        />
      </ul>,
    );
    expect(screen.getByText("深度思考中")).toBeInTheDocument();
  });
});
