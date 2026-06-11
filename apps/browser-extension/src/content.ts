interface SelectionContext {
  content: string;
  contextBefore: string;
  contextAfter: string;
  locator: { kind: "browser"; pageUrl: string; startPath?: string; endPath?: string; startOffset: number; endOffset: number };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "collector:get-selection") return;
  sendResponse(getSelectionContext());
});

function getSelectionContext(): SelectionContext | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const content = selection.toString().trim();
  if (!content) return null;
  const container = range.commonAncestorContainer;
  const surrounding = (container.textContent ?? "").replace(/\s+/g, " ");
  const index = surrounding.indexOf(content);
  return {
    content,
    contextBefore: index >= 0 ? surrounding.slice(Math.max(0, index - 240), index) : "",
    contextAfter: index >= 0 ? surrounding.slice(index + content.length, index + content.length + 240) : "",
    locator: {
      kind: "browser",
      pageUrl: location.href,
      startPath: domPath(range.startContainer),
      endPath: domPath(range.endContainer),
      startOffset: range.startOffset,
      endOffset: range.endOffset,
    },
  };
}

function domPath(node: Node): string | undefined {
  const parts: string[] = [];
  let current: Node | null = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
  while (current instanceof Element && parts.length < 10) {
    const parent: Element | null = current.parentElement;
    const index = parent ? Array.from(parent.children).indexOf(current) + 1 : 1;
    parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);
    current = parent;
  }
  return parts.length ? parts.join(" > ") : undefined;
}
