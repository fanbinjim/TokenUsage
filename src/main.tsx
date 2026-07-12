import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import TaskbarInputProxy from "./TaskbarInputProxy";
import TaskbarWidget from "./TaskbarWidget";
import "./styles.css";

const currentWindowLabel = (window as Window & {
  __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } };
}).__TAURI_INTERNALS__?.metadata?.currentWindow?.label;

document.documentElement.dataset.platform = /Windows/i.test(navigator.userAgent) ? "windows" : "other";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {currentWindowLabel === "taskbar-widget" ? <TaskbarWidget />
      : currentWindowLabel === "taskbar-input-proxy" ? <TaskbarInputProxy />
      : <App />}
  </StrictMode>,
);
