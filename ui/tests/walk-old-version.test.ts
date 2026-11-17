// The old version as the page asks for it (ADR 0034 §3, slice 7b), against the real service over a
// temporary project with Git history (7a's route), and against hand-made refusals.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseOldVersion, readOldVersion } from "../src/walkthroughs/use-old-version";
import { startTsProject, type TsProject } from "./support/ts-service";
import { walkthroughFiles } from "./support/walkthrough-project";
import { commitHistory } from "./support/walkthrough-history";

let withHistory: TsProject;
let without: TsProject;
const via = (server: TsProject) => (url: string, init?: RequestInit) =>
  server.fetch(url, { redirect: "follow", ...init });
beforeAll(async () => {
  withHistory = await startTsProject({ files: walkthroughFiles(), beforeService: commitHistory });
  without = await startTsProject({ files: walkthroughFiles() });
}, 90_000);
afterAll(async () => {
  await withHistory?.stop();
  await without?.stop();
});

describe("readOldVersion", () => {
  it("finds the diagram the archived walkthrough was written for, and projects it", async () => {
    const answer = await readOldVersion("containers", "pay-with-card-form", via(withHistory));
    expect(answer.status).toBe("found");
    if (answer.status !== "found") return;
    expect(answer.committedAt).toMatch(/^2026-08-12/);
    expect(answer.view.nodes.map((n) => n.id)).toContain("gateway");
    expect(answer.view.nodes.map((n) => n.id)).not.toContain("payments");
  });

  it("says not-in-history when the project has no Git history", async () => {
    expect(await readOldVersion("containers", "pay-with-card-form", via(without))).toEqual({
      status: "not-in-history",
      id: "pay-with-card-form",
    });
  });

  it("is failed for a walkthrough the service does not have", async () => {
    expect(await readOldVersion("containers", "nope", via(withHistory))).toEqual({ status: "failed", id: "nope" });
  });
});

describe("parseOldVersion", () => {
  const base = { schemaVersion: 1, viewId: "v", id: "w" };
  it("keeps the service's refusal and its not-in-history as what they are", () => {
    expect(parseOldVersion("w", { ...base, status: "refused", diagnostics: [] })).toEqual({
      status: "refused",
      id: "w",
    });
    expect(parseOldVersion("w", { ...base, status: "not-in-history", reason: "not_found" })).toEqual({
      status: "not-in-history",
      id: "w",
    });
  });
  it("refuses a found model that is not a graph this page can draw, and fails on what it cannot read", () => {
    expect(
      parseOldVersion("w", {
        ...base,
        status: "found",
        commit: "a".repeat(40),
        committedAt: "2026-08-12T10:00:00Z",
        envelope: { nonsense: true },
      }),
    ).toEqual({ status: "refused", id: "w" });
    expect(parseOldVersion("w", { ...base, id: "other", status: "refused" })).toEqual({ status: "failed", id: "w" });
    expect(parseOldVersion("w", null)).toEqual({ status: "failed", id: "w" });
  });
});
