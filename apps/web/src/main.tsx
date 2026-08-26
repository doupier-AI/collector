import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app/App";
import { createDefaultServices, ServicesProvider } from "./app/services";
import { initializeThemePreference } from "./features/theme/theme";
import "@fontsource-variable/noto-sans-sc";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/utilities.css";
import "./features/navigation/dual-sidebar.css";

const services = createDefaultServices();
initializeThemePreference();
const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

createRoot(container).render(
  <StrictMode>
    <ServicesProvider services={services}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ServicesProvider>
  </StrictMode>,
);
