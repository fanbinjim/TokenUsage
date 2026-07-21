import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import type { AppSettings, MultiRuntimeUsageSnapshot, RateWindow, RuntimeScope } from "./types";
import { findSevenDayQuotaWindow, subscriptionPlanWindow } from "./quota";
import { useUsageStore } from "./store";
import "./taskbar-widget.css";

export type TaskbarQuotaLevel = "danger" | "warning" | "info" | "healthy";

export interface TaskbarQuotaValues {
  monthly: number;
  sevenDay: number | null;
  sevenDayWindow: RateWindow | null;
}

export type TaskbarResetLevel = "danger" | "warning" | "info" | "healthy";

export interface TaskbarResetCountdown {
  label: string;
  resetDateLabel: string;
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
  nowMs = Date.now(),
  subscriptionStartedOn?: string | null,
): TaskbarQuotaValues {
  const runtime = snapshot?.runtimes.find((item) => item.scope === selectedScope) ?? snapshot?.runtimes[0];
  const sevenDayWindow = findSevenDayQuotaWindow(runtime?.snapshot.primary, runtime?.snapshot.secondary);
  return {
    monthly: validRemainingPercent(subscriptionPlanWindow(subscriptionStartedOn, new Date(nowMs))) ?? 100,
    sevenDay: validRemainingPercent(sevenDayWindow),
    sevenDayWindow,
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
  const resetDate = new Date(resetMs);
  const resetDateLabel = `${resetDate.getMonth() + 1}.${resetDate.getDate()}`;
  const resetTime = `${String(resetDate.getHours()).padStart(2, "0")}:${String(resetDate.getMinutes()).padStart(2, "0")}`;

  return {
    label,
    resetDateLabel,
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
    ? `7d 额度将在 ${countdown.resetTime} 重置，剩余 ${countdown.label}`
    : "7d 重置时间不可用";

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
      <span className="taskbar-reset-label">{countdown?.resetDateLabel ?? "--"}</span>
    </div>
  );
}

export interface TaskbarWidgetPreview {
  monthly: number;
  sevenDay: number;
  resetsAt: string;
  windowDurationMins?: number;
}

export default function TaskbarWidget({ preview }: { preview?: TaskbarWidgetPreview }) {
  const { bootstrap, setSnapshot, setSettings, settings, snapshot } = useUsageStore();
  const liveQuota = taskbarQuotaValues(snapshot, settings?.selectedRuntime, Date.now(), settings?.subscriptionStartedOn);
  const quota: TaskbarQuotaValues = preview ? {
    monthly: preview.monthly,
    sevenDay: preview.sevenDay,
    sevenDayWindow: {
      usedPercent: 100 - preview.sevenDay,
      remainingPercent: preview.sevenDay,
      resetsAt: preview.resetsAt,
      windowDurationMins: preview.windowDurationMins ?? 10_080,
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
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div
      className="taskbar-widget"
      aria-label="TokenUsage live quota"
    >
      <div className="taskbar-widget-quotas">
        <QuotaRow label="7d" percent={quota.sevenDay} tone="secondary" />
        <QuotaRow label="本月" percent={quota.monthly} tone="primary" />
      </div>
      <ResetCountdown window={quota.sevenDayWindow} nowMs={nowMs} />
    </div>
  );
}
