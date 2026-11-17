# Archer

Archer shows agent-authored Mermaid diagrams to the person working with an agent, and keeps them in
the project as reference. A project's diagrams and notes live in its Archer folder (`.archer/` by
default); a local service serves them to a browser page where the person reads, selects and
comments, and the agent reaches the same diagrams over MCP or the `archer` CLI.

The product is the TypeScript implementation in [`ts/`](ts/README.md). It replaced an earlier Rust
implementation (release 0.3.0); its `CHANGELOG.md` entries stay here as history.

Agents changing Archer's implementation should begin with [`AGENTS.md`](AGENTS.md). Claude-compatible environments can use
[`CLAUDE.md`](CLAUDE.md) as the short entry point. What changed in each release is in
[`CHANGELOG.md`](CHANGELOG.md); contributing is in [`CONTRIBUTING.md`](CONTRIBUTING.md).

To author diagrams with an installed Archer, start with the [Archer skill](ts/plugin/skills/archer/SKILL.md)
and its [authoring workflow](ts/plugin/skills/archer/references/authoring.md) in the intended project.
The same references are available as MCP resources `archer://docs/authoring` and
`archer://docs/cli`; `archer docs` lists offline CLI access, including `archer docs supported-mermaid`.
Use the needed reference through either path; reading both copies is unnecessary.
New discussion diagrams can live together in a Markdown note under its configured Archer folder;
embedded views need no manifest or separate attachment step. The bootstrap/build commands below
are for developing this implementation; an existing installation can author and present directly.

## Layout

- `ts/`: the product. Mermaid compile, the MCP server, the CLI, the local service, export, and the
  Claude plugin (`ts/plugin`). The accepted Mermaid is [`ts/docs/supported-mermaid.md`](ts/docs/supported-mermaid.md).
- `ui/`: the browser page and the MCP App, two builds of one page (`npm run build`): `ui/dist/` is
  the web page the service serves, `ui/dist/mcp/index.html` the MCP App's single file. The MCP App is
  also checked in as `ts/assets/archer-mcp-app.html`, and `ts/` bundles the export painter, theme and fonts.
- `shared/`: note Markdown rendering used by both.
- `schema/`, `fixtures/`: the diagram envelope schema and the golden and protocol fixtures both
  halves test against.
- `fixtures/`, `ts/test/fixtures/`: diagram and project corpora used by the test suites.

## Frontend architecture

Build the web app with a **shared Application Shell (App Shell)** and **component composition**.
The shell owns common layout and workspace behavior; pages supply identity, content and local tools.
Use explicit scope/capability policy and stable shared-state identity so navigation, Notifications,
Settings, Help and recovery remain consistent across routes. A design system supplies the shared
visual primitives. Embedded MCP mode and read-only source permissions retain their intended limits.

## Bootstrap and verify

Requires Node 22.18 or newer.

```sh
npm ci
npm run typecheck                      # ui
npm test                               # ui (jsdom)
npm run build                          # ui/dist
npm --workspace ts run typecheck
npm --workspace ts test
npm --workspace ts run bundle          # ts/dist: runs with `node ts/dist/archer.js`
npm --workspace ui run test:browser:ts # Chromium against the TypeScript service
```

`npm run lint` is the same command as `npm run typecheck` (`tsc --noEmit`), so it is listed once.
The browser suite needs `npm run build` first and a browser installed once
(`npx playwright install chromium`). CI (`.github/workflows/ci.yml`) runs the same gates.
On Linux hosts with unrelated interface churn, the same browser gate can run in an explicit
private loopback namespace.
This alternate environment retains all assertions; it does not validate external networking.

## Run

```sh
npm run build
npm --workspace ts run bundle
node ts/dist/archer.js --help
```

The bundler, the package and a service run from this checkout use the UI build (`ui/dist/index.html`
with its ELK worker in `ui/dist/page-assets/`, and the MCP App's single file `ui/dist/mcp/index.html`);
none of them rebuilds the UI. Without a build the bundle refuses, and a service started from the
checkout logs that its page is missing and to run `npm run build` (its page requests fail until then).
After UI changes, build the page first as above. The MCP App a checkout offers its MCP clients is the
checked-in `ts/assets/archer-mcp-app.html`: when shipping UI changes, refresh it with
`cp ui/dist/mcp/index.html ts/assets/archer-mcp-app.html`. To install from a checkout, build the
package (`npm --workspace ts run package`) and install or upgrade with it as
[docs/install.md](docs/install.md) says; `scripts/ship.sh --to <ssh-host>` does that on another machine.

New services use native HTTPS. Run `archer tls setup --host <browser-host-or-LAN-IP>` to explicitly
provision local certificates, then follow [certificate and browser trust setup](docs/tls.md).
Merge its printed certificate paths into global configuration before starting; no trust stores or
configuration are edited automatically. Plain HTTP requires the explicit `force_http` override.
For private browser links, discover `issue_access_link`, `list_access_links`, and
`revoke_access_link` through `archer tools`. Grants cover all attached projects, survive restart
and remain valid until individually revoked. Opening an issued link removes its token from the URL
and remembers browser access. The HTTPS migration requires one deliberate trust/open step.

### Editing diagrams in the browser

Any Archer link or pairing code lets the person in the browser create and edit diagrams; there are
no separate editing links. One setting turns it off: `edit = false` at the top of an `archer.toml`.
The project's file wins over the account's (`~/.config/archer/archer.toml`), and it is on by default.
With it off, New and Edit are greyed out with a tooltip naming the file, and Settings shows "Editing in
the page: Off" and where that came from. The page cannot change it; edit the file, or ask your agent
to. It applies only to the browser: agents can still change diagrams.

**New → Diagram** on a project, folder, diagram or note page opens the editor
for a new `.mmd` file, and **Edit** on a diagram edits it in place. Flowchart, sequence, C4
container, state and entity-relationship diagrams have a parts bar: add a part, drag from one part
to another to connect them, double-click to rename. Other types, such as architecture and journey,
are edited as Mermaid source beside the live drawing. **Save** updates the original or creates the
new file; **Cancel** discards unsaved work. Drafts and proposals are secondary actions. Editing is
on desktop; phones are view-only. Notes are not edited in the browser.

Repeated canonical Saves retain one baseline-to-current review until an agent explicitly clears its
current revision with an understanding summary. The service derives ignored `.review/*.diff` files
under the configured authoring folder. Agent tools `list_changes`, `read_change` and `resolve_change`
read exact saved snapshots separately from current disk. Private storage has explicit lifetime
limits; status exposes usage and refuses new work at capacity without pruning history. Preserve
private state; safe retention/rotation is future work.

After installing a compatible build, run `archer restart` to replace the running backend.
It checks the replacement first, preserves the running listener configuration and projects,
waits for the previous service locks to be released, and verifies the restored URL and inventory.
A service that refuses the restart is left running. A replacement that cannot reclaim the port fails rather than moving
existing links. Open pages reconnect and synchronize automatically; refresh to load newly installed
UI code, after keeping unsaved text. Existing agent sessions still need a restart for new MCP tools
and skills. This is a brief backend restart, not zero downtime or mutation replay.

Browser protocol compatibility is versioned independently of the application.


The regular browser gate uses Chromium. For reported Firefox sidebar or flow-animation issues,
install Firefox once with `npx playwright install firefox`. Linux hosts also need Firefox's
system dependencies (`npx playwright install-deps firefox`). Then run the focused production flows:

```sh
npm --workspace ui run test:browser:ts -- --browser=firefox --workers=1 emphasis-motion.e2e.ts recovery.e2e.ts sidebar-hover.e2e.ts sidebar-projects.e2e.ts
```

Browser validation applies to the tested operating system; passing Linux checks do not establish
that a Windows-specific rendering issue is fixed.

Commands, MCP tools and the service are described in [`ts/README.md`](ts/README.md).
