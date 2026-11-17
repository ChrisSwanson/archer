/** Explicit calibration experiment, never product discovery. Run from the repo: node --import tsx ts/scripts/measure-corpus.ts */
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { noteDiagrams } from "../../shared/note-diagrams.mts";
import { compileDiagramBytes } from "../src/project/envelope.ts";
import { LayoutPool } from "../src/measurement/pool.ts";
import { measureSnapshot, type MeasurementReport } from "../src/measurement/index.ts";
import { createApplication } from "../src/application/index.ts";

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const ROOTS = ["examples", ".archer", "tools/devkit/corpus", "ts/test/fixtures/pageturner"] as const;
interface Input {
  readonly root: string;
  readonly path: string;
  readonly source: string;
  readonly embedded: boolean;
}
interface Row {
  readonly root: string;
  readonly path: string;
  readonly embedded: boolean;
  readonly milliseconds: number;
  readonly report: MeasurementReport;
}
function* files(path: string): Generator<string> {
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (["node_modules", ".git", ".scratch-page", ".shots", ".plan", ".plan2"].includes(entry.name)) continue;
    const full = join(path, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (entry.isFile() && /\.(mmd|md)$/.test(entry.name)) yield full;
  }
}
function corpusInputs(): Input[] {
  const result: Input[] = [];
  for (const root of ROOTS)
    for (const file of files(join(ROOT, root))) {
      const path = relative(ROOT, file).split("\\").join("/");
      const source = readFileSync(file, "utf8");
      if (path.endsWith(".mmd")) result.push({ root, path, source, embedded: false });
      else
        for (const fence of noteDiagrams(source).diagrams)
          result.push({ root, path: `${path}#${fence.name}`, source: fence.source, embedded: true });
    }
  return result;
}
async function measured(pool: LayoutPool, input: Input): Promise<Row> {
  const start = performance.now();
  // A stable temporary filename supplies inference for standalone and note source alike; model kinds stay compiler-owned.
  const compiled = await compileDiagramBytes({ path: "calibration.mmd" }, Buffer.from(input.source));
  const report = await measureSnapshot(pool, {
    viewId: input.path,
    sourceRevision: compiled.revision,
    envelope: compiled.envelope,
    diagnostics: compiled.diagnostics.map((d) => ({ ...d })),
    basis: "saved-source",
  });
  return {
    root: input.root,
    path: input.path,
    embedded: input.embedded,
    milliseconds: Number((performance.now() - start).toFixed(3)),
    report,
  };
}
const round = (value: number) => Number(value.toFixed(3));
function quantile(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * p,
    lo = Math.floor(at),
    hi = Math.ceil(at);
  return round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo));
}
/** Reproducible calibration over the four owner-selected roots; no inventory/discovery behavior is added. */
export async function measureCorpus(outdir = join(ROOT, ".shots")) {
  mkdirSync(outdir, { recursive: true });
  const pool = new LayoutPool();
  try {
    const inputs = corpusInputs(),
      rows: Row[] = [];
    for (const input of inputs) rows.push(await measured(pool, input));
    const ready = rows.filter((row) => row.report.complete);
    const camera = ready.filter((row) => row.report.basis !== "static-export-board");
    const trips = camera.filter((row) => row.report.suggestions.length > 0);
    const times = rows.map((row) => row.milliseconds).sort((a, b) => a - b);
    const summary = {
      version: 1,
      roots: ROOTS,
      profile: "desktop-1025x896-gutter24",
      inputs: rows.length,
      standalone: rows.filter((r) => !r.embedded).length,
      embedded: rows.filter((r) => r.embedded).length,
      measured: ready.length,
      cameraMeasured: camera.length,
      journeyBoards: ready.length - camera.length,
      unavailable: rows.length - ready.length,
      tripCount: trips.length,
      byRoot: ROOTS.map((root) => ({
        root,
        inputs: rows.filter((r) => r.root === root).length,
        measured: ready.filter((r) => r.root === root).length,
        trips: trips.filter((r) => r.root === root).length,
      })),
      compileAndMeasureMs: {
        median: quantile(times, 0.5),
        p90: quantile(times, 0.9),
        p95: quantile(times, 0.95),
        max: times.at(-1),
      },
      worker: pool.stats,
      limitations: [
        "Occurrences, including mirrored fixtures, are counted separately.",
        "Threshold trips are review candidates, not evidence of poor comprehension.",
        "Journey bounds describe the static export board and have no camera-based suggestions.",
        "This calibration scan is explicit and does not change admitted product inventory.",
      ],
    };
    const timelineSource = `flowchart LR\n${Array.from({ length: 18 }, (_, i) => ` n${i}[Year ${2000 + i}]`).join("\n")}\n${Array.from({ length: 17 }, (_, i) => ` n${i} year_${i}@--> n${i + 1}`).join("\n")}\n`;
    const intentionalTimeline = await measured(pool, {
      root: "additional-counterexample",
      path: "intentional-ordered-timeline.mmd",
      source: timelineSource,
      embedded: false,
    });
    writeFileSync(
      join(outdir, "layout-corpus.json"),
      `${JSON.stringify({ summary, rows, intentionalTimeline }, null, 2)}\n`,
    );
    writeFileSync(
      join(outdir, "layout-corpus-trips.json"),
      `${JSON.stringify(
        trips.map(({ path, report }) => ({
          path,
          sourceRevision: report.sourceRevision,
          suggestions: report.suggestions,
          states: report.states.map(({ mode, open, bounds, spanScreens }) => ({ mode, open, bounds, spanScreens })),
        })),
        null,
        2,
      )}\n`,
    );
    const table = trips.map(({ path, report }) => {
      const finding = report.suggestions[0]!,
        state = report.states.find((s) => s.stateIndex === finding.stateIndex)!;
      return `| ${path} | ${finding.code} | ${state.mode}${state.open?.length ? ` (${state.open.join(", ")})` : ""} | ${state.spanScreens!.x.toFixed(4)} × ${state.spanScreens!.y.toFixed(4)} |`;
    });
    writeFileSync(
      join(outdir, "layout-corpus-trips.md"),
      `# Desktop layout calibration\n\n${ready.length}/${rows.length} inputs measured; ${camera.length} camera layouts, ${summary.journeyBoards} static journey boards. ${trips.length} threshold trips. Occurrences are not deduplicated.\n\n| Source | Suggestion | State | Reading screens X × Y |\n| --- | --- | --- | --- |\n${table.join("\n")}\n\nThe additional ordered timeline spans ${intentionalTimeline.report.states[0]?.spanScreens?.x} reading screens across and trips the width threshold. Its temporal order is intentional: advice never rearranges or refuses it. It is excluded from corpus counts.\n`,
    );
    const app = createApplication({
      cwd: realpathSync(join(ROOT, "examples/archer-tour")),
      layoutPool: pool,
      ensureService: () => {
        throw new Error("calibration must stay offline");
      },
    });
    try {
      const measurement = await app.call("measure_diagram", { viewId: "heartbeat" });
      writeFileSync(join(outdir, "heartbeat-measure.json"), `${JSON.stringify(measurement, null, 2)}\n`);
      writeFileSync(join(outdir, "heartbeat-measure.txt"), `${measurement.text}\n`);
      const read = await app.call("read_diagram", { viewId: "heartbeat" });
      const source = (read.structured.source as { text?: unknown }).text;
      if (typeof source !== "string") throw new Error("heartbeat source unavailable");
      const review = await app.call("validate_diagram", { viewId: "heartbeat", source });
      writeFileSync(join(outdir, "heartbeat-review.json"), `${JSON.stringify(review, null, 2)}\n`);
    } finally {
      app.close();
    }
    return summary;
  } finally {
    pool.close();
  }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  process.stdout.write(
    `${JSON.stringify(await measureCorpus(process.argv[2] ? resolve(process.argv[2]) : undefined), null, 2)}\n`,
  );
}
