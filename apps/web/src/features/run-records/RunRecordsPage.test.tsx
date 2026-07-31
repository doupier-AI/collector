import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { RunRecordSummary } from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { ServicesProvider, type AppServices } from "../../app/services";
import { RunRecordsPage } from "./RunRecordsPage";

const summary: RunRecordSummary = {
  id: "research:task-1",
  source: "research",
  operationType: "research",
  title: "运行记录导出测试",
  status: "completed",
  outcome: "success",
  createdAt: "2026-07-31T00:00:00.000Z",
  modelCallCount: 1,
  searchCount: 0,
  retryCount: 0,
};

function renderPage(api: Partial<ApiClient>) {
  const services = {
    api: api as ApiClient,
    connectTaskEvents: vi.fn(),
    connectImportEvents: vi.fn(),
    connectSelectionEvents: vi.fn(),
  } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={["/run-records"]}>
        <RunRecordsPage />
      </MemoryRouter>
    </ServicesProvider>,
  );
}

describe("RunRecordsPage 导出", () => {
  it("导出当前筛选并显示本机完成状态", async () => {
    const user = userEvent.setup();
    const exportRunRecords = vi.fn(async () => ({ blob: new Blob(["{}"]), fileName: "collector-run-records-test.jsonl" }));
    renderPage({
      listRunRecords: vi.fn(async () => ({ items: [summary] })),
      exportRunRecords,
    });

    await screen.findByText("运行记录导出测试");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:test") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await user.click(screen.getByRole("button", { name: "导出当前筛选" }));

    await waitFor(() => expect(exportRunRecords).toHaveBeenCalledWith({}));
    expect(await screen.findByRole("status")).toHaveTextContent("已下载当前筛选结果的脱敏文件");
    clickSpy.mockRestore();
  });

  it("没有匹配记录时不创建空导出", async () => {
    const user = userEvent.setup();
    const exportRunRecords = vi.fn();
    renderPage({
      listRunRecords: vi.fn(async () => ({ items: [] })),
      exportRunRecords,
    });

    await screen.findByText("当前筛选没有记录");
    await user.click(screen.getByRole("button", { name: "导出当前筛选" }));

    expect(exportRunRecords).not.toHaveBeenCalled();
    expect(await screen.findByText("当前筛选没有可导出的运行记录，请调整筛选条件。")).toBeInTheDocument();
  });
});
