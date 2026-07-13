// workspace-renderer.ts - Collector workspace UI
// PRD 2.0 information architecture: Recent / Topics / Materials
//
// Each top-level tab calls initWorkspace(root, view) with its own DOM root.
// WorkspaceState is shared across all views so data, filters, and selection
// are consistent regardless of which tab is active.

import type {
  CaptureRecord,
  FragmentRecord,
  TopicRecord,
  AgentRunRecord,
  WorkflowRunStatus,
  WorkflowRunRecord,
} from "@collector/capture-contracts";

interface FlatCapture extends CaptureRecord {
  fragments: FragmentRecord[];
  agentRuns?: AgentRunRecord[];
}

interface WorkspaceData {
  captures: FlatCapture[];
  topics: TopicRecord[];
}

type ViewMode = "recent" | "topics" | "materials" | "trash";

// ── Shared workspace state (one instance across all tab views) ──

class WorkspaceState {
  data: WorkspaceData = { captures: [], topics: [] };
  selectedId: string | null = null;
  activeView: ViewMode | null = null;
  /** Set by recent ↦ materials navigation; cleared after consumption. */
  materialsFilter: string | null = null;
  private loaded = false;

  get isLoaded(): boolean { return this.loaded; }

  async load(bridge: NonNullable<typeof window.collector>): Promise<void> {
    try {
      const [raw, materials] = await Promise.all([
        bridge.workspace.load() as Promise<{ topics: TopicRecord[] }>,
        bridge.material.list({ limit: 200 }),
      ]);
      this.data = { captures: materials.items as unknown as FlatCapture[], topics: raw.topics };
      this.loaded = true;
    } catch (err) {
      console.error("WorkspaceState.load failed:", err);
      throw err;
    }
  }
}

const workspaceState = new WorkspaceState();

export function invalidateWorkspace(): void {
  workspaceState.data = { captures: [], topics: [] };
  workspaceState.selectedId = null;
}

export function initWorkspace(root: HTMLElement, view: ViewMode): void {
  const bridge = window.collector;
  if (!bridge) {
    root.innerHTML = '<div class="empty-state"><h2>Bridge unavailable</h2><p>Collector preload not loaded.</p></div>';
    return;
  }

  workspaceState.activeView = view;

  // Per-view DOM references
  const prefix = view;
  const listEl = root.querySelector<HTMLElement>(`#${prefix}-list`)!;
  const detailEl = root.querySelector<HTMLElement>(`#${prefix}-detail`)!;

  const createAnchor = root.querySelector<HTMLButtonElement>(`#${prefix}-refresh`)!;
  if (view === "topics" && !root.querySelector("#topics-create")) {
    const createButton = buttonEl("\u65b0\u5efa\u4e13\u9898", "button primary", async () => {
      const title = await requestTopicTitle();
      if (!title) return;
      await bridge.workspace.createTopic(title);
      await load();
    });
    createButton.id = "topics-create";
    createAnchor.parentElement?.append(createButton);
  }
  const searchEl = root.querySelector<HTMLInputElement>(`#${prefix}-search`)!;
  const titleEl = root.querySelector<HTMLElement>(`#${prefix}-title`)!;
  const refreshBtn = root.querySelector<HTMLButtonElement>(`#${prefix}-refresh`)!;

  async function load(): Promise<void> {
    try { await workspaceState.load(bridge!); }
    catch (err) {
      listEl.innerHTML = `<div class="empty-state"><p>Load failed: ${err instanceof Error ? err.message : "unknown error"}</p></div>`;
      return;
    }
    renderList();
  }

  async function renderList(): Promise<void> {
    const query = searchEl.value.toLowerCase();
    listEl.replaceChildren();
    const data = workspaceState.data;

    if (view === "recent" || view === "materials" || view === "trash") {
      // For materials and trash views, use the material bridge for proper filtering
      let displayItems: FlatCapture[];
      if ((view === "materials" || view === "trash") && bridge!.material) {
        try {
          const result = await bridge!.material.list({ q: query || undefined, trash: view === "trash" });
          // Backend already performed search and trash filtering, use results directly
          displayItems = result.items as unknown as FlatCapture[];
        } catch {
          // Fallback to workspace data with frontend filtering
          let items = data.captures.filter((c: any) => view === "trash" ? Boolean(c.trashedAt) : !c.trashedAt);
          const filtered = query ? items.filter((c) =>
            (c.sourceTitle ?? c.content ?? "").toLowerCase().includes(query)
          ) : items;
          displayItems = filtered;
        }
      } else {
        // recent view or other cases
        let items = data.captures;
        const filtered = query ? items.filter((c) =>
          (c.sourceTitle ?? c.content ?? "").toLowerCase().includes(query)
        ) : items;
        displayItems = filtered;
      }

      // Apply unclustered filter when navigated from recent "查看未归类材料" button
      const filterFlag = workspaceState.materialsFilter;

      // 应用未归类过滤器（但不立即清除状态）
      if (filterFlag === "unclustered" && view === "materials") {
        try {
          const snapshot = await bridge!.recent.snapshot();
          if (snapshot?.unclusteredMaterialIds) {
            const unclusteredSet = new Set(snapshot.unclusteredMaterialIds);
            displayItems = displayItems.filter((item) => unclusteredSet.has((item as any).id ?? item.id));
          }
        } catch { /* keep all items if snapshot unavailable */ }
      }

      // 在切换到其他视图时再清除状态
      if (view !== "materials") {
        workspaceState.materialsFilter = null;
      }

      if (!displayItems.length) {
        listEl.innerHTML = '<div class="empty-list">' + (filterFlag === "unclustered" ? "所有材料已归类" : "暂无内容") + '</div>';
        return;
      }
      titleEl.textContent = filterFlag === "unclustered" ? "未归类材料" : (view === "recent" ? "近期收集" : view === "trash" ? "回收站" : "全部材料");

      for (const item of displayItems) {
        const btn = document.createElement("button");
        btn.className = `list-item${workspaceState.selectedId === item.id ? " active" : ""}`;
        const trashedAt = (item as any).trashedAt;
        const metaHtml = trashedAt 
          ? `<span>${escapeHtml(formatTime(trashedAt))} 删除</span>`
          : `<div class="list-meta">${timeElement((item as any).createdAt ?? item.capturedAt, true)}</div>`;
        btn.innerHTML = `<strong>${escapeHtml(captureLabel(item))}</strong><p>${escapeHtml(snippet(item.content ?? ""))}</p>${metaHtml}`;
        btn.addEventListener("click", async () => {
          workspaceState.selectedId = item.id;
          await renderList();
          try {
            const full = await bridge!.material.get(item.id);
            renderCaptureDetail({ ...item, ...full } as unknown as FlatCapture);
          } catch (error) {
            detailEl.innerHTML = `<div class="empty-state"><p>\u6750\u6599\u52a0\u8f7d\u5931\u8d25\uff1a${escapeHtml(error instanceof Error ? error.message : "unknown")}</p></div>`;
          }
        });
        listEl.append(btn);
      }
    } else if (view === "topics") {
      const items = data.topics;
      const filtered = query ? items.filter((t) => t.title.toLowerCase().includes(query)) : items;

      if (!filtered.length) {
        listEl.innerHTML = '<div class="empty-list">暂无专题</div>';
        return;
      }
      titleEl.textContent = "专题";

      for (const topic of filtered) {
        const btn = document.createElement("button");
        btn.className = `list-item${workspaceState.selectedId === topic.id ? " active" : ""}`;
        btn.innerHTML = `<strong>${escapeHtml(topic.title)}</strong><p>${escapeHtml(topic.status ?? "active")}</p><div class="list-meta">${timeElement((topic as any).createdAt, true)}</div>`;
        btn.addEventListener("click", () => {
          workspaceState.selectedId = topic.id;
          renderList();
          renderTopicDetail(topic);
        });
        listEl.append(btn);
      }
    }
  }

  function renderCaptureDetail(item: FlatCapture): void {
    detailEl.replaceChildren();
    const header = div("detail-header");
    header.innerHTML = `<div><span class="eyebrow">CAPTURE</span><h2>${escapeHtml(captureLabel(item))}</h2><span class="detail-time">${escapeHtml(formatTime(item.capturedAt))}</span></div>`;
    detailEl.append(header);

    if (item.content) {
      const body = div("body-copy markdown-body");
      body.innerHTML = renderMarkdown(item.content);
      detailEl.append(body);
    }

    if (item.sourceUrl) {
      const src = div("section");
      src.innerHTML = `<div class="section-title"><h3>来源</h3></div><p class="card-meta">${escapeHtml(item.sourceUrl)}</p>`;
      detailEl.append(src);
    }

    if (item.fragments?.length) {
      const fragmentSection = sectionEl(
        "内容片段",
        item.fragments.map((f) => {
          const card = cardEl("", `片段 ${f.ordinal + 1}`);
          
          // 限制显示长度，超出部分显示...
          const maxLength = 500;
          const isLong = f.text.length > maxLength;
          const displayText = isLong ? f.text.slice(0, maxLength) + "..." : f.text;
          const fragmentDiv = div("markdown-body");
          fragmentDiv.innerHTML = renderMarkdown(displayText);
          card.innerHTML = "";
          card.append(fragmentDiv);
          if (isLong) {
            const hint = document.createElement("span");
            hint.className = "expand-hint";
            hint.textContent = "点击展开查看完整内容";
            card.append(hint);
          }
          
          // 添加点击展开功能
          if (isLong) {
            card.style.cursor = "pointer";
            card.addEventListener("click", () => {
              if (card.dataset.expanded === "true") {
                const md = card.querySelector(".markdown-body")!;
                md.innerHTML = renderMarkdown(displayText);
                card.dataset.expanded = "false";
              } else {
                const md = card.querySelector(".markdown-body")!;
                md.innerHTML = renderMarkdown(f.text);
                card.dataset.expanded = "true";
              }
            });
          }
          
          return card;
        })
      );
      
      // 添加工具提示
      fragmentSection.title = "从采集内容中自动分割的文本段落，用于 AI 分析和引用追踪";
      
      detailEl.append(fragmentSection);
    }

    if (item.agentRuns?.length) {
      detailEl.append(sectionEl("Agent Runs",
        item.agentRuns.map((r) => cardEl(`${r.provider ?? "?"} / ${r.model ?? "?"} | ${r.status}`, `Run ${r.id.slice(0, 8)}`))
      ));
    }

    // Material actions (edit/trash/restore/delete) for materials and trash views
    if ((view === "materials" || view === "trash") && bridge.material) {
      const actions = div("actions");
      actions.style.cssText = "display:flex;gap:7px;margin-top:16px;flex-wrap:wrap";

      // Edit button (only in materials view)
      if (view === "materials") {
        const editBtn = buttonEl("编辑", "button", async () => {
          try {
            // 先获取完整的材料详情
            const fullMaterial = await bridge.material!.get(item.id);
            console.log('[Edit Material] loaded full material:', { 
              id: fullMaterial.id, 
              hasContent: !!fullMaterial.content, 
              contentLength: fullMaterial.content?.length,
              sourceType: fullMaterial.sourceType,
              fileName: (fullMaterial as any).fileName
            });
            
            let contentToEdit = fullMaterial.content ?? "";
            
            // 检查是否为文件类型且没有 content
            const isFileWithoutContent = fullMaterial.sourceType === 'local_file' && (!fullMaterial.content || fullMaterial.content.length === 0);
            
            if (isFileWithoutContent) {
              // PDF 文件类型，尝试提取文本
              editBtn.disabled = true;
              const originalLabel = editBtn.textContent;
              editBtn.textContent = "提取中...";
              try {
                const result = await bridge.material!.extractText(fullMaterial.id);
                contentToEdit = result.text;
                console.log('[Edit Material] extracted PDF text:', { length: result.text.length, pageCount: result.pageCount });
              } catch (extractErr) {
                editBtn.disabled = false;
                editBtn.textContent = originalLabel;
                alert(`PDF 文本提取失败: ${extractErr instanceof Error ? extractErr.message : "unknown"}`);
                return;
              }
              editBtn.disabled = false;
              editBtn.textContent = originalLabel;
            }
            
            // 创建编辑对话框
            const { dialog, easyMDE } = createEditDialog();
            document.body.appendChild(dialog);
            
            // 填充内容
            if (contentToEdit) {
              easyMDE.value(contentToEdit);
            }
            
            console.log('[Edit Material] EasyMDE initialized, text length:', easyMDE.value().length);
            
            // 绑定按钮事件
            const cancelBtn = dialog.querySelector("#edit-cancel-btn") as HTMLButtonElement;
            const saveBtn = dialog.querySelector("#edit-save-btn") as HTMLButtonElement;
          
          const closeDialog = () => {
            easyMDE.toTextArea();
            dialog.remove();
            document.removeEventListener("keydown", handleEsc);
          };
          
          const handleEsc = (e: KeyboardEvent) => {
            if (e.key === "Escape") closeDialog();
          };
          document.addEventListener("keydown", handleEsc);
          
          cancelBtn.addEventListener("click", closeDialog);
          
          saveBtn.addEventListener("click", async () => {
            const newContent = easyMDE.value().trim();
            if (newContent !== (fullMaterial.content ?? "").trim()) {
              try {
                saveBtn.disabled = true;
                saveBtn.textContent = "保存中...";
                
                await bridge.material!.edit(fullMaterial.id, newContent);
                
                // 重新加载列表
                await renderList();
                // 清空详情面板
                detailEl.innerHTML = '<div class="empty-state"><span class="empty-glyph">⌃</span><h2>选择一条材料</h2><p>查看原文和来源信息。</p></div>';
                
                closeDialog();
                alert("保存成功");
              } catch (err) {
                alert("编辑失败: " + (err instanceof Error ? err.message : "unknown"));
              } finally {
                saveBtn.disabled = false;
                saveBtn.textContent = "保存";
              }
            } else {
              closeDialog();
            }
          });
        } catch (err) {
          alert("加载材料失败: " + (err instanceof Error ? err.message : "unknown"));
        }
        });
        actions.append(editBtn);
        const aiDisabled = Boolean(item.aiProcessingDisabled);
        actions.append(buttonEl(aiDisabled ? "允许云端 AI 处理" : "禁止云端 AI 处理", "button", async () => {
          try {
            const result = await bridge.material!.setAiProcessing(item.id, !aiDisabled);
            item.aiProcessingDisabled = result.aiProcessingDisabled;
            renderCaptureDetail(item);
          } catch (error) {
            alert(`AI 处理设置失败：${error instanceof Error ? error.message : "unknown"}`);
          }
        }));
      }

      // Trash button (only in materials view)
      const trashed = (item as any).trashed;
      if (!trashed && view === "materials") {
        const trashBtn = buttonEl("移至回收站", "button", async () => {
          if (!confirm("确定移入回收站？")) return;
          try {
            await bridge.material!.trash(item.id);
            detailEl.innerHTML = '<div class="empty-state"><h2>已移入回收站</h2></div>';
          await renderList();
          } catch (err) { alert("操作失败: " + (err instanceof Error ? err.message : "unknown")); }
        });
        trashBtn.style.color = "var(--red)";
        actions.append(trashBtn);
      }

      // Restore and permanent delete buttons (in trash view or when trashed)
      if (trashed || view === "trash") {
        const restoreBtn = buttonEl("恢复", "button primary", async () => {
          try {
            await bridge.material!.restore(item.id);
            detailEl.innerHTML = '<div class="empty-state"><h2>已恢复</h2></div>';
          await renderList();
          } catch (err) { alert("恢复失败: " + (err instanceof Error ? err.message : "unknown")); }
        });
        actions.append(restoreBtn);

        const delBtn = buttonEl("永久删除", "button danger", async () => {
          try {
            const impact = await bridge.material!.deleteImpact(item.id);
            if (!impact.hasNoImpact) {
              const topics = impact.topicMemberships.map(m => m.topicTitle).join(", ");
              if (!confirm(`该材料关联以下专题: ${topics}\n永久删除后文档引用将显示缺失。\n确认删除？`)) return;
            } else if (!confirm("确认永久删除？此操作不可撤销。")) return;
            await bridge.material!.permanentDelete(item.id, true);
            detailEl.innerHTML = '<div class="empty-state"><h2>已永久删除</h2></div>';
          await renderList();
          } catch (err) { alert("删除失败: " + (err instanceof Error ? err.message : "unknown")); }
        });
        delBtn.style.color = "var(--red)";
        actions.append(delBtn);
      }

      detailEl.append(actions);
    }
  }

  async function renderTopicDetail(topic: TopicRecord): Promise<void> {
    detailEl.replaceChildren();
    const hero = div("topic-hero");
    hero.innerHTML = `<div><span class="eyebrow">TOPIC</span><h2>${escapeHtml(topic.title)}</h2><span class="detail-time">${timeElement((topic as any).createdAt)}</span></div>`;
    detailEl.append(hero);

    const topicDetail = await bridge.workspace.getTopic(topic.id);
    const topicActions = div("actions");
    const renameButton = buttonEl("\u91cd\u547d\u540d", "button", async () => {
      const title = await requestTopicTitle(topic.title);
      if (!title || title === topic.title) return;
      const updated = await bridge.workspace.updateTopic(topic.id, { title });
      invalidateWorkspace();
      await renderTopicDetail(updated);
      await load();
    });
    const archiveButton = buttonEl(topic.status === "archived" ? "\u6062\u590d\u4e13\u9898" : "\u5f52\u6863", "button", async () => {
      const updated = await bridge.workspace.updateTopic(topic.id, { status: topic.status === "archived" ? "active" : "archived" });
      invalidateWorkspace();
      await renderTopicDetail(updated);
      await load();
    });
    topicActions.append(renameButton, archiveButton);
    detailEl.append(topicActions);

    const membersSection = div("section");
    membersSection.append(el("h3", `\u4e13\u9898\u6210\u5458\uff08${topicDetail.memberIds.length}\uff09`));
    for (const materialId of topicDetail.memberIds) {
      try {
        const material = await bridge.material.get(materialId);
        const row = div("topic-member-row");
        row.append(el("span", material.title));
        row.append(buttonEl("\u79fb\u9664", "button-link", async () => {
          await bridge.workspace.removeTopicMember(topic.id, materialId);
          await renderTopicDetail(topic);
        }));
        membersSection.append(row);
      } catch (error) {
        console.error("Failed to load topic member", materialId, error);
        membersSection.append(el("span", "\u6750\u6599\u4e0d\u53ef\u7528", "card-meta"));
      }
    }
    const suggestions = await bridge.workspace.topicSuggestions(topic.id);
    if (suggestions.length) {
      const picker = document.createElement("select");
      for (const suggestion of suggestions) {
        const option = document.createElement("option");
        option.value = suggestion.id;
        option.textContent = suggestion.title;
        picker.append(option);
      }
      const addButton = buttonEl("\u6dfb\u52a0\u6750\u6599", "button", async () => {
        if (!picker.value) return;
        await bridge.workspace.addTopicMember(topic.id, picker.value);
        await renderTopicDetail(topic);
      });
      const addRow = div("topic-member-add");
      addRow.append(picker, addButton);
      membersSection.append(addRow);
    }
    detailEl.append(membersSection);

    // === 新增：文档生成按钮 ===
    const actions = div("actions");
    actions.style.cssText = "display:flex;gap:8px;margin-top:16px";
    
    const genDocBtn = document.createElement("button");
    genDocBtn.className = "button primary";
    genDocBtn.textContent = "生成专题文档";
    genDocBtn.addEventListener("click", async () => {
      try {
        genDocBtn.disabled = true;
        genDocBtn.textContent = "生成中...";
        
        // 调用 API 生成文档
        const run = await bridge!.workspace.generateDocument(topic.id, crypto.randomUUID());
        alert(`文档生成已启动，工作流 ID: ${run.id}`);
        const completed = await waitForWorkflow(run.id);
        if (completed.status !== "completed") throw new Error(completed.errorMessage ?? "Document generation failed");
        
        // 刷新文档列表
        await renderTopicDetail(topic);
      } catch (err) {
        alert("生成失败: " + (err instanceof Error ? err.message : "unknown"));
      } finally {
        genDocBtn.disabled = false;
        genDocBtn.textContent = "生成专题文档";
      }
    });
    
    actions.append(genDocBtn);
    detailEl.append(actions);

    // === 新增：文档版本历史 ===
    await renderTopicDocuments(topic.id);


  }

  // === 新增：渲染文档列表函数 ===
  async function renderTopicDocuments(topicId: string): Promise<void> {
    try {
      const latest = await bridge!.workspace.getLatestDocument(topicId);
      if (!latest) return;
      const versions = await bridge!.workspace.listDocuments(topicId);
      const documentArea = div("section");
      const history = div("document-history");
      history.append(el("h3", "版本历史"));
      const versionBody = div("document-version-body");

      const showVersion = async (document: typeof latest): Promise<void> => {
        versionBody.replaceChildren();
        versionBody.append(el("h3", document.title));
        versionBody.append(el("p", `版本 ${document.documentVersion} · ${formatTime(document.publishedAt ?? document.createdAt)}`, "card-meta"));
        const claims = await bridge!.workspace.verificationClaims(document.id);
        const claimCounts = claims.reduce<Record<string, number>>((counts, claim) => {
          counts[claim.status] = (counts[claim.status] ?? 0) + 1;
          return counts;
        }, {});
        versionBody.append(el("p", claims.length
          ? `核验记录 ${claims.length} 条：支持 ${claimCounts.supported ?? 0}，有争议 ${claimCounts.disputed ?? 0}，证据不足/未核验 ${(claimCounts.insufficient ?? 0) + (claimCounts.unverified ?? 0)}`
          : "未提取到需要外部核验的关键陈述", "card-meta"));
        if (claims.length) {
          const verificationDetails = globalThis.document.createElement("details");
          const verificationSummary = globalThis.document.createElement("summary");
          verificationSummary.textContent = "查看核验说明";
          verificationDetails.append(verificationSummary);
          for (const claim of claims) {
            verificationDetails.append(el("p", `${claim.status}：${claim.statement} — ${claim.summary}`, claim.status === "supported" ? "card-meta" : "error-text"));
          }
          versionBody.append(verificationDetails);
        }

        if (document.gapItems.length) {
          const gaps = globalThis.document.createElement("details");
          gaps.className = "card document-gaps";
          const gapSummary = globalThis.document.createElement("summary");
          gapSummary.textContent = `材料缺口（${document.gapItems.length}）`;
          gaps.append(gapSummary);
          for (const gap of document.gapItems) gaps.append(el("p", gap.text, "error-text"));
          versionBody.append(gaps);
        }

        const citationLookup = new Map<string, { materialTitle: string; text: string }>();
        for (const materialId of document.materialIds) {
          try {
            const material = await bridge!.material!.get(materialId);
            for (const fragment of material.fragments as Array<{ id: string; text?: string }>) {
              citationLookup.set(fragment.id, { materialTitle: material.title, text: fragment.text ?? "" });
            }
          } catch (error) {
            console.error("Failed to load cited material", materialId, error);
          }
        }

        for (const section of document.sections) {
          const sectionCard = div("card document-section");
          sectionCard.append(el("h3", section.heading));
          const body = div("markdown-body");
          body.innerHTML = renderMarkdown(section.markdown);
          sectionCard.append(body);
          const citations = globalThis.document.createElement("details");
          const summary = globalThis.document.createElement("summary");
          summary.textContent = `${section.citationIds.length} 条引用`;
          citations.append(summary);
          for (const citationId of section.citationIds) {
            const citation = citationLookup.get(citationId);
            citations.append(el(
              "p",
              citation ? `${citation.materialTitle}：${citation.text.slice(0, 240)}` : `引用缺失（${citationId}）`,
              citation ? "card-meta" : "error-text",
            ));
          }
          sectionCard.append(citations);
          versionBody.append(sectionCard);
        }

        if (document.id !== latest.id) {
          versionBody.append(buttonEl("回退到此版本", "button", async () => {
            if (!confirm(`将 v${document.documentVersion} 的内容发布为最新版本？`)) return;
            await bridge!.workspace.rollbackDocument(topicId, document.id);
            const selectedTopic = workspaceState.data.topics.find((candidate) => candidate.id === topicId);
            if (selectedTopic) await renderTopicDetail(selectedTopic);
          }));
        } else {
          versionBody.append(buttonEl("检查新材料并更新", "button", async () => {
            const preview = await bridge!.workspace.previewDocumentUpdate(topicId);
            if (!preview) { alert("专题材料没有变化"); return; }
            const accepted = confirm(`发现 ${preview.proposedAdditions.length} 项新增、${preview.proposedModifications.length} 项修改，是否发布新版本？`);
            await bridge!.workspace.confirmDocumentUpdate(topicId, preview.id, accepted);
            const selectedTopic = workspaceState.data.topics.find((candidate) => candidate.id === topicId);
            if (accepted && selectedTopic) await renderTopicDetail(selectedTopic);
          }));
        }
      };

      for (const version of versions) {
        history.append(buttonEl(`v${version.documentVersion} · ${formatTime(version.publishedAt ?? version.createdAt)}`, "button-link", async () => {
          await showVersion(await bridge!.workspace.getDocumentVersion(version.id));
        }));
      }
      documentArea.append(history, versionBody);
      detailEl.append(documentArea);
      await showVersion(latest);
    } catch (error) {
      console.error("Failed to load topic documents", error);
      detailEl.append(el("p", `\u6587\u6863\u52a0\u8f7d\u5931\u8d25\uff1a${error instanceof Error ? error.message : "unknown"}`, "error-text"));
    }
  }

  async function waitForWorkflow(runId: string): Promise<WorkflowRunRecord> {
    while (true) {
      const run = await bridge!.workspace.workflowRun(runId);
      if (["completed", "failed", "cancelled", "waiting_for_budget"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // Recent organization (only for "recent" view)
  if (view === "recent") {
    setupRecentOrg(root, bridge);
  }

  // Events
  refreshBtn.addEventListener("click", () => { void load(); });
  searchEl.addEventListener("input", () => renderList());

  void load();
}

// ── Recent Organization ──

function setupRecentOrg(root: HTMLElement, bridge: typeof window.collector): void {
  if (!bridge) return;

  const recentBadge = root.querySelector<HTMLElement>("#recent-status-badge")!;
  const recentSummary = root.querySelector<HTMLElement>("#recent-summary")!;
  const recentOrganize = root.querySelector<HTMLButtonElement>("#recent-organize")!;
  const recentError = root.querySelector<HTMLElement>("#recent-error")!;
  const recentResult = root.querySelector<HTMLElement>("#recent-result")!;
  const clusterCount = root.querySelector<HTMLElement>("#recent-cluster-count")!;
  const viewUnclustered = root.querySelector<HTMLButtonElement>("#recent-view-unclustered")!;
  const retryBtn = root.querySelector<HTMLButtonElement>("#recent-retry")!;
  const clusterList = div("recent-clusters");
  clusterList.id = "recent-clusters";
  recentResult.append(clusterList);

  let activeRunId: string | undefined;
  let polling = false;

  async function loadRecent(): Promise<void> {
    console.log('[loadRecent] called at', new Date().toISOString());
    try {
      const snapshot = await bridge!.recent.snapshot();
      console.log('[loadRecent] snapshot received:', JSON.stringify(snapshot, null, 2));
      if (snapshot) {
        const clustered = snapshot.clusters.reduce((sum: number, c: { materialIds: string[] }) => sum + c.materialIds.length, 0);
        const unclustered = snapshot.unclusteredMaterialIds.length;
        console.log('[loadRecent] clustered:', clustered, 'unclustered:', unclustered);
        // 空快照（0 clusters + 0 unclustered）等同于无数据，应重置为待整理状态
        if (clustered === 0 && unclustered === 0) {
          console.log('[loadRecent] empty snapshot → resetRecentToIdle');
          resetRecentToIdle();
          return;
        }
        clusterCount.textContent = `${snapshot.clusters.length} clusters, ${clustered} classified, ${unclustered} unclustered`;
        await renderRecentClusters(snapshot);
        viewUnclustered.hidden = unclustered === 0;
        retryBtn.hidden = true;
        recentResult.hidden = false;
        recentBadge.dataset.status = "completed";
        recentBadge.textContent = "已完成";
        recentSummary.textContent = `整理于 ${relativeTime((snapshot as any).createdAt)}`;
        recentOrganize.disabled = false;
        recentError.textContent = "";
        console.log('[loadRecent] set status: completed');
      } else {
        console.log('[loadRecent] snapshot is null/undefined → resetRecentToIdle');
        resetRecentToIdle();
      }
    } catch (err) {
      // 后端无快照时抛 NotFoundError (404)
      console.log('[loadRecent] caught error → resetRecentToIdle:', err instanceof Error ? err.message : String(err));


      resetRecentToIdle();
    }
  }

  async function renderRecentClusters(snapshot: import("@collector/capture-contracts").RecentClusterSnapshotRecord): Promise<void> {
    clusterList.replaceChildren();
    for (const [clusterIndex, cluster] of snapshot.clusters.entries()) {
      const card = div("card recent-cluster-card");
      const heading = el("h3", cluster.name);
      const summary = el("p", cluster.summary, "card-copy");
      const members = div("cluster-members");
      const materialNames = await Promise.all(cluster.materialIds.map(async (materialId) => {
        try { return (await bridge!.material.get(materialId)).title; }
        catch { return "\u7f3a\u5931\u6750\u6599"; }
      }));
      for (const name of materialNames) members.append(el("span", name, "cluster-member"));
      const promote = buttonEl("\u4fdd\u5b58\u4e3a\u4e13\u9898", "button primary", async () => {
        const title = await requestTopicTitle(cluster.name);
        if (!title) return;
        await bridge!.workspace.promoteCluster(snapshot.id, clusterIndex, title);
        invalidateWorkspace();
        bridge!.capture.navigate("topics");
      });
      card.append(heading, summary, members, promote);
      clusterList.append(card);
    }

  }
  function resetRecentToIdle(): void {
    recentBadge.dataset.status = "idle";
    recentBadge.textContent = "待整理";
    recentSummary.textContent = "对近期采集的材料进行聚类与分组。";
    recentOrganize.disabled = false;
    recentOrganize.textContent = "立即整理";
    recentError.textContent = "";
    recentResult.hidden = true;
  }

  void loadRecent();
  void checkRecentAIConfig(root);

  async function pollRun(): Promise<void> {
    if (!activeRunId || polling) return;
    polling = true;
    try {
      const run = await bridge!.recent.run(activeRunId) as WorkflowRunRecord;
      const status: WorkflowRunStatus = run.status;
      if (status === "completed") {
        recentBadge.dataset.status = "completed";
        recentBadge.textContent = "已完成";
        recentSummary.textContent = "整理完成。";
        recentOrganize.disabled = false;
        recentOrganize.textContent = "重新整理";
        recentError.textContent = "";
        activeRunId = undefined;
        await loadRecent();
        void checkRecentAIConfig(root);
      } else if (status === "failed" || status === "cancelled") {
        recentBadge.dataset.status = "failed";
        recentBadge.textContent = status === "cancelled" ? "已取消" : "失败";
        recentSummary.textContent = run.errorMessage ?? (status === "cancelled" ? "整理已取消" : "未知错误");
        recentError.textContent = run.errorMessage ?? "";
        recentOrganize.disabled = false;
        activeRunId = undefined;
      } else if (status === "waiting_for_budget") {
        recentBadge.dataset.status = status;
        recentBadge.textContent = "等待预算";
        recentSummary.textContent = "AI 月度预算已用尽；提高预算后任务会自动继续。";
        recentError.textContent = run.errorMessage ?? "";
        recentOrganize.disabled = false;
        activeRunId = undefined;
      } else {
        recentBadge.dataset.status = status;
        recentBadge.textContent = status === "processing" ? "处理中..." : status;
        setTimeout(() => { polling = false; void pollRun(); }, 2000);
        return;
      }
    } catch {
      recentBadge.dataset.status = "failed";
      recentBadge.textContent = "错误";
    } finally {
      polling = false;
    }
  }

  recentOrganize.addEventListener("click", async () => {
    recentOrganize.disabled = true;
    recentBadge.dataset.status = "queued";
    recentBadge.textContent = "已排队";
    recentSummary.textContent = "正在启动整理…";
    recentError.textContent = "";
    try {
      const result = await bridge!.recent.organize('recent-ui-' + crypto.randomUUID()) as WorkflowRunRecord;
      activeRunId = result.id;
      recentBadge.dataset.status = "processing";
      recentBadge.textContent = "处理中…";
      void pollRun();
    } catch (err) {
      recentBadge.dataset.status = "failed";
      recentBadge.textContent = "失败";
      recentError.textContent = err instanceof Error ? err.message : "unknown";
      recentOrganize.disabled = false;
    }
  });

  viewUnclustered.addEventListener("click", () => {
    workspaceState.materialsFilter = "unclustered";
    bridge.capture.navigate("materials");
  });

  retryBtn.addEventListener("click", () => {
    recentOrganize.click();
  });
}

// ── AI Config Warning (module-level, can be called from shell-renderer) ──

export async function checkRecentAIConfig(root: HTMLElement): Promise<void> {
  const bridge = window.collector;
  if (!bridge) return;
  try {
    const config = await bridge.settings.get();
    const hasConsent = !!config?.ai?.consent;
    const hasApiKey = !!config?.ai?.configured;
    
    // 移除旧的警告（幂等设计）
    const oldWarning = root.querySelector(".warning-banner");
    if (oldWarning) oldWarning.remove();
    
    // 只有在确实缺少配置时才显示警告
    if (!hasConsent || !hasApiKey) {
      const warningDiv = div("warning-banner");
      warningDiv.innerHTML = `
          <span class="warning-icon">⚠️</span>
          <span>需要配置 AI 服务才能使用智能聚类功能</span>
          <a href="#" id="recent-warning-settings-link">前往设置</a>
        `;
      const container = root.querySelector(".recent-section");
      if (container) container.insertBefore(warningDiv, container.firstChild);
      
      const settingsLink = document.getElementById("recent-warning-settings-link");
      if (settingsLink) {
        settingsLink.addEventListener("click", (e) => {
          e.preventDefault();
          void window.collector.capture.navigate("settings");
        });
      }
    }
  } catch {
    // 无法获取配置，静默处理
  }
}

// ── Helpers ──

function captureLabel(item: CaptureRecord): string {
  return (item as any).title ?? item.sourceTitle ?? item.content?.replace(/\s+/g, " ").slice(0, 72) ?? item.sourceUrl ?? item.note ?? "采集内容";
}

function snippet(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 120);
}

function formatTime(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function relativeTime(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatTime(iso);
}

function timeElement(iso: string | undefined | null, useRelative: boolean = false): string {
  if (!iso) return "";
  const absolute = formatTime(iso);
  const relative = relativeTime(iso);
  if (useRelative) {
    return `<span title="${escapeHtml(absolute)}">${escapeHtml(relative)}</span>`;
  }
  return `<span>${escapeHtml(absolute)}</span>`;
}

function sectionEl(heading: string, nodes: HTMLElement[]): HTMLElement {
  const rootEl = div("section");
  rootEl.innerHTML = `<div class="section-title"><h3>${escapeHtml(heading)}</h3></div>`;
  if (!nodes.length) rootEl.append(el("p", "暂无内容", "card-meta"));
  else rootEl.append(...nodes);
  return rootEl;
}

function cardEl(copy: string, meta: string): HTMLElement {
  const node = div("card");
  node.innerHTML = `<div class="card-meta">${escapeHtml(meta)}</div><p>${escapeHtml(copy)}</p>`;
  return node;
}

function div(className = ""): HTMLDivElement {
  const node = document.createElement("div");
  node.className = className;
  return node;
}

function el<K extends keyof HTMLElementTagNameMap>(name: K, text: string, className = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  node.className = className;
  node.textContent = text;
  return node;
}


function buttonEl(label: string, className: string, action: () => Promise<void>): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  node.addEventListener("click", () => void action());
  return node;
}

function requestTopicTitle(initialValue = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = div("modal-overlay topic-title-overlay");
    const modal = div("modal topic-title-modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "topic-title-heading");

    const heading = el("h3", initialValue ? "重命名专题" : "专题名称");
    heading.id = "topic-title-heading";

    const form = document.createElement("form");
    const input = document.createElement("input");
    input.id = "topic-title-input";
    input.className = "topic-title-input";
    input.type = "text";
    input.required = true;
    input.maxLength = 200;
    input.autocomplete = "off";
    input.placeholder = "输入专题名称";
    input.value = initialValue;
    input.setAttribute("aria-label", "专题名称");

    const actions = div("modal-actions");
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "button";
    cancelButton.textContent = "取消";
    const submitButton = document.createElement("button");
    submitButton.id = "topic-title-submit";
    submitButton.type = "submit";
    submitButton.className = "button primary";
    submitButton.textContent = "确认";
    actions.append(cancelButton, submitButton);
    form.append(input, actions);
    modal.append(heading, form);
    overlay.append(modal);

    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(value);
    };

    cancelButton.addEventListener("click", () => finish(null));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(null);
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") finish(null);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const title = input.value.trim();
      if (!title) {
        input.setCustomValidity("请输入专题名称");
        input.reportValidity();
        return;
      }
      finish(title);
    });
    input.addEventListener("input", () => input.setCustomValidity(""));

    document.body.append(overlay);
    input.focus();
    input.select();
  });
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Markdown Detection & Rendering ─────────────────────────

/**
 * Heuristic detection: determines whether text is Markdown.
 * Strong signals: any one → Markdown.
 * Weak signals: ≥2 different types → Markdown.
 */
function isMarkdown(text: string): boolean {
  if (!text.trim()) return false;

  // ── Strong signals ──
  // ATX heading: line starting with #{1,6} + space + non-space
  if (/^#{1,6}\s+\S/m.test(text)) return true;
  // Fenced code block: line starting with ```
  if (/^```/m.test(text)) return true;
  // Table separator row: |---|---|
  if (/\|[-:| ]+\|/m.test(text)) return true;
  // Unordered list: consecutive lines starting with - * +
  if (/^(?:[-*+]\s.+\n?){2,}/m.test(text)) return true;
  // Ordered list: consecutive lines starting with 1. 2.
  if (/^(?:\d+\.\s.+\n?){2,}/m.test(text)) return true;

  // ── Weak signals (need ≥2 different types) ──
  let weakCount = 0;
  // Bold: **text**
  if (/\*\*[^*]+\*\*/.test(text)) weakCount++;
  // Italic: *text* (not part of bold)
  if (/(?<!\*)\*[^*]+\*(?!\*)/.test(text)) weakCount++;
  // Link: [text](url)
  if (/\[[^\]]+\]\([^)]+\)/.test(text)) weakCount++;
  // Inline code: `text`
  if (/`[^`]+`/.test(text)) weakCount++;
  // Blockquote: line starting with >
  if (/^>\s/m.test(text)) weakCount++;

  return weakCount >= 2;
}

/** Escape markdown syntax symbols for plain-text content. */
function escapeMarkdownSyntax(text: string): string {
  const htmlEscaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return htmlEscaped
    .replace(/\*/g, "&#42;")
    .replace(/#/g, "&#35;")
    .replace(/\|/g, "&#124;")
    .replace(/`/g, "&#96;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/\(/g, "&#40;")
    .replace(/\)/g, "&#41;")
    .replace(/^>/gm, "&#62;");
}

/** Unified render: detect → escape or marked → DOMPurify */
function renderMarkdown(text: string): string {
  if (!text || !text.trim()) return "";
  let html: string;
  if (isMarkdown(text)) {
    html = marked.parse(text);
  } else {
    html = "<pre>" + escapeMarkdownSyntax(text) + "</pre>";
  }
  return DOMPurify.sanitize(html);
}

// ── Custom Edit Dialog ───────────────────────────────────

function createEditDialog(): { dialog: HTMLElement; easyMDE: EasyMDE } {
  const dialog = document.createElement("div");
  dialog.className = "modal-overlay";
  dialog.innerHTML = `
    <div class="modal">
      <h3>编辑材料内容</h3>
      <textarea id="edit-textarea"></textarea>
      <div class="modal-actions">
        <button id="edit-cancel-btn" class="button secondary">取消</button>
        <button id="edit-save-btn" class="button primary">保存</button>
      </div>
    </div>
  `;
  const textarea = dialog.querySelector("#edit-textarea") as HTMLTextAreaElement;
  const easyMDE = new EasyMDE({
    element: textarea,
    spellChecker: false,
    autoDownloadFontAwesome: false, // 已手动加载 fontawesome.min.css
    sideBySide: false, // 不默认启用分栏
    sideBySideFullscreen: false, // 分栏不触发全屏，限制在弹窗内
    previewRender: (plainText: string) => renderMarkdown(plainText),
    toolbar: [
      "bold", "italic", "heading",
      "|",
      "quote", "unordered-list", "ordered-list",
      "|",
      "code", "link", "table",
      "|",
      "preview", "side-by-side", "fullscreen",
    ],
    placeholder: "输入 Markdown 内容…",
  });
  return { dialog, easyMDE };
}
