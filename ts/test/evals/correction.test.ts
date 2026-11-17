import { expect, test } from "vitest";
import { runCorrectionEval } from "../../scripts/evals/correction.ts";

test("runs the production correction loop and reports preserved content and refused stale operations", async () => {
  const result = await runCorrectionEval();
  expect(result.status).toBe("passed");
  expect(result.checks).toMatchObject({
    staleReplyRefused: true,
    staleWriteRefused: true,
    unrelatedContentPreserved: true,
    stableIdsPreserved: true,
    anchorPreserved: true,
    currentModelCorrect: true,
    freshReplyAccepted: true,
  });
  expect(result.stages.length).toBeGreaterThan(8);
});

test("records measured bounded stages and cleans only its own child directory", async () => {
  const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const parent = mkdtempSync(join(tmpdir(), "archer-correction-parent-"));
  try {
    writeFileSync(join(parent, "keep.txt"), "caller-owned");
    const result = await runCorrectionEval({ parentDirectory: parent });
    expect(result.status).toBe("passed");
    expect(result.kind).toBe("deterministic-api-contract");
    expect(result.stages).toHaveLength(13);
    expect(
      result.stages.every((s) => s.status === "passed" && Number.isFinite(s.durationMs) && s.durationMs >= 0),
    ).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(result.stages.reduce((sum, s) => sum + s.durationMs, 0));
    expect(result.revisions.feedbackFresh).toBe(2);
    expect(result.revisions.reply).toBe(result.revisions.feedbackFresh);
    expect(result.revisions.correctedSource).not.toBe(result.revisions.initialSource);
    expect(result.revisions.correctedModel).not.toBe(result.revisions.initialModel);
    expect(result.artifactDirectory).toBeUndefined();
    expect(readFileSync(join(parent, "keep.txt"), "utf8")).toBe("caller-owned");
    expect(readdirSync(parent)).toEqual(["keep.txt"]);
  } finally {
    rmSync(parent, { recursive: true });
  }
});

test("preserves inspectable artifacts only when explicitly requested", async () => {
  const { existsSync, readFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const result = await runCorrectionEval({ retainArtifacts: true });
  try {
    expect(result.status).toBe("passed");
    expect(result.artifactDirectory).toBeDefined();
    expect(existsSync(result.artifactDirectory!)).toBe(true);
    expect(readFileSync(join(result.artifactDirectory!, ".archer/notes/review.md"), "utf8")).toContain(
      "consumer transfer@-->|returns result| producer",
    );
    expect(result.stages.some((s) => s.name === "cleanup-owned-fixture")).toBe(false);
  } finally {
    if (result.artifactDirectory) rmSync(result.artifactDirectory, { recursive: true });
  }
});

test("reports the named setup failure without making or deleting a caller path", async () => {
  const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const parent = mkdtempSync(join(tmpdir(), "archer-correction-missing-"));
  const missing = join(parent, "missing");
  try {
    const result = await runCorrectionEval({ parentDirectory: missing });
    expect(result.status).toBe("failed");
    expect(result.stages).toMatchObject([
      { name: "create-isolated-note", status: "failed", error: expect.stringContaining("ENOENT") },
    ]);
    expect(result.checks).toEqual({});
    expect(result.artifactDirectory).toBeUndefined();
    expect(existsSync(parent)).toBe(true);
    expect(existsSync(missing)).toBe(false);
  } finally {
    rmSync(parent, { recursive: true });
  }
});
