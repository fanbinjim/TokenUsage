import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import type { AppSettings, MultiRuntimeUsageSnapshot, RateWindow, RuntimeScope } from "./types";
import { useUsageStore } from "./store";
import "./taskbar-widget.css";

export type TaskbarQuotaLevel = "danger" | "warning" | "info" | "healthy";

export interface TaskbarQuotaValues {
  fiveHour: number | null;
  sevenDay: number | null;
}

export function taskbarQuotaLevel(percent: number): TaskbarQuotaLevel {
  if (percent < 10) return "danger";
  if (percent < 30) return "warning";
  if (percent < 60) return "info";
  return "healthy";
}

function validRemainingPercent(window: RateWindow | null | undefined): number | null {
  const percent = window?.remainingPercent;
  return typeof percent === "number" && Number.isFinite(percent) ? percent : null;
}

export function taskbarQuotaValues(
  snapshot: MultiRuntimeUsageSnapshot | null,
  selectedScope: RuntimeScope | undefined,
): TaskbarQuotaValues {
  const runtime = snapshot?.runtimes.find((item) => item.scope === selectedScope) ?? snapshot?.runtimes[0];
  return {
    fiveHour: validRemainingPercent(runtime?.snapshot.primary),
    sevenDay: validRemainingPercent(runtime?.snapshot.secondary),
  };
}

function QuotaRow({ label, percent, tone }: {
  label: string;
  percent: number | null;
  tone: "primary" | "secondary";
}) {
  const normalizedPercent = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  const level = percent == null ? null : taskbarQuotaLevel(normalizedPercent);
  return (
    <div
      className={`taskbar-widget-row ${tone} ${level ? `quota-${level}` : "quota-unavailable"}`}
      aria-label={`${label} ${percent == null ? "unavailable" : `${Math.round(normalizedPercent)}% remaining`}`}
    >
      <span className="taskbar-widget-label">{label}</span>
      <span className="taskbar-widget-track">
        <span className="taskbar-widget-fill" style={{ transform: `scaleX(${normalizedPercent / 100})` }} />
      </span>
      <span className="taskbar-widget-value">{percent == null ? "--" : `${Math.round(normalizedPercent)}%`}</span>
    </div>
  );
}

export default function TaskbarWidget() {
  const { bootstrap, setSnapshot, setSettings, settings, snapshot } = useUsageStore();
  const quota = taskbarQuotaValues(snapshot, settings?.selectedRuntime);

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
    <div
      className="taskbar-widget"
      aria-label="TokenUsage live quota"
      onContextMenu={(event) => {
        event.preventDefault();
        void api.showTaskbarWidgetMenu();
      }}
    >
      <QuotaRow label="5h" percent={quota.fiveHour} tone="primary" />
      <QuotaRow label="7d" percent={quota.sevenDay} tone="secondary" />
    </div>
  );
}
