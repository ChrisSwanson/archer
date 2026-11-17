// Per-browser sessions (decision D2, 2026-10-31; finding C-22, ASVS 7.2.4 "a fresh cookie"; rubric R1,
// G4): every sign-in mints a fresh session secret for its grant, stored hashed, revoked with the grant; the
// link's secret never appears in Set-Cookie, and a cookie holding a link's secret or the service token is refused.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  AccessGrantError,
  AccessGrantStore,
  MAX_SESSION_MINTS_PER_MINUTE,
  MAX_SESSIONS_PER_SUBJECT,
  SESSION_MAX_AGE_SECONDS,
} from "../../src/service/access-grants.ts";
import { connectService } from "../../src/service/service-client.ts";
import { cleanUp, events, http, project, service, slugOf, tempDir } from "../service/support.ts";

afterEach(cleanUp);

const setCookie = (reply: { headers: Record<string, unknown> }): string =>
  (reply.headers["set-cookie"] as string[])[0]!;
const pair = (header: string): string => header.split(";")[0]!;
const value = (header: string): string => pair(header).split("=")[1]!;

async function signedIn() {
  const { svc, state } = await service();
  const client = await connectService(svc.socketPath);
  const attached = await client.call("attach", { root: project() });
  const grant = await client.call("issueAccess", { label: "Shared link" });
  const origin = new URL(svc.homeUrl).origin,
    slug = slugOf(attached.url);
  return { svc, state, client, grant, origin, slug, link: `${origin}/projects/${slug}/?token=${grant.token}` };
}

test("two browsers opening the same link get different cookies, neither the link's secret, and both work", async () => {
  const { svc, client, grant, origin, link } = await signedIn();
  try {
    const first = await http(link),
      second = await http(link);
    expect([first.status, second.status]).toEqual([303, 303]);
    const [a, b] = [setCookie(first), setCookie(second)];
    expect(value(a)).not.toBe(value(b));
    for (const header of [a, b]) {
      expect(header).not.toContain(grant.token);
      expect(header).not.toContain(svc.token);
      expect(value(header)).toMatch(/^[a-f0-9]{32}$/);
      expect(header).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS}`);
      expect((await http(`${origin}/api/projects`, { headers: { cookie: pair(header) } })).status).toBe(200);
    }
  } finally {
    client.close();
  }
}, 15_000);

test("revoking the grant ends every browser signed in with it, and their open streams", async () => {
  const { client, grant, origin, slug, link } = await signedIn();
  try {
    const cookies = [pair(setCookie(await http(link))), pair(setCookie(await http(link)))];
    const other = await client.call("issueAccess", { label: "Another link" });
    const kept = pair(setCookie(await http(`${origin}/projects/${slug}/?token=${other.token}`)));
    const streams = await Promise.all(cookies.map((cookie) => events(`${origin}/p/${slug}/api/events`, { cookie })));
    try {
      expect(streams.map((stream) => stream.status)).toEqual([200, 200]);
      expect(await client.call("revokeAccess", { grantId: grant.id })).toEqual({ revoked: true });
      for (const cookie of cookies)
        expect((await http(`${origin}/api/projects`, { headers: { cookie } })).status).toBe(404);
      // The streams were ended by the revocation (their next frame never arrives).
      for (const stream of streams) await expect(stream.next("presentation", 500)).rejects.toThrow();
      expect((await http(`${origin}/api/projects`, { headers: { cookie: kept } })).status).toBe(200);
    } finally {
      streams.forEach((stream) => stream.close());
    }
  } finally {
    client.close();
  }
}, 15_000);

test("the owner's agent link (the service token) and a pairing code also set a session, never the service token or a grant secret", async () => {
  const { svc, client, origin, slug } = await signedIn();
  try {
    const owner = await http(`${origin}/projects/${slug}/?follow&token=${svc.token}`);
    expect(owner.status).toBe(303);
    expect(setCookie(owner)).not.toContain(svc.token);
    const ownerCookie = pair(setCookie(owner));
    // The owner's session keeps the owner's authority (the home page is the service token's only).
    expect((await http(`${origin}/projects/${slug}/`, { headers: { cookie: ownerCookie } })).status).toBe(200);
    const code = await client.call("issuePairingCode", {});
    const paired = await http(`${origin}/-/pair`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ code: code.code }),
    });
    expect(paired.status, paired.body).toBe(303);
    const pairedCookie = pair(setCookie(paired));
    expect((await http(`${origin}/api/projects`, { headers: { cookie: pairedCookie } })).status).toBe(200);
    const listed = await client.call("listAccess", {});
    expect(JSON.stringify(listed)).not.toContain(value(pairedCookie));
    expect(JSON.stringify(listed)).not.toContain(value(ownerCookie));
  } finally {
    client.close();
  }
}, 15_000);

test("a cookie holding a secret itself (the link's own secret, or the service token) authenticates nothing", async () => {
  const { svc, client, grant, origin, slug, link } = await signedIn();
  try {
    const name = pair(setCookie(await http(link))).split("=")[0]!;
    expect((await http(`${origin}/api/projects`, { headers: { cookie: `${name}=${grant.token}` } })).status).toBe(404);
    expect(
      (await http(`${origin}/projects/${slug}/`, { headers: { cookie: `${name}=${svc.token}` } })).status,
    ).not.toBe(200);
  } finally {
    client.close();
  }
}, 15_000);

test("a session secret is a cookie only: not a link, not a Bearer credential; it is stored only as a verifier", async () => {
  const { state, client, origin, slug, link } = await signedIn();
  try {
    const session = value(setCookie(await http(link)));
    expect((await http(`${origin}/projects/${slug}/?token=${session}`)).status).toBe(404);
    expect((await http(`${origin}/api/projects`, { headers: { authorization: `Bearer ${session}` } })).status).toBe(
      404,
    );
    const stored = readdirSync(state)
      .filter((file) => file.endsWith(".json"))
      .map((file) => readFileSync(join(state, file), "utf8"))
      .join("\n");
    expect(stored).toContain('"sessions"');
    expect(stored).not.toContain(session);
  } finally {
    client.close();
  }
}, 15_000);

test("store: sessions expire with the cookie, owner sessions end with a new service token, and each grant keeps its newest", () => {
  const dir = tempDir("archer-sessions-");
  let now = Date.parse("2026-10-31T12:00:00.000Z");
  const store = new AccessGrantStore(dir, () => now);
  const grant = store.issue("Link");
  const session = store.mintGrantSession(grant.id);
  expect(store.authenticateSession(session)?.id).toBe(grant.id);
  expect(store.authenticateLink(session)).toBeNull();
  const owner = store.mintOwnerSession("a".repeat(32));
  expect(store.authenticateOwnerSession(owner, "a".repeat(32))).toBe(true);
  expect(store.authenticateOwnerSession(owner, "b".repeat(32))).toBe(false);
  expect(store.authenticateSession(owner)).toBeNull();
  now += SESSION_MAX_AGE_SECONDS * 1000 + 1;
  expect(store.authenticateSession(session)).toBeNull();
  expect(store.authenticateOwnerSession(owner, "a".repeat(32))).toBe(false);
  // The grant's own secret is not a session: it outlives them, as a link does, and is never a session.
  expect(store.authenticateLink(grant.token)?.id).toBe(grant.id);
  expect(store.authenticateSession(grant.token)).toBeNull();
  // Sign-ins are paced (C-27), so 70 of them take minutes, not a burst.
  const many = Array.from({ length: 70 }, () => {
    now += 60_000 / MAX_SESSION_MINTS_PER_MINUTE;
    return store.mintGrantSession(grant.id);
  });
  expect(store.authenticateSession(many[0]!)).toBeNull();
  expect(store.authenticateSession(many.at(-1)!)?.id).toBe(grant.id);
  store.revoke(grant.id);
  expect(store.authenticateSession(many.at(-1)!)).toBeNull();
  expect(() => store.mintGrantSession(grant.id)).toThrow();
});

// C-27 (S4, R5/R1): one link holder signing in as fast as it can neither floods the session store with writes
// nor, in a burst, pushes the link's other browsers out. Each grant mints at most MAX_SESSION_MINTS_PER_MINUTE
// sessions a minute; the owner (the service token's holder) is not paced. Evicting a grant's other browsers
// past MAX_SESSIONS_PER_SUBJECT now takes minutes of sign-ins.
test("store: a grant's sign-ins are paced per minute, other grants and the owner are not, and the pace recovers", () => {
  const dir = tempDir("archer-sessions-");
  let now = Date.parse("2026-10-31T12:00:00.000Z");
  const store = new AccessGrantStore(dir, () => now);
  const grant = store.issue("Link"),
    other = store.issue("Other");
  const first = store.mintGrantSession(grant.id);
  for (let i = 1; i < MAX_SESSION_MINTS_PER_MINUTE; i++) store.mintGrantSession(grant.id);
  const before = readFileSync(join(dir, "browser-sessions.json"), "utf8");
  let refused: unknown;
  try {
    store.mintGrantSession(grant.id);
  } catch (failure) {
    refused = failure;
  }
  expect(refused).toBeInstanceOf(AccessGrantError);
  expect((refused as AccessGrantError).code).toBe("session_rate_limited");
  // A refused sign-in writes nothing and signs nobody out.
  expect(readFileSync(join(dir, "browser-sessions.json"), "utf8")).toBe(before);
  expect(store.authenticateSession(first)?.id).toBe(grant.id);
  expect(store.authenticateSession(store.mintGrantSession(other.id))?.id).toBe(other.id);
  for (let i = 0; i < MAX_SESSION_MINTS_PER_MINUTE + 5; i++) store.mintOwnerSession("a".repeat(32));
  now += 60_001;
  expect(store.authenticateSession(store.mintGrantSession(grant.id))?.id).toBe(grant.id);
  expect(MAX_SESSION_MINTS_PER_MINUTE * 3).toBeLessThan(MAX_SESSIONS_PER_SUBJECT);
});
