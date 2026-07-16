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

function dateInMonth(year: number, month: number, day: number): Date {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, lastDay));
}

function parseLocalDate(value: string | null | undefined): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const parsed = new Date(year, month, day);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month || parsed.getDate() !== day) return null;
  return parsed;
}

/** Builds the current monthly billing cycle from a user-supplied subscription date. */
export function subscriptionPlanWindow(subscriptionStartedOn: string | null | undefined, now = new Date()): RateWindow {
  const anchor = parseLocalDate(subscriptionStartedOn);
  if (!anchor) return currentMonthPlanWindow(now);

  const renewalDay = anchor.getDate();
  let startsAt = dateInMonth(now.getFullYear(), now.getMonth(), renewalDay);
  if (startsAt.getTime() > now.getTime()) {
    startsAt = dateInMonth(now.getFullYear(), now.getMonth() - 1, renewalDay);
  }
  if (startsAt.getTime() < anchor.getTime()) startsAt = anchor;
  const resetsAt = dateInMonth(startsAt.getFullYear(), startsAt.getMonth() + 1, renewalDay);
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

/** Calendar-month fallback used until the user records a subscription date. */
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
