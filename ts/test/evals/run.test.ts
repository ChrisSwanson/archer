import { expect, test } from "vitest";
import { evalMain } from "../../scripts/evals/run.ts";
import { RIPGREP_MISSING } from "../../scripts/evals/retrieval.ts";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";

test("a correction run that reports a failed stage exits nonzero for automation", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("../../scripts/evals/run.ts", import.meta.url)),
      "correction",
      "--parent",
      join(tmpdir(), `archer-intentionally-absent-${randomUUID()}`),
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  expect(JSON.parse(result.stdout)).toMatchObject({
    status: "failed",
    stages: [{ name: "create-isolated-note", status: "failed" }],
  });
  expect(result.status).toBe(1);
});

test("local correction command verifies production outcomes without a service", async () => {
  expect(await evalMain(["correction"])).toMatchObject({ status: "passed", checks: { staleReplyRefused: true } });
});

test("local retrieval command measures two confined synthetic projects", async () => {
  const result = (await evalMain(["retrieval", "--size", "20"])) as { projects: { inventory: { notes: unknown[] } }[] };
  expect(result).toMatchObject({
    status: "passed",
    projects: [
      {
        fixtureValidity: {
          status: "passed",
          checks: expect.arrayContaining([
            expect.objectContaining({
              name: "expected_corpus",
              observed: expect.objectContaining({ expectedNoteCount: 20 }),
            }),
          ]),
        },
      },
      {
        fixtureValidity: {
          status: "passed",
          checks: expect.arrayContaining([
            expect.objectContaining({
              name: "expected_corpus",
              observed: expect.objectContaining({ expectedNoteCount: 20 }),
            }),
          ]),
        },
      },
    ],
  });
  expect(result.projects).toHaveLength(2);
  expect(result.projects.map((project) => project.inventory.notes.length)).toEqual([20, 20]);
  await expect(evalMain(["retrieval", "--size", "21"])).rejects.toThrow("--size must be 20 or 100");
});

test("a retrieval process with missing lexical evidence reports failed fixture validity and exits nonzero", () => {
  const commands = mkdtempSync(join(tmpdir(), "archer-retrieval-fault-"));
  try {
    // Fault injection: rg's documented no-match exit, withholding fixture evidence.
    writeFileSync(join(commands, "rg"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("../../scripts/evals/run.ts", import.meta.url)), "retrieval"],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, PATH: `${commands}:${process.env.PATH}` },
      },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "failed", fixtureValidity: { status: "failed" } });
    expect(result.status).toBe(1);
  } finally {
    rmSync(commands, { recursive: true, force: true });
  }
  // The child has a 30-second budget including cold TypeScript startup and forty
  // confined note admissions. A full-suite run completed in 5.279s, exceeding the
  // unrelated default 5s test deadline; allow child completion plus assertion/cleanup.
}, 35_000);

test("a retrieval process without ripgrep names the missing prerequisite instead of an opaque ENOENT", () => {
  const commands = mkdtempSync(join(tmpdir(), "archer-retrieval-no-rg-"));
  try {
    // A PATH holding no rg; the child is started by absolute path, so it needs nothing else from PATH.
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("../../scripts/evals/run.ts", import.meta.url)), "retrieval"],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, PATH: commands },
      },
    );
    expect(result.stderr).toContain(RIPGREP_MISSING);
    expect(result.stderr).not.toContain("ENOENT");
    expect(result.status).toBe(1);
  } finally {
    rmSync(commands, { recursive: true, force: true });
  }
}, 35_000);

test("the case-list command exposes names without evaluator expectations", async () => {
  const result = (await evalMain(["cases"])) as { cases: { id: string; title: string }[] };
  expect(result.cases).toHaveLength(8);
  expect(result.cases.map((entry) => entry.id)).toContain("c4-worker");
  expect(JSON.stringify(result)).not.toContain("evaluator");
  expect(JSON.stringify(result)).not.toContain("prohibitedInventions");
});

test("validation needs an explicit project and preparation needs a known track", async () => {
  await expect(evalMain(["validate"])).rejects.toThrow("--project is required");
  await expect(evalMain(["prepare", "--track", "unknown"])).rejects.toThrow("--track must be authoring or activation");
  await expect(evalMain(["other"])).rejects.toThrow("Unknown command");
});
