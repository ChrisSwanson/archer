import { describe, expect, it } from "vitest";
import { displayLocation } from "../../src/config/project-settings.ts";

describe("the settings snapshot's project location", () => {
  it("is home-relative under the home directory", () => {
    expect(displayLocation("/home/me/code/archer", "/home/me")).toBe("~/code/archer");
    expect(displayLocation("/home/me", "/home/me")).toBe("~");
  });
  it("names only the folder elsewhere, never the absolute path", () => {
    expect(displayLocation("/srv/work/archer", "/home/me")).toBe("\u2026/archer");
    expect(displayLocation("/home/meow/archer", "/home/me")).toBe("\u2026/archer");
  });
});
