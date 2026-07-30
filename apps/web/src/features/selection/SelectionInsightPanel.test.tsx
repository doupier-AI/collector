import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type {
  CreateChildNodeInput,
  NodeGrowthAccepted,
  ResearchLaterItemInput,
  ResearchLaterItemView,
  ResearchSelectionAccepted,
  ResearchSelectionInput,
  ResearchSelectionInsight,
  ResearchSelectionTaskEvent,
} from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { ApiRequestError } from "../../api/errors";
import type { SelectionEventStreamOptions } from "../../api/selection-events";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { LATER_CHANGED_EVENT } from "../navigation/later-event";
import { makeLaterItemView, makeMessage, makeNode, makeSelection, makeSelectionTask, makeSession, makeTask } from "../../test/fakes";
import { SelectionInsightPanel, selectionIdempotencyKey } from "./SelectionInsightPanel";
import type { ActiveCapture } from "./useSelection";

const insight: ResearchSelectionInsight = {
  summary: "这段在讲选区的锚点设计",
  difficulty: "中",
  quickReadMinutes: 2,
  deepStudyMinutes: 15,
  prerequisites: ["基础阅读能力", "段落概念"],
  relationToContent: "选区是当前回答的核心论点",
  rationale: "判断依据是选区内的定义句",
};

function makeCapture(): ActiveCapture {
  return {
    range: {
      startBlockId: "m-out#p0",
      endBlockId: "m-out#p0",
      startOffset: 0,
      endOffset: 6,
      text: "一段选区文字",
      blockCount: 1,
    },
    anchor: {
      kind: "message",
      messageId: "m-out",
      blockOrdinal: 0,
      startOffset: 0,
      endOffset: 6,
      exact: "一段选区文字",
    },
    quality: { level: "ok" },
    rect: { top: 100, bottom: 120, left: 40, right: 200 },
  };
}

interface StreamHandle {
  options: SelectionEventStreamOptions;
  closed: boolean;
  emit(event: ResearchSelectionTaskEvent): void;
}

function renderPanel(api: Partial<ApiClient>, options: { nodeId?: string } = {}) {
  const streams: StreamHandle[] = [];
  const connectSelectionEvents = vi.fn((options: SelectionEventStreamOptions) => {
    const handle: StreamHandle = {
      options,
      closed: false,
      emit(event) {
        options.onEvent(event);
      },
    };
    streams.push(handle);
    return {
      close: () => {
        handle.closed = true;
      },
      syncNow: () => {},
      mode: "streaming" as const,
      lastEventId: 0,
    };
  });
  const services = {
    api: api as ApiClient,
    connectSelectionEvents,
  } as unknown as AppServices;
  const view = render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={["/research/session-1"]}>
        <SelectionInsightPanel sessionId="session-1" nodeId={options.nodeId} capture={makeCapture()} onClose={() => {}} />
        <LocationProbe />
      </MemoryRouter>
    </ServicesProvider>,
  );
  return { ...view, streams, connectSelectionEvents, services };
}

/** 暴露当前路由，用于断言深入研究发起成功后的导航去向。 */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}</div>;
}

function acceptedWith(status: ResearchSelectionAccepted["task"]["status"]): ResearchSelectionAccepted {
  return {
    selection: makeSelection({ id: "selection-1" }),
    task: makeSelectionTask({ id: "selection-task-1", status }),
  };
}

describe("选区智能窗口", () => {
  it("原文立即可见，分析完成后逐字段呈现；详情按需展开", async () => {
    const createResearchSelection = vi.fn(
      async (_sessionId: string, _input: ResearchSelectionInput, _idempotencyKey: string) => acceptedWith("queued"),
    );
    const { streams } = renderPanel({ createResearchSelection });

    // 窗口打开时原文已经在，分析字段先显示骨架
    expect(await screen.findByText("一段选区文字")).toBeInTheDocument();
    expect(screen.queryByText(insight.summary)).not.toBeInTheDocument();
    expect(screen.getByText("正在分析，已保存的选区不会丢失。")).toBeInTheDocument();

    // 使用稳定幂等键创建选区
    expect(createResearchSelection).toHaveBeenCalledTimes(1);
    const [sessionId, input, key] = createResearchSelection.mock.calls[0];
    expect(sessionId).toBe("session-1");
    expect(input).toEqual({ anchor: makeCapture().anchor });
    expect(key).toBe(selectionIdempotencyKey(makeCapture().anchor!));
    // 幂等键会进入 HTTP 请求头：必须只含可打印 ASCII，且短于服务端 200 字符上限
    expect(key).toMatch(/^sel:[!-~]+$/);
    expect(key.length).toBeLessThanOrEqual(200);

    // 创建请求返回后连接事件流；分析完成事件到达后展示核心字段
    await waitFor(() => expect(streams).toHaveLength(1));
    const completed = makeSelectionTask({ id: "selection-task-1", status: "completed" });
    streams[0].emit({
      id: 1,
      type: "completed",
      task: completed,
      selection: makeSelection({ id: "selection-1", insight }),
      createdAt: "2026-07-20T08:03:00.000Z",
    });

    expect(await screen.findByText(insight.summary)).toBeInTheDocument();
    expect(screen.getByText("中")).toBeInTheDocument();
    expect(screen.getByText("约 2 分钟")).toBeInTheDocument();
    expect(screen.getByText("约 15 分钟")).toBeInTheDocument();
    expect(streams[0].closed).toBe(true);

    // 前置知识、关系、依据、来源位置默认收起，展开后可见
    expect(screen.queryByText("基础阅读能力")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "展开分析详情" }));
    expect(screen.getByText("基础阅读能力")).toBeInTheDocument();
    expect(screen.getByText("段落概念")).toBeInTheDocument();
    expect(screen.getByText(insight.relationToContent)).toBeInTheDocument();
    expect(screen.getByText(insight.rationale)).toBeInTheDocument();
    expect(screen.getByText("段落 1")).toBeInTheDocument();
  });

  it("节点页传入当前节点 id 时，创建选区携带该节点归属", async () => {
    const createResearchSelection = vi.fn(
      async (_sessionId: string, _input: ResearchSelectionInput, _idempotencyKey: string) => acceptedWith("queued"),
    );
    renderPanel({ createResearchSelection }, { nodeId: "node-child-1" });

    await waitFor(() => expect(createResearchSelection).toHaveBeenCalledTimes(1));
    const [sessionId, input] = createResearchSelection.mock.calls[0];
    expect(sessionId).toBe("session-1");
    expect(input).toEqual({ anchor: makeCapture().anchor, nodeId: "node-child-1" });
  });

  it("分析失败时保留原文并可重试，结束操作始终可用", async () => {
    const failedTask = makeSelectionTask({
      id: "selection-task-1",
      status: "failed",
      retryable: true,
      error: { code: "model_not_configured", message: "未配置可用的 AI 模型。选区已保存，配置模型后可以重试分析。" },
    });
    const createResearchSelection = vi.fn(async () => ({
      selection: makeSelection({ id: "selection-1" }),
      task: failedTask,
    }));
    const retryResearchSelectionTask = vi.fn(async () =>
      makeSelectionTask({ id: "selection-task-1", status: "queued" }),
    );
    const { streams } = renderPanel({ createResearchSelection, retryResearchSelectionTask });

    expect(await screen.findByText("选区已保存，分析暂时没有完成")).toBeInTheDocument();
    expect(screen.getByText("未配置可用的 AI 模型。选区已保存，配置模型后可以重试分析。")).toBeInTheDocument();
    expect(screen.getByText("一段选区文字")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "结束" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "重试分析" }));
    expect(retryResearchSelectionTask).toHaveBeenCalledWith("selection-task-1");

    // 重试后重新连接事件流，完成后展示分析
    await waitFor(() => expect(streams).toHaveLength(1));
    streams[0].emit({
      id: 2,
      type: "completed",
      task: makeSelectionTask({ id: "selection-task-1", status: "completed" }),
      selection: makeSelection({ id: "selection-1", insight }),
      createdAt: "2026-07-20T08:04:00.000Z",
    });
    expect(await screen.findByText(insight.summary)).toBeInTheDocument();
    expect(screen.queryByText("选区已保存，分析暂时没有完成")).not.toBeInTheDocument();
  });

  it("创建请求失败时给出可重试的提示，不打开空窗口", async () => {
    const createResearchSelection = vi.fn(
      async (_sessionId: string, _input: ResearchSelectionInput, _idempotencyKey: string): Promise<ResearchSelectionAccepted> => {
        throw new ApiRequestError(500, "internal_error", "boom");
      },
    );
    const { streams } = renderPanel({ createResearchSelection });

    expect(await screen.findByText("选区已保存，分析请求没有发出")).toBeInTheDocument();
    expect(streams).toHaveLength(0);

    createResearchSelection.mockResolvedValueOnce(acceptedWith("queued"));
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("正在分析，已保存的选区不会丢失。")).toBeInTheDocument();
    expect(streams).toHaveLength(1);
  });

  it("来源位置失效的选区保留原文并如实说明", async () => {
    const createResearchSelection = vi.fn(async () => ({
      selection: makeSelection({ id: "selection-1", status: "stale" }),
      task: makeSelectionTask({ id: "selection-task-1", status: "completed" }),
    }));
    renderPanel({ createResearchSelection });

    expect(await screen.findByText("原文位置已发生变化，原始文字已保留。")).toBeInTheDocument();
    expect(screen.getByText("一段选区文字")).toBeInTheDocument();
  });

  function growthAccepted(): NodeGrowthAccepted {
    return {
      node: makeNode({ id: "node-child-1", sessionId: "session-1", parentNodeId: "session-1", originSelectionId: "selection-1" }),
      session: makeSession({ id: "session-1" }),
      selection: makeSelection({ id: "selection-1" }),
      inputMessage: makeMessage({ id: "m-in", role: "user", content: "深入研究这段内容" }),
      outputMessage: makeMessage({ id: "m-out", role: "assistant", status: "pending" }),
      task: makeTask({ id: "task-1", status: "queued", inputMessageId: "m-in", outputMessageId: "m-out" }),
    };
  }

  it("开枝散叶：先保存再生成，导航到统一节点页，幂等键稳定且纯 ASCII", async () => {
    const user = userEvent.setup();
    const startChildNode = vi.fn(
      async (_selectionId: string, _input: CreateChildNodeInput, _key: string) => growthAccepted(),
    );
    renderPanel({ createResearchSelection: vi.fn(async () => acceptedWith("queued")), startChildNode });

    const openButton = await screen.findByRole("button", { name: "深入研究" });
    await user.click(openButton);

    expect(await screen.findByTestId("node-growth-panel")).toBeInTheDocument();
    expect(screen.getByText(/从这段选区长出一个新的研究节点/)).toBeInTheDocument();
    // 单一去向：不再有分支 / 独立会话二选一
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "开始研究" }));

    expect(startChildNode).toHaveBeenCalledTimes(1);
    const [selectionId, input, key] = startChildNode.mock.calls[0];
    expect(selectionId).toBe("selection-1");
    expect(input).toEqual({});
    expect(key).toMatch(/^ng:selection-1:auto$/);
    expect(key).toMatch(/^[!-~]+$/);
    expect(key.length).toBeLessThanOrEqual(200);

    expect(await screen.findByTestId("location-probe")).toHaveTextContent("/research/session-1/node/node-child-1");
  });

  it("开枝散叶可填写重点问题：query 进入请求并影响幂等键", async () => {
    const user = userEvent.setup();
    const startChildNode = vi.fn(
      async (_selectionId: string, _input: CreateChildNodeInput, _key: string) => growthAccepted(),
    );
    renderPanel({ createResearchSelection: vi.fn(async () => acceptedWith("queued")), startChildNode });

    await user.click(await screen.findByRole("button", { name: "深入研究" }));
    await user.type(screen.getByLabelText("你想重点问什么（可选）"), "把本地优先的边界讲透");
    await user.click(screen.getByRole("button", { name: "开始研究" }));

    const [, input, key] = startChildNode.mock.calls[0];
    expect(input).toEqual({ query: "把本地优先的边界讲透" });
    expect(key).toMatch(/^ng:selection-1:[!-~]+$/);
    expect(key).not.toBe("ng:selection-1:auto");
    expect(await screen.findByTestId("location-probe")).toHaveTextContent("/research/session-1/node/node-child-1");
  });

  it("分析失败时仍可以发起节点生长", async () => {
    const user = userEvent.setup();
    const startChildNode = vi.fn(
      async (_selectionId: string, _input: CreateChildNodeInput, _key: string) => growthAccepted(),
    );
    renderPanel({
      createResearchSelection: vi.fn(async () => acceptedWith("failed")),
      startChildNode,
    });

    const openButton = await screen.findByRole("button", { name: "深入研究" });
    expect(openButton).toBeEnabled();
    await user.click(openButton);
    await user.click(screen.getByRole("button", { name: "开始研究" }));

    expect(startChildNode).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("location-probe")).toHaveTextContent("/research/session-1/node/node-child-1");
  });

  it("发起失败时保留生长面板并给出错误，重试后成功导航", async () => {
    const user = userEvent.setup();
    const startChildNode = vi
      .fn<(selectionId: string, input: CreateChildNodeInput, idempotencyKey: string) => Promise<NodeGrowthAccepted>>()
      .mockRejectedValueOnce(new ApiRequestError(500, "internal_error", "boom"))
      .mockResolvedValueOnce(growthAccepted());
    renderPanel({ createResearchSelection: vi.fn(async () => acceptedWith("queued")), startChildNode });

    await user.click(await screen.findByRole("button", { name: "深入研究" }));
    await user.click(screen.getByRole("button", { name: "开始研究" }));

    expect(await screen.findByText("Collector 服务暂时出现错误，请稍后重试。")).toBeInTheDocument();
    expect(screen.getByTestId("node-growth-panel")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "开始研究" }));
    expect(await screen.findByTestId("location-probe")).toHaveTextContent("/research/session-1/node/node-child-1");
  });

  it("选区尚未保存完成时不能打开发起面板", async () => {
    renderPanel({ createResearchSelection: vi.fn(() => new Promise<ResearchSelectionAccepted>(() => {})) });
    const openButton = await screen.findByRole("button", { name: "深入研究" });
    expect(openButton).toBeDisabled();
  });

  it("同路由切换会话后不重新创建选区（旧锚点不属于新会话）", async () => {
    const createResearchSelection = vi.fn(
      async (_sessionId: string, _input: ResearchSelectionInput, _idempotencyKey: string) => acceptedWith("queued"),
    );
    const { services, rerender } = renderPanel({ createResearchSelection });
    expect(await screen.findByText("一段选区文字")).toBeInTheDocument();
    expect(createResearchSelection).toHaveBeenCalledTimes(1);

    // 模拟深入研究开启独立会话：同一组件实例收到新的 sessionId
    rerender(
      <ServicesProvider services={services}>
        <MemoryRouter initialEntries={["/research/session-1"]}>
          <SelectionInsightPanel sessionId="session-2" capture={makeCapture()} onClose={() => {}} />
          <LocationProbe />
        </MemoryRouter>
      </ServicesProvider>,
    );

    // 等待一轮副作用稳定，确认没有第二次创建请求
    await screen.findByText("一段选区文字");
    expect(createResearchSelection).toHaveBeenCalledTimes(1);
  });
});

describe("选区智能窗口 稍后再学", () => {
  function completedSelection() {
    return {
      selection: makeSelection({ id: "selection-1", insight }),
      task: makeSelectionTask({ id: "selection-task-1", status: "completed" }),
    };
  }

  it("预填确定性概括与默认三星，保存使用纯 ASCII 幂等键并通知栏目刷新", async () => {
    const user = userEvent.setup();
    const createResearchLaterItem = vi.fn(
      async (_input: ResearchLaterItemInput, _key: string) =>
        makeLaterItemView({ item: { ...makeLaterItemView().item, priority: 5 } }),
    );
    renderPanel({
      createResearchSelection: vi.fn(async () => completedSelection()),
      createResearchLaterItem,
    });

    const laterEvents: Event[] = [];
    const listener = (event: Event) => laterEvents.push(event);
    window.addEventListener(LATER_CHANGED_EVENT, listener);

    await user.click(await screen.findByRole("button", { name: "稍后再学" }));

    // 预填确定性默认概括（选区首句 / 前 80 字符），默认三星
    expect(await screen.findByTestId("later-form")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "优先级" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "3 星" })).toBeChecked();
    expect(screen.getByLabelText("概括")).toHaveValue("一段选区文字");

    // 调整为五星后保存
    await user.click(screen.getByRole("radio", { name: "5 星" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(createResearchLaterItem).toHaveBeenCalledTimes(1);
    const [input, key] = createResearchLaterItem.mock.calls[0];
    expect(input).toEqual({ selectionId: "selection-1", priority: 5, summary: "一段选区文字" });
    expect(key).toBe("later:selection-1");
    expect(key).toMatch(/^later:[!-~]+$/);
    expect(key.length).toBeLessThanOrEqual(200);

    // 成功确认态并通知右侧栏目刷新
    expect(await screen.findByTestId("later-saved")).toBeInTheDocument();
    await waitFor(() => expect(laterEvents.length).toBeGreaterThan(0));
    window.removeEventListener(LATER_CHANGED_EVENT, listener);
  });

  it("概括被清空时省略 summary 字段，交由后端套用确定性默认值", async () => {
    const user = userEvent.setup();
    const createResearchLaterItem = vi.fn(async (_input: ResearchLaterItemInput, _key: string) => makeLaterItemView());
    renderPanel({
      createResearchSelection: vi.fn(async () => completedSelection()),
      createResearchLaterItem,
    });

    await user.click(await screen.findByRole("button", { name: "稍后再学" }));
    const summaryInput = screen.getByLabelText("概括");
    await user.clear(summaryInput);
    await user.click(screen.getByRole("button", { name: "保存" }));

    const [input] = createResearchLaterItem.mock.calls[0];
    expect(input).toEqual({ selectionId: "selection-1", priority: 3 });
  });

  it("分析失败时仍可以保存稍后再学", async () => {
    const user = userEvent.setup();
    const createResearchLaterItem = vi.fn(async () => makeLaterItemView());
    renderPanel({
      createResearchSelection: vi.fn(async () => ({
        selection: makeSelection({ id: "selection-1" }),
        task: makeSelectionTask({ id: "selection-task-1", status: "failed", retryable: true }),
      })),
      createResearchLaterItem,
    });

    const laterButton = await screen.findByRole("button", { name: "稍后再学" });
    expect(laterButton).toBeEnabled();
    await user.click(laterButton);
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(createResearchLaterItem).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("later-saved")).toBeInTheDocument();
  });

  it("保存失败时保留表单并给出错误，重试后成功", async () => {
    const user = userEvent.setup();
    const createResearchLaterItem = vi
      .fn<() => Promise<ResearchLaterItemView>>()
      .mockRejectedValueOnce(new ApiRequestError(500, "internal_error", "boom"))
      .mockResolvedValueOnce(makeLaterItemView());
    renderPanel({
      createResearchSelection: vi.fn(async () => completedSelection()),
      createResearchLaterItem,
    });

    await user.click(await screen.findByRole("button", { name: "稍后再学" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("Collector 服务暂时出现错误，请稍后重试。")).toBeInTheDocument();
    expect(screen.getByTestId("later-form")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByTestId("later-saved")).toBeInTheDocument();
  });
});
