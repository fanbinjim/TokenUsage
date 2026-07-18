import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import TaskbarWidget from "./TaskbarWidget";
import "./styles.css";

const currentWindowLabel = (window as Window & {
  __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } };
}).__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
const previewParams = new URLSearchParams(window.location.search);
const isDevelopment = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;
const isTaskbarPreview = isDevelopment && previewParams.has("taskbar-preview");
const isMainMockPreview = isDevelopment && previewParams.get("mock") === "main";
const previewResetMinutes = Math.max(0, Number(previewParams.get("reset-minutes")) || 222);
const taskbarPreview = isTaskbarPreview ? {
  monthly: Math.max(0, Math.min(100, Number(previewParams.get("monthly")) || 65)),
  sevenDay: Math.max(0, Math.min(100, Number(previewParams.get("seven-day")) || 83)),
  resetsAt: new Date(Date.now() + previewResetMinutes * 60_000).toISOString(),
  windowDurationMins: 10_080,
} : undefined;

document.documentElement.dataset.platform = /Windows/i.test(navigator.userAgent) ? "windows" : "other";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {currentWindowLabel === "taskbar-widget" || isTaskbarPreview ? <TaskbarWidget preview={taskbarPreview} />
      : currentWindowLabel === "taskbar-input-proxy" ? null
      : <App mockMode={isMainMockPreview} />}
  </StrictMode>,
);
