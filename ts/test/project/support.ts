// Temporary projects for the project and command-line tests. Every one lives
// under the system's temp directory, never in the repository's own tree.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ownClaimName, writerClaimDirectory } from "../../src/comments/lock.ts";
import type { Project } from "../../src/project/index.ts";

const made: string[] = [];

/** A fresh directory holding `files` (paths relative to it, `/`-separated). */
export function tempDir(files: Record<string, string> = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "archer-project-")));
  made.push(dir);
  for (const [path, text] of Object.entries(files)) write(dir, path, text);
  return dir;
}

export function write(dir: string, path: string, text: string): string {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  return full;
}

export function removeTempDirs(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export const FLOW = "flowchart LR\n  a[Client] e1@--> b[API]\n";
export const FLOW_OLD = "flowchart LR\n  a[A (x)]\n  b[B]\n  a e@-->|reads (c)| b\n";
export const SEQ = "sequenceDiagram\n  participant A as Alice\n  participant B as Bob\n  A->>B: hi\n";
export const BROKEN = "flowchart LR\n  a[A] --> b[B]\n";

/**
 * Holds a live writer claim on a project file, as a contending writer in this
 * process would (src/comments/lock.ts): writers of that file wait out their
 * bound and refuse until it is removed. Claims are private state, not repo files.
 */
export function blockWriters(project: Project, path: string): () => void {
  const directory = writerClaimDirectory(project, path);
  mkdirSync(directory, { recursive: true });
  const claim = join(directory, ownClaimName());
  writeFileSync(claim, "1");
  return () => rmSync(claim, { force: true });
}
