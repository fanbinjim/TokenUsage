import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TaskbarWidget, { taskbarQuotaLevel } from "./TaskbarWidget";

describe("taskbar quota preview", () => {
  it("renders the fixed 5h and 7d mock percentages", () => {
    const markup = renderToStaticMarkup(<TaskbarWidget />);
    expect(markup).toContain("65%");
    expect(markup).toContain("83%");
    expect(markup).toContain("scaleX(0.65)");
    expect(markup).toContain("scaleX(0.83)");
    expect(markup.match(/quota-healthy/g)).toHaveLength(2);
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
});
