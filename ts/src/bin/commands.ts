// The commands that work on a project's Archer folder: init, list, validate,
// compile, and draw by name. Loaded only when one of them runs.
import { relative, resolve, sep, isAbsolute, basename } from "node:path";
import { parseArgs } from "node:util";
import type { Diagnostic } from "../mermaid/index.ts";
import {
  compileDiagram,
  findProject,
  initProject,
  listDiagrams,
  listNotes,
  resolveDiagram,
  resolveInFolder,
  type CompiledDiagram,
  type Project,
} from "../project/index.ts";
import { projectDisplayName } from "../project/repository.ts";
import { ProjectError } from "../project/errors.ts";
import { allEmbedded, compileEmbedded, readEmbedded, type EmbeddedRead } from "../notes/embedded.ts";
import { safe, usage, UsageError, type Io } from "./main.ts";

const cwdOf = (io: Io): string => io.cwd ?? process.cwd();

/** A folder-relative diagram path as the person sees it: relative to where they stand. */
function shown(project: Project, path: string, io: Io): string {
  const absolute = resolveInFolder(project, path);
  const rel = relative(resolve(cwdOf(io)), absolute);
  return (rel === "" || rel.split(sep)[0] === ".." || isAbsolute(rel) ? absolute : rel).split(sep).join("/");
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const errorsIn = (diagnostics: readonly Diagnostic[]): number =>
  diagnostics.filter((d) => d.severity === "error").length;

/** `file:line:col code message`, then the hint on its own line. */
function diagnosticLines(file: string, diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map((d) => {
      const head = safe(
        `${file}:${d.span.start.line}:${d.span.start.column} ${d.code} ${d.message}`.replace(/\n/g, " "),
      );
      return d.hint === undefined ? `${head}\n` : `${head}\n${safe(`  hint: ${d.hint}`.replace(/\n/g, " "))}\n`;
    })
    .join("");
}

export async function run(command: string, args: readonly string[], io: Io): Promise<number> {
  switch (command) {
    case "init":
      return init(args, io);
    case "list":
      return await list(args, io);
    case "validate":
    case "compile":
      return await check(command, args, io);
    default:
      throw new UsageError(`unknown command ${command}`);
  }
}

function positionalsOnly(command: string, args: readonly string[], most: number, least = 0): string[] {
  const { positionals } = usage(() =>
    parseArgs({ args: [...args], options: {}, strict: true, allowPositionals: true }),
  );
  if (positionals.length > most || positionals.length < least)
    throw new UsageError(
      least === 1 && most === 1
        ? `${command} needs one diagram name or file`
        : most === 0
          ? `${command} takes no arguments`
          : `${command} takes at most ${most} argument${most === 1 ? "" : "s"}`,
    );
  return positionals;
}

function init(args: readonly string[], io: Io): number {
  const { values, positionals } = usage(() =>
    parseArgs({ args: [...args], options: { docs: { type: "boolean" } }, strict: true, allowPositionals: true }),
  );
  if (positionals.length > 1) throw new UsageError("init takes at most 1 argument");
  const docs = values.docs === true;
  const { project, created, updated } = initProject(resolve(cwdOf(io), positionals[0] ?? "."), { docs });
  const lines = [`Archer project at ${project.root}`];
  for (const path of created) lines.push(`  created ${path}`);
  for (const path of updated)
    lines.push(path === "archer.toml" ? `  turned docs mode on in ${path}` : `  added the Archer section to ${path}`);
  if (created.length === 0 && updated.length === 0) lines.push("  already set up; nothing to do");
  if (docs)
    lines.push(
      `Docs mode is on. Next: ask your agent to set up the architecture docs. \`archer docs index --write\` regenerates ${project.folderSetting}/index.md; --check reports the pack's health.`,
    );
  io.stdout(safe(lines.join("\n")) + "\n");
  return 0;
}

async function list(args: readonly string[], io: Io): Promise<number> {
  positionalsOnly("list", args, 0);
  const project = findProject(cwdOf(io));
  const out: string[] = [];
  const diagrams = listDiagrams(project);
  const notes = listNotes(project);
  const embedded = allEmbedded(project);
  out.push(`Project: ${projectDisplayName(project)}`, `Archer folder: ${project.folderSetting} (in ${project.root})`);
  if (diagrams.length === 0 && notes.length === 0) {
    out.push(
      "No diagrams or notes yet. Run `archer init` to set the folder up, then add .mmd diagrams and .md notes to it.",
    );
  } else {
    out.push("Diagrams:");
    if (diagrams.length === 0 && embedded.length === 0) out.push("  (none)");
    const results: { status: string; path: string; view: string }[] = [];
    for (const entry of diagrams) {
      const { diagnostics } = await compileDiagram(project, entry);
      const errors = errorsIn(diagnostics);
      results.push({
        status: errors === 0 ? "ok" : plural(errors, "error"),
        path: entry.path,
        view: entry.view ? `view ${entry.view.id}` : "",
      });
    }
    // Diagrams embedded in notes, under the addresses the agent's tools use (ADR 0012).
    for (const read of embedded) {
      const errors = errorsIn((await compileEmbedded(read)).diagnostics);
      results.push({ status: errors === 0 ? "ok" : plural(errors, "error"), path: read.address, view: "" });
    }
    const width = Math.max(0, ...results.map((r) => r.status.length));
    const pathWidth = Math.max(0, ...results.map((r) => r.path.length));
    for (const r of results)
      out.push(`  ${r.status.padEnd(width)}  ${r.view ? `${r.path.padEnd(pathWidth)}  ${r.view}` : r.path}`);
    out.push("Notes:");
    if (notes.length === 0) out.push("  (none)");
    // Each note's own diagrams, by name, grouped once (not one scan of every block per note).
    const blocksOf = new Map<string, string[]>();
    for (const read of embedded) {
      const names = blocksOf.get(read.notePath);
      if (names === undefined) blocksOf.set(read.notePath, [read.name]);
      else names.push(read.name);
    }
    for (const note of notes) {
      const about = [note.type, note.status].filter((s) => s !== undefined).join(", ");
      const parts = [note.path, about, note.diagrams.length > 0 ? `-> ${note.diagrams.join(", ")}` : ""].filter(
        (s) => s !== "",
      );
      out.push(`  ${parts.join("  ")}`);
      // The note's own diagrams, by name; the address is `<note>#<name>` (ADR 0012).
      const blocks = blocksOf.get(note.path) ?? [];
      if (blocks.length > 0) out.push(`    blocks: ${blocks.join(", ")}`);
      for (const problem of note.problems) out.push(`    ! ${problem}`);
    }
  }
  for (const problem of project.problems)
    out.push(
      `archer.toml view ${problem.position}${problem.id === null ? "" : ` (${problem.id})`}: ${problem.message}`,
    );
  io.stdout(out.map((line) => safe(line.replace(/\n/g, " "))).join("\n") + "\n");
  return 0;
}

interface Named {
  readonly project: Project;
  readonly compiled: CompiledDiagram;
  /** Where its positions are: the `.mmd` file, or the note it is embedded in. */
  readonly file: string;
  /** How the person names it: the file, or `<note>#<name>`. */
  readonly label: string;
  readonly title: string;
  /** Its id for the operations (validate_diagram): the view's, or the embedded diagram's address. */
  readonly viewId: string | undefined;
}

async function named(name: string, io: Io): Promise<Named> {
  const project = findProject(cwdOf(io));
  const target = await resolveTarget(project, name, io);
  if ("address" in target) {
    const file = shown(project, target.notePath, io);
    return {
      project,
      compiled: await compileEmbedded(target),
      file,
      label: `${file}#${target.name}`,
      title: target.name,
      viewId: target.address,
    };
  }
  const compiled = await compileDiagram(project, target);
  const file = shown(project, target.path, io);
  const { inventory } = await import("../application/diagrams.ts");
  const viewId = inventory(project).views.find((v) => v.registration !== "embedded" && v.source === target.path)?.id;
  return { project, compiled, file, label: file, title: basename(compiled.path), viewId };
}

/**
 * A `.mmd` file or view as `resolveDiagram` finds it, or a diagram embedded in a note: by its address
 * (`notes/a.md#name`, folder-relative or from where the person stands) or by its bare name when
 * nothing else answers to it.
 */
export async function resolveTarget(project: Project, name: string, io: Io): Promise<DiagramEntryOf | EmbeddedRead> {
  const hash = name.lastIndexOf("#");
  if (hash > 0 && !name.endsWith(".mmd")) {
    const note = name.slice(0, hash),
      id = name.slice(hash + 1);
    const fromCwd = relative(project.folder, resolve(cwdOf(io), note))
      .split(sep)
      .join("/");
    for (const notePath of [note, fromCwd]) {
      const read = readEmbedded(project, `${notePath}#${id}`);
      if (read !== null) return read;
    }
    throw notFound(project, name, allEmbedded(project));
  }
  const embedded = allEmbedded(project);
  const sameName =
    name.endsWith(".mmd") || project.views.some((v) => v.id === name) ? [] : embedded.filter((r) => r.name === name);
  let file: DiagramEntryOf | undefined;
  try {
    file = await resolveDiagram(project, name, { cwd: cwdOf(io) });
  } catch (error) {
    if (!(error instanceof ProjectError) || error.code !== "diagram_not_found") throw error;
    if (sameName.length === 0) throw embedded.length === 0 ? error : notFound(project, name, embedded);
  }
  if (file !== undefined && sameName.length === 0) return file;
  if (file === undefined && sameName.length === 1 && sameName[0] !== undefined) return sameName[0];
  const choices = [...(file === undefined ? [] : [file.path]), ...sameName.map((r) => r.address)];
  throw new ProjectError(
    "ambiguous_diagram",
    `"${name}" matches more than one diagram; give its path or address:\n${choices.map((c) => `  ${c}`).join("\n")}`,
  );
}
type DiagramEntryOf = Awaited<ReturnType<typeof resolveDiagram>>;

function notFound(project: Project, name: string, embedded: readonly EmbeddedRead[]): ProjectError {
  const all = [...listDiagrams(project).map((d) => d.path), ...embedded.map((r) => r.address)];
  return new ProjectError(
    "diagram_not_found",
    all.length === 0
      ? `no diagram named "${name}": the Archer folder (${project.folderSetting}) has none yet`
      : `no diagram named "${name}" in ${project.folderSetting}. Diagrams here:\n${all.map((p) => `  ${p}`).join("\n")}`,
  );
}

async function check(command: "validate" | "compile", args: readonly string[], io: Io): Promise<number> {
  const { values, positionals } = usage(() =>
    parseArgs({
      args: [...args],
      options: { json: { type: "boolean" }, suggest: { type: "boolean" }, "no-suggest": { type: "boolean" } },
      strict: true,
      allowPositionals: true,
    }),
  );
  if (positionals.length !== 1) throw new UsageError(`${command} needs one diagram name or file`);
  if (values.json === true && command !== "validate")
    throw new UsageError("compile always prints JSON; it takes no --json");
  if ((values.suggest === true || values["no-suggest"] === true) && command !== "validate")
    throw new UsageError("--suggest and --no-suggest are for validate");
  if (values.suggest === true && values["no-suggest"] === true)
    throw new UsageError("--suggest lists every suggestion and --no-suggest none: give one");
  const { compiled, file, label, viewId } = await named(positionals[0]!, io);
  const errors = errorsIn(compiled.diagnostics);
  if (command === "validate") {
    // Suggestions compare a view with the project's other views (P44): a file outside them has none to compare.
    if (values.suggest === true && viewId === undefined)
      throw new UsageError(
        `--suggest needs a diagram of this project (a view id or <note path>#<name>); ${label} is not one`,
      );
    const suggest = values.suggest === true;
    // Unset: validate_diagram's default (up to 5 on an existing view); --no-suggest: none.
    const asked = suggest ? true : values["no-suggest"] === true ? false : undefined;
    // A diagram that compiles is also checked as validate_diagram checks it: the reading rules and the advice.
    // Asked for suggestions, the check runs even on a source that does not compile: the answer says why there are none.
    const checked = viewId !== undefined ? await currentLint(viewId, io, asked) : null;
    const lint = errors === 0 ? checked : null;
    const application = await import("../application/index.ts");
    const suggested =
      (errors === 0 || suggest ? checked?.suggested : undefined) ??
      (suggest ? application.suggestionFields("does_not_compile") : undefined);
    const layoutReview = checked?.layoutReview;
    const same = (a: Diagnostic, b: Diagnostic) =>
      a.code === b.code && a.message === b.message && a.span.start.line === b.span.start.line;
    const more = (lint?.diagnostics ?? []).filter(
      (d): d is Diagnostic => "span" in d && !compiled.diagnostics.some((c) => same(c, d as Diagnostic)),
    );
    const all = [...compiled.diagnostics, ...more];
    const failed = errorsIn(all);
    const warnings = all.filter((d) => d.severity === "warning").length;
    const status = failed > 0 ? plural(failed, "error") : warnings > 0 ? `ok, ${plural(warnings, "warning")}` : "ok";
    if (values.json === true) {
      // What the text form prints, as one value; `lint` as `archer present --json` carries it, when there is some.
      const linted =
        lint !== null && (lint.diagnostics.length > 0 || lint.advice.length > 0 || lint.existingWarnings > 0);
      io.stdout(
        jsonForTerminal(
          {
            // Suggestions right after the status, before the long lists: agents cut JSON with head -c too.
            diagram: label,
            ...(viewId === undefined ? {} : { viewId }),
            status,
            errors: failed,
            warnings,
            ...(suggested ?? {}),
            diagnostics: all,
            ...(layoutReview === undefined ? {} : { layoutReview }),
            ...(linted
              ? {
                  lint: {
                    diagnostics: lint.diagnostics,
                    advice: lint.advice,
                    ...(lint.existingWarnings > 0 ? { existingWarnings: lint.existingWarnings } : {}),
                  },
                }
              : {}),
          },
          0,
        ) + "\n",
      );
      return failed === 0 ? 0 : 1;
    }
    const rest = lint === null ? "" : application.lintSection([], lint.existingWarnings, lint.advice);
    const said =
      suggested === undefined
        ? ""
        : application
            .suggestionText(suggested, viewId ?? label, `run archer validate ${viewId ?? label} --suggest`)
            .replace(/^\n/, "");
    // With suggestions, the status line and they come first, before the diagnostics and advice: agents cut
    // output at a few thousand characters. Without, the compiler's order: diagnostics, then the status.
    const head = safe(`${label}: ${status}`) + "\n";
    const layout = layoutReviewText(layoutReview, viewId ?? label);
    io.stdout(
      (said === "" ? diagnosticLines(file, all) + head : head + `${safe(said)}\n` + diagnosticLines(file, all)) +
        (rest === "" ? "" : `${safe(rest)}\n`) +
        (layout === "" ? "" : `${safe(layout)}\n`),
    );
    return failed === 0 ? 0 : 1;
  }
  if (compiled.diagnostics.length > 0) io.stderr(diagnosticLines(file, compiled.diagnostics));
  if (compiled.envelope === null) return 1;
  io.stdout(jsonForTerminal(compiled.envelope) + "\n");
  return 0;
}

/** Automatic layout prose stays separate from compiler diagnostics and ID rename suggestions. */
function layoutReviewText(review: unknown, viewId: string): string {
  if (review === null || typeof review !== "object") return "";
  const data = review as Record<string, unknown>;
  if (data["status"] === "pending")
    return `Layout review pending (non-blocking). Inspect with archer measure ${viewId} --json.`;
  const suggestions = data["suggestions"];
  if (!Array.isArray(suggestions)) return "";
  const first = suggestions[0] as { message?: unknown } | undefined;
  return typeof first?.message === "string" ? `Layout suggestion (non-blocking): ${first.message}` : "";
}

/** validate_diagram's findings on the diagram's current source, checked here without the service. */
async function currentLint(viewId: string, io: Io, suggest?: boolean) {
  const { createApplication } = await import("../application/index.ts");
  const app = createApplication({ cwd: cwdOf(io), env: io.env, waitForLayoutReview: true });
  try {
    return await app.currentLint(viewId, suggest === undefined ? {} : { suggest });
  } finally {
    app.close();
  }
}

/**
 * JSON whose strings cannot reorder or drive a terminal: JSON already escapes
 * C0 controls; C1 controls, DEL and bidi overrides are escaped the same way,
 * which leaves the value unchanged for any JSON reader.
 */
function jsonForTerminal(value: unknown, indent = 2): string {
  return JSON.stringify(value, null, indent).replace(
    /[\u007f-\u009f‪-‮⁦-⁩]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export async function drawDiagram(name: string, options: { width: number; color: boolean }, io: Io): Promise<number> {
  const { compiled, label: file, file: at, title } = await named(name, io);
  if (compiled.envelope === null) {
    io.stderr(diagnosticLines(at, compiled.diagnostics));
    return 1;
  }
  const { model } = compiled.envelope;
  if (model.type === "sequence-trace") {
    io.stdout(
      safe(
        `${file} is a sequence diagram; the terminal draws graphs only for now (\`archer compile\` prints its model).`,
      ) + "\n",
    );
    return 0;
  }
  const { drawGraph } = await import("../terminal/draw.ts");
  const drawOptions = { ...options, title };
  if (model.type === "state-machine" || model.type === "entity-relationship") {
    const { graphInputOf } = await import("../terminal/from-model.ts");
    io.stdout(await drawGraph(graphInputOf(model), drawOptions));
    return 0;
  }
  if (model.type === "c4-model" || model.type === "service-architecture" || model.type === "user-journey") {
    const { describeModel } = await import("../model/index.ts");
    io.stdout(
      safe(
        `${file} is ${describeModel(model)}, drawn on the browser page only: \`archer serve\` prints the page's address.`,
      ) + "\n",
    );
    return 0;
  }
  const { readGraphInput } = await import("../terminal/input.ts");
  io.stdout(await drawGraph(readGraphInput(model), drawOptions));
  return 0;
}
