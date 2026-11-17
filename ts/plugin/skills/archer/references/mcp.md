# Archer over MCP

MCP is an opt-in adapter over the same operations as `archer call`: each tool is the operation of the
same name with the same arguments and results. Use the CLI unless the person set MCP up or the host
has no shell. `archer setup --mcp` registers one server, `archer`, for Claude Code and Codex.

- **What MCP adds.** In a host that renders MCP Apps (web chat), `present_diagram` and
  `set_emphasis` draw the diagram inline; elsewhere they return the browser URL. Resources
  `archer://docs/<guide>` serve the same guides as `archer docs`. `setup_network_access` asks the
  person in the client's own prompt where the client can (elicitation); the CLI asks at their
  terminal instead. Results may end with a short note of the person's saved changes.
- **The relay.** `archer mcp` is a thin relay to the one running Archer service: the tools live in
  the service, so an upgrade's hot swap reaches every session at once, and the relay tells the
  client `notifications/tools/list_changed` when the tool list changed. A host that does not
  refresh on that keeps its old tool list until the session restarts; say so only when a tool you
  need is missing. A call cut by a restart fails with "outcome unknown": check before retrying (a
  write may be done; read the thread or diagram first); it is never sent again. After `archer stop`
  the relay starts Archer again only for your next tool call or read, never for a ping. The relay registers this session as an agent, so
  `archer listen --claim` here claims as it.
- **Older tools.** When a result says a newer Archer is running than the session's, or a tool the
  CLI has is missing, use the CLI: it is current.
- **A refused relay.** Against an older service the relay serves the tools itself, in its own
  process, as before; `archer restart` moves the service to this installation.

`measure_diagram` is the same read-only operation as `archer measure`. Discover its schema, then
request a `viewId` (a named note figure uses `notes/topic.md#name`) or `project: true`. Optional
`source` measures candidate bytes without writing; `expectedRevision` guards saved source.
Default states are full and, for a grouped graph, collapsed. Explicit states use
`{"mode":"full"}` or `{"mode":"nested","open":["boundary_id"]}`; at most eight. Nested states
start fresh, opening parents before children, then ids. Unknown or unreachable ids are refused.

The default desktop canvas is 1025×896 with 24px padding per side, Fira and source presentation.
`viewport.canvas` and `viewport.padding` supply an explicit comparison. The report identifies
revisions, engine, typeface and state, bounds, readable screen spans, fit and overflow. Private saved
positions and live expansion history can differ. Sequence/journey diagrams reject nested states;
journey results measure the static export board and have null camera fields and no camera advice.
See [CLI](cli.md#measure-a-layout) for examples and [authoring](authoring.md#review-the-reading-layout)
for interpretation.

Validate/write results may add `layoutReview` without changing their existing contract. Its
`suggestions` are layout advice; validate's top-level `suggestions` remain ID renames. Advice never
changes validity or blocks a write. A cold persistent-session review may be `pending` after 150ms;
run `measure_diagram` with its `inspect.arguments` to get facts, since completion is not pushed
later. One-shot CLI validate/write instead waits within the analysis deadline before teardown.
Explicit measurement
waits within 5s and returns `ready`, `partial` or `unavailable`; absent geometry is never a zero-sized
success. Candidate inspection must use the same candidate source. No layout finding enters inbox
delivery or wakes an agent. If an older service lacks this operation, use the current CLI or
restart the service; a missing tool is not evidence that the diagram fits.
Optional `notes` are informational, separate from layout suggestions: small fit text below the
12px reading floor can still require zooming in when no suggestion threshold was exceeded.
