// Response-header and credential-exchange checks (security rubric G4, G5, R2; probes P3 and P4),
// used by tools/devkit/security/headers.mjs and ts/test/security/headers.test.ts.
//
// `collect(target)` asks an Archer service for one response of each class (pages, refusal pages,
// assets, JSON, errors, the event stream, thumbnails, bare 404s, authoring and debug answers) and runs
// each credential exchange (grant `?token=`, owner `?token=`, pairing) and its refusals. `evaluate(snapshot)`
// turns the snapshot into one result per (rubric row, predicate, response class): {row, predicate,
// class, pass, observed}. Nothing secret is kept: header values that could carry one are redacted.
import { cookiePair, openStream, redact, send } from "./lib/client.mjs";

/** CSP text → {directive: [sources]}; the first occurrence of a directive wins (CSP3 §2.2.1). */
export function parseCsp(text) {
  const policy = {};
  for (const part of String(text ?? "").split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name && !(name.toLowerCase() in policy)) policy[name.toLowerCase()] = sources;
  }
  return policy;
}

/** The effective sources of a fetch directive: itself, else its fallback chain to default-src (CSP3 §6.8). */
function effective(policy, directive) {
  const chain = {
    "script-src": ["script-src", "default-src"],
    "object-src": ["object-src", "default-src"],
    "style-src": ["style-src", "default-src"],
  }[directive] ?? [directive];
  for (const name of chain) if (policy[name] !== undefined) return policy[name];
  return undefined;
}

/** `Set-Cookie` → {name, attributes (lower-cased names), value redacted}. */
export function parseCookie(header) {
  const [pair, ...attrs] = String(header)
    .split(";")
    .map((s) => s.trim());
  const name = pair.split("=", 1)[0];
  const attributes = {};
  for (const attr of attrs) {
    const [key, ...value] = attr.split("=");
    attributes[key.toLowerCase()] = value.join("=") || true;
  }
  return { name, attributes };
}

const SECRET = /[a-f0-9]{32}/;

/**
 * The response classes. `auth`: whether a credential admitted it (no-store applies). `type`: the
 * expected Content-Type prefix. `html`: a page that needs the G5 policy.
 */
export const CLASSES = {
  "page (clean address, cookie)": { auth: true, html: true, type: "text/html" },
  "refused-link page": { auth: false, html: true, type: "text/html" },
  "pairing form": { auth: false, html: true, type: "text/html" },
  "not-found page": { auth: true, html: true, type: "text/html" },
  "page asset": { auth: true, type: "text/javascript" },
  "api json": { auth: true, type: "application/json" },
  "api error json": { auth: true, type: "application/json" },
  "event stream": { auth: true, type: "text/event-stream" },
  thumbnail: { auth: true, type: "image/" },
  "authoring json": { auth: true, type: "application/json" },
  "debug json": { auth: false, type: "application/json" },
  "bare 404": { auth: false, type: null },
};

/** Keeps what the predicates need; secret-shaped values (cookies, locations) are redacted. */
function keep(response) {
  const headers = {};
  for (const [key, value] of Object.entries(response.headers ?? {}))
    headers[key] =
      key === "set-cookie"
        ? [].concat(value).map((c) => {
            const p = parseCookie(c);
            return { name: p.name, attributes: p.attributes };
          })
        : redact(Array.isArray(value) ? value.join(", ") : String(value));
  return { status: response.status, headers, ...(response.error ? { error: response.error } : {}) };
}

/**
 * One response of each class and the exchanges. `target`: {origin, ca, grantToken, ownerToken,
 * pairingCode?, slug, view, revision?, asset?}. The grant cookie comes from exchanging the grant.
 */
export async function collect(target) {
  const { origin, ca } = target;
  const get = (path, headers = {}, method = "GET") =>
    send(`${origin}${path}`, { ca, headers, method, ...(method === "GET" ? {} : { body: "" }) });
  const grantExchange = await get(`/projects/${target.slug}/?token=${target.grantToken}`);
  const cookie = cookiePair(grantExchange);
  const ownerExchange = await get(`/projects/${target.slug}/?token=${target.ownerToken}`);
  const withCookie = { cookie };
  const classes = {};
  classes["page (clean address, cookie)"] = await get(`/projects/${target.slug}/`, withCookie);
  classes["refused-link page"] = await get(`/projects/${target.slug}/`);
  classes["pairing form"] = await get("/");
  classes["not-found page"] = await get("/projects/no-such-project-here/", withCookie);
  if (target.asset) classes["page asset"] = await get(`/-/page-assets/${target.asset}`, withCookie);
  classes["api json"] = await get(`/p/${target.slug}/api/diagrams`, withCookie);
  classes["api error json"] = await get(`/p/${target.slug}/api/diagrams/no-such-view`, withCookie);
  const stream = await openStream(`${origin}/p/${target.slug}/api/events`, { ca, headers: withCookie });
  stream.close();
  classes["event stream"] = { status: stream.status, headers: stream.headers };
  if (target.revision) {
    // The first answer redirects to the address carrying the drawing version (`&v=`); the drawing is the class.
    const path = `/p/${target.slug}/api/thumbnails/${encodeURIComponent(target.view)}?rev=${encodeURIComponent(target.revision)}&theme=light`;
    const first = await get(path, withCookie);
    const location = first.headers.location;
    classes["thumbnail"] =
      first.status >= 300 && first.status < 400 && typeof location === "string"
        ? await send(new URL(location, `${origin}${path}`).href, { ca, headers: withCookie })
        : first;
  }
  classes["authoring json"] = await get(`/p/${target.slug}/api/authoring`, withCookie);
  classes["debug json"] = await get("/-/debug/health");
  classes["bare 404"] = await get("/nowhere");
  // P3: each exchange, its one hop, and the refusals.
  const hop = async (response, headers) => {
    const location = response.headers.location;
    if (typeof location !== "string") return null;
    const next = await get(location, headers);
    return { status: next.status };
  };
  const exchanges = {
    "grant ?token=": {
      ...keep(grantExchange),
      location: grantExchange.headers.location,
      next: await hop(grantExchange, withCookie),
    },
    "owner ?token=": {
      ...keep(ownerExchange),
      location: ownerExchange.headers.location,
      next: await hop(ownerExchange, { cookie: cookiePair(ownerExchange) }),
    },
  };
  if (target.pairingCode) {
    const paired = await send(`${origin}/-/pair`, {
      ca,
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ code: target.pairingCode }),
    });
    let location;
    try {
      location = JSON.parse(paired.body).location;
    } catch {
      /* not JSON */
    }
    exchanges["pairing"] = { ...keep(paired), location: paired.headers.location ?? location, bodyLocation: location };
  }
  const refusals = {
    "?token= with Authorization": keep(
      await get(`/projects/${target.slug}/?token=${target.grantToken}`, {
        authorization: `Bearer ${target.grantToken}`,
      }),
    ),
    "?token= on POST": keep(
      await get(
        `/projects/${target.slug}/?token=${target.grantToken}`,
        { origin, "content-type": "application/json" },
        "POST",
      ),
    ),
    "?token= twice": keep(await get(`/projects/${target.slug}/?token=${target.grantToken}&token=${target.grantToken}`)),
    // Retired in 0.15.0: the service token in the path is no credential, on a page or the home address.
    "service token in the path": keep(await get(`/${target.ownerToken}/projects/${target.slug}/`)),
    "service token home": keep(await get(`/${target.ownerToken}/`)),
  };
  const kept = {};
  for (const [name, response] of Object.entries(classes)) kept[name] = keep(response);
  for (const exchange of Object.values(exchanges))
    if (exchange.location)
      exchange.location = redact(
        exchange.location,
        new Map([
          [target.grantToken, "grant"],
          [target.ownerToken, "service-token"],
        ]),
      );
  return { https: origin.startsWith("https:"), classes: kept, exchanges, refusals };
}

/** Every predicate over a snapshot. */
export function evaluate(snapshot) {
  const results = [];
  const add = (row, predicate, cls, pass, observed) =>
    results.push({ row, predicate, class: cls, pass: Boolean(pass), observed: observed ?? null });
  for (const [cls, response] of Object.entries(snapshot.classes)) {
    const spec = CLASSES[cls] ?? {};
    const h = response.headers;
    if (response.status === 0) {
      add("R2", "answered", cls, false, response.error);
      continue;
    }
    if (snapshot.https)
      add(
        "R2",
        "HSTS (Strict-Transport-Security)",
        cls,
        h["strict-transport-security"] !== undefined,
        h["strict-transport-security"],
      );
    add(
      "R2",
      "X-Content-Type-Options: nosniff",
      cls,
      h["x-content-type-options"] === "nosniff",
      h["x-content-type-options"],
    );
    add(
      "R2",
      "Referrer-Policy set",
      cls,
      typeof h["referrer-policy"] === "string" && h["referrer-policy"] !== "unsafe-url",
      h["referrer-policy"],
    );
    if (spec.auth)
      add(
        "R2",
        "Cache-Control: no-store (authenticated)",
        cls,
        /\bno-store\b/.test(h["cache-control"] ?? ""),
        h["cache-control"],
      );
    if (spec.type)
      add("R2", "Content-Type correct", cls, (h["content-type"] ?? "").startsWith(spec.type), h["content-type"]);
    add(
      "R2",
      "no CORS headers",
      cls,
      !Object.keys(h).some((k) => k.startsWith("access-control-")),
      Object.keys(h)
        .filter((k) => k.startsWith("access-control-"))
        .join(",") || null,
    );
    add(
      "R2 (L3)",
      "Cross-Origin-Opener-Policy",
      cls,
      h["cross-origin-opener-policy"] !== undefined,
      h["cross-origin-opener-policy"],
    );
    add(
      "R2 (L3)",
      "Cross-Origin-Resource-Policy",
      cls,
      h["cross-origin-resource-policy"] !== undefined,
      h["cross-origin-resource-policy"],
    );
    if (spec.html) {
      const csp = parseCsp(h["content-security-policy"]);
      const script = effective(csp, "script-src");
      add("G5", "CSP present", cls, h["content-security-policy"] !== undefined, h["content-security-policy"]);
      add(
        "G5",
        "CSP restricts script (script-src or default-src, no * / data: / http(s):)",
        cls,
        script !== undefined && !script.some((s) => s === "*" || s === "data:" || s === "http:" || s === "https:"),
        script?.join(" "),
      );
      add(
        "G5",
        "object-src 'none' (effective)",
        cls,
        effective(csp, "object-src")?.join(" ") === "'none'",
        effective(csp, "object-src")?.join(" "),
      );
      add("G5", "base-uri 'none'", cls, csp["base-uri"]?.join(" ") === "'none'", csp["base-uri"]?.join(" "));
      add(
        "G5",
        "frame-ancestors 'none'",
        cls,
        csp["frame-ancestors"]?.join(" ") === "'none'",
        csp["frame-ancestors"]?.join(" "),
      );
      add("R2", "no 'unsafe-eval' in script-src", cls, !(script ?? []).includes("'unsafe-eval'"), script?.join(" "));
      add(
        "R2 (L3)",
        "no 'unsafe-inline' in script-src (strict CSP)",
        cls,
        !(script ?? []).includes("'unsafe-inline'"),
        script?.join(" "),
      );
    }
  }
  for (const [kind, exchange] of Object.entries(snapshot.exchanges)) {
    const cookies = exchange.headers["set-cookie"] ?? [];
    add("G4", "one Set-Cookie", kind, cookies.length === 1, cookies.length);
    const c = cookies[0] ?? { name: "", attributes: {} };
    if (snapshot.https) add("G4", "__Host- prefix", kind, c.name.startsWith("__Host-"), c.name);
    if (snapshot.https) add("G4", "Secure", kind, c.attributes.secure === true, c.attributes.secure);
    add("G4", "HttpOnly", kind, c.attributes.httponly === true, c.attributes.httponly);
    add("G4", "Path=/", kind, c.attributes.path === "/", c.attributes.path);
    add("G4", "no Domain", kind, c.attributes.domain === undefined, c.attributes.domain);
    add("G4", "SameSite=Strict", kind, String(c.attributes.samesite).toLowerCase() === "strict", c.attributes.samesite);
    add("G4", "a 303", kind, exchange.status === 303, exchange.status);
    add(
      "G4",
      "clean Location (no token)",
      kind,
      typeof exchange.location === "string" &&
        !/[?&]token=/.test(exchange.location) &&
        !SECRET.test(exchange.location) &&
        !exchange.location.includes("<redacted"),
      exchange.location,
    );
    if (exchange.next !== undefined)
      add(
        "G4",
        "one hop (Location is not another redirect)",
        kind,
        exchange.next !== null && !(exchange.next.status >= 300 && exchange.next.status < 400),
        exchange.next?.status,
      );
  }
  for (const [kind, response] of Object.entries(snapshot.refusals)) {
    add(
      "G4",
      "refused (no cookie, no redirect)",
      kind,
      !(response.status >= 200 && response.status < 400) && (response.headers["set-cookie"] ?? []).length === 0,
      response.status,
    );
  }
  return results;
}

/** Results grouped for a report: the failing predicates by row, then the passing count. */
export function summarize(results) {
  const failing = results.filter((r) => !r.pass);
  const byRow = {};
  for (const r of failing)
    (byRow[r.row] ??= []).push(
      `${r.predicate} — ${r.class}${r.observed === null || r.observed === undefined ? "" : ` (${r.observed})`}`,
    );
  return {
    predicates: results.length,
    passing: results.length - failing.length,
    failing: failing.length,
    failingByRow: byRow,
  };
}
