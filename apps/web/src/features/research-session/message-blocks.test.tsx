import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeMessage, makeSession, makeTask } from "../../test/fakes";
import { ResearchSessionPage } from "./ResearchSessionPage";
import type { ResearchSessionView } from "@collector/capture-contracts";

function renderSessionPage(api: Partial<ApiClient>) {
  const services = {
    api: api as ApiClient,
    connectTaskEvents: vi.fn(() => ({ close: () => {}, syncNow: () => {}, mode: "closed", lastEventId: 0 })),
  } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={["/research/session-1"]}>
        <Routes>
          <Route path="/research/:sessionId" element={<ResearchSessionPage />} />
        </Routes>
      </MemoryRouter>
    </ServicesProvider>,
  );
}

function viewWithAssistant(content: string): ResearchSessionView {
  return {
    session: makeSession({ id: "session-1" }),
    messages: [
      makeMessage({ id: "m-in", role: "user", content: "一个问题" }),
      makeMessage({ id: "m-out", role: "assistant", status: "completed", content }),
    ],
    tasks: [makeTask({ id: "task-1", status: "completed", inputMessageId: "m-in", outputMessageId: "m-out" })],
  };
}

describe("AI 回答分块渲染", () => {
  it("多段回答按确定性段落块渲染并带稳定块 ID", async () => {
    renderSessionPage({
      getResearchSessionView: async () => viewWithAssistant("第一段。\n\n第二段。"),
    });

    const first = await screen.findByText("第一段。");
    const second = screen.getByText("第二段。");
    expect(first.closest("[data-block-id]")).toHaveAttribute("data-block-id", "m-out#p0");
    expect(second.closest("[data-block-id]")).toHaveAttribute("data-block-id", "m-out#p1");
    expect(first.closest("[data-content-kind]")).toHaveAttribute("data-content-kind", "message");
  });

  it("单段回答仍渲染为单个稳定块", async () => {
    renderSessionPage({
      getResearchSessionView: async () => viewWithAssistant("只有一段。"),
    });

    const el = await screen.findByText("只有一段。");
    expect(el.closest("[data-block-id]")).toHaveAttribute("data-block-id", "m-out#p0");
  });

  it("引用标记由 remark 插件从 [来源n] token 渲染为可悬停角标，编号与文末列表一致", async () => {
    const view = viewWithAssistant("[来源1]第一段文字。[来源2]\n\n第二段文字。");
    view.tasks[0] = makeTask({
      id: "task-1",
      status: "completed",
      inputMessageId: "m-in",
      outputMessageId: "m-out",
      groundingScope: { status: "grounded", sourceCount: 2, citationCount: 2, runId: "run-1" },
    });
    view.groundingSources = [
      { id: "source-1", runId: "run-1", ordinal: 1, title: "第一个来源", url: "https://example.com/one", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "source-2", runId: "run-1", ordinal: 2, title: "第二个来源", url: "https://example.com/two", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    view.citations = [
      { id: "citation-1", messageId: "m-out", runId: "run-1", sourceId: "source-1", blockOrdinal: 0, markerOffset: 2, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "citation-2", messageId: "m-out", runId: "run-1", sourceId: "source-2", blockOrdinal: 0, markerOffset: 12, createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    renderSessionPage({ getResearchSessionView: async () => view });

    const firstMarker = await screen.findByLabelText("打开来源 1：第一个来源");
    const secondMarker = screen.getByLabelText("打开来源 2：第二个来源");
    expect(firstMarker).toHaveAttribute("href", "https://example.com/one");
    expect(firstMarker).toHaveAttribute("rel", "noopener noreferrer");
    expect(firstMarker.querySelector("sup")).toHaveTextContent("");
    expect(firstMarker.querySelector("sup")).toHaveAttribute("data-citation-index", "1");
    expect(secondMarker.querySelector("sup")).toHaveAttribute("data-citation-index", "2");
    expect(firstMarker.closest("[data-block-id]")).toHaveAttribute("data-block-id", "m-out#p0");
    expect(screen.getByText("本轮可核验来源")).toBeInTheDocument();
  });
});

describe("模型状态显示", () => {
  it("真实模型显示供应商与模型名", async () => {
    renderSessionPage({
      getResearchSessionView: async () => viewWithAssistant("回答。"),
      getAiConfiguration: async () => ({ consent: true, configured: true, mode: "real", provider: "deepseek", model: "deepseek-v4-pro" }),
    });

    expect(await screen.findByText("模型：deepseek · deepseek-v4-pro")).toBeInTheDocument();
  });

  it("演示模式明确标识非真实 AI", async () => {
    renderSessionPage({
      getResearchSessionView: async () => viewWithAssistant("回答。"),
      getAiConfiguration: async () => ({ consent: false, configured: false, mode: "demo" }),
    });

    expect(await screen.findByText(/本地演示模式｜非真实 AI｜未联网检索/)).toBeInTheDocument();
  });

  it("未配置模型时给出明确状态", async () => {
    renderSessionPage({
      getResearchSessionView: async () => viewWithAssistant("回答。"),
      getAiConfiguration: async () => ({ consent: false, configured: false, mode: "unconfigured" }),
    });

    expect(await screen.findByText(/未配置模型/)).toBeInTheDocument();
  });

  it("状态接口不可用时静默省略，不阻塞会话内容", async () => {
    renderSessionPage({
      getResearchSessionView: async () => viewWithAssistant("回答。"),
      getAiConfiguration: async () => {
        throw new Error("network down");
      },
    });

    expect(await screen.findByText("回答。")).toBeInTheDocument();
    expect(screen.queryByText(/模型：/)).not.toBeInTheDocument();
  });
});
