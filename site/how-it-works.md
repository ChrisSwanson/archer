# How Archer works

Your agent writes Mermaid and Markdown. A local service watches those files and serves the page where you explore, select, comment and edit diagrams.

## One project, several ways in

| Surface | Role |
| --- | --- |
| **Service** | Watches projects, compiles diagrams and shares presentation and feedback state. One service normally hosts all your projects. |
| **Web page** | Explore notes and diagrams, follow highlights and walkthroughs, comment and edit supported diagrams on desktop. |
| **CLI** | Discover operations with `archer tools`; run them with `archer call`. Source and documentation operations also work offline. |
| **Skill** | Teaches Claude Code and Codex to reuse diagrams and answer by showing. Setup installs it alongside the CLI. |
| **MCP** | Optional adapter to the same operations. Hosts that support MCP Apps can show diagrams inline; other hosts receive a page link. |

## Files stay beside the code

`archer init` creates `archer.toml` and `.archer/` (or your configured folder).

```text
my-project/
├── archer.toml
└── .archer/
    ├── diagrams/containers.mmd
    └── notes/checkout.md
```

Archer discovers `.mmd` files and Markdown notes there. A note can hold several named Mermaid blocks; `notes/checkout.md#flow` addresses one of them.

Mermaid records meaning. Archer compiles it for drawing and interaction. Stable element IDs keep selection, comments and emphasis attached as the source evolves.

## Discuss the picture

1. Your agent presents a diagram with a caption.
2. It highlights the parts that answer your question.
3. You select a part or leave a comment.
4. The agent reads that context, replies and updates the work.

Ask your agent to “listen to me in Archer” to continue from the page. The page shows whether it is listening, between turns or away.

## Docs mode: a small architecture pack

`archer init --docs` enables a maintained pack: intent, use cases, architecture and key flows. It sets `mode = "docs"` without creating empty templates.

The generated index routes questions to relevant files. Agents read it first, check code references and update affected docs as they change the code. Elaborations go in `notes/scratch/`; structural proposals go in `notes/proposals/`, marked as proposed.

```sh
archer docs index "How does a request reach storage?"
archer docs index --write --check
archer docs docs-mode
```

## Access from another device

Archer serves loopback by default. For a phone or another computer, enable network access, trust its local certificate and use a pairing code or revocable access link.

[HTTPS & Browser Trust](/security/network-access) covers setup and fixes. [Usage](/usage) walks through a first conversation.
