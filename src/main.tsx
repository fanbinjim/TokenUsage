import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import TaskbarWidget from "./TaskbarWidget";
import "./styles.css";

const currentWindowLabel = (window as Window & {
  __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } };
}).__TAURI_INTERNALS__?.metadata?.currentWindow?.label;

createRoot(document.getElementById("root")!).render(
  <StrictMode>{currentWindowLabel === "taskbar-widget" ? <TaskbarWidget /> : <App />}</StrictMode>,
);
