
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
