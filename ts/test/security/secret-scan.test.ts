// P12 (security rubric R9, docs/quality/rubrics/security.md §6): seed the service token, a grant, a
// pairing code and the CA key path on a real HTTPS service with ARCHER_DEBUG=1; drive success and
// refusal paths through URL path, query, header, body and exception channels; then scan the service
// log, the telemetry downloads (/-/debug/log, /-/debug/events, metrics, health) and ingested client
// events for raw, URL-encoded, base64 and 8-character-prefix spellings (secret-scan-forms.ts).
// Hits are reported as channel + location + kind/form only, never the secret.
//
// Not scanned, by design: the sandbox record (0600 storage, not a log) and the state directory's
// stores (verifiers, not secrets). Not reachable here: the browser's own console (the page's
// capture is exercised by posting what it posts, `ui.console-error` batches) and the journey suite
// (run separately against a sandbox).
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { request } from "node:https";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PairingCodes } from "../../src/service/pairing-codes.ts";
import { connectService } from "../../src/service/service-client.ts";
import { redactText } from "../../src/telemetry/redact.ts";
import { setupLocalTls } from "../../src/service/tls-setup.ts";
import { cleanUp, project, service, slugOf } from "../service/support.ts";
import { described, jsonRecords, lineRecords, needles, scan, type Record_, type Secret } from "./secret-scan-forms.ts";

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** A Seeded HTTPS service: its secrets, its origin, a captured service log and a request helper. */
interface Seeded {
  readonly origin: string;
  readonly slug: string;
  readonly secrets: readonly Secret[];
  readonly token: string;
  readonly grant: string;
  readonly code: string;
  readonly serviceLog: string[];
  readonly call: (method: string, params: unknown) => Promise<unknown>;
  readonly send: (
    path: string,
    options?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<Reply>;
  readonly close: () => void;
}

/** One throwaway CA and leaf for the file (each service reuses it); kept outside cleanUp's temp dirs. */
let shared: Promise<{ tlsRoot: string; tls: { tlsCert: string; tlsKey: string; caCert: string } }> | undefined;
const sharedTls = () =>
  (shared ??= (async () => {
    const tlsRoot = realpathSync(mkdtempSync(join(tmpdir(), "archer-sec-tls-")));
    const tls = await setupLocalTls({ directory: join(tlsRoot, "tls"), host: "127.0.0.1" });
    if (!("caCert" in tls)) throw new Error("TLS setup failed");
    return { tlsRoot, tls };
  })());
afterAll(async () => {
  if (shared !== undefined) rmSync((await shared).tlsRoot, { recursive: true, force: true });
});

async function seeded(): Promise<Seeded> {
  const { tlsRoot, tls } = await sharedTls();
  const ca = readFileSync(tls.caCert);
  const caKeyPath = join(tlsRoot, "tls", "ca", "ca-key.pem");
  const serviceLog: string[] = [];
  const { svc } = await service({
    forceHttp: false,
    tlsCert: tls.tlsCert,
    tlsKey: tls.tlsKey,
    log: (line) => void serviceLog.push(line),
    env: { ARCHER_DEBUG: "1" },
  });
  const client = await connectService(svc.socketPath);
  const call = (method: string, params: unknown): Promise<unknown> =>
    (client.call as (m: string, p: unknown) => Promise<unknown>)(method, params);
  const attached = (await call("attach", { root: project() })) as { url: string };
  const grant = (await call("issueAccess", { label: "secret-scan" })) as { token: string };
  const pairing = (await call("issuePairingCode", {})) as { code: string };
  const origin = new URL(svc.homeUrl).origin;
  const send = (
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const req = request(
        `${origin}${path}`,
        { method: options.method ?? "GET", headers: options.headers ?? {}, ca },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      req.on("error", reject);
      req.end(options.body);
    });
  const secrets: Secret[] = [
    { kind: "service-token", value: svc.token },
    { kind: "grant", value: grant.token },
    { kind: "pairing-code", value: pairing.code },
    { kind: "ca-key-path", value: caKeyPath },
    { kind: "ca-key", value: readFileSync(caKeyPath, "utf8") },
    { kind: "tls-key", value: readFileSync(tls.tlsKey, "utf8") },
  ];
  return {
    origin,
    slug: slugOf(attached.url),
    secrets,
    token: svc.token,
    grant: grant.token,
    code: pairing.code,
    serviceLog,
    call,
    send,
    close: () => client.close(),
  };
}

const cookieOf = (reply: Reply): string | undefined =>
  (reply.headers["set-cookie"] as string[] | undefined)?.[0]?.split(";")[0];
const flip = (secret: string): string => `${secret.slice(0, -1)}${secret.endsWith("0") ? "1" : "0"}`;
const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const enc = (text: string): string =>
  [...Buffer.from(text)].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");

/** The ordinary success and refusal traffic: every probe a correct service survives with no hit. */
async function exercise(s: Seeded): Promise<Record<string, number>> {
  const { token, grant, code, slug, origin } = s;
  const statuses: Record<string, number> = {};
  const note = async (name: string, reply: Promise<Reply>): Promise<Reply> => {
    const r = await reply;
    statuses[name] = r.status;
    return r;
  };
  const json = { "content-type": "application/json", origin };

  // Success: owner exchange and its cookie, grant exchange (query), cookie, Bearer header, an event stream, pairing (body).
  const exchange = await note("grant-query-exchange", s.send(`/projects/${slug}/?token=${grant}`));
  const cookie = cookieOf(exchange) ?? "";
  await note("cookie", s.send(`/api/projects`, { headers: { cookie } }));
  await note("bearer", s.send(`/api/projects`, { headers: { authorization: `Bearer ${grant}` } }));
  const ownerExchange = await note("owner-exchange", s.send(`/projects/${slug}/?token=${token}`));
  await note("owner-cookie", s.send(`/p/${slug}/api/diagrams`, { headers: { cookie: cookieOf(ownerExchange) ?? "" } }));
  await note("owner-debug-bearer", s.send(`/-/debug/health`, { headers: { authorization: `Bearer ${token}` } }));

  // Refusals through the URL path and query. The service token in the path (a 0.14 page address) is refused too.
  await note("owner-token-path", s.send(`/${token}/p/${slug}/api/diagrams`));
  await note("wrong-token-path", s.send(`/${flip(token)}/p/${slug}/api/diagrams`));
  await note("encoded-token-path", s.send(`/${enc(token)}/p/${slug}/api/diagrams`));
  await note("upper-token-path", s.send(`/${token.toUpperCase()}/p/${slug}/api/diagrams`));
  await note("query-wrong-grant", s.send(`/projects/${slug}/?token=${flip(grant)}`));
  await note("query-encoded-name", s.send(`/projects/${slug}/?%74oken=${enc(grant)}`));
  await note(
    "query-on-post",
    s.send(`/projects/${slug}/?token=${grant}`, { method: "POST", headers: json, body: "{}" }),
  );
  await note(
    "query-with-authorization",
    s.send(`/projects/${slug}/?token=${grant}`, { headers: { authorization: `Bearer ${grant}` } }),
  );
  await note("query-unknown-name", s.send(`/api/projects?grant=${grant}&secret=${token}&auth=${b64(token)}`));
  await note("query-base64", s.send(`/projects/${slug}/?token=${b64(grant)}`));
  await note("pairing-in-query", s.send(`/?code=${code}`));
  // Headers.
  await note("bearer-wrong", s.send(`/api/projects`, { headers: { authorization: `Bearer ${flip(grant)}` } }));
  await note("bearer-upper", s.send(`/api/projects`, { headers: { authorization: `Bearer ${grant.toUpperCase()}` } }));
  await note("basic-base64", s.send(`/api/projects`, { headers: { authorization: `Basic ${b64(`x:${token}`)}` } }));
  await note(
    "cookie-ambiguous",
    s.send(`/api/projects`, { headers: { cookie: `${cookie}; ${cookie.split("=")[0]}=${token}` } }),
  );
  await note(
    "cookie-wrong",
    s.send(`/api/projects`, { headers: { cookie: `${cookie.split("=")[0]}=${flip(grant)}` } }),
  );
  await note("debug-log-as-grant", s.send(`/-/debug/log`, { headers: { authorization: `Bearer ${grant}` } }));
  await note("debug-log-query-token", s.send(`/-/debug/log?token=${token}`));
  await note("debug-log-malformed", s.send(`/-/debug/log`, { headers: { authorization: `Bearer ${b64(token)}` } }));
  // Bodies: pairing success after refusals (wrong code, malformed JSON holding secrets, query, plain text).
  await note(
    "pair-wrong",
    s.send(`/-/pair`, { method: "POST", headers: json, body: JSON.stringify({ code: "ZZZZ-ZZZZ" }) }),
  );
  await note(
    "pair-malformed",
    s.send(`/-/pair`, { method: "POST", headers: json, body: `{"code":"${code}","token":"${token}"` }),
  );
  await note(
    "pair-query",
    s.send(`/-/pair?code=${code}`, { method: "POST", headers: json, body: JSON.stringify({ code }) }),
  );
  await note(
    "pair-text",
    s.send(`/-/pair`, { method: "POST", headers: { ...json, "content-type": "text/plain" }, body: code }),
  );
  await note(
    "pair-extra",
    s.send(`/-/pair`, { method: "POST", headers: json, body: JSON.stringify({ code: `${code}x`, grant, token }) }),
  );
  await note(
    "settings-body",
    s.send(`/api/settings`, {
      method: "POST",
      headers: { ...json, cookie },
      body: `{"token":"${token}","grant":"${grant}",`,
    }),
  );
  await note(
    "comment-malformed",
    s.send(`/p/${slug}/api/comments`, { method: "POST", headers: { ...json, cookie }, body: `{"body":"${token}"` }),
  );
  // Exception channels: management calls carrying secrets where an id, a root or a label belongs.
  for (const [method, params] of [
    ["revokeAccess", { grantId: grant }],
    ["revokeAccess", { grantId: token }],
    ["attach", { root: `/nonexistent/${token}` }],
    ["issueAccess", { label: `\u0001${grant}` }],
    ["present", { project: token, viewId: grant }],
  ] as const) {
    try {
      await s.call(method, params);
      statuses[`socket-${method}`] = 0;
    } catch {
      statuses[`socket-${method}`] = -1;
    }
  }
  // Client telemetry, as the page's console capture and request tracker post it (a grant may post).
  const batch = {
    session: "0123456789abcdef",
    page: "/projects/x/",
    build: "test",
    events: [
      {
        at: new Date().toISOString(),
        type: "error",
        code: "ui.console-error",
        msg: `failed ${origin}/projects/${slug}/?token=${grant} with Bearer ${token}`,
      },
      {
        at: new Date().toISOString(),
        type: "error",
        code: "ui.console-error",
        msg: `pairing failed: code=${code}`,
        data: { pairing: code, pairingCode: code },
      },
      {
        at: new Date().toISOString(),
        type: "request",
        code: "ui.request",
        msg: "GET",
        data: {
          url: `/${token}/p/${slug}/api/diagrams`,
          headers: { authorization: `Bearer ${grant}` },
          note: `code=${code}`,
        },
      },
    ],
  };
  await note(
    "client-events",
    s.send(`/-/debug/events`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify(batch) }),
  );
  // A pairing success last (it spends the code; the refusals above stay under the rate limits).
  const paired = await note(
    "pair-success",
    s.send(`/-/pair`, { method: "POST", headers: json, body: JSON.stringify({ code }) }),
  );
  await note("paired-cookie", s.send(`/api/projects`, { headers: { cookie: cookieOf(paired) ?? "" } }));
  return statuses;
}

/** Every channel a person or agent can read evidence from: the service log and each debug download. */
async function collect(s: Seeded): Promise<Record_[]> {
  const owner = { authorization: `Bearer ${s.token}` };
  const download = async (path: string): Promise<unknown> => {
    const reply = await s.send(path, { headers: owner });
    if (reply.status !== 200) throw new Error(`${path}: ${reply.status}`);
    return JSON.parse(reply.body) as unknown;
  };
  return [
    ...lineRecords("service-log", s.serviceLog),
    ...jsonRecords("debug-log", await download("/-/debug/log?limit=1000")),
    ...jsonRecords("debug-events", await download("/-/debug/events?limit=1000")),
    ...jsonRecords("debug-metrics", await download("/-/debug/metrics")),
    ...jsonRecords("debug-health", await download("/-/debug/health")),
  ];
}

const CHANNELS = ["service-log", "debug-log", "debug-events", "debug-metrics", "debug-health"] as const;

describe("the scanner (seeded checks)", () => {
  const secrets: Secret[] = [
    { kind: "service-token", value: "0123456789abcdef0123456789abcdef" },
    { kind: "grant", value: "fedcba9876543210fedcba9876543210" },
    { kind: "pairing-code", value: "ABCD-EFGH" },
    { kind: "ca-key-path", value: "/tmp/archer-x/tls/ca/ca-key.pem" },
    {
      kind: "ca-key",
      value: `-----BEGIN PRIVATE KEY-----\n${"MIIEvQIBADANBgkqhkiG9w0BAQEFAASC".repeat(4)}\n-----END PRIVATE KEY-----\n`,
    },
  ];

  test("a planted line of every form of every secret is found, form by form, on its line", () => {
    const planted = secrets.flatMap(needles).map((n) => `[archer] planted ${n.kind} ${n.form}: x${n.text}y`);
    const hits = scan(lineRecords("planted", planted), secrets);
    const wanted = secrets.flatMap(needles);
    for (const [i, needle] of wanted.entries())
      expect(
        hits.some((hit) => hit.kind === needle.kind && hit.form === needle.form && hit.location === `line ${i + 1}`),
        `${needle.kind}/${needle.form}`,
      ).toBe(true);
    // Every kind is planted in a raw, an encoded and (tokens, codes) a base64 and a prefix form.
    for (const kind of ["service-token", "grant", "pairing-code"] as const)
      for (const form of ["raw", "url-encoded", "percent-every-byte", "base64", "base64url", "prefix-8"] as const)
        expect(
          wanted.some((n) => n.kind === kind && n.form === form),
          `${kind}/${form}`,
        ).toBe(true);
  });

  test("a planted JSON field and key are found by path; a redacted copy and unrelated text are not", () => {
    const value = {
      entries: [
        { msg: `GET /?token=${secrets[0]!.value}` },
        { data: { [secrets[1]!.value]: 1 } },
        { msg: "GET /?token=[redacted]" },
      ],
    };
    expect(described(scan(jsonRecords("planted", value), secrets))).toEqual([
      "planted $.entries[0].msg <redacted:service-token>/prefix-8",
      "planted $.entries[0].msg <redacted:service-token>/raw",
      "planted $.entries[0].msg <redacted:service-token>/url-encoded",
      "planted $.entries[1].data{key #0} <redacted:grant>/prefix-8",
      "planted $.entries[1].data{key #0} <redacted:grant>/raw",
      "planted $.entries[1].data{key #0} <redacted:grant>/url-encoded",
    ]);
    // A location never spells the secret, even when a key is the secret.
    expect(described(scan(jsonRecords("planted", value), secrets)).join("\n")).not.toContain(
      secrets[1]!.value.slice(0, 8),
    );
    expect(
      scan(
        lineRecords("clean", ["[archer] service: serving https://127.0.0.1:1/<token>/", "GET /?token=[redacted] 404"]),
        secrets,
      ),
    ).toEqual([]);
  });
});

describe("P12 on a seeded HTTPS debug service", () => {
  let s: Seeded;
  let records: Record_[];
  let statuses: Record<string, number>;
  beforeAll(async () => {
    s = await seeded();
    statuses = await exercise(s);
    records = await collect(s);
  }, 60_000);
  afterAll(async () => {
    s?.close();
    await cleanUp();
  });

  test("the probes ran: successes admitted, refusals refused", () => {
    expect(statuses).toMatchObject({
      "owner-exchange": 303,
      "owner-cookie": 200,
      "grant-query-exchange": 303,
      cookie: 200,
      bearer: 200,
      "owner-debug-bearer": 200,
      "client-events": 200,
      "pair-success": 303,
      "paired-cookie": 200,
    });
    for (const refused of [
      "owner-token-path",
      "wrong-token-path",
      "encoded-token-path",
      "upper-token-path",
      "bearer-wrong",
      "cookie-wrong",
      "pair-wrong",
      "pair-malformed",
      "debug-log-as-grant",
    ])
      expect(statuses[refused], refused).toBeGreaterThanOrEqual(400);
    // The planted control holds on the real channels: one planted line among them is found.
    const planted = [...records, { channel: "service-log", location: "planted", text: `[archer] planted ${s.token}` }];
    expect(described(scan(planted, s.secrets))).toContain("service-log planted <redacted:service-token>/raw");
  });

  test.each(CHANNELS)("%s: no seeded secret in any form", (channel) => {
    const inChannel = records.filter((record) => record.channel === channel);
    expect(inChannel.length, `${channel} collected nothing`).toBeGreaterThan(0);
    expect(described(scan(inChannel, s.secrets))).toEqual([]);
  });
});

/**
 * The gaps security round 1 found (C-06/X-03, C-07/X-04), each a probe of its own on one service: the
 * hits it adds to the channels. Each probe's response is checked first so a broken probe cannot pass.
 */
describe("P12 round 1 gaps (R9), closed", () => {
  let s: Seeded;
  let cookie = "";
  beforeAll(async () => {
    s = await seeded();
    cookie = cookieOf(await s.send(`/projects/${s.slug}/?token=${s.grant}`)) ?? "";
    if (cookie === "") throw new Error("no grant cookie");
  }, 60_000);
  afterAll(async () => {
    s?.close();
    await cleanUp();
  });

  /** The hits `probe` adds, as safe descriptions. */
  const added = async (probe: () => Promise<void>): Promise<string[]> => {
    const before = new Set(described(scan(await collect(s), s.secrets)));
    await probe();
    return described(scan(await collect(s), s.secrets)).filter((hit) => !before.has(hit));
  };
  const clientEvent = (msg: string, data?: unknown) => async () => {
    const batch = {
      session: "0123456789abcdef",
      page: "/projects/x/",
      build: "test",
      events: [
        {
          at: new Date().toISOString(),
          type: "error",
          code: "ui.console-error",
          msg,
          ...(data === undefined ? {} : { data }),
        },
      ],
    };
    const reply = await s.send(`/-/debug/events`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: s.origin, cookie },
      body: JSON.stringify(batch),
    });
    expect(reply.status).toBe(200);
  };

  test("control: a probe that adds nothing secret adds no hit", async () => {
    expect(
      await added(async () => void expect((await s.send(`/projects/${s.slug}/?token=${s.grant}`)).status).toBe(303)),
    ).toEqual([]);
  });

  // Fixed (D-2, C-07/X-04): redactText hides a pairing code standing alone (`XXXX-XXXX`, or 8 code
  // characters with a digit), a typed code under any query name, a `code` field holding one, and any
  // base64 or base64url run that decodes to a token or a code (telemetry/redact.ts, and the page's copy).
  test("a pairing code in the URL path is not kept in the debug log", async () => {
    expect(await added(async () => void expect((await s.send(`/${s.code}`)).status).toBe(404))).toEqual([]);
  });

  test("a pairing code under an unlisted query name is not kept in the debug log", async () => {
    expect(await added(async () => void expect((await s.send(`/?pair=${s.code}`)).status).toBe(404))).toEqual([]);
  });

  test("a pairing code in a client console message is not kept", async () => {
    expect(await added(clientEvent(`pairing code ${s.code} rejected`))).toEqual([]);
  });

  test("a base64 service token in a client console message is not kept", async () => {
    expect(await added(clientEvent(`auth header Basic ${b64(`owner:${s.token}`)}`))).toEqual([]);
  });

  test("a base64 grant and a base64 pairing code in client event data are not kept", async () => {
    expect(
      await added(
        clientEvent("encoded", {
          encoded: b64(s.grant),
          url: `/x/${Buffer.from(s.grant).toString("base64url")}`,
          pairing: b64(s.code),
        }),
      ),
    ).toEqual([]);
  });

  test("a pairing code in a client event's `code` field is not kept", async () => {
    expect(await added(clientEvent("pairing failed", { code: s.code }))).toEqual([]);
  });

  // Fixed (D-1, C-06/X-03): routePattern keeps only the API and debug names the service serves; any other
  // name is `:other`, and Telemetry redacts the route before it becomes a log field or a metrics key.
  test("a token in the API-name slot of a project route is not kept (route field, metrics key)", async () => {
    expect(
      await added(
        async () =>
          void expect(
            (await s.send(`/p/${s.slug}/api/${s.token}`, { headers: { cookie } })).status,
          ).toBeGreaterThanOrEqual(400),
      ),
    ).toEqual([]);
  });

  test("a grant in the API-name slot of an unauthenticated request is not kept (metrics key)", async () => {
    expect(await added(async () => void expect((await s.send(`/api/${s.grant}`)).status).toBe(404))).toEqual([]);
  });

  test("a token as a debug route name is not kept (metrics key prefix)", async () => {
    expect(await added(async () => void expect((await s.send(`/-/debug/${s.token}`)).status).toBe(404))).toEqual([]);
  });

  // Fixed (D-1): metrics need the service token; a loopback peer with no credential, or a grant, gets the bare 404.
  test("metrics, which hold the route keys, answer only the service token", async () => {
    expect((await s.send("/-/debug/metrics")).status).toBe(404);
    expect((await s.send("/-/debug/metrics", { headers: { cookie } })).status).toBe(404);
    expect((await s.send("/-/debug/metrics", { headers: { authorization: `Bearer ${s.grant}` } })).status).toBe(404);
    expect((await s.send("/-/debug/metrics", { headers: { authorization: `Bearer ${s.token}` } })).status).toBe(200);
  });

  test("a token in a page path is not kept (projects/:project/*)", async () => {
    expect(
      await added(
        async () =>
          void expect(
            (await s.send(`/projects/${s.slug}/${s.token}`, { headers: { cookie } })).status,
          ).toBeGreaterThanOrEqual(200),
      ),
    ).toEqual([]);
  });
});

/**
 * The residuals re-score 1 found (X-04, C-29), on a service whose pairing code is issued and unspent: a
 * code percent-encoded (every byte or in part) in a URL path, and a truncated base64url service token.
 * A spelling the scanner has no form for is checked directly, in every collected channel.
 */
describe("P12 re-score 1 gaps (R9), closed", () => {
  let s: Seeded;
  beforeAll(async () => {
    s = await seeded();
  }, 60_000);
  afterAll(async () => {
    s?.close();
    await cleanUp();
  });

  const added = async (probe: () => Promise<void>): Promise<string[]> => {
    const before = new Set(described(scan(await collect(s), s.secrets)));
    await probe();
    return described(scan(await collect(s), s.secrets)).filter((hit) => !before.has(hit));
  };
  /** The channels (by name only) whose collected text holds `spelling`. */
  const holding = async (spelling: string): Promise<string[]> => [
    ...new Set(
      (await collect(s))
        .filter((record) => record.text.includes(spelling))
        .map((record) => `${record.channel} ${record.location}`),
    ),
  ];
  const get = (path: string) => async () => void expect((await s.send(path)).status).toBe(404);

  test("an issued code percent-encoded byte by byte in the URL path is not kept (lower- and upper-case hex)", async () => {
    expect(await added(get(`/${enc(s.code)}`))).toEqual([]);
    expect(await added(get(`/${enc(s.code).toUpperCase()}`))).toEqual([]);
  });

  test("an issued code encoded in part (its dash, its first character, after an encoded slash) is not kept", async () => {
    const spellings = [
      s.code.replace("-", "%2D"),
      `%${s.code.charCodeAt(0).toString(16)}${s.code.slice(1)}`,
      `x%2F${s.code}`,
    ];
    for (const spelling of spellings) {
      await get(`/${spelling}`)();
      expect(await holding(spelling), "the spelling sent").toEqual([]);
    }
    expect(await holding(s.code.replace("-", ""))).toEqual([]);
    expect(described(scan(await collect(s), s.secrets))).toEqual([]);
  });

  test("a truncated base64url service token in the URL path is not kept (C-29)", async () => {
    const prefix = Buffer.from(s.token, "utf8").toString("base64url").slice(0, 40);
    await get(`/${prefix}`)();
    expect(await holding(prefix.slice(0, 16))).toEqual([]);
  });

  test("the code is still unspent after the probes: it redeems", async () => {
    expect(
      (
        await s.send(`/-/pair`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: s.origin },
          body: JSON.stringify({ code: s.code }),
        })
      ).status,
    ).toBe(303);
  });
});

/**
 * The residuals re-score 2 found (C-34, X-04), on a service whose pairing code is issued and unspent:
 * truncated hex credentials and respelled codes in a URL path or query. A request is logged by its route
 * (`/:other`, `/:token/projects/`), never its path or query, so no spelling of what was sent is kept.
 */
describe("P12 re-score 2 gaps (R9), closed", () => {
  let s: Seeded;
  beforeAll(async () => {
    s = await seeded();
  }, 60_000);
  afterAll(async () => {
    s?.close();
    await cleanUp();
  });

  /** The channels (by name only) whose collected text holds `spelling`, in either case. */
  const holding = async (spelling: string): Promise<string[]> => [
    ...new Set(
      (await collect(s))
        .filter((record) => record.text.toLowerCase().includes(spelling.toLowerCase()))
        .map((record) => `${record.channel} ${record.location}`),
    ),
  ];
  const sent = async (path: string): Promise<void> =>
    void expect((await s.send(path)).status).toBeGreaterThanOrEqual(300);

  test("a truncated owner token (12, 20 and 31 hex digits) in the URL path is not kept (C-34)", async () => {
    for (const length of [12, 20, 31]) await sent(`/${s.token.slice(0, length)}/projects/`);
    expect(await holding(s.token.slice(0, 8))).toEqual([]);
  });

  test("a truncated grant in a project path or an unlisted query name is not kept (C-34)", async () => {
    await sent(`/p/${s.grant.slice(0, 16)}/api/diagrams`);
    await sent(`/projects/?tok=${s.grant.slice(4, 24)}`);
    expect(await holding(s.grant.slice(0, 8))).toEqual([]);
    expect(await holding(s.grant.slice(4, 12))).toEqual([]);
  });

  test("an issued code spelled with %20, an en dash, an em dash, no dash or in lower case is not kept (C-34, X-04)", async () => {
    const [head, tail] = s.code.split("-") as [string, string];
    const spellings = [
      `${head}%20${tail}`,
      `${head}%E2%80%93${tail}`,
      `${head}%E2%80%94${tail}`,
      `${head}${tail}`,
      `${head}${tail}`.toLowerCase(),
      `${head}+${tail}`,
    ];
    for (const spelling of spellings) await sent(`/${spelling}`);
    // Each spelling as sent and as decoded (a space, an en or em dash); `holding` ignores case.
    for (const spelling of [...spellings, `${head} ${tail}`, `${head}\u2013${tail}`, `${head}\u2014${tail}`])
      expect(await holding(spelling), "a spelling sent").toEqual([]);
  });

  test("the live token cut short and the live code respelled in client events are not kept (C-34, X-04)", async () => {
    const cookie = cookieOf(await s.send(`/projects/${s.slug}/?token=${s.grant}`)) ?? "";
    expect(cookie).not.toBe("");
    const [head, tail] = s.code.split("-") as [string, string];
    const spellings = [
      s.token.slice(0, 8),
      s.token.slice(0, 12).toUpperCase(),
      s.token.slice(0, 31),
      `${head}${tail}`.toLowerCase(),
      `${head} ${tail}`.toLowerCase(),
      `${head}\u2013${tail}`,
      `${head}\u2014${tail}`,
    ];
    const event = (msg: string, data?: unknown) => ({
      at: new Date().toISOString(),
      type: "error",
      code: "ui.console-error",
      msg,
      ...(data === undefined ? {} : { data }),
    });
    const batch = {
      session: "0123456789abcdef",
      page: "/projects/x/",
      build: "test",
      events: spellings.map((spelling) =>
        event(`retry with ${spelling} failed`, { typed: spelling, nested: { url: `/x/${spelling}/y` } }),
      ),
    };
    const reply = await s.send(`/-/debug/events`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: s.origin, cookie },
      body: JSON.stringify(batch),
    });
    expect(reply.status).toBe(200);
    for (const spelling of [...spellings, `${head}${tail}`])
      expect(await holding(spelling), "a spelling posted").toEqual([]);
  });

  test("the request lines still name the route", async () => {
    const owner = { authorization: `Bearer ${s.token}` };
    const log = JSON.parse((await s.send("/-/debug/log?code=svc.request&limit=1000", { headers: owner })).body) as {
      entries: { msg: string; route: string }[];
    };
    expect(log.entries.length).toBeGreaterThan(0);
    for (const entry of log.entries) expect(entry.msg.startsWith(`GET ${entry.route} `), entry.route).toBe(true);
  });

  test("the code is still unspent after the probes: it redeems", async () => {
    expect(
      (
        await s.send(`/-/pair`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: s.origin },
          body: JSON.stringify({ code: s.code }),
        })
      ).status,
    ).toBe(303);
  });
});

/**
 * The residual re-score 3 found (C-35, X-04): a grant's secret cut to 9–15 hex digits, written by the
 * grant's own holder into a page event's free text. The service stores only a grant's verifier, so no
 * redactor can know that prefix; instead, page events from anyone but the owner keep their code and
 * structured fields but no free text: every string becomes its length (R9).
 */
describe("P12 re-score 3 gaps (R9), closed", () => {
  let s: Seeded;
  beforeAll(async () => {
    s = await seeded();
  }, 60_000);
  afterAll(async () => {
    s?.close();
    await cleanUp();
  });

  const added = async (probe: () => Promise<void>): Promise<string[]> => {
    const before = new Set(described(scan(await collect(s), s.secrets)));
    await probe();
    return described(scan(await collect(s), s.secrets)).filter((hit) => !before.has(hit));
  };
  /** The channels (by name only) whose collected text holds `spelling`, in either case. */
  const holding = async (spelling: string): Promise<string[]> => [
    ...new Set(
      (await collect(s))
        .filter((record) => record.text.toLowerCase().includes(spelling.toLowerCase()))
        .map((record) => `${record.channel} ${record.location}`),
    ),
  ];
  const json = () => ({ "content-type": "application/json", origin: s.origin });
  const post = async (
    headers: Record<string, string>,
    events: unknown[],
    batch: Record<string, string> = {},
  ): Promise<void> => {
    const body = JSON.stringify({
      session: "0123abcd-4567ef01",
      page: "/projects/x/",
      build: "test",
      ...batch,
      events,
    });
    expect((await s.send(`/-/debug/events`, { method: "POST", headers, body })).status).toBe(200);
  };
  const event = (code: string, msg: string, data: unknown) => ({
    at: new Date().toISOString(),
    type: "error",
    code,
    msg,
    data,
  });
  const clientEntries = async (code: string): Promise<{ code: string; msg: string; data: Record<string, unknown> }[]> =>
    (
      JSON.parse(
        (await s.send(`/-/debug/events?code=${code}&limit=1000`, { headers: { authorization: `Bearer ${s.token}` } }))
          .body,
      ) as { entries: { code: string; msg: string; data: Record<string, unknown> }[] }
    ).entries;

  test("a grant's 9-, 12- and 15-hex prefixes in a grant's page events are kept nowhere", async () => {
    const cookie = cookieOf(await s.send(`/projects/${s.slug}/?token=${s.grant}`)) ?? "";
    expect(cookie).not.toBe("");
    const prefixes = [9, 12, 15].map((length) => s.grant.slice(0, length));
    const hits = await added(() =>
      post(
        { ...json(), cookie },
        prefixes.map((prefix) =>
          event("ui.console-error", `probe ${prefix}`, {
            detail: `probe ${prefix}`,
            nested: { list: [prefix, prefix.toUpperCase()] },
            line: 12,
            ok: true,
          }),
        ),
        { page: `/projects/${prefixes[2]}/`, build: prefixes[1]! },
      ),
    );
    expect(hits).toEqual([]);
    for (const prefix of prefixes) expect(await holding(prefix), `a ${prefix.length}-hex prefix`).toEqual([]);
    // Positive control: the events were kept, by code and with their structure; each string is its length.
    const kept = await clientEntries("ui.console-error");
    expect(kept).toHaveLength(3);
    expect(kept[0]).toMatchObject({
      code: "ui.console-error",
      msg: "<text:15>",
      data: {
        page: "<text:26>",
        build: "<text:12>",
        type: "error",
        data: { detail: "<text:15>", nested: { list: ["<text:9>", "<text:9>"] }, line: 12, ok: true },
      },
    });
  });

  test("a code, type, key or number written to carry a prefix is replaced too", async () => {
    const cookie = cookieOf(await s.send(`/projects/${s.slug}/?token=${s.grant}`)) ?? "";
    const prefix = s.grant.slice(0, 12);
    const digits = Number.parseInt(s.grant.slice(0, 12), 16);
    const hits = await added(() =>
      post(
        { ...json(), cookie },
        [
          {
            at: new Date().toISOString(),
            type: `t${prefix}`,
            code: `ui.${prefix}`,
            msg: "",
            data: { [prefix]: 1, [`k-${prefix.toUpperCase()}`]: 2, n: digits, small: 1200 },
          },
        ],
        { session: prefix },
      ),
    );
    expect(hits).toEqual([]);
    expect(await holding(prefix)).toEqual([]);
    expect(await holding(String(digits))).toEqual([]);
    const [kept] = await clientEntries("ui.other");
    expect(kept).toMatchObject({
      code: "ui.other",
      data: {
        session: expect.stringMatching(/^anon-[0-9a-f]{12}$/),
        type: "other",
        data: { n: expect.stringMatching(/^<number:\d+>$/), small: 1200 },
      },
    });
    expect(
      Object.keys(kept!.data.data as object).filter((key) => key.toLowerCase().includes(prefix.slice(0, 8))),
    ).toEqual([]);
  });

  test("a session in the page's own shape, an 8-digit number or a chosen time made from a grant is kept nowhere (re-score 4)", async () => {
    const cookie = cookieOf(await s.send(`/projects/${s.slug}/?token=${s.grant}`)) ?? "";
    const first = s.grant.slice(0, 8),
      second = s.grant.slice(8, 16);
    const decimal = 12_345_678 + (Number.parseInt(first, 16) % 87_654_321); // eight digits, from the grant
    const chosen = Date.UTC(2001, 0, 1) + Number.parseInt(first.slice(0, 6), 16);
    const before = Date.now();
    const hits = await added(() =>
      post(
        { ...json(), cookie },
        [{ at: chosen, type: "error", code: "ui.session-probe", msg: "", data: { count: decimal, ms: 1234.5, n: 7 } }],
        { session: `${first}-${second}` },
      ),
    );
    expect(hits).toEqual([]);
    for (const text of [first, second, String(decimal)]) expect(await holding(text), text).toEqual([]);
    const [kept] = (
      JSON.parse(
        (
          await s.send(`/-/debug/events?code=ui.session-probe&limit=10`, {
            headers: { authorization: `Bearer ${s.token}` },
          })
        ).body,
      ) as { entries: { at: string; data: { session: string; data: Record<string, unknown> } }[] }
    ).entries;
    expect(kept!.data.session).toMatch(/^anon-[0-9a-f]{12}$/);
    expect(kept!.data.data).toEqual({ count: "<number:8>", ms: 1234.5, n: 7 });
    expect(Date.parse(kept!.at)).toBeGreaterThanOrEqual(before - 1000);
    // The same page load keeps one mark, so its events still group.
    await post({ ...json(), cookie }, [{ at: chosen, type: "error", code: "ui.session-probe", msg: "" }], {
      session: `${first}-${second}`,
    });
    const marks = (
      JSON.parse(
        (
          await s.send(`/-/debug/events?code=ui.session-probe&limit=10`, {
            headers: { authorization: `Bearer ${s.token}` },
          })
        ).body,
      ) as { entries: { data: { session: string } }[] }
    ).entries.map((entry) => entry.data.session);
    expect(new Set(marks).size).toBe(1);
  });

  test("a paired device's page events keep no text either", async () => {
    const pairing = (await s.call("issuePairingCode", {})) as { code: string };
    const paired =
      cookieOf(
        await s.send(`/-/pair`, { method: "POST", headers: json(), body: JSON.stringify({ code: pairing.code }) }),
      ) ?? "";
    expect(paired).not.toBe("");
    const prefix = s.grant.slice(0, 15);
    expect(
      await added(() =>
        post({ ...json(), cookie: paired }, [event("ui.fetch-failed", `paired ${prefix}`, { detail: prefix })]),
      ),
    ).toEqual([]);
    expect(await holding(prefix)).toEqual([]);
    expect((await clientEntries("ui.fetch-failed"))[0]).toMatchObject({
      msg: `<text:${prefix.length + 7}>`,
      data: { data: { detail: `<text:${prefix.length}>` } },
    });
  });

  test("control: the owner's own page events keep readable text, still redacted", async () => {
    await post({ authorization: `Bearer ${s.token}`, "content-type": "application/json" }, [
      event("ui.page-error", "owner readable probe", { detail: "Cannot read properties of undefined", token: s.token }),
    ]);
    const [kept] = await clientEntries("ui.page-error");
    expect(kept).toMatchObject({
      msg: "owner readable probe",
      data: { page: "/projects/x/", data: { detail: "Cannot read properties of undefined", token: "[redacted]" } },
    });
  });
});

test("no issued code is digits only, so an 8-digit number stays readable; the code redacts bare and redeems (X-04)", () => {
  // Eight 5-bit groups below 10 are eight digits (1 2 3 4 5 6 7 8): that draw is drawn again.
  const bits = [1, 2, 3, 4, 5, 6, 7, 8].reduce((value, group) => value * 32 + group, 0);
  const draws = [bits, bits, 0x0123456789];
  const random = (bytes: number): Buffer => {
    const out = Buffer.alloc(bytes);
    out.writeUIntBE(draws.shift() ?? 0, 0, 5);
    return out;
  };
  const codes = new PairingCodes({ random });
  const { code } = codes.issue(5);
  expect(code).toMatch(/[A-Z]/);
  const bare = code.replace("-", "");
  for (const text of [
    `pair ${code}`,
    `GET /${code} 404`,
    `GET /${enc(code)} 404`,
    `code=${code}`,
    `pair ${bare}`,
    `pair ${bare.toLowerCase()}`,
    `GET /${enc(bare)} 404`,
  ]) {
    const out = redactText(text);
    expect(out).not.toContain(bare.slice(0, 4));
    expect(out).not.toContain(enc(code));
  }
  expect(redactText("pair 12345678, size 10485760")).toBe("pair 12345678, size 10485760");
  expect(codes.redeem(bare.toLowerCase(), () => true).ok).toBe(true);
});
