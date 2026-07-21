import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ResearchBranchView, ResearchTurnAccepted } from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { ApiRequestError } from "../../api/errors";
import type { TaskEventStream } from "../../api/task-events";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeBranchView, makeMessage, makeSelection, makeSession, makeTask } from "../../test/fakes";
import { ResearchBranchPage } from "./ResearchBranchPage";

function noopTaskEventStream(): TaskEventStream {
  return { close: () => {}, syncNow: () => {}, mode: "closed", lastEventId: 0 };
}

function renderBranchPage(api: Partial<ApiClient>) {
  const services = {
    api: api as ApiClient,
    connectTaskEvents: vi.fn(noopTaskEventStream),
  } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={["/research/session-1/branch/branch-1"]}>
        <Routes>
          <Route path="/research/:sessionId/branch/:branchId" element={<ResearchBranchPage />} />
        </Routes>
      </MemoryRouter>
    </ServicesProvider>,
  );
}

function readyBranchView(): ResearchBranchView {
  return makeBranchView({
    branch: {
      id: "branch-1",
      sessionId: "session-1",
      selectionId: "selection-1",
      status: "active",
      createdAt: "2026-07-21T08:00:00.000Z",
      updatedAt: "2026-07-21T08:00:00.000Z",
    },
    session: makeSession({ id: "session-1", title: "理解注意力机制" }),
    selection: makeSelection({ id: "selection-1", sessionId: "session-1", text: "不同头可以关注不同位置" }),
    messages: [
      makeMessage({ id: "m-in", sessionId: "session-1", branchId: "branch-1", role: "user", content: "把这段讲透" }),
      makeMessage({
        id: "m-out",
        sessionId: "session-1",
        branchId: "branch-1",
        role: "assistant",
        status: "completed",
        content: "多头注意力让每个位置看到不同信息。",
      }),
    ],
    tasks: [
      makeTask({ id: "task-1", sessionId: "session-1", status: "completed", inputMessageId: "m-in", outputMessageId: "m-out" }),
    ],
  });
}

describe("ResearchBranchPage", () => {
  it("呈现来源条、材料范围说明与分支消息，返回原文携带选区参数", async () => {
    renderBranchPage({ getResearchBranch: async () => readyBranchView() });

    const sourceBar = await screen.findByTestId("selection-source-bar");
    expect(sourceBar).toHaveTextContent("来自《理解注意力机制》的选区");
    expect(sourceBar).toHaveTextContent("不同头可以关注不同位置");
    expect(screen.getByRole("link", { name: "← 返回原文" })).toHaveAttribute(
      "href",
      "/research/session-1?sel=selection-1",
    );
    expect(screen.getByTestId("research-scope-note")).toHaveTextContent("未联网检索");

    expect(await screen.findByText("把这段讲透")).toBeInTheDocument();
    expect(screen.getByText("多头注意力让每个位置看到不同信息。")).toBeInTheDocument();
  });

  it("分支内继续追问使用稳定幂等键提交分支消息", async () => {
    const user = userEvent.setup();
    const submitBranchMessage = vi.fn(
      async (_branchId: string, _content: string, _idempotencyKey: string): Promise<ResearchTurnAccepted> => ({
        session: makeSession({ id: "session-1" }),
        inputMessage: makeMessage({ id: "m-in-2", role: "user", content: "继续追问" }),
        outputMessage: makeMessage({ id: "m-out-2", role: "assistant", status: "pending" }),
        task: makeTask({ id: "task-2", status: "queued", inputMessageId: "m-in-2", outputMessageId: "m-out-2" }),
      }),
    );
    renderBranchPage({ getResearchBranch: async () => readyBranchView(), submitBranchMessage });

    const composer = await screen.findByLabelText("你的问题");
    await user.type(composer, "继续追问");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(submitBranchMessage).toHaveBeenCalledTimes(1));
    const [branchId, content, key] = submitBranchMessage.mock.calls[0];
    expect(branchId).toBe("branch-1");
    expect(content).toBe("继续追问");
    expect(key).toMatch(/^[!-~]+$/);
    expect(key.length).toBeLessThanOrEqual(200);
    // 追问保存后出现在分支消息列表
    expect(await screen.findByText("继续追问", { selector: ".message__content" })).toBeInTheDocument();
  });

  it("分支不存在显示 404 文案并可返回研究", async () => {
    renderBranchPage({
      getResearchBranch: async () => {
        throw new ApiRequestError(404, "not_found", "not found");
      },
    });
    expect(await screen.findByRole("heading", { name: "这个研究分支不存在或已经清理" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回研究" })).toHaveAttribute("href", "/research/session-1");
  });

  it("路由会话编号与分支所属会话不一致时按不存在处理", async () => {
    const mismatched = readyBranchView();
    mismatched.branch = { ...mismatched.branch, sessionId: "other-session" };
    renderBranchPage({ getResearchBranch: async () => mismatched });
    expect(await screen.findByRole("heading", { name: "这个研究分支不存在或已经清理" })).toBeInTheDocument();
  });

  it("500 错误可重试", async () => {
    const user = userEvent.setup();
    const getResearchBranch = vi
      .fn<() => Promise<ResearchBranchView>>()
      .mockRejectedValueOnce(new ApiRequestError(500, "internal_error", "boom"))
      .mockResolvedValueOnce(readyBranchView());
    renderBranchPage({ getResearchBranch });

    expect(await screen.findByRole("heading", { name: "暂时无法打开这个研究分支" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByTestId("selection-source-bar")).toBeInTheDocument();
    expect(getResearchBranch).toHaveBeenCalledTimes(2);
  });
});
