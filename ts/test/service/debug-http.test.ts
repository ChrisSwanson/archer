// Development telemetry over HTTP (docs/devkit/CONTRACT.md): absent without
// ARCHER_DEBUG=1, gated by loopback or a grant cookie with it.
import { createServer, request, type Server } from "node:http";
import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/service-client.ts";
import { AccessGrantStore } from "../../src/service/access-grants.ts";
import { API_ROUTES } from "../../../shared/api-routes.mts";
import { API_NAMES, DebugHttp, routePattern, type DebugHttpOptions } from "../../src/service/debug-http.ts";
import { Telemetry } from "../../src/telemetry/index.ts";
import { cleanUp, FLOW, http, openPage, project, service, tempDir, write } from "./support.ts";

afterEach(cleanUp);

const debugEnv = { ARCHER_DEBUG: "1" };
const profilingEnv = { ARCHER_DEBUG: "1", ARCHER_DEBUG_PROFILING: "1" };
const origin = (homeUrl: string): string => new URL(homeUrl).origin;
/** Logs, events, profiles and reset need a grant: the service token as a bearer credential. */
let AUTH = "";
const auth = (headers: Record<string, string> = {}): Record<string, string> => ({
  ...headers,
  authorization: `Bearer ${AUTH}`,
});
const log = async (
  base: string,
  query = "",
): Promise<{
  seq: number;
  entries: { seq: number; code: string; level: string; data?: Record<string, unknown>; source?: string }[];
}> => {
  const reply = await http(`${base}/-/debug/log${query}`, { headers: auth() });
  expect(reply.status, reply.body).toBe(200);
  return JSON.parse(reply.body);
};

test("debug off: every /-/debug/ route is the bare 404 and no telemetry headers are added", async () => {
  const { svc } = await service();
  const base = origin(svc.homeUrl);
  for (const [method, path] of [
    ["GET", "health"],
    ["GET", "metrics"],
    ["GET", "log"],
    ["POST", "events"],
    ["POST", "reset"],
    ["POST", "profile/cpu?seconds=1"],
    ["POST", "heap-snapshot"],
  ] as const) {
    const reply = await http(`${base}/-/debug/${path}`, { method });
    expect([path, reply.status, reply.body]).toEqual([path, 404, ""]);
    expect(reply.headers["x-archer-request-id"]).toBeUndefined();
    expect(reply.headers["server-timing"]).toBeUndefined();
  }
  // The page the agent's home link signs in to (Projects).
  const home = await openPage(svc.homeUrl);
  expect(home.status).toBe(200);
  expect(home.headers["server-timing"]).toBeUndefined();
  expect(home.headers["x-archer-request-id"]).toBeUndefined();
});

/** Every debug route the code serves (debug-http.ts #route), and names it does not. */
const DEBUG_ROUTES = [
  ["GET", "health"],
  ["GET", "metrics"],
  ["GET", "log"],
  ["GET", "events"],
  ["POST", "events"],
  ["POST", "reset"],
  ["POST", "profile/cpu?seconds=1"],
  ["POST", "heap-snapshot"],
  ["GET", "nothing"],
  ["POST", "log"],
] as const;

test("debug off (rubric R8): no credential opens any /-/debug/ route, by cookie, Bearer or the token path", async () => {
  const { svc } = await service({ env: { ARCHER_DEBUG_PROFILING: "1" } });
  const client = await connectService(svc.socketPath);
  try {
    await client.call("attach", { root: project() });
    const grant = await client.call("issueAccess", { label: "debug-off" });
    const base = origin(svc.homeUrl);
    const grantCookie = ((await http(grant.url)).headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const ownerCookie = ((await http(svc.homeUrl)).headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const credentials: [string, string, Record<string, string>][] = [
      ["none", base, {}],
      ["owner cookie", base, { cookie: ownerCookie }],
      ["owner bearer", base, { authorization: `Bearer ${svc.token}` }],
      // A 0.14 address carrying the service token in its path: no credential at all.
      ["owner path (retired)", `${base}/${svc.token}`, {}],
      ["grant cookie", base, { cookie: grantCookie }],
      ["grant bearer", base, { authorization: `Bearer ${grant.token}` }],
    ];
    const answered: string[] = [];
    for (const [name, prefix, headers] of credentials)
      for (const [method, path] of DEBUG_ROUTES) {
        const reply = await http(`${prefix}/-/debug/${path}`, {
          method,
          headers: { ...headers, origin: base, "content-type": "application/json" },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        if (reply.status !== 404 || reply.body !== "" || reply.headers["server-timing"] !== undefined)
          answered.push(`${name} ${method} ${path}: ${reply.status}`);
      }
    expect(answered).toEqual([]);
    // The positive control: the same owner cookie is a credential on the data plane.
    expect((await http(`${base}/api/projects`, { headers: { cookie: ownerCookie } })).status).toBe(200);
  } finally {
    client.close();
  }
});

test("debug on (rubric R8): a grant, by cookie or Bearer, gets the bare 404 from every owner and profiling route; the owner does not", async () => {
  const { svc } = await service({ env: profilingEnv });
  const client = await connectService(svc.socketPath);
  try {
    await client.call("attach", { root: project() });
    const base = origin(svc.homeUrl);
    const grant = await client.call("issueAccess", { label: "debug-on grant" });
    const grantCookie = ((await http(grant.url)).headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const owner = (method: string, name: string) =>
      !(method === "GET" && name === "health") && !(method === "POST" && name === "events");
    const routes = DEBUG_ROUTES.filter(
      ([method, path]) =>
        owner(method, path.split("?")[0]!) && path !== "nothing" && !(method === "POST" && path === "log"),
    );
    expect(routes.map(([m, p]) => `${m} ${p}`)).toEqual([
      "GET metrics",
      "GET log",
      "GET events",
      "POST reset",
      "POST profile/cpu?seconds=1",
      "POST heap-snapshot",
    ]);
    const answered: string[] = [];
    for (const [name, headers] of [
      ["grant cookie", { cookie: grantCookie }],
      ["grant bearer", { authorization: `Bearer ${grant.token}` }],
    ] as const)
      for (const [method, path] of routes) {
        const reply = await http(`${base}/-/debug/${path}`, {
          method,
          headers: { ...headers, origin: base, "content-type": "application/json" },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        if (reply.status !== 404 || reply.body !== "") answered.push(`${name} ${method} ${path}: ${reply.status}`);
      }
    expect(answered).toEqual([]);
    // Positive controls: the grant is a credential (health, page events), and the owner opens the owner routes.
    expect(
      (
        await http(`${base}/-/debug/events`, {
          method: "POST",
          headers: { cookie: grantCookie, origin: base, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(422);
    const ownerBearer = { authorization: `Bearer ${svc.token}` };
    expect((await http(`${base}/-/debug/log`, { headers: ownerBearer })).status).toBe(200);
    expect((await http(`${base}/-/debug/events`, { headers: ownerBearer })).status).toBe(200);
    expect((await http(`${base}/-/debug/profile/cpu?seconds=0`, { method: "POST", headers: ownerBearer })).status).toBe(
      422,
    );
    // The owner signed in by the agent's link holds a session cookie (not the token): it opens the owner routes too.
    const signedIn = await http(svc.homeUrl);
    const ownerSession = (signedIn.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    expect(ownerSession.split("=")[1]).not.toBe(svc.token);
    expect((await http(`${base}/-/debug/log`, { headers: { cookie: ownerSession } })).status).toBe(200);
    expect(
      (
        await http(`${base}/-/debug/reset`, {
          method: "POST",
          headers: { cookie: ownerSession, origin: base, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(200);
  } finally {
    client.close();
  }
});

// G3 Bearer column (C-31): a browser session secret is a cookie only. As a Bearer header it is no
// credential on the debug routes, as on the data plane; the grant's own secret still is.
test("debug on: a session secret sent as Bearer is refused; the link's own secret is not", async () => {
  const { svc } = await service({ env: debugEnv });
  const client = await connectService(svc.socketPath);
  try {
    await client.call("attach", { root: project() });
    const base = origin(svc.homeUrl);
    const grant = await client.call("issueAccess", { label: "debug bearer" });
    const grantSession = ((await http(grant.url)).headers["set-cookie"] as string[])[0]!.split(";")[0]!.split("=")[1]!;
    const ownerSession = ((await http(svc.homeUrl)).headers["set-cookie"] as string[])[0]!
      .split(";")[0]!
      .split("=")[1]!;
    const events = (secret: string) =>
      http(`${base}/-/debug/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: "{}",
      });
    expect((await events(grant.token)).status).toBe(422);
    for (const session of [grantSession, ownerSession]) {
      const reply = await events(session);
      expect([reply.status, reply.body]).toEqual([404, ""]);
      expect((await http(`${base}/-/debug/log`, { headers: { authorization: `Bearer ${session}` } })).status).toBe(404);
    }
  } finally {
    client.close();
  }
});

test("debug on: health, metrics, log and Server-Timing", async () => {
  const { svc } = await service({ env: debugEnv });
  AUTH = svc.token;
  const client = await connectService(svc.socketPath);
  try {
    const root = project();
    const attached = await client.call("attach", { root });
    const base = origin(svc.homeUrl);
    const health = await http(`${base}/-/debug/health`);
    expect(health.status).toBe(200);
    expect(health.headers["x-archer-request-id"]).toMatch(/^[0-9a-f]{6}-[0-9a-z]+$/);
    const body = JSON.parse(health.body);
    expect(body).toMatchObject({
      ok: true,
      version: expect.any(String),
      uptimeMs: expect.any(Number),
      streams: 0,
      eventLoopLagMs: expect.any(Number),
      heapUsedMb: expect.any(Number),
      rssMb: expect.any(Number),
      warnings: expect.any(Number),
    });
    expect(body.projects).toEqual([
      {
        slug: attached.url.split("/projects/")[1]!.split("/")[0],
        loaded: true,
        watcher: expect.any(Number),
        lastReloadMs: expect.any(Number),
      },
    ]);

    // A data-plane request, by the owner's session cookie: phases and total, a request id.
    const slug = body.projects[0].slug as string;
    const cookie = ((await http(svc.homeUrl)).headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const inventory = await http(`${base}/p/${slug}/api/diagrams`, { headers: { cookie } });
    expect(inventory.status).toBe(200);
    expect(inventory.headers["server-timing"]).toMatch(/(^|, )auth;dur=\d+\.\d.*total;dur=\d+\.\d$/);
    expect(inventory.headers["x-archer-request-id"]).toEqual(expect.any(String));
    // An unauthenticated miss still carries the headers, and stays a bare 404.
    const miss = await http(`${base}/nowhere`);
    expect([miss.status, miss.body]).toEqual([404, ""]);
    expect(miss.headers["server-timing"]).toMatch(/total;dur=/);

    const metrics = JSON.parse((await http(`${base}/-/debug/metrics`, { headers: auth() })).body);
    expect(metrics).toMatchObject({
      schemaVersion: 1,
      compile: { byFamily: expect.any(Object), cache: expect.any(Object) },
      thumbnails: expect.any(Object),
      eventLoop: expect.any(Object),
      memory: { now: expect.any(Object), series: expect.any(Array) },
      watcher: expect.any(Object),
      streams: expect.any(Object),
      authoring: expect.any(Object),
      management: expect.any(Object),
    });
    // Keyed by pattern: the project name is a placeholder, never spelled.
    expect(metrics.routes["GET /p/:project/api/diagrams"]).toMatchObject({
      count: 1,
      statuses: { "200": 1 },
      latency: { count: 1 },
    });
    expect(JSON.stringify(metrics)).not.toContain(svc.token);
    expect(metrics.compile.byFamily.flowchart.outcomes.compiled).toBeGreaterThan(0);
    expect(metrics.management.attach.outcomes).toEqual({ ok: 1 });

    const entries = (await log(base)).entries;
    const request = entries.find((entry) => entry.code === "svc.request" && entry.data?.["status"] === 200);
    expect(request).toMatchObject({
      level: "debug",
      route: "/p/:project/api/diagrams",
      requestId: inventory.headers["x-archer-request-id"],
    });
    expect(JSON.stringify(entries)).not.toContain(svc.token);
    // Debug routes themselves are counted but never logged per request.
    expect(
      entries.some(
        (entry) => entry.code === "svc.request" && String((entry as { route?: string }).route).startsWith("/-/debug/"),
      ),
    ).toBe(false);
    const filtered = await log(base, "?level=warn&limit=5");
    expect(filtered.entries.every((entry) => entry.level === "warn" || entry.level === "error")).toBe(true);
    // Loopback alone reads health, never metrics (route keys) or logs.
    expect((await http(`${base}/-/debug/log`)).status).toBe(404);
    expect((await http(`${base}/-/debug/metrics`)).status).toBe(404);
    expect((await http(`${base}/-/debug/health`)).status).toBe(200);
    expect((await http(`${base}/-/debug/log?limit=0`, { headers: auth() })).status).toBe(422);
    expect((await http(`${base}/-/debug/log?level=loud`, { headers: auth() })).status).toBe(422);
  } finally {
    client.close();
  }
});

test("debug on: three POSTs to one URL with different bodies are not duplicates; the same body is", async () => {
  const telemetry = new Telemetry();
  const debug = new DebugHttp({
    telemetry,
    version: "test",
    authority: () => undefined,
    projects: () => [],
    streams: () => 0,
  });
  // The handler reads the body after a turn of the loop, as the service's routes do.
  const server = createServer((req, res) =>
    debug.handle(
      req,
      res,
      (rq, rs) =>
        void setImmediate(async () => {
          for await (const _ of rq) {
            /* consumed */
          }
          rs.writeHead(200, { "content-length": "0" }).end();
        }),
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/p/x/api/authoring/edit`;
    const post = async (body: string) =>
      expect((await http(url, { method: "POST", headers: { "content-type": "application/json" }, body })).status).toBe(
        200,
      );
    const warned = () =>
      telemetry.entries({ level: "warn", limit: 50 }).filter((entry) => entry.code === "svc.duplicate-request");
    for (const body of ['{"op":1}', '{"op":2}', '{"op":3}']) await post(body);
    expect(warned()).toHaveLength(0);
    for (let i = 0; i < 2; i++) await post('{"op":1}');
    expect(warned()).toHaveLength(1);
    expect(warned()[0]).toMatchObject({ data: { count: 3 } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("debug on: one read from each of three page loads (x-archer-page-load) is no duplicate", async () => {
  const { svc } = await service({ env: debugEnv });
  AUTH = svc.token;
  const base = origin(svc.homeUrl);
  for (const load of ["00000000-000000a1", "00000000-000000a2", "00000000-000000a3"])
    await http(`${base}/thrice`, { headers: { "x-archer-page-load": load } });
  expect((await log(base, "?code=svc.duplicate-request")).entries).toHaveLength(0);
  for (let i = 0; i < 2; i++) await http(`${base}/thrice`, { headers: { "x-archer-page-load": "00000000-000000a3" } });
  expect((await log(base, "?code=svc.duplicate-request")).entries).toHaveLength(1);
});

test("debug on: an event stream names its page load in the address (EventSource sends no headers), so a stream per page load is no duplicate", async () => {
  const { svc } = await service({ env: debugEnv });
  AUTH = svc.token;
  const base = origin(svc.homeUrl);
  for (const load of ["00000000-000000b1", "00000000-000000b2", "00000000-000000b3"])
    await http(`${base}/stream?page-load=${load}`);
  expect((await log(base, "?code=svc.duplicate-request")).entries).toHaveLength(0);
  for (let i = 0; i < 2; i++) await http(`${base}/stream?page-load=00000000-000000b3`);
  expect((await log(base, "?code=svc.duplicate-request")).entries).toHaveLength(1);
});

test("debug on: the same request three times within two seconds is a duplicate-request warning", async () => {
  const { svc } = await service({ env: debugEnv });
  AUTH = svc.token;
  const base = origin(svc.homeUrl);
  for (let i = 0; i < 3; i++) await http(`${base}/twice?token=${"f".repeat(64)}`);
  const warned = (await log(base, "?code=svc.duplicate-request")).entries;
  expect(warned).toHaveLength(1);
  expect(warned[0]).toMatchObject({ level: "warn", data: { client: "addr:127.0.0.1", count: 3 } });
  expect(JSON.stringify(warned)).not.toContain("f".repeat(64));
  const health = JSON.parse((await http(`${base}/-/debug/health`)).body);
  expect(health.warnings).toBeGreaterThanOrEqual(1);
  // Reset clears the window; seq keeps counting.
  const before = (await log(base)).seq;
  const reset = JSON.parse((await http(`${base}/-/debug/reset`, { method: "POST", headers: auth() })).body);
  expect(reset.reset).toBe(true);
  expect((await log(base)).entries).toEqual([]);
  expect((await log(base)).seq).toBeGreaterThanOrEqual(before);
});

test("debug on: a project's first load is no cache-miss storm (a first compile is no miss)", async () => {
  const { svc } = await service({ env: debugEnv });
  AUTH = svc.token;
  const client = await connectService(svc.socketPath);
  try {
    const root = project();
    // More views than the storm threshold (20), all compiled for the first time on attach.
    for (let i = 0; i < 30; i++) write(root, `.archer/diagrams/d${i}.mmd`, FLOW);
    await client.call("attach", { root });
    const base = origin(svc.homeUrl);
    expect((await log(base, "?code=svc.cache-miss-storm")).entries).toEqual([]);
    const metrics = JSON.parse((await http(`${base}/-/debug/metrics`, { headers: auth() })).body);
    expect(metrics.compile.cache.miss ?? 0).toBe(0);
  } finally {
    client.close();
  }
});

test("debug on: a refused authoring edit is logged with its refusal code", async () => {
  const { svc } = await service({ env: debugEnv });
  AUTH = svc.token;
  const client = await connectService(svc.socketPath);
  try {
    const root = project();
    const attached = await client.call("attach", { root });
    const author = await client.call("issueAuthoringAccess", { label: "author", projectRoots: [root] });
    const cookie = ((await http(author.url)).headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const base = origin(svc.homeUrl),
      slug = attached.url.split("/projects/")[1]!.split("/")[0]!;
    const reply = await http(`${base}/p/${slug}/api/authoring/edit`, {
      method: "POST",
      headers: { cookie, origin: base, "content-type": "application/json", "x-archer-client-action": "test.delete" },
      body: JSON.stringify({ source: "flowchart LR\n  a[A]\n", edit: { kind: "delete-node", id: "missing" } }),
    });
    expect(reply.status, reply.body).toBe(200);
    const refusal = JSON.parse(reply.body) as { ok: boolean; code: string };
    expect(refusal.ok).toBe(false);
    const entries = (await log(base, "?code=svc.edit-")).entries;
    expect(entries).toEqual([
      expect.objectContaining({
        level: "info",
        code: "svc.edit-refused",
        requestId: reply.headers["x-archer-request-id"],
        data: { family: "flowchart", op: "delete-node", code: refusal.code },
      }),
    ]);
    const metrics = JSON.parse((await http(`${base}/-/debug/metrics`, { headers: auth() })).body);
    expect(metrics.authoring.edits["flowchart delete-node"].outcomes).toEqual({ [refusal.code]: 1 });
    const tagged = (await log(base, "?code=svc.request")).entries.find(
      (entry) => (entry as { action?: string }).action === "test.delete",
    );
    expect(tagged).toBeDefined();
    // A credential the page cannot author with (a bearer token, not the browser's cookie): the reason is logged, the token never is.
    const reader = await client.call("issueAccess", { label: "reader" });
    const readerCookie = ((await http(reader.url)).headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    await http(`${base}/p/${slug}/api/authoring/edit`, {
      method: "POST",
      headers: { authorization: `Bearer ${reader.token}`, origin: base, "content-type": "application/json" },
      body: "{}",
    });
    const forbidden = (await log(base, "?code=svc.authoring-forbidden")).entries;
    expect(forbidden).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ code: "authoring_forbidden", reason: "credential_bearer" }),
      }),
    ]);
    expect(JSON.stringify((await log(base)).entries)).not.toContain(reader.token);
    // A reader's (or author's) grant is not the owner's: the log and reset stay closed to it.
    for (const grantCookie of [readerCookie, cookie]) {
      expect((await http(`${base}/-/debug/log`, { headers: { cookie: grantCookie } })).status).toBe(404);
      expect(
        (await http(`${base}/-/debug/reset`, { method: "POST", headers: { cookie: grantCookie, origin: base } }))
          .status,
      ).toBe(404);
      expect((await http(`${base}/-/debug/health`, { headers: { cookie: grantCookie } })).status).toBe(200);
    }
  } finally {
    client.close();
  }
});

test("debug on: browser events are validated, capped and stored as client entries", async () => {
  const { svc } = await service({ env: debugEnv });
  AUTH = svc.token;
  const base = origin(svc.homeUrl);
  const post = (body: string, headers: Record<string, string> = { "content-type": "application/json" }) =>
    http(`${base}/-/debug/events`, { method: "POST", headers: auth(headers), body });
  const accepted = await post(
    JSON.stringify({
      session: "s1",
      page: "/projects/x/",
      build: "dev",
      events: [
        {
          at: Date.now(),
          type: "fetch-slow",
          code: "ui.fetch-slow",
          msg: "GET api/diagrams 1200 ms",
          data: { cookie: "archer-1=secret", url: `/projects/?token=${"a".repeat(64)}` },
        },
        { at: new Date().toISOString(), type: "web-vitals", code: "ui.web-vitals", data: { LCP: 900 } },
      ],
    }),
  );
  expect(accepted.status, accepted.body).toBe(200);
  expect(JSON.parse(accepted.body)).toMatchObject({ accepted: 2 });
  const events = JSON.parse((await http(`${base}/-/debug/events`, { headers: auth() })).body).entries;
  expect(events).toEqual([
    expect.objectContaining({
      source: "client",
      level: "warn",
      code: "ui.fetch-slow",
      data: expect.objectContaining({
        session: "s1",
        type: "fetch-slow",
        data: { cookie: "[redacted]", url: "/projects/?token=[redacted]" },
      }),
    }),
    expect.objectContaining({ source: "client", level: "info", code: "ui.web-vitals" }),
  ]);
  // The same entries interleave with the service's in /log.
  expect((await log(base, "?code=ui.")).entries).toHaveLength(2);
  expect((await post("{not json")).status).toBe(422);
  expect(
    (
      await post(
        JSON.stringify({
          session: "s",
          page: "p",
          build: "b",
          events: Array.from({ length: 201 }, () => ({ at: 1, type: "x" })),
        }),
      )
    ).status,
  ).toBe(422);
  expect((await post(JSON.stringify({ session: "s", page: "p", build: "b", events: [{ type: "x" }] }))).status).toBe(
    422,
  );
  expect((await post("x".repeat(64 * 1024 + 1))).status).toBe(413);
  expect((await post("{}", { "content-type": "application/json", origin: "https://evil.invalid" })).status).toBe(404);
  // sendBeacon's text/plain is the same JSON.
  expect(
    (await post(JSON.stringify({ session: "s", page: "p", build: "b", events: [] }), { "content-type": "text/plain" }))
      .status,
  ).toBe(200);
});

test("debug on: a CPU profile is a V8 profile; seconds are bounded", async () => {
  const { svc } = await service({ env: profilingEnv });
  AUTH = svc.token;
  const base = origin(svc.homeUrl);
  for (const seconds of ["0", "61", "1.5", "x"])
    expect(
      (await http(`${base}/-/debug/profile/cpu?seconds=${seconds}`, { method: "POST", headers: auth() })).status,
    ).toBe(422);
  const profile = await http(`${base}/-/debug/profile/cpu?seconds=1`, { method: "POST", headers: auth() });
  expect(profile.status).toBe(200);
  expect(profile.headers["content-disposition"]).toMatch(/\.cpuprofile"$/);
  expect(JSON.parse(profile.body)).toMatchObject({
    nodes: expect.any(Array),
    startTime: expect.any(Number),
    endTime: expect.any(Number),
  });
}, 10_000);

const OWNER = "b".repeat(64);

/** A DebugHttp in front of a stub plane, with the peer address the test chooses. */
async function gated(
  remote: string,
  extra: Partial<DebugHttpOptions> = {},
): Promise<{ url: string; grantSession: string; ownerSession: string; server: Server; telemetry: Telemetry }> {
  const grants = new AccessGrantStore(tempDir());
  const grant = grants.issue("browser");
  const telemetry = new Telemetry();
  let allowed = "";
  const debug = new DebugHttp({
    telemetry,
    version: "test",
    authority: () => ({
      serviceToken: OWNER,
      grants,
      cookieName: "archer-test",
      secure: false,
      allowedHosts: new Set([allowed]),
    }),
    projects: () => [],
    streams: () => 0,
    ...extra,
  });
  const server = createServer((req, res) => {
    Object.defineProperty(req.socket, "remoteAddress", { value: remote, configurable: true });
    debug.handle(req, res, (_, r) => void r.writeHead(404, { "content-length": "0" }).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  allowed = `127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url: `http://${allowed}`,
    grantSession: grants.mintGrantSession(grant.id),
    ownerSession: grants.mintOwnerSession(OWNER),
    server,
    telemetry,
  };
}

const closeServer = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));
/** A snapshot source of `chunks` chunks of 64 KiB. */
const fakeSnapshot =
  (chunks: number) =>
  async (chunk: (text: string) => void): Promise<void> => {
    for (let i = 0; i < chunks; i++) chunk("x".repeat(64 * 1024));
  };

test("access: a non-loopback peer needs a valid grant cookie; refusals are the plane's bare 404", async () => {
  const remote = await gated("10.1.2.3");
  try {
    expect(await http(`${remote.url}/-/debug/health`)).toMatchObject({ status: 404, body: "" });
    expect(
      (await http(`${remote.url}/-/debug/health`, { headers: { cookie: `archer-test=${"c".repeat(64)}` } })).status,
    ).toBe(404);
    const admitted = await http(`${remote.url}/-/debug/health`, {
      headers: { cookie: `archer-test=${remote.grantSession}` },
    });
    expect(admitted.status).toBe(200);
    expect(JSON.parse(admitted.body)).toMatchObject({ ok: true, version: "test" });
    // A host the service does not serve is refused even from loopback (DNS rebinding).
    expect(
      (
        await http(`${remote.url}/-/debug/health`, {
          headers: { host: "evil.invalid", cookie: `archer-test=${remote.grantSession}` },
        })
      ).status,
    ).toBe(404);
  } finally {
    await new Promise<void>((resolve) => remote.server.close(() => resolve()));
  }
  const local = await gated("::ffff:127.0.0.1");
  try {
    expect((await http(`${local.url}/-/debug/health`)).status).toBe(200);
  } finally {
    await new Promise<void>((resolve) => local.server.close(() => resolve()));
  }
});

test("route patterns keep the key set small and never spell a token or project", () => {
  const token = "d".repeat(64);
  expect(
    Object.fromEntries(
      [
        "/",
        `/${token}/`,
        "/projects/",
        "/projects/demo/notes/a.md",
        `/${token}/p/demo/api/diagrams`,
        "/p/demo/api/thumbnails/flow",
        "/p/demo/api/authoring/edit",
        "/p/demo/api/authoring/operations/abc",
        "/p/demo/api/comments/t1/replies",
        "/api/settings",
        "/-/debug/profile/cpu",
        "/favicon.ico",
        `/p/demo/api/${token}`,
        `/api/${token.slice(0, 32)}`,
        `/${token}/api/whatever`,
        `/-/debug/${token}`,
        `/-/debug/log/${token}`,
        "/p/demo/api/ABCD-EFGH",
      ].map((path) => [path, routePattern(path)]),
    ),
  ).toEqual({
    "/": "/",
    [`/${token}/`]: "/:token/",
    "/projects/": "/projects/",
    "/projects/demo/notes/a.md": "/projects/:project/*",
    [`/${token}/p/demo/api/diagrams`]: "/:token/p/:project/api/diagrams",
    "/p/demo/api/thumbnails/flow": "/p/:project/api/thumbnails/:id",
    "/p/demo/api/authoring/edit": "/p/:project/api/authoring/edit",
    "/p/demo/api/authoring/operations/abc": "/p/:project/api/authoring/operations/:id",
    "/p/demo/api/comments/t1/replies": "/p/:project/api/comments/:id/replies",
    "/api/settings": "/api/settings",
    "/-/debug/profile/cpu": "/-/debug/profile/cpu",
    "/favicon.ico": "/:other",
    // A name the service does not serve is a placeholder, whatever it spells (C-06/X-03).
    [`/p/demo/api/${token}`]: "/p/:project/api/:other",
    [`/api/${token.slice(0, 32)}`]: "/api/:other",
    [`/${token}/api/whatever`]: "/:token/api/:other",
    [`/-/debug/${token}`]: "/-/debug/:other",
    [`/-/debug/log/${token}`]: "/-/debug/:other",
    "/p/demo/api/ABCD-EFGH": "/p/:project/api/:other",
  });
});

test("access by route: a reader grant posts events and reads health; metrics, logs, reset, profiles and snapshots need the owner", async () => {
  const routes = [
    ["GET", "health"],
    ["GET", "metrics"],
    ["POST", "events"],
    ["GET", "log"],
    ["GET", "events"],
    ["POST", "reset"],
    ["POST", "profile/cpu?seconds=1"],
    ["POST", "heap-snapshot"],
  ] as const;
  const statuses = async (url: string, headers: Record<string, string>): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const [method, path] of routes) {
      const body =
        method === "POST" && path === "events"
          ? JSON.stringify({ session: "s", page: "p", build: "b", events: [] })
          : undefined;
      // A cookie write carries what a browser's would: the exact Origin and a JSON body.
      const write = method === "POST" ? { origin: url, "content-type": "application/json" } : {};
      out[`${method} ${path.split("?")[0]}`] = (
        await http(`${url}/-/debug/${path}`, { method, headers: { ...headers, ...write }, ...(body ? { body } : {}) })
      ).status;
    }
    return out;
  };
  const remote = await gated("10.1.2.3", { profiling: true, takeHeapSnapshot: fakeSnapshot(1) });
  try {
    expect(await statuses(remote.url, { cookie: `archer-test=${remote.grantSession}` })).toEqual({
      "GET health": 200,
      "GET metrics": 404,
      "POST events": 200,
      "GET log": 404,
      "GET events": 404,
      "POST reset": 404,
      "POST profile/cpu": 404,
      "POST heap-snapshot": 404,
    });
    expect(
      remote.telemetry
        .entries({ code: "svc.debug-refused", limit: 50 })
        .map((entry) => (entry.data as { reason: string }).reason),
    ).toEqual(["not_owner", "not_owner", "not_owner", "not_owner", "not_loopback", "not_loopback"]);
    // The owner from a remote peer: logs and reset, never a profile or snapshot.
    expect(await statuses(remote.url, { authorization: `Bearer ${OWNER}` })).toEqual({
      "GET health": 200,
      "GET metrics": 200,
      "POST events": 200,
      "GET log": 200,
      "GET events": 200,
      "POST reset": 200,
      "POST profile/cpu": 404,
      "POST heap-snapshot": 404,
    });
  } finally {
    await closeServer(remote.server);
  }
  const local = await gated("127.0.0.1", { profiling: true, takeHeapSnapshot: fakeSnapshot(1) });
  try {
    expect(await statuses(local.url, {})).toEqual({
      "GET health": 200,
      "GET metrics": 404,
      "POST events": 404,
      "GET log": 404,
      "GET events": 404,
      "POST reset": 404,
      "POST profile/cpu": 404,
      "POST heap-snapshot": 404,
    });
    expect(
      (
        await http(`${local.url}/-/debug/heap-snapshot`, {
          method: "POST",
          headers: { cookie: `archer-test=${local.grantSession}` },
        })
      ).status,
    ).toBe(404);
    const snapshot = await http(`${local.url}/-/debug/heap-snapshot`, {
      method: "POST",
      headers: { cookie: `archer-test=${local.ownerSession}`, origin: local.url, "content-type": "application/json" },
    });
    expect([snapshot.status, snapshot.body.length, snapshot.headers["content-length"]]).toEqual([
      200,
      64 * 1024,
      String(64 * 1024),
    ]);
  } finally {
    await closeServer(local.server);
  }
  // Without ARCHER_DEBUG_PROFILING=1 not even the owner on loopback takes one.
  const off = await gated("127.0.0.1", { takeHeapSnapshot: fakeSnapshot(1) });
  try {
    expect(
      (
        await http(`${off.url}/-/debug/heap-snapshot`, {
          method: "POST",
          headers: { authorization: `Bearer ${OWNER}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await http(`${off.url}/-/debug/profile/cpu?seconds=1`, {
          method: "POST",
          headers: { authorization: `Bearer ${OWNER}` },
        })
      ).status,
    ).toBe(404);
    expect(
      off.telemetry
        .entries({ code: "svc.debug-refused", limit: 5 })
        .map((entry) => (entry.data as { reason: string }).reason),
    ).toEqual(["profiling_off", "profiling_off"]);
  } finally {
    await closeServer(off.server);
  }
});

test("debug on without ARCHER_DEBUG_PROFILING: the service refuses profiles and snapshots to its owner", async () => {
  const { svc } = await service({ env: debugEnv });
  const base = origin(svc.homeUrl);
  for (const path of ["profile/cpu?seconds=1", "heap-snapshot"])
    expect(
      (await http(`${base}/-/debug/${path}`, { method: "POST", headers: { authorization: `Bearer ${svc.token}` } }))
        .status,
    ).toBe(404);
});

test("heap snapshots: capped, delivered with backpressure, one at a time, lock held until delivery ends", async () => {
  const MiB = 1024 * 1024;
  const owner = { authorization: `Bearer ${OWNER}` };
  const capped = await gated("127.0.0.1", {
    profiling: true,
    takeHeapSnapshot: fakeSnapshot(32),
    maxHeapSnapshotBytes: MiB,
  });
  try {
    const refused = await http(`${capped.url}/-/debug/heap-snapshot`, { method: "POST", headers: owner });
    expect([refused.status, JSON.parse(refused.body).error.code]).toEqual([413, "heap_snapshot_too_large"]);
  } finally {
    await closeServer(capped.server);
  }

  const slow = await gated("127.0.0.1", { profiling: true, takeHeapSnapshot: fakeSnapshot(512) }); // 32 MiB
  try {
    // A client that stops reading: the delivery waits on it, and the lock stays held meanwhile.
    const received = await new Promise<number>((resolve, reject) => {
      const req = request(`${slow.url}/-/debug/heap-snapshot`, { method: "POST", headers: owner }, (res) => {
        res.pause();
        setTimeout(() => {
          void http(`${slow.url}/-/debug/heap-snapshot`, { method: "POST", headers: owner }).then((busy) => {
            expect(busy.status).toBe(409);
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
            });
            res.on("end", () => resolve(size));
            res.resume();
          }, reject);
        }, 200);
      });
      req.on("error", reject);
      req.end();
    });
    expect(received).toBe(32 * MiB);
    // A client that stops reading and then goes away mid-delivery: the lock is released, the next one is served.
    // (The previous delivery's lock may outlive its client's last byte by a moment: retry a 409.)
    const abandon = (): Promise<number> =>
      new Promise<number>((resolve, reject) => {
        const req = request(`${slow.url}/-/debug/heap-snapshot`, { method: "POST", headers: owner }, (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
            return;
          }
          res.pause();
          setTimeout(() => {
            req.destroy();
            resolve(200);
          }, 200);
        });
        req.on("error", () => undefined);
        req.end();
        setTimeout(() => reject(new Error("no answer")), 10_000);
      });
    let abandoned = await abandon();
    for (let i = 0; i < 50 && abandoned === 409; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      abandoned = await abandon();
    }
    expect(abandoned).toBe(200);
    let status = 409;
    for (let i = 0; i < 50 && status === 409; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = (await http(`${slow.url}/-/debug/heap-snapshot`, { method: "POST", headers: owner })).status;
    }
    expect(status).toBe(200);
    expect(slow.telemetry.entries({ code: "svc.heap-snapshot", limit: 50 }).map((entry) => entry.msg)).toContain(
      "heap snapshot delivery ended early: the client went away",
    );
  } finally {
    await closeServer(slow.server);
  }
}, 60_000);

test("G2: a cookie POST to a debug route needs the exact Origin and a JSON body; Bearer callers need neither", async () => {
  const local = await gated("127.0.0.1");
  try {
    const owner = `archer-test=${local.ownerSession}`,
      grant = `archer-test=${local.grantSession}`;
    const batch = JSON.stringify({ session: "s", page: "p", build: "b", events: [] });
    const json = { "content-type": "application/json" };
    // The five G2 variants, each with a valid cookie: every one is refused (the bare 404) and nothing is reset.
    const variants: [string, Record<string, string>][] = [
      ["foreign Origin", { ...json, origin: "https://evil.invalid" }],
      ["Origin: null", { ...json, origin: "null" }],
      ["no Origin", json],
      ["simple content type", { "content-type": "text/plain", origin: local.url }],
      ["Sec-Fetch-Site: cross-site", { ...json, origin: local.url, "sec-fetch-site": "cross-site" }],
    ];
    const answered: string[] = [];
    for (const [name, headers] of variants) {
      local.telemetry.log("info", "test.marker", "kept unless reset");
      for (const [path, cookie, body] of [
        ["reset", owner, "{}"],
        ["events", grant, batch],
        ["events", owner, batch],
      ] as const) {
        const reply = await http(`${local.url}/-/debug/${path}`, {
          method: "POST",
          headers: { ...headers, cookie },
          body,
        });
        if (reply.status !== 404) answered.push(`${name} ${path}: ${reply.status}`);
      }
      if (local.telemetry.entries({ code: "test.marker", limit: 50 }).length === 0)
        answered.push(`${name}: the log was reset`);
    }
    expect(answered).toEqual([]);
    // Positive controls: the same cookies with the exact Origin and JSON, and the owner's Bearer with neither.
    expect(
      (
        await http(`${local.url}/-/debug/events`, {
          method: "POST",
          headers: { ...json, origin: local.url, cookie: grant },
          body: batch,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await http(`${local.url}/-/debug/reset`, {
          method: "POST",
          headers: { ...json, origin: local.url, cookie: owner },
          body: "{}",
        })
      ).status,
    ).toBe(200);
    expect(
      (await http(`${local.url}/-/debug/reset`, { method: "POST", headers: { authorization: `Bearer ${OWNER}` } }))
        .status,
    ).toBe(200);
    // A Bearer caller that does send a foreign Origin is still refused.
    expect(
      (
        await http(`${local.url}/-/debug/reset`, {
          method: "POST",
          headers: { authorization: `Bearer ${OWNER}`, origin: "https://evil.invalid" },
        })
      ).status,
    ).toBe(404);
  } finally {
    await closeServer(local.server);
  }
});

test("route patterns spell every API route the service serves (shared/api-routes.mts), so real routes stay distinct", () => {
  expect(new Set(API_ROUTES.map((spec) => spec.name)).size).toBeGreaterThan(25);
  expect(API_ROUTES.filter((spec) => !API_NAMES.has(spec.name)).map((spec) => spec.id)).toEqual([]);
  // Each route's own path keeps its name and literal segments; only its parameters become `:id`.
  const pattern = (spec: (typeof API_ROUTES)[number]): string =>
    spec.path.map((segment) => (segment.startsWith(":") ? ":id" : segment)).join("/");
  const sample = (spec: (typeof API_ROUTES)[number]): string =>
    spec.path.map((segment) => (segment.startsWith(":") ? "a1".repeat(16) : segment)).join("/");
  const wrong = API_ROUTES.flatMap((spec) => [
    ...(spec.scope === "service" ? [] : [[`/p/demo/${sample(spec)}`, `/p/:project/${pattern(spec)}`]]),
    ...(spec.scope === "project" ? [] : [[`/${sample(spec)}`, `/${pattern(spec)}`]]),
  ]).filter(([path, key]) => routePattern(path!) !== key);
  expect(wrong).toEqual([]);
});
