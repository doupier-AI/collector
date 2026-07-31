import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { RunRecordDetail, RunRecordExportFilters, RunRecordPage, RunRecordSummary } from "@collector/capture-contracts";
import { useServices } from "../../app/services";
import { RunRecordDetail as RunRecordDetailView } from "./RunRecordDetail";
import { formatDateTime, formatDuration, operationLabels, outcomeLabels } from "./format";

const PAGE_SIZE = 20;

type FilterForm = { from: string; to: string; operationType: string; outcome: string };
type ListState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; items: RunRecordSummary[]; nextCursor?: string; loadingMore: boolean; loadMoreError: boolean };
type DetailState = { kind: "idle" } | { kind: "loading" } | { kind: "error" } | { kind: "ready"; detail: RunRecordDetail };
type ExportState = { kind: "idle" } | { kind: "downloading" } | { kind: "success" } | { kind: "empty" } | { kind: "error" };

export function RunRecordsPage() {
  const { api } = useServices();
  const { runId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [form, setForm] = useState<FilterForm>(() => formFromParams(searchParams));
  const [reloadKey, setReloadKey] = useState(0);
  const [listState, setListState] = useState<ListState>({ kind: "loading" });
  const [detailState, setDetailState] = useState<DetailState>({ kind: "idle" });
  const [exportState, setExportState] = useState<ExportState>({ kind: "idle" });
  const filterKey = searchParams.toString();
  const filters = useMemo(() => filtersFromParams(searchParams), [filterKey, searchParams]);

  useEffect(() => setForm(formFromParams(searchParams)), [filterKey, searchParams]);

  useEffect(() => {
    let stale = false;
    setListState({ kind: "loading" });
    api.listRunRecords({ ...filters, limit: PAGE_SIZE }).then(
      (page) => { if (!stale) setListState({ kind: "ready", items: page.items, nextCursor: page.nextCursor, loadingMore: false, loadMoreError: false }); },
      () => { if (!stale) setListState({ kind: "error" }); },
    );
    return () => { stale = true; };
  }, [api, filterKey, reloadKey]);

  useEffect(() => {
    if (!runId) { setDetailState({ kind: "idle" }); return; }
    let stale = false;
    setDetailState({ kind: "loading" });
    api.getRunRecord(runId).then(
      (detail) => { if (!stale) setDetailState({ kind: "ready", detail }); },
      () => { if (!stale) setDetailState({ kind: "error" }); },
    );
    return () => { stale = true; };
  }, [api, runId, reloadKey]);

  const submitFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = new URLSearchParams();
    const from = dateInputToIso(form.from);
    const to = dateInputToIso(form.to);
    if (from) next.set("from", from);
    if (to) next.set("to", to);
    if (form.operationType) next.set("operationType", form.operationType);
    if (form.outcome) next.set("outcome", form.outcome);
    setSearchParams(next);
  };

  const resetFilters = () => {
    setForm({ from: "", to: "", operationType: "", outcome: "" });
    setSearchParams({});
  };

  const loadMore = () => {
    if (listState.kind !== "ready" || !listState.nextCursor || listState.loadingMore) return;
    setListState({ ...listState, loadingMore: true, loadMoreError: false });
    api.listRunRecords({ ...filters, limit: PAGE_SIZE, cursor: listState.nextCursor }).then(
      (page: RunRecordPage) => setListState((current) => current.kind === "ready" ? { kind: "ready", items: [...current.items, ...page.items], nextCursor: page.nextCursor, loadingMore: false, loadMoreError: false } : current),
      () => setListState((current) => current.kind === "ready" ? { ...current, loadingMore: false, loadMoreError: true } : current),
    );
  };

  const exportFilteredRecords = async () => {
    if (exportState.kind === "downloading") return;
    if (listState.kind === "ready" && listState.items.length === 0) {
      setExportState({ kind: "empty" });
      return;
    }
    setExportState({ kind: "downloading" });
    try {
      const download = await api.exportRunRecords(filters);
      downloadBlob(download.blob, download.fileName);
      setExportState({ kind: "success" });
    } catch {
      setExportState({ kind: "error" });
    }
  };

  return (
    <div className="page run-records">
      <header className="run-records__header">
        <div>
          <p className="run-records__eyebrow">本机可恢复的历史轨迹</p>
          <h1 className="page__title">运行记录</h1>
          <p className="page__lead">查看一次用户操作关联的任务、模型调用、搜索摘要和错误轨迹。</p>
        </div>
        <div className="run-records__header-actions">
          <button type="button" className="button button--secondary" disabled={exportState.kind === "downloading"} onClick={() => void exportFilteredRecords()}>{exportState.kind === "downloading" ? "正在导出…" : "导出当前筛选"}</button>
          <button type="button" className="button button--secondary" onClick={() => setReloadKey((key) => key + 1)}>刷新</button>
        </div>
      </header>

      {exportState.kind === "success" ? <p className="run-records__export-status" role="status">已下载当前筛选结果的脱敏文件，文件只在本机生成。</p> : null}
      {exportState.kind === "empty" ? <p className="run-records__export-status" role="status">当前筛选没有可导出的运行记录，请调整筛选条件。</p> : null}
      {exportState.kind === "error" ? <div className="run-records__export-status run-records__export-status--error" role="alert"><span>导出没有完成，原始记录未上传外部服务。</span><button type="button" className="button button--secondary" onClick={() => void exportFilteredRecords()}>重试导出</button></div> : null}

      <form className="run-records__filters" onSubmit={submitFilters} aria-label="运行记录筛选">
        <div className="run-records__filter-grid">
          <label>开始时间<input type="datetime-local" value={form.from} onChange={(event) => setForm({ ...form, from: event.target.value })} /></label>
          <label>结束时间<input type="datetime-local" value={form.to} onChange={(event) => setForm({ ...form, to: event.target.value })} /></label>
          <label>操作类型<select value={form.operationType} onChange={(event) => setForm({ ...form, operationType: event.target.value })}><option value="">全部操作</option>{Object.entries(operationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>结果<select value={form.outcome} onChange={(event) => setForm({ ...form, outcome: event.target.value })}><option value="">全部结果</option>{Object.entries(outcomeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        </div>
        <div className="run-records__filter-actions"><button type="submit" className="button button--primary">应用筛选</button><button type="button" className="button button--secondary" onClick={resetFilters}>清除筛选</button></div>
      </form>

      <section aria-labelledby="run-record-list-title">
        <div className="run-records__section-heading"><h2 id="run-record-list-title">记录列表</h2>{listState.kind === "ready" ? <span className="run-records__muted">共显示 {listState.items.length} 条</span> : null}</div>
        {listState.kind === "loading" ? <p className="run-records__state" role="status" aria-live="polite">正在读取运行记录…</p> : null}
        {listState.kind === "error" ? <div className="run-records__state run-records__state--error" role="alert"><p>暂时无法读取运行记录。</p><button type="button" className="button button--secondary" onClick={() => setReloadKey((key) => key + 1)}>重新读取</button></div> : null}
        {listState.kind === "ready" && listState.items.length === 0 ? <div className="run-records__state" role="status"><h3>当前筛选没有记录</h3><p>可以调整筛选条件；没有匹配记录时不会生成空的导出文件。</p></div> : null}
        {listState.kind === "ready" && listState.items.length > 0 ? <RunRecordList items={listState.items} /> : null}
        {listState.kind === "ready" && listState.nextCursor ? <div className="run-records__load-more"><button type="button" className="button button--secondary" disabled={listState.loadingMore} onClick={loadMore}>{listState.loadingMore ? "正在读取…" : "加载更多"}</button>{listState.loadMoreError ? <p className="run-records__inline-error" role="alert">下一页读取失败，请重试。</p> : null}</div> : null}
      </section>

      {runId ? <p className="run-records__back"><Link to="/run-records">← 返回运行记录列表</Link></p> : null}
      {detailState.kind === "loading" ? <p className="run-records__state" role="status" aria-live="polite">正在读取记录详情…</p> : null}
      {detailState.kind === "error" ? <div className="run-records__state run-records__state--error" role="alert"><p>暂时无法读取这条运行记录。</p><button type="button" className="button button--secondary" onClick={() => setReloadKey((key) => key + 1)}>重新读取</button></div> : null}
      {detailState.kind === "ready" ? <RunRecordDetailView detail={detailState.detail} /> : null}
    </div>
  );
}

function RunRecordList({ items }: { items: RunRecordSummary[] }) {
  return <ul className="run-records__list" data-testid="run-record-list">{items.map((item) => <li key={item.id} data-testid="run-record-item"><Link className="run-records__item" to={`/run-records/${encodeURIComponent(item.id)}`}><div className="run-records__item-heading"><strong>{item.title ?? operationLabels[item.operationType]}</strong><span className={`run-records__status run-records__status--${item.outcome}`}>{outcomeLabels[item.outcome]}</span></div><p>{formatDateTime(item.createdAt)}</p><dl className="run-records__item-meta"><div><dt>操作</dt><dd>{operationLabels[item.operationType]}</dd></div><div><dt>耗时</dt><dd>{formatDuration(item.durationMs)}</dd></div><div><dt>模型</dt><dd>{item.modelCallCount} 次</dd></div><div><dt>搜索</dt><dd>{item.searchCount} 次</dd></div><div><dt>重试</dt><dd>{item.retryCount} 次</dd></div></dl></Link></li>)}</ul>;
}

function formFromParams(params: URLSearchParams): FilterForm {
  return { from: isoToDateInput(params.get("from")), to: isoToDateInput(params.get("to")), operationType: params.get("operationType") ?? "", outcome: params.get("outcome") ?? "" };
}

function filtersFromParams(params: URLSearchParams): RunRecordExportFilters {
  const operationType = params.get("operationType");
  const outcome = params.get("outcome");
  const status = params.get("status");
  return {
    ...(params.get("from") ? { from: params.get("from")! } : {}),
    ...(params.get("to") ? { to: params.get("to")! } : {}),
    ...(operationType ? { operationType: operationType as RunRecordExportFilters["operationType"] } : {}),
    ...(outcome ? { outcome: outcome as RunRecordExportFilters["outcome"] } : {}),
    ...(status ? { status: status as RunRecordExportFilters["status"] } : {}),
  };
}

function dateInputToIso(value: string): string | undefined { if (!value) return undefined; const date = new Date(value); return Number.isNaN(date.getTime()) ? undefined : date.toISOString(); }
function isoToDateInput(value: string | null): string { if (!value) return ""; const date = new Date(value); if (Number.isNaN(date.getTime())) return ""; const pad = (number: number) => String(number).padStart(2, "0"); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; }

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
