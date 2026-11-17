# Use Archer with your agent

[Install Archer](/install), then open a terminal in the project you want to understand.

## Start a project

```sh
cd your-project
archer init
archer doctor
```

Start Claude Code or Codex in that folder and ask:

> Draw the containers of this project as a C4 diagram and show it to me.

The agent writes the source and returns a page link. Open it to explore, select parts and comment. Use `archer init --docs` for a [maintained architecture pack](/how-it-works#docs-mode-a-small-architecture-pack).

## Connect the agent

Setup installs the skill and CLI for Claude Code and Codex. Check the installation with `archer doctor`; read the installed guidance with `archer skill --references`.

The agent can discover and run operations from the project directory:

```sh
archer tools read_diagram --json
printf '%s' '{"viewId":"containers"}' | archer call read_diagram --stdin --json
```

For an MCP host, run `archer setup --mcp`. It registers the `archer mcp` relay with the same operations. Hosts that support MCP Apps can show diagrams inline.

## Present a diagram

```sh
archer list
archer present containers
archer present notes/checkout.md#flow
```

Use a name from `archer list`. `present` checks the page before printing its link. Diagrams can live in `.mmd` files or named blocks inside a note.

## Highlight the answer

> Show me where authentication happens. Highlight the request path on this diagram.

The agent reads the element IDs and adds emphasis. A **flow** follows a path; a **highlight** marks a set of parts. Labels explain each group. Emphasis leaves the source intact.

```sh
archer emphasis list containers --json
archer emphasis clear containers request-path --json
```

Use the emphasis ID returned by `list`.

## Comment and keep talking

Select a diagram part or note passage and leave a comment. The agent reads its context, replies and can resolve the thread.

For a conversation from the page, ask:

> Listen to me in Archer.

The agent claims this checkout and waits for messages. The page shows who receives them and whether that agent is between turns.

## Save a walkthrough

Ask for a saved walkthrough to keep a step-by-step explanation. Readers can replay numbered steps, link to a step and comment on it. Archer flags affected steps when the diagram changes.

```sh
archer walkthrough list containers --json
archer walkthrough show containers checkout --markdown
```

Use an ID from `list`. Walkthroughs support flowchart, C4, state, ER and architecture diagrams. Sequence and journey diagrams use emphasis instead.

## Validate and export

```sh
archer validate containers
archer docs supported-mermaid flowchart
archer tools export_diagram --json
```

Export SVG or PNG through `archer call export_diagram --file export.json --output diagram.svg`. Use the schema returned by `tools` to set the view, format, theme and revision guards. See [call](/generated/cli#call) in the CLI reference.

[Supported Mermaid](/supported-mermaid/) · [Using the Playground](/using-the-playground)
