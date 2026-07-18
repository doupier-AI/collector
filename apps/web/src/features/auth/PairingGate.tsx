import { useId, useState } from "react";
import type { FormEvent } from "react";
import { apiErrorCopy } from "../../api/errors";
import { useServices } from "../../app/services";
import { notifyPaired } from "./paired-event";

export interface PairingGateProps {
  /** 配对成功后调用，通常用于重新发起被 401 中断的加载。 */
  onPaired: () => void;
}

/**
 * 配对引导：启动器通常自动下发 HttpOnly 会话 Cookie；本页保留开发配对码入口。
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
      // 通知常驻区域（如默认展开的侧栏）配对已完成，触发自我刷新
      notifyPaired();
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
      <p className="page__lead">Collector 需要完成本机配对后才能继续。启动器通常会自动完成；如果未自动继续，请重新打开 Collector。</p>
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
      <p className="page__note">开发模式也可输入 6 位配对码；配对码只在你的本机有效。</p>
    </div>
  );
}
