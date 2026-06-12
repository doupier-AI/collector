import type {
  ArtifactRecord,
  CaptureInput,
  CaptureRecord,
  InboxItem,
  RelationRecord,
  ReviewDecision,
  TopicRecord,
  TopicWorkspace,
} from "@collector/capture-contracts";

interface CaptureBridge {
  submit(input: CaptureInput): Promise<CaptureRecord>;
  upload(file: File): Promise<ArtifactRecord>;
  hide(): void;
  openWorkspace(): void;
  openSettings(): void;
  onFocus(callback: () => void): void;
  onShortcutError(callback: (shortcut: string) => void): void;
}

interface WorkspaceBridge {
  load(): Promise<{ inbox: InboxItem[]; topics: TopicRecord[]; relations: RelationRecord[] }>;
  decide(id: string, decision: ReviewDecision): Promise<unknown>;
  revoke(id: string): Promise<unknown>;
  createTopic(title: string): Promise<TopicRecord>;
  createSuggestedTopic(input: { title: string; sourceCaptureId: string; sourceAgentRunId: string; evidenceFragmentIds: string[] }): Promise<TopicRecord>;
  updateTopic(id: string, patch: { title?: string; status?: "active" | "archived" }): Promise<TopicRecord>;
  getTopic(id: string): Promise<TopicWorkspace>;
  addTopicMember(topicId: string, captureId: string): Promise<unknown>;
  removeTopicMember(topicId: string, captureId: string): Promise<unknown>;
  deepAnalysis(captureId: string): Promise<unknown>;
  openCapture(): void;
  openSettings(): void;
}

interface SettingsBridge {
  get(): Promise<{ shortcut: string; ai: { consent: boolean; configured: boolean; provider?: string; model?: string; unavailable?: boolean } }>;
  saveAi(value: { consent: boolean; apiKey?: string }): Promise<{ consent: boolean; configured: boolean; provider?: string; model?: string }>;
  saveShortcut(value: string): Promise<{ shortcut: string }>;
  openWorkspace(): void;
}

declare global {
  interface Window {
    collector: { capture: CaptureBridge; workspace: WorkspaceBridge; settings: SettingsBridge };
  }
}

export {};
