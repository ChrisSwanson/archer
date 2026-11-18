// The `archer` command line. Kept apart from the entry file so it runs
// in-process under test, against a fake terminal.
import { configureWritePolicy, WriteRuleDenied } from "../config/write-policy.ts";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { printable } from "../terminal/printable.ts";

import { version } from "../version.ts";
export { version };

export interface Io {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly isTTY: boolean;
  readonly columns: number | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Where a project is looked for and relative paths start; the process's own by default. */
  readonly cwd?: string | undefined;
  /** JSON operation input; defaults to bounded process stdin. */
  readonly stdin?: () => Promise<string>;
  /** The question a person answers at this terminal (setup_network_access); detected from the process by default. */
  readonly askAtTerminal?: (question: string) => Promise<"yes" | "no">;
}

const USAGE = `usage: archer init [dir] [--docs]
       archer list
       archer validate <name|file> [--json] [--suggest | --no-suggest]
       archer measure <name|file> [--states full,collapsed] [--nested --open ids] [--canvas WxH] [--source file] [--json|--verbose]
       archer measure --project [--json]
       archer compile <name|file>
       archer draw <name|file> [--width N] [--color|--no-color]
       archer draw --model <file.json> [--width N] [--color|--no-color]
       archer emphasis list [viewId] [--json]
       archer emphasis set --file <set_emphasis.json> [--json]
       archer emphasis clear <viewId> <emphasisId> [--json]
       archer walkthrough list <viewId> [--json]
       archer walkthrough show <viewId> <id> [--json|--markdown]
       archer walkthrough write <viewId> (--file <walkthrough.json>|--stdin) [--expected N] [--json]
       archer walkthrough delete <viewId> <id> [--expected N] [--json]
       archer tools [operation] [--json]
       archer docs [surfaces|authoring|cli|mcp|admin|docs-mode|walkthroughs|supported-mermaid] [--json]
       archer docs index [--write] [--check] [--json] [question]
       archer call <operation> [--file <args.json>|--stdin] [--source <file.mmd>] [--json|--format text|json] [--output <export-file>]
       archer present [name] [--file <args.json>|--stdin] [--json]
       archer projects [--json]
       archer listen [--claim] [--as ID] [--json]
       archer wait [--as ID] [--timeout SECONDS] [--json]
       archer inbox [--brief] [--as ID] [--json]
       archer inbox --brief --hook claude-code|codex
       archer skill [--references] [--write DIR]
       archer doctor
       archer pair [--json]
       archer network-access [on|off] [--host HOST] [--json]
       archer mcp
       archer serve [--foreground [--port N] [--service NAME] [--page FILE]
                     [--tls-cert FILE --tls-key FILE | --force-http]]
       archer stop [--stale [--include-main]]
       archer status [--json]
       archer preferences [set instances <ask|reuse-main|reuse-any> [--note TEXT]]
       archer restart
       archer tls setup --host HOST [--directory NEW-ABSOLUTE-PATH]
       archer --version

init      make this directory an Archer project: archer.toml, the Archer folder
          (.archer/ by default) and a pointer to it in AGENTS.md and CLAUDE.md;
          --docs also turns docs mode on (mode = "docs"), with no stub files
list      the diagrams and notes in the Archer folder, with compile status
validate  check a diagram: file:line:col code message, with the fix as a hint;
          --json prints one JSON value (diagnostics, and lint as present has it);
          an existing view lists up to 5 ids other views already spell differently;
          --suggest lists them all, --no-suggest none
measure   inspect source layout, reading-screen spans and non-blocking suggestions;
          --project explicitly measures admitted inventory; never starts the service
compile   print a diagram's envelope (its view and model) as JSON
draw      draw a diagram, or a compiled graph model, as a box drawing
emphasis  discover, replace or clear named highlights using the MCP payload;
          list prints JSON and never starts the service
walkthrough  list, show, write or delete a diagram's numbered step-by-step walkthroughs;
          show --markdown prints one as prose; none starts the service
tools     discover operations; name one to see its complete input schema
docs      list shared guidance, or read a named guide offline; --json lists metadata.
          docs index: route a question to the doc pack, print its router (index.md),
          --write regenerate it, --check report pack health and exit 1 on a failure
call      execute any operation through the shared application layer
present   show a diagram (or, with no name, the project) in Archer's page and print its link,
          only after checking the page loads; otherwise it names the file to point at instead
projects  the projects attached to the running Archer, with their pages
listen    who listens for the person's messages in this checkout; --claim makes this agent
          session the listener and prints exactly what it claimed and its agent id
wait      wait for the person's next message in Archer, print it and exit (run it in the
          background and again after each message; while it runs, the listener is live)
inbox     the person's messages waiting in Archer; --hook is the turn-start hook: it prints
          one line or nothing, always exits 0 and never starts Archer
skill     print the Archer skill this CLI ships (--references adds its references), or
          --write it as a folder
doctor    check that this CLI runs, the service and its page are reachable from here and the
          installed skill matches; each failure says what to tell the person
pair      issue a short single-use code to type at Archer's address on another device
          (a phone, another computer) instead of carrying a link; needs a running service
network-access
          open Archer to your other devices over HTTPS: make a local certificate, update
          ~/.config/archer/archer.toml (other settings kept), restart Archer, and print the
          address, a pairing code and how to trust the certificate; it asks you first, at
          a terminal only (an agent cannot answer for you); off serves only this computer again
mcp       relay MCP on stdin and stdout to the running Archer service, for this directory's
          project (it starts the service when needed); MCP is opt-in, the CLI does the same
serve     start the local Archer service if it is not running, and print this
          project's page; --foreground runs it in this process
stop      stop the local Archer service; --stale stops abandoned copies instead: isolated
          and idle, state directory gone, or an older version (the main one only with
          --include-main)
status    list every running copy of Archer: main or isolated, version, age, idle time
preferences  show or set the flags in ~/.archer/preferences.md, the person's notes for
          agents; set appends a dated line
restart   replace the running service with this installation, preserving its
          address and projects; briefly pauses connections
tls       explicitly provision local certificates and print browser trust instructions

A diagram is named by its path, its view id in archer.toml, its file name without .mmd, or,
embedded in a note, <note path>#<name> (or its bare name). Diagram sources stay inside the Archer folder; export --output writes the chosen file.
`;

export class UsageError extends Error {}

/** Text from a person or a file, made safe for a terminal line by line. */
export const safe = (text: string): string => text.split("\n").map(printable).join("\n");

/** Runs one command line; resolves to the exit code. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  // The account rules (ADR 0013) come from the environment this command runs in.
  const endWritePolicy = configureWritePolicy({ env: io.env });
  try {
    return await runCommand(argv, io);
  } finally {
    endWritePolicy();
  }
}

async function runCommand(argv: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "--version" || command === "-v") {
      io.stdout(`${version()}\n`);
      return 0;
    }
    if (command === "--help" || command === "-h" || command === "help" || command === undefined) {
      io.stdout(USAGE);
      return 0;
    }
    if (command === "call") return await (await import("./operations.ts")).runCall(rest, io);
    if (command === "pair") {
      const { values } = usage(() =>
        parseArgs({ args: [...rest], strict: true, allowPositionals: false, options: { json: { type: "boolean" } } }),
      );
      return await (await import("./operations.ts")).executeOperation(
        "issue_pairing_code",
        {},
        io,
        values.json === true,
      );
    }
    if (command === "network-access") {
      const { values, positionals } = usage(() =>
        parseArgs({
          args: [...rest],
          strict: true,
          allowPositionals: true,
          options: { yes: { type: "boolean" }, host: { type: "string" }, json: { type: "boolean" } },
        }),
      );
      if (values.yes !== undefined)
        throw new UsageError(
          "network-access has no --yes: it asks you at a terminal, so an agent cannot answer for you. Run  archer network-access  in your own terminal",
        );
      if (
        positionals.length > 1 ||
        (positionals[0] !== undefined && positionals[0] !== "on" && positionals[0] !== "off")
      )
        throw new UsageError("network-access takes on (the default) or off");
      const off = positionals[0] === "off";
      return await (await import("./operations.ts")).executeOperation(
        "setup_network_access",
        off ? { enabled: false } : { ...(values.host === undefined ? {} : { host: values.host }) },
        io,
        values.json === true,
      );
    }
    if (command === "tools") return await (await import("./operations.ts")).runTools(rest, io);
    if (command === "inbox" && rest.includes("--hook")) {
      // The turn-start hook: always 0, whatever its arguments (exit 2 would block the person's prompt).
      return await (await import("./hook.ts")).runHook(rest, io);
    }
    if (command === "projects") return await (await import("./agents.ts")).runProjects(rest, io);
    if (command === "listen") return await (await import("./agents.ts")).runListen(rest, io);
    if (command === "wait") return await (await import("./agents.ts")).runWait(rest, io);
    if (command === "inbox") return await (await import("./agents.ts")).runInbox(rest, io);
    if (command === "skill") return await (await import("./skill.ts")).runSkill(rest, io);
    if (command === "doctor") return await (await import("./doctor.ts")).runDoctor(rest, io);
    if (command === "present") return await (await import("./present.ts")).runPresent(rest, io);
    if (command === "docs") return await (await import("./docs.ts")).runDocs(rest, io);
    if (command === "tls") return await (await import("./tls.ts")).runTls(rest, io);
    if (command === "emphasis") return await (await import("./emphasis.ts")).run(rest, io);
    if (command === "walkthrough") return await (await import("./walkthrough.ts")).run(rest, io);
    if (command === "draw") return await draw(rest, io);
    if (command === "measure") return await (await import("./measure.ts")).runMeasure(rest, io);
    if (command === "agent-surface") {
      // For `archer upgrade` (ADR 0032): a digest of the tools and instructions a session loads.
      if (rest.length > 0) throw new UsageError("agent-surface takes no arguments");
      io.stdout(`${(await (await import("../mcp/surface.ts")).agentSurface()).digest}\n`);
      return 0;
    }
    if (command === "mcp") {
      if (rest.length > 0) throw new UsageError("mcp takes no arguments");
      return await (await import("../mcp/relay.ts")).runMcp(io.env, io.cwd ?? process.cwd());
    }
    if (
      command === "serve" ||
      command === "stop" ||
      command === "restart" ||
      command === "status" ||
      command === "preferences"
    ) {
      const cli = await import("../service/cli.ts");
      try {
        return await cli[command](rest, io);
      } catch (error) {
        if (error instanceof cli.CliUsageError) throw new UsageError(error.message);
        throw error;
      }
    }
    if (PROJECT_COMMANDS.has(command)) {
      // Loaded only here, so `archer --version` does not pay for the compiler.
      const commands = await import("./commands.ts");
      return await commands.run(command, rest, io);
    }
    if (PACKAGE_COMMANDS.has(command)) {
      if (command === "setup" && (rest.includes("--help") || rest.includes("-h"))) {
        io.stdout(`${SETUP_USAGE}\n`);
        return 0;
      }
      // The package's own launcher (ts/pkg/bin/archer.mjs) handles these before this CLI runs.
      io.stderr(notAPackageInstall(command));
      return 1;
    }
    io.stderr(`archer ${printable(command)}: unknown command; archer --help lists them\n`);
    return 2;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`archer: ${printable(error.message)}\n${USAGE}`);
      return 2;
    }
    // Messages can quote arguments and file contents; they are text, never escapes. A rules
    // refusal's configuration detail is shown here: this is the account owner's own terminal.
    const detail = error instanceof WriteRuleDenied && error.detail !== undefined ? ` (${error.detail})` : "";
    io.stderr(`archer: ${safe(error instanceof Error ? error.message + detail : String(error))}\n`);
    return 1;
  }
}

const PROJECT_COMMANDS = new Set(["init", "list", "validate", "compile"]);
const SETUP_USAGE = "usage: archer setup [--mcp] [--no-claude] [--no-codex]";
const PACKAGE_COMMANDS = new Set(["setup", "upgrade", "uninstall"]);

/** For setup, upgrade and uninstall run from a development or source install, not the package. */
function notAPackageInstall(command: string): string {
  return `archer ${command}: this Archer was installed for development (or from source), not from the package, so it cannot ${command} itself.
Install the package once, in the folder holding its .tgz (docs/install.md):
  npx --yes ./archer-${version()}.tgz setup
Setup moves a development install over to the package and keeps the running Archer's address.
After that, archer upgrade <archer-x.y.z.tgz> installs each new package.
`;
}

/** Runs an argument parse, with its complaints as usage errors. */
export function usage<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

async function draw(args: readonly string[], io: Io): Promise<number> {
  const { values, positionals } = usage(() =>
    parseArgs({
      args: [...args],
      options: {
        model: { type: "string" },
        width: { type: "string" },
        color: { type: "boolean" },
        "no-color": { type: "boolean" },
      },
      strict: true,
      allowPositionals: true,
    }),
  );
  const file = values.model;
  if (positionals.length > 1) throw new UsageError("draw takes one diagram name");
  const name = positionals[0];
  if (file !== undefined && name !== undefined)
    throw new UsageError("draw takes a diagram name or --model <file.json>, not both");
  if (!file && name === undefined) throw new UsageError("draw needs a diagram name, or --model <file.json>");
  let width = io.columns ?? 80;
  if (values.width !== undefined) {
    width = Number(values.width);
    if (!Number.isInteger(width) || width < 1)
      throw new UsageError(`--width must be a positive whole number, not "${values.width}"`);
  }
  // Colour follows the usual convention: on for a terminal, off when piped or
  // when NO_COLOR is set, and either flag overrides.
  const color = values.color === true || (values["no-color"] !== true && io.isTTY && !io.env["NO_COLOR"]);

  if (name !== undefined) {
    const commands = await import("./commands.ts");
    return await commands.drawDiagram(name, { width, color }, io);
  }
  if (!file) throw new UsageError("draw needs --model <file.json>");

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not JSON; draw reads a compiled model, not a .mmd source`);
  }
  // Loaded only here, so `archer --version` does not pay for the layout engine.
  const { readGraphInput } = await import("../terminal/input.ts");
  const { drawGraph } = await import("../terminal/draw.ts");
  const graph = readGraphInput(json);
  io.stdout(await drawGraph(graph, { width, color, title: basename(file) }));
  return 0;
}
