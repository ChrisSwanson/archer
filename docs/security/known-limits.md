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

**What an attacker needs.**
- Write access to a directory inside the project, on the path being read or written. That means the
  same account as Archer, or an account the project folder is shared with.
- The ability to swap that directory for a link to an outside folder and back, several times, inside
  the few syscalls between Archer's walk, its open or create, and its re-walk. That means a racing
  local process and repeated attempts. One request gives the attacker one chance.
- For a read, a singly linked file outside the project that the Archer user can read, at the same
  name. For a write, an outside folder the Archer user can write to.

**What they get.**
- Read: the outside file's bytes are returned to whoever made the request (an agent, or a page grant
  holder).
- Write: Archer's temporary file is created in the outside folder (7 temporaries in one scheduled
  run). It can be renamed over an outside file of the same name, with Archer's bytes. No overwrite was
  seen in that run, but the design does not rule one out.
- The change store and review artifacts (since 0.14.1) check the parent before each create and prove it
  holds the new file before writing a byte, so a swap that wins the window leaves at most an empty
  temporary or an empty `snapshots` / `.review` folder outside. Cleanup removes only what a still-bound
  parent holds.

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
