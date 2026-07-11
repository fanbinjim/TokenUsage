import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { safeThreadLabel, shortCwd } from "./App";

describe("dashboard privacy and layout guards", () => {
  it("uses an opaque thread label and a project alias", () => {
    expect(safeThreadLabel({ id: "thread-secret-1234", title: "private prompt", tokens: 0, updatedAt: null, model: null, cwd: "C:\\Users\\name\\secret", archived: false })).toBe("会话 1234");
    expect(shortCwd("C:\\Users\\name\\secret-project")).toBe("secret-project");
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
});
