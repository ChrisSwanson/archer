import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AccessGrantStore } from "../../src/service/access-grants.ts";
import {
  AuthoringGrantError,
  AuthoringGrantStore,
  MAX_AUTHORING_GRANT_BYTES,
  parseAuthoringGrants,
} from "../../src/service/authoring-grants.ts";
import { cleanUp, tempDir } from "./support.ts";

afterEach(cleanUp);
const grantId = "a1234567-1234-4234-8234-123456789abc";
const root = "/tmp/authoring-project";
const entry = () => ({
  entitlementId: randomUUID(),
  grantId: randomUUID(),
  projectRoots: [root],
  issuedAt: "2026-10-18T00:00:00.000Z",
  revokedAt: null,
});
const valid = () => JSON.stringify({ version: 1, entitlements: [entry()] });

test("separate entitlements survive restart, use exact roots, and leave ordinary grant bytes untouched", () => {
  const state = tempDir();
  const access = new AccessGrantStore(state),
    base = access.issue("Browser");
  const baseBytes = readFileSync(join(state, "access-grants.json"));
  const store = new AuthoringGrantStore(state);
  expect(existsSync(join(state, "authoring-grants.json"))).toBe(false);
  const issued = store.issue(base.id, [root, "/tmp/another-project"]);
  expect(issued.entitlementId).toMatch(/^[a-f0-9-]{36}$/);
  const restarted = new AuthoringGrantStore(state);
  expect(restarted.allows(base.id, root)).toBe(true);
  expect(restarted.allows(base.id, `${root}/child`)).toBe(false);
  expect(restarted.allows(base.id, `${root}-other`)).toBe(false);
  expect(restarted.allows(base.id, `${root}/../authoring-project`)).toBe(false);
  expect(restarted.allows(grantId, root)).toBe(false);
  expect(readFileSync(join(state, "access-grants.json"))).toEqual(baseBytes);
  expect(statSync(join(state, "authoring-grants.json")).mode & 0o777).toBe(0o600);
  expect(() => store.issue(base.id, [root])).toThrow(AuthoringGrantError);
  // Entitlement checks intentionally do not stand in for base authentication.
  access.revoke(base.id);
  expect(restarted.allows(base.id, root)).toBe(true);
  expect(access.authenticateLink(base.token)).toBeNull();
});

test("allows rereads entitlement revocation from disk without a cached-authority fallback", () => {
  const state = tempDir(),
    store = new AuthoringGrantStore(state);
  store.issue(grantId, [root]);
  const path = join(state, "authoring-grants.json"),
    parsed = JSON.parse(readFileSync(path, "utf8"));
  parsed.entitlements[0].revokedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(parsed));
  expect(store.allows(grantId, root)).toBe(false);
});

test.each(["missing", "corrupt", "public", "symlink", "directory", "oversized", "invalid UTF-8"] as const)(
  "%s entitlement store fails closed without resetting existing authority",
  (kind) => {
    const state = tempDir(),
      store = new AuthoringGrantStore(state);
    store.issue(grantId, [root]);
    const path = join(state, "authoring-grants.json");
    if (kind === "missing") unlinkSync(path);
    if (kind === "corrupt") writeFileSync(path, "{broken");
    if (kind === "public") chmodSync(path, 0o644);
    if (kind === "symlink") {
      const backup = join(state, "backup.json");
      writeFileSync(backup, readFileSync(path), { mode: 0o600 });
      unlinkSync(path);
      symlinkSync(backup, path);
    }
    if (kind === "directory") {
      unlinkSync(path);
      mkdirSync(path);
    }
    if (kind === "oversized") writeFileSync(path, " ".repeat(MAX_AUTHORING_GRANT_BYTES + 1));
    if (kind === "invalid UTF-8") writeFileSync(path, Buffer.from([0xff]));
    expect(store.allows(grantId, root)).toBe(false);
    expect(() => store.issue(randomUUID(), [root])).toThrow(AuthoringGrantError);
    if (kind === "missing") expect(existsSync(path)).toBe(false);
    if (kind === "corrupt") expect(readFileSync(path, "utf8")).toBe("{broken");
  },
);

test("private parent and active ownership are required for reads and mutations", () => {
  const state = tempDir();
  let active = true;
  const store = new AuthoringGrantStore(state, () => {
    if (!active) throw new AuthoringGrantError("service_stopping", "stopped");
  });
  store.issue(grantId, [root]);
  const before = readFileSync(join(state, "authoring-grants.json"));
  active = false;
  expect(store.allows(grantId, root)).toBe(false);
  expect(() => store.issue(randomUUID(), [root])).toThrowError(expect.objectContaining({ code: "service_stopping" }));
  expect(readFileSync(join(state, "authoring-grants.json"))).toEqual(before);
  active = true;
  chmodSync(state, 0o755);
  expect(store.allows(grantId, root)).toBe(false);
  expect(() => store.issue(randomUUID(), [root])).toThrow(AuthoringGrantError);
  chmodSync(state, 0o700);
  const alias = join(tempDir(), "state");
  symlinkSync(state, alias, "dir");
  expect(() => new AuthoringGrantStore(alias)).toThrow(AuthoringGrantError);
});

test("strict parser and issuer enforce root, shape, byte and entitlement bounds", () => {
  const state = tempDir(),
    store = new AuthoringGrantStore(state);
  for (const roots of [
    [],
    ["relative"],
    ["/tmp/x/../y"],
    ["/tmp/x/"],
    ["/tmp/x", "/tmp/x"],
    ["/tmp/\0"],
    Array.from({ length: 17 }, (_, i) => `/tmp/${i}`),
  ])
    expect(() => store.issue(grantId, roots), JSON.stringify(roots)).toThrow(AuthoringGrantError);
  expect(() => store.issue("bad", [root])).toThrow(AuthoringGrantError);
  const full = { version: 1, entitlements: Array.from({ length: 1024 }, entry) };
  expect(parseAuthoringGrants(JSON.stringify(full)).entitlements).toHaveLength(1024);
  writeFileSync(join(state, "authoring-grants.json"), JSON.stringify(full), { mode: 0o600 });
  expect(() => store.issue(grantId, [root])).toThrowError(
    expect.objectContaining({ code: "authoring_grant_capacity" }),
  );
  for (const value of [
    { ...full, version: 2 },
    { ...full, unknown: true },
    { version: 1, entitlements: [entry(), { ...entry(), unknown: true }] },
    { version: 1, entitlements: Array.from({ length: 1025 }, entry) },
  ])
    expect(() => parseAuthoringGrants(JSON.stringify(value))).toThrow(AuthoringGrantError);
  const duplicated = entry();
  expect(() => parseAuthoringGrants(JSON.stringify({ version: 1, entitlements: [duplicated, duplicated] }))).toThrow(
    AuthoringGrantError,
  );
  const exact = valid();
  expect(parseAuthoringGrants(exact + " ".repeat(MAX_AUTHORING_GRANT_BYTES - Buffer.byteLength(exact))).version).toBe(
    1,
  );
  expect(() =>
    parseAuthoringGrants(exact + " ".repeat(MAX_AUTHORING_GRANT_BYTES - Buffer.byteLength(exact) + 1)),
  ).toThrow(AuthoringGrantError);
});

test("journal authority capture returns only a fresh exact-root entitlement", () => {
  const state = tempDir(),
    store = new AuthoringGrantStore(state);
  const issued = store.issue(grantId, [root]);
  expect(store.entitlement(grantId, root)).toEqual(issued);
  expect(store.entitlement(grantId, `${root}/child`)).toBeNull();
  expect(store.entitlement(randomUUID(), root)).toBeNull();
  const path = join(state, "authoring-grants.json");
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  parsed.entitlements[0].revokedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(parsed));
  expect(store.entitlement(grantId, root)).toBeNull();
  writeFileSync(path, "broken");
  expect(store.entitlement(grantId, root)).toBeNull();
});
