import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessGrantStore } from "../../src/service/access-grants.ts";
import { browserAccess, type BrowserAuthority } from "../../src/service/browser-access.ts";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "archer-access-"));
  dirs.push(dir);
  const grants = new AccessGrantStore(dir),
    issued = grants.issue("Browser");
  const authority: BrowserAuthority = {
    serviceToken: "a".repeat(64),
    grants,
    cookieName: "__Host-archer-40399",
    secure: true,
    allowedHosts: new Set(["localhost:40399"]),
  };
  return {
    authority,
    issued,
    headers: { host: "localhost:40399", cookie: `${authority.cookieName}=${grants.mintGrantSession(issued.id)}` },
  };
}
const isPage = (path: string): boolean => path === "/projects/" || path === "/p/example/browse/";

test("a grant link exchanges once for a remembered secure cookie and a clean filtered route", () => {
  const { authority, issued, headers } = fixture();
  const result = browserAccess(
    authority,
    "GET",
    new URL(`https://localhost:40399/p/example/browse/?q=hello&token=${issued.token}`),
    headers,
    isPage,
  );
  expect(result).toMatchObject({
    credential: "exchange",
    grantId: issued.id,
    path: "/p/example/browse/",
    redirect: "/p/example/browse/?q=hello",
  });
  expect(result?.cookie).toContain("HttpOnly; SameSite=Strict; Path=/; Secure; Max-Age=");
  expect(browserAccess(authority, "GET", new URL("https://localhost:40399/projects/"), headers, isPage)).toMatchObject({
    credential: "cookie",
    grantId: issued.id,
  });
});

test("invalid explicit credentials never fall back to an otherwise valid remembered cookie", () => {
  const { authority, issued, headers } = fixture();
  for (const query of [
    `?token=wrong`,
    `?token=${issued.token}&token=${issued.token}`,
    `?token=${issued.token}&token=wrong`,
  ])
    expect(
      browserAccess(authority, "GET", new URL(`https://localhost:40399/projects/${query}`), headers, isPage),
    ).toBeNull();
  for (const authorization of ["Basic abc", "Bearer wrong", "Bearer " + "b".repeat(64)])
    expect(
      browserAccess(
        authority,
        "GET",
        new URL("https://localhost:40399/projects/"),
        { ...headers, authorization },
        isPage,
      ),
    ).toBeNull();
  authority.grants.revoke(issued.id);
  expect(browserAccess(authority, "GET", new URL("https://localhost:40399/projects/"), headers, isPage)).toBeNull();
});

test("exchange is confined to admitted page GETs and validated Host", () => {
  const { authority, issued, headers } = fixture();
  for (const [method, path] of [
    ["POST", "/projects/"],
    ["GET", "/api/connection"],
    ["GET", "/unknown/"],
    ["GET", "//evil.example/"],
  ])
    expect(
      browserAccess(
        authority,
        method!,
        new URL(`https://localhost:40399${path}?token=${issued.token}`),
        headers,
        isPage,
      ),
    ).toBeNull();
  expect(
    browserAccess(
      authority,
      "GET",
      new URL(`https://localhost:40399/projects/?token=${issued.token}`),
      { ...headers, host: "evil.example" },
      isPage,
    ),
  ).toBeNull();
});

test("cookie writes require exact origin and JSON; Bearer clients can omit browser Origin", () => {
  const { authority, issued, headers } = fixture();
  const url = new URL("https://localhost:40399/p/example/api/selection");
  for (const origin of [undefined, "null", "http://localhost:40399", "https://elsewhere:40399"])
    expect(
      browserAccess(
        authority,
        "POST",
        url,
        { ...headers, ...(origin === undefined ? {} : { origin }), "content-type": "application/json" },
        isPage,
      ),
    ).toBeNull();
  expect(
    browserAccess(
      authority,
      "POST",
      url,
      { ...headers, origin: "https://localhost:40399", "content-type": "text/plain" },
      isPage,
    ),
  ).toBeNull();
  expect(
    browserAccess(
      authority,
      "POST",
      url,
      { ...headers, origin: "https://localhost:40399", "content-type": "application/json" },
      isPage,
    ),
  ).toMatchObject({ credential: "cookie" });
  expect(
    browserAccess(authority, "POST", url, { host: headers.host, authorization: `Bearer ${issued.token}` }, isPage),
  ).toMatchObject({ credential: "bearer" });
});
