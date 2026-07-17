import { Route, Routes } from "react-router-dom";
import { AppShell } from "../components/AppShell/AppShell";
import { HomeRoute } from "../features/research-session/HomeRoute";
import { NotFoundPage } from "../features/research-session/NotFoundPage";
import { ResearchSessionPage } from "../features/research-session/ResearchSessionPage";
import { StartPage } from "../features/research-session/StartPage";

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomeRoute />} />
        <Route path="research/new" element={<StartPage />} />
        <Route path="research/:sessionId" element={<ResearchSessionPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
