import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "../components/AppShell/AppShell";
import { ReadingPage } from "../features/imports/ReadingPage";
import { HomeRoute } from "../features/research-session/HomeRoute";
import { NotFoundPage } from "../features/research-session/NotFoundPage";
import { ResearchBranchPage } from "../features/research-session/ResearchBranchPage";
import { ResearchSessionPage } from "../features/research-session/ResearchSessionPage";
import { StartPage } from "../features/research-session/StartPage";
import { ModelSettingsPage } from "../features/settings/ModelSettingsPage";
import { SettingsPage } from "../features/settings/SettingsPage";

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomeRoute />} />
        <Route path="research/new" element={<StartPage />} />
        <Route path="research/:sessionId" element={<ResearchSessionPage />} />
        <Route path="research/:sessionId/branch/:branchId" element={<ResearchBranchPage />} />
        <Route path="research/:sessionId/reading/:contentSnapshotId" element={<ReadingPage />} />
        <Route path="settings" element={<SettingsPage />}>
          <Route index element={<Navigate to="/settings/models" replace />} />
          <Route path="models" element={<ModelSettingsPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
