import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveBodyVersion, deriveFragmentsFromSlices, deriveMessageSlices, messageContentBlockId } from "@collector/capture-contracts";
import type { ResearchBodyVersionView, ResearchNodeView, ResearchSelectionInput, ResearchTurnAccepted } from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { ApiRequestError, NetworkError } from "../../api/errors";
import type { TaskEventStream } from "../../api/task-events";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeAttachment, makeBodyVersion, makeFragment, makeFusionProposal, makeMessage, makeNode, makeNodeView, makeSelection, makeSelectionTask, makeSession, makeTask } from "../../test/fakes";
import { ResearchNodePage } from "./ResearchNodePage";
import { __clearBodyVersionCache } from "./fragment-locator";

beforeEach(() => {
  __clearBodyVersionCache();
});

function noopTaskEventStream(): TaskEventStream {
  return { close: () => {}, syncNow: () => {}, mode: "closed", lastEventId: 0 };
}

function renderNodePage(api: Partial<ApiClient>, entry = "/nodes/session-1") {
  const services = {
    api: api as ApiClient,
    connectTaskEvents: vi.fn(noopTaskEventStream),
  } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/nodes/:nodeId" element={<ResearchNodePage />} />
          <Route path="/research/:sessionId" element={<p>会话路由</p>} />
          <Route path="/research/new" element={<p>开始页</p>} />
          <Route path="/trash" element={<p>回收站页</p>} />
          <Route path="/" element={<p>首页</p>} />
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
  it("404 显示“这个节点不存在或已经清理”并提供返回首页", async () => {
    renderNodePage({
      getResearchNodeView: async () => {
        throw new ApiRequestError(404, "not_found", "not found");
      },
    });

    expect(await screen.findByRole("heading", { name: "这个节点不存在或已经清理" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回首页" })).toHaveAttribute("href", "/");
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

  it("回收站会话的节点正文可读，提示条说明只读并以前往回收站为行动", async () => {
    const user = userEvent.setup();
    const trashedView = {
      ...readyRootView(),
      session: { ...readyRootView().session, trashedAt: "2026-08-13T10:00:00.000Z" },
    };
    renderNodePage({ getResearchNodeView: async () => trashedView });

    // 正文继续可读
    expect(await screen.findByText("因为不同头可以关注不同位置。")).toBeInTheDocument();
    // 提示条：可理解（只读说明）且可行动（前往回收站）
    expect(screen.getByText("这个节点所在的会话在回收站中")).toBeInTheDocument();
    expect(screen.getByText(/内容可以继续阅读，但不能修改/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "前往回收站" }));
    expect(await screen.findByText("回收站页")).toBeInTheDocument();
  });

  it("根会话右上角菜单提供重命名、归档、删除、收藏与当前会话标记", async () => {
    const user = userEvent.setup();
    const updateResearchSession = vi.fn(async (_id: string, update: { isFavorite?: boolean }) =>
      makeSession({ id: "session-1", title: "理解注意力机制", isFavorite: update.isFavorite ?? false }),
    );
    renderNodePage({
      getResearchNodeView: async () => readyRootView(),
      updateResearchSession,
      listResearchLaterItems: async () => [],
    });

    const trigger = await screen.findByRole("button", { name: "理解注意力机制 的会话菜单" });
    await user.click(trigger);
    const menu = screen.getByRole("menu", { name: "理解注意力机制 的会话操作" });
    expect(within(menu).getByRole("menuitem", { name: "重命名" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "归档" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "删除…" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "查看标记" })).toBeInTheDocument();

    await user.click(within(menu).getByRole("menuitem", { name: "收藏" }));
    await waitFor(() => expect(updateResearchSession).toHaveBeenCalledWith("session-1", { isFavorite: true }));
    expect(await screen.findByLabelText("已收藏")).toHaveTextContent("已收藏");

    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "查看标记" }));
    const dialog = await screen.findByRole("dialog", { name: "本会话标记" });
    expect(within(dialog).getByTestId("mark-empty")).toHaveTextContent("本会话还没有标记");
    await user.click(within(dialog).getByRole("button", { name: "关闭标记弹窗" }));
    expect(trigger).toHaveFocus();
  });

  it("归档当前会话后离开已归档内容并回到开始页", async () => {
    const user = userEvent.setup();
    const updateResearchSession = vi.fn(async () => makeSession({ id: "session-1", status: "archived" }));
    renderNodePage({ getResearchNodeView: async () => readyRootView(), updateResearchSession });

    await user.click(await screen.findByRole("button", { name: "理解注意力机制 的会话菜单" }));
    await user.click(screen.getByRole("menuitem", { name: "归档" }));

    await waitFor(() => expect(updateResearchSession).toHaveBeenCalledWith("session-1", { status: "archived" }));
    expect(await screen.findByText("开始页")).toBeInTheDocument();
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
    expect(link).toHaveAttribute("href", "/nodes/node-child-1");
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
      "/nodes/session-2",
    );

    const sourceBar = await screen.findByTestId("selection-source-bar");
    expect(sourceBar).toHaveTextContent("来自《理解注意力机制》的选区");
    expect(sourceBar).toHaveTextContent("本地优先会先把输入保存在本机");
    expect(screen.getByRole("link", { name: "← 返回原文" })).toHaveAttribute("href", "/nodes/session-1?sel=sel-1");
    expect(screen.getByTestId("research-scope-note")).toHaveTextContent("自动使用当前模型供应商的联网能力");
  });

  it("来源返回：消息选区在回答中重定位并高亮，只读提醒不重开胶囊", async () => {
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
      "/nodes/session-1?sel=sel-1",
    );

    const mark = await screen.findByText("不同头可", { selector: "[data-selection-mark]" });
    expect(mark.tagName).toBe("MARK");
    expect(screen.queryByTestId("selection-restore-fallback")).not.toBeInTheDocument();
    // #48：返回定位是只读临时提醒——不重开浮动胶囊，不进入引用态
    expect(screen.queryByTestId("floating-selection-capsule")).not.toBeInTheDocument();
    expect(screen.queryByTestId("selection-capsule")).not.toBeInTheDocument();
    expect(createResearchSelection).not.toHaveBeenCalled();
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
      "/nodes/session-1?sel=sel-1",
    );

    const fallback = await screen.findByTestId("selection-restore-fallback");
    expect(fallback).toHaveTextContent("原选区位置未能精确恢复");
    expect(fallback).toHaveTextContent("段落 2");
    expect(fallback).toHaveTextContent("已被重写的内容");
    expect(screen.queryByText("已被重写的内容", { selector: "[data-selection-mark]" })).not.toBeInTheDocument();
    // #48：降级说明持续展示，不重开胶囊
    expect(screen.queryByTestId("floating-selection-capsule")).not.toBeInTheDocument();
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
    renderNodePage(childApi(), "/nodes/node-child-1");

    const sourceBar = await screen.findByTestId("selection-source-bar");
    expect(sourceBar).toHaveTextContent("来自《理解注意力机制》的选区");
    expect(sourceBar).toHaveTextContent("不同头可以关注不同位置");
    expect(screen.getByRole("link", { name: "← 返回原文" })).toHaveAttribute(
      "href",
      "/nodes/session-1?sel=selection-1",
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
    renderNodePage({ ...childApi(), submitResearchNodeMessage }, "/nodes/node-child-1");

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
      "/nodes/node-child-1",
    );

    await screen.findByTestId("selection-source-bar");
    expect(container.querySelector(".attachments")).toBeNull();
  });

  it("稳定地址只凭节点编号渲染，会话上下文从节点视图派生", async () => {
    // #61：地址不含会话编号——即使节点属于其他会话，页面也按节点身份正常渲染，
    // 面包屑等会话上下文一律来自已加载视图而非 URL。
    const foreign = readyChildView();
    foreign.node = { ...foreign.node, sessionId: "other-session" };
    foreign.session = makeSession({ id: "other-session", title: "另一场研究" });
    renderNodePage({ ...childApi(), getResearchNodeView: async () => foreign }, "/nodes/node-child-1");

    expect(await screen.findByRole("heading", { name: "深入研究：不同头可以关注不同位置" })).toBeInTheDocument();
    const crumb = screen.getByRole("navigation", { name: "节点位置" });
    expect(within(crumb).getByRole("link", { name: "另一场研究" })).toHaveAttribute("href", "/nodes/other-session");
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
      "/nodes/node-child-1",
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
      "/nodes/node-child-1",
    );

    const list = await screen.findByTestId("node-child-list");
    expect(list).toBeInTheDocument();
    const link = await screen.findByRole("link", { name: /深入研究：深入探讨位置信息/ });
    expect(link).toHaveAttribute("href", "/nodes/node-grandchild-1");
  });

  it("子节点页来源返回只读提醒，不重开窗口不创建选区", async () => {
    const selection = makeSelection({
      id: "sel-1",
      sessionId: "session-1",
      text: "不同信息",
      anchor: {
        kind: "message",
        messageId: "m-out",
        blockOrdinal: 0,
        startOffset: 12,
        endOffset: 16,
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
      "/nodes/node-child-1?sel=sel-1",
    );

    // #48：返回定位是只读临时提醒——不重开浮动胶囊、不创建选区记录
    await screen.findByText("不同信息", { selector: "[data-selection-mark]" });
    expect(screen.queryByTestId("floating-selection-capsule")).not.toBeInTheDocument();
    expect(screen.queryByTestId("selection-capsule")).not.toBeInTheDocument();
    expect(createResearchSelection).not.toHaveBeenCalled();
  });
});

describe("#36 连续语义卡片与章节导航", () => {
  function makeSlice(overrides: Partial<import("@collector/capture-contracts").ResearchSliceRecord> = {}): import("@collector/capture-contracts").ResearchSliceRecord {
    return {
      id: "slice:session-1:m-out:0",
      nodeId: "session-1",
      messageId: "m-out",
      ordinal: 0,
      title: "起点",
      normalizedConcepts: [],
      sourceRefs: [],
      isProvisional: false,
      createdAt: "2026-08-01T00:00:00.000Z",
      ...overrides,
    };
  }

  function viewWithSlices(): ResearchNodeView {
    const view = readyRootView();
    const assistant = view.messages.find((m) => m.role === "assistant")!;
    // #91：节卡只在长文出现——把最后一段拉长超过共享阈值，前两段断言文本保持逐字不变。
    assistant.content = "第一段。\n\n第二段。\n\n第三段。" + "填充".repeat(1_200);
    view.slices = {
      [assistant.id]: [
        makeSlice({ id: `slice:session-1:${assistant.id}:0`, messageId: assistant.id, ordinal: 0, title: "起点" }),
        makeSlice({ id: `slice:session-1:${assistant.id}:1`, messageId: assistant.id, ordinal: 1, title: "推进" }),
        makeSlice({ id: `slice:session-1:${assistant.id}:2`, messageId: assistant.id, ordinal: 2, title: "收束" }),
      ],
    };
    return view;
  }

  it("页面级：按卡片顺序输出全部切片标题", async () => {
    renderNodePage({ getResearchNodeView: async () => viewWithSlices() });
    await screen.findByText("第一段。");
    const headings = screen.getAllByRole("heading", { level: 3 }).filter((h) => h.classList.contains("slice-card__title"));
    expect(headings.map((h) => h.textContent)).toEqual(["起点", "推进", "收束"]);
  });

  it("章节导航挂载：有正式切片时渲染导航，线数=切片数，aria-label=切片标题", async () => {
    const { container } = renderNodePage({ getResearchNodeView: async () => viewWithSlices() });
    await screen.findByText("第一段。");
    const nav = screen.getByRole("navigation", { name: "章节导航" });
    expect(nav).toBeInTheDocument();
    const ticks = container.querySelectorAll(".slice-rail__tick");
    expect(ticks.length).toBe(3);
    expect(ticks[0]).toHaveAttribute("aria-label", "起点");
    expect(ticks[1]).toHaveAttribute("aria-label", "推进");
    expect(ticks[2]).toHaveAttribute("aria-label", "收束");
  });

  it("导航降级：无正式切片时不渲染线列", async () => {
    const { container } = renderNodePage({ getResearchNodeView: async () => readyRootView() });
    await screen.findByText("因为不同头可以关注不同位置。");
    expect(screen.queryByRole("navigation", { name: "章节导航" })).not.toBeInTheDocument();
    expect(container.querySelectorAll(".slice-rail__tick").length).toBe(0);
  });

  it("导航降级：进行中任务不渲染线列", async () => {
    const view = makeNodeView({
      node: makeNode({ id: "session-1", sessionId: "session-1" }),
      session: makeSession({ id: "session-1" }),
      messages: [
        makeMessage({ id: "m-in", role: "user", content: "解释" }),
        makeMessage({ id: "m-out", role: "assistant", status: "pending", content: "" }),
      ],
      tasks: [makeTask({ id: "task-1", status: "running", inputMessageId: "m-in", outputMessageId: "m-out" })],
    });
    const { container } = renderNodePage({ getResearchNodeView: async () => view });
    await screen.findByText("解释");
    expect(container.querySelectorAll(".slice-rail__tick").length).toBe(0);
  });

  it("点击线跳转到对应卡片（更新当前线高亮）", async () => {
    const user = userEvent.setup();
    const { container } = renderNodePage({ getResearchNodeView: async () => viewWithSlices() });
    await screen.findByText("第一段。");
    const ticks = container.querySelectorAll<HTMLElement>(".slice-rail__tick");
    await user.click(ticks[2]);
    // 点击后立即更新当前线高亮
    expect(ticks[2].className).toContain("slice-rail__tick--active");
    expect(ticks[2]).toHaveAttribute("aria-current", "location");
  });
});

describe("#42 融合依据定位", () => {
  /** 三段式正文 + 真实派生切片/片段/版本（与生产同规则）。
      提案带两条同节点依据（同一版本、不同片段）——同版本缓存恰好一次请求。 */
  function viewWithFusionEvidence(overrides: { nodeId?: string; sessionId?: string } = {}): ResearchNodeView {
    const nodeId = overrides.nodeId ?? "session-1";
    const sessionId = overrides.sessionId ?? "session-1";
    const content = "第一段。\n\n第二段。\n\n第三段。";
    const message = makeMessage({ id: "m-out", nodeId, role: "assistant", status: "completed", content });
    const version = deriveBodyVersion({ messageId: message.id, nodeId, content, origin: "backfill", createdAt: "2026-08-02T00:00:00.000Z" });
    const slices = deriveMessageSlices(nodeId, message.id, content, 0, []);
    const fragments = deriveFragmentsFromSlices(version, slices, []);
    const proposal = makeFusionProposal({
      id: "fusion:1",
      loNodeId: nodeId,
      hiNodeId: "node-b",
      triggerSources: [
        { nodeId, bodyVersionId: version.id, fragmentId: fragments[1].id },
        { nodeId, bodyVersionId: version.id, fragmentId: fragments[0].id },
      ],
    });
    return makeNodeView({
      node: makeNode({ id: nodeId, sessionId }),
      session: makeSession({ id: sessionId, title: "理解注意力机制" }),
      messages: [makeMessage({ id: "m-in", role: "user", content: "为什么需要多头注意力？" }), message],
      tasks: [makeTask({ id: "task-1", status: "completed", inputMessageId: "m-in", outputMessageId: message.id })],
      slices: { [message.id]: slices },
      bodyVersions: { [message.id]: version },
      fusionProposals: [proposal],
    });
  }

  /** #91：普通回答的片段落点 = 轮次卡片内段落块容器（与 deriveSliceCardTargets 同源判定）。 */
  function blockTargetFor(messageId: string, ordinal: number): string {
    return messageContentBlockId(messageId, ordinal);
  }

  function bodyVersionViewFor(message: ReturnType<typeof makeMessage>, nodeId = "session-1"): ResearchBodyVersionView {
    const version = deriveBodyVersion({ messageId: message.id, nodeId, content: message.content, origin: "backfill", createdAt: "2026-08-02T00:00:00.000Z" });
    const slices = deriveMessageSlices(nodeId, message.id, message.content, 0, []);
    const fragments = deriveFragmentsFromSlices(version, slices, []);
    // 视图类型要求 excerpt；运行时预览经 resolveFragmentExcerpt 本地派生，不依赖该字段
    return { version, fragments: fragments.map((fragment) => ({ ...fragment, excerpt: version.content.slice(fragment.startOffset, fragment.endOffset) })) };
  }

  it("展开依据后渲染可点击依据条目，预览懒加载且同一版本只请求一次", async () => {
    const user = userEvent.setup();
    const view = viewWithFusionEvidence();
    const versionView = bodyVersionViewFor(view.messages.find((m) => m.id === "m-out")!, "session-1");
    const getResearchBodyVersion = vi.fn(async () => versionView);
    renderNodePage({ getResearchNodeView: async () => view, getResearchBodyVersion });

    await screen.findByText("第一段。");
    const summary = screen.getByText("熟悉的概念再现，节点可融合");
    await user.click(summary);
    await waitFor(() => expect(getResearchBodyVersion).toHaveBeenCalledTimes(1));
    const sources = await screen.findAllByRole("button", { name: /查看依据片段/ });
    expect(sources).toHaveLength(2);
    // 依据预览显示对应片段摘录（第二段 / 第一段）
    expect(sources[0]).toHaveTextContent("第二段。");
    expect(sources[1]).toHaveTextContent("第一段。");
  });

  it("跨节点点击依据：跳转到目标节点并定位目标卡片（强调 + 播报）", async () => {
    const user = userEvent.setup();
    const view = viewWithFusionEvidence();
    const childContent = "子节点第一段。\n\n子节点第二段。";
    const childMessage = makeMessage({ id: "m-child-out", nodeId: "node-b", role: "assistant", status: "completed", content: childContent });
    const childVersionView = bodyVersionViewFor(childMessage, "node-b");
    const childView: ResearchNodeView = makeNodeView({
      node: makeNode({ id: "node-b", sessionId: "session-1", parentNodeId: "session-1" }),
      session: makeSession({ id: "session-1", title: "理解注意力机制" }),
      messages: [makeMessage({ id: "m-child-in", role: "user", content: "追问" }), childMessage],
      tasks: [makeTask({ id: "task-2", status: "completed", inputMessageId: "m-child-in", outputMessageId: childMessage.id })],
      slices: { [childMessage.id]: deriveMessageSlices("node-b", childMessage.id, childContent, 0, []) },
      bodyVersions: { [childMessage.id]: childVersionView.version },
      fusionProposals: [],
    });
    // 根视图提案带一条指向子节点的依据（真实派生的版本与片段）
    const crossView: ResearchNodeView = {
      ...view,
      fusionProposals: [
        makeFusionProposal({
          id: "fusion:1",
          loNodeId: "session-1",
          hiNodeId: "node-b",
          triggerSources: [
            { nodeId: "node-b", bodyVersionId: childVersionView.version.id, fragmentId: childVersionView.fragments[1].id },
          ],
        }),
      ],
    };
    const getResearchNodeView = vi.fn(async (nodeId: string) => (nodeId === "node-b" ? childView : crossView));
    const getResearchBodyVersion = vi.fn(async () => childVersionView);
    renderNodePage(
      { getResearchNodeView, getResearchBodyVersion },
      "/nodes/session-1",
    );

    // 根页展开依据 → 点击指向子节点的依据
    await screen.findByText("第一段。");
    await user.click(screen.getByText("熟悉的概念再现，节点可融合"));
    const source = await screen.findByRole("button", { name: /查看依据片段/ });
    await user.click(source);

    // 子节点页加载完成，目标卡片（子节点第二段）获得强调
    await screen.findByText("子节点第二段。");
    await waitFor(() => {
      expect(document.getElementById(blockTargetFor("m-child-out", 1))).toHaveClass("fragment-target--focused");
    });
    // 播报（sr-only live region）
    expect(screen.getByText(/已定位到/)).toBeInTheDocument();
  });

  it("同节点点击依据：留在本页仅追加 fragment 参数并定位", async () => {
    const user = userEvent.setup();
    const view = viewWithFusionEvidence();
    const versionView = bodyVersionViewFor(view.messages.find((m) => m.id === "m-out")!, "session-1");
    renderNodePage(
      {
        getResearchNodeView: async () => view,
        getResearchBodyVersion: async () => versionView,
        getResearchSelection: async () => makeSelection({ id: "sel-1", sessionId: "session-1", text: "不同头可以关注不同位置" }),
      },
      "/nodes/session-1?sel=sel-1",
    );

    await screen.findByText("第一段。");
    await user.click(screen.getByText("熟悉的概念再现，节点可融合"));
    const source = (await screen.findAllByRole("button", { name: /查看依据片段/ }))[0];
    await user.click(source);

    // 同节点：留在本页并定位（导航成功 → 目标卡片获得强调；?sel= 保留由 fragmentDeepLink 保证）
    await waitFor(() => {
      expect(document.getElementById(blockTargetFor("m-out", 1))).toHaveClass("fragment-target--focused");
    });
    expect(screen.getByText(/已定位到/)).toBeInTheDocument();
  });

  it("快速切换目标：旧卡片强调消失，只保留最新落点", async () => {
    const user = userEvent.setup();
    const view = viewWithFusionEvidence();
    const versionView = bodyVersionViewFor(view.messages.find((m) => m.id === "m-out")!, "session-1");
    renderNodePage({
      getResearchNodeView: async () => view,
      getResearchBodyVersion: async () => versionView,
    });

    await screen.findByText("第一段。");
    await user.click(screen.getByText("熟悉的概念再现，节点可融合"));
    const sources = await screen.findAllByRole("button", { name: /查看依据片段/ });
    // 第一条依据（第二段）→ 第二段卡片强调
    await user.click(sources[0]);
    await waitFor(() => {
      expect(document.getElementById(blockTargetFor("m-out", 1))).toHaveClass("fragment-target--focused");
    });
    // 第二条依据（第一段）→ 强调转移到第一段卡片
    await user.click(sources[1]);
    await waitFor(() => {
      expect(document.getElementById(blockTargetFor("m-out", 0))).toHaveClass("fragment-target--focused");
    });
    expect(document.getElementById(blockTargetFor("m-out", 1))).not.toHaveClass("fragment-target--focused");
  });

  it("失效回退：版本获取失败时显示明确回退信息，不静默定位", async () => {
    const user = userEvent.setup();
    const view = viewWithFusionEvidence();
    const getResearchBodyVersion = vi.fn(async () => {
      throw new ApiRequestError(404, "not_found", "not found");
    });
    renderNodePage({ getResearchNodeView: async () => view, getResearchBodyVersion });

    await screen.findByText("第一段。");
    await user.click(screen.getByText("熟悉的概念再现，节点可融合"));
    const source = (await screen.findAllByRole("button", { name: /查看依据片段/ }))[0];
    await user.click(source);
    const fallback = await screen.findByTestId("fragment-locator-fallback");
    expect(fallback).toHaveTextContent("正文版本已不存在");
    // 无卡片获得强调
    expect(document.querySelector(".fragment-target--focused")).toBeNull();
  });

  it("accepted 提案：无决策按钮，依据仍可点击", async () => {
    const user = userEvent.setup();
    const view = viewWithFusionEvidence();
    const versionView = bodyVersionViewFor(view.messages.find((m) => m.id === "m-out")!, "session-1");
    const accepted = { ...view.fusionProposals![0], status: "accepted" as const };
    const viewAccepted = { ...view, fusionProposals: [accepted] };
    renderNodePage({ getResearchNodeView: async () => viewAccepted, getResearchBodyVersion: async () => versionView });

    await screen.findByText("第一段。");
    await user.click(screen.getByText("已保留的概念关系"));
    expect(screen.queryByRole("button", { name: "保留关系" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "暂不处理" })).not.toBeInTheDocument();
    expect(await screen.findAllByRole("button", { name: /查看依据片段/ })).toHaveLength(2);
  });

  it("决策为 accepted 时提案转为只读依据入口，rejected 时移除", async () => {
    const user = userEvent.setup();
    const view = viewWithFusionEvidence();
    const versionView = bodyVersionViewFor(view.messages.find((m) => m.id === "m-out")!, "session-1");
    const proposal = view.fusionProposals![0];
    const decideResearchFusionProposal = vi.fn(async () => ({ ...proposal, status: "accepted" as const }));
    renderNodePage({
      getResearchNodeView: async () => view,
      getResearchBodyVersion: async () => versionView,
      decideResearchFusionProposal,
    });

    await screen.findByText("第一段。");
    await user.click(screen.getByText("熟悉的概念再现，节点可融合"));
    await user.click(screen.getByRole("button", { name: "保留关系" }));
    await waitFor(() => expect(decideResearchFusionProposal).toHaveBeenCalledWith("fusion:1", "accepted"));
    // 提案保留为只读（无决策按钮，依据可点）——findBy 等待 async 决策后重渲染
    await waitFor(() => expect(screen.queryByText("已保留的概念关系")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "保留关系" })).not.toBeInTheDocument();
    expect((await screen.findAllByRole("button", { name: /查看依据片段/ })).length).toBeGreaterThan(0);
  });

  it("#31 点击「融合为节点」调用 fuse 并跳转到融合节点页", async () => {
    const user = userEvent.setup();
    const view = viewWithFusionEvidence();
    const versionView = bodyVersionViewFor(view.messages.find((m) => m.id === "m-out")!, "session-1");
    const fuseResearchFusionProposal = vi.fn(async () => ({
      node: makeNode({ id: "fusion-node-1", sessionId: "session-1" }),
      session: makeSession({ id: "session-1" }),
      selection: undefined,
      inputMessage: makeMessage({ id: "m-fuse-in", role: "user", content: "请综合以下研究来源" }),
      outputMessage: makeMessage({ id: "m-fuse-out", role: "assistant", status: "pending", content: "" }),
      task: makeTask({ id: "task-fuse", status: "queued", inputMessageId: "m-fuse-in", outputMessageId: "m-fuse-out" }),
    }));
    renderNodePage(
      {
        getResearchNodeView: async () => view,
        getResearchBodyVersion: async () => versionView,
        fuseResearchFusionProposal,
      },
      "/nodes/session-1",
    );

    await screen.findByText("第一段。");
    await user.click(screen.getByText("熟悉的概念再现，节点可融合"));
    await user.click(screen.getByRole("button", { name: "融合为节点" }));
    await waitFor(() => expect(fuseResearchFusionProposal).toHaveBeenCalledWith("fusion:1", "fuse:fusion:1"));
  });

  it("无 fragment 参数时不请求正文版本", async () => {
    const view = viewWithFusionEvidence();
    const getResearchBodyVersion = vi.fn(async () => bodyVersionViewFor(view.messages.find((m) => m.id === "m-out")!));
    renderNodePage({ getResearchNodeView: async () => view, getResearchBodyVersion });
    await screen.findByText("第一段。");
    expect(getResearchBodyVersion).not.toHaveBeenCalled();
  });
});


describe("#32 自动融合挂载扫描", () => {
  it("开关开启：挂载自动扫描，合并提案并显示可跳转的自动融合提示条", async () => {
    const user = userEvent.setup();
    const view = readyRootView();
    const pendingProposal = makeFusionProposal({
      id: "fusion:auto-1",
      loNodeId: "session-1",
      hiNodeId: "node-b",
      status: "pending",
    });
    const scanResearchFusionProposals = vi.fn(async () => ({
      proposals: [pendingProposal],
      autoFused: [{ proposalId: "fusion:auto-1", nodeId: "fusion-node-1", sessionId: "session-1" }],
    }));
    const getFusionAutoConfig = vi.fn(async () => ({ enabled: true }));
    renderNodePage({
      getResearchNodeView: async () => view,
      getFusionAutoConfig,
      scanResearchFusionProposals,
    });

    await waitFor(() => expect(getFusionAutoConfig).toHaveBeenCalled());
    await waitFor(() => expect(scanResearchFusionProposals).toHaveBeenCalledWith("session-1"));
    // 自动融合提示条可见且链接指向融合节点页。
    await screen.findByTestId("auto-fusion-notice");
    expect(screen.getByText("已自动生成融合节点")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看融合节点" })).toHaveAttribute(
      "href",
      "/nodes/fusion-node-1",
    );
    // 扫描返回的 pending 提案合并进弱提示区（同一实体/共享概念才自动融合，这里 status 保持 pending）。
    await waitFor(() => expect(screen.getByText("熟悉的概念再现，节点可融合")).toBeInTheDocument());
  });

  it("开关关闭：不调用扫描，不显示提示条", async () => {
    const view = readyRootView();
    const scanResearchFusionProposals = vi.fn(async () => ({ proposals: [], autoFused: [] }));
    const getFusionAutoConfig = vi.fn(async () => ({ enabled: false }));
    renderNodePage({ getResearchNodeView: async () => view, getFusionAutoConfig, scanResearchFusionProposals });

    await screen.findByText("为什么需要多头注意力？");
    await waitFor(() => expect(getFusionAutoConfig).toHaveBeenCalled());
    expect(scanResearchFusionProposals).not.toHaveBeenCalled();
    expect(screen.queryByTestId("auto-fusion-notice")).not.toBeInTheDocument();
  });

  it("客户端方法缺失（旧替身）：静默跳过，不扫描不报错", async () => {
    const view = readyRootView();
    renderNodePage({ getResearchNodeView: async () => view });
    await screen.findByText("为什么需要多头注意力？");
    expect(screen.queryByTestId("auto-fusion-notice")).not.toBeInTheDocument();
  });

  it("扫描失败：页面正常，无提示条", async () => {
    const view = readyRootView();
    const getFusionAutoConfig = vi.fn(async () => ({ enabled: true }));
    const scanResearchFusionProposals = vi.fn(async () => {
      throw new NetworkError();
    });
    renderNodePage({ getResearchNodeView: async () => view, getFusionAutoConfig, scanResearchFusionProposals });
    await screen.findByText("为什么需要多头注意力？");
    await waitFor(() => expect(scanResearchFusionProposals).toHaveBeenCalled());
    expect(screen.queryByTestId("auto-fusion-notice")).not.toBeInTheDocument();
  });

  it("自动融合节点页标题旁显示「自动生成」徽章；确认式融合节点不显示", async () => {
    const autoView = makeNodeView({
      node: makeNode({ id: "fusion-node-1", sessionId: "session-1", isFusionNode: true, isAutoFusionNode: true }),
      session: makeSession({ id: "session-1", title: "融合节点" }),
      messages: [makeMessage({ id: "m-in", role: "user", content: "请综合以下研究来源" })],
      tasks: [],
      fusionProposals: [],
    });
    const { unmount } = renderNodePage(
      { getResearchNodeView: async () => autoView },
      "/nodes/fusion-node-1",
    );
    await screen.findByRole("heading", { name: /融合节点/ });
    expect(screen.getByTestId("auto-fusion-badge")).toHaveTextContent("自动生成");
    unmount();

    const manualView = makeNodeView({
      node: makeNode({ id: "fusion-node-2", sessionId: "session-1", isFusionNode: true }),
      session: makeSession({ id: "session-1", title: "融合节点" }),
      messages: [makeMessage({ id: "m-in", role: "user", content: "请综合以下研究来源" })],
      tasks: [],
      fusionProposals: [],
    });
    renderNodePage(
      { getResearchNodeView: async () => manualView },
      "/nodes/fusion-node-2",
    );
    await screen.findByRole("heading", { name: "融合节点" });
    expect(screen.queryByTestId("auto-fusion-badge")).not.toBeInTheDocument();
  });
});
