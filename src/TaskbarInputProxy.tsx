import { api } from "./api";
import "./taskbar-input-proxy.css";

export default function TaskbarInputProxy() {
  return (
    <div
      className="taskbar-input-proxy"
      aria-label="TokenUsage taskbar menu"
      onContextMenu={(event) => {
        event.preventDefault();
        void api.showTaskbarWidgetMenu();
      }}
    />
  );
}
