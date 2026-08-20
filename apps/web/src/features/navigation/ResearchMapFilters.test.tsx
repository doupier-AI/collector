import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { makeProject } from "../../test/fakes";
import { ResearchMapFilters } from "./ResearchMapFilters";
import { DEFAULT_RESEARCH_MAP_FILTER_STATE, type ResearchMapFilterState } from "./research-map-filters";

const projects = [
  makeProject({ id: "project-work", name: "工作项目", colorRole: "blue" }),
  makeProject({ id: "project-study", name: "学习项目", colorRole: "teal" }),
];

function FilterHarness({ initial = DEFAULT_RESEARCH_MAP_FILTER_STATE, validationMessage }: {
  readonly initial?: ResearchMapFilterState;
  readonly validationMessage?: string;
}) {
  const [value, setValue] = useState(initial);
  return <ResearchMapFilters projects={projects} value={value} onChange={setValue} validationMessage={validationMessage} />;
}

describe("ResearchMapFilters", () => {
  it("默认摘要表明全部项目包含未分类，以及全部时间和两种生命周期", () => {
    render(<FilterHarness />);

    expect(screen.getByText("项目：全部项目")).toBeInTheDocument();
    expect(screen.getByLabelText("当前筛选摘要")).toHaveTextContent("时间：全部时间；生命周期：活跃和归档");
    expect(screen.getByRole("radio", { name: "全部项目（含未分类）" })).toBeChecked();
  });

  it("项目从全部到单选、组合，移除最后一个后回到全部", async () => {
    const user = userEvent.setup();
    render(<FilterHarness />);

    const work = screen.getByRole("checkbox", { name: "工作项目" });
    const study = screen.getByRole("checkbox", { name: "学习项目" });
    await user.click(work);
    expect(work).toBeChecked();
    expect(screen.getByRole("radio", { name: "全部项目（含未分类）" })).not.toBeChecked();

    await user.click(study);
    expect(study).toBeChecked();
    expect(screen.getByText("项目：2个项目")).toBeInTheDocument();

    await user.click(study);
    await user.click(work);
    expect(screen.getByRole("radio", { name: "全部项目（含未分类）" })).toBeChecked();
  });

  it("未分类可独立选择，也可和项目组合", async () => {
    const user = userEvent.setup();
    render(<FilterHarness />);

    const uncategorized = screen.getByRole("checkbox", { name: "未分类" });
    await user.click(uncategorized);
    expect(uncategorized).toBeChecked();
    expect(screen.getByText("项目：未分类")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "工作项目" }));
    expect(screen.getByText("项目：1个项目和未分类")).toBeInTheDocument();
  });

  it("日期控件保留本地日期字符串并上报", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ResearchMapFilters projects={projects} value={DEFAULT_RESEARCH_MAP_FILTER_STATE} onChange={onChange} />);

    await user.type(screen.getByLabelText("开始日期"), "2026-08-20");
    await user.type(screen.getByLabelText("结束日期"), "2026-08-21");
    expect(onChange).toHaveBeenNthCalledWith(1, { ...DEFAULT_RESEARCH_MAP_FILTER_STATE, fromDate: "2026-08-20" });
    expect(onChange).toHaveBeenNthCalledWith(2, { ...DEFAULT_RESEARCH_MAP_FILTER_STATE, throughDate: "2026-08-21" });
  });

  it("生命周期不能关闭最后一项；先选另一项后可完成切换", async () => {
    const user = userEvent.setup();
    render(<FilterHarness initial={{ ...DEFAULT_RESEARCH_MAP_FILTER_STATE, lifecycles: ["active"] }} />);

    const active = screen.getByRole("checkbox", { name: "活跃" });
    const archived = screen.getByRole("checkbox", { name: "已归档" });
    expect(active).toBeDisabled();
    expect(screen.getByText("至少保留一项")).toBeInTheDocument();

    await user.click(archived);
    expect(active).not.toBeDisabled();
    expect(archived).toBeChecked();
    await user.click(active);
    expect(active).not.toBeChecked();
    expect(archived).toBeDisabled();
  });

  it("清除筛选恢复默认状态", async () => {
    const user = userEvent.setup();
    render(<FilterHarness initial={{
      projectScope: { kind: "selected", projectIds: ["project-work"], includeUncategorized: true },
      fromDate: "2026-08-20",
      throughDate: "2026-08-21",
      lifecycles: ["archived"],
    }} />);

    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByRole("radio", { name: "全部项目（含未分类）" })).toBeChecked();
    expect(screen.getByLabelText("开始日期")).toHaveValue("");
    expect(screen.getByRole("checkbox", { name: "活跃" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "已归档" })).toBeChecked();
  });

  it("显示校验说明，并可用原生键盘操作项目选择", async () => {
    const user = userEvent.setup();
    render(<FilterHarness validationMessage="开始日期不能晚于结束日期。" />);

    expect(screen.getByRole("alert")).toHaveTextContent("开始日期不能晚于结束日期。");
    screen.getByRole("checkbox", { name: "工作项目" }).focus();
    await user.keyboard(" ");
    expect(screen.getByRole("checkbox", { name: "工作项目" })).toBeChecked();
  });
});
