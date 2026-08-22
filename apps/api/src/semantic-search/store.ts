import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ResearchSearchField, ResearchSearchLocator, ResearchSearchUnit, SemanticSearchInstallationState, SemanticSearchProfile } from "@collector/capture-contracts";

export type SemanticSearchGenerationState = "building" | "active" | "retired" | "failed";
export type SemanticSearchTaskKind = "download" | "index-build";
export type SemanticSearchTaskState = "queued" | "running" | "completed" | "cancelled" | "failed";

export interface SemanticSearchGenerationInput {
  id: string;
  profile: SemanticSearchProfile;
  embeddingKey: string;
  sourceKey: string;
  createdAt: string;
}

export type SemanticSearchUnitInput = ResearchSearchUnit & {
  generationId: string;
  sessionId: string;
  checksum: string;
  searchText: string;
  vector: Uint8Array;
  embeddingKey: string;
};

export interface SemanticSearchGenerationRecord extends SemanticSearchGenerationInput {
  state: SemanticSearchGenerationState;
  updatedAt: string;
  errorCode?: string;
}

export interface SemanticSearchKeywordMatch {
  unitId: string;
  nodeId: string;
  sessionId: string;
  field: ResearchSearchField;
  locator: ResearchSearchLocator;
  searchText: string;
}

export interface SemanticSearchVectorRecord extends SemanticSearchKeywordMatch {
  vector: Uint8Array;
}

export interface SemanticSearchTaskInput {
  id: string;
  kind: SemanticSearchTaskKind;
  profile?: SemanticSearchProfile;
  state: SemanticSearchTaskState;
  completedUnits: number;
  totalUnits: number;
  createdAt: string;
  errorCode?: string;
  /** Exact derived facts guarded by a durable resource failure. */
  sourceKey?: string;
  embeddingKey?: string;
}

export interface SemanticSearchTaskRecord extends SemanticSearchTaskInput {
  updatedAt: string;
}

export interface SemanticSearchInstallationInput {
  profile: SemanticSearchProfile;
  manifestJson: string;
  state: SemanticSearchInstallationState;
  downloadedBytes: number;
  totalBytes: number;
  updatedAt: string;
  errorCode?: string;
}

/**
 * Local-only derived search storage. It stores derived index copies, never canonical source
 * authority or product search results; callers resolve locators against the canonical body.
 */
export class SemanticSearchSqliteStore {
  constructor(private readonly database: DatabaseSync) {}

  getConfiguredProfile(): SemanticSearchProfile | undefined {
    const row = this.database.prepare("SELECT configured_profile FROM semantic_search_settings WHERE id = 1").get() as { configured_profile: SemanticSearchProfile } | undefined;
    return row?.configured_profile;
  }

  setConfiguredProfile(profile: SemanticSearchProfile): void {
    this.database.prepare("INSERT INTO semantic_search_settings (id, configured_profile) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET configured_profile = excluded.configured_profile").run(profile);
  }

  saveInstallation(input: SemanticSearchInstallationInput): void {
    this.database.prepare(`
      INSERT INTO semantic_model_installations (profile, manifest_json, state, downloaded_bytes, total_bytes, error_code, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile) DO UPDATE SET
        manifest_json = excluded.manifest_json,
        state = excluded.state,
        downloaded_bytes = excluded.downloaded_bytes,
        total_bytes = excluded.total_bytes,
        error_code = excluded.error_code,
        updated_at = excluded.updated_at
    `).run(input.profile, input.manifestJson, input.state, input.downloadedBytes, input.totalBytes, input.errorCode ?? null, input.updatedAt);
  }

  getInstallation(profile: SemanticSearchProfile): SemanticSearchInstallationInput | undefined {
    const row = this.database.prepare("SELECT profile, manifest_json, state, downloaded_bytes, total_bytes, error_code, updated_at FROM semantic_model_installations WHERE profile = ?").get(profile) as InstallationRow | undefined;
    return row && installationFromRow(row);
  }

  listInstallations(): SemanticSearchInstallationInput[] {
    return (this.database.prepare("SELECT profile, manifest_json, state, downloaded_bytes, total_bytes, error_code, updated_at FROM semantic_model_installations ORDER BY profile").all() as unknown as InstallationRow[]).map(installationFromRow);
  }

  createGeneration(input: SemanticSearchGenerationInput): void {
    this.database.prepare(`
      INSERT INTO semantic_search_index_generations (id, profile, embedding_key, source_key, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'building', ?, ?)
    `).run(input.id, input.profile, input.embeddingKey, input.sourceKey, input.createdAt, input.createdAt);
  }

  getGeneration(id: string): SemanticSearchGenerationRecord | undefined {
    const row = this.database.prepare("SELECT id, profile, embedding_key, source_key, state, created_at, updated_at, error_code FROM semantic_search_index_generations WHERE id = ?").get(id) as GenerationRow | undefined;
    return row && generationFromRow(row);
  }

  getActiveGeneration(profile: SemanticSearchProfile): SemanticSearchGenerationRecord | undefined {
    const row = this.database.prepare("SELECT id, profile, embedding_key, source_key, state, created_at, updated_at, error_code FROM semantic_search_index_generations WHERE profile = ? AND state = 'active'").get(profile) as GenerationRow | undefined;
    return row && generationFromRow(row);
  }

  failGeneration(id: string, errorCode: string, updatedAt: string): void {
    this.transaction(() => {
      const target = this.database.prepare("SELECT id FROM semantic_search_index_generations WHERE id = ? AND state = 'building'").get(id) as { id: string } | undefined;
      if (!target) return;
      // Failed vectors are not a reusable index. Remove vector, FTS and generation
      // together so repeated failures cannot grow the local database.
      this.deleteUnitsWhere("generation_id = ?", target.id);
      this.database.prepare("DELETE FROM semantic_search_index_generations WHERE id = ?").run(target.id);
    });
  }

  /** Atomically swaps a fully-built generation into visibility for exactly one profile. */
  activateGeneration(id: string, updatedAt: string): void {
    this.transaction(() => {
      const target = this.database.prepare("SELECT profile FROM semantic_search_index_generations WHERE id = ? AND state = 'building'").get(id) as { profile: SemanticSearchProfile } | undefined;
      if (!target) throw new Error("Only a building semantic search generation can be activated");
      this.database.prepare("UPDATE semantic_search_index_generations SET state = 'retired', updated_at = ? WHERE profile = ? AND state = 'active'").run(updatedAt, target.profile);
      this.database.prepare("UPDATE semantic_search_index_generations SET state = 'active', error_code = NULL, updated_at = ? WHERE id = ? AND state = 'building'").run(updatedAt, id);
      this.deleteGenerationsWhere("profile = ? AND state IN ('retired', 'failed', 'building') AND id <> ?", target.profile, id);
    });
  }

  /** Replaces all rows as one transaction, so FTS and vector rows never diverge. */
  replaceGenerationUnits(generationId: string, units: readonly SemanticSearchUnitInput[]): void {
    this.transaction(() => {
      const generation = this.database.prepare("SELECT embedding_key, state FROM semantic_search_index_generations WHERE id = ?").get(generationId) as { embedding_key: string; state: SemanticSearchGenerationState } | undefined;
      if (!generation || (generation.state !== "building" && generation.state !== "active")) throw new Error("Search units require a building or active generation");
      for (const unit of units) {
        if (unit.generationId !== generationId) throw new Error("Every search unit must belong to the replacement generation");
        if (unit.embeddingKey !== generation.embedding_key) throw new Error("Search unit embedding key must match its generation");
      }
      this.deleteUnitsWhere("generation_id = ?", generationId);
      const insertUnit = this.database.prepare(`
        INSERT INTO semantic_search_units (unit_id, generation_id, node_id, session_id, field, source_locator_json, checksum, search_text, vector, embedding_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertFts = this.database.prepare("INSERT INTO semantic_search_units_fts (rowid, search_text) VALUES (?, ?)");
      for (const unit of units) {
        const result = insertUnit.run(unit.id, unit.generationId, unit.nodeId, unit.sessionId, unit.field, JSON.stringify(unit.locator), unit.checksum, unit.searchText, unit.vector, unit.embeddingKey);
        insertFts.run(Number(result.lastInsertRowid), unit.searchText);
      }
    });
  }

  searchActiveKeyword(profile: SemanticSearchProfile, rawQuery: string, limit = 50): SemanticSearchKeywordMatch[] {
    const query = rawQuery.trim();
    if (!query) return [];
    const boundedLimit = requireLimit(limit, 100);
    const queryLength = [...query].length;
    // The FTS5 hidden rank column (= bm25, lower is better) ranks matches for
    // both the per-node window and the global cutoff; rowid tiebreaks keep the
    // order deterministic. The LIKE fallback has no relevance signal, so it
    // keeps stable insertion order.
    const ftsCte = `
      SELECT u.unit_id, u.node_id, u.session_id, u.field, u.source_locator_json, u.search_text, u.rowid AS unit_rowid,
        f.rank AS relevance,
        ROW_NUMBER() OVER (PARTITION BY u.node_id ORDER BY f.rank, u.rowid) AS node_rank
      FROM semantic_search_units u
      JOIN semantic_search_index_generations g ON g.id = u.generation_id AND g.state = 'active'
      JOIN semantic_search_units_fts f ON f.rowid = u.rowid
    `;
    const likeCte = `
      SELECT u.unit_id, u.node_id, u.session_id, u.field, u.source_locator_json, u.search_text, u.rowid AS unit_rowid,
        u.rowid AS relevance,
        ROW_NUMBER() OVER (PARTITION BY u.node_id ORDER BY u.rowid) AS node_rank
      FROM semantic_search_units u
      JOIN semantic_search_index_generations g ON g.id = u.generation_id AND g.state = 'active'
    `;
    const selectRanked = "SELECT unit_id, node_id, session_id, field, source_locator_json, search_text FROM matches WHERE node_rank <= 3 ORDER BY relevance, unit_rowid LIMIT ?";
    let rows: UnitMatchRow[];
    if (queryLength >= 3) {
      // FTS grammar receives a quoted literal through a bound parameter; user text never becomes SQL.
      const safePhrase = `"${query.replaceAll('"', '""')}"`;
      rows = this.database.prepare(`WITH matches AS (${ftsCte} WHERE g.profile = ? AND f.search_text MATCH ?) ${selectRanked}`)
        .all(profile, safePhrase, boundedLimit) as unknown as UnitMatchRow[];
    } else {
      const escaped = query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
      rows = this.database.prepare(`WITH matches AS (${likeCte} WHERE g.profile = ? AND u.search_text LIKE ? ESCAPE '\\') ${selectRanked}`)
        .all(profile, `%${escaped}%`, boundedLimit) as unknown as UnitMatchRow[];
    }
    return rows.map(keywordMatchFromRow);
  }

  listActiveVectors(profile: SemanticSearchProfile, embeddingKey: string, limit = 100, offset = 0): SemanticSearchVectorRecord[] {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Semantic search vector offset must be a non-negative integer");
    const rows = this.database.prepare(`
      SELECT u.unit_id, u.node_id, u.session_id, u.field, u.source_locator_json, u.search_text, u.vector
      FROM semantic_search_units u
      JOIN semantic_search_index_generations g ON g.id = u.generation_id AND g.state = 'active'
      WHERE g.profile = ? AND u.embedding_key = ? AND g.embedding_key = ?
      ORDER BY u.rowid LIMIT ? OFFSET ?
    `).all(profile, embeddingKey, embeddingKey, requireLimit(limit, 1_000), offset) as unknown as VectorRow[];
    return rows.map((row) => ({ ...keywordMatchFromRow(row), vector: new Uint8Array(row.vector) }));
  }

  /** Reserved for future node-level deletion. Session trashing and deletion clean their rows via the cascade helpers below. */
  deleteUnitsForNodes(nodeIds: readonly string[]): number {
    if (!nodeIds.length) return 0;
    let deleted = 0;
    this.transaction(() => {
      const placeholders = nodeIds.map(() => "?").join(", ");
      const affectedGenerations = this.database.prepare(`SELECT DISTINCT generation_id FROM semantic_search_units WHERE node_id IN (${placeholders})`)
        .all(...nodeIds) as Array<{ generation_id: string }>;
      deleted = this.deleteUnitsWhere(`node_id IN (${placeholders})`, ...nodeIds);
      for (const generation of affectedGenerations) {
        // Canonical trash/delete removes derived rows immediately. Mark the
        // surviving generation stale as well, so a restore to the same source
        // checksum cannot be mistaken for an already complete index.
        this.database.prepare("UPDATE semantic_search_index_generations SET source_key = CASE WHEN source_key LIKE 'invalidated:%' THEN source_key ELSE 'invalidated:' || source_key END WHERE id = ?")
          .run(generation.generation_id);
      }
    });
    return deleted;
  }

  createTask(input: SemanticSearchTaskInput): void {
    this.database.prepare(`
      INSERT INTO semantic_search_tasks (id, kind, profile, state, completed_units, total_units, error_code, source_key, embedding_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.kind, input.profile ?? null, input.state, input.completedUnits, input.totalUnits, input.errorCode ?? null, input.sourceKey ?? null, input.embeddingKey ?? null, input.createdAt, input.createdAt);
  }

  getTask(id: string): SemanticSearchTaskRecord | undefined {
    const row = this.database.prepare("SELECT id, kind, profile, state, completed_units, total_units, error_code, source_key, embedding_key, created_at, updated_at FROM semantic_search_tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row && taskFromRow(row);
  }

  getLatestTask(profile: SemanticSearchProfile, kind: SemanticSearchTaskKind): SemanticSearchTaskRecord | undefined {
    const row = this.database.prepare("SELECT id, kind, profile, state, completed_units, total_units, error_code, source_key, embedding_key, created_at, updated_at FROM semantic_search_tasks WHERE profile = ? AND kind = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(profile, kind) as TaskRow | undefined;
    return row && taskFromRow(row);
  }

  updateTask(id: string, input: Pick<SemanticSearchTaskInput, "state" | "completedUnits" | "totalUnits"> & { updatedAt: string; errorCode?: string; sourceKey?: string; embeddingKey?: string }): void {
    this.database.prepare(`
      UPDATE semantic_search_tasks
      SET state = ?, completed_units = ?, total_units = ?, error_code = ?,
          source_key = COALESCE(?, source_key), embedding_key = COALESCE(?, embedding_key), updated_at = ?
      WHERE id = ?
    `).run(input.state, input.completedUnits, input.totalUnits, input.errorCode ?? null, input.sourceKey ?? null, input.embeddingKey ?? null, input.updatedAt, id);
  }

  /** A process restart requeues work and removes generations that cannot be resumed. */
  requeueInterruptedTasks(updatedAt: string): number {
    let requeued = 0;
    this.transaction(() => {
      const result = this.database.prepare("UPDATE semantic_search_tasks SET state = 'queued', updated_at = ? WHERE state = 'running'").run(updatedAt);
      requeued = Number(result.changes);
      // Inference vectors live in the terminated process, so no building
      // generation can be continued safely after restart. The queued task is
      // retained and reused, while its partial vector/FTS rows are discarded.
      this.deleteGenerationsWhere("state = 'building'");
    });
    return requeued;
  }

  private deleteUnitsWhere(where: string, ...values: SQLInputValue[]): number {
    const rowIds = this.database.prepare(`SELECT rowid FROM semantic_search_units WHERE ${where}`).all(...values) as Array<{ rowid: number }>;
    if (!rowIds.length) return 0;
    const deleteFts = this.database.prepare("DELETE FROM semantic_search_units_fts WHERE rowid = ?");
    for (const row of rowIds) deleteFts.run(row.rowid);
    this.database.prepare(`DELETE FROM semantic_search_units WHERE ${where}`).run(...values);
    return rowIds.length;
  }

  private deleteGenerationsWhere(where: string, ...values: SQLInputValue[]): number {
    const ids = this.database.prepare(`SELECT id FROM semantic_search_index_generations WHERE ${where}`).all(...values) as Array<{ id: string }>;
    for (const generation of ids) this.deleteUnitsWhere("generation_id = ?", generation.id);
    if (ids.length) this.database.prepare(`DELETE FROM semantic_search_index_generations WHERE ${where}`).run(...values);
    return ids.length;
  }

  private transaction(action: () => void): void {
    this.database.exec("BEGIN IMMEDIATE");
    try { action(); this.database.exec("COMMIT"); }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}

interface InstallationRow { profile: SemanticSearchProfile; manifest_json: string; state: SemanticSearchInstallationState; downloaded_bytes: number; total_bytes: number; error_code: string | null; updated_at: string; }
interface GenerationRow { id: string; profile: SemanticSearchProfile; embedding_key: string; source_key: string; state: SemanticSearchGenerationState; created_at: string; updated_at: string; error_code: string | null; }
interface UnitMatchRow { unit_id: string; node_id: string; session_id: string; field: ResearchSearchField; source_locator_json: string; search_text: string; }
interface VectorRow extends UnitMatchRow { vector: Uint8Array; }
interface TaskRow { id: string; kind: SemanticSearchTaskKind; profile: SemanticSearchProfile | null; state: SemanticSearchTaskState; completed_units: number; total_units: number; error_code: string | null; source_key: string | null; embedding_key: string | null; created_at: string; updated_at: string; }

function installationFromRow(row: InstallationRow): SemanticSearchInstallationInput {
  return { profile: row.profile, manifestJson: row.manifest_json, state: row.state, downloadedBytes: row.downloaded_bytes, totalBytes: row.total_bytes, errorCode: row.error_code ?? undefined, updatedAt: row.updated_at };
}

function generationFromRow(row: GenerationRow): SemanticSearchGenerationRecord {
  return { id: row.id, profile: row.profile, embeddingKey: row.embedding_key, sourceKey: row.source_key, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at, errorCode: row.error_code ?? undefined };
}

function keywordMatchFromRow(row: UnitMatchRow): SemanticSearchKeywordMatch {
  return { unitId: row.unit_id, nodeId: row.node_id, sessionId: row.session_id, field: row.field, locator: JSON.parse(row.source_locator_json) as ResearchSearchLocator, searchText: row.search_text };
}

function taskFromRow(row: TaskRow): SemanticSearchTaskRecord {
  return {
    id: row.id, kind: row.kind, profile: row.profile ?? undefined, state: row.state, completedUnits: row.completed_units, totalUnits: row.total_units,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.source_key ? { sourceKey: row.source_key } : {}),
    ...(row.embedding_key ? { embeddingKey: row.embedding_key } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function requireLimit(limit: number, maximum: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw new Error(`Semantic search query limit must be a positive integer at most ${maximum}`);
  return limit;
}
