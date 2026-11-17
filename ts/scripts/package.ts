// Builds the private, installable Archer package: dist/archer-<version>.tgz at the repo root.
//
//   npm --workspace ts run package            # builds the page, the bundle and the tgz
//   tsx scripts/package.ts <outdir> [--skip-ui-build]
//
// The tgz holds the bundled CLI, MCP relay and page (dist/), the skill (skills/archer, which setup links
// for Claude Code and Codex) and `archer setup` (pkg/bin/setup.mjs). No Claude Code plugin ships: an
// install that had one keeps a relay-only shell setup writes itself (ADR 0035 §5–6), and the package
// root carries no .claude-plugin, under which Codex would rename the linked skill. Install it with
// `npx --yes ./archer-<version>.tgz setup` (docs/install.md). It is never published: the
// manifest is private and points publishing at an unreachable registry.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const TS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(TS, "..");

/** The package.json written into the tgz. Exported for the guard test. */
export function packageManifest(version: string): Record<string, unknown> {
  return {
    name: "archer",
    version,
    private: true,
    license: "Apache-2.0",
    description: "Archer: agent-authored Mermaid diagrams shared between a person and their agents (private build)",
    type: "module",
    engines: { node: ">=22.18" },
    bin: { archer: "bin/archer.mjs" },
    files: ["bin/", "dist/", "skills/", "examples/", "README.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"],
    // Belt and braces: `private` makes npm refuse to publish; the registry and the
    // script make any other publish path fail too.
    publishConfig: { registry: "https://publishing-disabled.invalid/" },
    scripts: {
      prepublishOnly: "node -e \"console.error('archer is a private package: never publish it'); process.exit(1)\"",
    },
  };
}

/**
 * `pages`: a built `ui/dist`-shaped directory to package instead of ui/dist (no page build then); tests
 * pass a private copy, so a page rebuilt meanwhile cannot change what they compare.
 */
export async function buildPackage(
  outdir: string,
  options: { skipUiBuild?: boolean; pages?: string } = {},
): Promise<string> {
  const version = (JSON.parse(readFileSync(join(TS, "package.json"), "utf8")) as { version: string }).version;
  const started = Date.now();
  const pages = options.pages ?? join(REPO, "ui", "dist");
  const skipUiBuild = options.skipUiBuild === true || options.pages !== undefined;
  if (!skipUiBuild) {
    // NODE_ENV=production: a caller under test (vitest sets NODE_ENV=test) would otherwise build a dev React page that prod-strip refuses.
    execFileSync("npm", ["--workspace", "ui", "run", "build"], {
      cwd: REPO,
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "production" },
    });
  }
  const page = join(pages, "index.html"),
    mcpPage = join(pages, "mcp", "index.html");
  // The package ships only pages built from this checkout.
  for (const [built, name] of [
    [page, "ui/dist/index.html"],
    [mcpPage, "ui/dist/mcp/index.html"],
  ] as const) {
    if (!existsSync(built)) throw new Error(`${name} is missing: run \`npm --workspace ui run build\``);
    if (!skipUiBuild && statSync(built).mtimeMs < started - 1000) throw new Error(`${name} was not rebuilt`);
  }
  const { bundle } = await import("./bundle.ts");

  const stage = join(outdir, "package");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  await bundle(join(stage, "dist"), { pages });
  cpSync(join(TS, "plugin", "skills"), join(stage, "skills"), { recursive: true });
  cpSync(join(TS, "pkg", "bin"), join(stage, "bin"), { recursive: true });
  cpSync(join(TS, "pkg", "README.md"), join(stage, "README.md"));
  // Root examples ship when present; test corpora stay in the source tree.
  const examples = join(REPO, "examples");
  if (existsSync(examples)) cpSync(examples, join(stage, "examples"), { recursive: true });
  // Apache-2.0 §4: a redistribution carries the licence and the NOTICE file.
  for (const file of ["LICENSE", "NOTICE"]) cpSync(join(REPO, file), join(stage, file));
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(packageManifest(version), null, 2)}\n`);
  writeFileSync(join(stage, "THIRD_PARTY_NOTICES.md"), thirdPartyNotices());
  const shipped = readFileSync(join(stage, "dist", "assets", "archer-ui.html"));
  if (!shipped.equals(readFileSync(page))) throw new Error("packaged page differs from ui/dist/index.html");
  if (!readFileSync(join(stage, "dist", "assets", "archer-mcp-app.html")).equals(readFileSync(mcpPage)))
    throw new Error("packaged MCP App page differs from ui/dist/mcp/index.html");

  const name = execFileSync("npm", ["pack", "--ignore-scripts", "--quiet", "--pack-destination", outdir], {
    cwd: stage,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .pop()!;
  const tgz = join(outdir, name);
  const sha = createHash("sha256").update(readFileSync(tgz)).digest("hex");
  console.log(`${tgz}\n  ${(statSync(tgz).size / 1e6).toFixed(1)} MB, sha256 ${sha}`);
  return tgz;
}

/**
 * The checkout whose install `repo` uses: itself, or, when its node_modules is a link (a worktree
 * sharing another checkout's install, .agents/skills/archer-ui-verification), the checkout the link
 * leads to. There npm ls sees the install as its own; run in the worktree it sees every package as a
 * link outside the project, calls it extraneous and exits with ELSPROBLEMS. The bundlers resolve
 * through the same link, so that install is the one the package carries.
 */
export function installRoot(repo: string): string {
  const modules = join(repo, "node_modules");
  return existsSync(modules) && lstatSync(modules).isSymbolicLink() ? dirname(realpathSync(modules)) : repo;
}

/**
 * The licences of everything the CLI bundle and the page may carry: the production dependency
 * trees of the ts and ui workspaces (a superset of what the bundlers keep), each with its own
 * licence files, or its SPDX id and source when it ships none (resvg-wasm, MPL-2.0).
 */
export function thirdPartyNotices(): string {
  const installed = installRoot(REPO);
  const [root = "", ...lines] = execFileSync(
    "npm",
    ["ls", "--omit=dev", "--all", "--parseable", "--workspace", "ts", "--workspace", "ui"],
    { cwd: installed, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\n")
    .filter((line) => line !== "");
  // npm 11 masks UUID-like path segments in its output as "***", so a checkout under such a directory
  // got paths that do not exist and lost their notices. Read each path relative to the root npm printed first.
  const paths = lines
    .filter((line) => line.includes(`${"/"}node_modules${"/"}`))
    .map((line) => (line.startsWith(`${root}/`) ? join(installed, line.slice(root.length + 1)) : line));
  const seen = new Map<string, string>();
  for (const dir of paths) {
    let manifest: { name?: string; version?: string; license?: unknown; repository?: unknown; homepage?: string };
    try {
      manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const id = `${manifest.name}@${manifest.version}`;
    if (manifest.name === undefined || seen.has(id)) continue;
    const licence =
      typeof manifest.license === "string" ? manifest.license : JSON.stringify(manifest.license ?? "UNKNOWN");
    const repository =
      typeof manifest.repository === "string"
        ? manifest.repository
        : ((manifest.repository as { url?: string } | undefined)?.url ??
          manifest.homepage ??
          `https://www.npmjs.com/package/${manifest.name}`);
    const texts = readdirSync(dir)
      .filter((file) => /^(licen[cs]e|copying|notice)/i.test(file))
      .sort()
      .map((file) => readFileSync(join(dir, file), "utf8").trim());
    const body =
      texts.length > 0
        ? texts.join("\n\n")
        : `No licence file ships with this package; its licence is ${licence} (https://spdx.org/licenses/${licence}.html).`;
    seen.set(id, `## ${id}\n\nLicence: ${licence}. Source: ${repository}\n\n\`\`\`\`text\n${body}\n\`\`\`\`\n`);
  }
  if (![...seen.keys()].some((id) => id.startsWith("@resvg/resvg-wasm@")))
    throw new Error("third-party notices: @resvg/resvg-wasm is missing from the dependency tree");
  return `# Third-party notices\n\nArcher bundles the following packages (and the Fira Sans font, whose OFL notice ships beside it). Each is used under its own licence, reproduced or named below.\n\n${[
    ...seen.keys(),
  ]
    .sort()
    .map((id) => seen.get(id))
    .join("\n")}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const out = args.find((arg) => !arg.startsWith("--"));
  await buildPackage(resolve(out ?? join(REPO, "dist")), { skipUiBuild: args.includes("--skip-ui-build") });
}
