  async generateTopicDocument(topicId: string, idempotencyKey?: string): Promise<WorkflowRunRecord> {
    if (!idempotencyKey?.trim()) throw new ValidationError("Idempotency-Key is required");
    const topic = this.store.getTopic(topicId);
    if (!topic) throw new NotFoundError("Topic not found");
    const memberIds = this.store.listTopicCaptureIds(topicId);
    if (!memberIds.length) throw new ValidationError("Topic has no materials");
    if (!this.modelGateway) throw new ValidationError("AI is not configured");
    const materialSetVersion = createHash("sha256").update(JSON.stringify([...memberIds].sort())).digest("hex");
    const existing = this.store.findWorkflowRun("topic_document_generation", idempotencyKey, materialSetVersion);
    if (existing) return existing;
    const now = new Date().toISOString();
    const run: WorkflowRunRecord = {
      id: randomUUID(), workflowType: "topic_document_generation", idempotencyKey,
      materialIds: memberIds, materialSetVersion, status: "queued", createdAt: now,
    };
    const stepTypes = ["freeze_topic_materials", "generate_outline", "generate_chapters", "verify_citations", "publish_document"] as const;
    const steps: WorkflowStepRecord[] = stepTypes.map((stepType) => ({
      id: randomUUID(), workflowRunId: run.id, stepType, status: "queued", createdAt: now,
    }));
    await this.store.createWorkflowRun(run, steps);
    void this.resumeTopicDocumentRuns();
    return run;
  }

  getTopicDocument(id: string): TopicDocument | undefined { return this.store.getTopicDocument(id); }
  getLatestTopicDocument(topicId: string): TopicDocument | undefined { return this.store.getLatestTopicDocument(topicId); }
  listTopicDocuments(topicId: string): TopicDocument[] { return this.store.listTopicDocuments(topicId); }

  async resumeTopicDocumentRuns(maxSteps = Number.POSITIVE_INFINITY): Promise<number> {
    let completedCount = 0;
    while (completedCount < maxSteps) {
      let progressed = false;
      for (const run of this.store.listRecoverableWorkflowRuns().filter((r: WorkflowRunRecord) => r.workflowType === "topic_document_generation")) {
        if (completedCount >= maxSteps) break;
        const now = new Date();
        const claimed = this.store.claimWorkflowStep(run.id, "topic-doc-worker", now.toISOString(), new Date(now.getTime() + 60000).toISOString());
        if (!claimed) continue;
        progressed = true;
        const processing: WorkflowRunRecord = { ...run, status: "processing", startedAt: run.startedAt ?? now.toISOString() };
        try {
          const step = await this.executeTopicDocumentStep(processing, claimed);
          this.store.completeWorkflowStep(step, processing);
          completedCount += 1;
        } catch (error) {
          const completedAt = new Date().toISOString();
          const msg = error instanceof Error ? error.message : "Topic document step failed";
          this.store.failWorkflowStep({ ...claimed, status: "failed", completedAt }, { ...processing, status: "failed", errorMessage: msg, completedAt });
          completedCount += 1;
        }
      }
      if (!progressed) break;
    }
    return completedCount;
  }

  private async executeTopicDocumentStep(run: WorkflowRunRecord, claimed: WorkflowStepRecord): Promise<WorkflowStepRecord> {
    const completedAt = new Date().toISOString();
    let output: unknown;
    if (claimed.stepType === "freeze_topic_materials") {
      const frags: FragmentRecord[] = [];
      for (const captureId of run.materialIds) frags.push(...this.store.listFragments(captureId));
      output = { materialIds: run.materialIds, fragments: frags, frozenAt: completedAt };
    } else if (claimed.stepType === "generate_outline") {
      const freezeStep = this.store.getWorkflowSteps(run.id).find((s: WorkflowStepRecord) => s.stepType === "freeze_topic_materials");
      const frozen = freezeStep?.output as { materialIds: string[]; fragments: FragmentRecord[]; frozenAt: string } | undefined;
      if (!frozen) throw new Error("Material freeze not found");
      output = await this.generateDocumentOutline(frozen);
    } else if (claimed.stepType === "generate_chapters") {
      const outlineStep = this.store.getWorkflowSteps(run.id).find((s: WorkflowStepRecord) => s.stepType === "generate_outline");
      const outline = outlineStep?.output as DocumentOutline | undefined;
      if (!outline) throw new Error("Outline not found");
      const freezeStep = this.store.getWorkflowSteps(run.id).find((s: WorkflowStepRecord) => s.stepType === "freeze_topic_materials");
      const frozen = freezeStep?.output as { materialIds: string[]; fragments: FragmentRecord[]; frozenAt: string } | undefined;
      if (!frozen) throw new Error("Material freeze not found");
      output = { sections: await this.generateDocumentChapters(outline, frozen) };
    } else if (claimed.stepType === "verify_citations") {
      const chaptersStep = this.store.getWorkflowSteps(run.id).find((s: WorkflowStepRecord) => s.stepType === "generate_chapters");
      const chapterOutput = chaptersStep?.output as { sections: DocumentChapter[] } | undefined;
      if (!chapterOutput) throw new Error("Chapters not found");
      const freezeStep = this.store.getWorkflowSteps(run.id).find((s: WorkflowStepRecord) => s.stepType === "freeze_topic_materials");
      const frozen = freezeStep?.output as { materialIds: string[]; fragments: FragmentRecord[]; frozenAt: string } | undefined;
      if (!frozen) throw new Error("Material freeze not found");
      output = this.verifyCitations(chapterOutput.sections, frozen);
    } else {
      const verifyStep = this.store.getWorkflowSteps(run.id).find((s: WorkflowStepRecord) => s.stepType === "verify_citations");
      const verified = verifyStep?.output as { sections: DocumentChapter[]; verifiedCount: number; unverifiedCount: number } | undefined;
      const outlineStep = this.store.getWorkflowSteps(run.id).find((s: WorkflowStepRecord) => s.stepType === "generate_outline");
      const outline = outlineStep?.output as DocumentOutline | undefined;
      if (!verified || !outline) throw new Error("Missing verified content or outline");
      const documentContent = this.renderDocument(verified.sections);
      const allTopics = this.store.listTopics();
      let foundTopicId = "";
      for (const t of allTopics) {
        const members = this.store.listTopicCaptureIds(t.id);
        if (run.materialIds.some((mid: string) => members.includes(mid))) { foundTopicId = t.id; break; }
      }
      const doc: TopicDocument = {
        id: randomUUID(), topicId: foundTopicId, version: 1, title: outline.title, content: documentContent,
        outline: JSON.stringify(outline), materialSetVersion: run.materialSetVersion,
        workflowRunId: run.id, status: "active", createdAt: completedAt,
      };
      await this.store.saveTopicDocument(doc);
      for (const old of this.store.listTopicDocuments(foundTopicId).filter((d: TopicDocument) => d.status === "active" && d.id !== doc.id)) {
        await this.store.saveTopicDocument({ ...old, status: "archived" });
      }
      output = { documentId: doc.id, topicId: foundTopicId, title: doc.title };
    }
    return { ...claimed, status: "completed", output, completedAt };
  }

  private async generateDocumentOutline(frozen: { materialIds: string[]; fragments: FragmentRecord[]; frozenAt: string }): Promise<DocumentOutline> {
    if (!this.modelGateway) throw new Error("AI not configured");
    const fragmentTexts = frozen.fragments.map((f: FragmentRecord) => "[FRAGMENT " + f.id + "]\n" + f.text).join("\n\n");
    const prompt = "Create a document outline from the following materials. Return JSON: {\"title\":\"...\",\"sections\":[{\"title\":\"...\",\"summary\":\"...\",\"materialIds\":[\"id1\"]}],\"gapNotes\":\"...\"}. Use only fragment IDs from: " + JSON.stringify(frozen.fragments.map((f: FragmentRecord) => f.id)) + "\n\nMaterials:\n" + fragmentTexts;
    const response = await this.modelGateway.complete(prompt, { model: this.modelGateway.modelName });
    const value = JSON.parse(response.content) as Record<string, unknown>;
    const validIds = new Set(frozen.fragments.map((f: FragmentRecord) => f.id));
    return {
      title: String(value.title ?? "Untitled Document"),
      sections: (Array.isArray(value.sections) ? value.sections : []).map((s: Record<string, unknown>, i: number) => ({
        title: String(s.title ?? "Section " + (i + 1)),
        summary: String(s.summary ?? ""),
        materialIds: (Array.isArray(s.materialIds) ? s.materialIds : []).map(String).filter((id: string) => validIds.has(id)),
      })),
      gapNotes: String(value.gapNotes ?? ""),
    };
  }

  private async generateDocumentChapters(outline: DocumentOutline, frozen: { materialIds: string[]; fragments: FragmentRecord[]; frozenAt: string }): Promise<DocumentChapter[]> {
    if (!this.modelGateway) throw new Error("AI not configured");
    const allFragments = frozen.fragments;
    const chapters: DocumentChapter[] = [];
    for (const section of outline.sections) {
      const relevant = allFragments.filter((f: FragmentRecord) => section.materialIds.includes(f.id));
      const fragmentTexts = relevant.map((f: FragmentRecord) => "[FRAGMENT " + f.id + "]\n" + f.text).join("\n\n");
      const prompt = "Write a chapter for \"" + section.title + "\". Summary: " + section.summary + ". Cite using [ref: fragmentId]. Return JSON: {\"title\":\"...\",\"content\":\"text with [ref: id] citations\",\"citations\":[{\"fragmentId\":\"id\",\"text\":\"quoted text\"}]}. Valid IDs: " + JSON.stringify(relevant.map((f: FragmentRecord) => f.id)) + "\n\nMaterials:\n" + fragmentTexts;
      const response = await this.modelGateway.complete(prompt, { model: "deepseek-v4-pro" });
      const value = JSON.parse(response.content) as Record<string, unknown>;
      chapters.push({
        title: String(value.title ?? section.title),
        content: String(value.content ?? ""),
        citations: (Array.isArray(value.citations) ? value.citations : []).map((c: Record<string, unknown>) => ({
          fragmentId: String(c.fragmentId ?? ""), text: String(c.text ?? ""),
        })),
      });
    }
    return chapters;
  }

  private verifyCitations(sections: DocumentChapter[], frozen: { materialIds: string[]; fragments: FragmentRecord[]; frozenAt: string }): { sections: DocumentChapter[]; verifiedCount: number; unverifiedCount: number } {
    const validIds = new Set(frozen.fragments.map((f: FragmentRecord) => f.id));
    let verifiedCount = 0, unverifiedCount = 0;
    for (const section of sections) {
      const refRegex = /\[ref:\s*([^\]]+)\]/g;
      let match: RegExpExecArray | null;
      while ((match = refRegex.exec(section.content)) !== null) {
        if (validIds.has(match[1].trim())) { verifiedCount += 1; }
        else { section.content = section.content.replace(match[0], "[unverified]"); unverifiedCount += 1; }
      }
    }
    return { sections, verifiedCount, unverifiedCount };
  }

  private renderDocument(sections: DocumentChapter[]): string {
    return sections.map((s: DocumentChapter) => "## " + s.title + "\n\n" + s.content).join("\n\n");
  }

  async requestDeepAnalysis(captureId: string): Promise<AgentRunRecord> {
    const capture = this.getCapture(captureId);
    if (capture.aiProcessingDisabled) throw new ValidationError("AI processing is disabled for this capture");
    if (!this.modelGateway) throw new ValidationError("AI is not configured");
    const fragments = this.store.listFragments(captureId);
    if (!fragments.length) throw new ValidationError("Capture has no parsed fragments");
    const existingRun = this.store.listAgentRuns(captureId).find((run: AgentRunRecord) => run.processingLevel === "L3" && (run.status === "queued" || run.status === "running"));
    if (existingRun) return existingRun;
    const run: AgentRunRecord = {
      id: randomUUID(), captureId, provider: this.modelGateway.providerName, model: "deepseek-v4-pro",
      promptVersion: this.modelGateway.promptVersion, processingLevel: "L3", status: "queued",
      retryCount: 0, createdAt: new Date().toISOString(),
    };
    await this.store.saveAgentRun(run);
    this.scheduleModelRun(capture, fragments, run);
    return run;
  }

  async createTopic(title: string, sourceOrMaterialIds?: { captureId: string; agentRunId: string; evidenceFragmentIds: string[] } | string[]): Promise<TopicRecord> {
    if (!title.trim()) throw new ValidationError("title is required");
    const materialIds = Array.isArray(sourceOrMaterialIds) ? sourceOrMaterialIds : undefined;
    const source = !Array.isArray(sourceOrMaterialIds) && sourceOrMaterialIds ? sourceOrMaterialIds : undefined;
    if (materialIds) for (const id of materialIds) { if (!this.store.getCapture(id)) throw new ValidationError("Unknown capture: " + id); }
    const existingSuggestion = source && this.store.listTopics().find((t: TopicRecord) => t.sourceAgentRunId === source.agentRunId && t.title === title.trim());
    if (existingSuggestion) return existingSuggestion;
    if (source) {
      if (!this.store.getCapture(source.captureId)) throw new ValidationError("Unknown source capture");
      const allowed = new Set(this.store.listFragments(source.captureId).map((f: FragmentRecord) => f.id));
      if (!source.evidenceFragmentIds.length || source.evidenceFragmentIds.some((id: string) => !allowed.has(id))) throw new ValidationError("Invalid evidence fragments");
      if (!this.store.listAgentRuns(source.captureId).some((run: AgentRunRecord) => run.id === source.agentRunId && run.status === "succeeded")) throw new ValidationError("Unknown successful source AgentRun");
    }
    const now = new Date().toISOString();
    const topic: TopicRecord = {
      id: randomUUID(), title: title.trim(), status: "active", origin: source ? "ai_suggestion" : "user",
      ...(source ? { sourceCaptureId: source.captureId, sourceAgentRunId: source.agentRunId, evidenceFragmentIds: source.evidenceFragmentIds } : {}),
      createdAt: now, updatedAt: now,
    };
    if (source) await this.store.saveTopicWithMembership(topic, source.captureId);
    else if (materialIds) {
      await this.store.saveTopic(topic);
      for (const captureId of materialIds) await this.store.saveTopicMembership(topic.id, captureId, now);
    } else await this.store.saveTopic(topic);
    return topic;
  }

  listTopics(): TopicRecord[] { return this.store.listTopics(); }

  async promoteClusterToTopic(clusterSnapshotId: string, clusterIndex: number, title: string, materialIds?: string[]): Promise<TopicRecord> {
    if (!title.trim()) throw new ValidationError("title is required");
    const latest = this.store.getLatestRecentClusterSnapshot();
    if (!latest || latest.id !== clusterSnapshotId) throw new NotFoundError("Cluster snapshot not found");
    const cluster = latest.clusters?.[clusterIndex];
    if (!cluster) throw new NotFoundError("Cluster not found in snapshot");
    const ids = materialIds ?? cluster.materialIds;
    if (!ids.length) throw new ValidationError("Cluster has no materials");
    for (const id of ids) { if (!this.store.getCapture(id)) throw new ValidationError("Unknown capture: " + id); }
    const now = new Date().toISOString();
    const topic: TopicRecord = { id: randomUUID(), title: title.trim(), status: "active", origin: "from_recent_cluster", createdAt: now, updatedAt: now };
    await this.store.saveTopic(topic);
    for (const captureId of ids) await this.store.saveTopicMembership(topic.id, captureId, now);
    return topic;
  }

  async updateTopic(id: string, patch: { title?: string; status?: "active" | "archived" }): Promise<TopicRecord> {
    const existing = this.store.getTopic(id);
    if (!existing) throw new NotFoundError("Topic not found");
    const updated: TopicRecord = { ...existing, ...(patch.title ? { title: patch.title.trim() } : {}), ...(patch.status ? { status: patch.status } : {}), updatedAt: new Date().toISOString() };
    await this.store.saveTopic(updated);
    return updated;
  }

  async addTopicMember(topicId: string, captureId: string): Promise<void> {
    if (!this.store.getTopic(topicId)) throw new NotFoundError("Topic not found");
    if (!this.store.getCapture(captureId)) throw new NotFoundError("Capture not found");
    await this.store.saveTopicMembership(topicId, captureId, new Date().toISOString());
  }

  async removeTopicMember(topicId: string, captureId: string): Promise<void> {
    if (!this.store.getTopic(topicId)) throw new NotFoundError("Topic not found");
    if (!this.store.getCapture(captureId)) throw new NotFoundError("Capture not found");
    await this.store.removeTopicMembership(topicId, captureId);
  }

  getTopicWorkspace(topicId: string): TopicWorkspace {
    const topic = this.store.getTopic(topicId);
    if (!topic) throw new NotFoundError("Topic not found");
    const captureIds = this.store.listTopicCaptureIds(topicId);
    const captures: InboxItem[] = captureIds.map((captureId: string) => ({
      capture: this.store.getCapture(captureId)!,
      fragments: this.store.listFragments(captureId),
      knowledgeItems: this.store.listKnowledgeItems(captureId),
      reviewProposals: this.store.listReviewProposals(captureId),
      agentRuns: this.store.listAgentRuns(captureId),
    }));
    const ids = new Set(captureIds);
    const relations = this.store.listRelations().filter((r: RelationRecord) => r.status === "active" && (ids.has(r.sourceCaptureId) || Boolean(r.targetCaptureId && ids.has(r.targetCaptureId))));
    return { topic, captures, relations };
  }

  getTopicSuggestions(topicId: string): { captures: InboxItem[] } {
    if (!this.store.getTopic(topicId)) throw new NotFoundError("Topic not found");
    const topicMembers = new Set(this.store.listTopicCaptureIds(topicId));
    const suggestions = this.store.listCaptures().filter((c: CaptureRecord) => !topicMembers.has(c.id)).slice(0, 10).map((c: CaptureRecord) => ({
      capture: c, fragments: this.store.listFragments(c.id),
      knowledgeItems: this.store.listKnowledgeItems(c.id),
      reviewProposals: this.store.listReviewProposals(c.id),
      agentRuns: this.store.listAgentRuns(c.id),
    }));
    return { captures: suggestions };
  }

  listMaterials(query?: string, page?: number, limit?: number, includeTrash?: boolean): { items: Array<{ id: string; title: string; sourceType: string; capturedAt: string; snippet: string; hasSource: boolean; trashed: boolean }>; total: number } {
    const all = this.store.listCaptures().sort((a: CaptureRecord, b: CaptureRecord) => b.createdAt.localeCompare(a.createdAt));
    const nonTrash = includeTrash ? all : all.filter((c: CaptureRecord) => !c.trashedAt);
    const q = query?.trim().toLowerCase();
    const filtered = q ? nonTrash.filter((c: CaptureRecord) => (c.content ?? "").toLowerCase().includes(q) || (c.sourceTitle ?? "").toLowerCase().includes(q) || (c.sourceUrl ?? "").toLowerCase().includes(q)) : nonTrash;
    const total = filtered.length;
    const p = page ?? 1;
    const l = Math.min(limit ?? 50, 200);
    const pageItems = filtered.slice((p - 1) * l, p * l).map((c: CaptureRecord) => ({ id: c.id, title: materialTitle(c), sourceType: c.captureType, capturedAt: c.capturedAt, snippet: (c.content ?? c.sourceUrl ?? "").slice(0, 200), hasSource: Boolean(c.sourceUrl || c.locator?.kind === "file" || c.locator?.kind === "browser"), trashed: Boolean(c.trashedAt) }));
    return { items: pageItems, total };
  }

  getMaterial(id: string): { id: string; title: string; sourceType: string; capturedAt: string; content: string; sourceUrl?: string; fileName?: string; pageNumber?: number; evidenceGrade: string; processingStatus: string; trashed: boolean; revisionCount: number; fragments: Array<{ text: string; locator: Record<string, unknown> }> } {
    const record = this.store.getCapture(id);
    if (!record) throw new NotFoundError("Material not found");
    const fragments = this.store.listFragments(id);
    const revisions = this.store.listRevisions(id);
    const latestRevision = revisions[0];
    const displayContent = latestRevision?.content ?? record.content ?? "";
    return { id: record.id, title: materialTitle(record), sourceType: record.captureType, capturedAt: record.capturedAt, content: displayContent, sourceUrl: record.sourceUrl, fileName: record.locator?.kind === "file" ? (record.locator as import("@collector/capture-contracts").FileLocator).fileName : undefined, pageNumber: record.locator?.kind === "file" ? (record.locator as import("@collector/capture-contracts").FileLocator).pageNumber : undefined, evidenceGrade: record.evidenceGrade, processingStatus: record.status, trashed: Boolean(record.trashedAt), revisionCount: revisions.length, fragments: fragments.map((f: FragmentRecord) => ({ text: f.text, locator: (f.locator ?? {}) as Record<string, unknown> })) };
  }

  listRevisions(materialId: string): Array<{ id: string; captureId: string; content: string; ordinal: number; createdAt: string }> {
    if (!this.store.getCapture(materialId)) throw new NotFoundError("Material not found");
    return this.store.listRevisions(materialId);
  }

  async editRevision(materialId: string, content: string): Promise<{ id: string; ordinal: number; createdAt: string }> {
    if (!this.store.getCapture(materialId)) throw new NotFoundError("Material not found");
    if (!content.trim()) throw new ValidationError("Content cannot be empty");
    const existing = this.store.listRevisions(materialId);
    const ordinal = existing.length > 0 ? Math.max(...existing.map((r: { ordinal: number }) => r.ordinal)) + 1 : 1;
    const revisionId = randomUUID();
    const createdAt = new Date().toISOString();
    await this.store.saveRevision({ id: revisionId, captureId: materialId, content: content.trim(), ordinal, createdAt });
    return { id: revisionId, ordinal, createdAt };
  }

  async trashMaterial(materialId: string): Promise<{ trashed: boolean; alreadyTrashed: boolean }> {
    const capture = this.store.getCapture(materialId);
    if (!capture) throw new NotFoundError("Material not found");
    if (capture.trashedAt) return { trashed: false, alreadyTrashed: true };
    const ok = await this.store.trashCapture(materialId, new Date().toISOString());
    return { trashed: ok, alreadyTrashed: false };
  }

  async restoreMaterial(materialId: string): Promise<{ restored: boolean; notTrashed: boolean }> {
    const capture = this.store.getCapture(materialId);
    if (!capture) throw new NotFoundError("Material not found");
    if (!capture.trashedAt) return { restored: false, notTrashed: true };
    const ok = await this.store.restoreCapture(materialId);
    return { restored: ok, notTrashed: false };
  }

  getDeleteImpact(materialId: string): { topicMemberships: Array<{ topicId: string; topicTitle: string }>; workflowInputs: Array<{ workflowRunId: string; workflowType: string }>; citationCount: number; hasNoImpact: boolean } {
    if (!this.store.getCapture(materialId)) throw new NotFoundError("Material not found");
    return this.store.getDeleteImpact(materialId);
  }

  async permanentDelete(materialId: string, acknowledgeImpact?: boolean): Promise<{ deleted: boolean; impactBlocked: boolean }> {
    if (!this.store.getCapture(materialId)) throw new NotFoundError("Material not found");
    const impact = this.store.getDeleteImpact(materialId);
    if (!impact.hasNoImpact && !acknowledgeImpact) return { deleted: false, impactBlocked: true };
    const ok = await this.store.deleteCapture(materialId);
    return { deleted: ok, impactBlocked: false };
  }

