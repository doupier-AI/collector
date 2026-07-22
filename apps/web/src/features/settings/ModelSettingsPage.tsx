import { useState } from "react";
import type { ProviderProfileWithCredential, ProviderProfile } from "@collector/capture-contracts";
import { useModelSettings } from "./useModelSettings";
import { Skeleton } from "../../components/Skeleton/Skeleton";

type ApiKeyFieldMode = "new" | "keep" | "clear";

export function ModelSettingsPage() {
  const ctrl = useModelSettings();
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [apiKeyMode, setApiKeyMode] = useState<ApiKeyFieldMode>("new");

  if (ctrl.state.kind === "loading") {
    return (
      <div className="model-settings">
        <h1 className="model-settings__title">模型设置</h1>
        <Skeleton variant="title" width="60%" />
        <Skeleton variant="text" width="40%" />
        <Skeleton variant="block" />
        <Skeleton variant="block" />
      </div>
    );
  }

  if (ctrl.state.kind === "error") {
    return (
      <div className="model-settings">
        <h1 className="model-settings__title">模型设置</h1>
        <p className="form-error" role="alert">{ctrl.state.error}</p>
        <button className="button button--secondary" onClick={() => window.location.reload()}>重试</button>
      </div>
    );
  }

  const { catalog, profiles, activeId } = ctrl.state;
  const editingProfile = ctrl.formMode.kind === "edit" ? ctrl.formMode.profile : undefined;
  const isEditing = editingProfile !== undefined;

  function handleOpenCreate() {
    setApiKeyValue("");
    setApiKeyMode("new");
    ctrl.openCreateForm();
  }

  function handleOpenEdit(profile: ProviderProfile) {
    setApiKeyValue("");
    setApiKeyMode("keep");
    ctrl.openEditForm(profile);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const isEdit = ctrl.formMode.kind === "edit";
    const providerId = (form.get("providerId") as string) || editingProfile?.providerId || "";
    const input: ProviderProfileWithCredential = {
      id: isEdit ? editingProfile!.id : undefined,
      providerId,
      displayName: form.get("displayName") as string,
      model: form.get("model") as string,
      enabled: form.get("enabled") === "on",
    };
    const baseUrl = form.get("baseUrl") as string;
    if (baseUrl) input.baseUrl = baseUrl;

    if (apiKeyMode === "new" && apiKeyValue.trim()) {
      input.credential = apiKeyValue.trim();
    } else if (apiKeyMode === "clear") {
      input.credential = "";
    }
    // "keep" mode: omit credential entirely (undefined = no change)

    void ctrl.saveProfile(input);
  }

  const selectedProviderId = ctrl.formMode.kind === "edit" ? ctrl.formMode.profile.providerId : undefined;
  const selectedDefinition = selectedProviderId ? catalog.find((d) => d.id === selectedProviderId) : undefined;

  return (
    <div className="model-settings">
      <h1 className="model-settings__title">模型设置</h1>
      <p className="model-settings__lead">管理 AI 模型提供商配置：保存多个配置、测试连接、查看联网能力。</p>

      {profiles.length === 0 && ctrl.formMode.kind === "closed" ? (
        <p className="model-settings__empty">暂无已保存的配置，点击下方按钮添加。</p>
      ) : (
        <ul className="model-settings__list">
          {profiles.map((profile) => {
            const def = catalog.find((d) => d.id === profile.providerId);
            const isActive = profile.id === activeId;
            const isDeleting = ctrl.deletingId === profile.id;
            return (
              <li key={profile.id} className={`profile-card${isActive ? " profile-card--active" : ""}`}>
                <div className="profile-card__header">
                  <div>
                    <span className="profile-card__name">{profile.displayName}</span>
                    {isActive ? <span className="profile-card__badge profile-card__badge--active">当前使用</span> : null}
                  </div>
                  <span className="profile-card__provider">{def?.label ?? profile.providerId}</span>
                </div>
                <div className="profile-card__meta">
                  <span className="profile-card__model">模型：{profile.model}</span>
                  {def ? (
                    <span className={`profile-card__grounding ${def.capabilities.webGrounding !== "unsupported" ? "profile-card__grounding--supported" : ""}`}>
                      {def.groundingDescription}
                    </span>
                  ) : null}
                  <span className="profile-card__credential">
                    {profile.credentialConfigured ? "API Key 已配置" : "未配置 API Key"}
                  </span>
                </div>
                <div className="profile-card__actions">
                  <button
                    type="button"
                    className="button button--secondary"
                    onClick={() => { void ctrl.testConnection(profile.id); }}
                    disabled={ctrl.testing || !profile.credentialConfigured}
                  >
                    {ctrl.testing ? "测试中…" : "测试连接"}
                  </button>
                  {!isActive ? (
                    <button
                      type="button"
                      className="button button--secondary"
                      onClick={() => { void ctrl.activateProfile(profile.id); }}
                      disabled={!profile.credentialConfigured}
                    >
                      设为活跃
                    </button>
                  ) : null}
                  <button type="button" className="button button--ghost" onClick={() => handleOpenEdit(profile)}>
                    编辑
                  </button>
                  {isDeleting ? (
                    <>
                      <button type="button" className="button button--primary" onClick={() => { void ctrl.deleteProfile(profile.id); }}>
                        确认删除
                      </button>
                      <button type="button" className="button button--ghost" onClick={ctrl.cancelDelete}>
                        取消
                      </button>
                    </>
                  ) : (
                    <button type="button" className="button button--ghost" onClick={() => ctrl.confirmDelete(profile.id)} disabled={isActive}>
                      删除
                    </button>
                  )}
                </div>
                {ctrl.testResult && (
                  <p className={`connection-test ${ctrl.testResult.ok ? "connection-test--ok" : "connection-test--fail"}`} role="status">
                    {ctrl.testResult.ok ? `连接成功 — 模型：${ctrl.testResult.model ?? profile.model}` : `连接失败 — ${ctrl.testResult.error}`}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {ctrl.formMode.kind !== "closed" ? (
        <form className="profile-form" onSubmit={handleSubmit}>
          <h2 className="profile-form__title">{isEditing ? "编辑配置" : "添加配置"}</h2>

          <div className="profile-form__field">
            <label className="profile-form__label" htmlFor="pf-provider">供应商</label>
            <select id="pf-provider" name="providerId" className="profile-form__select" defaultValue={editingProfile?.providerId ?? ""} disabled={isEditing} required>
              <option value="" disabled>选择供应商…</option>
              {catalog.map((def) => (
                <option key={def.id} value={def.id}>{def.label}{def.capabilities.webGrounding !== "unsupported" ? "（支持联网）" : ""}</option>
              ))}
            </select>
          </div>

          <div className="profile-form__field">
            <label className="profile-form__label" htmlFor="pf-displayName">配置名称</label>
            <input id="pf-displayName" name="displayName" className="profile-form__input" defaultValue={editingProfile?.displayName ?? ""} required maxLength={80} placeholder="例如：我的 DeepSeek" />
          </div>

          <div className="profile-form__field">
            <label className="profile-form__label" htmlFor="pf-model">模型</label>
            {selectedDefinition && selectedDefinition.models.length > 0 ? (
              <select id="pf-model" name="model" className="profile-form__select" defaultValue={editingProfile?.model ?? selectedDefinition.defaultModel} required>
                {selectedDefinition.models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input id="pf-model" name="model" className="profile-form__input" defaultValue={editingProfile?.model ?? ""} required maxLength={200} placeholder="输入模型名称…" />
            )}
          </div>

          {(selectedDefinition?.id.startsWith("custom") || editingProfile?.providerId.startsWith("custom")) ? (
            <div className="profile-form__field">
              <label className="profile-form__label" htmlFor="pf-baseUrl">Base URL</label>
              <input id="pf-baseUrl" name="baseUrl" className="profile-form__input" defaultValue={editingProfile?.baseUrl ?? ""} placeholder="https://api.example.com/v1" />
            </div>
          ) : null}

          <div className="profile-form__field">
            <label className="profile-form__label" htmlFor="pf-apiKey">API Key</label>
            {isEditing ? (
              <div className="profile-form__key-actions">
                <label className="profile-form__radio">
                  <input type="radio" name="apiKeyMode" checked={apiKeyMode === "keep"} onChange={() => setApiKeyMode("keep")} />
                  保持已保存的密钥不变
                </label>
                <label className="profile-form__radio">
                  <input type="radio" name="apiKeyMode" checked={apiKeyMode === "new"} onChange={() => setApiKeyMode("new")} />
                  更新密钥
                </label>
                <label className="profile-form__radio">
                  <input type="radio" name="apiKeyMode" checked={apiKeyMode === "clear"} onChange={() => setApiKeyMode("clear")} />
                  清除已保存的密钥
                </label>
              </div>
            ) : null}
            {(apiKeyMode !== "keep" || !isEditing) ? (
              <input
                id="pf-apiKey"
                name="apiKey"
                type="password"
                className="profile-form__input"
                value={apiKeyValue}
                onChange={(e) => setApiKeyValue(e.target.value)}
                placeholder={isEditing ? "输入新密钥（留空不修改）" : "输入 API Key…"}
                autoComplete="off"
              />
            ) : null}
            <p className="profile-form__hint">密钥仅存储在本机，不会上传到任何服务器。</p>
          </div>

          {ctrl.saveError ? <p className="form-error" role="alert">{ctrl.saveError}</p> : null}

          <div className="profile-form__actions">
            <button type="button" className="button button--ghost" onClick={ctrl.closeForm}>取消</button>
            <button type="submit" className="button button--primary" disabled={ctrl.saving}>
              {ctrl.saving ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="model-settings__add-button" onClick={handleOpenCreate}>
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><line x1="10" y1="4" x2="10" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><line x1="4" y1="10" x2="16" y2="10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          添加模型配置
        </button>
      )}
    </div>
  );
}
