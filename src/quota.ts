import type { RateWindow } from "./types";

export const SEVEN_DAY_WINDOW_MINUTES = 7 * 24 * 60;

const MINUTE = 60_000;

export function findSevenDayQuotaWindow(
  primary: RateWindow | null | undefined,
  secondary: RateWindow | null | undefined,
): RateWindow | null {
  return [primary, secondary].find(
    (window): window is RateWindow => window?.windowDurationMins === SEVEN_DAY_WINDOW_MINUTES,
  ) ?? null;
}

export function quotaResetRemainingFraction(
  window: RateWindow | null | undefined,
  nowMs = Date.now(),
): number | null {
  if (!window?.resetsAt || !window.windowDurationMins || window.windowDurationMins <= 0) return null;
  const resetsAtMs = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetsAtMs)) return null;
  const durationMs = window.windowDurationMins * MINUTE;
  return Math.max(0, Math.min(1, (resetsAtMs - nowMs) / durationMs));
}

/**
 * The Codex app-server exposes the plan type but not the subscription renewal
 * date. Use the current calendar month as the visible monthly plan cycle.
 */
export function currentMonthPlanWindow(now = new Date()): RateWindow {
  const startsAt = new Date(now.getFullYear(), now.getMonth(), 1);
  const resetsAt = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const totalMs = resetsAt.getTime() - startsAt.getTime();
  const remainingMs = Math.max(0, Math.min(totalMs, resetsAt.getTime() - now.getTime()));
  const remainingPercent = (remainingMs / totalMs) * 100;

  return {
    usedPercent: 100 - remainingPercent,
    remainingPercent,
    windowDurationMins: Math.round(totalMs / MINUTE),
    resetsAt: resetsAt.toISOString(),
  };
}
