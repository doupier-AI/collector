import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ResearchNodeView, ResearchSelectionInput, ResearchTurnAccepted } from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { ApiRequestError, NetworkError } from "../../api/errors";
import type { TaskEventStream } from "../../api/task-events";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeAttachment, makeMessage, makeNode, makeNodeView, makeSelection, makeSelectionTask, makeSession, makeTask } from "../../test/fakes";
import { ResearchNodePage } from "./ResearchNodePage";

function noopTaskEventStream(): TaskEventStream {
  return { close: () => {}, syncNow: () => {}, mode: "closed", lastEventId: 0 };
}

function renderNodePage(api: Partial<ApiClient>, entry = "/research/session-1/node/session-1") {
  const services = {
    api: api as ApiClient,
    connectTaskEvents: vi.fn(noopTaskEventStream),
  } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/research/:sessionId/node/:nodeId" element={<ResearchNodePage />} />
          <Route path="/research/:sessionId" element={<p>会话路由</p>} />
          <Route path="/research/new" element={<p>开始页</p>} />
        </Routes>
      </MemoryRouter>
    </ServicesProvider>,
  );
}

function readyRootView(): ResearchNodeView {
  return makeNodeView({
    node: makeNode({ id: "session-1", sessionId: "session-1" }),
    session: makeSession({ id: "session-1", title: "理解注意力机制" }),
    messages: [
      makeMessage({ id: "m-in", role: "user", content: "为什么需要多头注意力？" }),
      makeMessage({ id: "m-out", role: "assistant", status: "completed", content: "因为不同头可以关注不同位置。" }),
    ],
    tasks: [makeTask({ id: "task-1", status: "completed", inputMessageId: "m-in", outputMessageId: "m-out" })],
  });
}

describe("ResearchNodePage 错误文案映射", () => {
  it("404 显示“这场研究不存在或已经清理”并提供返回研究", async () => {
    renderNodePage({
      getResearchNodeView: async () => {
        throw new ApiRequestError(404, "not_found", "not found");
      },
    });

    expect(await screen.findByRole("heading", { name: "这场研究不存在或已经清理" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回研究" })).toHaveAttribute("href", "/research/session-1/node/session-1");
  });

  it("401 显示配对引导，配对码错误时给出文案", async () => {
    const user = userEvent.setup();
    const exchangePairingCode = vi.fn(async () => {
      throw new ApiRequestError(401, "invalid_pairing", "invalid");
    });
    renderNodePage({
      getResearchNodeView: async () => {
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

  it("配对成功后自动重新加载节点", async () => {
    const user = userEvent.setup();
    const getResearchNodeView = vi
      .fn<() => Promise<ResearchNodeView>>()
      .mockRejectedValueOnce(new ApiRequestError(401, "unauthorized", "unauthorized"))
      .mockResolvedValueOnce(readyRootView());
    renderNodePage({
      getResearchNodeView,
      exchangePairingCode: async () => ({ paired: true as const }),
    });

    expect(await screen.findByRole("heading", { name: "配对 Collector" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("配对码"), "654321");
    await user.click(screen.getByRole("button", { name: "配对并继续" }));

    expect(await screen.findByRole("heading", { name: "理解注意力机制" })).toBeInTheDocument();
    expect(getResearchNodeView).toHaveBeenCalledTimes(2);
  });

  it("500 显示通用错误并可重试", async () => {
    const user = userEvent.setup();
    const getResearchNodeView = vi
      .fn<() => Promise<ResearchNodeView>>()
      .mockRejectedValueOnce(new ApiRequestError(500, "internal_error", "boom"))
      .mockResolvedValueOnce(readyRootView());
    renderNodePage({ getResearchNodeView });

    expect(await screen.findByRole("heading", { name: "暂时无法打开这场研究" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { name: "理解注意力机制" })).toBeInTheDocument();
    expect(getResearchNodeView).toHaveBeenCalledTimes(2);
  });

  it("网络失败显示通用错误，页面可重试", async () => {
    const user = userEvent.setup();
    const getResearchNodeView = vi
      .fn<() => Promise<ResearchNodeView>>()
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValueOnce(readyRootView());
    renderNodePage({ getResearchNodeView });

    expect(await screen.findByRole("heading", { name: "暂时无法打开这场研究" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { name: "理解注意力机制" })).toBeInTheDocument();
  });
});

describe("ResearchNodePage 根节点", () => {
  it("渲染会话标题、更新时间与完整消息", async () => {
    renderNodePage({ getResearchNodeView: async () => readyRootView() });

    expect(await screen.findByRole("heading", { name: "理解注意力机制" })).toBeInTheDocument();
    expect(screen.getByText(/更新于/)).toBeInTheDocument();
    expect(screen.getByText("为什么需要多头注意力？")).toBeInTheDocument();
    expect(screen.getByText("因为不同头可以关注不同位置。")).toBeInTheDocument();
    expect(screen.getByLabelText("你的问题")).toBeInTheDocument();
  });

  it("在流状态提示下方呈现可用键盘展开和决策的相似概念弱提示", async () => {
    const user = userEvent.setup();
    const proposal = {
      id: "fusion:1",
      loNodeId: "node-a",
      hiNodeId: "node-b",
      relationType: "contrast" as const,
      reason: "两个同名角色来自不同作品。",
      status: "pending" as const,
      triggerSources: [],
      verification: { promptVersion: "similarity-verify-v1" as const, sourceSliceIds: [], tokenBudget: 800 },
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    };
    const view: ResearchNodeView = { ...readyRootView(), fusionProposals: [proposal] };
    const decideResearchFusionProposal = vi.fn(async () => ({ ...proposal, status: "rejected" as const, cooldownUntil: "2026-09-01T00:00:00.000Z" }));
    const { container } = renderNodePage({ getResearchNodeView: async () => view, decideResearchFusionProposal });

    const notice = await screen.findByTestId("fusion-proposal-notice");
    expect(notice).toHaveTextContent("熟悉的概念再现，节点可融合");
    const header = container.querySelector(".session-header");
    expect(header?.compareDocumentPosition(notice) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    const summary = screen.getByText("熟悉的概念再现，节点可融合");
    summary.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByText("关系：对比")).toBeInTheDocument();
    expect(screen.getByText("两个同名角色来自不同作品。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "暂不处理" }));
    await waitFor(() => expect(decideResearchFusionProposal).toHaveBeenCalledWith("fusion:1", "rejected"));
    expect(screen.queryByTestId("fusion-proposal-notice")).not.toBeInTheDocument();
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
    const view = makeNodeView({
      node: makeNode({ id: "session-1", sessionId: "session-1" }),
      session: makeSession({ id: "session-1", title: "本地优先研究" }),
      messages: [
        makeMessage({ id: "m-in", role: "user", content: "即使没有模型也请保存这段输入" }),
        makeMessage({ id: "m-out", role: "assistant", status: "failed", content: "" }),
      ],
      tasks: [failedTask],
    });
    const retryResearchTask = vi.fn(async () => makeTask({ ...failedTask, status: "queued" as const }));
    const { container } = renderNodePage({
      getResearchNodeView: async () => view,
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
    const view = makeNodeView({
      node: makeNode({ id: "session-1", sessionId: "session-1" }),
      session: makeSession({ id: "session-1" }),
      messages: [
        makeMessage({ id: "m-in", role: "user", content: "解释本地优先研究的价值" }),
        makeMessage({ id: "m-out", role: "assistant", status: "pending", content: "" }),
      ],
      tasks: [makeTask({ id: "task-1", status: "running", inputMessageId: "m-in", outputMessageId: "m-out" })],
    });
    renderNodePage({ getResearchNodeView: async () => view });

    expect(await screen.findByText("解释本地优先研究的价值")).toBeInTheDocument();
    expect(screen.getByTestId("ai-placeholder")).toBeInTheDocument();
    expect(screen.getByText("已保存，正在请求联网")).toBeInTheDocument();
  });

  it("子节点列表按来源选区原文命名并可进入子节点", async () => {
    const view = makeNodeView({
      ...readyRootView(),
      childNodes: [makeNode({ id: "node-child-1", sessionId: "session-1", parentNodeId: "session-1", originSelectionId: "sel-1" })],
    });
    renderNodePage({
      getResearchNodeView: async () => view,
      listResearchSelections: async () => [makeSelection({ id: "sel-1", sessionId: "session-1", text: "本地优先会先把输入保存在本机" })],
    });

    const list = await screen.findByTestId("node-child-list");
    expect(list).toBeInTheDocument();
    // 子节点名来自异步读取的选区原文：等待具名链接出现，避免对兜底名做非等待断言
    const link = await screen.findByRole("link", { name: /深入研究：本地优先会先把输入保存在本机/ });
    expect(link).toHaveAttribute("href", "/research/session-1/node/node-child-1");
  });
});

describe("ResearchNodePage 带来源的根节点（旧独立会话）", () => {
  function originView(): ResearchNodeView {
    return makeNodeView({
      node: makeNode({ id: "session-2", sessionId: "session-2" }),
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
    });
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

  it("带来源的根节点显示来源条与材料范围说明，返回原文携带选区参数", async () => {
    renderNodePage(
      {
        getResearchNodeView: async () => originView(),
        getResearchSelection: async () => originSelection(),
        getResearchSessionView: async () => ({
          session: makeSession({ id: "session-1", title: "理解注意力机制" }),
          messages: [],
          tasks: [],
        }),
      },
      "/research/session-2/node/session-2",
    );

    const sourceBar = await screen.findByTestId("selection-source-bar");
    expect(sourceBar).toHaveTextContent("来自《理解注意力机制》的选区");
    expect(sourceBar).toHaveTextContent("本地优先会先把输入保存在本机");
    expect(screen.getByRole("link", { name: "← 返回原文" })).toHaveAttribute("href", "/research/session-1/node/session-1?sel=sel-1");
    expect(screen.getByTestId("research-scope-note")).toHaveTextContent("自动使用当前模型供应商的联网能力");
  });

  it("来源返回：消息选区在回答中重定位并高亮", async () => {
    const user = userEvent.setup();
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
    const createResearchSelection = vi.fn(async () => ({
      selection,
      task: makeSelectionTask({ id: "sel-task-1", status: "completed" }),
    }));
    renderNodePage(
      {
        getResearchNodeView: async () => readyRootView(),
        getResearchSelection: async () => selection,
        createResearchSelection,
      },
      "/research/session-1/node/session-1?sel=sel-1",
    );

    const mark = await screen.findByText("不同头可", { selector: "[data-selection-mark]" });
    expect(mark.tagName).toBe("MARK");
    expect(screen.queryByTestId("selection-restore-fallback")).not.toBeInTheDocument();
    // 来源返回先显示浮动胶囊；明确点击引用后才进入引用态
    expect(await screen.findByTestId("floating-selection-capsule")).toBeInTheDocument();
    expect(screen.queryByTestId("selection-capsule")).not.toBeInTheDocument();
    expect(createResearchSelection).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("floating-capsule-cite"));
    expect(await screen.findByTestId("selection-capsule")).toBeInTheDocument();
    expect(createResearchSelection).toHaveBeenCalledTimes(1);
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
    renderNodePage(
      {
        getResearchNodeView: async () => readyRootView(),
        getResearchSelection: async () => selection,
        createResearchSelection: async () => ({
          selection,
          task: makeSelectionTask({ id: "sel-task-1", status: "completed" }),
        }),
      },
      "/research/session-1/node/session-1?sel=sel-1",
    );

    const fallback = await screen.findByTestId("selection-restore-fallback");
    expect(fallback).toHaveTextContent("原选区位置未能精确恢复");
    expect(fallback).toHaveTextContent("段落 2");
    expect(fallback).toHaveTextContent("已被重写的内容");
    expect(screen.queryByText("已被重写的内容", { selector: "[data-selection-mark]" })).not.toBeInTheDocument();
  });
});

describe("ResearchNodePage 子节点", () => {
  function readyChildView(): ResearchNodeView {
    return makeNodeView({
      node: makeNode({
        id: "node-child-1",
        sessionId: "session-1",
        parentNodeId: "session-1",
        originSelectionId: "selection-1",
      }),
      session: makeSession({ id: "session-1", title: "理解注意力机制" }),
      messages: [
        makeMessage({ id: "m-in", sessionId: "session-1", nodeId: "node-child-1", role: "user", content: "把这段讲透" }),
        makeMessage({
          id: "m-out",
          sessionId: "session-1",
          nodeId: "node-child-1",
          role: "assistant",
          status: "completed",
          content: "多头注意力让每个位置看到不同信息。",
        }),
      ],
      tasks: [
        makeTask({ id: "task-1", sessionId: "session-1", nodeId: "node-child-1", status: "completed", inputMessageId: "m-in", outputMessageId: "m-out" }),
      ],
    });
  }

  function childApi(): Partial<ApiClient> {
    return {
      getResearchNodeView: async () => readyChildView(),
      getResearchSelection: async () => makeSelection({ id: "selection-1", sessionId: "session-1", text: "不同头可以关注不同位置" }),
      getResearchSessionView: async () => ({
        session: makeSession({ id: "session-1", title: "理解注意力机制" }),
        messages: [],
        tasks: [],
      }),
    };
  }

  it("呈现来源条、材料范围说明与节点消息，标题来自来源选区摘要", async () => {
    renderNodePage(childApi(), "/research/session-1/node/node-child-1");

    const sourceBar = await screen.findByTestId("selection-source-bar");
    expect(sourceBar).toHaveTextContent("来自《理解注意力机制》的选区");
    expect(sourceBar).toHaveTextContent("不同头可以关注不同位置");
    expect(screen.getByRole("link", { name: "← 返回原文" })).toHaveAttribute(
      "href",
      "/research/session-1/node/session-1?sel=selection-1",
    );
    expect(screen.getByTestId("research-scope-note")).toHaveTextContent("自动使用当前模型供应商的联网能力");
    expect(screen.getByRole("heading", { name: "深入研究：不同头可以关注不同位置" })).toBeInTheDocument();

    expect(await screen.findByText("把这段讲透")).toBeInTheDocument();
    expect(screen.getByText("多头注意力让每个位置看到不同信息。")).toBeInTheDocument();
  });

  it("子节点内继续追问使用稳定幂等键提交节点消息", async () => {
    const user = userEvent.setup();
    const submitResearchNodeMessage = vi.fn(
      async (_nodeId: string, _content: string, _idempotencyKey: string): Promise<ResearchTurnAccepted> => ({
        session: makeSession({ id: "session-1" }),
        inputMessage: makeMessage({ id: "m-in-2", role: "user", content: "继续追问" }),
        outputMessage: makeMessage({ id: "m-out-2", role: "assistant", status: "pending" }),
        task: makeTask({ id: "task-2", status: "queued", inputMessageId: "m-in-2", outputMessageId: "m-out-2" }),
      }),
    );
    renderNodePage({ ...childApi(), submitResearchNodeMessage }, "/research/session-1/node/node-child-1");

    const composer = await screen.findByLabelText("你的问题");
    await user.type(composer, "继续追问");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(submitResearchNodeMessage).toHaveBeenCalledTimes(1));
    const [nodeId, content, key] = submitResearchNodeMessage.mock.calls[0];
    expect(nodeId).toBe("node-child-1");
    expect(content).toBe("继续追问");
    expect(key).toMatch(/^[!-~]+$/);
    expect(key.length).toBeLessThanOrEqual(200);
    // 追问保存后出现在节点消息列表
    expect(await screen.findByText("继续追问", { selector: ".message__content" })).toBeInTheDocument();
  });

  it("子节点不呈现附件区（即使视图携带会话级附件）", async () => {
    const viewWithAttachments: ResearchNodeView = {
      ...readyChildView(),
      attachments: [makeAttachment({ id: "att-1", sessionId: "session-1", status: "ready" })],
    };
    const { container } = renderNodePage(
      { ...childApi(), getResearchNodeView: async () => viewWithAttachments },
      "/research/session-1/node/node-child-1",
    );

    await screen.findByTestId("selection-source-bar");
    expect(container.querySelector(".attachments")).toBeNull();
  });

  it("路由会话编号与节点所属会话不一致时按不存在处理", async () => {
    const mismatched = readyChildView();
    mismatched.node = { ...mismatched.node, sessionId: "other-session" };
    renderNodePage({ ...childApi(), getResearchNodeView: async () => mismatched }, "/research/session-1/node/node-child-1");
    expect(await screen.findByRole("heading", { name: "这场研究不存在或已经清理" })).toBeInTheDocument();
  });

  it("500 错误可重试", async () => {
    const user = userEvent.setup();
    const getResearchNodeView = vi
      .fn<() => Promise<ResearchNodeView>>()
      .mockRejectedValueOnce(new ApiRequestError(500, "internal_error", "boom"))
      .mockResolvedValueOnce(readyChildView());
    renderNodePage(
      {
        getResearchNodeView,
        getResearchSelection: async () => makeSelection({ id: "selection-1", sessionId: "session-1", text: "不同头可以关注不同位置" }),
        getResearchSessionView: async () => ({
          session: makeSession({ id: "session-1", title: "理解注意力机制" }),
          messages: [],
          tasks: [],
        }),
      },
      "/research/session-1/node/node-child-1",
    );

    expect(await screen.findByRole("heading", { name: "暂时无法打开这场研究" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByTestId("selection-source-bar")).toBeInTheDocument();
    expect(getResearchNodeView).toHaveBeenCalledTimes(2);
  });

  it("子节点页呈现它自己长出的子节点（C 页显示 D）", async () => {
    const viewWithGrandchild = makeNodeView({
      ...readyChildView(),
      childNodes: [makeNode({ id: "node-grandchild-1", sessionId: "session-1", parentNodeId: "node-child-1", originSelectionId: "sel-d" })],
    });
    renderNodePage(
      {
        ...childApi(),
        getResearchNodeView: async () => viewWithGrandchild,
        listResearchSelections: async () => [makeSelection({ id: "sel-d", sessionId: "session-1", text: "深入探讨位置信息" })],
      },
      "/research/session-1/node/node-child-1",
    );

    const list = await screen.findByTestId("node-child-list");
    expect(list).toBeInTheDocument();
    const link = await screen.findByRole("link", { name: /深入研究：深入探讨位置信息/ });
    expect(link).toHaveAttribute("href", "/research/session-1/node/node-grandchild-1");
  });

  it("子节点页来源返回重开窗口时，创建选区携带当前节点 id", async () => {
    const user = userEvent.setup();
    const selection = makeSelection({
      id: "sel-1",
      sessionId: "session-1",
      text: "不同信息",
      anchor: {
        kind: "message",
        messageId: "m-out",
        blockOrdinal: 0,
        startOffset: 0,
        endOffset: 4,
        exact: "不同信息",
      },
    });
    const createResearchSelection = vi.fn(
      async (_sessionId: string, _input: ResearchSelectionInput, _idempotencyKey: string) => ({
        selection,
        task: makeSelectionTask({ id: "sel-task-1", status: "completed" }),
      }),
    );
    renderNodePage(
      { ...childApi(), getResearchSelection: async () => selection, createResearchSelection },
      "/research/session-1/node/node-child-1?sel=sel-1",
    );

    // 来源返回先显示浮动胶囊，明确点击引用后创建选区并携带当前节点 id
    await screen.findByTestId("floating-selection-capsule");
    expect(screen.queryByTestId("selection-capsule")).not.toBeInTheDocument();
    expect(createResearchSelection).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("floating-capsule-cite"));
    await screen.findByTestId("selection-capsule");
    await waitFor(() => expect(createResearchSelection).toHaveBeenCalledTimes(1));
    const [sessionId, input] = createResearchSelection.mock.calls[0];
    expect(sessionId).toBe("session-1");
    expect(input.nodeId).toBe("node-child-1");
  });
});
