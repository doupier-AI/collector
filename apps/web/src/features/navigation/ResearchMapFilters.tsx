import type { ProjectRecord, ResearchGraphLifecycle } from "@collector/capture-contracts";
import {
  DEFAULT_RESEARCH_MAP_FILTER_STATE,
  researchMapFilterSummary,
  type ResearchMapFilterState,
  type ResearchMapProjectScope,
} from "./research-map-filters";

export interface ResearchMapFiltersProps {
  readonly projects: readonly ProjectRecord[];
  readonly value: ResearchMapFilterState;
  readonly onChange: (next: ResearchMapFilterState) => void;
  readonly validationMessage?: string;
}

const LIFECYCLES: readonly ResearchGraphLifecycle[] = ["active", "archived"];
const LIFECYCLE_LABELS: Readonly<Record<ResearchGraphLifecycle, string>> = {
  active: "活跃",
  archived: "已归档",
};

function nextProjectScope(
  current: ResearchMapProjectScope,
  selection: { readonly kind: "project"; readonly projectId: string } | { readonly kind: "uncategorized" },
): ResearchMapProjectScope {
  const selectedIds = current.kind === "selected" ? new Set(current.projectIds) : new Set<string>();
  let includeUncategorized = current.kind === "selected" && current.includeUncategorized;

  if (selection.kind === "project") {
    if (selectedIds.has(selection.projectId)) selectedIds.delete(selection.projectId);
    else selectedIds.add(selection.projectId);
  } else {
    includeUncategorized = !includeUncategorized;
  }

  const projectIds = [...selectedIds].sort();
  return projectIds.length || includeUncategorized
    ? { kind: "selected", projectIds, includeUncategorized }
    : { kind: "all" };
}

function withDate(value: ResearchMapFilterState, field: "fromDate" | "throughDate", date: string): ResearchMapFilterState {
  const next = { ...value, [field]: date || undefined };
  if (!date) delete next[field];
  return next;
}

/**
 * 地图范围的纯展示与交互控件。调用方拥有筛选状态、校验与请求时机；这里不读取数据也不发请求。
 */
export function ResearchMapFilters({ projects, value, onChange, validationMessage }: ResearchMapFiltersProps) {
  const summary = researchMapFilterSummary(value);
  const projectScope = value.projectScope;

  function changeProject(selection: { readonly kind: "project"; readonly projectId: string } | { readonly kind: "uncategorized" }) {
    onChange({ ...value, projectScope: nextProjectScope(projectScope, selection) });
  }

  function changeLifecycle(lifecycle: ResearchGraphLifecycle) {
    const selected = value.lifecycles.includes(lifecycle);
    if (selected && value.lifecycles.length === 1) return;
    const lifecycles = selected
      ? LIFECYCLES.filter((candidate) => candidate !== lifecycle && value.lifecycles.includes(candidate))
      : LIFECYCLES.filter((candidate) => candidate === lifecycle || value.lifecycles.includes(candidate));
    onChange({ ...value, lifecycles });
  }

  return (
    <section className="research-map-filters" aria-labelledby="research-map-filters-title">
      <div className="research-map-filters__heading">
        <h2 id="research-map-filters-title">筛选地图</h2>
        <button type="button" className="research-map-filters__clear" onClick={() => onChange(DEFAULT_RESEARCH_MAP_FILTER_STATE)}>
          清除筛选
        </button>
      </div>

      <details className="research-map-filters__projects" open>
        <summary>
          项目：{summary.project}
        </summary>
        <fieldset className="research-map-filters__project-options">
          <legend>项目范围</legend>
          <label className="research-map-filters__choice">
            <input
              type="radio"
              name="research-map-project-scope"
              checked={projectScope.kind === "all"}
              onChange={() => onChange({ ...value, projectScope: { kind: "all" } })}
            />
            <span>全部项目（含未分类）</span>
          </label>
          {projects.map((project) => {
            const checked = projectScope.kind === "selected" && projectScope.projectIds.includes(project.id);
            return (
              <label className="research-map-filters__choice" key={project.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => changeProject({ kind: "project", projectId: project.id })}
                />
                <span className={`research-map-filters__project-dot research-map-filters__project-dot--${project.colorRole ?? "amber"}`} aria-hidden="true" />
                <span>{project.name}</span>
              </label>
            );
          })}
          <label className="research-map-filters__choice">
            <input
              type="checkbox"
              checked={projectScope.kind === "selected" && projectScope.includeUncategorized}
              onChange={() => changeProject({ kind: "uncategorized" })}
            />
            <span className="research-map-filters__uncategorized-mark" aria-hidden="true">○</span>
            <span>未分类</span>
          </label>
        </fieldset>
      </details>

      <fieldset className="research-map-filters__dates">
        <legend>创建日期</legend>
        <label>
          <span>开始日期</span>
          <input
            type="date"
            value={value.fromDate ?? ""}
            onChange={(event) => onChange(withDate(value, "fromDate", event.target.value))}
          />
        </label>
        <label>
          <span>结束日期</span>
          <input
            type="date"
            value={value.throughDate ?? ""}
            onChange={(event) => onChange(withDate(value, "throughDate", event.target.value))}
          />
        </label>
      </fieldset>

      <fieldset className="research-map-filters__lifecycles">
        <legend>生命周期</legend>
        {LIFECYCLES.map((lifecycle) => {
          const checked = value.lifecycles.includes(lifecycle);
          const cannotClear = checked && value.lifecycles.length === 1;
          return (
            <label className="research-map-filters__choice" key={lifecycle}>
              <input
                type="checkbox"
                checked={checked}
                disabled={cannotClear}
                onChange={() => changeLifecycle(lifecycle)}
              />
              <span>{LIFECYCLE_LABELS[lifecycle]}</span>
            </label>
          );
        })}
        <p className="research-map-filters__hint">至少保留一项</p>
      </fieldset>

      <p className="research-map-filters__summary" aria-label="当前筛选摘要">
        时间：{summary.time}；生命周期：{summary.lifecycle}
      </p>
      {validationMessage ? <p className="research-map-filters__validation" role="alert">{validationMessage}</p> : null}
    </section>
  );
}
