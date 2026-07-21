import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type {
  DeepResearchAccepted,
  DeepResearchInput,
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
import { makeMessage, makeSelection, makeSelectionTask, makeSession, makeTask } from "../../test/fakes";
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

function renderPanel(api: Partial<ApiClient>) {
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
        <SelectionInsightPanel sessionId="session-1" capture={makeCapture()} onClose={() => {}} />
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

  function deepAccepted(mode: DeepResearchAccepted["mode"]): DeepResearchAccepted {
    return {
      mode,
      session: makeSession({ id: mode === "branch" ? "session-1" : "session-2" }),
      ...(mode === "branch"
        ? { branch: { id: "branch-1", sessionId: "session-1", selectionId: "selection-1", status: "active" as const, createdAt: "2026-07-21T08:00:00.000Z", updatedAt: "2026-07-21T08:00:00.000Z" } }
        : {}),
      selection: makeSelection({ id: "selection-1" }),
      inputMessage: makeMessage({ id: "m-in", role: "user", content: "深入研究这段内容" }),
      outputMessage: makeMessage({ id: "m-out", role: "assistant", status: "pending" }),
      task: makeTask({ id: "task-1", status: "queued", inputMessageId: "m-in", outputMessageId: "m-out" }),
    };
  }

  it("深入研究默认分支去向：先保存再生成，导航到分支视图，幂等键稳定且纯 ASCII", async () => {
    const user = userEvent.setup();
    const startDeepResearch = vi.fn(
      async (_selectionId: string, _input: DeepResearchInput, _key: string) => deepAccepted("branch"),
    );
    renderPanel({ createResearchSelection: vi.fn(async () => acceptedWith("queued")), startDeepResearch });

    const openButton = await screen.findByRole("button", { name: "深入研究" });
    await user.click(openButton);

    expect(await screen.findByTestId("deep-research-chooser")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "深入研究去向" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /沿当前内容建立研究分支/ })).toBeChecked();
    // 分支去向不显示方向输入框
    expect(screen.queryByLabelText("研究方向（可选）")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "开始深入研究" }));

    expect(startDeepResearch).toHaveBeenCalledTimes(1);
    const [selectionId, input, key] = startDeepResearch.mock.calls[0];
    expect(selectionId).toBe("selection-1");
    expect(input).toEqual({ mode: "branch" });
    expect(key).toMatch(/^dr:selection-1:branch:auto$/);
    expect(key).toMatch(/^dr:[!-~]+$/);
    expect(key.length).toBeLessThanOrEqual(200);

    expect(await screen.findByTestId("location-probe")).toHaveTextContent("/research/session-1/branch/branch-1");
  });

  it("独立会话去向提供方向输入框：方向进入请求并导航到新会话", async () => {
    const user = userEvent.setup();
    const startDeepResearch = vi.fn(
      async (_selectionId: string, _input: DeepResearchInput, _key: string) => deepAccepted("session"),
    );
    renderPanel({ createResearchSelection: vi.fn(async () => acceptedWith("queued")), startDeepResearch });

    await user.click(await screen.findByRole("button", { name: "深入研究" }));
    await user.click(screen.getByRole("radio", { name: /以选区开启独立研究会话/ }));

    const directionInput = screen.getByLabelText("研究方向（可选）");
    await user.type(directionInput, "把本地优先的边界讲透");
    await user.click(screen.getByRole("button", { name: "开始深入研究" }));

    const [, input, key] = startDeepResearch.mock.calls[0];
    expect(input).toEqual({ mode: "session", direction: "把本地优先的边界讲透" });
    expect(key).toMatch(/^dr:selection-1:session:[!-~]+$/);
    expect(await screen.findByTestId("location-probe")).toHaveTextContent("/research/session-2");
  });

  it("分析失败时仍可以发起深入研究", async () => {
    const user = userEvent.setup();
    const startDeepResearch = vi.fn(
      async (_selectionId: string, _input: DeepResearchInput, _key: string) => deepAccepted("branch"),
    );
    renderPanel({
      createResearchSelection: vi.fn(async () => acceptedWith("failed")),
      startDeepResearch,
    });

    const openButton = await screen.findByRole("button", { name: "深入研究" });
    expect(openButton).toBeEnabled();
    await user.click(openButton);
    await user.click(screen.getByRole("button", { name: "开始深入研究" }));

    expect(startDeepResearch).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("location-probe")).toHaveTextContent("/research/session-1/branch/branch-1");
  });

  it("发起失败时保留去向选择并给出错误，重试后成功导航", async () => {
    const user = userEvent.setup();
    const startDeepResearch = vi
      .fn<(selectionId: string, input: DeepResearchInput, idempotencyKey: string) => Promise<DeepResearchAccepted>>()
      .mockRejectedValueOnce(new ApiRequestError(500, "internal_error", "boom"))
      .mockResolvedValueOnce(deepAccepted("branch"));
    renderPanel({ createResearchSelection: vi.fn(async () => acceptedWith("queued")), startDeepResearch });

    await user.click(await screen.findByRole("button", { name: "深入研究" }));
    await user.click(screen.getByRole("button", { name: "开始深入研究" }));

    expect(await screen.findByText("Collector 服务暂时出现错误，请稍后重试。")).toBeInTheDocument();
    expect(screen.getByTestId("deep-research-chooser")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /沿当前内容建立研究分支/ })).toBeChecked();

    await user.click(screen.getByRole("button", { name: "开始深入研究" }));
    expect(await screen.findByTestId("location-probe")).toHaveTextContent("/research/session-1/branch/branch-1");
  });

  it("选区尚未保存完成时不能打开去向选择", async () => {
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
