// workspace-renderer.ts - Collector workspace UI
// PRD 2.0 information architecture: Recent / Topics / Materials
//
// Each top-level tab calls initWorkspace(root, view) with its own DOM root.
// No Inbox/KnowledgeItem/ReviewProposal/Relation UI is rendered.

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

type ViewMode = "recent" | "topics" | "materials";

export function initWorkspace(root: HTMLElement, view: ViewMode): void {
  const bridge = window.collector;
  if (!bridge) {
    root.innerHTML = '<div class="empty-state"><h2>Bridge unavailable</h2><p>Collector preload not loaded.</p></div>';
    return;
  }

  let data: WorkspaceData = { captures: [], topics: [] };
  let selectedId: string | null = null;

  // Per-view DOM references
  const prefix = view;
  const listEl = root.querySelector<HTMLElement>(`#${prefix}-list`)!;
  const detailEl = root.querySelector<HTMLElement>(`#${prefix}-detail`)!;
  const searchEl = root.querySelector<HTMLInputElement>(`#${prefix}-search`)!;
  const titleEl = root.querySelector<HTMLElement>(`#${prefix}-title`)!;
  const refreshBtn = root.querySelector<HTMLButtonElement>(`#${prefix}-refresh`)!;

  async function load(): Promise<void> {
    try {
      const raw = await bridge.workspace.load() as unknown as { inbox: FlatCapture[]; topics: TopicRecord[] };
      data = { captures: raw.inbox, topics: raw.topics };
      renderList();
    } catch (err) {
      listEl.innerHTML = `<div class="empty-state"><p>Load failed: ${err instanceof Error ? err.message : "unknown error"}</p></div>`;
    }
  }

  async function renderList(): Promise<void> {
    const query = searchEl.value.toLowerCase();
    listEl.replaceChildren();

    if (view === "recent" || view === "materials") {
      // For materials view, use the material bridge for proper trash filtering
      let items = data.captures;
      if (view === "materials" && bridge.material) {
        try {
          const result = await bridge.material.list({ q: query || undefined });
          items = result.items as unknown as FlatCapture[];
        } catch { /* fall back to workspace data */ }
      }
      const filtered = query ? items.filter((c) =>
        (c.sourceTitle ?? c.content ?? "").toLowerCase().includes(query)
      ) : items;

      if (!filtered.length) {
        listEl.innerHTML = '<div class="empty-list">暂无内容</div>';
        return;
      }
      titleEl.textContent = view === "recent" ? "近期收集" : "全部材料";

      for (const item of filtered) {
        const btn = document.createElement("button");
        btn.className = `list-item${selectedId === item.id ? " active" : ""}`;
        btn.innerHTML = `<strong>${escapeHtml(captureLabel(item))}</strong><p>${escapeHtml(snippet(item.content ?? ""))}</p><div class="list-meta"><span>${escapeHtml(item.capturedAt?.slice(0, 10) ?? "")}</span></div>`;
        btn.addEventListener("click", () => {
          selectedId = item.id;
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
        btn.className = `list-item${selectedId === topic.id ? " active" : ""}`;
        btn.innerHTML = `<strong>${escapeHtml(topic.title)}</strong><p>${''}</p><div class="list-meta"><span>${escapeHtml(topic.status ?? "active")}</span></div>`;
        btn.addEventListener("click", () => {
          selectedId = topic.id;
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
    header.innerHTML = `<div><span class="eyebrow">CAPTURE</span><h2>${escapeHtml(captureLabel(item))}</h2></div>`;
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
      detailEl.append(sectionEl("Fragments",
        item.fragments.map((f) => cardEl(f.text.slice(0, 200), `Fragment ${f.id.slice(0, 8)}`))
      ));
    }

    if (item.agentRuns?.length) {
      detailEl.append(sectionEl("Agent Runs",
        item.agentRuns.map((r) => cardEl(`${r.provider ?? "?"} / ${r.model ?? "?"} | ${r.status}`, `Run ${r.id.slice(0, 8)}`))
      ));
    }

    // Material actions (edit/trash/restore/delete) for materials view
    if (view === "materials" && bridge.material) {
      const actions = div("actions");
      actions.style.cssText = "display:flex;gap:7px;margin-top:16px;flex-wrap:wrap";

      // Edit button
      const editBtn = buttonEl("编辑", "button", async () => {
        const newContent = prompt("编辑内容:", item.content ?? "");
        if (newContent !== null && newContent !== item.content) {
          try {
            await bridge.material!.edit(item.id, newContent);
            detailEl.querySelector(".body-copy")!.textContent = newContent;
          } catch (err) { alert("编辑失败: " + (err instanceof Error ? err.message : "unknown")); }
        }
      });
      actions.append(editBtn);

      // Trash button
      const trashed = (item as any).trashed;
      if (!trashed) {
        const trashBtn = buttonEl("移至回收站", "button", async () => {
          if (!confirm("确定移入回收站？")) return;
          try {
            await bridge.material!.trash(item.id);
            detailEl.innerHTML = '<div class="empty-state"><h2>已移入回收站</h2></div>';
          } catch (err) { alert("操作失败: " + (err instanceof Error ? err.message : "unknown")); }
        });
        trashBtn.style.color = "var(--red)";
        actions.append(trashBtn);
      } else {
        const restoreBtn = buttonEl("恢复", "button primary", async () => {
          try {
            await bridge.material!.restore(item.id);
            detailEl.innerHTML = '<div class="empty-state"><h2>已恢复</h2></div>';
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
    hero.innerHTML = `<div><span class="eyebrow">TOPIC</span><h2>${escapeHtml(topic.title)}</h2></div>`;
    detailEl.append(hero);

    try {
      const ws = await bridge.workspace.getTopic(topic.id) as unknown as { topic: TopicRecord; captures: CaptureRecord[] };
      if (ws.captures?.length) {
        detailEl.append(sectionEl(`Materials (${ws.captures.length})`,
          ws.captures.map((c) => {
            const node = div("card member");
            const label = (c as CaptureRecord).sourceTitle ?? (c as CaptureRecord).content?.slice(0, 72) ?? "Capture";
            node.innerHTML = `<strong>${escapeHtml(label)}</strong><p>${escapeHtml(((c as CaptureRecord).content ?? "").slice(0, 180))}</p>`;
            return node;
          })
        ));
      }
    } catch {
      // topic workspace unavailable
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
        recentSummary.textContent = "最近一次整理已完成。";
        recentOrganize.disabled = false;
        recentError.textContent = "";
      }
    } catch { /* no snapshot yet */ }
  }

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

  void loadRecent();
}

// ── Helpers ──

function captureLabel(item: CaptureRecord): string {
  return item.sourceTitle ?? item.content?.replace(/\s+/g, " ").slice(0, 72) ?? item.sourceUrl ?? item.note ?? "采集内容";
}

function snippet(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 120);
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
