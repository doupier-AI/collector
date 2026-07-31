import type {
  ResearchAttachmentRecord,
  ResearchBranchRecord,
  ResearchBranchView,
  ResearchImportTaskRecord,
  ResearchLaterItemRecord,
  ResearchLaterItemView,
  ResearchMessageRecord,
  ResearchNodeRecord,
  ResearchNodeView,
  ResearchSelectionRecord,
  ResearchSelectionTaskRecord,
  ResearchSessionRecord,
  ResearchTaskRecord,
} from "@collector/capture-contracts";
import type { EventSourceLike } from "../api/task-events";

/** 可注入的 EventSource 替身：手动推送 open / error / 命名事件。 */
export class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];

  static reset(): void {
    FakeEventSource.instances = [];
  }

  readonly url: string;
  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: Event) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  emitOpen(): void {
    this.readyState = 1;
    this.emitRaw("open");
  }

  emitError(readyState = 0): void {
    this.readyState = readyState;
    this.emitRaw("error");
  }

  emit(type: string, data: unknown): void {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      listener({ type, data: JSON.stringify(data) } as MessageEvent<string>);
    }
  }

  private emitRaw(type: string): void {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(new Event(type));
    }
  }
}

let sequence = 0;

export function makeSession(overrides: Partial<ResearchSessionRecord> = {}): ResearchSessionRecord {
  sequence += 1;
  return {
    id: `session-${sequence}`,
    title: `研究会话 ${sequence}`,
    status: "active",
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:01:00.000Z",
    ...overrides,
  };
}

export function makeNode(overrides: Partial<ResearchNodeRecord> = {}): ResearchNodeRecord {
  sequence += 1;
  return {
    id: `node-${sequence}`,
    sessionId: "session-1",
    status: "active",
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:01:00.000Z",
    ...overrides,
  };
}

export function makeNodeView(overrides: Partial<ResearchNodeView> = {}): ResearchNodeView {
  const node = overrides.node ?? makeNode();
  return {
    node,
    session: overrides.session ?? makeSession({ id: node.sessionId }),
    messages: overrides.messages ?? [],
    tasks: overrides.tasks ?? [],
    childNodes: overrides.childNodes ?? [],
  };
}

export function makeMessage(overrides: Partial<ResearchMessageRecord> = {}): ResearchMessageRecord {
  sequence += 1;
  return {
    id: `message-${sequence}`,
    sessionId: "session-1",
    role: "user",
    content: "",
    status: "completed",
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:00:00.000Z",
    ...overrides,
  };
}

export function makeTask(overrides: Partial<ResearchTaskRecord> = {}): ResearchTaskRecord {
  sequence += 1;
  return {
    id: `task-${sequence}`,
    sessionId: "session-1",
    inputMessageId: "message-1",
    outputMessageId: "message-2",
    idempotencyKey: `key-${sequence}`,
    status: "queued",
    retryable: false,
    promptVersion: "test-prompt-v1",
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:00:00.000Z",
    ...overrides,
  };
}

export function makeAttachment(overrides: Partial<ResearchAttachmentRecord> = {}): ResearchAttachmentRecord {
  sequence += 1;
  return {
    id: `attachment-${sequence}`,
    sessionId: "session-1",
    fileName: "笔记.txt",
    mimeType: "text/plain",
    size: 128,
    checksum: `checksum-${sequence}`,
    status: "processing",
    importTaskId: `import-task-${sequence}`,
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:00:00.000Z",
    ...overrides,
  };
}

export function makeImportTask(overrides: Partial<ResearchImportTaskRecord> = {}): ResearchImportTaskRecord {
  sequence += 1;
  return {
    id: `import-task-${sequence}`,
    sessionId: "session-1",
    attachmentId: `attachment-${sequence}`,
    idempotencyKey: `import-key-${sequence}`,
    status: "queued",
    progress: { phase: "queued", completedUnits: 0, totalUnits: 0 },
    retryable: false,
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:00:00.000Z",
    ...overrides,
  };
}

export function makeSelection(overrides: Partial<ResearchSelectionRecord> = {}): ResearchSelectionRecord {
  sequence += 1;
  return {
    id: `selection-${sequence}`,
    sessionId: "session-1",
    anchor: { kind: "message", messageId: "m-out", blockOrdinal: 0, startOffset: 0, endOffset: 6, exact: "一段选区文字" },
    text: "一段选区文字",
    status: "active",
    createdAt: "2026-07-20T08:00:00.000Z",
    updatedAt: "2026-07-20T08:00:00.000Z",
    ...overrides,
  };
}

export function makeSelectionTask(overrides: Partial<ResearchSelectionTaskRecord> = {}): ResearchSelectionTaskRecord {
  sequence += 1;
  return {
    id: `selection-task-${sequence}`,
    sessionId: "session-1",
    selectionId: "selection-1",
    idempotencyKey: `sel-key-${sequence}`,
    status: "queued",
    retryable: false,
    promptVersion: "selection-analysis-v1",
    createdAt: "2026-07-20T08:00:00.000Z",
    updatedAt: "2026-07-20T08:00:00.000Z",
    ...overrides,
  };
}

export function makeBranch(overrides: Partial<ResearchBranchRecord> = {}): ResearchBranchRecord {
  sequence += 1;
  return {
    id: `branch-${sequence}`,
    sessionId: "session-1",
    selectionId: "selection-1",
    status: "active",
    createdAt: "2026-07-21T08:00:00.000Z",
    updatedAt: "2026-07-21T08:00:00.000Z",
    ...overrides,
  };
}

export function makeBranchView(overrides: Partial<ResearchBranchView> = {}): ResearchBranchView {
  const branch = overrides.branch ?? makeBranch();
  const selection = overrides.selection ?? makeSelection({ id: branch.selectionId, sessionId: branch.sessionId });
  return {
    branch,
    session: overrides.session ?? makeSession({ id: branch.sessionId, title: "来源研究会话" }),
    selection,
    messages: overrides.messages ?? [],
    tasks: overrides.tasks ?? [],
  };
}

export function makeLaterItem(overrides: Partial<ResearchLaterItemRecord> = {}): ResearchLaterItemRecord {
  sequence += 1;
  return {
    id: `later-${sequence}`,
    sessionId: "session-1",
    selectionId: "selection-1",
    summary: "本地优先会先把输入保存在本机",
    priority: 3,
    status: "pending",
    createdAt: "2026-07-21T08:00:00.000Z",
    updatedAt: "2026-07-21T08:00:00.000Z",
    ...overrides,
  };
}

export function makeLaterItemView(overrides: {
  item?: ResearchLaterItemRecord;
  selection?: ResearchSelectionRecord;
  sourceTitle?: string;
  sourceNode?: { id: string; label: string };
} = {}): ResearchLaterItemView {
  const item = overrides.item ?? makeLaterItem();
  const selection = overrides.selection ?? makeSelection({ id: item.selectionId, sessionId: item.sessionId });
  return {
    item,
    selection,
    sourceTitle: overrides.sourceTitle ?? "理解注意力机制",
    sourceNode: overrides.sourceNode ?? { id: item.nodeId ?? item.sessionId, label: overrides.sourceTitle ?? "理解注意力机制" },
  };
}
