import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ArtifactRecord, CaptureRecord, FragmentRecord, KnowledgeItemRecord, ReviewProposalRecord } from "@collector/capture-contracts";

interface StoreData {
  captures: Record<string, CaptureRecord>;
  captureByClientId: Record<string, string>;
  captureByChecksum: Record<string, string>;
  artifacts: Record<string, ArtifactRecord>;
  fragments: Record<string, FragmentRecord>;
  knowledgeItems: Record<string, KnowledgeItemRecord>;
  reviewProposals: Record<string, ReviewProposalRecord>;
}

const EMPTY_DATA: StoreData = {
  captures: {},
  captureByClientId: {},
  captureByChecksum: {},
  artifacts: {},
  fragments: {},
  knowledgeItems: {},
  reviewProposals: {},
};

export class JsonStore {
  private data: StoreData = structuredClone(EMPTY_DATA);
  private writeQueue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      this.data = { ...structuredClone(EMPTY_DATA), ...JSON.parse(await readFile(this.filePath, "utf8")) as StoreData };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.flush();
    }
  }

  getCapture(id: string): CaptureRecord | undefined {
    return this.data.captures[id];
  }

  getCaptureByClientId(clientId: string): CaptureRecord | undefined {
    const id = this.data.captureByClientId[clientId];
    return id ? this.data.captures[id] : undefined;
  }

  getCaptureByChecksum(checksum: string): CaptureRecord | undefined {
    const id = this.data.captureByChecksum[checksum];
    return id ? this.data.captures[id] : undefined;
  }

  getArtifact(id: string): ArtifactRecord | undefined {
    return this.data.artifacts[id];
  }

  listCaptures(): CaptureRecord[] {
    return Object.values(this.data.captures).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listFragments(captureId: string): FragmentRecord[] {
    return Object.values(this.data.fragments).filter((item) => item.captureId === captureId).sort((a, b) => a.ordinal - b.ordinal);
  }

  listKnowledgeItems(captureId: string): KnowledgeItemRecord[] {
    return Object.values(this.data.knowledgeItems).filter((item) => item.captureId === captureId);
  }

  listReviewProposals(captureId: string): ReviewProposalRecord[] {
    return Object.values(this.data.reviewProposals).filter((item) => item.captureId === captureId);
  }

  getReviewProposal(id: string): ReviewProposalRecord | undefined {
    return this.data.reviewProposals[id];
  }

  async saveCapture(record: CaptureRecord): Promise<void> {
    this.data.captures[record.id] = record;
    this.data.captureByClientId[record.clientCaptureId] = record.id;
    this.data.captureByChecksum[record.checksum] = record.id;
    await this.flush();
  }

  async saveArtifact(record: ArtifactRecord): Promise<void> {
    this.data.artifacts[record.id] = record;
    await this.flush();
  }

  async saveEnrichment(fragment: FragmentRecord, item: KnowledgeItemRecord, proposal: ReviewProposalRecord): Promise<void> {
    this.data.fragments[fragment.id] = fragment;
    this.data.knowledgeItems[item.id] = item;
    this.data.reviewProposals[proposal.id] = proposal;
    await this.flush();
  }

  async saveReviewProposal(record: ReviewProposalRecord): Promise<void> {
    this.data.reviewProposals[record.id] = record;
    await this.flush();
  }

  private flush(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(this.data, null, 2), "utf8");
      await rename(temporaryPath, this.filePath);
    });
    return this.writeQueue;
  }
}

export function defaultDataPaths(root = join(process.cwd(), ".collector-data")) {
  return { root, database: join(root, "store.json"), artifacts: join(root, "artifacts") };
}
