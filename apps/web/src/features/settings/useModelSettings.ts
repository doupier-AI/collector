import { useCallback, useEffect, useState } from "react";
import type { ProviderCatalogEntry, ProviderConnectionTestResult, ProviderProfile, ProviderProfileWithCredential } from "@collector/capture-contracts";
import { useServices } from "../../app/services";

export type ModelSettingsState =
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "ready"; catalog: ProviderCatalogEntry[]; profiles: ProviderProfile[]; activeId: string | null };

export type FormMode =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; profile: ProviderProfile };

export interface ModelSettingsController {
  state: ModelSettingsState;
  formMode: FormMode;
  saving: boolean;
  saveError: string | undefined;
  testResult: ProviderConnectionTestResult | undefined;
  testing: boolean;
  deletingId: string | null;
  openCreateForm(): void;
  openEditForm(profile: ProviderProfile): void;
  closeForm(): void;
  saveProfile(input: ProviderProfileWithCredential): Promise<void>;
  testConnection(id: string): Promise<void>;
  activateProfile(id: string): Promise<void>;
  confirmDelete(id: string): void;
  cancelDelete(): void;
  deleteProfile(id: string): Promise<void>;
}

export function useModelSettings(): ModelSettingsController {
  const { api } = useServices();
  const [state, setState] = useState<ModelSettingsState>({ kind: "loading" });
  const [formMode, setFormMode] = useState<FormMode>({ kind: "closed" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [testResult, setTestResult] = useState<ProviderConnectionTestResult | undefined>();
  const [testing, setTesting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(() => {
    let stale = false;
    setState({ kind: "loading" });
    Promise.all([api.getProviderCatalog(), api.listProviderProfiles()])
      .then(([catalog, { profiles, activeId }]) => {
        if (!stale) setState({ kind: "ready", catalog, profiles, activeId });
      })
      .catch((error) => {
        if (!stale) setState({ kind: "error", error: (error as Error).message ?? "加载失败" });
      });
    return () => { stale = true; };
  }, [api]);

  useEffect(() => {
    const cancel = load();
    return cancel;
  }, [load]);

  const saveProfile = useCallback(async (input: ProviderProfileWithCredential) => {
    setSaving(true);
    setSaveError(undefined);
    try {
      await api.saveProviderProfile(input);
      setFormMode({ kind: "closed" });
      setTestResult(undefined);
      load();
    } catch (error) {
      setSaveError((error as Error).message ?? "保存失败");
    } finally {
      setSaving(false);
    }
  }, [api, load]);

  const testConnection = useCallback(async (id: string) => {
    setTesting(true);
    setTestResult(undefined);
    try {
      const result = await api.testProviderConnection(id);
      setTestResult(result);
    } catch (error) {
      setTestResult({ ok: false, error: (error as Error).message ?? "测试失败" });
    } finally {
      setTesting(false);
    }
  }, [api]);

  const activateProfile = useCallback(async (id: string) => {
    try {
      await api.activateProviderProfile(id);
      load();
    } catch {
      // error is surfaced elsewhere
    }
  }, [api, load]);

  const deleteProfile = useCallback(async (id: string) => {
    await api.deleteProviderProfile(id);
    setDeletingId(null);
    load();
  }, [api, load]);

  return {
    state, formMode, saving, saveError, testResult, testing, deletingId,
    openCreateForm: () => setFormMode({ kind: "create" }),
    openEditForm: (profile) => setFormMode({ kind: "edit", profile }),
    closeForm: () => { setFormMode({ kind: "closed" }); setSaveError(undefined); setTestResult(undefined); },
    saveProfile, testConnection, activateProfile,
    confirmDelete: (id) => setDeletingId(id),
    cancelDelete: () => setDeletingId(null),
    deleteProfile,
  };
}
