/**
 * Durable independent browser grants. Only the OS-authorized management plane may issue them.
 *
 * Browser sessions (security round 1, decision D2): every sign-in (a link's `?token=`, the owner's
 * path, a pairing code) mints a fresh random per-browser session secret, and the cookie carries that, never
 * the link's secret. A session acts for its grant (or for the owner's service token), is kept only as its
 * sha256 verifier in `browser-sessions.json` beside the grants, listed nowhere, and ends with its grant's
 * revocation, a new service token, or `SESSION_MAX_AGE_SECONDS` (the cookie's Max-Age). A cookie carrying a
 * link's secret or the service token itself authenticates nothing.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { privateDirProblem } from "./paths.ts";
import { newSecret, TOKEN_PATTERN } from "./token.ts";

export const MAX_ACCESS_GRANTS = 4096;
export const MAX_ACCESS_GRANT_BYTES = 2 * 1024 * 1024;
const FILE = "access-grants.json";
const SESSIONS_FILE = "browser-sessions.json";
/** The browser cookie's lifetime (400 days, the most a browser keeps one), and so a session's. */
export const SESSION_MAX_AGE_SECONDS = 34_560_000;
export const MAX_BROWSER_SESSIONS = 4096;
/** Browsers signed in per grant (or for the owner) before the oldest is dropped. */
export const MAX_SESSIONS_PER_SUBJECT = 64;
/**
 * Sign-ins per grant per minute (C-27): a link holder signing in as fast as it can would otherwise rewrite the
 * session store hundreds of times a second and, past MAX_SESSIONS_PER_SUBJECT, sign the link's other browsers
 * out in a moment. Kept in memory: a restart starts the count again. The owner is not paced.
 */
export const MAX_SESSION_MINTS_PER_MINUTE = 20;
const MAX_SESSION_BYTES = 2 * 1024 * 1024;
/** The owner's sessions are bound to the service token they were minted under: a new token ends them. */
const ownerSubject = (ownerToken: string): string =>
  `owner:${createHash("sha256").update(`archer-owner-session:${ownerToken}`).digest("hex")}`;
const subjectPattern = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|owner:[a-f0-9]{64})$/;
const hex = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

export interface AccessGrantInfo {
  readonly id: string;
  readonly label: string;
  readonly issuedAt: string;
  readonly revokedAt: string | null;
}

interface StoredGrant extends AccessGrantInfo {
  readonly verifier: string;
}
interface GrantFile {
  readonly version: 1;
  readonly grants: readonly StoredGrant[];
}
export class AccessGrantError extends Error {
  override readonly name = "AccessGrantError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function refuse(message: string): never {
  throw new AccessGrantError("invalid_access_store", message);
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const date = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length === 24 &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const labelValid = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value);

/** Fixed-depth vocabulary validation; no recursive descent over caller-controlled objects. */
export function parseAccessGrants(text: string): GrantFile {
  if (Buffer.byteLength(text) > MAX_ACCESS_GRANT_BYTES) refuse("access grant store exceeds its byte limit");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse("access grant store is not valid JSON");
  }
  if (
    !object(raw) ||
    raw.version !== 1 ||
    Object.keys(raw).some((k) => k !== "version" && k !== "grants") ||
    !Array.isArray(raw.grants) ||
    raw.grants.length > MAX_ACCESS_GRANTS
  )
    return refuse("access grant store has an unsupported shape or capacity");
  const ids = new Set<string>();
  const verifiers = new Set<string>();
  for (const grant of raw.grants) {
    if (
      !object(grant) ||
      Object.keys(grant).length !== 5 ||
      Object.keys(grant).some((k) => !["id", "label", "issuedAt", "revokedAt", "verifier"].includes(k)) ||
      typeof grant.id !== "string" ||
      !uuid.test(grant.id) ||
      !labelValid(grant.label) ||
      !date(grant.issuedAt) ||
      (grant.revokedAt !== null && !date(grant.revokedAt)) ||
      typeof grant.verifier !== "string" ||
      !hex.test(grant.verifier) ||
      ids.has(grant.id) ||
      verifiers.has(grant.verifier)
    )
      return refuse("access grant store contains an invalid or duplicate grant");
    ids.add(grant.id);
    verifiers.add(grant.verifier);
  }
  return raw as unknown as GrantFile;
}

interface StoredSession {
  readonly id: string;
  readonly subject: string;
  readonly verifier: string;
  readonly issuedAt: string;
}
interface SessionFile {
  readonly version: 1;
  readonly sessions: readonly StoredSession[];
}

/** The session store's vocabulary, as strictly as the grants'. */
export function parseBrowserSessions(text: string): SessionFile {
  if (Buffer.byteLength(text) > MAX_SESSION_BYTES) refuse("browser session store exceeds its byte limit");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse("browser session store is not valid JSON");
  }
  if (
    !object(raw) ||
    raw.version !== 1 ||
    Object.keys(raw).some((k) => k !== "version" && k !== "sessions") ||
    !Array.isArray(raw.sessions) ||
    raw.sessions.length > MAX_BROWSER_SESSIONS
  )
    return refuse("browser session store has an unsupported shape or capacity");
  const verifiers = new Set<string>();
  for (const session of raw.sessions) {
    if (
      !object(session) ||
      Object.keys(session).length !== 4 ||
      Object.keys(session).some((k) => !["id", "subject", "verifier", "issuedAt"].includes(k)) ||
      typeof session.id !== "string" ||
      !uuid.test(session.id) ||
      typeof session.subject !== "string" ||
      !subjectPattern.test(session.subject) ||
      typeof session.verifier !== "string" ||
      !hex.test(session.verifier) ||
      !date(session.issuedAt) ||
      verifiers.has(session.verifier)
    )
      return refuse("browser session store contains an invalid or duplicate session");
    verifiers.add(session.verifier);
  }
  return raw as unknown as SessionFile;
}

function information({ id, label, issuedAt, revokedAt }: StoredGrant): AccessGrantInfo {
  return { id, label, issuedAt, revokedAt };
}

/** Single writer: construct only while holding the service's account-state writer lock. */
export class AccessGrantStore {
  private readonly existed = new Set<string>();
  /** Recent sign-in times per grant, for MAX_SESSION_MINTS_PER_MINUTE; bounded by the live grants. */
  private readonly mints = new Map<string, number[]>();
  constructor(
    readonly stateDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.read();
  }
  private read(): readonly StoredGrant[] {
    return this.readFile(FILE, MAX_ACCESS_GRANT_BYTES, "access grant store", (text) => parseAccessGrants(text).grants);
  }
  private readSessions(): readonly StoredSession[] {
    return this.readFile(
      SESSIONS_FILE,
      MAX_SESSION_BYTES,
      "browser session store",
      (text) => parseBrowserSessions(text).sessions,
    );
  }
  private readFile<T>(
    file: string,
    maxBytes: number,
    what: string,
    parse: (text: string) => readonly T[],
  ): readonly T[] {
    const problem = privateDirProblem(this.stateDir, "access grant directory");
    if (problem !== undefined) return refuse(problem);
    let fd: number;
    try {
      fd = openSync(join(this.stateDir, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === "ENOENT" && !this.existed.has(file)) return [];
      return refuse(`${what} is unavailable; restore it or explicitly reset browser access`);
    }
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.size > maxBytes ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid !== undefined && stat.uid !== process.getuid())
      )
        return refuse(`${what} is not a bounded private regular file`);
      const bytes = Buffer.alloc(stat.size);
      let used = 0;
      while (used < bytes.length) {
        const count = readSync(fd, bytes, used, bytes.length - used, used);
        if (count === 0) return refuse(`${what} changed during read`);
        used += count;
      }
      const result = parse(bytes.toString("utf8"));
      this.existed.add(file);
      return result;
    } finally {
      closeSync(fd);
    }
  }
  private persist(grants: readonly StoredGrant[]): void {
    const text = `${JSON.stringify({ version: 1, grants })}\n`;
    parseAccessGrants(text);
    this.persistFile(FILE, text);
  }
  private persistSessions(sessions: readonly StoredSession[]): void {
    const text = `${JSON.stringify({ version: 1, sessions })}\n`;
    parseBrowserSessions(text);
    this.persistFile(SESSIONS_FILE, text);
  }
  private persistFile(file: string, text: string): void {
    const temporary = join(this.stateDir, `.${file}.${randomBytes(16).toString("hex")}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const bytes = Buffer.from(text);
      let used = 0;
      while (used < bytes.length) used += writeSync(fd, bytes, used, bytes.length - used);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, join(this.stateDir, file));
      this.existed.add(file);
      const directory = openSync(this.stateDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch (error) {
      // Cleanup after a failed write: the write's error is the one reported, whatever the cleanup meets.
      try {
        if (fd !== undefined) closeSync(fd);
      } catch {
        /* the write's error is reported */
      }
      try {
        unlinkSync(temporary);
      } catch {
        /* the write's error is reported */
      }
      throw error;
    }
    try {
      unlinkSync(temporary);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
    }
  }
  issue(label: string): AccessGrantInfo & { readonly token: string } {
    if (!labelValid(label))
      throw new AccessGrantError("invalid_arguments", "grant label must contain 1–128 characters without controls");
    const grants = this.read();
    if (grants.length >= MAX_ACCESS_GRANTS)
      throw new AccessGrantError(
        "access_grant_capacity",
        "access grant capacity reached; existing grants remain unchanged",
      );
    const token = newSecret();
    const grant: StoredGrant = {
      id: randomUUID(),
      label,
      issuedAt: new Date().toISOString(),
      revokedAt: null,
      verifier: hash(token),
    };
    this.persist([...grants, grant]);
    return { ...information(grant), token };
  }
  list(): readonly AccessGrantInfo[] {
    return this.read().map(information);
  }
  isActive(id: string): boolean {
    try {
      return this.read().some((grant) => grant.id === id && grant.revokedAt === null);
    } catch {
      return false;
    }
  }
  /** A live grant's own secret (a link, a Bearer header). A session secret is not one. */
  authenticateLink(token: string): AccessGrantInfo | null {
    if (!TOKEN_PATTERN.test(token)) return null;
    let grants: readonly StoredGrant[];
    try {
      grants = this.read();
    } catch {
      return null;
    }
    return this.linkMatch(grants, Buffer.from(hash(token), "hex"));
  }
  private linkMatch(grants: readonly StoredGrant[], digest: Buffer): AccessGrantInfo | null {
    let matched: StoredGrant | undefined;
    for (const grant of grants) {
      const equal = timingSafeEqual(digest, Buffer.from(grant.verifier, "hex"));
      if (equal && grant.revokedAt === null) matched = grant;
    }
    return matched === undefined ? null : information(matched);
  }
  /** A live session of a live grant. A grant's own secret is a link, not a session: it is not one. */
  authenticateSession(token: string): AccessGrantInfo | null {
    if (!TOKEN_PATTERN.test(token)) return null;
    let grants: readonly StoredGrant[];
    try {
      grants = this.read();
    } catch {
      return null;
    }
    const subject = this.sessionSubject(Buffer.from(hash(token), "hex"));
    const grant =
      subject === null
        ? undefined
        : grants.find((candidate) => candidate.id === subject && candidate.revokedAt === null);
    return grant === undefined ? null : information(grant);
  }
  /** Whether `token` is a live session minted for the owner under `ownerToken`, the service token now. */
  authenticateOwnerSession(token: string, ownerToken: string): boolean {
    if (!TOKEN_PATTERN.test(token)) return false;
    return this.sessionSubject(Buffer.from(hash(token), "hex")) === ownerSubject(ownerToken);
  }
  /** The subject of the live (unexpired) session whose verifier is `digest`, compared against every session. */
  private sessionSubject(digest: Buffer): string | null {
    let sessions: readonly StoredSession[];
    try {
      sessions = this.readSessions();
    } catch {
      return null;
    }
    const oldest = this.now() - SESSION_MAX_AGE_SECONDS * 1000;
    let matched: StoredSession | undefined;
    for (const session of sessions) {
      const equal = timingSafeEqual(digest, Buffer.from(session.verifier, "hex"));
      if (equal && Date.parse(session.issuedAt) > oldest) matched = session;
    }
    return matched?.subject ?? null;
  }
  /** A fresh browser session for a live grant; its secret goes in that browser's cookie and nowhere else. */
  mintGrantSession(grantId: string): string {
    if (!this.read().some((grant) => grant.id === grantId && grant.revokedAt === null))
      throw new AccessGrantError("access_grant_revoked", "the grant is not live");
    const now = this.now();
    for (const [id, times] of this.mints) if (times.at(-1)! <= now - 60_000) this.mints.delete(id);
    const recent = (this.mints.get(grantId) ?? []).filter((time) => time > now - 60_000);
    if (recent.length >= MAX_SESSION_MINTS_PER_MINUTE)
      throw new AccessGrantError("session_rate_limited", "too many sign-ins with this link in the last minute");
    const secret = this.mintSession(grantId);
    this.mints.set(grantId, [...recent, now]);
    return secret;
  }
  /** A fresh browser session for the owner, bound to the service token it was signed in with. */
  mintOwnerSession(ownerToken: string): string {
    return this.mintSession(ownerSubject(ownerToken));
  }
  private mintSession(subject: string): string {
    const grants = this.read();
    const live = new Set(grants.filter((grant) => grant.revokedAt === null).map((grant) => grant.id));
    const oldest = this.now() - SESSION_MAX_AGE_SECONDS * 1000;
    // Kept: unexpired sessions of live grants and of the owner under the current subject's token (an owner
    // session of an older token is dead). Each subject keeps its newest sessions; the store its newest overall.
    let kept = this.readSessions().filter(
      (session) =>
        Date.parse(session.issuedAt) > oldest &&
        (session.subject.startsWith("owner:")
          ? !subject.startsWith("owner:") || session.subject === subject
          : live.has(session.subject)),
    );
    const mine = kept.filter((session) => session.subject === subject);
    if (mine.length >= MAX_SESSIONS_PER_SUBJECT) {
      const dropped = new Set(mine.slice(0, mine.length - MAX_SESSIONS_PER_SUBJECT + 1).map((session) => session.id));
      kept = kept.filter((session) => !dropped.has(session.id));
    }
    if (kept.length >= MAX_BROWSER_SESSIONS) kept = kept.slice(kept.length - MAX_BROWSER_SESSIONS + 1);
    const secret = newSecret();
    this.persistSessions([
      ...kept,
      { id: randomUUID(), subject, verifier: hash(secret), issuedAt: new Date(this.now()).toISOString() },
    ]);
    return secret;
  }
  revoke(id: string): boolean {
    const grants = this.read();
    const target = grants.find((grant) => grant.id === id);
    if (target === undefined || target.revokedAt !== null) return false;
    this.persist(grants.map((grant) => (grant.id === id ? { ...grant, revokedAt: new Date().toISOString() } : grant)));
    // Its sessions already refuse (each is checked against a live grant); this only drops their records.
    try {
      const sessions = this.readSessions();
      if (sessions.some((session) => session.subject === id))
        this.persistSessions(sessions.filter((session) => session.subject !== id));
    } catch {
      /* the grant's revocation alone ends its sessions */
    }
    return true;
  }
}
