// Cache on the wire (performance rubric G5, ADR 0014 as amended): on a warm load the shell revalidates (wire 304
// in Network.responseReceivedExtraInfo, no body), the hashed worker moves no body, and every other body that
// crosses the wire is a `no-store` API answer. Pure: rows as page-load.mjs records them.

const header = (headers, name) => {
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === name) return String(v);
  return null;
};

/**
 * Whether a row's body crossed the wire: not when the wire said 304, and not when the browser served it from its
 * memory or disk cache (`fromCache`, or Resource Timing transferSize 0 for a worker).
 */
export function bodyOnWire(r) {
  if (r.wireStatus === 304) return false;
  if (r.fromCache) return false;
  if (r.worker && r.transferBytes === 0) return false;
  if (/^eventsource$/i.test(r.type ?? "")) return false;
  return (r.decodedBytes ?? 0) > 0 || (r.transferBytes ?? 0) > 0;
}

/**
 * G5 on one warm load. `rows`: [{type, url, worker?, wireStatus?, status, fromCache?, decodedBytes, transferBytes,
 * cacheControl?, headers?}]; `tlsMode` from lib/tls.mjs. Returns {verdict: PASS|FAIL|NOT EVALUATED, problems, shell, worker}.
 */
export function cacheOnWire(rows, { tlsMode } = {}) {
  if (tlsMode === "ignore-https-errors")
    return {
      verdict: "NOT EVALUATED",
      problems: [
        "TLS errors ignored for the whole browser: Chromium does not cache, so the wire says nothing about the product (use --tls-ca or --tls-spki)",
      ],
    };
  const problems = [];
  const docs = rows.filter((r) => /^document$/i.test(r.type ?? ""));
  const shell = docs[docs.length - 1];
  if (!shell) problems.push("no document row");
  else if (shell.wireStatus !== 304)
    problems.push(`shell: wire status ${shell.wireStatus ?? "unknown"} (want 304 from responseReceivedExtraInfo)`);
  // Redirects of an alias are documents too; only the final one is the shell.
  for (const r of docs.slice(0, -1))
    if (!(r.status >= 300 && r.status < 400))
      problems.push(`document ${r.url}: a second document that is not a redirect`);
  const workers = rows.filter((r) => r.worker || /worker-[A-Za-z0-9_-]+\.js$/.test(r.url));
  for (const w of workers)
    if (bodyOnWire(w))
      problems.push(`worker ${new URL(w.url).pathname}: ${w.transferBytes} bytes on the wire (want 0 body bytes)`);
  for (const r of rows) {
    if (r === shell || workers.includes(r) || docs.includes(r) || !bodyOnWire(r)) continue;
    const cc = r.cacheControl ?? header(r.headers, "cache-control") ?? "";
    if (!/\/api\//.test(r.url) || !/no-store/i.test(cc))
      problems.push(
        `${r.method ?? "GET"} ${new URL(r.url).pathname}: body on the wire, ${/\/api\//.test(r.url) ? `Cache-Control "${cc}" is not no-store` : "not an API answer"}`,
      );
  }
  return {
    verdict: problems.length ? "FAIL" : "PASS",
    problems,
    shell: shell ? { wireStatus: shell.wireStatus ?? null, transferBytes: shell.transferBytes } : null,
    workers: workers.map((w) => ({
      url: new URL(w.url).pathname,
      transferBytes: w.transferBytes,
      fromCache: Boolean(w.fromCache),
    })),
  };
}
