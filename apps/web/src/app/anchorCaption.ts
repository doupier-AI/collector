import type { ResearchContentBlock } from "@collector/capture-contracts";

/** 内容块在原文中的位置说明（第 N 行 / 段落 N / 第 N 页），阅读视图与选区来源位置共用。 */
export function anchorCaption(block: ResearchContentBlock): string {
  const anchor = block.anchor;
  switch (anchor.kind) {
    case "text":
    case "markdown":
      return anchor.startLine === anchor.endLine ? `第 ${anchor.startLine} 行` : `第 ${anchor.startLine}–${anchor.endLine} 行`;
    case "docx":
      return `段落 ${anchor.paragraphIndex + 1}`;
    case "pdf":
      return `第 ${anchor.pageNumber} 页`;
  }
}

/** AI 消息派生块的位置说明，按段落序号展示。 */
export function messageBlockCaption(blockOrdinal: number): string {
  return `段落 ${blockOrdinal + 1}`;
}
