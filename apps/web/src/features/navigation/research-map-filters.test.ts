import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESEARCH_MAP_FILTER_STATE,
  isDefaultResearchMapFilterState,
  normalizeResearchMapFilterState,
  reconcileResearchMapFilterProjects,
  researchMapFilterSummary,
  serializeResearchMapFilters,
  type ResearchMapFilterState,
} from "./research-map-filters";

function state(overrides: Partial<ResearchMapFilterState> = {}): ResearchMapFilterState {
  return { ...DEFAULT_RESEARCH_MAP_FILTER_STATE, ...overrides };
}

describe("research map filters", () => {
  it("以项目全选、全部时间和活跃及归档作为默认状态", () => {
    const result = serializeResearchMapFilters(DEFAULT_RESEARCH_MAP_FILTER_STATE);
    expect(result).toEqual({ valid: true, state: DEFAULT_RESEARCH_MAP_FILTER_STATE, input: { lifecycles: ["active", "archived"] } });
    expect(researchMapFilterSummary(DEFAULT_RESEARCH_MAP_FILTER_STATE)).toEqual({ project: "全部项目", time: "全部时间", lifecycle: "活跃和归档" });
  });

  it("排序去重项目选择；仅未分类仍是有效的单独范围，真正空选回退到全部项目", () => {
    const selected = serializeResearchMapFilters(state({
      projectScope: { kind: "selected", projectIds: ["project-b", "project-a", "project-b"], includeUncategorized: true },
    }));
    expect(selected).toEqual({
      valid: true,
      state: state({ projectScope: { kind: "selected", projectIds: ["project-a", "project-b"], includeUncategorized: true } }),
      input: { projectIds: ["project-a", "project-b"], includeUncategorized: true, lifecycles: ["active", "archived"] },
    });
    expect(researchMapFilterSummary(state({ projectScope: { kind: "selected", projectIds: ["project-a", "project-b"], includeUncategorized: true } })).project).toBe("2个项目和未分类");
    expect(researchMapFilterSummary(state({ projectScope: { kind: "selected", projectIds: [], includeUncategorized: true } })).project).toBe("未分类");

    const empty = serializeResearchMapFilters(state({ projectScope: { kind: "selected", projectIds: [], includeUncategorized: false } }));
    expect(empty).toEqual({ valid: true, state: DEFAULT_RESEARCH_MAP_FILTER_STATE, input: { lifecycles: ["active", "archived"] } });
  });

  it("用当地午夜的半开区间序列化闰日，且不依赖固定 UTC 时区", () => {
    const result = serializeResearchMapFilters(state({ fromDate: "2024-02-29", throughDate: "2024-02-29" }));
    expect(result).toEqual({
      valid: true,
      state: state({ fromDate: "2024-02-29", throughDate: "2024-02-29" }),
      input: {
        lifecycles: ["active", "archived"],
        createdFrom: new Date(2024, 1, 29).toISOString(),
        createdBefore: new Date(2024, 2, 1).toISOString(),
      },
    });
  });

  it("拒绝非实际日期、非严格格式和反向时间范围，不生成请求参数", () => {
    expect(normalizeResearchMapFilterState(state({ fromDate: "2023-02-29" }))).toEqual({ valid: false, reason: "开始日期不是实际存在的日期。" });
    expect(normalizeResearchMapFilterState(state({ throughDate: "2024-2-9" }))).toEqual({ valid: false, reason: "结束日期必须使用 YYYY-MM-DD 格式。" });
    expect(serializeResearchMapFilters(state({ fromDate: "2026-08-21", throughDate: "2026-08-20" }))).toEqual({ valid: false, reason: "开始日期不能晚于结束日期。" });
  });

  it("稳定排序生命周期，并拒绝空、重复或未知值", () => {
    expect(serializeResearchMapFilters(state({ lifecycles: ["archived", "active"] }))).toEqual({
      valid: true,
      state: state({ lifecycles: ["active", "archived"] }),
      input: { lifecycles: ["active", "archived"] },
    });
    expect(normalizeResearchMapFilterState(state({ lifecycles: [] }))).toEqual({ valid: false, reason: "生命周期筛选必须至少保留“活跃”或“已归档”中的一项。" });
    expect(normalizeResearchMapFilterState(state({ lifecycles: ["active", "active"] }))).toEqual({ valid: false, reason: "生命周期筛选不能包含重复项。" });
    expect(normalizeResearchMapFilterState(state({ lifecycles: ["retired"] as unknown as ResearchMapFilterState["lifecycles"] }))).toEqual({ valid: false, reason: "生命周期筛选仅支持“活跃”和“已归档”。" });
  });

  it("恢复现场时剔除已删除项目，并在选择清空后回到全部项目", () => {
    const selected = state({ projectScope: { kind: "selected", projectIds: ["gone", "keep"], includeUncategorized: false } });
    expect(reconcileResearchMapFilterProjects(selected, ["keep"]).projectScope).toEqual({
      kind: "selected",
      projectIds: ["keep"],
      includeUncategorized: false,
    });
    expect(reconcileResearchMapFilterProjects(selected, []).projectScope).toEqual({ kind: "all" });
  });

  it("只把全部项目、全部时间和双生命周期识别为默认现场", () => {
    expect(isDefaultResearchMapFilterState(DEFAULT_RESEARCH_MAP_FILTER_STATE)).toBe(true);
    expect(isDefaultResearchMapFilterState(state({ lifecycles: ["active"] }))).toBe(false);
    expect(isDefaultResearchMapFilterState(state({ projectScope: { kind: "selected", projectIds: [], includeUncategorized: true } }))).toBe(false);
  });
});
