import { useCallback, useEffect, useState } from "react";
import type { ProviderDefinition, ProviderProfile } from "@collector/capture-contracts";
import { useServices } from "../../app/services";
import { Skeleton } from "../../components/Skeleton/Skeleton";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; catalog: ProviderDefinition[]; activeProfile?: ProviderProfile; profiles: ProviderProfile[] };

/**
 * 已保存的模型配置列表：展示全部 ProviderProfile，支持编辑、激活与删除。
 */
export function ProviderProfileList({
  profiles,
  activeProfile,
  onActivate,
  onEdit,
  onDelete,
}: {
  profiles: ProviderProfile[];
  activeProfile?: ProviderProfile;
  onActivate: (id: string) => void;
  onEdit: (profile: ProviderProfile) => void;
  onDelete: (id: string) => void;
}) {
  if (!profiles.length) return null;
  return (
    <section className="settings-profile-list" aria-label="已保存的模型配置">
      <h2 className="settings-profile-list__title">已保存的模型配置</h2>
      {profiles.map((profile) => {
        const isActive = activeProfile?.id === profile.id;
        return (
          <div key={profile.id} className={`settings-profile-item${isActive ? " settings-profile-item--active" : ""}`}>
            <div>
              <p className="settings-profile-item__name">{profile.displayName}</p>
              <p className="settings-profile-item__meta">
                {profile.providerId} · {profile.model}
                {isActive ? " · 当前使用" : ""}
                {profile.credentialConfigured ? "" : " · 未配置 Key"}
              </p>
            </div>
            <div className="settings-profile-item__actions">
              {!isActive && profile.credentialConfigured ? (
                <button type="button" className="button button--secondary" onClick={() => onActivate(profile.id)}>
                  设为当前
                </button>
              ) : null}
              <button type="button" className="button button--secondary" onClick={() => onEdit(profile)}>
                编辑
              </button>
              <button type="button" className="button button--ghost" onClick={() => onDelete(profile.id)}>
                删除
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

/**
 * AI 模型设置页：加载供应商目录与当前配置，提供新建、编辑、测试、激活、删除能力。
 * API Key 只在组件内存中，提交后立即清空，不写入 localStorage/URL/日志。
 */
export function AiModelSettingsPage() {
  const { api } = useServices();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [editingProfile, setEditingProfile] = useState<ProviderProfile | undefined>(undefined);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const [catalog, profiles, activeProfile] = await Promise.all([
        api.getProviderCatalog(),
        api.listProviderProfiles(),
        api.getActiveProviderProfile().catch(() => undefined),
      ]);
      setState({ kind: "ready", catalog, profiles, activeProfile });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "加载模型设置失败" });
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load, reloadNonce]);

  const handleSaved = useCallback(() => {
    setEditingProfile(undefined);
    setReloadNonce((nonce) => nonce + 1);
  }, []);

  const handleActivate = useCallback(
    async (id: string) => {
      await api.activateProviderProfile(id);
      setReloadNonce((nonce) => nonce + 1);
    },
    [api],
  );

  const handleEdit = useCallback((profile: ProviderProfile) => {
    setEditingProfile(profile);
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      await api.deleteProviderProfile(id);
      setEditingProfile((current) => (current?.id === id ? undefined : current));
      setReloadNonce((nonce) => nonce + 1);
    },
    [api],
  );

  if (state.kind === "loading") {
    return (
      <div className="page">
        <Skeleton variant="title" />
        <Skeleton variant="block" lines={4} />
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="page">
        <p className="form-error" role="alert">{state.message}</p>
        <button type="button" className="button button--secondary" onClick={() => setReloadNonce((nonce) => nonce + 1)}>
          重新加载
        </button>
      </div>
    );
  }

  return (
    <div className="page">
      <h1 className="page__title">AI 模型设置</h1>
      <p className="page__lead">
        选择模型供应商并输入 API Key。可保存多套配置并随时切换，配置保存在本机，下次启动 Collector 时自动恢复。
      </p>
      <ProviderProfileForm
        key={editingProfile?.id ?? "new"}
        catalog={state.catalog}
        activeProfile={state.activeProfile}
        editingProfile={editingProfile}
        onSaved={handleSaved}
        onCancelEdit={() => setEditingProfile(undefined)}
      />
      <ProviderProfileList
        profiles={state.profiles}
        activeProfile={state.activeProfile}
        onActivate={handleActivate}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />
    </div>
  );
}

interface ProviderProfileFormProps {
  catalog: ProviderDefinition[];
  activeProfile?: ProviderProfile;
  /** 提供时表单进入编辑模式；API Key 留空表示保持已保存的 Key。 */
  editingProfile?: ProviderProfile;
  onSaved: () => void;
  onCancelEdit: () => void;
}

type FormStatus =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "saving" }
  | { kind: "discovering" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

/**
 * 模型配置表单：供应商、配置名称、模型（可一键获取可调用列表）、API Key、自定义 Base URL。
 * 新建模式保存新配置；编辑模式更新已有配置。支持「测试连接」「仅保存」「保存并启用」。
 */
function ProviderProfileForm({ catalog, activeProfile, editingProfile, onSaved, onCancelEdit }: ProviderProfileFormProps) {
  const { api } = useServices();
  const [providerId, setProviderId] = useState(editingProfile?.providerId ?? activeProfile?.providerId ?? catalog[0]?.id ?? "");
  const [model, setModel] = useState(editingProfile?.model ?? activeProfile?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(editingProfile?.baseUrl ?? activeProfile?.baseUrl ?? "");
  const [displayName, setDisplayName] = useState(editingProfile?.displayName ?? activeProfile?.displayName ?? "");
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [status, setStatus] = useState<FormStatus>({ kind: "idle" });

  const definition = catalog.find((item) => item.id === providerId);
  const isCustom = definition?.id.startsWith("custom") ?? false;
  const editing = editingProfile !== undefined;
  const effectiveModel = model.trim() || definition?.defaultModel || "";
  const effectiveDisplayName = displayName.trim() || definition?.label || "";
  const modelOptions = [...new Set([...discoveredModels, ...(definition?.models ?? [])])];
  const busy = status.kind === "testing" || status.kind === "saving" || status.kind === "discovering";

  const handleProviderChange = (nextProviderId: string) => {
    setProviderId(nextProviderId);
    const nextDefinition = catalog.find((item) => item.id === nextProviderId);
    if (nextDefinition) {
      setModel(nextDefinition.defaultModel);
      setBaseUrl(nextDefinition.defaultBaseUrl);
      setDisplayName(nextDefinition.label);
    }
    setDiscoveredModels([]);
  };

  const buildPayload = () => ({
    providerId,
    displayName: effectiveDisplayName,
    model: effectiveModel,
    baseUrl: isCustom ? baseUrl : undefined,
    apiKey: apiKey.trim(),
  });

  const buildDiscoveryPayload = () => ({
    providerId,
    baseUrl: isCustom ? baseUrl : undefined,
    apiKey: apiKey.trim() || undefined,
    profileId: !apiKey.trim() && editingProfile?.credentialConfigured ? editingProfile.id : undefined,
  });

  const handleTest = async () => {
    if (!apiKey.trim()) {
      setStatus({ kind: "error", message: "请先输入 API Key" });
      return;
    }
    setStatus({ kind: "testing" });
    try {
      const result = await api.testProviderProfileConfig(buildPayload());
      setStatus(result.ok
        ? { kind: "success", message: `连接成功：${result.model}${result.durationMs != null ? ` · ${(result.durationMs / 1000).toFixed(1)}s` : ""}` }
        : { kind: "error", message: result.error });
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : "连接测试失败" });
    }
  };

  const handleDiscover = async () => {
    if (!apiKey.trim() && !editingProfile?.credentialConfigured) {
      setStatus({ kind: "error", message: "请先输入 API Key 后再获取模型列表" });
      return;
    }
    setStatus({ kind: "discovering" });
    try {
      const result = await api.discoverProviderModels(buildDiscoveryPayload());
      if (result.ok) {
        setDiscoveredModels(result.models);
        setStatus({ kind: "success", message: `已获取 ${result.models.length} 个可调用模型，可在模型输入框中下拉选择` });
      } else {
        setStatus({ kind: "error", message: result.error });
      }
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : "获取模型列表失败" });
    }
  };

  const handleSave = async (activate: boolean) => {
    if (!editing && !apiKey.trim()) {
      setStatus({ kind: "error", message: "新配置需要输入 API Key" });
      return;
    }
    setStatus({ kind: "saving" });
    try {
      await api.saveProviderProfile({
        ...(editing ? { id: editingProfile.id } : {}),
        ...buildPayload(),
        ...(apiKey.trim() ? {} : { apiKey: undefined }),
        activate,
      });
      setApiKey("");
      setStatus({ kind: "success", message: activate ? "已保存并启用" : "已保存" });
      onSaved();
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : "保存失败" });
    }
  };

  return (
    <form className="settings-form" onSubmit={(event) => { event.preventDefault(); void handleSave(true); }}>
      {editing ? (
        <p className="settings-form__hint" role="status">
          正在编辑配置「{editingProfile.displayName}」
          <button type="button" className="button button--ghost" onClick={onCancelEdit}>取消编辑</button>
        </p>
      ) : null}

      <div className="settings-form__field">
        <label className="settings-form__label" htmlFor="provider-select">模型供应商</label>
        <select
          id="provider-select"
          className="settings-form__select"
          value={providerId}
          disabled={editing}
          onChange={(event) => handleProviderChange(event.target.value)}
        >
          {catalog.map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </select>
        {editing ? <p className="settings-form__hint">已有配置的供应商类型不可修改；如需更换请新建配置。</p> : null}
      </div>

      <div className="settings-form__field">
        <label className="settings-form__label" htmlFor="display-name-input">配置名称</label>
        <input
          id="display-name-input"
          className="settings-form__input"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder={definition?.label ?? "例如：我的 OpenAI"}
        />
      </div>

      <div className="settings-form__field">
        <label className="settings-form__label" htmlFor="model-input">模型</label>
        <div className="settings-form__inline">
          <input
            id="model-input"
            className="settings-form__input"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder={definition?.defaultModel ?? "模型名称"}
            list="model-options"
          />
          <button
            type="button"
            className="button button--secondary"
            disabled={busy}
            onClick={() => void handleDiscover()}
          >
            {status.kind === "discovering" ? "获取中…" : "获取模型"}
          </button>
        </div>
        <datalist id="model-options">
          {modelOptions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
        <p className="settings-form__hint">可直接输入，或点击「获取模型」从供应商拉取可调用模型后下拉选择。</p>
      </div>

      {isCustom ? (
        <div className="settings-form__field">
          <label className="settings-form__label" htmlFor="base-url-input">Base URL</label>
          <input
            id="base-url-input"
            className="settings-form__input"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.example.com/v1"
          />
          <p className="settings-form__hint">自定义兼容端点必须使用 HTTPS 公网地址。</p>
        </div>
      ) : null}

      <div className="settings-form__field">
        <label className="settings-form__label" htmlFor="api-key-input">API Key</label>
        <input
          id="api-key-input"
          className="settings-form__input"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={editing && editingProfile.credentialConfigured ? "已保存，留空则保持不变" : "输入 API Key"}
          autoComplete="off"
        />
        <p className="settings-form__hint">Key 只保存在本机服务中，不会上传到 Collector 服务器。</p>
      </div>

      <div className="settings-form__actions">
        <button
          type="button"
          className="button button--secondary"
          disabled={busy}
          onClick={() => void handleTest()}
        >
          {status.kind === "testing" ? "测试中…" : "测试连接"}
        </button>
        <button
          type="button"
          className="button button--secondary"
          disabled={busy}
          onClick={() => void handleSave(false)}
        >
          仅保存
        </button>
        <button
          type="submit"
          className="button button--primary"
          disabled={busy}
        >
          {status.kind === "saving" ? "保存中…" : "保存并启用"}
        </button>
      </div>

      {status.kind === "success" ? <p className="settings-status settings-status--ok">{status.message}</p> : null}
      {status.kind === "error" ? <p className="settings-status settings-status--error" role="alert">{status.message}</p> : null}
    </form>
  );
}
