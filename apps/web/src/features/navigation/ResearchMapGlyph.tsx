/** 研究图谱入口的稳定图标；只表达产品入口，不依赖当前地图实现。 */
export function ResearchMapGlyph({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle cx="10" cy="4.5" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="5" cy="15.5" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="15" cy="15.5" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <line x1="8.5" y1="6" x2="6" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="11.5" y1="6" x2="14" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
