import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TaskbarWidget, {
  taskbarQuotaLevel,
  taskbarQuotaValues,
  taskbarFallbackResetWindow,
  taskbarResetCountdown,
  taskbarResetLevel,
} from "./TaskbarWidget";
import type { MultiRuntimeUsageSnapshot } from "./types";

describe("taskbar quota", () => {
  it("renders full quota fallbacks until a live snapshot is available", () => {
    const markup = renderToStaticMarkup(<TaskbarWidget />);
    expect(markup.match(/class="taskbar-widget-value">100%<\/span>/g)).toHaveLength(2);
    expect(markup.match(/scaleX\(1\)/g)).toHaveLength(2);
    expect(markup).not.toContain("quota-unavailable");
  });

  it("uses the selected runtime's live remaining quota", () => {
    const snapshot: MultiRuntimeUsageSnapshot = {
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
            primary: { usedPercent: 35, windowDurationMins: 300, resetsAt: null, remainingPercent: 65 },
            secondary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: null, remainingPercent: 83 },
            cloudLifetimeTokens: null,
            local: null,
            diagnostics: [],
          },
        },
        {
          scope: "claudeCode",
          displayName: "Claude Code",
          status: "available",
          snapshot: {
            refreshedAt: "2026-07-12T12:00:00Z",
            account: null,
            limitId: null,
            limitName: null,
            primary: { usedPercent: 58, windowDurationMins: 300, resetsAt: null, remainingPercent: 42 },
            secondary: { usedPercent: 82, windowDurationMins: 10080, resetsAt: null, remainingPercent: 18 },
            cloudLifetimeTokens: null,
            local: null,
            diagnostics: [],
          },
        },
      ],
    };

    expect(taskbarQuotaValues(snapshot, "claudeCode")).toMatchObject({ fiveHour: 42, sevenDay: 18 });
    expect(taskbarQuotaValues(snapshot, "codex")).toMatchObject({ fiveHour: 65, sevenDay: 83 });
  });

  it("uses full quota values when quota data is missing", () => {
    const snapshot: MultiRuntimeUsageSnapshot = {
      schemaVersion: 1,
      refreshedAt: "2026-07-12T12:00:00Z",
      runtimes: [{
        scope: "codex",
        displayName: "Codex",
        status: "localOnly",
        snapshot: {
          refreshedAt: "2026-07-12T12:00:00Z",
          account: null,
          limitId: null,
          limitName: null,
          primary: null,
          secondary: null,
          cloudLifetimeTokens: null,
          local: null,
          diagnostics: [],
        },
      }],
    };

    expect(taskbarQuotaValues(snapshot, "codex")).toEqual({ fiveHour: 100, sevenDay: 100, fiveHourWindow: null });
  });

  it("falls back to the next local noon or midnight reset", () => {
    const morning = new Date(2026, 6, 12, 8, 15, 0).getTime();
    const morningReset = taskbarFallbackResetWindow(morning);
    expect(morningReset.windowDurationMins).toBe(720);
    expect(morningReset.remainingPercent).toBe(100);
    expect(new Date(morningReset.resetsAt!)).toEqual(new Date(2026, 6, 12, 12, 0, 0));
    expect(taskbarResetCountdown(morningReset, morning)?.resetTime).toBe("12:00");

    const afternoon = new Date(2026, 6, 12, 17, 30, 0).getTime();
    const afternoonReset = taskbarFallbackResetWindow(afternoon);
    expect(new Date(afternoonReset.resetsAt!)).toEqual(new Date(2026, 6, 13, 0, 0, 0));
    expect(taskbarResetCountdown(afternoonReset, afternoon)?.resetTime).toBe("00:00");

    const noon = new Date(2026, 6, 12, 12, 0, 0).getTime();
    expect(new Date(taskbarFallbackResetWindow(noon).resetsAt!)).toEqual(new Date(2026, 6, 13, 0, 0, 0));
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

  it("calculates the countdown from the server reset timestamp", () => {
    const now = Date.parse("2026-07-12T08:00:00Z");
    const countdown = taskbarResetCountdown({
      usedPercent: 35,
      remainingPercent: 65,
      windowDurationMins: 300,
      resetsAt: "2026-07-12T11:42:00Z",
    }, now);

    expect(countdown).toMatchObject({
      label: "3:42",
      level: "healthy",
      remainingMinutes: 222,
    });
    expect(countdown?.progress).toBeCloseTo(222 / 300, 5);
    expect(countdown?.resetTime).toMatch(/^\d{2}:\d{2}$/);
  });

  it("uses urgent colors as the five-hour reset approaches", () => {
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
      windowDurationMins: 300,
      resetsAt: "not-a-date",
    })).toBeNull();
  });
});
