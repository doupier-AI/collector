import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageItem } from "./MessageItem";
import { makeMessage, makeTask } from "../../test/fakes";

describe("联网研究状态", () => {
  it("证据政策满足不显示为事实已验证或 grounded", () => {
    render(<ul><MessageItem message={makeMessage({ id: "answer", role: "assistant", status: "completed", content: "回答" })} task={makeTask({ outputMessageId: "answer", status: "completed", groundingScope: { status: "evidence_prepared", evidencePolicyStatus: "policy_satisfied", sourceCount: 2, citationCount: 0, runId: "run" } })} /></ul>);
    expect(screen.getByTestId("grounding-scope-note")).toHaveTextContent("按当前证据政策准备来源");
    expect(screen.getByTestId("grounding-scope-note")).toHaveTextContent("不表示事实已验证");
    expect(screen.getByTestId("grounding-scope-note")).not.toHaveTextContent("已联网核验");
  });

  it("部分满足与冲突使用不同的诚实停止文案", () => {
    const { rerender } = render(<ul><MessageItem message={makeMessage({ id: "answer", role: "assistant", status: "completed", content: "回答" })} task={makeTask({ outputMessageId: "answer", status: "completed", groundingScope: { status: "evidence_incomplete", evidencePolicyStatus: "partially_satisfied", sourceCount: 1, citationCount: 0, runId: "run" } })} /></ul>);
    expect(screen.getByTestId("grounding-scope-note")).toHaveTextContent("仅部分满足");
    rerender(<ul><MessageItem message={makeMessage({ id: "answer", role: "assistant", status: "completed", content: "回答" })} task={makeTask({ outputMessageId: "answer", status: "completed", groundingScope: { status: "evidence_conflicting", evidencePolicyStatus: "conflicting", sourceCount: 2, citationCount: 0, runId: "run" } })} /></ul>);
    expect(screen.getByTestId("grounding-scope-note")).toHaveTextContent("合格来源存在冲突");
  });

  it("联网成功文案不混用完整搜索来源数量", () => {
    render(<ul><MessageItem message={makeMessage({ id: "answer", role: "assistant", status: "completed", content: "回答" })} task={makeTask({ outputMessageId: "answer", status: "completed", groundingScope: { status: "grounded", sourceCount: 2, citationCount: 1, runId: "run" } })} /></ul>);
    expect(screen.getByTestId("grounding-scope-note")).toHaveTextContent("本轮已联网核验。");
    expect(screen.getByTestId("grounding-scope-note")).not.toHaveTextContent("2 个");
  });

  it("不会把联网失败降级成已经核验", () => {
    render(<ul><MessageItem message={makeMessage({ id: "answer", role: "assistant", status: "completed", content: "回答" })} task={makeTask({ outputMessageId: "answer", status: "completed", groundingScope: { status: "grounding_failed", sourceCount: 0, citationCount: 0, runId: "run" } })} /></ul>);
    expect(screen.getByTestId("grounding-scope-note")).toHaveTextContent("联网尝试失败");
    expect(screen.getByTestId("grounding-scope-note")).toHaveTextContent("未完成外部核验");
  });

  it("只显示必要的上下文类别说明并由联网状态负责降级文案", () => {
    render(<ul><MessageItem message={makeMessage({ id: "answer", role: "assistant", status: "completed", content: "回答" })} task={makeTask({
      outputMessageId: "answer",
      status: "completed",
      groundingScope: { status: "grounding_failed", sourceCount: 0, citationCount: 0, runId: "run" },
      contextExplanations: ["imported_material_used", "personalization_not_used", "retrieval_degraded"],
    })} /></ul>);
    expect(screen.getByTestId("context-explanation-note")).toHaveTextContent("使用了你导入的材料");
    expect(screen.getByTestId("context-explanation-note")).toHaveTextContent("已考虑但未使用个性化信息");
    expect(screen.getByTestId("context-explanation-note")).not.toHaveTextContent("检索");
    expect(screen.getByTestId("grounding-scope-note")).toHaveTextContent("联网尝试失败");
  });
});
