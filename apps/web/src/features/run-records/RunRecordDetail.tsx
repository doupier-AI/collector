import type { RunRecordDetail as RunRecordDetailModel } from "@collector/capture-contracts";
import { errorCategoryLabels, formatDateTime, formatDuration, formatTokens, operationLabels, outcomeLabels, statusLabels } from "./format";

export function RunRecordDetail({ detail }: { detail: RunRecordDetailModel }) {
  const isCorrupt = detail.status === "corrupt";
  return (
    <section className="run-records__detail" aria-labelledby="run-record-detail-title" data-testid="run-record-detail">
      <div className="run-records__section-heading">
        <div>
          <p className="run-records__eyebrow">单条记录</p>
          <h2 id="run-record-detail-title">运行记录详情</h2>
        </div>
        <span className={`run-records__status run-records__status--${detail.outcome}`}>
          {isCorrupt ? "记录损坏" : outcomeLabels[detail.outcome]}
        </span>
      </div>

      {isCorrupt ? <p className="run-records__notice">这条记录无法读取，原始内容已隐藏。</p> : null}

      <dl className="run-records__detail-meta">
        <div><dt>操作</dt><dd>{operationLabels[detail.operationType]}</dd></div>
        <div><dt>状态</dt><dd>{statusLabels[detail.status]}</dd></div>
        <div><dt>开始时间</dt><dd>{formatDateTime(detail.startedAt ?? detail.createdAt)}</dd></div>
        <div><dt>耗时</dt><dd>{formatDuration(detail.durationMs)}</dd></div>
        <div><dt>模型调用</dt><dd>{detail.modelCallCount} 次</dd></div>
        <div><dt>搜索次数</dt><dd>{detail.searchCount} 次</dd></div>
        <div><dt>重试次数</dt><dd>{detail.retryCount} 次</dd></div>
      </dl>

      {detail.task ? (
        <section className="run-records__subsection" aria-labelledby="run-record-task-title">
          <h3 id="run-record-task-title">关联任务</h3>
          <dl className="run-records__detail-meta run-records__detail-meta--compact">
            {detail.task.sessionId ? <div><dt>会话</dt><dd>已关联本地会话</dd></div> : null}
            {detail.task.provider ? <div><dt>模型服务</dt><dd>{detail.task.provider}</dd></div> : null}
            {detail.task.model ? <div><dt>模型</dt><dd>{detail.task.model}</dd></div> : null}
            {detail.task.promptVersion ? <div><dt>提示版本</dt><dd>{detail.task.promptVersion}</dd></div> : null}
            {detail.task.sliceCount !== undefined ? <div><dt>派生片段数</dt><dd>{detail.task.sliceCount} 个</dd></div> : null}
            {detail.task.retryable !== undefined ? <div><dt>可重试</dt><dd>{detail.task.retryable ? "可以" : "不可以"}</dd></div> : null}
          </dl>
        </section>
      ) : null}

      <section className="run-records__subsection" aria-labelledby="run-record-model-title">
        <h3 id="run-record-model-title">模型调用</h3>
        {detail.modelCalls.length === 0 ? <p className="run-records__muted">没有记录到模型调用。</p> : (
          <div className="run-records__table-wrap">
            <table className="run-records__table">
              <thead><tr><th>模型</th><th>提示版本</th><th>状态</th><th>用量</th><th>耗时</th><th>重试</th></tr></thead>
              <tbody>
                {detail.modelCalls.map((call) => (
                  <tr key={call.id}>
                    <td>
                      <strong>{call.model}</strong>
                      <span>{call.provider} · {call.purpose}</span>
                      {call.sourceSliceIds?.length ? <span>来源切片：{call.sourceSliceIds.join("、")}</span> : null}
                      {call.tokenBudget !== undefined ? <span>令牌预算：{formatTokens(call.tokenBudget)}</span> : null}
                    </td>
                    <td>{call.promptVersion}</td>
                    <td>{call.status === "corrupt" ? "记录损坏" : call.status === "completed" ? "已完成" : "失败"}</td>
                    <td>{formatTokens(call.inputTokens)} 输入 / {formatTokens(call.outputTokens)} 输出</td>
                    <td>{formatDuration(call.latencyMs)}</td>
                    <td>{call.retryCount} 次</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="run-records__subsection" aria-labelledby="run-record-search-title">
        <h3 id="run-record-search-title">联网搜索</h3>
        {detail.searches.length === 0 ? <p className="run-records__muted">没有记录到联网搜索。</p> : (
          <ul className="run-records__search-list">
            {detail.searches.map((search) => (
              <li key={search.id} className="run-records__search-item">
                <div className="run-records__search-heading">
                  <strong>{search.provider} · {search.model}</strong>
                  <span>{search.status} · 第 {search.attempt} 次</span>
                </div>
                <p>查询：{search.queries.length ? search.queries.join("；") : "未记录"}</p>
                <p>来源 {search.sourceCount} 个，引用 {search.citationCount} 个</p>
                {search.responseSummary ? <pre>{JSON.stringify(search.responseSummary, null, 2)}</pre> : null}
                {search.sources.length ? (
                  <ul className="run-records__source-list">
                    {search.sources.map((source, index) => (
                      <li key={`${search.id}-${index}`}>
                        {source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a> : <span>{source.title}</span>}
                        {source.snippet ? <small>{source.snippet}</small> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="run-records__subsection" aria-labelledby="run-record-error-title">
        <h3 id="run-record-error-title">错误轨迹</h3>
        {detail.errors.length === 0 ? <p className="run-records__muted">没有记录到错误。</p> : (
          <ul className="run-records__error-list">
            {detail.errors.map((error, index) => <li key={`${error.source}-${index}`}><strong>{errorCategoryLabels[error.category]} · {error.source}</strong><span>{error.message}</span></li>)}
          </ul>
        )}
      </section>
    </section>
  );
}
