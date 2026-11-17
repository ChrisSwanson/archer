// Response headers and credential exchanges on a real TLS service (security rubric G4, G5, R2;
// probes P3, P4), through the same checks as tools/devkit/security/headers.mjs.
//
// What holds today is asserted. What fails today is pinned with `test.fails`, named by its rubric
// row, so CI stays green while the finding is open and turns red when the product changes (then move
// the predicate into the passing set). The tool itself is proven first: a hardened snapshot passes
// every predicate, and a seeded snapshot (a header removed, a cookie attribute weakened, a token left
// in a Location) fails exactly the predicates it should.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { collect, evaluate } from "../../../tools/devkit/security/headers-model.mjs";
import { connectService } from "../../src/service/service-client.ts";
import { startService, type RunningService } from "../../src/service/service.ts";
import { project, slugOf } from "../service/support.ts";

interface Result {
  readonly row: string;
  readonly predicate: string;
  readonly class: string;
  readonly pass: boolean;
  readonly observed: unknown;
}
type Snapshot = {
  https: boolean;
  classes: Record<string, { status: number; headers: Record<string, unknown> }>;
  exchanges: Record<
    string,
    { status: number; headers: Record<string, unknown>; location?: string; next?: { status: number } | null }
  >;
  refusals: Record<string, { status: number; headers: Record<string, unknown> }>;
};

const PAGE =
  '<!doctype html><html><head><!-- <script>not a script</script> --><script type="module">globalThis.a = "<script>";\r\n</script></head><body>Archer page<script src="x.js"></script><SCRIPT>b()</SCRIPT></body></html>';
const sha = (text: string): string => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
let dir = "",
  svc: RunningService | undefined,
  snapshot: Snapshot,
  results: Result[],
  origin = "",
  ca: Buffer;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "archer-sec-headers-"));
  const tlsCert = join(dir, "cert.pem"),
    tlsKey = join(dir, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      tlsKey,
      "-out",
      tlsCert,
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore", timeout: 10_000 },
  );
  const pagePath = join(dir, "page.html");
  // Two inline scripts, one with CR LF (the browser hashes it with LF), and one external script that gets no hash.
  writeFileSync(pagePath, PAGE);
  const state = join(dir, "state");
  svc = await startService({
    tlsCert,
    tlsKey,
    pagePath,
    stateDir: state,
    socketPath: join(state, "archer.sock"),
    warmStart: false,
    prefetchThumbnails: false,
    log: () => {},
    env: {
      HOME: dir,
      XDG_CONFIG_HOME: join(dir, ".config"),
      ARCHER_HOME: join(dir, ".archer"),
      ARCHER_OPEN_BROWSER: "never",
      ARCHER_DEBUG: "1",
    },
  });
  const root = project();
  const client = await connectService(svc.socketPath);
  try {
    const attached = await client.call("attach", { root });
    const grant = await client.call("issueAccess", { label: "headers" });
    const pairing = await client.call("issuePairingCode", {});
    origin = new URL(attached.url).origin;
    ca = readFileSync(tlsCert);
    const slug = slugOf(attached.url);
    const { cookiePair, send } = await import("../../../tools/devkit/security/lib/client.mjs");
    // The owner's browser: its link's token exchanged once for the session cookie.
    const cookie = cookiePair(await send(attached.url, { ca }));
    if (cookie === null) throw new Error("the agent link set no cookie");
    const inventory = JSON.parse(
      (await send(`${origin}/p/${slug}/api/diagrams`, { ca, headers: { cookie } })).body,
    ) as { views: { id: string; modelRevision?: string }[] };
    const view = inventory.views.find((v) => v.modelRevision !== undefined);
    snapshot = (await collect({
      origin,
      ca,
      grantToken: grant.token,
      ownerToken: svc.token,
      pairingCode: pairing.code,
      slug,
      view: view?.id,
      revision: view?.modelRevision,
    })) as Snapshot;
    results = evaluate(snapshot) as Result[];
  } finally {
    client.close();
  }
}, 60_000);

afterAll(async () => {
  await svc?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The predicates v0.8.0 fails, by rubric row (each is a candidate finding in the round's report). */
const KNOWN_FAILING: Readonly<Record<string, (r: Result) => boolean>> = {
  "R2 (L3): no COOP or CORP": (r) => r.row === "R2 (L3)" && r.predicate.startsWith("Cross-Origin-"),
};
/**
 * Approved exceptions, by id: EX-S1-01 (D3, 2026-10-31) — hashed, immutable page assets and thumbnails
 * keep a year-long private cache (the address names one build or one drawing exactly); the page and every API
 * answer are no-store. EX-S1-05 (D6, 2026-10-31; C-25) — no HSTS when the Host is a `localhost` name
 * (`localhost`, `*.localhost`) only, so one HTTPS sandbox cannot pin every local plain-HTTP dev server; those
 * names are loopback-only, so nothing is left to downgrade. IP literals and real names get HSTS.
 */
const IMMUTABLE = "private, max-age=31536000, immutable",
  PAGE_SHELL = "private, no-cache";
/** The class-name prefix of a response asked for under a `localhost` Host (EX-S1-05's scope). */
const LOCALHOST_NAME = "localhost name: ";
const EXCEPTIONS: Readonly<Record<string, (r: Result) => boolean>> = {
  "EX-S1-01": (r) =>
    r.predicate === "Cache-Control: no-store (authenticated)" &&
    (((r.class === "thumbnail" || r.class === "page asset") && r.observed === IMMUTABLE) ||
      // Extended by D8 (2026-10-31): the page shell at its clean address revalidates on every load (one build, no project data or secret).
      (r.class === "page (clean address, cookie)" && r.observed === PAGE_SHELL)),
  "EX-S1-05": (r) =>
    r.predicate === "HSTS (Strict-Transport-Security)" && r.class.startsWith(LOCALHOST_NAME) && r.observed === null,
};
const knownFailing = (r: Result): boolean =>
  [...Object.values(KNOWN_FAILING), ...Object.values(EXCEPTIONS)].some((match) => match(r));

test("every other G4, G5 and R2 predicate holds on every response class and exchange", () => {
  expect(Object.keys(snapshot.classes).length).toBeGreaterThanOrEqual(11);
  expect(Object.keys(snapshot.exchanges)).toEqual(["grant ?token=", "owner ?token=", "pairing"]);
  const failing = results
    .filter((r) => !r.pass && !knownFailing(r))
    .map((r) => `${r.row} ${r.predicate} — ${r.class}: ${String(r.observed)}`);
  expect(failing).toEqual([]);
  // The passing set is not empty by accident: the cookie, the exchange and the refusals are checked.
  const passed = (predicate: string) => results.filter((r) => r.pass && r.predicate === predicate).map((r) => r.class);
  expect(passed("__Host- prefix")).toEqual(["grant ?token=", "owner ?token=", "pairing"]);
  expect(passed("SameSite=Strict")).toHaveLength(3);
  expect(passed("clean Location (no token)")).toHaveLength(3);
  // G4 (X-10, D5): every exchange, pairing included, is one 303.
  expect(passed("a 303")).toEqual(["grant ?token=", "owner ?token=", "pairing"]);
  expect(passed("refused (no cookie, no redirect)")).toEqual([
    "?token= with Authorization",
    "?token= on POST",
    "?token= twice",
    "service token in the path",
    "service token home",
  ]);
  // Every HTML class: the page, the refused-link page, the pairing form and the not-found page.
  const html = Object.values(snapshot.classes).filter((r) =>
    String(r.headers["content-type"] ?? "").startsWith("text/html"),
  ).length;
  expect(html).toBe(4);
  expect(passed("frame-ancestors 'none'").length).toBe(html);
  // G5 (C-03/X-06): every HTML class sets base-uri 'none'.
  expect(passed("base-uri 'none'").length).toBe(html);
  // R2 (C-09/X-08, H5): scripts run by the hash of each inline script actually served; no 'unsafe-eval', no 'unsafe-inline'.
  expect(passed("no 'unsafe-eval' in script-src").length).toBe(html);
  expect(passed("no 'unsafe-inline' in script-src (strict CSP)").length).toBe(html);
  const pageCsp = String(snapshot.classes["page (clean address, cookie)"]!.headers["content-security-policy"]);
  expect(pageCsp).toContain(`script-src ${sha('globalThis.a = "<script>";\n')} ${sha("b()")};`);
  for (const scriptless of ["refused-link page", "not-found page"])
    expect(String(snapshot.classes[scriptless]!.headers["content-security-policy"])).toContain("script-src 'none';");
  // G5/R2 (C-32): form-action is not covered by default-src, so every HTML class names it: 'self' where a
  // script runs (the pairing form posts to /-/pair), 'none' where none does.
  for (const [name, response] of Object.entries(snapshot.classes)) {
    const csp = String(response.headers["content-security-policy"] ?? "");
    if (!String(response.headers["content-type"] ?? "").startsWith("text/html")) continue;
    expect(csp, name).toMatch(/form-action '(self|none)'/);
    expect(csp.includes("script-src 'none'") ? "'none'" : "'self'", name).toBe(
      /form-action ('self'|'none')/.exec(csp)![1],
    );
  }
  expect(String(snapshot.classes["pairing form"]!.headers["content-security-policy"])).toContain("form-action 'self'");
  // R2 (X-09, D3, D8): every API answer is no-store; only EX-S1-01's classes are cached, the page shell revalidating.
  expect(snapshot.classes["page (clean address, cookie)"]!.headers["cache-control"]).toBe(PAGE_SHELL);
  expect(passed("Cache-Control: no-store (authenticated)")).toEqual(
    expect.arrayContaining(["not-found page", "api json", "api error json", "event stream", "authoring json"]),
  );
  expect(snapshot.classes["thumbnail"]!.headers["cache-control"]).toBe(IMMUTABLE);
  // R2 (C-08/X-07): HSTS on every HTTPS class; the bare 404 and debug JSON carry nosniff and Referrer-Policy.
  expect(passed("HSTS (Strict-Transport-Security)")).toHaveLength(Object.keys(snapshot.classes).length);
  expect(passed("Referrer-Policy set")).toEqual(expect.arrayContaining(["bare 404", "debug json"]));
  expect(passed("X-Content-Type-Options: nosniff")).toEqual(expect.arrayContaining(["bare 404", "debug json"]));
});

test("EX-S1-05: HSTS is left off for a localhost name only, so one HTTPS sandbox cannot upgrade every localhost dev server", async () => {
  const { send } = await import("../../../tools/devkit/security/lib/client.mjs");
  const port = new URL(origin).port;
  const named = await send(`https://localhost:${port}/nowhere`, { ca });
  expect(named.status).toBe(404);
  expect(named.headers["strict-transport-security"]).toBeUndefined();
  // The omission is exactly the approved exception: every other predicate on that answer holds.
  const local = evaluate({
    https: true,
    classes: { [`${LOCALHOST_NAME}bare 404`]: { status: named.status, headers: named.headers } },
    exchanges: {},
    refusals: {},
  }) as Result[];
  const hsts = local.filter((r) => r.predicate === "HSTS (Strict-Transport-Security)");
  expect(hsts.map((r) => r.pass)).toEqual([false]);
  expect(EXCEPTIONS["EX-S1-05"]!(hsts[0]!)).toBe(true);
  expect(local.filter((r) => !r.pass && !knownFailing(r))).toEqual([]);
  const literal = await send(`${origin}/nowhere`, { ca });
  expect(literal.headers["strict-transport-security"]).toBe("max-age=31536000");
});

for (const [name, match] of Object.entries(KNOWN_FAILING)) {
  // Fails while the product fails the predicate; once it holds, this turns red: move it to the passing set.
  test.fails(`open finding — ${name}`, () => {
    const hits = results.filter(match);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.filter((r) => !r.pass)).toEqual([]);
  });
}

/** The snapshot as a fully hardened service would answer, to prove every predicate can pass. */
function harden(source: Snapshot): Snapshot {
  const s = structuredClone(source);
  const fix = (h: Record<string, unknown>, html: boolean) => {
    Object.assign(h, {
      "strict-transport-security": "max-age=31536000",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
    });
    if (html)
      h["content-security-policy"] =
        "default-src 'none'; script-src 'sha256-abc'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
  };
  for (const [name, response] of Object.entries(s.classes)) fix(response.headers, /page|form/.test(name));
  return s;
}

test("the tool passes a hardened service: every predicate holds", () => {
  const hardened = evaluate(harden(snapshot)) as Result[];
  expect(hardened.filter((r) => !r.pass).map((r) => `${r.predicate} — ${r.class}`)).toEqual([]);
});

test("seeded: a removed header, a weakened cookie and a token left in a Location fail exactly their predicates", () => {
  const seeded = harden(snapshot);
  delete seeded.classes["api json"]!.headers["x-content-type-options"];
  seeded.classes["page (clean address, cookie)"]!.headers["content-security-policy"] =
    "default-src 'none'; script-src 'unsafe-eval'; base-uri 'none'";
  const cookie = (
    seeded.exchanges["grant ?token="]!.headers["set-cookie"] as { name: string; attributes: Record<string, unknown> }[]
  )[0]!;
  cookie.attributes["samesite"] = "Lax";
  cookie.attributes["domain"] = "example.test";
  seeded.exchanges["owner ?token="]!.location = "/projects/x/?token=0123456789abcdef0123456789abcdef";
  seeded.refusals["?token= on POST"] = { status: 303, headers: {} };
  const failed = (evaluate(seeded) as Result[])
    .filter((r) => !r.pass)
    .map((r) => `${r.predicate} — ${r.class}`)
    .sort();
  expect(failed).toEqual(
    [
      "SameSite=Strict — grant ?token=",
      "X-Content-Type-Options: nosniff — api json",
      "clean Location (no token) — owner ?token=",
      "frame-ancestors 'none' — page (clean address, cookie)",
      "no 'unsafe-eval' in script-src — page (clean address, cookie)",
      "no Domain — grant ?token=",
      "refused (no cookie, no redirect) — ?token= on POST",
    ].sort(),
  );
});
