import type {
  ArtifactRecord,
  CaptureInput,
  CaptureRecord,
  TopicDocumentVersionRecord,
  TopicRecord,
  WorkflowRunRecord,
} from "@collector/capture-contracts";

interface CaptureBridge {
  submit(input: CaptureInput): Promise<CaptureRecord>;
  upload(file: File): Promise<ArtifactRecord>;
  hide(): void;
  navigate(tab: string): void;
  onFocus(callback: () => void): void;
  onShortcutError(callback: (shortcut: string) => void): void;
  onModeChange(callback: (mode: string) => void): void;
  onNavigate(callback: (tab: string) => void): void;
  onDataCleared(callback: () => void): void;
}

interface WorkspaceBridge {
  load(): Promise<{ topics: TopicRecord[] }>;
  createTopic(title: string, materialIds?: string[]): Promise<TopicRecord>;
  updateTopic(id: string, patch: { title?: string; status?: "active" | "archived" }): Promise<TopicRecord>;
  addTopicMember(topicId: string, captureId: string): Promise<unknown>;
  removeTopicMember(topicId: string, captureId: string): Promise<unknown>;
  generateDocument(topicId: string, idempotencyKey?: string): Promise<WorkflowRunRecord>;
  listDocuments(topicId: string): Promise<TopicDocumentVersionRecord[]>;
  getLatestDocument(topicId: string): Promise<TopicDocumentVersionRecord | null>;
  getDocumentVersion(documentId: string): Promise<TopicDocumentVersionRecord>;
  rollbackDocument(topicId: string, documentId: string): Promise<TopicDocumentVersionRecord>;
  getTopic(topicId: string): Promise<TopicRecord & { memberIds: string[]; documentVersion: number | null }>;
  promoteCluster(snapshotId: string, clusterIndex: number, title: string): Promise<TopicRecord>;
  topicSuggestions(topicId: string): Promise<Array<{ id: string; title: string; snippet: string }>>;
  workflowRun(runId: string): Promise<WorkflowRunRecord>;
  previewDocumentUpdate(topicId: string): Promise<import("@collector/capture-contracts").UpdatePreview | null>;
  confirmDocumentUpdate(topicId: string, previewId: string, accepted: boolean): Promise<import("@collector/capture-contracts").UpdatePreview>;
  verificationClaims(documentId: string): Promise<import("@collector/capture-contracts").VerificationClaim[]>;
  navigateTo(tab: string): void;
}

interface RecentBridge {
  organize(idempotencyKey?: string): Promise<import("@collector/capture-contracts").WorkflowRunRecord>;
  snapshot(): Promise<import("@collector/capture-contracts").RecentClusterSnapshotRecord>;
  run(id: string): Promise<import("@collector/capture-contracts").WorkflowRunRecord>;
  cancel(id: string): Promise<import("@collector/capture-contracts").WorkflowRunRecord>;
}

interface SettingsBridge {
  get(): Promise<{ shortcut: string; ai: { consent: boolean; configured: boolean; provider?: string; model?: string; unavailable?: boolean }; providerCatalog: import("@collector/capture-contracts").ProviderDefinition[]; providerProfiles: import("@collector/capture-contracts").ProviderProfile[]; activeProviderProfileId?: string }>;
  saveProvider(value: { profile: import("@collector/capture-contracts").ProviderProfileInput; apiKey?: string; consent?: boolean; activate?: boolean }): Promise<{ profile: import("@collector/capture-contracts").ProviderProfile; ai: { consent: boolean; configured: boolean; provider?: string; model?: string }; activeProviderProfileId?: string }>;
  testProvider(value: { profile: import("@collector/capture-contracts").ProviderProfileInput; apiKey?: string }): Promise<{ ok: true; model: string } | { ok: false; error: string }>;
  activateProvider(id: string): Promise<{ profile?: import("@collector/capture-contracts").ProviderProfile; ai: { consent: boolean; configured: boolean; provider?: string; model?: string } }>;
  deleteProvider(id: string): Promise<{ deleted: boolean; ai: { consent: boolean; configured: boolean; provider?: string; model?: string } }>;
  setAiConsent(consent: boolean): Promise<{ consent: boolean; configured: boolean; provider?: string; model?: string }>;
  saveShortcut(value: string): Promise<{ shortcut: string }>;
  clearAllData(): Promise<{ cleared: boolean }>;
  dataControl(): Promise<{
    usage: import("@collector/capture-contracts").AiUsageSummary;
    budget: import("@collector/capture-contracts").AiBudgetSettings;
    backups: import("@collector/capture-contracts").BackupRecord[];
    paths?: { database: string; artifacts: string; databaseExists: boolean };
  }>;
  saveAiBudget(value: { monthlyLimitUsd?: number; warningThresholdUsd?: number; enabled?: boolean }): Promise<import("@collector/capture-contracts").AiBudgetSettings>;
  createBackup(): Promise<import("@collector/capture-contracts").ExportResult>;
  verifyBackup(id: string): Promise<import("@collector/capture-contracts").BackupVerificationResult>;
  exportPortable(value: import("@collector/capture-contracts").ExportRequest): Promise<import("@collector/capture-contracts").ExportResult>;
}


interface MaterialBridge {
  list(params?: { q?: string; page?: number; limit?: number; trash?: boolean }): Promise<{ items: Array<{ id: string; title: string; sourceType: string; content: string; evidenceGrade: string; revisionCount: number; trashed: boolean; createdAt: string }>; total: number }>;
  get(id: string): Promise<{ id: string; title: string; sourceType: string; content: string; evidenceGrade: string; fragments: unknown[]; revisionCount: number; trashed: boolean; aiProcessingDisabled: boolean; createdAt: string }>;
  revisions(id: string): Promise<Array<{ id: string; captureId: string; content: string; ordinal: number; createdAt: string }>>;
  edit(id: string, content: string): Promise<{ id: string; captureId: string; content: string; ordinal: number; createdAt: string }>;
  setAiProcessing(id: string, disabled: boolean): Promise<{ aiProcessingDisabled: boolean }>;
  extractText(id: string): Promise<{ text: string; pageCount: number }>;
  trash(id: string): Promise<{ trashed: boolean }>;
  restore(id: string): Promise<{ restored: boolean }>;
  deleteImpact(id: string): Promise<{ hasNoImpact: boolean; topicMemberships: Array<{ topicId: string; topicTitle: string }>; workflowInputs: Array<{ workflowRunId: string; workflowType: string }>; citationCount: number }>;
  permanentDelete(id: string, acknowledge?: boolean): Promise<{ deleted: boolean }>;
}

declare global {
  const marked: { parse(input: string): string };
  const DOMPurify: { sanitize(dirty: string): string };

  class EasyMDE {
    constructor(options: EasyMDE.Options);
    value(): string;
    value(text: string): void;
    toTextArea(): void;
    isPreviewActive(): boolean;
    isSideBySideActive(): boolean;
    togglePreview(): void;
    toggleSideBySide(): void;
  }

  namespace EasyMDE {
    interface Options {
      element: HTMLElement;
      previewRender?: (plainText: string, preview: HTMLElement) => string;
      toolbar?: Array<string | { name: string; action?: string } | false>;
      spellChecker?: boolean;
      autoDownloadFontAwesome?: boolean;
      sideBySide?: boolean;
      sideBySideFullscreen?: boolean;
      status?: Array<string | false>;
      placeholder?: string;
      renderingConfig?: { singleLineBreaks?: boolean; codeSyntaxHighlighting?: boolean };
    }
  }

  interface Window {
    collector: { capture: CaptureBridge; workspace: WorkspaceBridge; recent: RecentBridge; material: MaterialBridge; settings: SettingsBridge };
  }
}

export {};
