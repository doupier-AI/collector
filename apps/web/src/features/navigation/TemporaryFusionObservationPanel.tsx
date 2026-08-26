import { useEffect, useRef, useState } from "react";
import type { ResearchCandidateSourceConnectionRecord, ResearchTemporaryFusionBundle, ResearchTemporaryFusionConversationView, ResearchTemporaryFusionDraftHistory, ResearchTemporaryFusionListItem, ResearchTemporaryFusionSearchMatch } from "@collector/capture-contracts";
import { apiErrorCopy } from "../../api/errors";
import { useServices } from "../../app/services";

interface TemporaryFusionObservationPanelProps {
  onCloseObservation: () => void;
  onOpenSource: (source: ResearchCandidateSourceConnectionRecord) => void;
  /** 删除写入成功后由地图重新读取临时层、搜索投影和全局数量。 */
  onChanged: () => void;
}

function sourceLabel(source: ResearchCandidateSourceConnectionRecord): string {
  return `返回来源节点 ${source.sourceNodeId}`;
}

function adjacentDraftDifference(current: string, previous: string): string {
  let prefix = 0;
  while (prefix < current.length && prefix < previous.length && current[prefix] === previous[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < current.length - prefix && suffix < previous.length - prefix && current[current.length - suffix - 1] === previous[previous.length - suffix - 1]) suffix += 1;
  const removed = previous.slice(prefix, previous.length - suffix);
  const added = current.slice(prefix, current.length - suffix);
  return `相对上一版：${removed ? `删除“${removed}”` : "无删除"}${added ? `；新增“${added}”` : "；无新增"}`;
}

/** T02 的 B 面只读观察器。它只读取当前草案和来源定位，不提供任何管理或确认动作。 */
export function TemporaryFusionObservationPanel({ onCloseObservation, onOpenSource, onChanged }: TemporaryFusionObservationPanelProps) {
  const { api } = useServices();
  const [items, setItems] = useState<ResearchTemporaryFusionListItem[]>([]);
  const [selected, setSelected] = useState<ResearchTemporaryFusionBundle>();
  const [conversation, setConversation] = useState<ResearchTemporaryFusionConversationView>();
  const [draftHistory, setDraftHistory] = useState<ResearchTemporaryFusionDraftHistory>();
  const [draftEditing, setDraftEditing] = useState(false);
  const [draftBody, setDraftBody] = useState("");
  const [messageDraft, setMessageDraft] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<ResearchTemporaryFusionSearchMatch[] | undefined>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [clearConfirmationOpen, setClearConfirmationOpen] = useState(false);
  const cancelClearRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let stale = false;
    api.listTemporaryFusions().then((next) => { if (!stale) setItems(next); }, (nextError) => { if (!stale) setError(nextError); });
    return () => { stale = true; };
  }, [api]);

  useEffect(() => {
    if (clearConfirmationOpen) cancelClearRef.current?.focus();
  }, [clearConfirmationOpen]);

  const reload = () => {
    setQuery("");
    setMatches(undefined);
    setSelected(undefined);
    setConversation(undefined);
    api.listTemporaryFusions().then(
      (next) => {
        setItems(next);
        setSelectedIds((current) => new Set([...current].filter((id) => next.some((item) => item.node.id === id))));
      },
      setError,
    );
    onChanged();
  };

  const open = (id: string) => {
    setError(undefined);
    Promise.all([api.getTemporaryFusion(id), api.getTemporaryFusionConversation(id), api.getTemporaryFusionDraftHistory(id)]).then(
      ([bundle, nextConversation, history]) => { setSelected(bundle); setConversation(nextConversation); setDraftHistory(history); setDraftBody(bundle.activeDraft.body); setDraftEditing(false); },
      setError,
    );
  };

  const saveDraft = async () => {
    if (!selected || busy || !draftBody.trim()) return;
    setBusy(true); setError(undefined);
    try {
      const result = await api.updateTemporaryFusionDraft(selected.node.id, { body: draftBody, expectedDraftVersionId: selected.activeDraft.id });
      setSelected(result.bundle); setDraftBody(result.bundle.activeDraft.body); setDraftHistory(await api.getTemporaryFusionDraftHistory(selected.node.id)); setDraftEditing(false); onChanged();
    } catch (nextError) { setError(nextError); }
    finally { setBusy(false); }
  };

  const restoreDraft = async (versionId: string) => {
    if (!selected || busy) return;
    setBusy(true); setError(undefined);
    try {
      const result = await api.restoreTemporaryFusionDraft(selected.node.id, versionId, selected.activeDraft.id);
      setSelected(result.bundle); setDraftBody(result.bundle.activeDraft.body); setDraftHistory(await api.getTemporaryFusionDraftHistory(selected.node.id)); setDraftEditing(false); onChanged();
    } catch (nextError) { setError(nextError); }
    finally { setBusy(false); }
  };

  const refreshConversation = (id = selected?.node.id) => {
    if (!id) return;
    api.getTemporaryFusionConversation(id).then(setConversation, setError);
  };

  useEffect(() => {
    if (!selected) return;
    const timer = window.setInterval(() => refreshConversation(selected.node.id), 1000);
    return () => window.clearInterval(timer);
  }, [api, selected?.node.id]);

  const search = () => {
    const value = query.trim();
    if (!value) {
      setMatches(undefined);
      return;
    }
    setError(undefined);
    api.searchTemporaryFusions({ query: value }).then((response) => setMatches(response.matches), setError);
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const deleteOne = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.deleteTemporaryFusion(id);
      reload();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  };

  const deleteSelected = async () => {
    if (busy || selectedIds.size === 0) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.deleteTemporaryFusions([...selectedIds]);
      setSelectedIds(new Set());
      reload();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  };

  const clearAll = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.clearTemporaryFusions();
      setClearConfirmationOpen(false);
      setSelectedIds(new Set());
      reload();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  };

  const sendMessage = async () => {
    if (!selected || busy || !messageDraft.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.submitTemporaryFusionMessage(selected.node.id, messageDraft, crypto.randomUUID());
      setMessageDraft("");
      refreshConversation(selected.node.id);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  };

  const cancelTask = async (taskId: string) => {
    if (busy) return;
    setBusy(true);
    try { await api.cancelTemporaryFusionTask(taskId); refreshConversation(); }
    catch (nextError) { setError(nextError); }
    finally { setBusy(false); }
  };

  const retryTask = async (taskId: string) => {
    if (busy) return;
    setBusy(true);
    try { await api.retryTemporaryFusionTask(taskId); refreshConversation(); }
    catch (nextError) { setError(nextError); }
    finally { setBusy(false); }
  };

  const visible = matches ?? items;
  return (
    <section className="temporary-fusion-observation" aria-labelledby="temporary-fusion-observation-title">
      <div className="temporary-fusion-observation__heading">
        <div><h2 id="temporary-fusion-observation-title">临时融合观察</h2><p>候选只在这里查看；它们尚未成为研究节点或永久关系。</p></div>
        <button type="button" className="button button--secondary" onClick={onCloseObservation}>关闭临时层</button>
      </div>
      <div className="temporary-fusion-observation__actions" role="group" aria-label="临时融合管理">
        <span aria-live="polite">{selectedIds.size > 0 ? `已选 ${selectedIds.size} 条` : `${items.length} 条临时融合`}</span>
        <button type="button" className="button button--secondary" disabled={busy || selectedIds.size === 0} onClick={() => void deleteSelected()}>删除所选</button>
        <button type="button" className="button button--danger" disabled={busy || items.length === 0} onClick={() => setClearConfirmationOpen(true)}>清空全部临时融合</button>
      </div>
      <form className="map-search__form" role="search" onSubmit={(event) => { event.preventDefault(); search(); }}>
        <label className="sr-only" htmlFor="temporary-fusion-search-input">搜索当前临时融合草案</label>
        <input id="temporary-fusion-search-input" type="search" className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前草案" maxLength={400} />
        <button type="submit" className="button button--primary">搜索</button>
      </form>
      {error ? <p className="map-search__status map-search__status--error" role="alert">{apiErrorCopy(error).body}</p> : null}
      <ul className="temporary-fusion-observation__list" aria-label="临时融合列表">
        {visible.map((item) => (
          <li key={item.node.id}>
            <label className="temporary-fusion-observation__selection"><input type="checkbox" checked={selectedIds.has(item.node.id)} onChange={() => toggleSelected(item.node.id)} aria-label={`选择 ${item.label}`} />选择</label>
            <button type="button" onClick={() => open(item.node.id)} aria-pressed={selected?.node.id === item.node.id}>
              <strong>{item.label}</strong><span>{item.evidenceStatus === "verified" ? "证据已核验" : item.evidenceStatus === "pending" ? "等待核验" : "证据无效"}</span>
            </button>
            <button type="button" className="button button--secondary" disabled={busy} onClick={() => void deleteOne(item.node.id)}>删除</button>
            {"preview" in item && typeof item.preview === "string" ? <p>{item.preview}</p> : null}
          </li>
        ))}
      </ul>
      {visible.length === 0 ? <p className="map-search__status">没有匹配的当前临时融合。</p> : null}
      {selected ? (
        <article className="temporary-fusion-observation__detail" aria-label={`${selected.node.id} 的当前草案`}>
          <h3>当前草案 · v{selected.activeDraft.version}</h3>
          <p>{selected.activeDraft.evidenceStatus === "verified" ? "当前版本的判断已核验。" : selected.activeDraft.evidenceStatus === "pending" ? "仅受修改影响的判断正在等待核验。" : "当前版本包含不能保持已核验的判断。"}</p>
          {draftEditing ? <><label htmlFor="temporary-fusion-draft-body">修改草案（只在保存后创建新版本）</label><textarea id="temporary-fusion-draft-body" className="input" value={draftBody} onChange={(event) => setDraftBody(event.target.value)} maxLength={100000} /><button type="button" className="button button--primary" disabled={busy || !draftBody.trim()} onClick={() => void saveDraft()}>保存为新版本并核验</button><button type="button" className="button button--secondary" disabled={busy} onClick={() => { setDraftBody(selected.activeDraft.body); setDraftEditing(false); }}>取消</button></> : <><pre>{selected.activeDraft.body}</pre><button type="button" className="button button--secondary" disabled={busy} onClick={() => setDraftEditing(true)}>修改草案</button></>}
          <section aria-label="草案版本历史"><h3>版本历史</h3>{(() => { const versions = draftHistory?.versions ?? []; const currentIndex = versions.findIndex((version) => version.id === selected.activeDraft.id); const previous = currentIndex >= 0 ? versions[currentIndex + 1] : undefined; return previous ? <p aria-label="相邻版本差异">{adjacentDraftDifference(selected.activeDraft.body, previous.body)}</p> : null; })()}<ol>{draftHistory?.versions.map((version) => <li key={version.id}><strong>v{version.version}</strong> · {version.evidenceStatus === "verified" ? "已核验" : version.evidenceStatus === "pending" ? "待核验" : "无效"}{version.id === selected.activeDraft.id ? "（当前）" : <button type="button" className="button button--secondary" disabled={busy} onClick={() => void restoreDraft(version.id)}>撤销到此版本</button>}</li>)}</ol></section>
          <h3>正式来源</h3>
          <ul>{selected.candidateSources.map((source) => <li key={source.id}><button type="button" className="button button--secondary" onClick={() => onOpenSource(source)}>{sourceLabel(source)}</button></li>)}</ul>
          <section className="temporary-fusion-observation__conversation" aria-label="临时融合讨论">
            <h3>临时讨论</h3>
            <p>讨论只产生临时消息，不会修改当前草案、核验结果或正式研究节点。</p>
            <ol aria-label="临时讨论消息">
              {conversation?.messages.map((message) => <li key={message.id}><strong>{message.role === "user" ? "你" : "助手"}</strong><p>{message.content || (message.status === "pending" || message.status === "streaming" ? "正在生成…" : "未生成内容")}</p></li>)}
            </ol>
            {conversation?.tasks.filter((task) => task.status === "queued" || task.status === "running" || task.status === "failed").map((task) => (
              <p key={task.id} className="temporary-fusion-observation__task">
                {task.status === "failed" ? `生成失败：${task.error?.message ?? "可重试"}` : task.status === "running" ? "正在生成回复" : "等待生成"}
                {task.status === "failed" ? <button type="button" className="button button--secondary" disabled={busy} onClick={() => void retryTask(task.id)}>重试</button> : <button type="button" className="button button--secondary" disabled={busy} onClick={() => void cancelTask(task.id)}>取消</button>}
              </p>
            ))}
            <form onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
              <label htmlFor="temporary-fusion-message-input">围绕当前候选继续讨论</label>
              <textarea id="temporary-fusion-message-input" className="input" value={messageDraft} onChange={(event) => setMessageDraft(event.target.value)} maxLength={20_000} />
              <button type="submit" className="button button--primary" disabled={busy || !messageDraft.trim()}>发送讨论</button>
            </form>
          </section>
        </article>
      ) : null}
      {clearConfirmationOpen ? (
        <div className="temporary-fusion-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="temporary-fusion-clear-title" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setClearConfirmationOpen(false); } }}>
          <h3 id="temporary-fusion-clear-title">清空全部临时融合？</h3>
          <p>将删除全部临时融合、其草案版本和候选来源连接；不会删除或改写正式来源、正文和永久关系。</p>
          <div className="temporary-fusion-confirmation__actions">
            <button ref={cancelClearRef} type="button" className="button button--secondary" disabled={busy} onClick={() => setClearConfirmationOpen(false)}>取消</button>
            <button type="button" className="button button--danger" disabled={busy} onClick={() => void clearAll()}>确认清空全部临时融合</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
