import { describe, expect, it } from "vitest";
import { createMockDashboardSnapshot, MOCK_SETTINGS } from "./mockDashboard";

describe("main dashboard mock mode data", () => {
  it("provides an available Codex runtime with every dashboard data set", () => {
    const snapshot = createMockDashboardSnapshot(new Date("2026-07-12T12:00:00.000Z"));
    const runtime = snapshot.runtimes[0];

    expect(runtime).toMatchObject({ scope: "codex", displayName: "Codex", status: "available" });
    expect(runtime.snapshot.primary?.remainingPercent).toBe(58);
    expect(runtime.snapshot.secondary?.remainingPercent).toBe(65);
    expect(runtime.snapshot.local?.recentThreads).toHaveLength(6);
    expect(runtime.snapshot.local?.dailyBuckets).toHaveLength(7);
    expect(runtime.snapshot.local?.usageTrend?.days).toHaveLength(28);
    expect(runtime.snapshot.local?.projects.length).toBeGreaterThan(0);
    expect(runtime.snapshot.local?.skillUsage.length).toBeGreaterThan(0);
  });

  it("starts from a real dashboard-compatible Codex selection", () => {
    expect(MOCK_SETTINGS).toMatchObject({ selectedRuntime: "codex", theme: "dark" });
    expect(MOCK_SETTINGS.visibleRuntimes).toEqual(["codex"]);
  });
});
