import type {
  ArtifactRecord,
  CaptureInput,
  CaptureRecord,
  InboxItem,
  RelationRecord,
  TopicRecord,
  TopicWorkspace,
} from "@collector/capture-contracts";

interface CaptureBridge {
  submit(input: CaptureInput): Promise<CaptureRecord>;
  upload(file: File): Promise<ArtifactRecord>;
  hide(): void;
  navigate(tab: string): void;
  onFocus(callback: () => void): void;
  onShortcutError(callback: (shortcut: string) => void): void;
  onModeChange(callback: (mode: string) => void): void;
}

interface WorkspaceBridge {
  load(): Promise<{ inbox: InboxItem[]; topics: TopicRecord[]; relations: RelationRecord[] }>;
  createTopic(title: string): Promise<TopicRecord>;
  createSuggestedTopic(input: { title: string; sourceCaptureId: string; sourceAgentRunId: string; evidenceFragmentIds: string[] }): Promise<TopicRecord>;
  updateTopic(id: string, patch: { title?: string; status?: "active" | "archived" }): Promise<TopicRecord>;
  getTopic(id: string): Promise<TopicWorkspace>;
  addTopicMember(topicId: string, captureId: string): Promise<unknown>;
  removeTopicMember(topicId: string, captureId: string): Promise<unknown>;
  deepAnalysis(captureId: string): Promise<unknown>;
  navigateTo(tab: string): void;
}

interface RecentBridge {
  organize(idempotencyKey?: string): Promise<import("@collector/capture-contracts").WorkflowRunRecord>;
  snapshot(): Promise<import("@collector/capture-contracts").RecentClusterSnapshotRecord>;
  run(id: string): Promise<import("@collector/capture-contracts").WorkflowRunRecord>;
  cancel(id: string): Promise<import("@collector/capture-contracts").WorkflowRunRecord>;
}

interface SettingsBridge {
  get(): Promise<{ shortcut: string; ai: { consent: boolean; configured: boolean; apiKey?: string; provider?: string; model?: string; unavailable?: boolean } }>;
  saveAi(value: { consent: boolean; apiKey?: string }): Promise<{ consent: boolean; configured: boolean; apiKey?: string; provider?: string; model?: string }>;
    testConnection(key?: string): Promise<{ ok: true; model: string } | { ok: false; error: string }>;
  saveShortcut(value: string): Promise<{ shortcut: string }>;
  navigateTo(tab: string): void;
}


interface MaterialBridge {
  list(params?: { q?: string; page?: number; limit?: number; trash?: boolean }): Promise<{ items: Array<{ id: string; title: string; sourceType: string; content: string; evidenceGrade: string; revisionCount: number; trashed: boolean; createdAt: string }>; total: number }>;
  get(id: string): Promise<{ id: string; title: string; sourceType: string; content: string; evidenceGrade: string; fragments: unknown[]; revisionCount: number; trashed: boolean; createdAt: string }>;
  revisions(id: string): Promise<Array<{ id: string; captureId: string; content: string; ordinal: number; createdAt: string }>>;
  edit(id: string, content: string): Promise<{ id: string; captureId: string; content: string; ordinal: number; createdAt: string }>;
  trash(id: string): Promise<{ trashed: boolean }>;
  restore(id: string): Promise<{ restored: boolean }>;
  deleteImpact(id: string): Promise<{ hasNoImpact: boolean; topicMemberships: Array<{ topicId: string; topicTitle: string }>; workflowInputs: Array<{ workflowRunId: string; workflowType: string }>; citationCount: number }>;
  permanentDelete(id: string, acknowledge?: boolean): Promise<{ deleted: boolean }>;
}

declare global {
  interface Window {
    collector: { capture: CaptureBridge; workspace: WorkspaceBridge; recent: RecentBridge; material: MaterialBridge; settings: SettingsBridge };
  }
}

export {};