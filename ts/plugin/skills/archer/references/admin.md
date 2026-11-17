# Archer administration

Open this only for setup, access or upgrade work; everyday use is in the skill and [CLI](cli.md).

## Setup, the skill and the turn-start hook

`archer setup` installs Archer for this account: the `archer` command, the skill (linked, or copied
where a host does not follow links) for Claude Code and Codex, and one Archer-owned turn-start hook,
`archer inbox --brief --hook claude-code` (or `codex`), that shows "N messages from the person in
Archer" at the start of a turn, counting only what would reach that session; a session Archer does
not know as an agent sees nothing. The hook prints one line or nothing, always exits 0 and never
starts Archer. `--no-claude` and `--no-codex` skip a host; `--mcp` also registers the MCP server `archer`
([MCP](mcp.md)). `archer uninstall` removes only Archer's own entries.

`archer doctor`, run from the agent's own session, checks that the CLI runs, the service and its page
are reachable from there, and that the installed skill is this CLI's. Each failure ends in a line
"Tell the person: …": say exactly that. `archer skill` prints the skill this CLI ships
(`--references` adds these references); `archer skill --write <dir>` writes the folder, for a host
that has none installed. A changed skill is loaded only by a new session.

## Browser links and HTTPS

Discover `issue_access_link`, `list_access_links` and `revoke_access_link` individually. Issuance
requires a running service and a short label; its result contains a secret returned once and a
query-token URL. Share the URL privately. Opening it establishes a remembered HttpOnly cookie and
redirects to a clean route. Listing returns IDs/metadata only. Revoke by grant ID; other grants stay
valid. Do not automatically repeat issuance if the response is lost: list metadata first and issue
a replacement only when needed. Browser credentials cannot issue grants. To let the same new link
also edit diagrams, pass `authoringProjectRoots` with the exact roots from `list_projects`; omit it
for a read/comment link. If the authoring entitlement cannot be recorded, no link is returned.

`issue_pairing_code` (CLI: `archer pair`; it starts the service if needed) returns the base address, which carries no secret, and an
8-character code such as `7KQ4-M2XD`. The person opens the address and types the code; it works
once, for `pairing_code_minutes` (default 5), and makes a new grant labelled "Paired …" that
`list_access_links` shows and `revoke_access_link` ends. Give the address and the code exactly. A
restart voids unused codes; after too many wrong tries every live code is void, so issue a new one.

On this computer the page is plain HTTP on 127.0.0.1 with no setting (the link never leaves the
machine). For another device, ask the person once, then `setup_network_access` with
`personConfirmed: true`. The CLI form, `archer network-access [--host <LAN IP or name>]`, is the
person's: it asks at their terminal and refuses in an agent's shell. Where the client can, the tool asks the person itself and their
answer decides. It makes (or reuses) a local CA and certificate, binds the LAN address only, merges
`host`, `force_http`, `tls_cert` and `tls_key` into the global `[service]` table (other settings kept,
the old file backed up), restarts Archer on HTTPS and returns the address, a pairing code and the
CA-trust step, which only the person can do on the device. `enabled: false` (`archer network-access
off`) serves only this computer again. A setup or access refusal carries a stable `code` and a `fix` (tool, command, whether it
needs the person's yes): follow it. Never send private keys or the TLS directory; never change trust
stores. Project config cannot control TLS. Pages opened over HTTP must be reopened at the new address.

A readable-output-limit receipt means the operation completed but its text projection was refused.
Read the current state with JSON for complete details; do not repeat a mutation to obtain another
format. The shared API keeps full structured data even when its readable projection is limited.


## Running copies and preferences

Front doors use the main Archer (the default state directory) when it answers and is current. A
caller with its own `ARCHER_STATE_DIR` always gets its own copy. An older main build, one speaking
another protocol, or a copy running on another default state directory is refused as
`instance_choice_needed`, listing the copies and the command for each option. Ask the person, run
the command for their choice, and retry. `archer preferences set instances ask|reuse-main|reuse-any
--note "…"` records it in `~/.archer/preferences.md`, whose body holds the person's notes for agents;
a project's `.archer/user_preferences.md` wins for that project. `archer status` lists the running
copies; `archer stop --stale` stops abandoned ones (never the main one without `--include-main`).
An isolated copy stops itself after 30 idle minutes (`ARCHER_IDLE_TIMEOUT_MS`), any copy when its
state directory is removed.

## Startup and recovery overrides

`ARCHER_AUTO_START=false` refuses implicit startup; explicit `start_service` or `archer serve`
still starts the service. `ARCHER_RESTORE_STATE=false` starts with no restored attachments/context
without deleting saved state. `ARCHER_OPEN_BROWSER=auto|always|never` defaults to auto: a detected
graphical session opens a browser on an explicit presentation, while headless, SSH and CI stay
quiet. Recovery does not open a browser. Binding defaults to localhost; an explicit LAN bind also
needs a certificate covering the advertised browser host/IP. These options control on-demand
behavior, not OS-login startup.

## Upgrade and restart (hot swap)

`archer upgrade <archer-x.y.z.tgz>` installs a package and hot swaps the running main Archer to it;
`archer restart` does the swap alone, after a manual install. The new version starts warm, then takes
over the same address, token and attached projects (gap well under a second); a replacement that
cannot start leaves the running service as it was. Calls during the swap wait for it. Open pages
reconnect and reload themselves to the new version unless something is being edited. Restart your
own session only when upgrade says so, or when a result says a newer Archer is running. It does not
attach the caller's directory. Do not issue stop/start commands instead. No mutation is
automatically retried; a lost write reply may have committed, so verify current comments before
resubmitting.
