import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

interface Entry {
  purpose: string;
  examples: string[];
  notes?: string;
}

// Editorial facts live here; syntax and flags come from the CLI below.
const entries: Record<string, Entry> = {
  setup: {
    purpose: "Install Archer, its skill and turn-start hooks for Claude Code and Codex.",
    examples: ["npx --yes ./archer.tgz setup", "archer setup --mcp"],
    notes: "Requires Node 22.18 or newer. Open a new terminal after the first install. MCP registration is optional.",
  },
  upgrade: {
    purpose: "Install a downloaded release and replace the running service at its existing address.",
    examples: ["archer upgrade ./archer-0.15.0.tgz"],
    notes: "Keeps the previous installation. Restart agent sessions if the command reports a changed skill.",
  },
  uninstall: {
    purpose: "Remove the installation, skill links and managed agent configuration.",
    examples: ["archer stop", "archer uninstall"],
    notes: "Preserves diagrams, configuration and service state. Stop the service before uninstalling.",
  },
  init: {
    purpose: "Create the project manifest, Archer folder and agent pointers.",
    examples: ["archer init", "archer init --docs"],
    notes:
      "Uses .archer/ by default. Docs mode enables a maintained architecture pack without generating empty templates.",
  },
  list: {
    purpose: "List this project's diagrams, embedded figures and notes with compile status.",
    examples: ["archer list"],
  },
  validate: {
    purpose: "Check a diagram and report diagnostics, advice and identity suggestions.",
    examples: ["archer validate containers", "archer validate notes/checkout.md#flow --json"],
    notes:
      "Exits 1 on errors; warnings and advice do not fail validation. Existing views show up to five rename suggestions by default. Read again after a revision conflict.",
  },
  compile: {
    purpose: "Print the diagram envelope and model as JSON.",
    examples: ["archer compile containers > containers.json"],
  },
  draw: {
    purpose: "Render a diagram as a terminal box drawing.",
    examples: ["archer draw containers --width 100", "archer draw --model containers.json --no-color"],
    notes: "Color follows the terminal and NO_COLOR unless overridden.",
  },
  measure: {
    purpose: "Inspect source layout and reading size without starting the service.",
    examples: [
      "archer measure containers --states full,collapsed --json",
      "archer measure containers --nested --open backend --canvas 1025x896",
    ],
    notes:
      "Measures source layout, excluding saved positions and live expansion history. An empty suggestions list does not establish readability; inspect fit text and informational notes. Use --project for admitted inventory.",
  },
  tools: {
    purpose: "List operations, or print one operation's complete input schema.",
    examples: ["archer tools", "archer tools read_diagram --json"],
  },
  call: {
    purpose: "Run an operation through the same application layer used by MCP.",
    examples: [
      "printf '%s' '{\"viewId\":\"containers\"}' | archer call read_diagram --stdin --json",
      "archer call export_diagram --file export-args.json --output diagram.svg --json",
    ],
    notes:
      "Discover the schema with `archer tools <operation>`. Argument input is one JSON object (maximum 2 MiB). JSON failures go to stderr as {code,message,details}; revision conflicts require a new read. --source supplies candidate Mermaid bytes without shell escaping.",
  },
  present: {
    purpose: "Show a diagram or the current project and print a verified browser link.",
    examples: ["archer present containers", "archer present notes/checkout.md#flow --json"],
    notes:
      "Finds or starts the configured service. If the page cannot load, reports the fallback file instead of claiming success. Argument files use the present_diagram operation schema.",
  },
  projects: {
    purpose: "List projects attached to the running service with their page URLs.",
    examples: ["archer projects --json"],
  },
  listen: {
    purpose: "Inspect or claim the agent session receiving this checkout's page messages.",
    examples: ["archer listen --claim --json", "archer listen --json"],
    notes: "Claim only from the intended checkout. Use the agent ID returned by the claim with --as.",
  },
  wait: {
    purpose: "Wait for the person's next page message, print it and exit.",
    examples: ["archer wait --timeout 300 --json"],
    notes:
      "Run in the background and start it again after each message. The listener is live while this command waits; the default timeout is 1,500 seconds.",
  },
  inbox: {
    purpose: "Read waiting page messages or print the brief turn-start reminder.",
    examples: ["archer inbox --brief", "archer inbox --brief --hook codex"],
    notes: "The installed --hook form always exits 0, stays silent without messages and never starts a service.",
  },
  skill: {
    purpose: "Print the bundled agent skill or write it as a folder.",
    examples: ["archer skill --references", "archer skill --write ./archer-skill"],
  },
  doctor: {
    purpose: "Check configuration, service reachability, page loading and installed skill compatibility.",
    examples: ["archer doctor"],
    notes: "Each failed check names the recovery step. Run from the same environment as the agent.",
  },
  pair: {
    purpose: "Issue a short single-use browser pairing code.",
    examples: ["archer pair"],
    notes: "Requires a running service. Enter the code at Archer's address on the other device.",
  },
  "network-access": {
    purpose: "Enable HTTPS access from other devices, or return to loopback only.",
    examples: ["archer network-access on --host 192.168.1.42", "archer network-access off"],
    notes:
      "Enabling access requires the person's answer at a terminal. Provisions a local certificate, merges global service settings and restarts Archer. Trust the public CA on each browser device; see [HTTPS & Browser Trust](/security/network-access).",
  },
  mcp: {
    purpose: "Relay MCP over stdin/stdout to Archer for this directory's project.",
    examples: ["archer mcp"],
    notes: "Starts the service when needed. Normally launched by your MCP host after archer setup --mcp.",
  },
  serve: {
    purpose: "Start Archer, attach the current project and print its page.",
    examples: ["archer serve", "archer serve --foreground --port 7331"],
    notes:
      "Listener overrides require --foreground first. Network listeners require TLS unless you explicitly choose --force-http.",
  },
  stop: {
    purpose: "Stop the service, or stop verified stale Archer processes.",
    examples: ["archer stop", "archer stop --stale"],
    notes:
      "A regular stop affects all projects on the selected service. Stale cleanup keeps the main service unless --include-main is also given.",
  },
  status: {
    purpose: "List running Archer copies, versions, addresses and idle times.",
    examples: ["archer status --json"],
  },
  restart: {
    purpose: "Replace the running service with this installation while preserving its address and projects.",
    examples: ["archer restart"],
    notes: "Briefly pauses connections. Preflights configured TLS files before stopping the old service.",
  },
  preferences: { purpose: "Read the person's recorded instance preference.", examples: ["archer preferences"] },
  "preferences set": {
    purpose: "Record how agents should reuse running Archer instances.",
    examples: ["archer preferences set instances reuse-main --note 'Use my main service'"],
  },
  docs: {
    purpose: "List bundled guidance or read a guide without a service.",
    examples: ["archer docs authoring", "archer docs supported-mermaid flowchart"],
    notes:
      "Guides: surfaces, authoring, cli, mcp, admin, docs-mode, walkthroughs and supported-mermaid. The Mermaid guide accepts a family name.",
  },
  "docs index": {
    purpose: "Route a question into the doc pack, regenerate its index or check pack health.",
    examples: ["archer docs index 'How does a request reach storage?'", "archer docs index --write --check"],
    notes: "With no question, prints the current router. --check exits 1 when pack health fails.",
  },
  emphasis: {
    purpose: "Discover, replace or clear named highlights on existing diagrams.",
    examples: ["archer emphasis list containers --json"],
  },
  "emphasis list": {
    purpose: "List saved emphasis, optionally restricted to one view.",
    examples: ["archer emphasis list containers --json"],
    notes: "Always prints JSON and never starts a service.",
  },
  "emphasis set": {
    purpose: "Replace one named emphasis using the set_emphasis operation payload.",
    examples: ["archer tools set_emphasis --json", "archer emphasis set --file request-path.json --json"],
    notes: "Read the diagram's current IDs first. Flow groups require edge targets; highlight groups stay stationary.",
  },
  "emphasis clear": {
    purpose: "Clear the top-level emphasis ID returned by discovery.",
    examples: ["archer emphasis clear containers request-path --json"],
    notes: "Use the emphasis ID, rather than its title or one of its group IDs.",
  },
  walkthrough: {
    purpose: "Manage a saved, numbered explanation of a diagram.",
    examples: ["archer walkthrough list containers --json"],
    notes: "These commands do not start a service. Sequence and journey diagrams do not support walkthroughs.",
  },
  "walkthrough list": {
    purpose: "List a diagram's saved walkthroughs.",
    examples: ["archer walkthrough list containers --json"],
  },
  "walkthrough show": {
    purpose: "Read one walkthrough as structured data or prose.",
    examples: ["archer walkthrough show containers checkout --markdown"],
    notes: "Use the ID returned by list. --markdown conflicts with --json.",
  },
  "walkthrough write": {
    purpose: "Create or replace a walkthrough from JSON.",
    examples: ["archer walkthrough write containers --file checkout.json --expected 2 --json"],
    notes:
      "Accepts the walkthrough object or the echoed show --json result. --expected overrides its embedded revision; conflicts require a new read.",
  },
  "walkthrough delete": {
    purpose: "Delete one walkthrough, guarded by its revision.",
    examples: ["archer walkthrough delete containers checkout --expected 2 --json"],
    notes: "Without --expected, reads the current revision before deleting.",
  },
  tls: {
    purpose: "Provision local HTTPS certificates without changing configuration or trust stores.",
    examples: ["archer tls setup --host 192.168.1.42"],
  },
  "tls setup": {
    purpose: "Create a local CA and server certificate for a concrete browser hostname or IP.",
    examples: ["archer tls setup --host 192.168.1.42 --directory /absolute/new-tls"],
    notes:
      "Requires OpenSSL and a new private destination. Prints paths, fingerprint and service settings. Copy only the public CA certificate to browser devices.",
  },
  "agent-surface": {
    purpose: "Print the installed agent surface digest used by upgrade compatibility checks.",
    examples: ["archer agent-surface"],
    notes: "An internal diagnostic; takes no arguments.",
  },
  help: { purpose: "Print command help or the installed version.", examples: ["archer --help", "archer --version"] },
};

const descriptions: Record<string, string> = {
  json: "Print structured JSON.",
  file: "Read the command's JSON arguments from this file.",
  stdin: "Read JSON arguments from standard input; use instead of --file.",
  docs: "Enable docs mode for the project.",
  suggest: "List all identity rename suggestions.",
  "no-suggest": "Suppress identity rename suggestions.",
  model: "Draw a compiled JSON envelope or graph model instead of Mermaid.",
  width: "Set terminal width in columns; defaults to terminal width or 80.",
  color: "Force terminal color.",
  "no-color": "Disable terminal color.",
  states: "Measure up to eight comma-separated full or collapsed states.",
  nested: "Measure one nested state; use instead of --states.",
  open: "Open these comma-separated group IDs; requires --nested.",
  canvas: "Set canvas dimensions in pixels, for example 1025x896.",
  source: "Read candidate Mermaid source from a file.",
  verbose: "Append all structured fields to the readable measurement.",
  project: "Measure this project's admitted diagram inventory.",
  output: "Atomically save export_diagram image bytes to this path.",
  format: "Choose text or json output; --json is the JSON shorthand.",
  claim: "Make this agent session the checkout's listener.",
  as: "Use the agent ID returned by listen --claim.",
  timeout: "Wait this many seconds (default 1500).",
  brief: "Print the short message summary.",
  hook: "Run the quiet turn-start reminder for claude-code or codex.",
  references: "Include the skill's reference documents.",
  write: "Write the generated output to disk.",
  check: "Report doc-pack health; exit 1 on failure.",
  host: "Use the concrete hostname or IP the browser will open.",
  directory: "Create certificates in a new absolute directory.",
  foreground: "Run attached to this terminal.",
  port: "Listen on this port (1–65535).",
  service: "Select a named service.",
  page: "Serve this page file.",
  "tls-cert": "Use this PEM certificate file.",
  "tls-key": "Use this PEM private key file.",
  "force-http": "Explicitly allow an unencrypted listener for development.",
  stale: "Stop isolated idle copies, missing-state copies and older versions.",
  "include-main": "Include a stale main service; requires --stale.",
  note: "Append this dated explanation to the person's preferences.",
  markdown: "Print walkthrough prose instead of JSON.",
  expected: "Require this walkthrough revision (integer, at least 1).",
  mcp: "Also register Archer as an MCP server.",
  "no-claude": "Skip Claude Code configuration.",
  "no-codex": "Skip Codex configuration.",
  help: "Print command help (alias -h or help).",
  version: "Print the installed version (alias -v).",
};

/** Every module declaring accepted CLI syntax, including package-only commands. */
export const cliSyntaxFiles = [
  "ts/src/bin/main.ts",
  "ts/src/bin/commands.ts",
  "ts/src/bin/measure.ts",
  "ts/src/bin/operations.ts",
  "ts/src/bin/present.ts",
  "ts/src/bin/agents.ts",
  "ts/src/bin/hook.ts",
  "ts/src/bin/skill.ts",
  "ts/src/bin/doctor.ts",
  "ts/src/bin/docs.ts",
  "ts/src/bin/tls.ts",
  "ts/src/bin/emphasis.ts",
  "ts/src/bin/walkthrough.ts",
  "ts/src/service/cli.ts",
  "ts/src/service/instances-cli.ts",
  "ts/pkg/bin/archer.mjs",
  "ts/pkg/bin/setup.mjs",
  "ts/pkg/bin/upgrade.mjs",
] as const;

const handlerFiles: Record<string, [string, string]> = {
  init: ["commands", "init"],
  validate: ["commands", "check"],
  compile: ["commands", "check"],
  draw: ["main", "draw"],
  measure: ["measure", "runMeasure"],
  tools: ["operations", "runTools"],
  call: ["operations", "runCall"],
  present: ["present", "runPresent"],
  projects: ["agents", "runProjects"],
  listen: ["agents", "runListen"],
  wait: ["agents", "parseWaitArgs"],
  inbox: ["agents", "runInbox"],
  skill: ["skill", "runSkill"],
  docs: ["docs", "runDocs"],
  "docs index": ["docs", "docsIndex"],
  emphasis: ["emphasis", "run"],
  walkthrough: ["walkthrough", "run"],
};

// These are intentionally recognized only to return migration/refusal instructions.
const refusedFlags = new Set(["listen:project", "listen:person-requested", "network-access:yes"]);

function propertyName(node: ts.PropertyName): string {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : node.getText();
}

export function parseCliSource(source: string, path = "cli.ts"): ts.SourceFile {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
}

/** Extract node:util parseArgs declarations, not flags copied into prose. */
export function declaredOptions(root: ts.Node): Map<string, "boolean" | "string"> {
  const result = new Map<string, "boolean" | "string">();
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node.name) === "options" &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const prop of node.initializer.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isObjectLiteralExpression(prop.initializer)) continue;
        const type = prop.initializer.properties.find(
          (field) => ts.isPropertyAssignment(field) && propertyName(field.name) === "type",
        );
        if (
          type &&
          ts.isPropertyAssignment(type) &&
          ts.isStringLiteral(type.initializer) &&
          ["boolean", "string"].includes(type.initializer.text)
        )
          result.set(propertyName(prop.name), type.initializer.text as "boolean" | "string");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return result;
}

function namedFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const found = source.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (!found) throw new Error(`Missing CLI handler ${name} in ${source.fileName}`);
  return found;
}

function commandBranch(source: ts.SourceFile, command: string): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isIfStatement(node) &&
      ts.isBinaryExpression(node.expression) &&
      ts.isIdentifier(node.expression.left) &&
      node.expression.left.text === "command" &&
      node.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      ts.isStringLiteral(node.expression.right) &&
      node.expression.right.text === command
    )
      found = node.thenStatement;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error(`Missing inline CLI handler ${command}`);
  return found;
}

function literalConstant(source: ts.SourceFile, name: string): string {
  let value: string | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))
    )
      value = node.initializer.text;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (value === undefined) throw new Error(`Missing CLI ${name} in ${source.fileName}`);
  return value;
}

function flags(text: string): string[] {
  return [...new Set([...text.matchAll(/--([a-z][a-z-]*)/g)].map((match) => match[1]!))];
}

function syntaxLines(usage: string): string[] {
  return usage
    .split("\n\n")[0]!
    .replace(/^usage:\s*/, "")
    .split(/\n\s*(?=archer )/)
    .map((line) => line.replace(/\s*\n\s*/g, " ").trim());
}

export async function generateCliReference(repoRoot: string): Promise<string> {
  const sources = new Map<string, ts.SourceFile>(
    await Promise.all(
      cliSyntaxFiles.map(
        async (path) => [path, parseCliSource(await readFile(join(repoRoot, path), "utf8"), path)] as const,
      ),
    ),
  );
  const lines = syntaxLines(literalConstant(sources.get("ts/src/bin/main.ts")!, "USAGE"));
  lines.push(
    ...syntaxLines(literalConstant(sources.get("ts/pkg/bin/setup.mjs")!, "USAGE")).flatMap((line) =>
      line.split(" | archer ").map((part, index) => (index ? `archer ${part}` : part)),
    ),
  );
  lines.push(...syntaxLines(literalConstant(sources.get("ts/pkg/bin/upgrade.mjs")!, "USAGE")));
  lines.push("archer agent-surface", "archer --help", "archer -h", "archer help", "archer -v");
  const groups = new Map<string, string[]>();
  for (const line of lines) {
    const parts = line.split(/\s+/);
    let name = parts[1]!;
    if (name.startsWith("-") || name === "help") name = "help";
    else if (entries[`${name} ${parts[2]}`]) name += ` ${parts[2]}`;
    if (!entries[name]) throw new Error(`CLI reference needs editorial guidance for ${name}`);
    const group = groups.get(name) ?? [];
    group.push(line);
    groups.set(name, group);
  }
  // preferences has an optional subcommand in the real synopsis; disclose it at h3.
  groups.set("preferences", ["archer preferences"]);
  groups.set("preferences set", [
    lines
      .find((line) => line.startsWith("archer preferences "))!
      .replace("[set ", "set ")
      .replace(/\]$/, ""),
  ]);
  for (const parent of ["emphasis", "walkthrough", "tls"]) {
    const children = [...groups.keys()]
      .filter((name) => name.startsWith(`${parent} `))
      .map((name) => name.slice(parent.length + 1));
    groups.set(parent, [`archer ${parent} <${children.join("|")}>`]);
  }
  const order = [
    "setup",
    "upgrade",
    "uninstall",
    "init",
    "list",
    "validate",
    "compile",
    "draw",
    "measure",
    "tools",
    "call",
    "present",
    "emphasis",
    "walkthrough",
    "docs",
    "projects",
    "listen",
    "wait",
    "inbox",
    "skill",
    "doctor",
    "serve",
    "status",
    "restart",
    "stop",
    "preferences",
    "pair",
    "network-access",
    "tls",
    "mcp",
    "agent-surface",
    "help",
  ];
  const sections: string[] = [];
  for (const parent of order) {
    for (const name of [parent, ...[...groups.keys()].filter((name) => name.startsWith(`${parent} `))]) {
      const syntax = groups.get(name);
      if (!syntax) throw new Error(`CLI synopsis missing ${name}`);
      const entry = entries[name]!;
      const booleanFlags = new Set([
        "json",
        "docs",
        "suggest",
        "no-suggest",
        "color",
        "no-color",
        "nested",
        "verbose",
        "project",
        "stdin",
        "claim",
        "brief",
        "references",
        "check",
        "foreground",
        "force-http",
        "stale",
        "include-main",
        "markdown",
        "mcp",
        "no-claude",
        "no-codex",
        "help",
        "version",
      ]);
      const options = new Map(
        flags(syntax.join("\n")).map((flag) => [
          flag,
          booleanFlags.has(flag) ? ("boolean" as const) : ("string" as const),
        ]),
      );
      const handler = handlerFiles[name];
      if (handler && name !== "compile") {
        for (const [flag, type] of declaredOptions(
          namedFunction(sources.get(`ts/src/bin/${handler[0]}.ts`)!, handler[1]),
        )) {
          if (!refusedFlags.has(`${parent}:${flag}`)) options.set(flag, type);
        }
      }
      if (name === "pair" || name === "network-access") {
        for (const [flag, type] of declaredOptions(commandBranch(sources.get("ts/src/bin/main.ts")!, name))) {
          if (!refusedFlags.has(`${parent}:${flag}`)) options.set(flag, type);
        }
      }
      if (parent === "help") {
        options.set("help", "boolean");
        options.set("version", "boolean");
      }
      const table = options.size
        ? `| Option | Purpose |\n| --- | --- |\n${[...options]
            .map(([flag, type]) => {
              let description = descriptions[flag];
              if (name === "skill" && flag === "write")
                description = "Write the skill and references into this directory.";
              if (name === "docs index" && flag === "write") description = "Regenerate the doc-pack index.md.";
              if (!description) throw new Error(`CLI reference needs an option description for ${name} --${flag}`);
              return `| \`--${flag}${type === "string" ? " <value>" : ""}\` | ${description} |`;
            })
            .join("\n")}`
        : "No options.";
      sections.push(
        `${name === parent ? "##" : "###"} ${name}\n\n${entry.purpose}\n\n\`\`\`text\n${syntax.join("\n")}\n\`\`\`\n\n${table}\n\n\`\`\`sh\n${entry.examples.join("\n")}\n\`\`\`${entry.notes ? `\n\n${entry.notes}` : ""}`,
      );
    }
  }
  return `<!-- Generated from CLI usage and option declarations by site/scripts/cli-reference.mts; edit those sources and its editorial guidance. -->\n\n# CLI reference\n\nRun commands from the intended project. A diagram can be named by view ID, path, file stem or \`notes/topic.md#figure\`.\n\nUse \`archer tools <operation> --json\` for operation arguments; the [agent CLI guide](https://github.com/chrisswanson/archer/blob/main/ts/plugin/skills/archer/references/cli.md) covers revision, feedback and authoring rules.\n\n${sections.join("\n\n")}\n`;
}
