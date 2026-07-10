import { describe, expect, it } from "vitest";
import { formatTokens } from "./format";

describe("formatTokens", () => {
  it("keeps unavailable data distinct from zero", () => {
    expect(formatTokens(null)).toBe("--");
    expect(formatTokens(0)).toBe("0");
  });

  it("uses compact units for large local counts", () => {
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
});
