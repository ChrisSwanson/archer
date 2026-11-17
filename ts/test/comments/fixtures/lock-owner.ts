import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withCommentsLock, writerClaimDirectory } from "../../../src/comments/lock.ts";
import { findProject } from "../../../src/project/index.ts";
const root = process.argv[2]!;
// Holds the lock forever, or, given milliseconds, until another writer has
// published its ticket (so it has seen this owner) and that long after.
const afterContendedMs = process.argv[3] === undefined ? undefined : Number(process.argv[3]);
const cell = new Int32Array(new SharedArrayBuffer(4));
const writers = writerClaimDirectory(findProject(root), "flow.comments.json");
const contended = (mine: string) =>
  readdirSync(writers).some((name) => {
    if (!name.endsWith(".claim") || name === mine) return false;
    try {
      return readFileSync(join(writers, name), "utf8") !== "";
    } catch {
      return false;
    }
  });
withCommentsLock(findProject(root), "flow.comments.json", () => {
  const mine = readdirSync(writers).find((name) => name.startsWith(`${process.pid}.`))!;
  process.send?.({ holding: true });
  if (afterContendedMs === undefined) {
    Atomics.wait(cell, 0, 0);
    return;
  }
  while (!contended(mine)) Atomics.wait(cell, 0, 0, 2);
  Atomics.wait(cell, 0, 0, afterContendedMs);
});
process.disconnect?.();
