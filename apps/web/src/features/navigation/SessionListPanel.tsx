import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ProjectRecord, ResearchSessionRecord } from "@collector/capture-contracts";
import { useServices } from "../../app/services";
import { Skeleton } from "../../components/Skeleton/Skeleton";
import { PAIRED_EVENT } from "../auth/paired-event";
import { formatSessionTime } from "../research-session/format";
import { notifySessionsChanged, SESSIONS_CHANGED_EVENT } from "./session-events";

type ListState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; projects: ProjectRecord[]; sessions: ResearchSessionRecord[] };

/** 抽屉内的最近研究会话：项目 → 会话分组树，未分类兜底；变更操作后广播刷新。 */
export function SessionListPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { api } = useServices();
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("collector:session-collapsed") ?? "{}") as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [submittingProject, setSubmittingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");

  useEffect(() => {
    let stale = false;
    Promise.all([api.listProjects(), api.listResearchSessions()]).then(
      ([projects, sessions]) => {
        if (!stale) setState({ kind: "ready", projects, sessions });
      },
      () => {
        if (!stale) setState({ kind: "error" });
      },
    );
    return () => {
      stale = true;
    };
  }, [api, reloadNonce]);

  // 面板常驻时可能先于配对挂载（初始 401 失败）；配对完成后自动重试
  useEffect(() => {
    const refresh = () => setReloadNonce((nonce) => nonce + 1);
    window.addEventListener(PAIRED_EVENT, refresh);
    window.addEventListener(SESSIONS_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener(PAIRED_EVENT, refresh);
      window.removeEventListener(SESSIONS_CHANGED_EVENT, refresh);
    };
  }, []);

  // 折叠态持久化：overlay 模式抽屉重挂不丢
  useEffect(() => {
    localStorage.setItem("collector:session-collapsed", JSON.stringify(collapsed));
  }, [collapsed]);

  const toggleCollapsed = (projectId: string) => {
    setCollapsed((prev) => ({ ...prev, [projectId]: !prev[projectId] }));
  };

  const startRename = (target: string, currentName: string) => {
    setRenaming(target);
    setRenameValue(currentName);
    setMenuFor(null);
  };

  const commitRename = async (target: string) => {
    const name = renameValue.trim();
    if (!name || !state || state.kind !== "ready") {
      setRenaming(null);
      return;
    }
    const session = state.sessions.find((item) => item.id === target);
    try {
      if (session) {
        await api.updateResearchSession(target, { title: name });
      } else {
        await api.renameProject(target, name);
      }
      setRenaming(null);
      notifySessionsChanged();
    } catch {
      // 改名失败保持输入框，用户可重试或取消
    }
  };

  const handleCreateProject = async () => {
    const name = newProjectName.trim();
    if (!name || submittingProject) return;
    setSubmittingProject(true);
    try {
      await api.createProject(name, crypto.randomUUID());
      setNewProjectName("");
      setCreatingProject(false);
      notifySessionsChanged();
    } catch {
      // 创建失败保留输入框
    } finally {
      setSubmittingProject(false);
    }
  };

  const handleMove = async (sessionId: string, projectId: string | null) => {
    try {
      await api.updateResearchSession(sessionId, { projectId });
      setMenuFor(null);
      notifySessionsChanged();
    } catch {
      // 移动失败保持菜单
    }
  };

  const handleToggleArchive = async (sessionId: string, status: "active" | "archived") => {
    try {
      await api.updateResearchSession(sessionId, { status });
      setMenuFor(null);
      notifySessionsChanged();
    } catch {
      // 归档切换失败保持菜单
    }
  };

  const handleTrash = async (sessionId: string) => {
    if (!window.confirm("删除后会话将进入回收站，30 天内可恢复。确定删除吗？")) return;
    try {
      await api.trashResearchSession(sessionId);
      setMenuFor(null);
      notifySessionsChanged();
    } catch {
      // 删除失败保持菜单
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    if (!window.confirm("删除项目不会删除其中的会话，其下会话将回到未分类。确定删除吗？")) return;
    try {
      await api.deleteProject(projectId);
      setMenuFor(null);
      notifySessionsChanged();
    } catch {
      // 删除失败保持菜单
    }
  };

  if (state.kind === "loading") {
    return (
      <div className="drawer__sessions" aria-label="正在读取最近研究">
        <Skeleton lines={3} />
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="drawer__sessions">
        <p className="drawer__empty">暂时无法读取最近研究。</p>
        <button type="button" className="button button--secondary" onClick={() => setReloadNonce((nonce) => nonce + 1)}>
          重试
        </button>
      </div>
    );
  }

  if (state.sessions.length === 0 && state.projects.length === 0) {
    return (
      <div className="drawer__sessions">
        <p className="drawer__empty">还没有研究会话。写下第一个问题，Collector 会为你保存这次研究。</p>
        <button type="button" className="drawer__new-project" onClick={() => setCreatingProject((value) => !value)}>
          ＋ 新建项目
        </button>
        {creatingProject ? (
          <div className="drawer__inline-create">
            <input
              type="text"
              className="input"
              value={newProjectName}
              maxLength={40}
              aria-label="新项目名称"
              onChange={(event) => setNewProjectName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleCreateProject();
                if (event.key === "Escape") setCreatingProject(false);
              }}
            />
            <button type="button" className="button button--secondary" disabled={submittingProject} onClick={() => void handleCreateProject()}>
              创建
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const groups: Array<{ projectId: string | null; title: string; sessions: ResearchSessionRecord[] }> = [
    ...state.projects.map((project) => ({
      projectId: project.id,
      title: project.name,
      sessions: state.sessions.filter((session) => session.projectId === project.id),
    })),
  ];
  const unclassified = state.sessions.filter((session) => !session.projectId);
  if (unclassified.length > 0) {
    groups.push({ projectId: null, title: "未分类", sessions: unclassified });
  }

  const renderInlineRename = (target: string) => (
    <div className="drawer__inline-rename">
      <input
        type="text"
        className="input"
        value={renameValue}
        maxLength={40}
        aria-label="重命名"
        autoFocus
        onChange={(event) => setRenameValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void commitRename(target);
          if (event.key === "Escape") setRenaming(null);
        }}
      />
      <button type="button" className="button button--secondary" onClick={() => void commitRename(target)}>
        保存
      </button>
    </div>
  );

  const renderSessionMenu = (session: ResearchSessionRecord) => (
    <>
      <button type="button" className="session-menu__overlay" aria-label="关闭菜单" onClick={() => setMenuFor(null)} />
      <div className="session-menu" role="menu" aria-label={`${session.title} 的操作`}>
        <button type="button" role="menuitem" className="session-menu__item" onClick={() => startRename(session.id, session.title)}>
          重命名
        </button>
        <div role="menuitem" className="session-menu__group" aria-label="移动到项目">
          <span className="session-menu__group-title">移动到</span>
          {state.kind === "ready" ? (
            <>
              <button
                type="button"
                role="menuitem"
                className={`session-menu__item${session.projectId ? "" : " session-menu__item--active"}`}
                onClick={() => void handleMove(session.id, null)}
              >
                未分类
              </button>
              {state.projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  role="menuitem"
                  className={`session-menu__item${session.projectId === project.id ? " session-menu__item--active" : ""}`}
                  onClick={() => void handleMove(session.id, project.id)}
                >
                  {project.name}
                </button>
              ))}
            </>
          ) : null}
        </div>
        <button
          type="button"
          role="menuitem"
          className="session-menu__item"
          onClick={() => void handleToggleArchive(session.id, session.status === "archived" ? "active" : "archived")}
        >
          {session.status === "archived" ? "取消归档" : "归档"}
        </button>
        <button type="button" role="menuitem" className="session-menu__item session-menu__item--danger" onClick={() => void handleTrash(session.id)}>
          删除…
        </button>
      </div>
    </>
  );

  const renderProjectMenu = (projectId: string, name: string) => (
    <>
      <button type="button" className="session-menu__overlay" aria-label="关闭菜单" onClick={() => setMenuFor(null)} />
      <div className="session-menu" role="menu" aria-label={`${name} 的操作`}>
        <button type="button" role="menuitem" className="session-menu__item" onClick={() => startRename(projectId, name)}>
          重命名
        </button>
        <button
          type="button"
          role="menuitem"
          className="session-menu__item session-menu__item--danger"
          onClick={() => void handleDeleteProject(projectId)}
        >
          删除项目…
        </button>
      </div>
    </>
  );

  return (
    <div className="drawer__sessions">
      {groups.map((group) => {
        const isCollapsed = group.projectId !== null && collapsed[group.projectId] === true;
        return (
          <section key={group.projectId ?? "unclassified"} className="drawer__group">
            <div className="drawer__group-head">
              {group.projectId !== null ? (
                <button
                  type="button"
                  className="drawer__group-toggle"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleCollapsed(group.projectId as string)}
                >
                  <span className={`drawer__group-caret${isCollapsed ? " drawer__group-caret--closed" : ""}`} aria-hidden="true">
                    ▾
                  </span>
                  {group.title}
                  <span className="drawer__group-count">({group.sessions.length})</span>
                </button>
              ) : (
                <span className="drawer__group-title">
                  {group.title}
                  <span className="drawer__group-count">({group.sessions.length})</span>
                </span>
              )}
              {group.projectId !== null ? (
                <button
                  type="button"
                  className="drawer__group-more"
                  aria-label={`${group.title} 的菜单`}
                  aria-expanded={menuFor === group.projectId}
                  aria-haspopup="true"
                  onClick={() => setMenuFor(menuFor === group.projectId ? null : group.projectId)}
                >
                  ⋯
                </button>
              ) : null}
            </div>
            {isCollapsed ? null : (
              <ul className="drawer__sessions--list">
                {group.sessions.map((session) =>
                  renaming === session.id ? (
                    <li key={session.id} className="drawer__session-row">
                      {renderInlineRename(session.id)}
                    </li>
                  ) : (
                    <li key={session.id} className="drawer__session-row">
                      <div className="drawer__session-wrap">
                        <Link
                          className={`drawer__session${session.status === "archived" ? " drawer__session--archived" : ""}`}
                          to={`/research/${encodeURIComponent(session.id)}`}
                          onClick={onNavigate}
                        >
                          <span className="drawer__session-title">{session.title}</span>
                          <span className="drawer__session-time">
                            {session.status === "archived" ? "已归档 · " : ""}
                            {formatSessionTime(session.updatedAt)}
                          </span>
                        </Link>
                        <button
                          type="button"
                          className="drawer__session-more"
                          aria-label={`${session.title} 的菜单`}
                          aria-expanded={menuFor === session.id}
                          aria-haspopup="true"
                          onClick={() => setMenuFor(menuFor === session.id ? null : session.id)}
                        >
                          ⋯
                        </button>
                      </div>
                      {menuFor === session.id ? renderSessionMenu(session) : null}
                    </li>
                  ),
                )}
              </ul>
            )}
            {menuFor === group.projectId && group.projectId !== null ? renderProjectMenu(group.projectId, group.title) : null}
          </section>
        );
      })}
      <button type="button" className="drawer__new-project" onClick={() => setCreatingProject((value) => !value)}>
        ＋ 新建项目
      </button>
      {creatingProject ? (
        <div className="drawer__inline-create">
          <input
            type="text"
            className="input"
            value={newProjectName}
            maxLength={40}
            aria-label="新项目名称"
            onChange={(event) => setNewProjectName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleCreateProject();
              if (event.key === "Escape") setCreatingProject(false);
            }}
          />
          <button type="button" className="button button--secondary" disabled={submittingProject} onClick={() => void handleCreateProject()}>
            创建
          </button>
        </div>
      ) : null}
    </div>
  );
}
