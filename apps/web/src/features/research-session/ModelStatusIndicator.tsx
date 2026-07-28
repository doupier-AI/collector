import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AiConfigurationView, ProviderProfile } from "@collector/capture-contracts";
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
 * 避免把演示回答或缺失模型当作真实 AI 能力。
 * 点击展开已保存配置列表可直接切换当前模型（对应 CC Switch 的快速切换），
 * 底部保留进入模型设置的入口。
 */
export function ModelStatusIndicator() {
  const { api } = useServices();
  const [state, setState] = useState<ModelStatusState>({ kind: "loading" });
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<ProviderProfile[] | undefined>(undefined);
  const [switchingId, setSwitchingId] = useState<string | undefined>(undefined);

  const refreshConfig = useCallback(() => {
    // 旧客户端或测试替身可能不提供该接口；状态点静默省略，不影响会话内容
    const query = api.getAiConfiguration?.bind(api);
    if (!query) {
      setState({ kind: "unavailable" });
      return;
    }
    query()
      .then((config) => setState({ kind: "ready", config }))
      .catch(() => setState({ kind: "unavailable" }));
  }, [api]);

  useEffect(() => {
    refreshConfig();
  }, [refreshConfig]);

  const handleToggle = () => {
    const nextOpen = !open;
    setOpen(nextOpen);
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
    setSwitchingId(profile.id);
    try {
      await activate(profile.id);
      refreshConfig();
      setOpen(false);
    } finally {
      setSwitchingId(undefined);
    }
  };

  if (state.kind !== "ready") return null;
  const mode = state.config.mode;
  const activeProfileId = state.config.providerProfileId;
  const switchable = (profiles ?? []).filter((profile) => profile.credentialConfigured);

  return (
    <div className="model-status-wrap">
      <button
        type="button"
        className={`model-status model-status--${mode}`}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={handleToggle}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        <span className="model-status__dot" aria-hidden="true" />
        {statusText(state.config)}
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
            <Link className="model-status__menu-settings" role="menuitem" to="/settings/ai-model" onClick={() => setOpen(false)}>
              模型设置…
            </Link>
          </div>
        </>
      ) : null}
    </div>
  );
}
