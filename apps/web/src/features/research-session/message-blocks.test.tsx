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
    expect(first).toHaveAttribute("data-block-id", "m-out#p0");
    expect(second).toHaveAttribute("data-block-id", "m-out#p1");
    expect(first.closest("[data-content-kind]")).toHaveAttribute("data-content-kind", "message");
  });

  it("单段回答仍渲染为单个稳定块", async () => {
    renderSessionPage({
      getResearchSessionView: async () => viewWithAssistant("只有一段。"),
    });

    expect(await screen.findByText("只有一段。")).toHaveAttribute("data-block-id", "m-out#p0");
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
