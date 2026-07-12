import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, BootstrapPayload, MultiRuntimeUsageSnapshot } from "./types";

export const api = {
  bootstrap: () => invoke<BootstrapPayload>("bootstrap"),
  refreshUsage: (force = true) =>
    invoke<MultiRuntimeUsageSnapshot>("refresh_usage", { force }),
  saveSettings: (patch: Partial<AppSettings>) =>
    invoke<AppSettings>("save_settings", { patch }),
  showTaskbarWidgetMenu: () => invoke<void>("show_taskbar_widget_menu"),
};
