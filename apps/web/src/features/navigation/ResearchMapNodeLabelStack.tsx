interface ResearchMapNodeLabelStackProps {
  title: readonly [primary: string, secondary: string | undefined];
  titleFontSize: number;
  details?: string;
  evidence?: {
    label: string;
    health: string;
  };
  scopeLabel?: string;
}

const LABEL_START_Y = 27;
const TITLE_LINE_HEIGHT_RATIO = 1.7;
const ANNOTATION_FONT_SIZE_RATIO = 10 / 13;
const ANNOTATION_LINE_HEIGHT_RATIO = 1.9;
const TITLE_TO_ANNOTATION_GAP_RATIO = 2 / 13;

export function ResearchMapNodeLabelStack({
  title: [primaryTitle, secondaryTitle],
  titleFontSize,
  details,
  evidence,
  scopeLabel,
}: ResearchMapNodeLabelStackProps) {
  const titleLineHeight = titleFontSize * TITLE_LINE_HEIGHT_RATIO;
  const annotationFontSize = titleFontSize * ANNOTATION_FONT_SIZE_RATIO;
  const annotationLineHeight = annotationFontSize * ANNOTATION_LINE_HEIGHT_RATIO;
  const lastTitleBaseline = LABEL_START_Y + (secondaryTitle ? titleLineHeight : 0);
  const firstAnnotationBaseline = lastTitleBaseline
    + (titleLineHeight + annotationLineHeight) / 2
    + titleFontSize * TITLE_TO_ANNOTATION_GAP_RATIO;
  const annotations = [
    details ? { key: "details", className: "global-map__node-details", label: details } : undefined,
    evidence ? {
      key: "evidence",
      className: `global-map__node-evidence global-map__node-evidence--${evidence.health}`,
      label: evidence.label,
    } : undefined,
    scopeLabel ? { key: "scope", className: "global-map__node-scope", label: scopeLabel } : undefined,
  ].filter((annotation): annotation is NonNullable<typeof annotation> => Boolean(annotation));

  return <>
    <text className="global-map__node-title" textAnchor="middle" y={LABEL_START_Y} style={{ fontSize: titleFontSize }} aria-hidden="true">
      <tspan x="0">{primaryTitle}</tspan>
      {secondaryTitle ? <tspan x="0" dy={titleLineHeight}>{secondaryTitle}</tspan> : null}
    </text>
    {annotations.map((annotation, index) => (
      <text
        key={annotation.key}
        className={annotation.className}
        textAnchor="middle"
        y={firstAnnotationBaseline + annotationLineHeight * index}
        style={{ fontSize: annotationFontSize }}
        aria-hidden="true"
      >
        {annotation.label}
      </text>
    ))}
  </>;
}
