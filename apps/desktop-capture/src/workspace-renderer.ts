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
      const raw = await bridge.workspace.load() as unknown as { inbox: FlatCapture[]; topics: TopicRecord[] };
      this.data = { captures: raw.inbox, topics: raw.topics };
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
        btn.addEventListener("click", () => {
          workspaceState.selectedId = item.id;
          renderList();
          renderCaptureDetail(item);
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
      const body = div("body-copy");
      body.textContent = item.content;
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
          const text = f.text.length > maxLength 
            ? f.text.slice(0, maxLength) + "..." 
            : f.text;
          
          card.innerHTML = `
            <p>${escapeHtml(text)}</p>
            ${f.text.length > maxLength ? '<span class="expand-hint">点击展开查看完整内容</span>' : ''}
          `;
          
          // 添加点击展开功能
          if (f.text.length > maxLength) {
            card.style.cursor = "pointer";
            card.addEventListener("click", () => {
              if (card.dataset.expanded === "true") {
                card.querySelector("p")!.textContent = text;
                card.dataset.expanded = "false";
              } else {
                card.querySelector("p")!.textContent = f.text;
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
          // 创建并显示自定义对话框
          const dialog = createEditDialog();
          document.body.appendChild(dialog);
          
          const textarea = dialog.querySelector("#edit-content-textarea") as HTMLTextAreaElement;
          textarea.value = item.content ?? "";
          textarea.focus();
          
          // 绑定按钮事件
          const cancelBtn = dialog.querySelector("#edit-cancel-btn") as HTMLButtonElement;
          const saveBtn = dialog.querySelector("#edit-save-btn") as HTMLButtonElement;
          
          const closeDialog = () => {
            dialog.remove();
            document.removeEventListener("keydown", handleEsc);
          };
          
          const handleEsc = (e: KeyboardEvent) => {
            if (e.key === "Escape") closeDialog();
          };
          document.addEventListener("keydown", handleEsc);
          
          cancelBtn.addEventListener("click", closeDialog);
          
          saveBtn.addEventListener("click", async () => {
            const newContent = textarea.value;
            if (newContent !== item.content) {
              try {
                saveBtn.disabled = true;
                saveBtn.textContent = "保存中...";
                
                await bridge.material!.edit(item.id, newContent);
                
                // 重新加载材料详情以显示最新修订
                await renderCaptureDetail(item);
                await renderList();
                
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
        });
        actions.append(editBtn);
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
        
        // 刷新文档列表
        await renderTopicDocuments(topic.id);
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

    try {
      const ws = await bridge.workspace.getTopic(topic.id) as unknown as { topic: TopicRecord; captures: CaptureRecord[] };
      if (ws.captures?.length) {
        detailEl.append(sectionEl(`Materials (${ws.captures.length})`,
          ws.captures.map((c) => {
            const node = div("card member");
            const label = (c as CaptureRecord).sourceTitle ?? (c as CaptureRecord).content?.slice(0, 72) ?? "Capture";
            const source = (c as CaptureRecord).sourceUrl ? `<span class="card-source">${escapeHtml((c as CaptureRecord).sourceUrl!)}</span>` : "";
            const time = `<span class="card-time">${timeElement((c as CaptureRecord).capturedAt)}</span>`;
            node.innerHTML = `<strong>${escapeHtml(label)}</strong><p>${escapeHtml(((c as CaptureRecord).content ?? "").slice(0, 180))}</p><div class="card-meta-row">${source}${time}</div>`;
            return node;
          })
        ));
      }
    } catch {
      // topic workspace unavailable
    }
  }

  // === 新增：渲染文档列表函数 ===
  async function renderTopicDocuments(topicId: string): Promise<void> {
    try {
      const doc = await bridge!.workspace.getLatestDocument(topicId);
      if (!doc) return; // 无文档
      
      const docSection = div("section");
      docSection.innerHTML = `
        <div class="section-title"><h3>最新文档</h3></div>
        <div class="card">
          <div class="card-meta">版本 ${doc.documentVersion} · ${timeElement(doc.publishedAt ?? doc.createdAt)}</div>
          <p>${doc.sections.length} 个章节</p>
          <pre class="doc-preview">${escapeHtml(doc.sections.slice(0, 3).map((s: { heading: string }) => s.heading).join('\n'))}</pre>
        </div>
      `;
      detailEl.append(docSection);
    } catch {
      // 无文档或加载失败，静默处理
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

  let activeRunId: string | undefined;
  let polling = false;

  async function loadRecent(): Promise<void> {
    try {
      const snapshot = await bridge!.recent.snapshot();
      if (snapshot) {
        const clustered = snapshot.clusters.reduce((sum: number, c: { materialIds: string[] }) => sum + c.materialIds.length, 0);
        const unclustered = snapshot.unclusteredMaterialIds.length;
        clusterCount.textContent = `${snapshot.clusters.length} clusters, ${clustered} classified, ${unclustered} unclustered`;
        viewUnclustered.hidden = unclustered === 0;
        retryBtn.hidden = true;
        recentResult.hidden = false;
        recentBadge.dataset.status = "completed";
        recentBadge.textContent = "已完成";
        recentSummary.textContent = `整理于 ${relativeTime((snapshot as any).createdAt)}`;
        recentOrganize.disabled = false;
        recentError.textContent = "";
      } else {
        resetRecentToIdle();
      }
    } catch {
      // 后端无快照时抛 NotFoundError (404)，这才是真正的"无数据"路径
      resetRecentToIdle();
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
      } else if (status === "failed") {
        recentBadge.dataset.status = "failed";
        recentBadge.textContent = "失败";
        recentSummary.textContent = run.errorMessage ?? "未知错误";
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
    const hasApiKey = !!config?.ai?.apiKey;
    
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

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Custom Edit Dialog ───────────────────────────────────

function createEditDialog(): HTMLElement {
  const dialog = document.createElement("div");
  dialog.className = "modal-overlay";
  dialog.innerHTML = `
    <div class="modal">
      <h3>编辑材料内容</h3>
      <textarea id="edit-content-textarea" rows="10"></textarea>
      <div class="modal-actions">
        <button id="edit-cancel-btn" class="button secondary">取消</button>
        <button id="edit-save-btn" class="button primary">保存</button>
      </div>
    </div>
  `;
  return dialog;
}
