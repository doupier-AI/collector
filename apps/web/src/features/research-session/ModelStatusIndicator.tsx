import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AiConfigurationView } from "@collector/capture-contracts";
import { useServices } from "../../app/services";

type ModelStatusState =
  | { kind: "loading" }
  | { kind: "ready"; config: AiConfigurationView }
  | { kind: "unavailable" };

function statusText(config: AiConfigurationView): string {
  if (config.mode === "demo") return "本地演示模式｜非真实 AI｜未联网检索";
  if (config.mode === "real") {
    const label = [config.provider, config.model].filter(Boolean).join(" · ");
    return label ? `模型：${label}` : "模型：已配置";
  }
  return "未配置模型｜点击配置";
}

/**
 * 会话页头的克制模型状态点。明确区分真实模型、本地演示与未配置，
 * 避免把演示回答或缺失模型当作真实 AI 能力；点击可进入模型设置。
 */
export function ModelStatusIndicator() {
  const { api } = useServices();
  const [state, setState] = useState<ModelStatusState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    // 旧客户端或测试替身可能不提供该接口；状态点静默省略，不影响会话内容
    const query = api.getAiConfiguration?.bind(api);
    if (!query) {
      setState({ kind: "unavailable" });
      return;
    }
    query()
      .then((config) => {
        if (!cancelled) setState({ kind: "ready", config });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (state.kind !== "ready") return null;
  const mode = state.config.mode;
  return (
    <Link className={`model-status model-status--${mode}`} to="/settings/ai-model">
      <span className="model-status__dot" aria-hidden="true" />
      {statusText(state.config)}
    </Link>
  );
}
