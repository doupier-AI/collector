import { useCallback, useEffect, useState } from "react";
import { useServices } from "../../app/services";

/** 研究图谱只保存入口偏好；坐标、筛选和专注不会跨打开保存。 */
export function ResearchMapSettingsPage() {
  const { api } = useServices();
  const [value, setValue] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      setError(undefined);
      setValue((await api.getResearchMapSettings()).defaultFocusFromNode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取节点图谱设置失败");
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const change = useCallback(async (defaultFocusFromNode: boolean) => {
    setSaving(true);
    setError(undefined);
    try {
      setValue((await api.updateResearchMapSettings({ defaultFocusFromNode })).defaultFocusFromNode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存节点图谱设置失败");
    } finally {
      setSaving(false);
    }
  }, [api]);

  return <section className="page" aria-label="节点图谱">
    <h1 className="page__title">节点图谱</h1>
    <div className="settings-form__field">
      <label className="settings-form__label settings-form__label--toggle">
        <input type="checkbox" checked={value ?? false} disabled={saving || value === null} onChange={(event) => void change(event.target.checked)} />
        从节点正文进入时默认专注父子树
      </label>
      <p className="settings-form__hint">关闭时仍会居中突出该节点；侧栏、搜索和旧链接始终进入全局总览。</p>
    </div>
    {value === null && !error ? <p className="settings-status">正在读取节点图谱设置…</p> : null}
    {saving ? <p className="settings-status">正在保存…</p> : null}
    {error ? <p className="settings-status settings-status--error" role="alert">{error}</p> : null}
  </section>;
}
