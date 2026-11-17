// A state file is written to a temporary name and renamed into place. When the write fails, removing
// the temporary file is cleanup: if that cleanup fails too, the write's own error is the one reported,
// not the cleanup's (a `throw` inside `finally` used to replace it).
import { afterEach, expect, test, vi } from "vitest";
import { chmodSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const faults = vi.hoisted(() => ({ write: false, unlink: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync(...args: Parameters<typeof actual.writeSync>) {
      if (faults.write) throw Object.assign(new Error("injected: no space left"), { code: "ENOSPC" });
      return (actual.writeSync as (...a: unknown[]) => number)(...args);
    },
    unlinkSync(path: Parameters<typeof actual.unlinkSync>[0]) {
      if (faults.unlink) throw Object.assign(new Error("injected: cannot remove"), { code: "EACCES" });
      actual.unlinkSync(path);
    },
  };
});
import { AccessGrantStore } from "../../src/service/access-grants.ts";
import { PairingAttemptFile } from "../../src/service/pairing-codes.ts";

const roots: string[] = [];
afterEach(() => {
  faults.write = false;
  faults.unlink = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function state(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archer-atomic-save-")));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

test("a failed pairing-attempt write reports the write's error, not the cleanup's", () => {
  const file = new PairingAttemptFile(state());
  faults.write = true;
  faults.unlink = true;
  expect(() => file.save({ recentWrong: [], wrongInWindow: 0, windowEndsAt: null })).toThrow(/no space left/);
});

test("a failed access-grant write reports the write's error, not the cleanup's", () => {
  const store = new AccessGrantStore(state());
  faults.write = true;
  faults.unlink = true;
  expect(() => store.issue("laptop")).toThrow(/no space left/);
});

test("a successful save still leaves no temporary file behind", () => {
  const dir = state();
  new PairingAttemptFile(dir).save({ recentWrong: [], wrongInWindow: 0, windowEndsAt: null });
  new AccessGrantStore(dir).issue("laptop");
  expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("a failed write removes its temporary file when it can", () => {
  const dir = state();
  faults.write = true;
  expect(() => new PairingAttemptFile(dir).save({ recentWrong: [], wrongInWindow: 0, windowEndsAt: null })).toThrow(
    /no space left/,
  );
  expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});
