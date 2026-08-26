import { useCallback, useEffect, useState } from "react";
import { useServices } from "../../app/services";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; enabled: boolean };

/**
 * 临时融合发现设置：开关默认关闭；开启后独立核验多来源新增认识，
 * 合格结果只进入 B 面临时层，不创建正式节点或永久关系。
 */
export function FusionSettingsPage() {
  const { api } = useServices();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    if (!api.getFusionAutoConfig) {
      setState({ kind: "error", message: "当前客户端不支持临时融合发现设置" });
      return;
    }
    setState((current) => (current.kind === "ready" ? current : { kind: "loading" }));
    try {
      const config = await api.getFusionAutoConfig();
      setState({ kind: "ready", enabled: config.enabled });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "读取临时融合发现设置失败" });
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleToggle = useCallback(
    async (enabled: boolean) => {
      if (!api.updateFusionAutoConfig) return;
      setSaveError(undefined);
      setSaving(true);
      try {
        await api.updateFusionAutoConfig(enabled);
        setState({ kind: "ready", enabled });
      } catch (cause) {
        setSaveError(cause instanceof Error ? cause.message : "保存临时融合发现设置失败");
      } finally {
        setSaving(false);
      }
    },
    [api],
  );

  if (state.kind === "loading") {
    return (
      <div className="page">
        <p className="settings-status">正在读取临时融合发现设置…</p>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="page">
        <p className="settings-status settings-status--error" role="alert">
          {state.message}
        </p>
      </div>
    );
  }

  return (
    <section className="page" aria-label="临时融合发现">
      <h1 className="page__title">临时融合发现</h1>
      <p className="settings-form__hint">
        开启后，进入或刷新研究节点页时会先查找相关正式内容，再独立判断是否形成了具体、多来源且证据可定位的新认识。
        合格结果只保存为待核验的临时融合；当前阅读不会跳转、弹窗或新增对话消息。
      </p>
      <div className="settings-form__field">
        <label className="settings-form__label settings-form__label--toggle">
          <input
            type="checkbox"
            checked={state.enabled}
            disabled={saving}
            onChange={(event) => void handleToggle(event.target.checked)}
            aria-describedby="temporary-fusion-hint"
          />
          自动发现临时融合
        </label>
        <p className="settings-form__hint" id="temporary-fusion-hint">
          {state.enabled ? "已开启：合格的新认识会进入临时层等待核验。" : "已关闭：不会自动创建临时融合。"}
        </p>
      </div>
      {saveError ? <p className="settings-status settings-status--error" role="alert">{saveError}</p> : null}
      {saving ? <p className="settings-status settings-status--ok">正在保存…</p> : null}
    </section>
  );
}
