import { useCallback, useEffect, useState } from "react";
import type { ModelPurpose, ModelRoutingView, ProviderDefinition, ProviderProfile } from "@collector/capture-contracts";
import { useServices } from "../../app/services";
import { Skeleton } from "../../components/Skeleton/Skeleton";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; catalog: ProviderDefinition[]; activeProfile?: ProviderProfile; profiles: ProviderProfile[]; routing: ModelRoutingView };

/** 表单入口：closed = 只显示「新建模型供应商」按钮；new / edit 时表单展开。 */
type FormState = { kind: "closed" } | { kind: "new" } | { kind: "edit"; profile: ProviderProfile };

/**
 * 把模型 ID 按家族分组（借鉴 CC Switch 的分组展示）：
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

/** 按供应商分组已保存配置，保持供应商目录顺序，未知名录的排在最后。 */
export function groupProfilesByProvider(
  profiles: ProviderProfile[],
  catalog: ProviderDefinition[],
): Array<{ providerId: string; label: string; profiles: ProviderProfile[] }> {
  const groups: Array<{ providerId: string; label: string; profiles: ProviderProfile[] }> = [];
  const index = new Map<string, number>();
  const labelOf = (providerId: string) => catalog.find((item) => item.id === providerId)?.label ?? providerId;
  for (const profile of profiles) {
    let slot = index.get(profile.providerId);
    if (slot === undefined) {
      slot = groups.length;
      index.set(profile.providerId, slot);
      groups.push({ providerId: profile.providerId, label: labelOf(profile.providerId), profiles: [] });
    }
    groups[slot].profiles.push(profile);
  }
  return groups;
}

/**
 * 已保存的模型配置列表：按供应商分组展示全部 ProviderProfile，
 * 每行一个启用复选框（停用后不再参与快速切换与任务分配），并支持设为当前、编辑与删除。
 * 当前使用中的配置不能停用。
 */
export function ProviderProfileList({
  profiles,
  catalog,
  activeProfile,
  pendingId,
  error,
  onActivate,
  onEdit,
  onDelete,
  onToggleEnabled,
}: {
  profiles: ProviderProfile[];
  catalog: ProviderDefinition[];
  activeProfile?: ProviderProfile;
  pendingId?: string;
  error?: string;
  onActivate: (id: string) => void;
  onEdit: (profile: ProviderProfile) => void;
  onDelete: (id: string) => void;
  onToggleEnabled: (profile: ProviderProfile) => void;
}) {
  if (!profiles.length) return null;
  return (
    <section className="settings-profile-list" aria-label="已保存的模型配置">
      <h2 className="settings-profile-list__title">已保存的模型配置</h2>
      <p className="settings-form__hint">
        勾选启用、取消勾选停用对应模型；停用的配置不会出现在会话页快速切换和任务模型分配中。
      </p>
      {error ? <p className="settings-status settings-status--error" role="alert">{error}</p> : null}
      {groupProfilesByProvider(profiles, catalog).map((group) => (
        <div key={group.providerId} className="settings-profile-group">
          <h3 className="settings-profile-group__title">{group.label}</h3>
          {group.profiles.map((profile) => {
            const isActive = activeProfile?.id === profile.id;
            const toggleLabel = profile.enabled ? `停用 ${profile.displayName}` : `启用 ${profile.displayName}`;
            return (
              <div
                key={profile.id}
                className={`settings-profile-item${isActive ? " settings-profile-item--active" : ""}${profile.enabled ? "" : " settings-profile-item--disabled"}`}
              >
                <label className="settings-profile-item__toggle">
                  <input
                    type="checkbox"
                    aria-label={toggleLabel}
                    checked={profile.enabled}
                    disabled={isActive || pendingId === profile.id}
                    onChange={() => onToggleEnabled(profile)}
                  />
                </label>
                <div className="settings-profile-item__body">
                  <p className="settings-profile-item__name">{profile.displayName}</p>
                  <p className="settings-profile-item__meta">
                    {profile.providerId} · {profile.model}
                    {isActive ? " · 当前使用" : ""}
                    {profile.credentialConfigured ? "" : " · 未配置 Key"}
                    {profile.enabled ? "" : " · 已停用"}
                  </p>
                </div>
                <div className="settings-profile-item__actions">
                  {!isActive && profile.enabled && profile.credentialConfigured ? (
                    <button type="button" className="button button--secondary" disabled={pendingId === profile.id} onClick={() => onActivate(profile.id)}>
                      设为当前
                    </button>
                  ) : null}
                  <button type="button" className="button button--secondary" onClick={() => onEdit(profile)}>
                    编辑
                  </button>
                  <button type="button" className="button button--ghost" disabled={pendingId === profile.id} onClick={() => onDelete(profile.id)}>
                    删除
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}

/**
 * AI 模型设置页：默认只显示已保存配置与「新建模型供应商」入口；
 * 点击新建或某条配置的「编辑」后展开表单。配置保存在本机，下次启动 Collector 时自动恢复。
 */
export function AiModelSettingsPage() {
  const { api } = useServices();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [form, setForm] = useState<FormState>({ kind: "closed" });
  const [listPendingId, setListPendingId] = useState<string | undefined>(undefined);
  const [listError, setListError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    // 仅首次进入显示骨架屏；保存/启停等操作后的刷新静默进行，
    // 避免表单在 loading 期间卸载导致已填的 Key 与状态文案丢失
    setState((current) => (current.kind === "ready" ? current : { kind: "loading" }));
    try {
      const [catalog, profiles, activeProfile, routing] = await Promise.all([
        api.getProviderCatalog(),
        api.listProviderProfiles(),
        api.getActiveProviderProfile().catch(() => undefined),
        // 旧客户端或测试替身可能不提供该接口；分配区块按全部跟随当前配置展示
        api.getModelRouting?.().catch(() => ({ routes: [] })) ?? Promise.resolve({ routes: [] }),
      ]);
      setState({ kind: "ready", catalog, profiles, activeProfile, routing });
      // 首次使用（还没有任何配置）时直接展开新建表单，给出明确起点
      setForm((current) => (current.kind === "closed" && profiles.length === 0 ? { kind: "new" } : current));
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "加载模型设置失败" });
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load, reloadNonce]);

  const reload = useCallback(() => setReloadNonce((nonce) => nonce + 1), []);

  /** 保存后刷新列表；表单保持展开，Key 以暗文留在输入框中（无论新建还是编辑）。 */
  const handleSaved = useCallback(() => {
    reload();
  }, [reload]);

  const runListAction = useCallback(
    async (id: string, action: () => Promise<unknown>) => {
      setListError(undefined);
      setListPendingId(id);
      try {
        await action();
        reload();
      } catch (cause) {
        setListError(cause instanceof Error ? cause.message : "操作失败，请重试");
      } finally {
        setListPendingId(undefined);
      }
    },
    [reload],
  );

  const handleActivate = useCallback(
    (id: string) => runListAction(id, () => api.activateProviderProfile(id)),
    [api, runListAction],
  );

  const handleToggleEnabled = useCallback(
    (profile: ProviderProfile) => {
      if (!api.setProviderProfileEnabled) {
        setListError("当前客户端不支持启用/停用配置");
        return;
      }
      return runListAction(profile.id, () => api.setProviderProfileEnabled(profile.id, !profile.enabled));
    },
    [api, runListAction],
  );

  const handleEdit = useCallback((profile: ProviderProfile) => {
    setForm({ kind: "edit", profile });
  }, []);

  const handleDelete = useCallback(
    (id: string) => runListAction(id, async () => {
      await api.deleteProviderProfile(id);
      setForm((current) => (current.kind === "edit" && current.profile.id === id ? { kind: "closed" } : current));
    }),
    [api, runListAction],
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
        <button type="button" className="button button--secondary" onClick={reload}>
          重新加载
        </button>
      </div>
    );
  }

  const editingProfile = form.kind === "edit" ? form.profile : undefined;

  return (
    <div className="page">
      <h1 className="page__title">AI 模型设置</h1>
      <p className="page__lead">
        每套配置对应一个模型。点击「新建模型供应商」添加配置，或在下方列表中编辑、启停、切换已保存的配置。配置保存在本机，下次启动 Collector 时自动恢复。
      </p>
      {form.kind === "closed" ? (
        <p className="settings-new-provider">
          <button type="button" className="button button--primary" onClick={() => setForm({ kind: "new" })}>
            新建模型供应商
          </button>
        </p>
      ) : (
        <section className="settings-form-section" aria-label={editingProfile ? "编辑模型供应商" : "新建模型供应商"}>
          <h2 className="settings-profile-list__title">
            {editingProfile ? `编辑模型供应商「${editingProfile.displayName}」` : "新建模型供应商"}
          </h2>
          <ProviderProfileForm
            key={editingProfile?.id ?? "new"}
            catalog={state.catalog}
            activeProfile={state.activeProfile}
            profiles={state.profiles}
            editingProfile={editingProfile}
            onSaved={handleSaved}
            onCancel={() => setForm({ kind: "closed" })}
          />
        </section>
      )}
      <ProviderProfileList
        profiles={state.profiles}
        catalog={state.catalog}
        activeProfile={state.activeProfile}
        pendingId={listPendingId}
        error={listError}
        onActivate={handleActivate}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onToggleEnabled={handleToggleEnabled}
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
  extraction: "事后语义抽取",
};

const PURPOSE_ORDER: ModelPurpose[] = ["chat", "selection", "research", "search", "document", "extraction"];

/**
 * 任务模型分配：按任务类型指定使用哪套已保存配置；
 * 默认「跟随当前配置」，即全部任务使用上方激活的配置。已停用的配置不可分配。
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
  const assignable = profiles.filter((profile) => profile.credentialConfigured && profile.enabled);
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
  /** 提供时表单进入编辑模式；API Key 会自动回填已保存值（暗文显示）。 */
  editingProfile?: ProviderProfile;
  /** 保存（含部分成功）后调用：父组件刷新列表；表单保持展开，Key 暗文留在输入框中。 */
  onSaved: () => void;
  onCancel: () => void;
}

type FormStatus =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "saving" }
  | { kind: "discovering" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

/** 已保存 Key 的回填状态：编辑模式下从本机服务读取真实 Key 填入输入框（暗文显示）。 */
type KeyLoadState = "none" | "loading" | "loaded" | "failed";

/**
 * 模型配置表单：供应商、配置名称、模型（可一键获取可调用列表后勾选）、API Key、自定义 Base URL。
 * API Key 以暗文显示，右侧眼睛按钮可切换明文；编辑模式下自动回填本机已保存的 Key，
 * 因此重启服务后再次打开编辑仍能看到暗文 Key。Key 只在组件内存中，不写入浏览器存储。
 * 「获取模型」成功后展示可勾选列表：勾选多个模型后保存，会为每个勾选模型各生成一套配置
 * （共用同一个 Key，借鉴 CC Switch 一次配置多个模型）；编辑模式同样可用，用于给同一供应商补充模型。
 */
function ProviderProfileForm({ catalog, activeProfile, profiles, editingProfile, onSaved, onCancel }: ProviderProfileFormProps) {
  const { api } = useServices();
  const [providerId, setProviderId] = useState(editingProfile?.providerId ?? activeProfile?.providerId ?? catalog[0]?.id ?? "");
  const [model, setModel] = useState(editingProfile?.model ?? activeProfile?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [keyVisible, setKeyVisible] = useState(false);
  const [keyLoad, setKeyLoad] = useState<KeyLoadState>("none");
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
  const busy = status.kind === "testing" || status.kind === "saving" || status.kind === "discovering";
  // 同厂商已保存的模型：勾选列表中标记"已保存"，防止批量添加产生重复配置
  const existingModels = new Set(profiles.filter((profile) => profile.providerId === providerId).map((profile) => profile.model));
  // 批量目标保持获取列表的顺序：已保存的模型（含编辑模式下的当前模型）自动排除
  const batchTargets = discoveredModels.filter((item) => checkedModels.includes(item) && !existingModels.has(item));

  // 编辑模式：从本机服务读取已保存的 Key 回填输入框（暗文显示），重启服务后依然可见
  useEffect(() => {
    if (!editingProfile?.credentialConfigured || !api.getProviderCredential) return;
    let cancelled = false;
    setKeyLoad("loading");
    api.getProviderCredential(editingProfile.id)
      .then((key) => {
        if (cancelled) return;
        if (key) {
          setApiKey(key);
          setKeyLoad("loaded");
        } else {
          setKeyLoad("failed");
        }
      })
      .catch(() => {
        if (!cancelled) setKeyLoad("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [editingProfile, api]);

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
        // 新建模式默认勾选当前模型（如果在获取结果中且尚未保存过），其余由用户自行勾选
        setCheckedModels(!editing && result.models.includes(effectiveModel) && !existingModels.has(effectiveModel) ? [effectiveModel] : []);
        setStatus({
          kind: "success",
          message: editing
            ? `已获取 ${result.models.length} 个可调用模型：勾选后随本次保存批量添加，共用同一个 Key`
            : `已获取 ${result.models.length} 个可调用模型：勾选多个模型后保存，将为每个模型各生成一套配置（共用同一个 Key）`,
        });
      } else {
        setStatus({ kind: "error", message: result.error });
      }
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : "获取模型列表失败" });
    }
  };

  /**
   * 批量创建：为每个勾选模型各保存一套配置，共用输入框中的 Key。
   * 串行执行保证「保存并启用」只激活第一个勾选项。
   * 返回已保存与失败的模型列表，由调用方决定状态文案与表单去留。
   */
  const saveBatchTargets = async (targets: string[], activateFirst: boolean) => {
    const saved: string[] = [];
    const failed: string[] = [];
    for (const [index, item] of targets.entries()) {
      try {
        await api.saveProviderProfile({
          providerId,
          displayName: `${effectiveDisplayName} · ${item}`,
          model: item,
          baseUrl: isCustom ? baseUrl : undefined,
          apiKey: apiKey.trim(),
          activate: activateFirst && index === 0,
        });
        saved.push(item);
      } catch {
        failed.push(item);
      }
    }
    return { saved, failed };
  };

  const handleSave = async (activate: boolean) => {
    if (!editing && !apiKey.trim()) {
      setStatus({ kind: "error", message: "新配置需要输入 API Key" });
      return;
    }
    if (editing && batchTargets.length > 0 && !apiKey.trim()) {
      setStatus({ kind: "error", message: "批量添加模型需要 API Key；已保存的 Key 读取失败时请重新输入" });
      return;
    }
    setStatus({ kind: "saving" });
    try {
      if (editing) {
        // 编辑模式：先保存当前配置本身，再批量补充勾选的额外模型
        await api.saveProviderProfile({
          id: editingProfile.id,
          ...buildPayload(),
          ...(apiKey.trim() ? {} : { apiKey: undefined }),
          activate,
        });
        if (batchTargets.length === 0) {
          setStatus({ kind: "success", message: activate ? "已保存并启用" : "已保存" });
          onSaved();
          return;
        }
        const { saved, failed } = await saveBatchTargets(batchTargets, false);
        setCheckedModels((current) => current.filter((item) => !saved.includes(item)));
        if (!failed.length) {
          setStatus({ kind: "success", message: `已保存当前配置，并新增 ${saved.length} 个模型配置` });
        } else {
          // 失败的模型保持勾选，可直接重试
          setStatus({
            kind: "error",
            message: `当前配置已保存；新增模型已保存 ${saved.length} 个，${failed.length} 个失败（${failed.join("、")}），可直接重试`,
          });
        }
        onSaved();
        return;
      }
      if (batchTargets.length > 0) {
        // 新建模式 + 勾选列表：每个勾选模型各生成一套配置
        const { saved, failed } = await saveBatchTargets(batchTargets, activate);
        setCheckedModels((current) => current.filter((item) => !saved.includes(item)));
        if (!failed.length) {
          setStatus({ kind: "success", message: activate ? `已保存 ${saved.length} 个配置并启用第一个` : `已保存 ${saved.length} 个配置` });
        } else {
          // 失败的模型保持勾选与 Key，可直接重试
          setStatus({
            kind: "error",
            message: `已保存 ${saved.length} 个，${failed.length} 个失败（${failed.join("、")}），可直接重试`,
          });
        }
        onSaved();
        return;
      }
      await api.saveProviderProfile({
        ...buildPayload(),
        activate,
      });
      setStatus({ kind: "success", message: activate ? "已保存并启用" : "已保存" });
      onSaved();
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : "保存失败" });
    }
  };

  const keyHint = (() => {
    if (!editing) return "Key 只保存在本机服务中，不会上传到 Collector 服务器。";
    if (!editingProfile.credentialConfigured) return "该配置还没有 Key，请输入后保存。";
    if (keyLoad === "loaded") return "已自动填入本机保存的 Key（暗文显示），点右侧眼睛可查看明文；如需更换请直接修改。";
    if (keyLoad === "failed") return "已保存的 Key 读取失败；留空保存将保持原 Key 不变。";
    return "正在读取已保存的 Key…";
  })();

  return (
    <form className="settings-form" onSubmit={(event) => { event.preventDefault(); void handleSave(true); }}>
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
        <p className="settings-form__hint">可直接输入，或点击「获取模型」从供应商拉取可调用模型后在下方勾选。</p>
        {discoveredModels.length > 0 ? (
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
                ? editing
                  ? `已勾选 ${batchTargets.length} 个新模型：保存时将各生成一套配置，共用上方 Key。`
                  : `已勾选 ${batchTargets.length} 个模型：保存时将为每个勾选模型各生成一套配置，共用上方 Key。`
                : editing
                  ? "勾选尚未保存的模型后保存，可为每个模型各生成一套配置，共用上方 Key。"
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
        <div className="settings-form__key-wrap">
          <input
            id="api-key-input"
            className="settings-form__input"
            type={keyVisible ? "text" : "password"}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={editing && editingProfile.credentialConfigured && keyLoad !== "loaded" ? "已保存，留空则保持不变" : "输入 API Key"}
            autoComplete="off"
          />
          <button
            type="button"
            className="settings-form__key-toggle"
            aria-label={keyVisible ? "隐藏 API Key" : "显示 API Key"}
            aria-pressed={keyVisible}
            disabled={!apiKey}
            onClick={() => setKeyVisible((visible) => !visible)}
          >
            {keyVisible ? (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </button>
        </div>
        <p className="settings-form__hint">{keyHint}</p>
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
        <button
          type="button"
          className="button button--ghost"
          disabled={busy}
          onClick={onCancel}
        >
          取消
        </button>
      </div>

      {status.kind === "success" ? <p className="settings-status settings-status--ok">{status.message}</p> : null}
      {status.kind === "error" ? <p className="settings-status settings-status--error" role="alert">{status.message}</p> : null}
    </form>
  );
}
