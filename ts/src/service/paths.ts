// Where the service keeps itself: a per-user state directory (mode 0700)
// holding the token and port, so a restart comes back at the same URL and an
// open tab reconnects; and the socket directory the front doors dial.
//
//   state   $XDG_STATE_HOME/archer, else ~/.local/state/archer
//   socket  <state>/archer.sock (or explicit ARCHER_SOCKET)
// Runtime directories vary between terminals and MCP hosts; they cannot
// select a second socket for the same persistent service identity.
//
// Account state also remembers project attachments, verified source snapshots
// and presentation context; ARCHER_RESTORE_STATE controls startup recovery.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isToken } from "./token.ts";

/**
 * Why `dir` cannot hold private state, or undefined when it can: it must be a directory you own with
 * no group or other access, and not itself a link. Linked ancestors (a moved home, macOS /tmp) are fine.
 */
export function privateDirProblem(dir: string, what: string): string | undefined {
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink()) return `${what} ${dir} is a symbolic link; point the setting at the real directory`;
  if (!stat.isDirectory()) return `${what} ${dir} is not a directory`;
  if (process.getuid !== undefined && stat.uid !== process.getuid()) return `${what} ${dir} is owned by another user`;
  if ((stat.mode & 0o077) !== 0) return `${what} ${dir} is readable by others; run: chmod 700 ${dir}`;
  return undefined;
}

export type Env = Readonly<Record<string, string | undefined>>;

export interface ServiceDirs {
  readonly stateDir: string;
  readonly socketDir: string;
  readonly socketPath: string;
}

const absolute = (value: string | undefined): string | undefined =>
  value !== undefined && isAbsolute(value) ? value : undefined;

export function serviceDirs(env: Env = process.env): ServiceDirs {
  // ARCHER_STATE_DIR and ARCHER_SOCKET override both sides alike: the service
  // and every front door read them here, so they always find each other.
  const stateOverride = absolute(env["ARCHER_STATE_DIR"]);
  const socketOverride = absolute(env["ARCHER_SOCKET"]);
  const stateHome = absolute(env["XDG_STATE_HOME"]) ?? join(absolute(env["HOME"]) ?? homedir(), ".local", "state");
  const stateDir = stateOverride ?? join(stateHome, "archer");
  const socketDir = socketOverride === undefined ? stateDir : dirname(socketOverride);
  return { stateDir, socketDir, socketPath: socketOverride ?? join(socketDir, "archer.sock") };
}

/** The longest socket path every supported platform accepts (macOS allows 104 bytes). */
export const MAX_SOCKET_PATH_BYTES = 103;

/** Refuses a socket path the operating system would reject with a bare EINVAL. */
export function checkSocketPath(path: string): void {
  const bytes = Buffer.byteLength(path);
  if (bytes > MAX_SOCKET_PATH_BYTES)
    throw new StateError(
      `the socket path ${path} is ${bytes} bytes; Unix sockets allow at most ${MAX_SOCKET_PATH_BYTES} here. Set ARCHER_SOCKET to a shorter path`,
    );
}

/** The management socket the CLI and the MCP server dial (protocol.ts). */
export const serviceSocketPath = (env: Env = process.env): string => serviceDirs(env).socketPath;

export class StateError extends Error {
  override readonly name = "StateError";
}

/**
 * Makes `dir` (and its parents, 0700) and holds it to: a real directory, the user's own, readable by
 * nobody else. A link or someone else's directory is refused. A loose directory of the user's is
 * tightened only with `repair` (Archer's own default directory, which an older Archer may have left
 * loose); otherwise it is refused, untouched, with the fix in the message (security rubric R4): a
 * directory the person pointed Archer at may already hold another account's files.
 */
export function ensurePrivateDir(
  dir: string,
  options: { readonly repair?: boolean; readonly what?: string } = {},
): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = lstatSync(dir);
  if (!stats.isDirectory())
    throw new StateError(`${dir} is not a directory (a link or a file); remove it and start Archer again`);
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid)
    throw new StateError(`${dir} belongs to another user; Archer keeps its token there and will not use it`);
  if ((stats.mode & 0o077) === 0) return;
  if (options.repair === false)
    throw new StateError(`${options.what ?? "the directory"} ${dir} is readable by others; run: chmod 700 ${dir}`);
  chmodSync(dir, 0o700);
}

/**
 * ensurePrivateDir for the service's state or socket directory: Archer's own default
 * (`<XDG_STATE_HOME or ~/.local/state>/archer`) is created 0700 and repaired; a directory named by
 * ARCHER_STATE_DIR, ARCHER_SOCKET or an explicit option is refused when loose, never tightened.
 */
export function ensureServiceDir(dir: string, env: Env, what: string): void {
  const own = serviceDirs({ ...env, ARCHER_STATE_DIR: undefined, ARCHER_SOCKET: undefined }).stateDir;
  ensurePrivateDir(dir, { repair: resolve(dir) === resolve(own), what });
}

/**
 * Why the socket at `path` must not be dialled or deferred to, or undefined when it is absent or safe
 * (R4, C-26): another account must not be able to plant a listener the CLI and MCP traffic would reach.
 * It must be the user's own, in a directory private to them (privateDirProblem), and, for a client, a
 * socket. The service (`stale: "remove"`) instead removes a non-socket of the user's in its own private
 * directory as a stale leftover, as it always has; another user's entry is refused on both sides.
 */
export function socketProblem(path: string, options: { readonly stale?: "remove" } = {}): string | undefined {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? undefined : `cannot check the Archer service's socket ${path}: ${code ?? "error"}`;
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid)
    return `the socket ${path} is owned by another user; Archer will not talk to it. Point ARCHER_SOCKET at a directory of yours (chmod 700)`;
  if (!stats.isSocket() && options.stale !== "remove")
    return `the socket path ${path} is not a socket (a link or a file); remove it, or point ARCHER_SOCKET elsewhere`;
  try {
    return privateDirProblem(dirname(path), "the socket's directory");
  } catch (error) {
    return `cannot check the Archer service's socket directory ${dirname(path)}: ${(error as NodeJS.ErrnoException).code ?? "error"}`;
  }
}

export interface Identity {
  readonly token: string;
  /** The port last served on, or null for none yet. */
  readonly port: number | null;
}

const IDENTITY = "service.json";
const MAX_IDENTITY_BYTES = 4096;

/** The saved token and port, or null when there are none usable. Never follows a link. */
export function readIdentity(stateDir: string): Identity | null {
  let fd: number;
  try {
    fd = openSync(join(stateDir, IDENTITY), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stats = fstatSync(fd);
    const uid = process.getuid?.();
    if (
      !stats.isFile() ||
      stats.size > MAX_IDENTITY_BYTES ||
      (uid !== undefined && stats.uid !== uid) ||
      (stats.mode & 0o077) !== 0
    )
      return null;
    const buffer = Buffer.alloc(stats.size);
    readSync(fd, buffer, 0, stats.size, 0);
    const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { token, port } = parsed as Record<string, unknown>;
    if (!isToken(token)) return null;
    const validPort = typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
    return { token, port: validPort };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Writes the token and port to a fresh 0600 file, then moves it into place. */
export function writeIdentity(stateDir: string, identity: Identity): void {
  const temporary = join(stateDir, `.${IDENTITY}.${process.pid}.tmp`);
  try {
    unlinkSync(temporary);
  } catch {
    // none left over
  }
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, `${JSON.stringify(identity, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, join(stateDir, IDENTITY));
}
