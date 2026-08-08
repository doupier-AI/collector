import { useCallback, useEffect, useState } from "react";
import { useServices } from "../../app/services";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; enabled: boolean };

/**
 * #32 自动融合设置页：开关默认关闭；开启后进入/刷新研究节点页时自动扫描相似概念，
 * 同一实体 / 共享概念自动融合并标记「自动生成」，类比 / 对比保持逐条确认弱提示。
 */
export function FusionSettingsPage() {
  const { api } = useServices();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    if (!api.getFusionAutoConfig) {
      setState({ kind: "error", message: "当前客户端不支持自动融合设置" });
      return;
    }
    setState((current) => (current.kind === "ready" ? current : { kind: "loading" }));
    try {
      const config = await api.getFusionAutoConfig();
      setState({ kind: "ready", enabled: config.enabled });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "读取自动融合设置失败" });
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
        setSaveError(cause instanceof Error ? cause.message : "保存自动融合设置失败");
      } finally {
        setSaving(false);
      }
    },
    [api],
  );

  if (state.kind === "loading") {
    return <p className="settings-status">正在读取自动融合设置…</p>;
  }
  if (state.kind === "error") {
    return (
      <p className="settings-status settings-status--error" role="alert">
        {state.message}
      </p>
    );
  }

  return (
    <section className="settings-profile-list" aria-label="自动融合">
      <h2 className="settings-profile-list__title">自动融合</h2>
      <p className="settings-form__hint">
        开启后，进入或刷新研究节点页时自动扫描相似概念。同一实体与共享概念的提议自动生成融合节点并标记「自动生成」；
        类比与对比保持逐条确认的弱提示。自动融合不改变来源可回溯与跨领域同名判定规则，只处理开启后新出现的提议。
      </p>
      <div className="settings-form__field">
        <label className="settings-form__label settings-form__label--toggle">
          <input
            type="checkbox"
            checked={state.enabled}
            disabled={saving}
            onChange={(event) => void handleToggle(event.target.checked)}
            aria-describedby="auto-fusion-hint"
          />
          自动融合
        </label>
        <p className="settings-form__hint" id="auto-fusion-hint">
          {state.enabled ? "已开启：高置信提议将自动生成融合节点。" : "已关闭：核验成立的提议只呈现弱提示。"}
        </p>
      </div>
      {saveError ? <p className="settings-status settings-status--error" role="alert">{saveError}</p> : null}
      {saving ? <p className="settings-status settings-status--ok">正在保存…</p> : null}
    </section>
  );
}
