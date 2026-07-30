/**
 * remark 插件：把原始块文本里的 [来源n] 标记转为 cite-marker 自定义 hast 节点。
 * 遍历 AST 的 text 节点，拆分 [来源n] 为 text + cite-marker + text 序列。
 * 仅匹配 [来源n]（n 为纯数字），不处理 [1]/[2] 等单一数字格式。
 */
import type { Root } from "mdast";

const TOKEN = /\[来源(\d+)\]/g;

interface MdastText {
  type: "text";
  value: string;
}

interface MdastCiteMarker {
  type: "cite-marker";
  data: {
    hName: "cite-marker";
    hProperties: Record<string, string>;
  };
}

type MdastChild = MdastText | MdastCiteMarker | { type: string; children?: MdastChild[] };

export function remarkCitationMarkers() {
  return (tree: Root) => {
    visitTextNodes(tree);
  };
}

/** 递归遍历：对 tree 或 children 数组上的每个 text 节点拆分 [来源n]。 */
function visitTextNodes(node: any) {
  const children: any[] | undefined = node?.children;
  if (!children) return;
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child && child.type === "text" && typeof child.value === "string") {
      const parts = splitCitationTokens(child.value);
      if (parts.length > 1) {
        children.splice(i, 1, ...parts);
      }
    } else {
      visitTextNodes(child);
    }
  }
}

function splitCitationTokens(value: string): MdastChild[] {
  const parts: MdastChild[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((match = TOKEN.exec(value)) !== null) {
    const before = value.slice(lastIndex, match.index);
    if (before) parts.push({ type: "text", value: before });
    parts.push({
      type: "cite-marker",
      data: {
        hName: "cite-marker",
        hProperties: {
          "data-source-ordinal": match[1],
          class: "citation-marker",
          role: "button",
          tabindex: "0",
        },
      },
    } as MdastCiteMarker);
    lastIndex = match.index + match[0].length;
  }
  const after = value.slice(lastIndex);
  if (after) parts.push({ type: "text", value: after });
  return parts;
}
