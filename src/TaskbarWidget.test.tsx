import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TaskbarWidget, {
  taskbarQuotaLevel,
  taskbarQuotaValues,
  taskbarResetCountdown,
  taskbarResetLevel,
} from "./TaskbarWidget";
import type { MultiRuntimeUsageSnapshot } from "./types";

describe("taskbar quota", () => {
  it("renders unavailable placeholders until a live snapshot is available", () => {
    const markup = renderToStaticMarkup(<TaskbarWidget />);
    expect(markup).toContain("--");
    expect(markup).toContain("scaleX(0)");
    expect(markup.match(/quota-unavailable/g)).toHaveLength(2);
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

  it("does not turn missing quota into a fake zero", () => {
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

    expect(taskbarQuotaValues(snapshot, "codex")).toEqual({ fiveHour: null, sevenDay: null, fiveHourWindow: null });
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
