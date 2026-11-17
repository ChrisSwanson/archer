// Where a browser goes after pairing (decided 2026-11-02; user-flows round 1, claude-09): back to the page it
// was refused at, not the start page. The return destination is attacker-influenced input (a link anyone can
// send), so it is accepted only as a path of this instance's own page grammar (`shared/browser-routes.mts`),
// spelled exactly as a browser would send it, and never with a credential in it. Anything else is no return,
// and the browser lands on `/projects/` as before. This is the whole check: a Location is only ever this
// value or `/projects/`, so there is no open redirect.

import { readBrowserRoute } from "../../../shared/browser-routes.mts";

/** Longer than any page address a person follows; a return that does not fit is dropped, not cut. */
export const MAX_RETURN_CHARS = 1024;
/** RFC 3986 path and query characters (no backslash, space, quote, angle bracket or fragment mark). */
const SPELLING = /^[A-Za-z0-9\-._~%!$&'()*+,;=:@/?]+$/;
/** Query keys that name a credential (the telemetry redactor's list, `telemetry/redact.ts`). */
const CREDENTIAL_KEY =
  /token|grant|secret|key|cookie|authori[sz]ation|^auth$|bearer|passw|credential|signature|^sig$|^code$|pairing|session/i;
const BASE = "http://archer.invalid";

/**
 * The page path (with its query) to land on, or null. Only `/projects/<name>/…` page addresses of the clean
 * grammar qualify: no scheme or host (`https://…`, `//host`), no backslash, no dot segments in any spelling,
 * no legacy `/p/` or token-prefixed form, no fragment, and no query key that names a credential, decoded.
 * Syntactic only: whether the project exists is for the caller, once the browser holds a credential.
 */
export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RETURN_CHARS || !SPELLING.test(raw)) return null;
  if (!raw.startsWith("/projects/") || raw.startsWith("//")) return null;
  const mark = raw.indexOf("?");
  const pathname = mark < 0 ? raw : raw.slice(0, mark),
    search = mark < 0 ? "" : raw.slice(mark);
  let parsed: URL;
  try {
    parsed = new URL(raw, BASE);
  } catch {
    return null;
  }
  // The URL parser resolves `.`/`..` (also `%2e`) and joins nothing else: any change is a spelling trick.
  if (parsed.origin !== BASE || parsed.pathname !== pathname || parsed.search !== search) return null;
  if (readBrowserRoute(pathname, search) === null) return null;
  for (const key of parsed.searchParams.keys()) if (CREDENTIAL_KEY.test(key)) return null;
  return raw;
}
