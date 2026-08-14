import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchNodeView, ResearchSessionView } from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { ApiRequestError, NetworkError } from "../../api/errors";
import { connectImportEvents } from "../../api/import-events";
import type { ImportEventStreamOptions } from "../../api/import-events";
import type { TaskEventStream } from "../../api/task-events";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { FakeEventSource, makeAttachment, makeImportTask, makeMessage, makeNode, makeSession, makeTask } from "../../test/fakes";
import { ReadingPage } from "./ReadingPage";
import { ResearchNodePage } from "../research-session/ResearchNodePage";

function noopTaskEventStream(): TaskEventStream {
  return { close: () => {}, syncNow: () => {}, mode: "closed", lastEventId: 0 };
}

function SessionRoutes() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate("/nodes/session-2")}>
        切换会话
      </button>
      <Routes>
        <Route path="/nodes/:nodeId" element={<ResearchNodePage />} />
        <Route path="/research/:sessionId/reading/:contentSnapshotId" element={<ReadingPage />} />
      </Routes>
    </>
  );
}

function renderSessionPage(api: Partial<ApiClient>) {
  const services = {
    api: api as ApiClient,
    connectTaskEvents: vi.fn(noopTaskEventStream),
    connectImportEvents: (options: ImportEventStreamOptions) =>
      connectImportEvents({ ...options, createEventSource: (url: string) => new FakeEventSource(url) }),
  } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={["/nodes/session-1"]}>
        <SessionRoutes />
      </MemoryRouter>
    </ServicesProvider>,
  );
}

function emptyView(): ResearchSessionView {
  return {
    session: makeSession({ id: "session-1", title: "本地研究" }),
    messages: [makeMessage({ id: "m-1", role: "user", content: "已保存的问题" })],
    tasks: [makeTask({ id: "task-1", status: "completed", inputMessageId: "m-1", outputMessageId: "m-2" })],
    attachments: [],
    importTasks: [],
  };
}

/** 会话视图 → 根节点视图：页面初始加载走节点端点，导入对齐仍走会话端点。 */
function nodeViewOf(view: ResearchSessionView): ResearchNodeView {
  return {
    node: makeNode({ id: view.session.id, sessionId: view.session.id }),
    ...view,
  };
}

function baseApi(overrides: Partial<ApiClient>): Partial<ApiClient> {
  return {
    getResearchNodeView: vi.fn(async (nodeId: string) =>
      nodeViewOf({ ...emptyView(), session: makeSession({ id: nodeId, title: "本地研究" }) }),
    ),
    getResearchSessionView: vi.fn(async () => emptyView()),
    getResearchImportTask: vi.fn(async () => makeImportTask({ id: "import-task-1", status: "completed" })),
    ...overrides,
  };
}

async function selectFile(container: HTMLElement, file: File) {
  await waitFor(() => expect(container.querySelector('input[type="file"]')).not.toBeNull());
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [file] } });
}

const createdAt = "2026-07-19T09:00:00.000Z";

describe("研究文件导入", () => {
  beforeEach(() => {
    FakeEventSource.reset();
  });

  it("真实上传后显示进度，完成后以稳定快照进入同一画布阅读视图", async () => {
    const user = userEvent.setup();
    const attachment = makeAttachment({ id: "att-1", fileName: "笔记.txt", importTaskId: "import-task-1" });
    const queuedTask = makeImportTask({ id: "import-task-1", attachmentId: "att-1", status: "queued" });
    const readyAttachment = { ...attachment, status: "ready" as const, contentSnapshotId: "snap-1" };
    const completedTask = makeImportTask({ id: "import-task-1", attachmentId: "att-1", status: "completed" });
    const createResearchImport = vi.fn<ApiClient["createResearchImport"]>(async () => ({ attachment, task: queuedTask }));
    const getResearchSessionView = vi.fn(async () => ({
      ...emptyView(),
      attachments: [readyAttachment],
      importTasks: [completedTask],
    }));
    const getResearchContent = vi.fn(async () => ({
      id: "snap-1",
      sessionId: "session-1",
      attachmentId: "att-1",
      mimeType: "text/plain" as const,
      title: "笔记.txt",
      blocks: [
        { id: "b-1", ordinal: 0, text: "第一行内容", anchor: { kind: "text" as const, startLine: 1, endLine: 1, exact: "第一行内容" } },
      ],
      createdAt,
    }));
    const { container } = renderSessionPage(
      baseApi({ createResearchImport, getResearchSessionView, getResearchContent }),
    );

    // 上传：原始 File body、编码文件名、浏览器 MIME、会话内幂等键
    const file = new File(["第一行内容"], "笔记.txt", { type: "text/plain" });
    await selectFile(container, file);
    await waitFor(() => expect(createResearchImport).toHaveBeenCalledTimes(1));
    const [sessionArg, fileArg, nameArg, mimeArg, keyArg] = createResearchImport.mock.calls[0];
    expect(sessionArg).toBe("session-1");
    expect(fileArg).toBe(file);
    expect(nameArg).toBe("笔记.txt");
    expect(mimeArg).toBe("text/plain");
    expect(typeof keyArg).toBe("string");

    // 附件立即出现在列表中并建立导入 SSE 连接
    expect(await screen.findByText("笔记.txt")).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0].url).toContain("/v1/research-imports/import-task-1/events");

    // 进度事件进入视图
    const source = FakeEventSource.instances[0];
    act(() => {
      source.emit("progress", {
        id: 1,
        type: "progress",
        task: { ...queuedTask, status: "running", progress: { phase: "parsing", completedUnits: 1, totalUnits: 2 } },
        attachment,
        createdAt,
      });
    });
    expect(await screen.findByText(/正在解析 1\/2/)).toBeInTheDocument();

    // 完成事件 → 终态确认 → 对齐完整视图 → 出现阅读入口
    act(() => {
      source.emit("completed", { id: 2, type: "completed", task: completedTask, attachment: readyAttachment, createdAt });
    });
    const readButton = await screen.findByRole("button", { name: "阅读" });
    expect(screen.getByText("已导入")).toBeInTheDocument();

    // 同一研究画布内打开阅读视图
    await user.click(readButton);
    expect(await screen.findByRole("heading", { name: "笔记.txt" })).toBeInTheDocument();
    expect(getResearchContent).toHaveBeenCalledWith("snap-1");
    expect(screen.getByText("第 1 行")).toBeInTheDocument();
    expect(screen.getByText("第一行内容")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回研究会话" })).toHaveAttribute("href", "/nodes/session-1");
  });

  it("切换会话后忽略旧会话延迟返回的上传结果", async () => {
    const user = userEvent.setup();
    let resolveUpload!: (value: Awaited<ReturnType<ApiClient["createResearchImport"]>>) => void;
    const createResearchImport = vi.fn<ApiClient["createResearchImport"]>(
      () => new Promise((resolve) => {
        resolveUpload = resolve;
      }),
    );
    const viewFor = (sessionId: string) => ({
      ...emptyView(),
      session: makeSession({ id: sessionId, title: sessionId === "session-1" ? "会话一" : "会话二" }),
    });
    const getResearchNodeView = vi.fn(async (nodeId: string) => nodeViewOf(viewFor(nodeId)));
    const getResearchSessionView = vi.fn(async (sessionId: string) => viewFor(sessionId));
    const { container } = renderSessionPage(baseApi({ createResearchImport, getResearchNodeView, getResearchSessionView }));

    await screen.findByRole("heading", { name: "会话一" });
    await selectFile(container, new File(["内容"], "旧会话.txt", { type: "text/plain" }));
    await waitFor(() => expect(createResearchImport).toHaveBeenCalledWith(
      "session-1",
      expect.any(File),
      "旧会话.txt",
      "text/plain",
      expect.any(String),
    ));

    await user.click(screen.getByRole("button", { name: "切换会话" }));
    await screen.findByRole("heading", { name: "会话二" });
    resolveUpload({
      attachment: makeAttachment({ id: "att-old", sessionId: "session-1", fileName: "旧会话.txt", importTaskId: "task-old" }),
      task: makeImportTask({ id: "task-old", sessionId: "session-1", attachmentId: "att-old", status: "queued" }),
    });

    await waitFor(() => expect(createResearchImport).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("旧会话.txt")).not.toBeInTheDocument();
  });

  it("切换会话后不保留旧会话的待重试上传", async () => {
    const user = userEvent.setup();
    let resolveRecovery!: (view: ResearchSessionView) => void;
    // 页面初始加载走节点端点；会话端点只在失败上传后的对齐时调用，返回挂起承诺模拟慢响应
    const getResearchSessionView = vi.fn(async (sessionId: string) => {
      if (sessionId === "session-2") {
        return { ...emptyView(), session: makeSession({ id: "session-2", title: "会话二" }) };
      }
      return new Promise<ResearchSessionView>((resolve) => {
        resolveRecovery = resolve;
      });
    });
    const getResearchNodeView = vi.fn(async (nodeId: string) =>
      nodeViewOf({ ...emptyView(), session: makeSession({ id: nodeId, title: nodeId === "session-1" ? "会话一" : "会话二" }) }),
    );
    const createResearchImport = vi.fn(async () => {
      throw new NetworkError();
    });
    const { container } = renderSessionPage(baseApi({ createResearchImport, getResearchNodeView, getResearchSessionView }));

    await screen.findByRole("heading", { name: "会话一" });
    await selectFile(container, new File(["内容"], "断线旧会话.txt", { type: "text/plain" }));
    await waitFor(() => expect(getResearchSessionView).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "切换会话" }));
    await screen.findByRole("heading", { name: "会话二" });
    resolveRecovery({ ...emptyView(), session: makeSession({ id: "session-1", title: "会话一" }) });
    await act(async () => {});

    expect(screen.queryByRole("button", { name: "重试上传" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "会话二" })).toBeInTheDocument();
  });

  it("前端白名单与大小预检拒绝时不发起请求", async () => {
    const createResearchImport = vi.fn();
    const { container } = renderSessionPage(baseApi({ createResearchImport }));

    await selectFile(container, new File(["x"], "程序.exe", { type: "application/x-msdownload" }));
    expect(await screen.findByText(/仅支持 TXT、Markdown、DOCX、PDF/)).toBeInTheDocument();

    const oversized = new File(["x"], "大.pdf", { type: "application/pdf" });
    Object.defineProperty(oversized, "size", { value: 21 * 1024 * 1024 });
    await selectFile(container, oversized);
    expect(await screen.findByText(/超过 20 MB 上限/)).toBeInTheDocument();
    expect(createResearchImport).not.toHaveBeenCalled();
  });

  it("进行中的导入可以取消", async () => {
    const user = userEvent.setup();
    const runningTask = makeImportTask({
      id: "import-task-1",
      attachmentId: "att-1",
      status: "running",
      progress: { phase: "parsing", completedUnits: 1, totalUnits: 3 },
    });
    const view: ResearchSessionView = {
      ...emptyView(),
      attachments: [makeAttachment({ id: "att-1", fileName: "长文.md", mimeType: "text/markdown", importTaskId: "import-task-1" })],
      importTasks: [runningTask],
    };
    const cancelResearchImport = vi.fn(async () => makeImportTask({ id: "import-task-1", attachmentId: "att-1", status: "cancelled" }));
    renderSessionPage(baseApi({
      getResearchNodeView: vi.fn(async () => nodeViewOf(view)),
      getResearchSessionView: vi.fn(async () => view),
      cancelResearchImport,
    }));

    await user.click(await screen.findByRole("button", { name: "取消" }));
    await waitFor(() => expect(cancelResearchImport).toHaveBeenCalledWith("import-task-1"));
    expect(await screen.findByText("已取消")).toBeInTheDocument();
  });

  it("切换会话后忽略旧会话延迟返回的取消结果", async () => {
    const user = userEvent.setup();
    let resolveCancel!: (task: Awaited<ReturnType<ApiClient["cancelResearchImport"]>>) => void;
    const viewFor = (sessionId: string): ResearchSessionView =>
      sessionId === "session-1"
        ? {
            ...emptyView(),
            session: makeSession({ id: "session-1", title: "会话一" }),
            attachments: [makeAttachment({ id: "att-1", sessionId: "session-1", fileName: "处理中.txt", importTaskId: "import-task-1" })],
            importTasks: [makeImportTask({ id: "import-task-1", sessionId: "session-1", attachmentId: "att-1", status: "running" })],
          }
        : { ...emptyView(), session: makeSession({ id: "session-2", title: "会话二" }) };
    const getResearchNodeView = vi.fn(async (nodeId: string) => nodeViewOf(viewFor(nodeId)));
    const getResearchSessionView = vi.fn(async (sessionId: string) => viewFor(sessionId));
    const cancelResearchImport = vi.fn<ApiClient["cancelResearchImport"]>(
      () => new Promise((resolve) => {
        resolveCancel = resolve;
      }),
    );
    renderSessionPage(baseApi({ getResearchNodeView, getResearchSessionView, cancelResearchImport }));

    await user.click(await screen.findByRole("button", { name: "取消" }));
    await waitFor(() => expect(cancelResearchImport).toHaveBeenCalledWith("import-task-1"));
    await user.click(screen.getByRole("button", { name: "切换会话" }));
    await screen.findByRole("heading", { name: "会话二" });

    resolveCancel(makeImportTask({ id: "import-task-1", sessionId: "session-1", attachmentId: "att-1", status: "cancelled" }));
    await act(async () => {});

    expect(screen.queryByText("已取消")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "会话二" })).toBeInTheDocument();
  });

  it("切换会话后忽略旧会话延迟返回的重试结果", async () => {
    const user = userEvent.setup();
    let resolveRetry!: (task: Awaited<ReturnType<ApiClient["retryResearchImport"]>>) => void;
    const viewFor = (sessionId: string): ResearchSessionView =>
      sessionId === "session-1"
        ? {
            ...emptyView(),
            session: makeSession({ id: "session-1", title: "会话一" }),
            attachments: [makeAttachment({ id: "att-1", sessionId: "session-1", fileName: "失败.txt", importTaskId: "import-task-1", status: "failed" })],
            importTasks: [makeImportTask({ id: "import-task-1", sessionId: "session-1", attachmentId: "att-1", status: "failed", retryable: true })],
          }
        : { ...emptyView(), session: makeSession({ id: "session-2", title: "会话二" }) };
    const getResearchNodeView = vi.fn(async (nodeId: string) => nodeViewOf(viewFor(nodeId)));
    const getResearchSessionView = vi.fn(async (sessionId: string) => viewFor(sessionId));
    const retryResearchImport = vi.fn<ApiClient["retryResearchImport"]>(
      () => new Promise((resolve) => {
        resolveRetry = resolve;
      }),
    );
    renderSessionPage(baseApi({ getResearchNodeView, getResearchSessionView, retryResearchImport }));

    await user.click(await screen.findByRole("button", { name: "重试" }));
    await waitFor(() => expect(retryResearchImport).toHaveBeenCalledWith("import-task-1"));
    await user.click(screen.getByRole("button", { name: "切换会话" }));
    await screen.findByRole("heading", { name: "会话二" });

    resolveRetry(makeImportTask({ id: "import-task-1", sessionId: "session-1", attachmentId: "att-1", status: "queued" }));
    await act(async () => {});

    expect(screen.queryByText("排队中")).not.toBeInTheDocument();
    expect(screen.queryByText("失败.txt")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "会话二" })).toBeInTheDocument();
  });

  it("失败任务显示稳定原因并可重试，重试后重新排队", async () => {
    const user = userEvent.setup();
    const failedTask = makeImportTask({
      id: "import-task-1",
      attachmentId: "att-1",
      status: "failed",
      retryable: true,
      error: { code: "parse_failed", message: "parse failed" },
    });
    const view: ResearchSessionView = {
      ...emptyView(),
      attachments: [makeAttachment({ id: "att-1", fileName: "损坏.docx", importTaskId: "import-task-1", status: "failed" })],
      importTasks: [failedTask],
    };
    const retryResearchImport = vi.fn(async () => makeImportTask({ id: "import-task-1", attachmentId: "att-1", status: "queued" }));
    renderSessionPage(baseApi({
      getResearchNodeView: vi.fn(async () => nodeViewOf(view)),
      getResearchSessionView: vi.fn(async () => view),
      retryResearchImport,
    }));

    expect(await screen.findByText(/无法解析这个文件/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(retryResearchImport).toHaveBeenCalledWith("import-task-1"));
    expect(await screen.findByText("排队中")).toBeInTheDocument();
    // 重试后任务回到 queued，事件连接重新接管
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
  });

  it("上传网络中断且服务端未受理：保留同一文件与同一幂等键重试", async () => {
    const user = userEvent.setup();
    const attachment = makeAttachment({ id: "att-1", fileName: "断线.txt", importTaskId: "import-task-1" });
    const queuedTask = makeImportTask({ id: "import-task-1", attachmentId: "att-1", status: "queued" });
    const createResearchImport = vi
      .fn()
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValueOnce({ attachment, task: queuedTask });
    const { container } = renderSessionPage(baseApi({ createResearchImport }));

    await selectFile(container, new File(["内容"], "断线.txt", { type: "text/plain" }));
    await user.click(await screen.findByRole("button", { name: "重试上传" }));

    await waitFor(() => expect(createResearchImport).toHaveBeenCalledTimes(2));
    expect(createResearchImport.mock.calls[0][4]).toBe(createResearchImport.mock.calls[1][4]);
    expect(await screen.findByText("断线.txt")).toBeInTheDocument();
    expect(screen.queryByText(/上传结果不确定/)).not.toBeInTheDocument();
  });

  it("上传网络中断但服务端已受理：按幂等键恢复，不保留伪记录", async () => {
    let usedKey = "";
    const attachment = makeAttachment({ id: "att-1", fileName: "已受理.txt", importTaskId: "import-task-1" });
    const queuedTask = makeImportTask({ id: "import-task-1", attachmentId: "att-1", status: "queued" });
    const createResearchImport = vi.fn((...args: unknown[]) => {
      usedKey = args[4] as string;
      return Promise.reject(new NetworkError());
    });
    const getResearchSessionView = vi.fn(async () => ({
      ...emptyView(),
      attachments: [attachment],
      importTasks: [{ ...queuedTask, idempotencyKey: usedKey }],
    }));
    const { container } = renderSessionPage(baseApi({ createResearchImport, getResearchSessionView }));

    await selectFile(container, new File(["内容"], "已受理.txt", { type: "text/plain" }));
    // 服务端视图已包含该附件与任务，直接恢复展示，不出现“重试上传”
    expect(await screen.findByText("已受理.txt")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试上传" })).not.toBeInTheDocument();
    expect(createResearchImport).toHaveBeenCalledTimes(1);
  });

  it("同键冲突返回 409 时刷新服务端状态并提示，不创建前端伪记录", async () => {
    const createResearchImport = vi.fn(async () => {
      throw new ApiRequestError(409, "idempotency_conflict", "conflict");
    });
    const getResearchSessionView = vi.fn(async () => emptyView());
    const { container } = renderSessionPage(baseApi({ createResearchImport, getResearchSessionView }));

    await selectFile(container, new File(["内容"], "冲突.txt", { type: "text/plain" }));
    expect(await screen.findByText(/与已有记录冲突/)).toBeInTheDocument();
    // 页面初始加载走节点端点；会话端点只在冲突后对齐时调用一次
    await waitFor(() => expect(getResearchSessionView).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("冲突.txt")).not.toBeInTheDocument();
  });

  it("拖放文件到页面触发同一真实上传", async () => {
    const attachment = makeAttachment({ id: "att-1", fileName: "拖放.txt", importTaskId: "import-task-1" });
    const queuedTask = makeImportTask({ id: "import-task-1", attachmentId: "att-1", status: "queued" });
    const createResearchImport = vi.fn(async () => ({ attachment, task: queuedTask }));
    const { container } = renderSessionPage(baseApi({ createResearchImport }));

    // 等待会话就绪（拖放处理器只在 ready 视图挂载）
    await waitFor(() => expect(container.querySelector('input[type="file"]')).not.toBeNull());
    const page = container.querySelector(".page");
    expect(page).not.toBeNull();
    const file = new File(["拖放内容"], "拖放.txt", { type: "text/plain" });
    const dataTransfer = { types: ["Files"], files: [file] };
    fireEvent.dragEnter(page!, { dataTransfer });
    expect(screen.getByText("松开鼠标，把文件导入这场研究")).toBeInTheDocument();
    fireEvent.drop(page!, { dataTransfer });

    await waitFor(() => expect(createResearchImport).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("拖放.txt")).toBeInTheDocument();
  });

  it("刷新恢复：已完成附件直接显示已导入与阅读入口，不建立事件连接", async () => {
    const view: ResearchSessionView = {
      ...emptyView(),
      attachments: [
        makeAttachment({ id: "att-1", fileName: "已完成.pdf", mimeType: "application/pdf", status: "ready", importTaskId: "import-task-1", contentSnapshotId: "snap-1" }),
      ],
      importTasks: [makeImportTask({ id: "import-task-1", attachmentId: "att-1", status: "completed" })],
    };
    renderSessionPage(baseApi({
      getResearchNodeView: vi.fn(async () => nodeViewOf(view)),
      getResearchSessionView: vi.fn(async () => view),
    }));

    expect(await screen.findByText("已完成.pdf")).toBeInTheDocument();
    expect(screen.getByText("已导入")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "阅读" })).toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
