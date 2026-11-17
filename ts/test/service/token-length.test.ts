// Browser credentials are issued as 32 hex digits (128 bits): small agents retyped the 64-digit
// form wrongly and gave the person dead links (ADR 0014, amended 2026-10-22). Credentials issued
// before stay valid: a 64-digit service token or grant secret is still admitted everywhere.
import { afterEach, expect, test } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessGrantStore } from "../../src/service/access-grants.ts";
import { browserAccess, type BrowserAuthority } from "../../src/service/browser-access.ts";
import { routePattern } from "../../src/service/debug-http.ts";
import { readIdentity, writeIdentity } from "../../src/service/paths.ts";
import { isToken, newToken } from "../../src/service/token.ts";
import { redactText } from "../../src/telemetry/redact.ts";
import { redactText as redactPageText } from "../../../ui/src/telemetry/redact.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const privateDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "archer-token-"));
  dirs.push(dir);
  return dir;
};
const LONG = "c".repeat(64);
const isPage = (path: string): boolean => path === "/projects/";

test("new service tokens and grant secrets are 32 hex digits", () => {
  for (let i = 0; i < 20; i++) expect(newToken()).toMatch(/^[0-9a-f]{32}$/);
  expect(new AccessGrantStore(privateDir()).issue("Phone").token).toMatch(/^[0-9a-f]{32}$/);
});

test("both lengths are tokens; nothing in between", () => {
  expect(isToken("a".repeat(32))).toBe(true);
  expect(isToken(LONG)).toBe(true);
  for (const length of [31, 33, 48, 63, 65]) expect(isToken("a".repeat(length)), String(length)).toBe(false);
});

test("an identity saved with a 64-digit token before the upgrade is kept", () => {
  const dir = privateDir();
  writeIdentity(dir, { token: LONG, port: 40399 });
  expect(readIdentity(dir)).toEqual({ token: LONG, port: 40399 });
});

test("short and long service tokens and grant secrets are admitted as links and bearers, and their sessions as cookies", () => {
  const dir = privateDir();
  // A grant issued before the upgrade: its 64-digit secret is stored only as a verifier.
  writeFileSync(
    join(dir, "access-grants.json"),
    JSON.stringify({
      version: 1,
      grants: [
        {
          id: randomUUID(),
          label: "Old",
          issuedAt: new Date().toISOString(),
          revokedAt: null,
          verifier: createHash("sha256").update(LONG).digest("hex"),
        },
      ],
    }),
    { mode: 0o600 },
  );
  const grants = new AccessGrantStore(dir),
    fresh = grants.issue("New");
  const headers = { host: "localhost:40399" };
  for (const serviceToken of ["d".repeat(32), "e".repeat(64)]) {
    const authority: BrowserAuthority = {
      serviceToken,
      grants,
      cookieName: "archer-40399",
      secure: false,
      allowedHosts: new Set(["localhost:40399"]),
    };
    for (const secret of [serviceToken, fresh.token, LONG]) {
      const exchange = browserAccess(
        authority,
        "GET",
        new URL(`http://localhost:40399/projects/?token=${secret}`),
        headers,
        isPage,
      );
      expect(exchange, secret.length + " link").toMatchObject({ credential: "exchange" });
      const session = exchange!.cookie!.split(";")[0]!;
      expect(
        browserAccess(
          authority,
          "GET",
          new URL("http://localhost:40399/projects/"),
          { ...headers, cookie: session },
          isPage,
        ),
        secret.length + " cookie",
      ).toMatchObject({ credential: "cookie" });
    }
    for (const secret of [fresh.token, LONG])
      expect(
        browserAccess(
          authority,
          "GET",
          new URL("http://localhost:40399/projects/"),
          { ...headers, authorization: `Bearer ${secret}` },
          isPage,
        ),
        secret.length + " bearer",
      ).toMatchObject({ credential: "bearer" });
    // In the path, either length is no credential (the retired path-token form).
    expect(
      browserAccess(authority, "GET", new URL(`http://localhost:40399/${serviceToken}/projects/`), headers, isPage),
    ).toBeNull();
  }
});

test("telemetry redacts and names short tokens as it does long ones", () => {
  const short = "f".repeat(32);
  for (const redact of [redactText, redactPageText]) {
    expect(redact(`GET /projects/?follow&token=${short}`)).not.toContain(short);
    expect(redact(`cookie ${short} and ${LONG}`)).not.toMatch(/[0-9a-f]{32}/);
  }
  expect(routePattern(`/${short}/projects/`)).toBe("/:token/projects/");
});
