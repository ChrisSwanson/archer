import type { IncomingHttpHeaders } from "node:http";
import { SESSION_MAX_AGE_SECONDS, type AccessGrantStore } from "./access-grants.ts";
import { TOKEN_PATTERN, tokenMatches } from "./token.ts";

export interface BrowserAuthority {
  readonly serviceToken: string;
  readonly grants: AccessGrantStore;
  readonly cookieName: string;
  readonly secure: boolean;
  readonly allowedHosts: ReadonlySet<string>;
}
export interface BrowserAccess {
  readonly path: string;
  readonly credential: "bearer" | "cookie" | "exchange";
  /** Absent for the service token: the owner's own authority, not an individually revocable grant. */
  readonly grantId?: string;
  readonly redirect?: string;
  readonly cookie?: string;
}

const SECRET = TOKEN_PATTERN;

/** The raw query without its `token` parameters, every other parameter kept in its order and spelling. */
export function withoutToken(search: string): string {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const kept = raw.split("&").filter((part) => {
    if (part === "") return false;
    const name = part.split("=", 1)[0]!;
    let decoded: string;
    try {
      decoded = decodeURIComponent(name.replace(/\+/g, " "));
    } catch {
      return true;
    }
    return decoded !== "token";
  });
  return kept.length === 0 ? "" : `?${kept.join("&")}`;
}

/**
 * The remembered, port-specific browser cookie. It carries a fresh per-browser session secret
 * (`sessionCookie`), never the link's own secret (decision D2, 2026-10-31).
 */
function cookieWith(authority: BrowserAuthority, secret: string): string {
  return `${authority.cookieName}=${secret}; HttpOnly; SameSite=Strict; Path=/; ${authority.secure ? "Secure; " : ""}Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

/** Sign one browser in: a new session for the grant (or, without one, for the owner's service token) and its cookie. */
export function sessionCookie(authority: BrowserAuthority, grantId: string | undefined): string {
  const secret =
    grantId === undefined
      ? authority.grants.mintOwnerSession(authority.serviceToken)
      : authority.grants.mintGrantSession(grantId);
  return cookieWith(authority, secret);
}

/** A link's credential: a grant's own secret or the service token (no grant id). A session secret is not a link. */
function authenticateLink(authority: BrowserAuthority, secret: string): { readonly grantId?: string } | null {
  if (!SECRET.test(secret)) return null;
  const grant = authority.grants.authenticateLink(secret);
  if (grant !== null) return { grantId: grant.id };
  return tokenMatches(secret, authority.serviceToken) ? {} : null;
}

/**
 * A cookie's credential: a browser session, for a live grant or for the owner under the current service
 * token. A grant's own secret or the service token is never a cookie's.
 */
export function cookieCredential(authority: BrowserAuthority, secret: string): { readonly grantId?: string } | null {
  if (!SECRET.test(secret)) return null;
  const grant = authority.grants.authenticateSession(secret);
  if (grant !== null) return { grantId: grant.id };
  return authority.grants.authenticateOwnerSession(secret, authority.serviceToken) ? {} : null;
}

/** Why a request was not admitted; reported to development telemetry only, never to the caller. */
export type AccessRefusal =
  | "host_not_allowed"
  | "token_query_invalid"
  | "token_unknown"
  | "token_not_page"
  | "bearer_malformed"
  | "bearer_unknown"
  | "cookie_too_large"
  | "cookie_missing"
  | "cookie_ambiguous"
  | "cookie_unknown"
  | "cookie_write_origin"
  | "session_unavailable";

/** Resolve explicit credentials first. Invalid explicit authority never falls back to a cookie. */
export function browserAccess(
  authority: BrowserAuthority,
  method: string,
  url: URL,
  headers: IncomingHttpHeaders,
  isPage: (path: string, search: string) => boolean,
  refused: (reason: AccessRefusal) => void = () => {},
): BrowserAccess | null {
  const refuse = (reason: AccessRefusal): null => {
    refused(reason);
    return null;
  };
  const host = headers.host;
  if (host === undefined || !authority.allowedHosts.has(host.toLowerCase())) return refuse("host_not_allowed");
  const path = url.pathname;
  const tokens = url.searchParams.getAll("token");
  const authorization = headers.authorization;
  // Each exchange signs this browser in with a session of its own; the link's secret is never the cookie.
  const exchange = (grantId: string | undefined, clean: string): BrowserAccess | null => {
    let cookie: string;
    try {
      cookie = sessionCookie(authority, grantId);
    } catch {
      return refuse("session_unavailable");
    }
    return {
      credential: "exchange",
      path: clean,
      ...(grantId === undefined ? {} : { grantId }),
      redirect: `${clean}${withoutToken(url.search)}`,
      cookie,
    };
  };
  if (tokens.length > 0) {
    if (tokens.length !== 1 || authorization !== undefined || method !== "GET") return refuse("token_query_invalid");
    const token = tokens[0]!;
    const admitted = authenticateLink(authority, token);
    if (admitted === null) return refuse("token_unknown");
    // `isPage` is syntactic (route shape, project name); file resolution waits for the caller.
    return !isPage(path, withoutToken(url.search)) ? refuse("token_not_page") : exchange(admitted.grantId, path);
  }
  if (authorization !== undefined) {
    const match = /^Bearer ([a-f0-9]{32}(?:[a-f0-9]{32})?)$/.exec(authorization);
    if (match === null) return refuse("bearer_malformed");
    // A grant's own secret; a browser's session secret lives in its cookie only.
    const grant = authority.grants.authenticateLink(match[1]!);
    return grant === null ? refuse("bearer_unknown") : { path, credential: "bearer", grantId: grant.id };
  }
  if ((headers.cookie?.length ?? 0) > 16384) return refuse("cookie_too_large");
  const values = (headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${authority.cookieName}=`));
  if (values.length !== 1) return refuse(values.length === 0 ? "cookie_missing" : "cookie_ambiguous");
  const admitted = cookieCredential(authority, values[0]!.slice(authority.cookieName.length + 1));
  if (admitted === null) return refuse("cookie_unknown");
  // Browser writes need exact actual scheme, authority, and a JSON body. Missing Origin
  // cannot borrow the non-browser Bearer exception. No CORS or forwarded-header trust.
  if (!["GET", "HEAD"].includes(method)) {
    if (
      headers.origin !== `${authority.secure ? "https" : "http"}://${host}` ||
      headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
    )
      return refuse("cookie_write_origin");
  }
  return { path, credential: "cookie", ...(admitted.grantId === undefined ? {} : { grantId: admitted.grantId }) };
}
