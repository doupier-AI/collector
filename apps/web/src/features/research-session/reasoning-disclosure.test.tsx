import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MessageItem } from "./MessageItem";
import { makeMessage, makeTask } from "../../test/fakes";
import type { ResearchMessageRecord, ResearchTaskRecord } from "@collector/capture-contracts";

function renderMessage(
  message: Partial<ResearchMessageRecord>,
  task: Partial<ResearchTaskRecord> = {},
) {
  return render(
    <ul>
      <MessageItem
        message={makeMessage({ id: "answer", role: "assistant", status: "completed", content: "正文回答", ...message })}
        task={makeTask({ outputMessageId: "answer", status: "completed", groundingScope: { status: "not_requested", sourceCount: 0, citationCount: 0 }, ...task })}
      />
    </ul>,
  );
}

describe("深度思考折叠区（ADR-0035）", () => {
  it("生成中：默认折叠显示「深度思考中…」，展开后逐字显示推理内容", async () => {
    const user = userEvent.setup();
    renderMessage({ reasoning: "推理过程片段", status: "streaming" }, { status: "running" });

    const toggle = screen.getByRole("button", { name: "展开深度思考中…" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.closest(".reasoning")).toHaveAttribute("data-reasoning-state", "streaming");
    expect(toggle.closest(".reasoning")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("推理过程片段")).not.toBeInTheDocument();

    await user.click(toggle);
    expect(screen.getByRole("button", { name: "收起深度思考中…" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("推理过程片段")).toBeInTheDocument();
  });

  it("完成后：折叠区保留可回看，标题为「思考过程」", async () => {
    const user = userEvent.setup();
    renderMessage({ reasoning: "## 完整推理记录\n\n$E=mc^2$" });

    const toggle = screen.getByRole("button", { name: "展开思考过程" });
    expect(toggle).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.getByRole("heading", { name: "完整推理记录", level: 2 })).toBeInTheDocument();
    expect(document.querySelector(".reasoning .katex")).not.toBeNull();
  });

  it("无思考内容时不渲染折叠区，生成中只显示诚实状态", () => {
    renderMessage({ reasoning: "  ", status: "streaming", content: "" }, { status: "running" });
    expect(screen.queryByRole("button", { name: /思考过程|深度思考中/ })).not.toBeInTheDocument();
    expect(screen.getByText("已保存，正在生成")).toBeInTheDocument();
  });

  it("思考期间无正文时状态行显示「深度思考中」", () => {
    renderMessage({ status: "streaming", content: "", reasoning: "推理中" }, { status: "running" });
    expect(screen.getByText("深度思考中")).toBeInTheDocument();
  });

  it.each([
    ["paused", "paused", "展开思考过程（已暂停）", "paused"],
    ["stopped", "stopped", "展开思考过程（已停止）", "stopped"],
    ["failed", "failed", "展开思考过程（生成失败）", "failed"],
  ] as const)("%s 状态保留已有过程且不继续显示脉冲", (messageStatus, taskStatus, label, state) => {
    renderMessage({ reasoning: "终态前已保存的过程", status: messageStatus }, { status: taskStatus });
    const toggle = screen.getByRole("button", { name: label });
    expect(toggle.closest(".reasoning")).toHaveAttribute("data-reasoning-state", state);
    expect(toggle.closest(".reasoning")).toHaveAttribute("aria-busy", "false");
    expect(toggle.closest(".reasoning")?.querySelector(".reasoning__pulse")).toBeNull();
  });

  it("版本切换严格读取当前查看版本，不在版本之间回退借用 reasoning", async () => {
    const user = userEvent.setup();
    renderMessage({
      reasoning: "当前版本过程",
      versions: [{ content: "无过程旧版正文", createdAt: "2026-08-20T00:00:00.000Z" }],
    });

    expect(screen.getByRole("button", { name: "展开思考过程" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "上一个版本" }));
    expect(screen.queryByRole("button", { name: /思考过程/ })).not.toBeInTheDocument();
    expect(screen.getByText("无过程旧版正文")).toBeInTheDocument();
  });

  it("当前版本无过程时，仍可在历史版本回看其独立 reasoning", async () => {
    const user = userEvent.setup();
    renderMessage({
      reasoning: undefined,
      versions: [{ content: "有过程旧版正文", reasoning: "旧版独立过程", createdAt: "2026-08-20T00:00:00.000Z" }],
    });

    expect(screen.queryByRole("button", { name: /思考过程/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "上一个版本" }));
    const toggle = screen.getByRole("button", { name: "展开历史思考过程" });
    expect(toggle.closest(".reasoning")).toHaveAttribute("data-reasoning-state", "history");
    await user.click(toggle);
    expect(screen.getByText("旧版独立过程")).toBeInTheDocument();
  });

  it("键盘可展开折叠区，按钮通过 aria-controls 关联有名称的内容区域", async () => {
    const user = userEvent.setup();
    renderMessage({ reasoning: "键盘可读过程" });

    const toggle = screen.getByRole("button", { name: "展开思考过程" });
    toggle.focus();
    await user.keyboard("{Enter}");
    const region = screen.getByRole("region", { name: "思考过程" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", region.id);
    expect(region).toHaveTextContent("键盘可读过程");
  });
});
