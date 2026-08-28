import { useEffect, useRef, useState } from "react";
import type { MapDensity } from "./research-map-layout";

export interface MapVisualSettings {
  colorMode: "project" | "node-type" | "lifecycle";
  showArrows: boolean;
  nodeScale: number;
  titleOpacity: number;
  lineWidth: number;
  density: MapDensity;
  showIsolates: boolean;
}

export const DEFAULT_MAP_VISUAL_SETTINGS: MapVisualSettings = {
  colorMode: "project",
  showArrows: false,
  nodeScale: 1,
  titleOpacity: 0.62,
  lineWidth: 1.25,
  density: "balanced",
  showIsolates: true,
};

interface ResearchMapVisualSettingsProps {
  settings: MapVisualSettings;
  nodeCount: number;
  edgeCount: number;
  onChange: (settings: MapVisualSettings) => void;
  onResetLayout: () => void;
}

const densityLabels: Record<MapDensity, string> = { compact: "紧凑", balanced: "均衡", spacious: "疏朗" };

export function ResearchMapVisualSettings({ settings, nodeCount, edgeCount, onChange, onResetLayout }: ResearchMapVisualSettingsProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const update = <Key extends keyof MapVisualSettings>(key: Key, value: MapVisualSettings[Key]) => onChange({ ...settings, [key]: value });

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="map-visual-settings__trigger"
        aria-label="图谱呈现与布局"
        aria-expanded={open}
        aria-controls="map-visual-settings-panel"
        onClick={() => setOpen((current) => !current)}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M6.5 10h7M8.5 15h3" /><circle cx="8" cy="5" r="1.5" /><circle cx="12" cy="10" r="1.5" /><circle cx="10" cy="15" r="1.5" /></svg>
      </button>
      {open ? (
        <aside id="map-visual-settings-panel" className="map-visual-settings" role="region" aria-labelledby="map-visual-settings-title">
          <header className="map-visual-settings__header">
            <div><h2 id="map-visual-settings-title">图谱呈现与布局</h2><p>{nodeCount} 个节点 · {edgeCount} 条永久关系</p></div>
            <button type="button" aria-label="关闭图谱呈现与布局" onClick={() => { setOpen(false); requestAnimationFrame(() => triggerRef.current?.focus()); }}>×</button>
          </header>
          <fieldset className="map-visual-settings__group">
            <legend>呈现</legend>
            <div className="map-visual-settings__row">
              <label htmlFor="map-color-mode">颜色模式</label>
              <select id="map-color-mode" value={settings.colorMode} onChange={(event) => update("colorMode", event.target.value as MapVisualSettings["colorMode"])}>
                <option value="project">项目</option><option value="node-type">节点类型</option><option value="lifecycle">生命周期</option>
              </select>
            </div>
            <div className="map-visual-settings__row map-visual-settings__row--check">
              <input id="map-show-arrows" type="checkbox" checked={settings.showArrows} onChange={(event) => update("showArrows", event.target.checked)} />
              <label htmlFor="map-show-arrows">显示关系箭头</label>
            </div>
            <div className="map-visual-settings__row">
              <label htmlFor="map-node-scale">节点大小</label><output htmlFor="map-node-scale">{Math.round(settings.nodeScale * 100)}%</output>
              <input id="map-node-scale" type="range" min="0.75" max="1.5" step="0.05" value={settings.nodeScale} onChange={(event) => update("nodeScale", Number(event.target.value))} />
            </div>
            <div className="map-visual-settings__row">
              <label htmlFor="map-title-opacity">标题透明度</label><output htmlFor="map-title-opacity">{Math.round(settings.titleOpacity * 100)}%</output>
              <input id="map-title-opacity" type="range" min="0.35" max="1" step="0.05" value={settings.titleOpacity} onChange={(event) => update("titleOpacity", Number(event.target.value))} />
            </div>
            <div className="map-visual-settings__row">
              <label htmlFor="map-line-width">连线粗细</label><output htmlFor="map-line-width">{settings.lineWidth.toFixed(2)}px</output>
              <input id="map-line-width" type="range" min="1" max="3" step="0.25" value={settings.lineWidth} onChange={(event) => update("lineWidth", Number(event.target.value))} />
            </div>
          </fieldset>
          <fieldset className="map-visual-settings__group">
            <legend>布局</legend>
            <div className="map-visual-settings__row">
              <label htmlFor="map-density">布局密度</label><output htmlFor="map-density">{densityLabels[settings.density]}</output>
              <select id="map-density" value={settings.density} onChange={(event) => update("density", event.target.value as MapDensity)}>
                <option value="compact">紧凑</option><option value="balanced">均衡</option><option value="spacious">疏朗</option>
              </select>
            </div>
            <div className="map-visual-settings__row map-visual-settings__row--check">
              <input id="map-show-isolates" type="checkbox" checked={settings.showIsolates} onChange={(event) => update("showIsolates", event.target.checked)} />
              <label htmlFor="map-show-isolates">显示孤立节点</label>
            </div>
            <button type="button" className="button button--secondary" onClick={onResetLayout}>重置本次布局</button>
          </fieldset>
          <p className="map-visual-settings__hint">拖动画布平移 · 滚轮缩放 · Shift+方向键微调 · 单击或 Space 专注 · 双击或 Enter 打开</p>
        </aside>
      ) : null}
    </>
  );
}
