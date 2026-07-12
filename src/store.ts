import { create } from "zustand";
import { api } from "./api";
import type { AppSettings, MultiRuntimeUsageSnapshot } from "./types";

interface UsageState {
  settings: AppSettings | null;
  snapshot: MultiRuntimeUsageSnapshot | null;
  isInitializing: boolean;
  isRefreshing: boolean;
  error: string | null;
  bootstrap: () => Promise<void>;
  refresh: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  setSnapshot: (snapshot: MultiRuntimeUsageSnapshot) => void;
  setSettings: (settings: AppSettings) => void;
}

export const useUsageStore = create<UsageState>((set) => ({
  settings: null,
  snapshot: null,
  isInitializing: true,
  isRefreshing: false,
  error: null,
  bootstrap: async () => {
    set({ isInitializing: true, error: null });
    try {
      const payload = await api.bootstrap();
      set({ settings: payload.settings, snapshot: payload.snapshot, isInitializing: false });
    } catch (error) {
      set({ error: String(error), isInitializing: false });
    }
  },
  refresh: async () => {
    set({ isRefreshing: true, error: null });
    try {
      const snapshot = await api.refreshUsage();
      set({ snapshot, isRefreshing: false });
    } catch (error) {
      set({ error: String(error), isRefreshing: false });
    }
  },
  updateSettings: async (patch) => {
    const settings = await api.saveSettings(patch);
    set({ settings });
  },
  setSnapshot: (snapshot) => set({ snapshot, isInitializing: false, isRefreshing: false, error: null }),
  setSettings: (settings) => set({ settings }),
}));
