import { create } from "zustand";
import { api } from "./api";
import type { AppSettings, MultiRuntimeUsageSnapshot } from "./types";

interface UsageState {
  settings: AppSettings | null;
  snapshot: MultiRuntimeUsageSnapshot | null;
  isLoading: boolean;
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
  isLoading: true,
  error: null,
  bootstrap: async () => {
    set({ isLoading: true, error: null });
    try {
      const payload = await api.bootstrap();
      set({ settings: payload.settings, snapshot: payload.snapshot, isLoading: false });
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },
  refresh: async () => {
    set({ isLoading: true, error: null });
    try {
      const snapshot = await api.refreshUsage();
      set({ snapshot, isLoading: false });
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },
  updateSettings: async (patch) => {
    const settings = await api.saveSettings(patch);
    set({ settings });
  },
  setSnapshot: (snapshot) => set({ snapshot, isLoading: false, error: null }),
  setSettings: (settings) => set({ settings }),
}));
