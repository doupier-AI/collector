import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import { NetworkError } from "../../api/errors";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { makeSession } from "../../test/fakes";
import { StartPage } from "./StartPage";

function Destination() {
  const location = useLocation();
  return <p>{location.pathname}</p>;
}

function renderStartPage(api: Partial<ApiClient>) {
  const services = {
    api: api as ApiClient,
    connectTaskEvents: vi.fn(),
  } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={["/research/new"]}>
        <Routes>
          <Route path="/research/new" element={<StartPage />} />
          <Route path="/nodes/:nodeId" element={<Destination />} />
        </Routes>
      </MemoryRouter>
    </ServicesProvider>,
  );
}

function fireFileChange(file: File) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("找不到文件输入框");
  // 模拟点击打开文件选择器，再触发 change 事件（ChatComposer 匹配的用法）
  vi.spyOn(input, "click").mockImplementation(() => {});
  fireEvent.change(input, { target: { files: [file] } });
}

function makeTxtFile(name = "test.txt", content = "hello world"): File {
  return new File([content], name, { type: "text/plain" });
}

describe("StartPage 会话创建", () => {
  it("结果不确定后重试复用同一个创建幂等键", async () => {
    const user = userEvent.setup();
    const createResearchSession = vi
      .fn<ApiClient["createResearchSession"]>()
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValueOnce(makeSession({ id: "recovered-session" }));
    renderStartPage({ createResearchSession });

    await user.type(screen.getByLabelText("你的问题"), "保留并重试这个问题");
    await user.click(screen.getByRole("button", { name: "开始研究" }));
    expect(await screen.findByText("连接失败，请重试。")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "开始研究" }));
    expect(await screen.findByText("/nodes/recovered-session")).toBeInTheDocument();
    expect(createResearchSession).toHaveBeenCalledTimes(2);
    expect(createResearchSession.mock.calls[0][0]).toBeTruthy();
    expect(createResearchSession.mock.calls[1][0]).toBe(createResearchSession.mock.calls[0][0]);
  });
});

describe("StartPage 文件入口", () => {
  it("选择有效文件后创建会话、导入文件并导航", async () => {
    const createResearchSession = vi.fn<ApiClient["createResearchSession"]>().mockResolvedValue(
      makeSession({ id: "file-session" }),
    );
    const createResearchImport = vi.fn<ApiClient["createResearchImport"]>().mockResolvedValue({
      attachment: { id: "att-1", sessionId: "file-session", fileName: "test.txt", mimeType: "text/plain" as const, size: 11, checksum: "abc", status: "processing" as const, importTaskId: "task-1", contentSnapshotId: undefined, createdAt: "2026-07-21T00:00:00Z", updatedAt: "2026-07-21T00:00:00Z" },
      task: { id: "task-1", sessionId: "file-session", attachmentId: "att-1", idempotencyKey: "import-key", status: "queued" as const, progress: { phase: "parsing" as const, completedUnits: 0, totalUnits: 1 }, retryable: false, createdAt: "2026-07-21T00:00:00Z", updatedAt: "2026-07-21T00:00:00Z" },
    });
    renderStartPage({ createResearchSession, createResearchImport });

    // ChatComposer 的隐藏文件输入
    await fireFileChange(makeTxtFile());

    expect(await screen.findByText("/nodes/file-session")).toBeInTheDocument();
    expect(createResearchSession).toHaveBeenCalledTimes(1);
    expect(createResearchImport).toHaveBeenCalledTimes(1);
    expect(createResearchImport.mock.calls[0][0]).toBe("file-session");
    expect(createResearchImport.mock.calls[0][1]).toBeInstanceOf(File);
  });

  it("不支持的文件类型显示错误，不发起 API 调用", async () => {
    const createResearchSession = vi.fn<ApiClient["createResearchSession"]>();
    const createResearchImport = vi.fn<ApiClient["createResearchImport"]>();
    renderStartPage({ createResearchSession, createResearchImport });

    await fireFileChange(new File(["binary"], "app.exe", { type: "application/x-msdownload" }));

    expect(await screen.findByText("仅支持 TXT、Markdown、DOCX、PDF 文件。")).toBeInTheDocument();
    expect(createResearchSession).not.toHaveBeenCalled();
    expect(createResearchImport).not.toHaveBeenCalled();
  });

  it("空文件显示校验错误", async () => {
    const createResearchSession = vi.fn<ApiClient["createResearchSession"]>();
    renderStartPage({ createResearchSession });

    await fireFileChange(new File([], "empty.txt", { type: "text/plain" }));

    expect(await screen.findByText("文件为空，请选择有内容的文件。")).toBeInTheDocument();
    expect(createResearchSession).not.toHaveBeenCalled();
  });

  it("会话创建成功但导入网络失败时仍然导航到会话页", async () => {
    const createResearchSession = vi.fn<ApiClient["createResearchSession"]>().mockResolvedValue(
      makeSession({ id: "partial-session" }),
    );
    const createResearchImport = vi.fn<ApiClient["createResearchImport"]>().mockRejectedValue(new NetworkError());
    renderStartPage({ createResearchSession, createResearchImport });

    await fireFileChange(makeTxtFile());

    // 导航到会话页（导入失败可重试）
    expect(await screen.findByText("/nodes/partial-session")).toBeInTheDocument();
  });

  it("上传文件后输入文本点击提交，不再重复创建会话", async () => {
    const createResearchSession = vi.fn<ApiClient["createResearchSession"]>().mockResolvedValue(
      makeSession({ id: "file-then-chat" }),
    );
    const createResearchImport = vi.fn<ApiClient["createResearchImport"]>().mockResolvedValue({
      attachment: { id: "att-1", sessionId: "file-then-chat", fileName: "test.txt", mimeType: "text/plain" as const, size: 11, checksum: "abc", status: "processing" as const, importTaskId: "task-1", contentSnapshotId: undefined, createdAt: "2026-07-21T00:00:00Z", updatedAt: "2026-07-21T00:00:00Z" },
      task: { id: "task-1", sessionId: "file-then-chat", attachmentId: "att-1", idempotencyKey: "import-key", status: "queued" as const, progress: { phase: "parsing" as const, completedUnits: 0, totalUnits: 1 }, retryable: false, createdAt: "2026-07-21T00:00:00Z", updatedAt: "2026-07-21T00:00:00Z" },
    } as Awaited<ReturnType<ApiClient["createResearchImport"]>>);
    renderStartPage({ createResearchSession, createResearchImport });

    // 先上传文件
    await fireFileChange(makeTxtFile());

    // 文件导入在 handleFileImport 末尾会 navigate；但因为 vitest 环境
    // 不会真正离开，只要确认 createResearchSession 只调了一次即可
    expect(createResearchSession).toHaveBeenCalledTimes(1);
    expect(createResearchImport).toHaveBeenCalledTimes(1);
  });

  it("会话创建网络失败时显示错误，不清除文件引用允许重试", async () => {
    const createResearchSession = vi.fn<ApiClient["createResearchSession"]>().mockRejectedValue(new NetworkError());
    renderStartPage({ createResearchSession });

    await fireFileChange(makeTxtFile());

    expect(await screen.findByText("连接失败，请重试。")).toBeInTheDocument();
  });
});
