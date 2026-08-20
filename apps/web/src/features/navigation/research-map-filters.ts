import type { ResearchGraphLifecycle, ResearchGraphObservationInput } from "@collector/capture-contracts";

export type ResearchMapProjectScope =
  | { readonly kind: "all" }
  | { readonly kind: "selected"; readonly projectIds: readonly string[]; readonly includeUncategorized: boolean };

/** 界面保存的筛选选择；成功规范化后 lifecycle 始终是稳定、非空的活跃/归档集合。 */
export interface ResearchMapFilterState {
  readonly projectScope: ResearchMapProjectScope;
  readonly fromDate?: string;
  readonly throughDate?: string;
  readonly lifecycles: readonly ResearchGraphLifecycle[];
}

export const DEFAULT_RESEARCH_MAP_FILTER_STATE: ResearchMapFilterState = {
  projectScope: { kind: "all" },
  lifecycles: ["active", "archived"],
};

export type ResearchMapFilterNormalization =
  | { readonly valid: true; readonly state: ResearchMapFilterState }
  | { readonly valid: false; readonly reason: string };

export type ResearchMapFilterSerialization =
  | { readonly valid: true; readonly state: ResearchMapFilterState; readonly input: ResearchGraphObservationInput }
  | { readonly valid: false; readonly reason: string };

export interface ResearchMapFilterSummary {
  readonly project: string;
  readonly time: string;
  readonly lifecycle: string;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const LIFECYCLE_ORDER: readonly ResearchGraphLifecycle[] = ["active", "archived"];
type InvalidResearchMapFilter = Extract<ResearchMapFilterNormalization, { valid: false }>;
interface ParsedLocalDate { readonly value?: string; readonly date?: Date }

function invalid(reason: string): InvalidResearchMapFilter {
  return { valid: false, reason };
}

function localDate(value: string | undefined, label: "开始日期" | "结束日期"): ParsedLocalDate | InvalidResearchMapFilter {
  if (!value) return {};
  const match = DATE_PATTERN.exec(value);
  if (!match) return invalid(`${label}必须使用 YYYY-MM-DD 格式。`);
  const [year, month, day] = match.slice(1).map(Number);
  // 数字构造保留用户所在时区的当地午夜；不能改用 UTC 解析 YYYY-MM-DD。
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return invalid(`${label}不是实际存在的日期。`);
  }
  return { value, date };
}

function isInvalid(result: ParsedLocalDate | InvalidResearchMapFilter): result is InvalidResearchMapFilter {
  return "valid" in result;
}

function normalizedProjectScope(scope: ResearchMapProjectScope): ResearchMapProjectScope {
  if (scope.kind === "all") return { kind: "all" };
  const projectIds = [...new Set(scope.projectIds)].sort();
  return projectIds.length || scope.includeUncategorized
    ? { kind: "selected", projectIds, includeUncategorized: scope.includeUncategorized }
    : { kind: "all" };
}

function normalizedLifecycles(lifecycles: readonly ResearchGraphLifecycle[]): ResearchGraphLifecycle[] | InvalidResearchMapFilter {
  if (lifecycles.length === 0) return invalid("生命周期筛选必须至少保留“活跃”或“已归档”中的一项。");
  if (new Set(lifecycles).size !== lifecycles.length) return invalid("生命周期筛选不能包含重复项。");
  if (lifecycles.some((lifecycle) => lifecycle !== "active" && lifecycle !== "archived")) {
    return invalid("生命周期筛选仅支持“活跃”和“已归档”。");
  }
  return LIFECYCLE_ORDER.filter((lifecycle) => lifecycles.includes(lifecycle));
}

/**
 * 集中收敛 UI 状态：项目空选回退为全部项目，日期按本地日验证，生命周期保持稳定顺序。
 * 无效结果不含请求参数，调用方可直接展示 reason 并跳过请求。
 */
export function normalizeResearchMapFilterState(state: ResearchMapFilterState): ResearchMapFilterNormalization {
  const from = localDate(state.fromDate, "开始日期");
  if (isInvalid(from)) return from;
  const through = localDate(state.throughDate, "结束日期");
  if (isInvalid(through)) return through;
  if (from.date && through.date && from.date.getTime() > through.date.getTime()) {
    return invalid("开始日期不能晚于结束日期。");
  }
  const lifecycles = normalizedLifecycles(state.lifecycles);
  if (!Array.isArray(lifecycles)) return lifecycles;
  return {
    valid: true,
    state: {
      projectScope: normalizedProjectScope(state.projectScope),
      ...(from.value ? { fromDate: from.value } : {}),
      ...(through.value ? { throughDate: through.value } : {}),
      lifecycles,
    },
  };
}

/** 将已经验证的界面筛选转换为全局观察请求；结束日期使用次日当地午夜作为不含上界。 */
export function serializeResearchMapFilters(state: ResearchMapFilterState): ResearchMapFilterSerialization {
  const normalized = normalizeResearchMapFilterState(state);
  if (!normalized.valid) return normalized;
  const from = localDate(normalized.state.fromDate, "开始日期");
  const through = localDate(normalized.state.throughDate, "结束日期");
  // 已由 normalize 验证；保留窄化分支以便该 Module 在未来独立调用时也不会发出错误请求。
  if (isInvalid(from)) return from;
  if (isInvalid(through)) return through;
  const projectScope = normalized.state.projectScope;
  const input: ResearchGraphObservationInput = {
    lifecycles: [...normalized.state.lifecycles],
    ...(projectScope.kind === "selected" && projectScope.projectIds.length ? { projectIds: [...projectScope.projectIds] } : {}),
    ...(projectScope.kind === "selected" && projectScope.includeUncategorized ? { includeUncategorized: true } : {}),
    ...(from.date ? { createdFrom: from.date.toISOString() } : {}),
    ...(through.date ? { createdBefore: new Date(through.date.getFullYear(), through.date.getMonth(), through.date.getDate() + 1).toISOString() } : {}),
  };
  return { valid: true, state: normalized.state, input };
}

export function researchMapFilterSummary(state: ResearchMapFilterState): ResearchMapFilterSummary {
  const normalized = normalizeResearchMapFilterState(state);
  if (!normalized.valid) {
    return { project: "筛选待修正", time: "筛选待修正", lifecycle: "筛选待修正" };
  }
  const { projectScope, fromDate, throughDate, lifecycles } = normalized.state;
  const project = projectScope.kind === "all"
    ? "全部项目"
    : projectScope.projectIds.length === 0
      ? "未分类"
      : `${projectScope.projectIds.length}个项目${projectScope.includeUncategorized ? "和未分类" : ""}`;
  const time = fromDate && throughDate ? `${fromDate}至${throughDate}` : fromDate ? `自${fromDate}` : throughDate ? `截至${throughDate}` : "全部时间";
  const lifecycle = lifecycles.join("和").replace("active", "活跃").replace("archived", "归档");
  return { project, time, lifecycle };
}

/** 项目被删除或现场来自旧标签页时，只保留当前仍存在的项目选择。 */
export function reconcileResearchMapFilterProjects(
  state: ResearchMapFilterState,
  availableProjectIds: readonly string[],
): ResearchMapFilterState {
  if (state.projectScope.kind === "all") return state;
  const selectedScope = state.projectScope;
  const available = new Set(availableProjectIds);
  const projectIds = selectedScope.projectIds.filter((id) => available.has(id));
  const projectScope = projectIds.length || selectedScope.includeUncategorized
    ? { kind: "selected" as const, projectIds, includeUncategorized: selectedScope.includeUncategorized }
    : { kind: "all" as const };
  if (projectScope.kind === "selected"
    && projectIds.length === selectedScope.projectIds.length
    && projectIds.every((id, index) => id === selectedScope.projectIds[index])) return state;
  return { ...state, projectScope };
}

export function isDefaultResearchMapFilterState(state: ResearchMapFilterState): boolean {
  const normalized = normalizeResearchMapFilterState(state);
  if (!normalized.valid) return false;
  return normalized.state.projectScope.kind === "all"
    && !normalized.state.fromDate
    && !normalized.state.throughDate
    && normalized.state.lifecycles.length === 2;
}
