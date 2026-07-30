/**
 * 草稿使用带版本的最小 localStorage 结构：只保存非敏感文字与时间戳，
 * 绝不保存认证信息、Cookie 或令牌。
 */

const STORAGE_KEY = "collector.web.draft.v1";

interface DraftEntry {
  content: string;
  updatedAt: string;
}

interface DraftStoreV1 {
  version: 1;
  drafts: Record<string, DraftEntry>;
}

function emptyStore(): DraftStoreV1 {
  return { version: 1, drafts: {} };
}

function readStore(): DraftStoreV1 {
  try {
    if (typeof window === "undefined") return emptyStore();
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw) as Partial<DraftStoreV1> | null;
    if (!parsed || parsed.version !== 1 || typeof parsed.drafts !== "object" || parsed.drafts === null) {
      return emptyStore();
    }
    const drafts: Record<string, DraftEntry> = {};
    for (const [scope, entry] of Object.entries(parsed.drafts)) {
      if (entry && typeof entry.content === "string" && typeof entry.updatedAt === "string") {
        drafts[scope] = { content: entry.content, updatedAt: entry.updatedAt };
      }
    }
    return { version: 1, drafts };
  } catch {
    return emptyStore();
  }
}

function writeStore(store: DraftStoreV1): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // 存储不可用（隐私模式、配额满）时静默降级，不影响输入
  }
}

export function loadDraft(scope: string): string {
  return readStore().drafts[scope]?.content ?? "";
}

export function saveDraft(scope: string, content: string): void {
  const store = readStore();
  if (content.trim().length > 0) {
    store.drafts[scope] = { content, updatedAt: new Date().toISOString() };
  } else {
    delete store.drafts[scope];
  }
  writeStore(store);
}

export function clearDraft(scope: string): void {
  const store = readStore();
  if (scope in store.drafts) {
    delete store.drafts[scope];
    writeStore(store);
  }
}
