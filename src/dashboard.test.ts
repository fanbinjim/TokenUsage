import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { dashboardQuotaPercent, safeThreadLabel, shortCwd, taskCardId, WOOL_MONTHLY_VALUE_CAP, woolProgressPercent } from "./App";

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

  it("uses full remaining quota when the main dashboard has no valid quota", () => {
    expect(dashboardQuotaPercent(null)).toBe(100);
    expect(dashboardQuotaPercent({ usedPercent: 0, remainingPercent: Number.NaN, windowDurationMins: 300, resetsAt: null })).toBe(100);
    expect(dashboardQuotaPercent({ usedPercent: 0, remainingPercent: -1, windowDurationMins: 300, resetsAt: null })).toBe(100);
    expect(dashboardQuotaPercent({ usedPercent: 0, remainingPercent: 101, windowDurationMins: 300, resetsAt: null })).toBe(100);
    expect(dashboardQuotaPercent({ usedPercent: 42, remainingPercent: 58.4, windowDurationMins: 300, resetsAt: null })).toBe(58);
  });
});
