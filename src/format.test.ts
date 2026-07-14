import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDaysHours } from "./format";

describe("formatDaysHours", () => {
  afterEach(() => vi.useRealTimers());

  it("formats a remaining monthly duration as days and hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T06:00:00.000Z"));

    expect(formatDaysHours("2026-08-01T00:00:00.000Z")).toBe("17d 18h");
    expect(formatDaysHours(null)).toBe("--");
  });
});
