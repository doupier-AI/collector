import { useId, useState } from "react";
import type { FormEvent } from "react";
import { apiErrorCopy } from "../../api/errors";
import { useServices } from "../../app/services";

export interface PairingGateProps {
  /** 配对成功后调用，通常用于重新发起被 401 中断的加载。 */
  onPaired: () => void;
}

/**
 * 配对引导：输入 Collector 启动器显示的 6 位配对码换取 HttpOnly 会话 Cookie。
 * 前端不读取、不存储 Cookie；配对失败不循环请求。
 */
export function PairingGate({ onPaired }: PairingGateProps) {
  const { api } = useServices();
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const errorId = useId();

  const canSubmit = /^\d{6}$/.test(code.trim()) && !submitting;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.exchangePairingCode(code.trim());
      onPaired();
    } catch (cause) {
      setError(apiErrorCopy(cause).body);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page page--pairing">
      <h1 className="page__title">配对 Collector</h1>
      <p className="page__lead">Collector 需要配对后才能继续使用。请输入 Collector 启动器上显示的 6 位配对码。</p>
      <form className="pairing-form" onSubmit={handleSubmit}>
        <label className="pairing-form__label" htmlFor={inputId}>
          配对码
        </label>
        <div className="pairing-form__row">
          <input
            id={inputId}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="6 位数字"
            aria-describedby={error ? errorId : undefined}
            autoFocus
          />
          <button type="submit" className="button button--primary" disabled={!canSubmit}>
            {submitting ? "正在配对……" : "配对并继续"}
          </button>
        </div>
      </form>
      {error ? (
        <p className="form-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
      <p className="page__note">认证过期时需要重新配对；配对码只在你的本机有效。</p>
    </div>
  );
}
