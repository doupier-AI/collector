import { useCallback, useEffect, useState } from "react";
import type { ModelPurpose, ModelRoutingView, ProviderDefinition, ProviderProfile } from "@collector/capture-contracts";
import { useServices } from "../../app/services";
import { Skeleton } from "../../components/Skeleton/Skeleton";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; catalog: ProviderDefinition[]; activeProfile?: ProviderProfile; profiles: ProviderProfile[]; routing: ModelRoutingView };

/**
 * 把模型 ID 按家族分组（借鉴 CC Switch 的分组下拉）：
 * 含 "/" 的按前缀分组（如 deepseek-ai/DeepSeek-V3.2 → deepseek-ai），
 * 否则按 "-" 首段分组（如 gpt-4.1-mini → gpt）。保持首次出现顺序。
 */
export function groupModelsByFamily(models: string[]): Array<{ family: string; models: string[] }> {
  const groups: Array<{ family: string; models: string[] }> = [];
  const index = new Map<string, number>();
  for (const model of models) {
    const slash = model.indexOf("/");
    const family = slash > 0 ? model.slice(0, slash) : (model.split("-")[0] || model);
    let slot = index.get(family);
    if (slot === undefined) {
      slot = groups.length;
      index.set(family, slot);
      groups.push({ family, models: [] });
    }
    groups[slot].models.push(model);
  }
  return groups;
}

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
      const [catalog, profiles, activeProfile, routing] = await Promise.all([
        api.getProviderCatalog(),
        api.listProviderProfiles(),
        api.getActiveProviderProfile().catch(() => undefined),
        // 旧客户端或测试替身可能不提供该接口；分配区块按全部跟随当前配置展示
        api.getModelRouting?.().catch(() => ({ routes: [] })) ?? Promise.resolve({ routes: [] }),
      ]);
      setState({ kind: "ready", catalog, profiles, activeProfile, routing });
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

  const handleRoutingChange = useCallback(
    async (purpose: ModelPurpose, profileId: string | null) => {
      if (!api.setModelRouting) throw new Error("当前客户端不支持任务模型分配");
      const next = await api.setModelRouting(purpose, profileId);
      setState((current) => (current.kind === "ready" ? { ...current, routing: next } : current));
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
        profiles={state.profiles}
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
      <ModelRoutingSection
        profiles={state.profiles}
        routing={state.routing}
        onChange={handleRoutingChange}
      />
    </div>
  );
}

const PURPOSE_LABELS: Record<ModelPurpose, string> = {
  chat: "对话与问答",
  selection: "选区分析",
  research: "深入研究",
  search: "联网搜索",
  document: "文档生成与整理",
};

const PURPOSE_ORDER: ModelPurpose[] = ["chat", "selection", "research", "search", "document"];

/**
 * 任务模型分配：按任务类型指定使用哪套已保存配置；
 * 默认「跟随当前配置」，即全部任务使用上方激活的配置。
 */
export function ModelRoutingSection({
  profiles,
  routing,
  onChange,
}: {
  profiles: ProviderProfile[];
  routing: ModelRoutingView;
  onChange: (purpose: ModelPurpose, profileId: string | null) => Promise<void>;
}) {
  const [error, setError] = useState<string | undefined>(undefined);
  const [pendingPurpose, setPendingPurpose] = useState<ModelPurpose | undefined>(undefined);
  const assignable = profiles.filter((profile) => profile.credentialConfigured);
  if (!assignable.length) return null;

  const handleSelect = async (purpose: ModelPurpose, value: string) => {
    setError(undefined);
    setPendingPurpose(purpose);
    try {
      await onChange(purpose, value || null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存任务模型分配失败");
    } finally {
      setPendingPurpose(undefined);
    }
  };

  return (
    <section className="settings-profile-list" aria-label="任务模型分配">
      <h2 className="settings-profile-list__title">任务模型分配</h2>
      <p className="settings-form__hint">
        不同任务可以使用不同配置，例如用更快的模型做选区分析、用更强的模型做深入研究。不指定时全部跟随当前配置。
      </p>
      {PURPOSE_ORDER.map((purpose) => {
        const assigned = routing.routes.find((route) => route.purpose === purpose)?.profileId ?? "";
        return (
          <div key={purpose} className="settings-form__field settings-routing__row">
            <label className="settings-form__label" htmlFor={`routing-${purpose}`}>{PURPOSE_LABELS[purpose]}</label>
            <select
              id={`routing-${purpose}`}
              className="settings-form__select"
              value={assigned}
              disabled={pendingPurpose !== undefined}
              onChange={(event) => void handleSelect(purpose, event.target.value)}
            >
              <option value="">跟随当前配置</option>
              {assignable.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.displayName}（{profile.providerId} · {profile.model}）
                </option>
              ))}
            </select>
          </div>
        );
      })}
      {error ? <p className="settings-status settings-status--error" role="alert">{error}</p> : null}
    </section>
  );
}

interface ProviderProfileFormProps {
  catalog: ProviderDefinition[];
  activeProfile?: ProviderProfile;
  /** 已保存配置：用于在批量勾选列表中标记已存在的模型，防止重复添加。 */
  profiles: ProviderProfile[];
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
 * 新建模式下「获取模型」成功后展示可勾选列表：勾选多个模型后保存，
 * 会为每个勾选模型各生成一套配置（共用同一个 Key，借鉴 CC Switch 一次配置多个模型）。
 */
function ProviderProfileForm({ catalog, activeProfile, profiles, editingProfile, onSaved, onCancelEdit }: ProviderProfileFormProps) {
  const { api } = useServices();
  const [providerId, setProviderId] = useState(editingProfile?.providerId ?? activeProfile?.providerId ?? catalog[0]?.id ?? "");
  const [model, setModel] = useState(editingProfile?.model ?? activeProfile?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(editingProfile?.baseUrl ?? activeProfile?.baseUrl ?? "");
  const [displayName, setDisplayName] = useState(editingProfile?.displayName ?? activeProfile?.displayName ?? "");
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [checkedModels, setCheckedModels] = useState<string[]>([]);
  const [status, setStatus] = useState<FormStatus>({ kind: "idle" });

  const definition = catalog.find((item) => item.id === providerId);
  const isCustom = definition?.id.startsWith("custom") ?? false;
  const editing = editingProfile !== undefined;
  const effectiveModel = model.trim() || definition?.defaultModel || "";
  const effectiveDisplayName = displayName.trim() || definition?.label || "";
  const modelOptions = [...new Set([...discoveredModels, ...(definition?.models ?? [])])];
  const busy = status.kind === "testing" || status.kind === "saving" || status.kind === "discovering";
  // 同厂商已保存的模型：勾选列表中标记"已保存"，防止批量添加产生重复配置
  const existingModels = new Set(profiles.filter((profile) => profile.providerId === providerId).map((profile) => profile.model));
  // 批量目标保持获取列表的顺序，"保存并启用"只启用其中第一个
  const batchTargets = editing ? [] : discoveredModels.filter((item) => checkedModels.includes(item) && !existingModels.has(item));

  const handleProviderChange = (nextProviderId: string) => {
    setProviderId(nextProviderId);
    const nextDefinition = catalog.find((item) => item.id === nextProviderId);
    if (nextDefinition) {
      setModel(nextDefinition.defaultModel);
      setBaseUrl(nextDefinition.defaultBaseUrl);
      setDisplayName(nextDefinition.label);
    }
    setDiscoveredModels([]);
    setCheckedModels([]);
  };

  const toggleCheckedModel = (item: string) => {
    setCheckedModels((current) => (current.includes(item) ? current.filter((value) => value !== item) : [...current, item]));
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
        // 默认勾选当前模型（如果在获取结果中且尚未保存过），其余由用户自行勾选
        setCheckedModels(!editing && result.models.includes(effectiveModel) && !existingModels.has(effectiveModel) ? [effectiveModel] : []);
        setStatus({
          kind: "success",
          message: editing
            ? `已获取 ${result.models.length} 个可调用模型，可在模型输入框中下拉选择`
            : `已获取 ${result.models.length} 个可调用模型：勾选多个模型后保存，将为每个模型各生成一套配置（共用同一个 Key）`,
        });
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
      if (batchTargets.length > 0) {
        await saveBatch(activate);
        return;
      }
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

  /**
   * 批量保存：为每个勾选模型各创建一套配置，共用同一个 Key。
   * 串行执行保证「保存并启用」只激活第一个勾选项；失败的模型保持勾选与 Key，可直接重试。
   */
  const saveBatch = async (activate: boolean) => {
    const saved: string[] = [];
    const failed: string[] = [];
    for (const [index, item] of batchTargets.entries()) {
      try {
        await api.saveProviderProfile({
          providerId,
          displayName: `${effectiveDisplayName} · ${item}`,
          model: item,
          baseUrl: isCustom ? baseUrl : undefined,
          apiKey: apiKey.trim(),
          activate: activate && index === 0,
        });
        saved.push(item);
      } catch {
        failed.push(item);
      }
    }
    setCheckedModels((current) => current.filter((item) => !saved.includes(item)));
    if (!failed.length) {
      setApiKey("");
      setStatus({ kind: "success", message: activate ? `已保存 ${saved.length} 个配置并启用第一个` : `已保存 ${saved.length} 个配置` });
    } else {
      setStatus({
        kind: "error",
        message: `已保存 ${saved.length} 个，${failed.length} 个失败（${failed.join("、")}），可直接重试`,
      });
    }
    onSaved();
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
        {!editing && discoveredModels.length > 0 ? (
          <div className="settings-model-picker" role="group" aria-label="可调用模型列表">
            {groupModelsByFamily(discoveredModels).map((group) => (
              <div key={group.family} className="settings-model-picker__group">
                <p className="settings-model-picker__family">{group.family}</p>
                {group.models.map((item) => {
                  const exists = existingModels.has(item);
                  const checked = checkedModels.includes(item);
                  return (
                    <label key={item} className={`settings-model-picker__item${exists ? " settings-model-picker__item--exists" : ""}`}>
                      <input
                        type="checkbox"
                        checked={exists || checked}
                        disabled={exists || busy}
                        onChange={() => toggleCheckedModel(item)}
                      />
                      <span className="settings-model-picker__model">{item}</span>
                      {exists ? <span className="settings-model-picker__badge">已保存</span> : null}
                    </label>
                  );
                })}
              </div>
            ))}
            <p className="settings-form__hint">
              {batchTargets.length > 0
                ? `已勾选 ${batchTargets.length} 个模型：保存时将为每个勾选模型各生成一套配置，共用上方 Key。`
                : "勾选多个模型后保存，可为每个模型各生成一套配置，共用上方 Key。"}
            </p>
          </div>
        ) : null}
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
          {batchTargets.length > 0 ? `仅保存（${batchTargets.length}）` : "仅保存"}
        </button>
        <button
          type="submit"
          className="button button--primary"
          disabled={busy}
        >
          {status.kind === "saving" ? "保存中…" : batchTargets.length > 0 ? `保存并启用（${batchTargets.length}）` : "保存并启用"}
        </button>
      </div>

      {status.kind === "success" ? <p className="settings-status settings-status--ok">{status.message}</p> : null}
      {status.kind === "error" ? <p className="settings-status settings-status--error" role="alert">{status.message}</p> : null}
    </form>
  );
}
