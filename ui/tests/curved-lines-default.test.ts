// @vitest-environment jsdom
// Curved lines are a viewer's opt-in: square lines stay the default (owner, 2026-11-15).
import { afterEach, describe, expect, it } from "vitest";
import { curvedLinesEnabled, setCurvedLinesEnabled } from "../src/app/curved-lines";

describe("curved lines setting", () => {
  afterEach(() => localStorage.clear());

  it("is off for a viewer who never chose", () => {
    localStorage.clear();
    expect(curvedLinesEnabled()).toBe(false);
  });

  it("is on only after the viewer turns it on, and off again after they turn it off", () => {
    setCurvedLinesEnabled(true);
    expect(curvedLinesEnabled()).toBe(true);
    setCurvedLinesEnabled(false);
    expect(curvedLinesEnabled()).toBe(false);
  });
});
