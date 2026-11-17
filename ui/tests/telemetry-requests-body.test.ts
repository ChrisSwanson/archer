import { describe, expect, it } from "vitest";
import { RequestTracker } from "../src/telemetry/requests";

describe("duplicate requests", () => {
  it("counts writes with different bodies as different requests, and identical ones as duplicates", () => {
    const reports: { code: string }[] = [];
    const tracker = new RequestTracker((event) => reports.push(event as { code: string }));
    for (const [i, body] of ["a", "b", "c"].entries())
      tracker.started("POST", "/p/api/authoring/edit", "edit", 100 + i, body);
    expect(reports.filter((r) => r.code === "ui.fetch-duplicate")).toHaveLength(0);
    for (const i of [0, 1, 2]) tracker.started("POST", "/p/api/authoring/edit", "edit", 200 + i, "same");
    expect(reports.filter((r) => r.code === "ui.fetch-duplicate")).toHaveLength(1);
  });
});
