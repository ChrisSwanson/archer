// Shared plumbing for the security tools (docs/quality/rubrics/security.md §8): one HTTP(S) request
// with full control of its headers (trusting only the sandbox's CA, like `curl --cacert`), the sandbox
// record, and redaction. Nothing here prints a secret: everything a tool writes goes through `redact`.
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** A credential's spelling (token.ts TOKEN_PATTERN: 32 hex, or 64 for older ones). */
const SECRET = /[a-f0-9]{64}|[a-f0-9]{32}/g;

/**
 * `value` with every known secret, and anything shaped like one, replaced by `<redacted:kind>`.
 * `secrets` maps a secret to its kind (`grant`, `service-token`, …); unknown token-shaped strings
 * become `<redacted:token>`.
 */
export function redact(value, secrets = new Map()) {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  for (const [secret, kind] of secrets) if (secret) text = text.split(secret).join(`<redacted:${kind}>`);
  return text.replace(SECRET, "<redacted:token>");
}

/**
 * One request. `body` is a string or Buffer; `declaredLength` overrides Content-Length (a cap probe
 * declares more than it sends); `chunked` sends the body with no Content-Length. Resolves {status, headers, rawHeaders, body (utf8), bytes}; a reset
 * connection resolves {status: 0, error}. `ca` trusts that PEM only; no verification is ever skipped.
 */
export function send(
  url,
  { method = "GET", headers = {}, body, ca, timeoutMs = 10_000, declaredLength, servername, chunked = false } = {},
) {
  const target = new URL(url);
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    const outgoing = { ...headers };
    if (body !== undefined && !chunked && declaredLength === undefined && outgoing["content-length"] === undefined)
      outgoing["content-length"] = String(Buffer.byteLength(body));
    if (declaredLength !== undefined) outgoing["content-length"] = String(declaredLength);
    const req = request(
      target,
      {
        method,
        headers: outgoing,
        agent: false,
        ...(target.protocol === "https:" ? { ca, ...(servername ? { servername } : {}) } : {}),
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        const done = () => {
          const bytes = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            rawHeaders: res.rawHeaders,
            body: bytes.toString("utf8"),
            bytes,
          });
        };
        res.on("end", done);
        res.on("aborted", done);
        res.on("error", done);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", (error) =>
      resolve({ status: 0, headers: {}, rawHeaders: [], body: "", bytes: Buffer.alloc(0), error: error.message }),
    );
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

/** Opens a stream (`api/events`) and resolves once headers arrive: {status, headers, ended (promise), close()}. */
export function openStream(url, { headers = {}, ca } = {}) {
  const target = new URL(url);
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    const req = request(target, { headers, agent: false, ...(target.protocol === "https:" ? { ca } : {}) }, (res) => {
      let endedAt = null;
      const ended = new Promise((done) => {
        const end = () => {
          endedAt ??= Date.now();
          done(endedAt);
        };
        res.on("end", end);
        res.on("close", end);
        res.on("aborted", end);
      });
      res.resume();
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        ended,
        endedAt: () => endedAt,
        close: () => req.destroy(),
      });
    });
    req.on("error", (error) =>
      resolve({
        status: 0,
        headers: {},
        ended: Promise.resolve(Date.now()),
        endedAt: () => Date.now(),
        close: () => {},
        error: error.message,
      }),
    );
    req.end();
  });
}

/** The sandbox record `tools/devkit/sandbox.mjs up --name <name>` kept (it holds secrets: never print it). */
export async function sandboxRecord(name) {
  const { registryPath } = await import("../../sandbox.mjs");
  const record = JSON.parse(readFileSync(registryPath(name), "utf8"));
  return { ...record, ca: record.caPath ? readFileSync(record.caPath) : undefined };
}

/** The cookie pair (`name=value`) of a response's first Set-Cookie, or null. */
export function cookiePair(response) {
  const set = response.headers["set-cookie"];
  const first = Array.isArray(set) ? set[0] : set;
  return typeof first === "string" ? first.split(";", 1)[0] : null;
}

/** The `error.code` of a JSON error body, or undefined. */
export function errorCode(response) {
  try {
    return JSON.parse(response.body)?.error?.code;
  } catch {
    return undefined;
  }
}
