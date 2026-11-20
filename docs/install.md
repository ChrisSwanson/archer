# Install Archer

Requires **Node 22.18 or newer** (`node --version`). Install on the computer where your coding
agent runs. Archer ships through [GitHub Releases](https://github.com/chrisswanson/archer/releases);
it is not on the npm registry.

## Install with npx

```sh
npx -y https://github.com/chrisswanson/archer/releases/latest/download/archer.tgz setup
```

## Install with curl

The installer checks Node, downloads the release, verifies its SHA-256 checksum, and runs setup.
It needs `curl` and either `sha256sum` or `shasum`; it never uses sudo.

```sh
curl -fsSL https://chrisswanson.github.io/archer/install.sh | sh
```

To choose a version or pass setup options:

```sh
curl -fsSL https://chrisswanson.github.io/archer/install.sh | ARCHER_VERSION=0.15.2 sh -s -- --mcp
```

## Windows (WSL)

On Windows, install and run Archer inside WSL (Windows Subsystem for Linux). Native Windows is
not supported: the installer is a POSIX shell script, and setup writes the Unix paths your agent
uses there.

1. In PowerShell, run `wsl --install` (Ubuntu by default), then open the Ubuntu terminal.
2. Install Node 22.18 or newer inside Ubuntu, and run your coding agent there too.
3. Run either install command above in that terminal.

## Install manually

Download and verify the package before running setup:

```sh
curl -fLO https://github.com/chrisswanson/archer/releases/latest/download/archer.tgz &&
curl -fLO https://github.com/chrisswanson/archer/releases/latest/download/SHA256SUMS &&
awk '$2 == "archer.tgz"' SHA256SUMS | sha256sum -c - &&
npx --yes ./archer.tgz setup
```

On macOS, replace `sha256sum -c -` with `shasum -a 256 -c -`. Continue only if verification says
`archer.tgz: OK`.

<details>
<summary>Build from source</summary>

```sh
git clone https://github.com/chrisswanson/archer.git
cd archer
npm ci
npm --workspace ts run package
npx --yes ./dist/archer-<version>.tgz setup
```

The package step prints the filename and checksum. Replace `<version>` with that version.

</details>

## What setup changes

- Installs versioned files under `~/.local/share/archer` and the command in `~/.local/bin`.
- Links the Archer skill into Claude Code and Codex.
- Adds turn-start hooks so agents receive messages written in Archer; keeps your other hooks.
- Registers MCP when you pass `--mcp`, or preserves an existing registration.
- Keeps replaced versions while running sessions still use them.

Use `--no-claude` or `--no-codex` to leave that host alone. Setup can be run again safely.
Follow its **Still to do by hand** list: it names settings it could not update and any host to install.
If the command is missing from your PATH, add this to your shell profile and open a new terminal:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

## First run

```sh
cd your-project
archer init
archer --version
```

Start Claude Code or Codex in that folder and ask: *“Draw this project's containers as a C4 diagram
and show it to me.”* The agent saves the diagram in `.archer/` and gives you the page link.
To receive your messages from the page immediately, ask it to *“listen to me in Archer.”*

The page works locally without configuration. For another device, see
[HTTPS & Browser Trust](tls.md). [Usage](../site/usage.md) covers the review loop.

## Upgrade

Download and verify the new package using the manual steps, then run:

```sh
archer upgrade ./archer.tgz
```

Archer warms the new service before switching; open pages reconnect, and setup reports whether
agent sessions need restarting. Your diagrams, notes, and settings stay in place.
For an older build without `upgrade`, run the install command again, then `archer restart`.

## Uninstall

```sh
archer stop
archer uninstall
```

Removes installed files, skill links, and Archer's hooks and MCP entries. Keeps project files,
`~/.config/archer`, `~/.local/state/archer`, and `~/.archer` preferences.
