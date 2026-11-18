# Use Archer with another agent

`archer setup` wires Archer into Claude Code and Codex. Any other coding agent (Cursor, OpenCode,
Aider, a terminal agent of your own) can use it with two steps, and a loop for hearing you back.
Run them on the computer where the agent runs, after [installing Archer](/install).

## 1. Give the agent the tools

The `archer` command works from any shell the agent has. If your agent speaks MCP, register Archer
as an MCP server too, so its tools appear natively:

- Command: `archer`, arguments: `mcp` (stdio). In most harnesses that is one entry in their MCP
  settings, or one line such as `<harness> mcp add archer -- archer mcp`.
- `archer mcp` serves the project of the directory the agent starts in, and starts Archer when needed.

## 2. Give the agent the skill

The skill tells the agent when to draw and how. Write it into the folder where your harness looks
for skills, in a folder named `archer`:

```sh
archer skill --write <your harness's skills folder>/archer
```

If the harness has no skills, put the output of `archer skill --references` where it keeps standing
instructions (an `AGENTS.md`, rules file or system prompt). Run `archer doctor` afterwards: it
checks the command, the service and its page. Its skill check looks only in Claude Code's and Codex's
folders, so for another agent it reports the skill as missing even when you wrote it; the other checks
still apply. After upgrading Archer, run the same `archer skill --write` again so the copy matches.

## Hearing you back without background tasks

Archer's page has a comment box. An agent that can run a command in the background starts
`archer wait`, which ends when you send a message. Harnesses without background tasks poll instead:

```sh
archer listen --claim          # once per session: becomes this checkout's listener; prints an agent id
archer inbox --brief           # at the start of every turn: one line saying whether messages wait
archer wait --timeout 50       # or: block up to 50 seconds for the next message, then print it
```

- Run `archer inbox` to read the waiting messages and answer them with `archer call reply_comment`
  (`archer tools reply_comment` shows its arguments).
- `wait` exits 0 when a message arrives and also when `--timeout` runs out. Start it again either way.
  Keep `--timeout` below the harness's own command limit.
- When a command is run from a shell the harness detaches from your agent, Archer cannot tell which
  session it belongs to. `archer listen --claim` then prints an agent id: pass it as `--as <id>` to
  `archer wait` and `archer inbox`.
- `archer listen` shows who listens in this checkout.
