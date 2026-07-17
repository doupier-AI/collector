import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { NetworkError, apiErrorCopy, isUnauthorized } from "../../api/errors";
import { useServices } from "../../app/services";
import { PairingGate } from "../auth/PairingGate";
import { ChatComposer } from "../chat-composer/ChatComposer";

/**
 * 开始页：不提前创建空会话。用户首次提交时才创建会话，
 * 拿到 201 立即把会话 id 写入路由，再由会话页提交第一条消息。
 */
export function StartPage() {
  const { api } = useServices();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<unknown>(null);
  const creatingRef = useRef(false);

  if (authError) {
    return <PairingGate onPaired={() => setAuthError(null)} />;
  }

  async function handleSubmit(content: string): Promise<boolean> {
    if (creatingRef.current) return false;
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const idempotencyKey = globalThis.crypto.randomUUID();
      const created = await api.createResearchSession();
      navigate(`/research/${encodeURIComponent(created.id)}`, {
        state: { firstTurn: { content, idempotencyKey } },
      });
      return true;
    } catch (error) {
      if (isUnauthorized(error)) {
        setAuthError(error);
        return false;
      }
      // 创建结果不确定时不盲目重建：保留草稿，提示重试
      setCreateError(error instanceof NetworkError ? "连接失败，请重试。" : apiErrorCopy(error).body);
      return false;
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  return (
    <div className="page page--start">
      <p className="page__brand">Collector</p>
      <h1 className="page__title">从一个问题开始</h1>
      <p className="page__lead">写下你正在理解的内容，Collector 会保存这次研究，并让你随时回来继续。</p>
      <ChatComposer
        draftScope="new"
        submitLabel="开始研究"
        externalError={createError}
        onSubmit={handleSubmit}
        autoFocus
      />
    </div>
  );
}
