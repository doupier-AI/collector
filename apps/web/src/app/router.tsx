import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { AppShell } from "../components/AppShell/AppShell";
import { ReadingPage } from "../features/imports/ReadingPage";
import { HomeRoute } from "../features/research-session/HomeRoute";
import { NotFoundPage } from "../features/research-session/NotFoundPage";
import { ResearchNodePage } from "../features/research-session/ResearchNodePage";
import { StartPage } from "../features/research-session/StartPage";
import { AiModelSettingsPage } from "../features/settings/AiModelSettingsPage";
import { FusionSettingsPage } from "../features/settings/FusionSettingsPage";
import { RunRecordsPage } from "../features/run-records/RunRecordsPage";

/**
 * 旧会话路由重定向（阶段 H2）：根节点 ID 与会话 ID 相同，
 * replace 重定向并保留 ?sel= 查询参数与路由 state（开始页首问）。
 */
function SessionRedirect() {
  const { sessionId = "" } = useParams();
  const location = useLocation();
  return (
    <Navigate
      to={`/research/${encodeURIComponent(sessionId)}/node/${encodeURIComponent(sessionId)}${location.search}`}
      replace
      state={location.state}
    />
  );
}

/**
 * 旧分支路由重定向（阶段 H2）：H1 迁移后子节点 ID 与旧分支 ID 相同，直接映射；
 * 保留 ?sel= 查询参数，旧书签不失效。
 */
function BranchRedirect() {
  const { sessionId = "", branchId = "" } = useParams();
  const location = useLocation();
  return (
    <Navigate
      to={`/research/${encodeURIComponent(sessionId)}/node/${encodeURIComponent(branchId)}${location.search}`}
      replace
      state={location.state}
    />
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomeRoute />} />
        <Route path="research/new" element={<StartPage />} />
        <Route path="research/:sessionId" element={<SessionRedirect />} />
        <Route path="research/:sessionId/branch/:branchId" element={<BranchRedirect />} />
        <Route path="research/:sessionId/node/:nodeId" element={<ResearchNodePage />} />
        <Route path="research/:sessionId/reading/:contentSnapshotId" element={<ReadingPage />} />
        <Route path="run-records" element={<RunRecordsPage />} />
        <Route path="run-records/:runId" element={<RunRecordsPage />} />
        <Route path="settings/ai-model" element={<AiModelSettingsPage />} />
        <Route path="settings/fusion" element={<FusionSettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
