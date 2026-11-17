// O45: a session's relay started on an older installed copy starts the service from the copy installed
// now (`current`), not from its own: that one may be an older build of the same version, which the
// version check reuses silently, or a folder a later upgrade removed.
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { serveEntryFor } from "../../src/service/client.ts";
import { cleanUp, tempDir } from "./support.ts";

afterEach(cleanUp);

function install(): { data: string; old: string; now: string } {
  const data = join(tempDir(), "archer");
  for (const id of ["0.7.1-old", "0.7.1-new"]) {
    mkdirSync(join(data, "versions", id, "dist"), { recursive: true });
    writeFileSync(join(data, "versions", id, "dist", "archer.js"), "");
  }
  symlinkSync(join("versions", "0.7.1-new"), join(data, "current"));
  return {
    data,
    old: join(data, "versions", "0.7.1-old", "dist", "archer.js"),
    now: join(data, "versions", "0.7.1-new", "dist", "archer.js"),
  };
}

test("an older installed copy starts the current copy's service, named by its version folder", () => {
  const { old, now } = install();
  expect(serveEntryFor(old)).toBe(realpathSync(now));
});

test("the current copy, a copy outside an install, or an install without current start themselves", () => {
  const { data, now } = install();
  expect(serveEntryFor(now)).toBe(now);
  const loose = join(tempDir(), "dist", "archer.js");
  expect(serveEntryFor(loose)).toBe(loose);
  const bare = join(tempDir(), "versions", "0.7.1-x", "dist", "archer.js");
  expect(serveEntryFor(bare)).toBe(bare);
  expect(data).toBeTruthy();
});
