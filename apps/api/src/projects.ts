import { randomUUID } from "node:crypto";
import type { ProjectRecord, ProjectInput } from "@collector/capture-contracts";
import { RESEARCH_TITLE_MAX_CHARACTERS } from "@collector/capture-contracts";
import type { ResearchStore } from "./store.js";
import { ResearchValidationError, ResearchNotFoundError } from "./research.js";

/** 项目：会话的第一层分组容器。不嵌套；无归属会话处于"未分类"。 */
export class ResearchProjectService {
  constructor(private readonly store: ResearchStore) {}

  async createProject(input: ProjectInput, idempotencyKey: string): Promise<ProjectRecord> {
    if (!idempotencyKey.trim()) throw new ResearchValidationError("Idempotency-Key is required");
    if (idempotencyKey.length > 200) throw new ResearchValidationError("Idempotency-Key must not exceed 200 characters");
    const name = input.name.trim();
    if (!name || name.length > RESEARCH_TITLE_MAX_CHARACTERS) {
      throw new ResearchValidationError(`Project name must contain 1-${RESEARCH_TITLE_MAX_CHARACTERS} characters`);
    }
    const now = new Date().toISOString();
    const record: ProjectRecord = {
      id: randomUUID(),
      name,
      createdAt: now,
      updatedAt: now,
    };
    return this.store.createProject(record, idempotencyKey);
  }

  listProjects(): ProjectRecord[] {
    return this.store.listProjects();
  }

  async renameProject(id: string, name: string): Promise<ProjectRecord> {
    const normalized = name.trim();
    if (!normalized || normalized.length > RESEARCH_TITLE_MAX_CHARACTERS) {
      throw new ResearchValidationError(`Project name must contain 1-${RESEARCH_TITLE_MAX_CHARACTERS} characters`);
    }
    const updated = await this.store.renameProject(id, normalized);
    if (!updated) throw new ResearchNotFoundError("Project not found");
    return updated;
  }

  /** 删除项目：其下会话移回未分类（事务内），不删会话。 */
  async deleteProject(id: string): Promise<boolean> {
    const deleted = await this.store.deleteProject(id);
    if (!deleted) throw new ResearchNotFoundError("Project not found");
    return deleted;
  }
}
