// "written for …" says which version of the diagram a walkthrough was written for in one form wherever it is shown
// (rendered review polish, 2026-11-13): "written for this version" sat beside "written for 13 Nov", which read as two
// different kinds of thing. Each now names a version: this one, the one of a day, or an earlier one.
import { describe, expect, it } from "vitest";
import type { Walk } from "../src/walkthroughs/contract";
import { writtenFor } from "../src/walkthroughs/WalkList";
import { dayLabel } from "../src/walkthroughs/walk-stale";

const walk = (over: Partial<Walk> = {}): Walk =>
  ({ id: "w", title: "W", modelRevision: "sha256:then", writtenAt: "2026-08-12T10:00:00Z", ...over }) as Walk;

describe("writtenFor", () => {
  it("names this version when the diagram has not moved on", () => {
    expect(writtenFor(walk(), "sha256:then")).toBe("written for this version");
  });

  it("names the version of the day it was written, in the same form, when the diagram has moved on", () => {
    expect(writtenFor(walk(), "sha256:now")).toBe(`written for the ${dayLabel("2026-08-12T10:00:00Z")} version`);
  });

  it("names an earlier version when it has no day", () => {
    expect(writtenFor(walk({ writtenAt: undefined }), "sha256:now")).toBe("written for an earlier version");
  });

  it("an archived one is written for an earlier version whatever revision is shown", () => {
    expect(writtenFor(walk({ status: "archived" } as Partial<Walk>), undefined)).toBe(
      `written for the ${dayLabel("2026-08-12T10:00:00Z")} version`,
    );
  });
});
