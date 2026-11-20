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

const ROOT = 0;
const STICKY = 0o1000;

/**
 * The first folder, from `path` up to `/`, whose entries an account other than this one (or root) can
 * add, remove or rename, or undefined when there is none. Only such an account could swap a folder on the
 * path for a link between Archer's check and its use. A folder qualifies when it is owned by this account
 * or root and writable by nobody else; its group may write only when that group is private to this
 * account (as for archer.toml; on macOS, where accounts are not in /etc/passwd, no group counts as
 * private). A sticky folder others can write (`/tmp`) qualifies above a child this account or root owns:
 * others cannot rename or remove that child.
 *
 * The path is walked as given, never resolved: a link on it is reported as a folder others can change, since
 * resolving it would check wherever the link leads at that moment, which is the swap this guards against.
 * Callers pass a real path for the part they trust (the anchor's folder) and the confined parts below it.
 *
 * Reads POSIX owners and modes only: an ACL that grants another account write access is not seen.
 * Where the platform has no uids nothing is reported.
 */
export function folderOthersCanChange(path: string): string | undefined {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  let accounts: { readonly passwd: string; readonly group: string } | null | undefined;
  const privateGroup = (gid: number): boolean => {
    if (accounts === undefined) {
      try {
        accounts = { passwd: readFileSync("/etc/passwd", "utf8"), group: readFileSync("/etc/group", "utf8") };
      } catch {
        accounts = null;
      }
    }
    return accounts !== null && groupIsPrivate(uid, gid, accounts.passwd, accounts.group);
  };
  let child: Stats | undefined;
  for (let at = path; ; at = dirname(at)) {
    const folder = lstatSync(at);
    if (folder.isSymbolicLink() || !onlyOwnerChanges(folder, uid, child, privateGroup)) return at;
    if (dirname(at) === at) return undefined;
    child = folder;
  }
}

function onlyOwnerChanges(
  folder: Stats,
  uid: number,
  child: Stats | undefined,
  privateGroup: (gid: number) => boolean,
): boolean {
  if (folder.uid !== uid && folder.uid !== ROOT) return false;
  const othersWrite = (folder.mode & 0o002) !== 0,
    groupWrites = (folder.mode & 0o020) !== 0;
  if (!othersWrite && !groupWrites) return true;
  if ((folder.mode & STICKY) !== 0 && child !== undefined && (child.uid === uid || child.uid === ROOT)) return true;
  return !othersWrite && folder.uid === uid && privateGroup(folder.gid);
}
