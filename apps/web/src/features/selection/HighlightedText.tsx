/** 在纯文本中把 [start, end) 范围渲染为 <mark>，其余保持纯文本。调用方负责先解析范围。 */
export function HighlightedText({
  text,
  start,
  end,
}: {
  text: string;
  start: number;
  end: number;
}) {
  return (
    <>
      {text.slice(0, start)}
      <mark className="selection-mark" data-selection-mark>
        {text.slice(start, end)}
      </mark>
      {text.slice(end)}
    </>
  );
}
