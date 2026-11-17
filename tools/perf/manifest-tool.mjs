#!/usr/bin/env node
// Request-manifest tool (performance rubric G1, S1), offline: no browser, no service.
//
//   node tools/perf/manifest-tool.mjs seed-from-baseline <resource-manifest.json> [--out tools/perf/manifests.json]
//   node tools/perf/manifest-tool.mjs check --rows <file> [--loads <loads.jsonl>] [--manifest tools/perf/manifests.json] [--allow-proposed] [--drop-decision "<B verdict>"]
//   node tools/perf/manifest-tool.mjs validate [--manifest tools/perf/manifests.json]
//
// `check` reads saved request rows — a B baseline resource-manifest.json ({requests:[{page,state,…}]}) or a lab
// requests.jsonl (one {page,state,profile,run,…row} per line) — groups them by page and state and checks each
// load against the manifest (lib/manifest.mjs checkLoad). Exit 1 when any load fails. `--drop-decision` removes B
// rows with that verdict first (the demo: B with its "should not happen" rows passes; B as measured fails).
// `--allow-proposed` counts entries not yet approved by the reviewers and the owner as matches (reported apart).
// `--loads` (the lab's loads.jsonl) gives each load's route-ready, in-view identities and variant, so phases are
// measured as in the lab; without it a late read cannot be told from a data read, and split entries are NOT EVALUATED.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  MANIFEST_SCHEMA,
  RUBRIC_FIXTURE,
  checkLines,
  checkLoad,
  entriesFor,
  entriesFromBaseline,
  shownFor,
  validateManifest,
} from "./lib/manifest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT = join(HERE, "manifests.json");
/** Alias surfaces and the canonical surface each redirects to. */
export const ALIASES = { "diagram-folder-path": "diagram", "note-alias": "note" };

/** The manifest as JSON with one line per entry, so a review diff shows entries, not fields. */
export function formatManifest(m) {
  const head = JSON.stringify({ ...m, surfaces: undefined }, null, 2).replace(/\n}$/, "");
  const surfaces = Object.entries(m.surfaces)
    .map(
      ([surface, states]) =>
        `    ${JSON.stringify(surface)}: {\n${Object.entries(states)
          .map(
            ([state, list]) =>
              `      ${JSON.stringify(state)}: [\n${list.map((e) => `        ${JSON.stringify(e)}`).join(",\n")}\n      ]`,
          )
          .join(",\n")}\n    }`,
    )
    .join(",\n");
  return `${head},\n  "surfaces": {\n${surfaces}\n  }\n}\n`;
}

export function readRows(path) {
  const text = readFileSync(path, "utf8");
  if (/\.jsonl$/.test(path))
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const json = JSON.parse(text);
  return Array.isArray(json) ? json : (json.requests ?? []);
}

const loadKey = (r) => `${r.page}/${r.profile ?? "default"}/${r.state}${r.run !== undefined ? `#${r.run}` : ""}`;

/** `meta`: the lab's loads.jsonl records ({page, profile, state, run, readyMs, inView, variant}), or none. */
export function checkRows(rows, manifest, { allowProposed = false, fixture = RUBRIC_FIXTURE, meta = [] } = {}) {
  const problems = validateManifest(manifest);
  const loads = new Map(),
    metaBy = new Map(meta.map((m) => [loadKey(m), m]));
  for (const r of rows) {
    const key = loadKey(r);
    (loads.get(key) ?? loads.set(key, { page: r.page, state: r.state, rows: [] }).get(key)).rows.push(r);
  }
  return [...loads].map(([key, l]) => {
    const m = metaBy.get(key);
    return {
      key,
      ...checkLoad({
        rows: l.rows,
        entries: entriesFor(manifest, l.page, l.state),
        shown: shownFor(l.page, fixture),
        readyMs: m?.readyMs ?? null,
        inView: m?.inView ?? null,
        variant: m?.variant ?? "production",
        allowProposed,
        problems,
      }),
    };
  });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      manifest: { type: "string" },
      rows: { type: "string" },
      loads: { type: "string" },
      "allow-proposed": { type: "boolean" },
      "drop-decision": { type: "string", multiple: true },
    },
  });
  if (cmd === "seed-from-baseline") {
    const src = positionals[0];
    if (!src) throw new Error("seed-from-baseline <resource-manifest.json>");
    const rows = readRows(src);
    const manifest = {
      schema: MANIFEST_SCHEMA,
      $comment:
        "Request manifest per surface × state (performance rubric G1). Seeded from baseline B (2026-10-30, resource-manifest.json SHA-256 168201ff…5ea1): every entry carries B's verdict and is approved:false until both reviewers agree and the maintainer approves it (§6). B's \"should not happen\" rows have no entry, so they fail. Patterns: lib/manifest.mjs manifestPattern; targets: route (the shown view), none, other (a target the page does not show: prefetch entries only).",
      fixture: {
        corpus: "tools/devkit/corpus",
        ...RUBRIC_FIXTURE,
        presentation: "agent presentation of seq-awkward active (as in B)",
      },
      exceptions: [],
      surfaces: entriesFromBaseline(rows, (page) => shownFor(page)),
    };
    // The aliases (§1 matrix) load their canonical page after one redirect: the same entries, one more document.
    for (const [alias, canonical] of Object.entries(ALIASES)) {
      const states = manifest.surfaces[canonical];
      if (!states) continue;
      manifest.surfaces[alias] = Object.fromEntries(
        Object.entries(states).map(([state, list]) => [
          state,
          list.map((e) =>
            e.phase === "document"
              ? {
                  ...e,
                  max: e.max + 1,
                  reason: `${e.reason} | alias: one redirect (303) and then the canonical document; each alias costs one redirect and one document (G3, perf #3)`,
                }
              : { ...e },
          ),
        ]),
      );
    }
    const out = resolve(values.out ?? DEFAULT);
    writeFileSync(out, formatManifest(manifest));
    process.stdout.write(
      `${out}: ${
        Object.values(manifest.surfaces)
          .flatMap((s) => Object.values(s))
          .flat().length
      } entries\n`,
    );
    return;
  }
  const manifest = JSON.parse(readFileSync(resolve(values.manifest ?? DEFAULT), "utf8"));
  if (cmd === "validate") {
    const problems = validateManifest(manifest);
    process.stdout.write(problems.length ? problems.map((p) => `- ${p}`).join("\n") + "\n" : "manifest valid\n");
    process.exitCode = problems.length ? 1 : 0;
    return;
  }
  if (cmd === "check") {
    if (!values.rows) throw new Error("check --rows <file>");
    const drop = new Set(values["drop-decision"] ?? []);
    const rows = readRows(values.rows).filter((r) => !drop.has(r.decision));
    const results = checkRows(rows, manifest, {
      allowProposed: values["allow-proposed"] === true,
      meta: values.loads ? readRows(values.loads) : [],
    });
    for (const r of results) process.stdout.write(checkLines(r.key, r).join("\n") + "\n");
    const failed = results.filter((r) => !(values["allow-proposed"] ? r.draftPass : r.pass));
    const wrong = results.reduce((a, r) => a + r.wrongTarget.length, 0);
    process.stdout.write(
      `\n${results.length} loads, ${failed.length} failing; wrong-target rows ${wrong} (cold ${results.filter((r) => /\/cold/.test(r.key)).reduce((a, r) => a + r.wrongTarget.length, 0)})\n`,
    );
    process.exitCode = failed.length ? 1 : 0;
    return;
  }
  process.stderr.write(
    readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("\n")
      .slice(1, 13)
      .map((l) => l.replace(/^\/\/ ?/, ""))
      .join("\n") + "\n",
  );
  process.exitCode = 2;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => {
    process.stderr.write(`${e?.stack ?? e}\n`);
    process.exit(2);
  });
