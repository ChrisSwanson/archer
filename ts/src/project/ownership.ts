// Who can change a file or folder: the current account alone, or others too. archer.toml's trust check
// and the path anchor's shared-folder refusal (docs/security/known-limits.md §1) use the same rule.
import { lstatSync, readFileSync, type Stats } from "node:fs";
import { dirname } from "node:path";

/** Whether group `gid` holds only account `uid`: its private group, by /etc/passwd and /etc/group. */
export function groupIsPrivate(uid: number, gid: number, passwd: string, group: string): boolean {
  let owner: string | undefined;
  for (const line of passwd.split("\n")) {
    const f = line.split(":");
    if (f.length < 4) continue;
    if (Number(f[2]) === uid) owner = f[0];
    else if (Number(f[3]) === gid) return false;
  }
  if (owner === undefined) return false;
  for (const line of group.split("\n")) {
    const f = line.split(":");
    if (f.length < 4 || Number(f[2]) !== gid) continue;
    const members = (f[3] ?? "")
      .split(",")
      .map((m) => m.trim())
      .filter((m) => m !== "");
    return members.every((m) => m === owner);
  }
  return false;
}

/**
 * Whether group `gid` is private to account `uid` by this host's /etc/passwd and /etc/group. Accounts that
 * are not in the local files (LDAP, macOS Directory Services) cannot be checked, so a group is private only
 * when both files can be read and show no one else.
 */
export function privateGroup(uid: number, gid: number): boolean {
  try {
    return groupIsPrivate(uid, gid, readFileSync("/etc/passwd", "utf8"), readFileSync("/etc/group", "utf8"));
  } catch {
    return false;
  }
}

/**
 * Whether only account `uid` can change what `stats` describes: it is that account's, nobody else may write
 * to it, and its group may write only when that group is private to the account (a user-private group, as
 * on umask 002 systems, where every file is group-writable).
 */
export function writableOnlyBy(
  stats: { readonly uid: number; readonly gid: number; readonly mode: number },
  uid: number,
): boolean {
  if (stats.uid !== uid || (stats.mode & 0o002) !== 0) return false;
  return (stats.mode & 0o020) === 0 || privateGroup(uid, stats.gid);
}

const ROOT = 0;
const STICKY = 0o1000;

/**
 * The first folder, from `path` up to `/`, whose entries an account other than this one (or root) can
 * add, remove or rename, or undefined when there is none. Only such an account could swap a folder on the
 * path for a link between Archer's check and its use. A folder qualifies when it is owned by root and
 * writable by nobody else, or when only this account can change it (`writableOnlyBy`, as for archer.toml;
 * on macOS no group counts as private). A sticky folder others can write (`/tmp`) qualifies above a child
 * this account or root owns: others cannot rename or remove that child.
 *
 * The path is walked as given, never resolved: a link on it is reported as a folder others can change, since
 * resolving it would check wherever the link leads at that moment, which is the swap this guards against.
 * Callers pass a real path for the part they trust (the anchor's folder) and the confined parts below it.
 *
 * Walked on every change, never cached: a mode changed while the service runs must count. It costs a few
 * microseconds beside the write's fsync.
 *
 * Reads POSIX owners and modes only: an ACL that grants another account write access is not seen.
 * Where the platform has no uids nothing is reported.
 */
export function folderOthersCanChange(path: string): string | undefined {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  const ours = (s: Stats) => s.uid === uid || s.uid === ROOT;
  let child: Stats | undefined;
  for (let at = path; ; at = dirname(at)) {
    const folder = lstatSync(at);
    const onlyOwnerChanges =
      !folder.isSymbolicLink() &&
      ours(folder) &&
      ((folder.mode & 0o022) === 0 ||
        ((folder.mode & STICKY) !== 0 && child !== undefined && ours(child)) ||
        writableOnlyBy(folder, uid));
    if (!onlyOwnerChanges) return at;
    if (dirname(at) === at) return undefined;
    child = folder;
  }
}
