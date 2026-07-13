import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildHalfYearMonthlyChartOption, buildHalfYearMonthlyUsage, buildHeatmapCalendar, buildSevenDayChartOption, dashboardQuotaPercent, safeThreadLabel, shortCwd, taskCardId, WOOL_MONTHLY_VALUE_CAP, woolProgressPercent } from "./App";
import type { DailyTokenBucket } from "./types";

describe("dashboard display and layout guards", () => {
  it("uses the local thread title and a project alias", () => {
    expect(safeThreadLabel({ id: "thread-secret-1234", title: "private prompt", tokens: 0, updatedAt: null, model: null, cwd: "C:\\Users\\name\\secret", archived: false })).toBe("private prompt");
    expect(safeThreadLabel({ id: "thread-secret-1234", title: "", tokens: 0, updatedAt: null, model: null, cwd: "C:\\Users\\name\\secret", archived: false })).toBe("会话 1234");
    expect(shortCwd("C:\\Users\\name\\secret-project")).toBe("secret-project");
    expect(taskCardId("thread-secret-1234")).toBe("COD-1234");
  });

  it("does not render the diagnostics panel in the default dashboard", () => {
    const source = readFileSync(resolve(process.cwd(), "src", "App.tsx"), "utf8");
    expect(source).not.toContain("diagnostics-panel");
    expect(source).not.toContain("数据诊断");
  });
  it("does not duplicate token breakdown cards in the trends tab", () => {
    const source = readFileSync(resolve(process.cwd(), "src", "App.tsx"), "utf8");
    expect(source).not.toContain("Token 拆分（今日）");
    expect(source).not.toContain("Token 拆分（近 7 天）");
  });

  it("keeps the glass surfaces neutral in light and dark themes", () => {
    const styles = readFileSync(resolve(process.cwd(), "src", "styles.css"), "utf8");
    expect(styles).toContain("--surface-window-bg: rgba(24, 24, 27, 0.22)");
    expect(styles).toContain("--surface-window-bg: rgba(246, 247, 249, 0.20)");
    expect(styles).toContain('html[data-platform="windows"]');
    expect(styles).not.toContain("rgba(80, 50, 162");
  });

  it("maps wool milestones into the early progress range and caps the monthly value", () => {
    expect(WOOL_MONTHLY_VALUE_CAP).toBe(46_500);
    expect(woolProgressPercent(null)).toBe(0);
    expect(woolProgressPercent(20)).toBe(6);
    expect(woolProgressPercent(100)).toBe(16);
    expect(woolProgressPercent(200)).toBe(30);
    expect(woolProgressPercent(WOOL_MONTHLY_VALUE_CAP)).toBe(100);
    expect(woolProgressPercent(WOOL_MONTHLY_VALUE_CAP * 2)).toBe(100);
  });

  it("keeps the half-year heatmap geometry fixed when the window resizes", () => {
    const styles = readFileSync(resolve(process.cwd(), "src", "styles.css"), "utf8").replace(/\r\n/g, "\n");
    expect(styles).toContain("--heatmap-grid-width: 402px");
    expect(styles).toContain("--heatmap-content-width: 421px");
    expect(styles).toContain("--half-year-card-width: 447px");
    expect(styles).toContain("grid-template-columns: repeat(27, 12px)");
    expect(styles).toContain(".heatmap-cell.is-future-placeholder {\n  background: transparent;");
    expect(styles).not.toContain("justify-content: space-between;\n  min-width: 0;\n}\n\n.heatmap-months");
  });

  it("keeps the main desktop window at or above the dashboard design size", () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), "src-tauri", "tauri.conf.json"), "utf8"));
    const mainWindow = config.app.windows.find((window: { label: string }) => window.label === "main");
    expect(mainWindow).toMatchObject({ width: 1000, height: 760, minWidth: 1000, minHeight: 760 });
  });

  it("builds smooth token-type curves and a dashed cache hit rate", () => {
    const buckets: DailyTokenBucket[] = [
      { id: "1", label: "7/11", tokens: 180, inputTokens: 100, cachedInputTokens: 60, outputTokens: 70, reasoningOutputTokens: 10 },
      { id: "2", label: "7/12", tokens: 40, inputTokens: 0, cachedInputTokens: 0, outputTokens: 40, reasoningOutputTokens: 0 },
    ];
    const option = buildSevenDayChartOption(buckets, {
      text: "#fff",
      muted: "#aaa",
      grid: "#333",
      tooltipBackground: "#111",
      tooltipBorder: "#444",
    }) as { yAxis: { max?: number }[]; series: { name: string; smooth: number; data: (number | null)[]; lineStyle: { type?: string } }[] };
    const input = option.series.find((series) => series.name === "输入");
    const cacheRate = option.series.find((series) => series.name === "缓存命中率");

    expect(option.series.map((series) => series.name)).toEqual(["输入", "输出", "缓存读取", "推理输出", "缓存命中率"]);
    expect(input?.data).toEqual([40, 0]);
    expect(option.series.every((series) => series.smooth > 0)).toBe(true);
    expect(cacheRate?.data[0]).toBe(60);
    expect(cacheRate?.data[1]).toBeNull();
    expect(cacheRate?.lineStyle.type).toBe("dashed");
    expect(option.yAxis[1].max).toBe(100);
  });

  it("aggregates half-year days into one total-usage monthly curve", () => {
    const days: DailyTokenBucket[] = [
      { id: "2026-01-30", label: "1/30", tokens: 120, inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningOutputTokens: null },
      { id: "2026-01-31", label: "1/31", tokens: 80, inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningOutputTokens: null },
      { id: "2026-02-01", label: "2/1", tokens: 240, inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningOutputTokens: null },
    ];
    const monthly = buildHalfYearMonthlyUsage(days);
    const option = buildHalfYearMonthlyChartOption(monthly, {
      text: "#fff",
      muted: "#aaa",
      grid: "#333",
      tooltipBackground: "#111",
      tooltipBorder: "#444",
    }) as { series: { name: string; smooth: number; data: number[] }[] };

    expect(monthly).toEqual([
      { id: "2026-01", label: "1月", tokens: 200 },
      { id: "2026-02", label: "2月", tokens: 240 },
    ]);
    expect(option.series).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "总用量", smooth: 0.35, data: [200, 240] }),
    ]));
    expect(option.series).toHaveLength(1);
  });

  it("renders a fixed Monday-first 27-week calendar and labels months", () => {
    const bucket = (id: string): DailyTokenBucket => ({
      id,
      label: id.slice(5).replace("-", "/"),
      tokens: 1,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
    });
    const today = new Date(2026, 6, 13, 12);
    const monday = bucket("2026-07-13");
    const weeks = buildHeatmapCalendar([monday], today);

    expect(weeks).toHaveLength(27);
    expect(weeks[0].monthLabel).toBe("1月");
    expect(weeks[0].days).toHaveLength(7);
    expect(weeks[0].futurePlaceholderCount).toBe(0);
    expect(weeks.map((week) => week.monthLabel).filter(Boolean)).toEqual(["1月", "2月", "3月", "4月", "5月", "6月", "7月"]);
    expect(weeks[26].days).toEqual([monday, null, null, null, null, null, null]);
    expect(weeks[26].futurePlaceholderCount).toBe(6);
  });

  it("uses full remaining quota when the main dashboard has no valid quota", () => {
    expect(dashboardQuotaPercent(null)).toBe(100);
    expect(dashboardQuotaPercent({ usedPercent: 0, remainingPercent: Number.NaN, windowDurationMins: 300, resetsAt: null })).toBe(100);
    expect(dashboardQuotaPercent({ usedPercent: 0, remainingPercent: -1, windowDurationMins: 300, resetsAt: null })).toBe(100);
    expect(dashboardQuotaPercent({ usedPercent: 0, remainingPercent: 101, windowDurationMins: 300, resetsAt: null })).toBe(100);
    expect(dashboardQuotaPercent({ usedPercent: 42, remainingPercent: 58.4, windowDurationMins: 300, resetsAt: null })).toBe(58);
  });
});
