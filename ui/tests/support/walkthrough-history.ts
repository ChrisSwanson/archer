/**
 * The walkthroughs fixture project with Git history, so a walkthrough's old version can be found
 * (ADR 0034 §3): the August and 2 October diagrams are committed, then today's, which is the one the
 * service serves. `pay-with-card-form` was written for August's, `order-shipped` for 2 October's.
 * An isolated temporary project; never the live service.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { walkthroughFiles } from "./walkthrough-project";

const FIXTURES = resolve(import.meta.dirname, "../../../ts/test/fixtures/walkthroughs");
const fixture = (name: string): string => readFileSync(resolve(FIXTURES, name), "utf8");

/** Commits history under `root`; `.archer/containers.mmd` is left as today's. As a `beforeService` seed. */
export async function commitHistory(_state: string, root: string): Promise<void> {
  commitHistoryAt(root);
}

/** Commits history under `root`; `.archer/containers.mmd` is left as today's. */
export function commitHistoryAt(root: string): void {
  const git = (...args: string[]): void => {
    execFileSync(
      "git",
      ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { stdio: "ignore" },
    );
  };
  git("init", "-q");
  const source = join(root, ".archer/containers.mmd");
  for (const [name, date] of [
    ["containers-aug.mmd", "2026-08-12T10:00:00Z"],
    ["containers-oct2.mmd", "2026-10-02T10:00:00Z"],
    ["containers.mmd", "2026-10-18T10:00:00Z"],
  ] as const) {
    writeFileSync(source, fixture(name));
    git("add", "archer.toml", ".archer/containers.mmd");
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        name,
      ],
      { stdio: "ignore", env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } },
    );
  }
}

export const historyFiles = walkthroughFiles;
