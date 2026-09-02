import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MessageItem } from "./MessageItem";
import { makeMessage, makeTask } from "../../test/fakes";
import type { ResearchMessageRecord, ResearchTaskRecord } from "@collector/capture-contracts";

function renderMessage(
  message: Partial<ResearchMessageRecord> = {},
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

describe("运行时执行过程", () => {
  it("只显示持久化的公开结构化事件，不展示供应商原始推理", async () => {
    const user = userEvent.setup();
    renderMessage(
      { reasoning: "不得展示的供应商推理" },
      {
        executionEvents: [
          { stage: "planning", status: "completed" },
          { stage: "web_search", status: "completed", query: "公开查询", requestedBackend: "primary", actualBackend: "fallback", usedFallback: true, resultCount: 4, sourceCount: 2 },
          { stage: "finalizing", status: "completed" },
        ],
      },
    );

    expect(screen.queryByText("不得展示的供应商推理")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开执行过程" }));
    const region = screen.getByRole("region", { name: "执行过程" });
    expect(region).toHaveTextContent("公开查询");
    expect(region).toHaveTextContent("fallback（故障切换）");
    expect(region).toHaveTextContent("来源：2");
  });

  it("历史任务没有事件时明确说明未记录，不虚构轨迹", async () => {
    const user = userEvent.setup();
    renderMessage({ reasoning: "旧记录也不得显示" }, { executionEvents: [] });
    await user.click(screen.getByRole("button", { name: "展开执行过程" }));
    expect(screen.getByRole("region", { name: "执行过程" })).toHaveTextContent("该任务未记录执行过程");
    expect(screen.queryByText("旧记录也不得显示")).not.toBeInTheDocument();
  });

  it("生成中按最新阶段显示真实状态", () => {
    renderMessage(
      { status: "streaming", content: "" },
      { status: "running", executionEvents: [{ stage: "web_search", status: "started", query: "最新资料" }] },
    );
    expect(screen.getByText("正在联网搜索")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开执行过程" }).closest(".execution-process")).toHaveAttribute("aria-busy", "true");
  });

  it("失败与降级事件显示安全原因码", async () => {
    const user = userEvent.setup();
    renderMessage({}, { executionEvents: [{ stage: "degradation", status: "failed", reasonCode: "web_search_timeout" }] });
    await user.click(screen.getByRole("button", { name: "展开执行过程" }));
    const region = screen.getByRole("region", { name: "执行过程" });
    expect(region).toHaveTextContent("执行降级");
    expect(region).toHaveTextContent("原因：web_search_timeout");
  });

  it("键盘可展开，按钮通过 aria-controls 关联有名称的内容区域", async () => {
    const user = userEvent.setup();
    renderMessage({}, { executionEvents: [{ stage: "drafting", status: "completed" }] });
    const toggle = screen.getByRole("button", { name: "展开执行过程" });
    toggle.focus();
    await user.keyboard("{Enter}");
    const region = screen.getByRole("region", { name: "执行过程" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", region.id);
    expect(region).toHaveTextContent("起草回答");
  });

  it("回答历史版本中的旧 reasoning 也不会重新出现", async () => {
    const user = userEvent.setup();
    renderMessage({
      versions: [{ content: "历史正文", reasoning: "历史供应商推理", createdAt: "2026-08-20T00:00:00.000Z" }],
    }, { executionEvents: [] });
    await user.click(screen.getByRole("button", { name: "上一个版本" }));
    expect(screen.getByText("历史正文")).toBeInTheDocument();
    expect(screen.queryByText("历史供应商推理")).not.toBeInTheDocument();
  });
});
