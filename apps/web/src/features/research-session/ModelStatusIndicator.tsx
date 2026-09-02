import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AiConfigurationView, ProviderProfile } from "@collector/capture-contracts";
import { useServices } from "../../app/services";
import { notifyAiConfigurationChanged } from "./ai-configuration-events";

type ModelStatusState =
  | { kind: "loading" }
  | { kind: "ready"; config: AiConfigurationView }
  | { kind: "unavailable" };

function statusText(config: AiConfigurationView): string {
  if (config.mode === "demo") return "本地演示模式｜非真实 AI｜未联网检索";
  // 配置无效时显示具体原因（停用/缺 Key/解析失败），优先于"已配置"文案——
  // 界面可能显示已配置（credentialConfigured 布尔）而网关实际不可用。
  if (config.modelError) return `模型不可用：${config.modelError}`;
  if (config.mode === "real") {
    const label = [config.provider, config.model].filter(Boolean).join(" · ");
    return label ? `模型：${label}` : "模型：已配置";
  }
  return "未配置模型｜点击配置";
}

/**
 * 会话页头的克制模型状态点。明确区分真实模型、本地演示与未配置，
 * 避免把演示回答或缺失模型当作真实 AI 能力。
 * 点击展开已保存配置列表可直接切换当前模型（对应 CC Switch 的快速切换），
 * 底部保留进入模型设置的入口。
 */
export function ModelStatusIndicator({ variant = "status" }: { variant?: "status" | "picker" }) {
  const { api } = useServices();
  const [state, setState] = useState<ModelStatusState>({ kind: "loading" });
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<ProviderProfile[] | undefined>(undefined);
  const [switchingId, setSwitchingId] = useState<string | undefined>(undefined);
  const [switchError, setSwitchError] = useState<string | undefined>(undefined);

  const refreshConfig = useCallback((notify = false) => {
    // 旧客户端或测试替身可能不提供该接口；状态点静默省略，不影响会话内容
    const query = api.getAiConfiguration?.bind(api);
    if (!query) {
      setState({ kind: "unavailable" });
      return;
    }
    query()
      .then((config) => {
        setState({ kind: "ready", config });
        if (notify) notifyAiConfigurationChanged(config);
      })
      .catch(() => setState({ kind: "unavailable" }));
  }, [api]);

  useEffect(() => {
    refreshConfig();
  }, [refreshConfig]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [open]);

  const handleToggle = () => {
    const nextOpen = !open;
    setOpen(nextOpen);
    setSwitchError(undefined);
    if (nextOpen && profiles === undefined) {
      const list = api.listProviderProfiles?.bind(api);
      if (!list) {
        setProfiles([]);
        return;
      }
      list()
        .then((items) => setProfiles(items))
        .catch(() => setProfiles([]));
    }
  };

  const handleSwitch = async (profile: ProviderProfile) => {
    const activate = api.activateProviderProfile?.bind(api);
    if (!activate || switchingId) return;
    setSwitchError(undefined);
    setSwitchingId(profile.id);
    try {
      await activate(profile.id);
      refreshConfig(true);
      setOpen(false);
    } catch (cause) {
      setSwitchError(cause instanceof Error ? cause.message : "切换模型失败，请重试");
    } finally {
      setSwitchingId(undefined);
    }
  };

  if (state.kind !== "ready") return null;
  const mode = state.config.mode;
  const activeProfileId = state.config.providerProfileId;
  const switchable = (profiles ?? []).filter((profile) => profile.credentialConfigured && profile.enabled);

  return (
    <div className={`model-status-wrap model-status-wrap--${variant}`}>
      <button
        type="button"
        className={`model-status model-status--${mode}${variant === "picker" ? " model-status--picker" : ""}`}
        aria-label={variant === "picker" ? `选择模型，${statusText(state.config)}` : undefined}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={handleToggle}
      >
        <span className="model-status__dot" aria-hidden="true" />
        <span className="model-status__label">{statusText(state.config)}</span>
        {variant === "picker" ? (
          <svg className="model-status__chevron" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </button>
      {open ? (
        <>
          <button
            type="button"
            className="model-status__menu-overlay"
            aria-label="关闭模型切换菜单"
            onClick={() => setOpen(false)}
          />
          <div className="model-status__menu" role="menu" aria-label="切换模型配置">
            {switchable.length ? (
              switchable.map((profile) => {
                const isActive = profile.id === activeProfileId;
                return (
                  <button
                    key={profile.id}
                    type="button"
                    role="menuitem"
                    className={`model-status__menu-item${isActive ? " model-status__menu-item--active" : ""}`}
                    disabled={isActive || switchingId !== undefined}
                    onClick={() => void handleSwitch(profile)}
                  >
                    {switchingId === profile.id ? "切换中… " : ""}
                    {profile.displayName}（{profile.providerId} · {profile.model}）
                    {isActive ? " · 当前" : ""}
                  </button>
                );
              })
            ) : (
              <p className="model-status__menu-empty">还没有可用的模型配置</p>
            )}
            {switchError ? <p className="model-status__menu-error" role="alert">{switchError}</p> : null}
            <Link className="model-status__menu-settings" role="menuitem" to="/settings/ai-model" onClick={() => setOpen(false)}>
              模型设置…
            </Link>
          </div>
        </>
      ) : null}
    </div>
  );
}
