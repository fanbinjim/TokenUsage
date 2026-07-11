import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { AppSettings, MultiRuntimeUsageSnapshot } from "./types";
import { useUsageStore } from "./store";
import "./taskbar-widget.css";

export const TASKBAR_QUOTA_PREVIEW = {
  fiveHour: 65,
  sevenDay: 83,
} as const;

export type TaskbarQuotaLevel = "danger" | "warning" | "info" | "healthy";

export function taskbarQuotaLevel(percent: number): TaskbarQuotaLevel {
  if (percent < 10) return "danger";
  if (percent < 30) return "warning";
  if (percent < 60) return "info";
  return "healthy";
}

function QuotaRow({ label, percent, tone }: {
  label: string;
  percent: number;
  tone: "primary" | "secondary";
}) {
  const normalizedPercent = Math.max(0, Math.min(100, percent));
  const level = taskbarQuotaLevel(normalizedPercent);
  return (
    <div className={`taskbar-widget-row ${tone} quota-${level}`}>
      <span className="taskbar-widget-label">{label}</span>
      <span className="taskbar-widget-track">
        <span className="taskbar-widget-fill" style={{ transform: `scaleX(${normalizedPercent / 100})` }} />
      </span>
      <span className="taskbar-widget-value">{Math.round(normalizedPercent)}%</span>
    </div>
  );
}

export default function TaskbarWidget() {
  const { bootstrap, setSnapshot, setSettings } = useUsageStore();

  useEffect(() => { void bootstrap(); }, [bootstrap]);
  useEffect(() => {
    const unsubscribeSnapshot = listen<MultiRuntimeUsageSnapshot>("tokenusage://snapshot", ({ payload }) => setSnapshot(payload));
    const unsubscribeSettings = listen<AppSettings>("tokenusage://settings-updated", ({ payload }) => setSettings(payload));
    return () => {
      void unsubscribeSnapshot.then((unsubscribe) => unsubscribe());
      void unsubscribeSettings.then((unsubscribe) => unsubscribe());
    };
  }, [setSettings, setSnapshot]);

  return (
    <div className="taskbar-widget" aria-label="TokenUsage quota">
      <QuotaRow label="5h" percent={TASKBAR_QUOTA_PREVIEW.fiveHour} tone="primary" />
      <QuotaRow label="7d" percent={TASKBAR_QUOTA_PREVIEW.sevenDay} tone="secondary" />
    </div>
  );
}
