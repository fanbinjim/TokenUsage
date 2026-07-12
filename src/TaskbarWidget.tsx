import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import type { AppSettings, MultiRuntimeUsageSnapshot, RateWindow, RuntimeScope } from "./types";
import { useUsageStore } from "./store";
import "./taskbar-widget.css";

export type TaskbarQuotaLevel = "danger" | "warning" | "info" | "healthy";

export interface TaskbarQuotaValues {
  fiveHour: number | null;
  sevenDay: number | null;
  fiveHourWindow: RateWindow | null;
}

export type TaskbarResetLevel = "danger" | "warning" | "info" | "healthy";

export interface TaskbarResetCountdown {
  label: string;
  level: TaskbarResetLevel;
  progress: number;
  remainingMinutes: number;
  resetTime: string;
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
    fiveHourWindow: runtime?.snapshot.primary ?? null,
  };
}

export function taskbarResetLevel(remainingMinutes: number): TaskbarResetLevel {
  if (remainingMinutes <= 30) return "danger";
  if (remainingMinutes <= 90) return "warning";
  if (remainingMinutes <= 180) return "info";
  return "healthy";
}

export function taskbarResetCountdown(
  window: RateWindow | null | undefined,
  nowMs = Date.now(),
): TaskbarResetCountdown | null {
  if (!window?.resetsAt) return null;
  const resetMs = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetMs)) return null;

  const remainingMs = Math.max(0, resetMs - nowMs);
  const remainingMinutes = Math.ceil(remainingMs / 60_000);
  const durationMinutes = window.windowDurationMins && window.windowDurationMins > 0
    ? window.windowDurationMins
    : 300;
  const progress = Math.max(0, Math.min(1, remainingMs / (durationMinutes * 60_000)));
  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  const label = hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}` : `${remainingMinutes}m`;
  const resetTime = new Date(resetMs).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return {
    label,
    level: taskbarResetLevel(remainingMinutes),
    progress,
    remainingMinutes,
    resetTime,
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

function ResetCountdown({ window, nowMs }: { window: RateWindow | null; nowMs: number }) {
  const countdown = taskbarResetCountdown(window, nowMs);
  const progress = countdown ? countdown.progress * 100 : 0;
  const tooltip = countdown
    ? `5h 额度将在 ${countdown.resetTime} 重置，剩余 ${countdown.label}`
    : "5h 重置时间不可用";

  return (
    <div
      className={`taskbar-reset-countdown reset-${countdown?.level ?? "unavailable"}`}
      title={tooltip}
      aria-label={tooltip}
    >
      <svg className="taskbar-reset-ring" viewBox="0 0 28 28" aria-hidden="true">
        <circle className="taskbar-reset-ring-track" cx="14" cy="14" r="11.5" />
        <circle
          className="taskbar-reset-ring-progress"
          cx="14"
          cy="14"
          r="11.5"
          pathLength="100"
          strokeDasharray={`${progress} 100`}
        />
      </svg>
      <span className="taskbar-reset-label">{countdown?.label ?? "--"}</span>
    </div>
  );
}

export interface TaskbarWidgetPreview {
  fiveHour: number;
  sevenDay: number;
  resetsAt: string;
  windowDurationMins?: number;
}

export default function TaskbarWidget({ preview }: { preview?: TaskbarWidgetPreview }) {
  const { bootstrap, setSnapshot, setSettings, settings, snapshot } = useUsageStore();
  const liveQuota = taskbarQuotaValues(snapshot, settings?.selectedRuntime);
  const quota: TaskbarQuotaValues = preview ? {
    fiveHour: preview.fiveHour,
    sevenDay: preview.sevenDay,
    fiveHourWindow: {
      usedPercent: 100 - preview.fiveHour,
      remainingPercent: preview.fiveHour,
      resetsAt: preview.resetsAt,
      windowDurationMins: preview.windowDurationMins ?? 300,
    },
  } : liveQuota;
  const [nowMs, setNowMs] = useState(Date.now);

  useEffect(() => {
    if (!preview) void bootstrap();
  }, [bootstrap, preview]);
  useEffect(() => {
    if (preview) return undefined;
    const unsubscribeSnapshot = listen<MultiRuntimeUsageSnapshot>("tokenusage://snapshot", ({ payload }) => setSnapshot(payload));
    const unsubscribeSettings = listen<AppSettings>("tokenusage://settings-updated", ({ payload }) => setSettings(payload));
    return () => {
      void unsubscribeSnapshot.then((unsubscribe) => unsubscribe());
      void unsubscribeSettings.then((unsubscribe) => unsubscribe());
    };
  }, [preview, setSettings, setSnapshot]);
  useEffect(() => {
    setNowMs(Date.now());
    if (!quota.fiveHourWindow?.resetsAt) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [quota.fiveHourWindow?.resetsAt]);

  return (
    <div
      className="taskbar-widget"
      aria-label="TokenUsage live quota"
      onContextMenu={(event) => {
        event.preventDefault();
        void api.showTaskbarWidgetMenu();
      }}
    >
      <div className="taskbar-widget-quotas">
        <QuotaRow label="5h" percent={quota.fiveHour} tone="primary" />
        <QuotaRow label="7d" percent={quota.sevenDay} tone="secondary" />
      </div>
      <ResetCountdown window={quota.fiveHourWindow} nowMs={nowMs} />
    </div>
  );
}
