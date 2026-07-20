import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
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
import { makeSelection, makeSelectionTask } from "../../test/fakes";
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
      <SelectionInsightPanel sessionId="session-1" capture={makeCapture()} onClose={() => {}} />
    </ServicesProvider>,
  );
  return { ...view, streams, connectSelectionEvents };
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
});
