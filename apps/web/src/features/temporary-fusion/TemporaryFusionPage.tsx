import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type {
  ResearchTemporaryFusionBundle,
  ResearchTemporaryFusionConversationView,
  ResearchTemporaryFusionDraftHistory,
} from "@collector/capture-contracts";
import { apiErrorCopy } from "../../api/errors";
import { stableNodePath } from "../../app/paths";
import { useServices } from "../../app/services";
import { formatSessionTime } from "../research-session/format";
import { TemporaryFusionConversation } from "./TemporaryFusionConversation";
import { TemporaryFusionDetails, TemporaryFusionDraft } from "./TemporaryFusionCandidate";

interface TemporaryFusionPageState {
  bundle: ResearchTemporaryFusionBundle;
  conversation: ResearchTemporaryFusionConversationView;
  history: ResearchTemporaryFusionDraftHistory;
  label: string;
}

export function TemporaryFusionPage() {
  const { temporaryFusionId = "" } = useParams();
  const { api } = useServices();
  const navigate = useNavigate();
  const [state, setState] = useState<TemporaryFusionPageState>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [draftEditing, setDraftEditing] = useState(false);
  const [draftBody, setDraftBody] = useState("");
  const [loadNonce, setLoadNonce] = useState(0);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError(undefined);
    Promise.all([
      api.getTemporaryFusion(temporaryFusionId),
      api.getTemporaryFusionConversation(temporaryFusionId),
      api.getTemporaryFusionDraftHistory(temporaryFusionId),
      api.listTemporaryFusions(),
    ]).then(
      ([bundle, conversation, history, items]) => {
        if (stale) return;
        setState({ bundle, conversation, history, label: items.find((item) => item.node.id === temporaryFusionId)?.label ?? "临时融合候选" });
        setDraftBody(bundle.activeDraft.body);
        setLoading(false);
      },
      (nextError) => {
        if (stale) return;
        setError(nextError);
        setLoading(false);
      },
    );
    return () => { stale = true; };
  }, [api, loadNonce, temporaryFusionId]);

  const refresh = useCallback(async () => {
    try {
      const [conversation, history] = await Promise.all([
        api.getTemporaryFusionConversation(temporaryFusionId),
        api.getTemporaryFusionDraftHistory(temporaryFusionId),
      ]);
      setState((current) => current ? { ...current, bundle: conversation.bundle, conversation, history } : current);
      if (!draftEditing) setDraftBody(conversation.bundle.activeDraft.body);
      setError(undefined);
    } catch (nextError) {
      setError(nextError);
    }
  }, [api, draftEditing, temporaryFusionId]);

  const needsPolling = Boolean(state && (
    state.bundle.activeDraft.evidenceStatus === "pending"
    || state.conversation.messages.some((message) => message.status === "pending" || message.status === "streaming")
    || state.conversation.tasks.some((task) => task.status === "queued" || task.status === "running")
  ));

  useEffect(() => {
    if (!needsPolling) return;
    const timer = window.setInterval(() => { void refresh(); }, 1_000);
    return () => window.clearInterval(timer);
  }, [needsPolling, refresh]);

  const saveDraft = async () => {
    if (!state || busy || !draftBody.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.updateTemporaryFusionDraft(temporaryFusionId, { body: draftBody, expectedDraftVersionId: state.bundle.activeDraft.id });
      const history = await api.getTemporaryFusionDraftHistory(temporaryFusionId);
      setState((current) => current ? { ...current, bundle: result.bundle, history } : current);
      setDraftBody(result.bundle.activeDraft.body);
      setDraftEditing(false);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  };

  const restoreDraft = async (versionId: string) => {
    if (!state || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.restoreTemporaryFusionDraft(temporaryFusionId, versionId, state.bundle.activeDraft.id);
      const history = await api.getTemporaryFusionDraftHistory(temporaryFusionId);
      setState((current) => current ? { ...current, bundle: result.bundle, history } : current);
      setDraftBody(result.bundle.activeDraft.body);
      setDraftEditing(false);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!state || busy || state.bundle.activeDraft.evidenceStatus !== "verified") return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.confirmTemporaryFusion(temporaryFusionId, state.bundle.activeDraft.id);
      navigate(stableNodePath(result.fusionNode.id), { replace: true });
    } catch (nextError) {
      setError(nextError);
      setBusy(false);
    }
  };

  const sendMessage = async (message: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(undefined);
    try {
      await api.submitTemporaryFusionMessage(temporaryFusionId, message, crypto.randomUUID());
      await refresh();
      return true;
    } catch (nextError) {
      setError(nextError);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const runTaskAction = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await action();
      await refresh();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="page temporary-fusion-page"><p className="temporary-fusion-page__loading" role="status">正在打开临时融合候选…</p></div>;
  }

  if (!state) {
    return (
      <div className="page temporary-fusion-page">
        <section className="temporary-fusion-page__unavailable" role="alert">
          <h1>无法打开这个临时融合</h1>
          <p>{error ? apiErrorCopy(error).body : "候选可能已被删除或确认。"}</p>
          <div className="temporary-fusion-page__unavailable-actions">
            <button type="button" className="button button--primary" onClick={() => setLoadNonce((nonce) => nonce + 1)}>重试</button>
            <Link className="button button--secondary" to="/map">返回研究图谱</Link>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="page temporary-fusion-page">
      <header className="temporary-fusion-page__header">
        <Link className="temporary-fusion-page__back" to="/map">← 返回研究图谱</Link>
        <div className="temporary-fusion-page__title-row">
          <div>
            <p className="temporary-fusion-page__kind"><span>临时融合</span> 尚未进入正式研究</p>
            <h1 className="page__title">{state.label}</h1>
            <p className="temporary-fusion-page__meta">更新于 {formatSessionTime(state.bundle.node.updatedAt)}</p>
          </div>
        </div>
      </header>

      {error ? <p className="temporary-fusion-page__error" role="alert">{apiErrorCopy(error).body}</p> : null}

      <div className="temporary-fusion-page__layout">
        <div className="temporary-fusion-page__main">
          <TemporaryFusionDraft
            bundle={state.bundle}
            draftBody={draftBody}
            editing={draftEditing}
            busy={busy}
            onBeginEdit={() => setDraftEditing(true)}
            onChangeDraft={setDraftBody}
            onCancelEdit={() => { setDraftBody(state.bundle.activeDraft.body); setDraftEditing(false); }}
            onSaveDraft={() => void saveDraft()}
          />
          <TemporaryFusionConversation
            view={state.conversation}
            busy={busy}
            onSend={sendMessage}
            onCancelTask={(taskId) => void runTaskAction(() => api.cancelTemporaryFusionTask(taskId))}
            onRetryTask={(taskId) => void runTaskAction(() => api.retryTemporaryFusionTask(taskId))}
          />
        </div>
        <TemporaryFusionDetails
          bundle={state.bundle}
          history={state.history}
          busy={busy}
          onRestoreDraft={(versionId) => void restoreDraft(versionId)}
          onConfirm={() => void confirm()}
        />
      </div>
    </div>
  );
}
