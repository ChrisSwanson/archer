/** Additional authoring authority; ordinary browser grants retain their existing contract. */
import { randomBytes, randomUUID } from "node:crypto";
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
import { isAbsolute, join, resolve } from "node:path";
import { privateDirProblem } from "./paths.ts";

export const MAX_AUTHORING_ENTITLEMENTS = 1024;
export const MAX_AUTHORING_ROOTS = 16;
export const MAX_AUTHORING_GRANT_BYTES = 2 * 1024 * 1024;
const FILE = "authoring-grants.json";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const date = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length === 24 &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
export const canonicalAuthoringRoot = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  !/[\u0000-\u001f\u007f]/u.test(value) &&
  isAbsolute(value) &&
  resolve(value) === value;
const rootsValid = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= MAX_AUTHORING_ROOTS &&
  value.every(canonicalAuthoringRoot) &&
  new Set(value).size === value.length;

export interface AuthoringEntitlement {
  readonly entitlementId: string;
  readonly grantId: string;
  readonly projectRoots: readonly string[];
  readonly issuedAt: string;
  readonly revokedAt: string | null;
}
interface EntitlementFile {
  readonly version: 1;
  readonly entitlements: readonly AuthoringEntitlement[];
}
export class AuthoringGrantError extends Error {
  override readonly name = "AuthoringGrantError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function refuse(message: string): never {
  throw new AuthoringGrantError("invalid_authoring_store", message);
}

/** Fixed-depth, bounded validation. No recursive traversal of untrusted input. */
export function parseAuthoringGrants(text: string): EntitlementFile {
  if (Buffer.byteLength(text) > MAX_AUTHORING_GRANT_BYTES) refuse("authoring entitlement store exceeds its byte limit");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse("authoring entitlement store is not valid JSON");
  }
  if (
    !object(raw) ||
    Object.keys(raw).length !== 2 ||
    raw.version !== 1 ||
    !Array.isArray(raw.entitlements) ||
    raw.entitlements.length > MAX_AUTHORING_ENTITLEMENTS
  )
    return refuse("authoring entitlement store has an unsupported shape or capacity");
  const ids = new Set<string>(),
    grants = new Set<string>();
  for (const entry of raw.entitlements) {
    if (
      !object(entry) ||
      Object.keys(entry).length !== 5 ||
      Object.keys(entry).some(
        (key) => !["entitlementId", "grantId", "projectRoots", "issuedAt", "revokedAt"].includes(key),
      ) ||
      typeof entry.entitlementId !== "string" ||
      !uuid.test(entry.entitlementId) ||
      typeof entry.grantId !== "string" ||
      !uuid.test(entry.grantId) ||
      !rootsValid(entry.projectRoots) ||
      !date(entry.issuedAt) ||
      (entry.revokedAt !== null && (!date(entry.revokedAt) || entry.revokedAt < entry.issuedAt)) ||
      ids.has(entry.entitlementId) ||
      grants.has(entry.grantId)
    )
      return refuse("authoring entitlement store contains an invalid or duplicate entitlement");
    ids.add(entry.entitlementId);
    grants.add(entry.grantId);
  }
  return raw as unknown as EntitlementFile;
}

/** Single writer under the service account lock. The owner guard refuses retained handles after stop. */
export class AuthoringGrantStore {
  private existed = false;
  constructor(
    readonly stateDir: string,
    private readonly assertOwner: () => void = () => {},
  ) {
    this.read();
  }

  private read(): readonly AuthoringEntitlement[] {
    this.assertOwner();
    try {
      const problem = privateDirProblem(this.stateDir, "authoring entitlement directory");
      if (problem !== undefined) return refuse(problem);
    } catch (failure) {
      if (failure instanceof AuthoringGrantError) throw failure;
      return refuse("authoring entitlement directory is unavailable");
    }
    let fd: number;
    try {
      fd = openSync(join(this.stateDir, FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === "ENOENT" && !this.existed) return [];
      return refuse("authoring entitlement store is unavailable; restore it before issuing authoring access");
    }
    // Once a file has been observed, deletion must not silently reset authority.
    this.existed = true;
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.size > MAX_AUTHORING_GRANT_BYTES ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid !== undefined && stat.uid !== process.getuid())
      )
        return refuse("authoring entitlement store is not a bounded private regular file");
      const bytes = Buffer.alloc(stat.size);
      let used = 0;
      while (used < bytes.length) {
        const count = readSync(fd, bytes, used, bytes.length - used, used);
        if (count === 0) return refuse("authoring entitlement store changed during read");
        used += count;
      }
      if (fstatSync(fd).size !== stat.size) return refuse("authoring entitlement store changed during read");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        return refuse("authoring entitlement store is not UTF-8");
      }
      return parseAuthoringGrants(text).entitlements;
    } catch (failure) {
      if (failure instanceof AuthoringGrantError) throw failure;
      return refuse("authoring entitlement store could not be read safely");
    } finally {
      closeSync(fd);
    }
  }

  private persist(entitlements: readonly AuthoringEntitlement[]): void {
    this.assertOwner();
    const text = `${JSON.stringify({ version: 1, entitlements })}\n`;
    parseAuthoringGrants(text);
    const temporary = join(this.stateDir, `.${FILE}.${randomBytes(16).toString("hex")}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const bytes = Buffer.from(text);
      let used = 0;
      while (used < bytes.length) used += writeSync(fd, bytes, used, bytes.length - used);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      this.assertOwner();
      renameSync(temporary, join(this.stateDir, FILE));
      this.existed = true;
      const directory = openSync(this.stateDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch (failure) {
      if (failure instanceof AuthoringGrantError) throw failure;
      return refuse("authoring entitlement could not be persisted; no authoring access receipt was issued");
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temporary);
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ENOENT")
          refuse("authoring entitlement temporary file could not be removed safely");
      }
    }
  }

  issue(grantId: string, projectRoots: readonly string[]): AuthoringEntitlement {
    this.assertOwner();
    if (!uuid.test(grantId) || !rootsValid(projectRoots))
      throw new AuthoringGrantError(
        "invalid_arguments",
        "authoring access needs a grant ID and 1–16 unique canonical absolute project roots",
      );
    const current = this.read();
    if (current.length >= MAX_AUTHORING_ENTITLEMENTS)
      throw new AuthoringGrantError(
        "authoring_grant_capacity",
        `authoring entitlement capacity reached (${MAX_AUTHORING_ENTITLEMENTS} issued, revoked ones included); existing grants remain unchanged. Stop Archer and move ${FILE} in the Archer state directory aside to start over (every authoring link must then be issued again)`,
      );
    if (current.some((entry) => entry.grantId === grantId))
      throw new AuthoringGrantError("invalid_arguments", "this browser grant already has an authoring entitlement");
    const entitlement: AuthoringEntitlement = {
      entitlementId: randomUUID(),
      grantId,
      projectRoots: [...projectRoots],
      issuedAt: new Date().toISOString(),
      revokedAt: null,
    };
    this.persist([...current, entitlement]);
    return entitlement;
  }

  /** Current entitlement identity for journal capture; base authentication is separate. */
  entitlement(grantId: string, root: string): AuthoringEntitlement | null {
    if (!uuid.test(grantId) || !canonicalAuthoringRoot(root)) return null;
    try {
      return (
        this.read().find(
          (entry) => entry.grantId === grantId && entry.revokedAt === null && entry.projectRoots.includes(root),
        ) ?? null
      );
    } catch {
      return null;
    }
  }

  /** Entitlement only: callers must separately authenticate and check the base grant. */
  allows(grantId: string, root: string): boolean {
    return this.entitlement(grantId, root) !== null;
  }
}
