import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** Where this run's example snapshot is written, once, by the first test that needs it. */
    playgroundSnapshotPath: string;
  }
}

/** One scratch directory per run; nothing is generated here, so runs without playground tests pay nothing. */
export default function setup(project: TestProject): () => void {
  const directory = mkdtempSync(join(tmpdir(), "archer-ui-run-"));
  project.provide("playgroundSnapshotPath", join(directory, "playground-snapshot.json"));
  return () => rmSync(directory, { recursive: true, force: true });
}
