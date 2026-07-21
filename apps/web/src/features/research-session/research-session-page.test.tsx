import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import { ApiRequestError, NetworkError } from "../../api/errors";
import type { TaskEventStream } from "../../api/task-events";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeBranch, makeMessage, makeSelection, makeSession, makeTask } from "../../test/fakes";
import { ResearchSessionPage } from "./ResearchSessionPage";
import type { ResearchSessionView } from "@collector/capture-contracts";

function noopTaskEventStream(): TaskEventStream {
  return { close: () => {}, syncNow: () => {}, mode: "closed", lastEventId: 0 };
}

function renderSessionPage(api: Partial<ApiClient>, entry = "/research/session-1") {
  const services = {
    api: api as ApiClient,
    connectTaskEvents: vi.fn(noopTaskEventStream),
  } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/research/:sessionId" element={<ResearchSessionPage />} />
          <Route path="/research/new" element={<p>开始页</p>} />
        </Routes>
      </MemoryRouter>
    </ServicesProvider>,
  );
}

function readyView(): ResearchSessionView {
  return {
    session: makeSession({ id: "session-1", title: "理解注意力机制" }),
    messages: [
      makeMessage({ id: "m-in", role: "user", content: "为什么需要多头注意力？" }),
      makeMessage({ id: "m-out", role: "assistant", status: "completed", content: "因为不同头可以关注不同位置。" }),
    ],
    tasks: [makeTask({ id: "task-1", status: "completed", inputMessageId: "m-in", outputMessageId: "m-out" })],
  };
}

describe("ResearchSessionPage 错误文案映射", () => {
  it("404 显示“这场研究不存在或已经清理”并提供返回开始页", async () => {
    renderSessionPage({
      getResearchSessionView: async () => {
        throw new ApiRequestError(404, "not_found", "not found");
      },
    });

    expect(await screen.findByRole("heading", { name: "这场研究不存在或已经清理" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回开始页" })).toHaveAttribute("href", "/research/new");
  });

  it("401 显示配对引导，配对码错误时给出文案", async () => {
    const user = userEvent.setup();
    const exchangePairingCode = vi.fn(async () => {
      throw new ApiRequestError(401, "invalid_pairing", "invalid");
    });
    renderSessionPage({
      getResearchSessionView: async () => {
        throw new ApiRequestError(401, "unauthorized", "unauthorized");
      },
      exchangePairingCode,
    });

    expect(await screen.findByRole("heading", { name: "配对 Collector" })).toBeInTheDocument();
    expect(screen.getByText(/启动器通常会自动完成/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("配对码"), "123456");
    await user.click(screen.getByRole("button", { name: "配对并继续" }));

    expect(exchangePairingCode).toHaveBeenCalledWith("123456");
    expect(await screen.findByText(/配对码不正确或已过期/)).toBeInTheDocument();
  });

  it("配对成功后自动重新加载会话", async () => {
    const user = userEvent.setup();
    const getResearchSessionView = vi
      .fn<() => Promise<ResearchSessionView>>()
      .mockRejectedValueOnce(new ApiRequestError(401, "unauthorized", "unauthorized"))
      .mockResolvedValueOnce(readyView());
    renderSessionPage({
      getResearchSessionView,
      exchangePairingCode: async () => ({ paired: true as const }),
    });

    expect(await screen.findByRole("heading", { name: "配对 Collector" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("配对码"), "654321");
    await user.click(screen.getByRole("button", { name: "配对并继续" }));

    expect(await screen.findByRole("heading", { name: "理解注意力机制" })).toBeInTheDocument();
    expect(getResearchSessionView).toHaveBeenCalledTimes(2);
  });

  it("500 显示通用错误并可重试", async () => {
    const user = userEvent.setup();
    const getResearchSessionView = vi
      .fn<() => Promise<ResearchSessionView>>()
      .mockRejectedValueOnce(new ApiRequestError(500, "internal_error", "boom"))
      .mockResolvedValueOnce(readyView());
    renderSessionPage({ getResearchSessionView });

    expect(await screen.findByRole("heading", { name: "暂时无法打开这场研究" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { name: "理解注意力机制" })).toBeInTheDocument();
    expect(getResearchSessionView).toHaveBeenCalledTimes(2);
  });

  it("网络失败显示通用错误，页面可重试", async () => {
    const user = userEvent.setup();
    const getResearchSessionView = vi
      .fn<() => Promise<ResearchSessionView>>()
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValueOnce(readyView());
    renderSessionPage({ getResearchSessionView });

    expect(await screen.findByRole("heading", { name: "暂时无法打开这场研究" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { name: "理解注意力机制" })).toBeInTheDocument();
  });
});

describe("ResearchSessionPage 就绪与失败恢复", () => {
  it("渲染会话标题、更新时间与完整消息", async () => {
    renderSessionPage({ getResearchSessionView: async () => readyView() });

    expect(await screen.findByRole("heading", { name: "理解注意力机制" })).toBeInTheDocument();
    expect(screen.getByText(/更新于/)).toBeInTheDocument();
    expect(screen.getByText("为什么需要多头注意力？")).toBeInTheDocument();
    expect(screen.getByText("因为不同头可以关注不同位置。")).toBeInTheDocument();
    expect(screen.getByLabelText("你的问题")).toBeInTheDocument();
  });

  it("model_not_configured 显示可重试失败卡，重试不新增第二条占位消息", async () => {
    const user = userEvent.setup();
    const failedTask = makeTask({
      id: "task-1",
      status: "failed",
      retryable: true,
      inputMessageId: "m-in",
      outputMessageId: "m-out",
      error: { code: "model_not_configured", message: "未配置可用的 AI 模型。输入已保存，配置模型后可以重试。" },
    });
    const view: ResearchSessionView = {
      session: makeSession({ id: "session-1", title: "本地优先研究" }),
      messages: [
        makeMessage({ id: "m-in", role: "user", content: "即使没有模型也请保存这段输入" }),
        makeMessage({ id: "m-out", role: "assistant", status: "failed", content: "" }),
      ],
      tasks: [failedTask],
    };
    const retryResearchTask = vi.fn(async () => makeTask({ ...failedTask, status: "queued" as const }));
    const { container } = renderSessionPage({
      getResearchSessionView: async () => view,
      retryResearchTask,
    });

    expect(await screen.findByText("即使没有模型也请保存这段输入")).toBeInTheDocument();
    expect(screen.getByText("内容已保存，暂时无法生成回答")).toBeInTheDocument();
    expect(screen.getByText(/还没有配置可用模型/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(retryResearchTask).toHaveBeenCalledWith("task-1");

    // 重试沿用原任务与 AI 消息，不新增第二条占位消息
    expect(container.querySelectorAll(".message--assistant")).toHaveLength(1);
    expect(screen.getAllByText("Collector")).toHaveLength(1);
  });

  it("进行中的任务显示 AI 固定占位与状态文字", async () => {
    const view: ResearchSessionView = {
      session: makeSession({ id: "session-1" }),
      messages: [
        makeMessage({ id: "m-in", role: "user", content: "解释本地优先研究的价值" }),
        makeMessage({ id: "m-out", role: "assistant", status: "pending", content: "" }),
      ],
      tasks: [makeTask({ id: "task-1", status: "running", inputMessageId: "m-in", outputMessageId: "m-out" })],
    };
    renderSessionPage({ getResearchSessionView: async () => view });

    expect(await screen.findByText("解释本地优先研究的价值")).toBeInTheDocument();
    expect(screen.getByTestId("ai-placeholder")).toBeInTheDocument();
    expect(screen.getByText("已保存，正在生成")).toBeInTheDocument();
  });
});

describe("ResearchSessionPage 来源会话与来源返回", () => {
  function originView(): ResearchSessionView {
    return {
      session: makeSession({
        id: "session-2",
        title: "把本地优先的边界讲透",
        originSelectionId: "sel-1",
        originSessionId: "session-1",
      }),
      messages: [
        makeMessage({ id: "m-in", sessionId: "session-2", role: "user", content: "把本地优先的边界讲透" }),
        makeMessage({
          id: "m-out",
          sessionId: "session-2",
          role: "assistant",
          status: "completed",
          content: "本地优先意味着数据先落在本机。",
        }),
      ],
      tasks: [makeTask({ id: "task-1", sessionId: "session-2", status: "completed", inputMessageId: "m-in", outputMessageId: "m-out" })],
    };
  }

  function originSelection() {
    return makeSelection({
      id: "sel-1",
      sessionId: "session-1",
      text: "本地优先会先把输入保存在本机",
      anchor: {
        kind: "message",
        messageId: "m-origin",
        blockOrdinal: 0,
        startOffset: 0,
        endOffset: 4,
        exact: "本地优先",
      },
    });
  }

  it("带来源的独立会话显示来源条与材料范围说明，返回原文携带选区参数", async () => {
    const getResearchSessionView = vi.fn(async (sessionId: string) =>
      sessionId === "session-2"
        ? originView()
        : { ...originView(), session: makeSession({ id: "session-1", title: "理解注意力机制" }), messages: [], tasks: [] },
    );
    renderSessionPage(
      { getResearchSessionView, getResearchSelection: async () => originSelection() },
      "/research/session-2",
    );

    const sourceBar = await screen.findByTestId("selection-source-bar");
    expect(sourceBar).toHaveTextContent("来自《理解注意力机制》的选区");
    expect(sourceBar).toHaveTextContent("本地优先会先把输入保存在本机");
    expect(screen.getByRole("link", { name: "← 返回原文" })).toHaveAttribute("href", "/research/session-1?sel=sel-1");
    expect(screen.getByTestId("research-scope-note")).toHaveTextContent("未联网检索");
  });

  it("来源返回：消息选区在回答中重定位并高亮", async () => {
    // 选区锚点指向本页消息块内偏移 2–6 的“不同头可”——与块文本切片一致
    const selection = makeSelection({
      id: "sel-1",
      sessionId: "session-1",
      text: "不同头可",
      anchor: {
        kind: "message",
        messageId: "m-out",
        blockOrdinal: 0,
        startOffset: 2,
        endOffset: 6,
        exact: "不同头可",
      },
    });
    renderSessionPage(
      { getResearchSessionView: async () => readyView(), getResearchSelection: async () => selection },
      "/research/session-1?sel=sel-1",
    );

    const mark = await screen.findByText("不同头可", { selector: "[data-selection-mark]" });
    expect(mark.tagName).toBe("MARK");
    expect(screen.queryByTestId("selection-restore-fallback")).not.toBeInTheDocument();
  });

  it("来源返回：原消息不存在时降级展示保存原文与段落说明", async () => {
    const selection = makeSelection({
      id: "sel-1",
      sessionId: "session-1",
      text: "已被重写的内容",
      anchor: {
        kind: "message",
        messageId: "m-gone",
        blockOrdinal: 1,
        startOffset: 0,
        endOffset: 8,
        exact: "已被重写的内容",
      },
    });
    renderSessionPage(
      { getResearchSessionView: async () => readyView(), getResearchSelection: async () => selection },
      "/research/session-1?sel=sel-1",
    );

    const fallback = await screen.findByTestId("selection-restore-fallback");
    expect(fallback).toHaveTextContent("原选区位置未能精确恢复");
    expect(fallback).toHaveTextContent("段落 2");
    expect(fallback).toHaveTextContent("已被重写的内容");
    expect(screen.queryByText("已被重写的内容", { selector: "[data-selection-mark]" })).not.toBeInTheDocument();
  });

  it("会话分支列表按来源选区原文命名并可进入分支", async () => {
    const view: ResearchSessionView = {
      ...readyView(),
      branches: [makeBranch({ id: "branch-1", sessionId: "session-1", selectionId: "sel-1" })],
    };
    renderSessionPage({
      getResearchSessionView: async () => view,
      listResearchSelections: async () => [makeSelection({ id: "sel-1", sessionId: "session-1", text: "本地优先会先把输入保存在本机" })],
    });

    const list = await screen.findByTestId("branch-list");
    expect(list).toHaveTextContent("深入研究：本地优先会先把输入保存在本机");
    expect(screen.getByRole("link", { name: /深入研究：本地优先/ })).toHaveAttribute(
      "href",
      "/research/session-1/branch/branch-1",
    );
  });
});
