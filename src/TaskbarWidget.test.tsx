import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TaskbarWidget, {
  taskbarQuotaLevel,
  taskbarQuotaValues,
  taskbarResetCountdown,
  taskbarResetLevel,
} from "./TaskbarWidget";
import type { MultiRuntimeUsageSnapshot, RateWindow } from "./types";

function runtimeSnapshot(primary: RateWindow | null, secondary: RateWindow | null): MultiRuntimeUsageSnapshot {
  return {
    schemaVersion: 1,
    refreshedAt: "2026-07-12T12:00:00Z",
    runtimes: [
      {
        scope: "codex",
        displayName: "Codex",
        status: "available",
        snapshot: {
          refreshedAt: "2026-07-12T12:00:00Z",
          account: null,
          limitId: null,
          limitName: null,
          primary,
          secondary,
          cloudLifetimeTokens: null,
          local: null,
          diagnostics: [],
        },
      },
    ],
  };
}

describe("taskbar quota", () => {
  it("renders the monthly cycle and marks an unavailable 7-day quota", () => {
    const markup = renderToStaticMarkup(<TaskbarWidget />);
    expect(markup).toContain("本月");
    expect(markup).toContain("7d");
    expect(markup).toContain("quota-unavailable");
  });

  it("uses the calendar month and finds a 7-day quota in either API slot", () => {
    const now = new Date(2026, 6, 16, 12).getTime();
    const fiveHour = { usedPercent: 35, windowDurationMins: 300, resetsAt: null, remainingPercent: 65 };
    const sevenDay = { usedPercent: 17, windowDurationMins: 10_080, resetsAt: null, remainingPercent: 83 };

    const withSecondaryWindow = taskbarQuotaValues(runtimeSnapshot(fiveHour, { ...sevenDay, resetsAt: new Date(now + 3.5 * 24 * 60 * 60_000).toISOString() }), "codex", now);
    expect(withSecondaryWindow).toMatchObject({
      monthly: 50,
      sevenDay: 83,
    });
    expect(withSecondaryWindow.sevenDayResetFraction).toBeCloseTo(0.5, 6);
    expect(taskbarQuotaValues(runtimeSnapshot(sevenDay, null), "codex", now)).toMatchObject({
      monthly: 50,
      sevenDay: 83,
      sevenDayWindow: sevenDay,
    });
  });

  it("keeps the 7-day quota unavailable when the API does not return it", () => {
    const now = new Date(2026, 6, 16, 12).getTime();
    const values = taskbarQuotaValues(runtimeSnapshot(null, null), "codex", now);
    expect(values).toMatchObject({ monthly: 50, sevenDay: null, sevenDayWindow: null, sevenDayResetFraction: null });
  });

  it("maps quota percentages to non-overlapping warning ranges", () => {
    expect(taskbarQuotaLevel(0)).toBe("danger");
    expect(taskbarQuotaLevel(9.99)).toBe("danger");
    expect(taskbarQuotaLevel(10)).toBe("warning");
    expect(taskbarQuotaLevel(29.99)).toBe("warning");
    expect(taskbarQuotaLevel(30)).toBe("info");
    expect(taskbarQuotaLevel(59.99)).toBe("info");
    expect(taskbarQuotaLevel(60)).toBe("healthy");
    expect(taskbarQuotaLevel(100)).toBe("healthy");
  });

  it("calculates the countdown from the 7-day server reset timestamp", () => {
    const now = Date.parse("2026-07-12T08:00:00Z");
    const countdown = taskbarResetCountdown({
      usedPercent: 35,
      remainingPercent: 65,
      windowDurationMins: 10_080,
      resetsAt: "2026-07-12T11:42:00Z",
    }, now);

    expect(countdown).toMatchObject({
      label: "3:42",
      level: "healthy",
      remainingMinutes: 222,
    });
    expect(countdown?.progress).toBeCloseTo(222 / 10_080, 5);
    expect(countdown?.resetTime).toMatch(/^\d{2}:\d{2}$/);
  });

  it("uses urgent colors as a quota reset approaches", () => {
    expect(taskbarResetLevel(181)).toBe("healthy");
    expect(taskbarResetLevel(180)).toBe("info");
    expect(taskbarResetLevel(90)).toBe("warning");
    expect(taskbarResetLevel(30)).toBe("danger");
    expect(taskbarResetLevel(0)).toBe("danger");
  });

  it("keeps missing or invalid reset timestamps unavailable", () => {
    expect(taskbarResetCountdown(null)).toBeNull();
    expect(taskbarResetCountdown({
      usedPercent: 35,
      remainingPercent: 65,
      windowDurationMins: 10_080,
      resetsAt: "not-a-date",
    })).toBeNull();
  });
});
