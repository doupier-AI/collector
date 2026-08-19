import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageItem } from "./MessageItem";
import { makeMessage, makeTask } from "../../test/fakes";

describe("联网研究状态", () => {
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
});
