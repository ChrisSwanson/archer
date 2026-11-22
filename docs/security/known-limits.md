# Known security limits

Limits Archer keeps on purpose, each with its reason, what an attacker needs, and what they
get. Security review is scoped to the local Linux sandbox. **Linux with `/proc` mounted is the
reviewed platform.** Everything below that names another platform is outside the reviewed scope. It
becomes in scope, and is reviewed again, the day such a host is supported.

## 1. The path-anchor fallback race (non-Linux hosts)

**Where it applies.** Any host where `confined-fs.ts` cannot verify a descriptor filesystem
(`/proc/self/fd`, or `/dev/fd` with directory-relative suffixes). That means macOS, the BSDs, and Linux
without `/proc` (some minimal containers). `descriptorConfinement()` reports which one is in use. On
Linux with `/proc`, every segment is opened from the descriptor before it, which is the equivalent of
`openat`, and this race does not exist.

**What uses it.** The read/write seam (`readConfined`, `writeConfined` and their callers) and, since
0.14.1, `ConfinedFileSystem` itself: the document catalog and its reads, the change store, review
artifacts and the launcher's working folder. Before 0.14.1 `ConfinedFileSystem` refused to open on these
hosts instead, which left a Mac's project page empty.

**What the fallback does.** Node has no `openat`, so the path anchor lstat-walks every segment before
and after each open, create and rename, and compares (dev, ino) with the descriptor. One swap at any
single step is refused (tested in `ts/test/security/confined-seam.test.ts`, path anchor). Launch's working
folder is checked again by path just before the spawn on these hosts, with the same kind of window.

**Writes under a folder another account can change are refused (since 0.15.3).** Swapping a folder
for a link needs write access to the folder that holds it. So before each create, rename, removal or new
folder in the Archer folder, and before writing a review file, the path anchor walks every folder from the
one it changes up to `/` (`folderOthersCanChange`, `ts/src/project/ownership.ts`). It refuses with
`shared_folder` when a folder there is not this account's or root's, or is writable by other accounts, or
is a link. A group may write only when it is this account's private group, the same rule archer.toml's
trust check uses. On macOS no group counts as private, because accounts are not listed in `/etc/passwd`.
A sticky folder others can write, such as `/tmp` or `/Users/Shared`, is allowed above a child this account
or root owns, since others cannot rename or remove that child. The refusal names the folder and says
`chmod go-w`. Nothing is created first. The walk reads links without following them: resolving one would
check wherever it pointed at that moment, which is the swap itself. The descriptor anchor has no window
and does not check. Tested in `ts/test/security/shared-folder.test.ts`, including a swap scheduled at
the temporary's create that never runs, with a control showing the same swap does run otherwise.

**What an attacker needs.**
- Write access to a directory inside the project, on the path being read or written. Since 0.15.3 only
  the same account as Archer has that for a write: a path another account can change is refused.
  Another account still has it for a read (below).
- The ability to swap that directory for a link to an outside folder and back, several times, inside
  the few syscalls between Archer's walk, its open or create, and its re-walk. That means a racing
  local process and repeated attempts. One request gives the attacker one chance.
- For a read, a singly linked file outside the project that the Archer user can read, at the same
  name. For a write, an outside folder the Archer user can write to.

**What they get.**
- Read: the outside file's bytes are returned to whoever made the request (an agent, or a page grant
  holder).
- Write (before 0.15.3 from any account that could write in the project; since then from this account only):
  Archer's temporary file is created in the outside folder (7 temporaries in one scheduled
  run). It can be renamed over an outside file of the same name, with Archer's bytes. No overwrite was
  seen in that run, but the design does not rule one out.
- The change store and review artifacts (since 0.14.1) check the parent before each create and prove it
  holds the new file before writing a byte, so a swap that wins the window leaves at most an empty
  temporary or an empty `snapshots` / `.review` folder outside. Cleanup removes only what a still-bound
  parent holds.

**What remains since 0.15.3.**
- A process running as this account can still win the write window and leave Archer's temporary, or
  in the worst case Archer's bytes under an Archer file name, in a folder outside that this account can
  write. It already has this account's access, so it can write there directly. That stops being true only
  where it is confined to less than the account: a sandbox or container that shares this account's uid
  but sees only the project. Only an `openat`-equivalent closes that case. `path-escape.test.ts` (G6)
  allows such a run at most new Archer temporaries, never a change to an outside file that was there (O283).
- Reads are not checked. Another account that can write in the project can still race a read and get
  the bytes of an outside file this account can read.
- POSIX owners and modes only: an ACL (`chmod +a` on macOS) that lets another account write to a folder
  is not seen. Not tried on network volumes or volumes with ownership ignored.
- The change store lives in Archer's private state directory, which must already be this account's alone
  (§3), so it is not walked. Launch's working folder is a spawn's cwd, not a write, and is not walked.

**Why it is kept.** Closing it needs an `openat`-equivalent that Node does not provide, or a refusal
of all project access on these hosts. The fix direction, if a non-Linux host comes into scope, is to
create the temporary with `O_EXCL` under a re-verified parent, or refuse writes on hosts without
a descriptor filesystem until there is a native confined implementation.

## 2. A held folder moved out of the project during a write (Linux)

**Why it is kept.** It is outside what Archer can defend: any program that writes files
has this property, since the operating system renames into a folder wherever that folder now is. A lock
(SQLite or otherwise) would bind only programs that take it, and `mv`, `git` or an editor never do.
The same reasoning covers the launcher's folder below.

With the descriptor anchor, a folder moved out of the project between the last binding check and the
rename still receives the rename, in its new place. The write answers `write_uncertain`.

**What an attacker needs.** Write access to the project folder, and write access to the outside
destination it is moved into.

**What they get.** Archer's own bytes, in the project's own folder, now at the outside place. They
could already write there directly, so this grants nothing new. No outside file is written through
its own name. Pinned by `confined-seam.test.ts` ("a parent moved out of the project just before the
rename").

**The launcher's folder.** Launch holds its working folder the same
way: opened through the seam and spawned with cwd `/proc/self/fd/<fd>`. A folder swapped for a link
after the check is refused (`launcher.test.ts`, "the launcher starts in the folder that was checked").
A folder moved out of the project in the few syscalls between that open and the spawn still has the
launcher start in it, wherever it now is. That needs the same write access to the outside destination,
and the command, argv, environment and stdin are still the person's own.

## 3. Another account reaching the management socket

The socket and state directories are owner-only. An override directory that is
loose or another user's is refused. A socket that is not a socket, not the user's, or in a directory
that is not private is refused by the client, the MCP relay (on every connect and reconnect) and the service (`paths.ts` `socketProblem`;
`ts/test/security/management-boundary.test.ts`). In those tests the other-owner cases are simulated
in the same account.

**A real other account.** A real other-uid connection is run
without sudo or a second account: `tools/devkit/security/other-account-socket.mjs` runs the client in
Docker as `--user <other uid>` on the host kernel, with the socket's directory bind-mounted. Against a
sandbox service's real socket (directory 0700), uids 2000 and 65534 get `EACCES`, and the owner's uid,
through the same mount, connects and is answered `hello`. Seeded, a socket in a 0777 directory is reached
by the other uid, and the probe fails (`tools/devkit/test/other-account-socket.test.mjs`, skipped where
Docker cannot run it). What this does not cover: a second account with a login session, and hosts where
Docker remaps uids (the probe refuses to run there).

**Upgrading with a loose override.** An install whose `ARCHER_STATE_DIR` or `ARCHER_SOCKET` directory
is group- or world-accessible (for example 0755) no longer starts. The service log and the front door
say `the state directory <dir> is readable by others; run: chmod 700 <dir>`, or the same for the
socket's directory, and nothing in the directory is changed. Archer's own default directory
(`$XDG_STATE_HOME/archer`, else `~/.local/state/archer`) is still created 0700, and an older loose
copy of it is still tightened.

## 4. Smaller limits

- File dates and existence checks use `stat` by name. They return no bytes.
