import { afterEach, expect, test } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessGrantError, AccessGrantStore, parseAccessGrants } from "../../src/service/access-grants.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "archer-grants-"));
  temporary.push(dir);
  return dir;
}

test("independent grants survive restart and revoking one preserves another", () => {
  const dir = directory();
  const store = new AccessGrantStore(dir);
  const first = store.issue("Windows browser");
  const second = store.issue("Interactive testing");
  expect(first.token).not.toBe(second.token);
  const restarted = new AccessGrantStore(dir);
  expect(restarted.authenticateLink(first.token)?.id).toBe(first.id);
  expect(restarted.revoke(first.id)).toBe(true);
  const afterRevocation = new AccessGrantStore(dir);
  expect(afterRevocation.authenticateLink(first.token)).toBeNull();
  expect(afterRevocation.authenticateLink(second.token)?.id).toBe(second.id);
  const persisted = readFileSync(join(dir, "access-grants.json"), "utf8");
  expect(persisted).not.toContain(first.token);
  expect(persisted).not.toContain(second.token);
  expect(JSON.stringify(afterRevocation.list())).not.toContain(second.token);
});

test("missing, corrupt and unsafe stores cannot revive previously issued access", () => {
  for (const kind of ["missing", "corrupt", "public", "symlink"] as const) {
    const dir = directory();
    const store = new AccessGrantStore(dir);
    const grant = store.issue("Browser");
    const path = join(dir, "access-grants.json");
    if (kind === "missing") unlinkSync(path);
    if (kind === "corrupt") writeFileSync(path, "{bad");
    if (kind === "public") chmodSync(path, 0o644);
    if (kind === "symlink") {
      const backup = join(dir, "backup.json");
      writeFileSync(backup, readFileSync(path), { mode: 0o600 });
      unlinkSync(path);
      symlinkSync(backup, path);
    }
    expect(store.authenticateLink(grant.token), kind).toBeNull();
    expect(() => store.issue("Another browser"), kind).toThrow();
    expect(() => store.revoke(grant.id), kind).toThrow();
  }
});

test("invalid grant labels and repeated revocation leave existing access unchanged", () => {
  const store = new AccessGrantStore(directory());
  const grant = store.issue("Browser");
  for (const label of ["", "x".repeat(129), "label\nother", "\0"])
    expect(() => store.issue(label)).toThrow(AccessGrantError);
  expect(store.authenticateLink(grant.token)?.id).toBe(grant.id);
  expect(store.authenticateLink("not a token")).toBeNull();
  expect(store.revoke("unknown")).toBe(false);
  expect(store.revoke(grant.id)).toBe(true);
  expect(store.revoke(grant.id)).toBe(false);
  expect(store.list()).toEqual([expect.objectContaining({ id: grant.id, revokedAt: expect.any(String) })]);
});

test("bounded grant parser refuses arbitrary input, vocabulary and small valid-store edits by name", () => {
  const store = new AccessGrantStore(directory());
  store.issue("Browser");
  const valid = readFileSync(join(store.stateDir, "access-grants.json"), "utf8");
  const vocabulary = ["version", "grants", "verifier", "issuedAt", "revokedAt", "label", "id", "null", "[]", "{}", "1"];
  let seed = 12345;
  const next = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let i = 0; i < 300; i++) {
    const point = next() % valid.length;
    for (const input of [
      String.fromCharCode(next() % 65536).repeat(next() % 100),
      vocabulary[next() % vocabulary.length] ?? "",
      valid.slice(0, point) + "[]" + valid.slice(point + 1),
    ]) {
      try {
        const parsed = parseAccessGrants(input);
        expect(parsed.version).toBe(1);
        expect(Array.isArray(parsed.grants)).toBe(true);
      } catch (failure) {
        expect(failure).toBeInstanceOf(AccessGrantError);
      }
    }
  }
  expect(() => parseAccessGrants("[".repeat(20000) + "0" + "]".repeat(20000))).toThrow(AccessGrantError);
  expect(() => parseAccessGrants(valid.replace('"version":1', '"version":2'))).toThrow(AccessGrantError);
  const duplicate = JSON.parse(valid) as { grants: unknown[] };
  duplicate.grants.push(duplicate.grants[0]);
  expect(() => parseAccessGrants(JSON.stringify(duplicate))).toThrow(AccessGrantError);
});

// Package review P4: a HOME reached through a link (macOS /tmp, a moved home) must not stop the service.
test("a state directory under a linked ancestor is used; one that is itself a link is refused by name", async () => {
  const { mkdirSync } = await import("node:fs");
  const real = directory(),
    linked = `${real}-link`;
  temporary.push(linked);
  symlinkSync(real, linked);
  mkdirSync(join(real, "state"), { mode: 0o700 });
  expect(new AccessGrantStore(join(linked, "state")).list()).toEqual([]);
  const { AuthoringGrantStore } = await import("../../src/service/authoring-grants.ts");
  expect(() => new AuthoringGrantStore(join(linked, "state"))).not.toThrow();
  symlinkSync(join(real, "state"), join(real, "alias"));
  expect(() => new AccessGrantStore(join(real, "alias"))).toThrow(/alias.*symbolic link/);
  chmodSync(join(real, "state"), 0o755);
  expect(() => new AccessGrantStore(join(real, "state"))).toThrow(/chmod 700/);
});
