/**
 * PROTOTYPE layout-engine eval: a fixed corpus, fixed screen profiles, and standard metrics, run against one or more
 * ENGINE VARIANTS. It tests the tool, not the author: every diagram is laid out exactly as written (frames included),
 * so a change can only score better by drawing the same diagram better.
 *
 *   cd ui && ../node_modules/.bin/tsx ../tools/layout-eval/eval.mts [--variants a,b] [--only name] [--save-baseline]
 *                                                                    [--svg-dir dir]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { computeLayout, type LayoutResult } from "../../ui/src/layout/elk-adapter";
import { viewOfSource } from "../../ui/tests/route-metrics";
import { measure, overlaySvg, type Report } from "./report.mts";
import { CURVE_STATS, VARIANTS } from "./variants.mts";

/** How far each line's ends come in off the perpendicular of the box side they meet, in degrees: summed, and counted. */
function entryOffNormal(layout: LayoutResult): { sum: number; count: number } {
  const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const n of layout.nodes) boxes.set(n.id, n);
  for (const g of layout.groups) boxes.set(g.id, g);
  let sum = 0;
  let count = 0;
  for (const e of layout.edges) {
    if (e.points.length < 2 || e.source === e.target) continue;
    for (const [id, pts] of [
      [e.target, e.points],
      [e.source, [...e.points].reverse()],
    ] as const) {
      const box = boxes.get(id);
      if (box === undefined) continue;
      const tip = pts[pts.length - 1]!;
      // A point at least 4px back along the line gives its direction into the box.
      let k = pts.length - 2;
      while (k > 0 && Math.hypot(pts[k]!.x - tip.x, pts[k]!.y - tip.y) < 4) k -= 1;
      const from = pts[k]!;
      const dx = tip.x - from.x;
      const dy = tip.y - from.y;
      const l = Math.hypot(dx, dy);
      if (l === 0) continue;
      const sides = [
        { d: Math.abs(tip.x - box.x), n: [1, 0] },
        { d: Math.abs(tip.x - (box.x + box.width)), n: [-1, 0] },
        { d: Math.abs(tip.y - box.y), n: [0, 1] },
        { d: Math.abs(tip.y - (box.y + box.height)), n: [0, -1] },
      ].sort((a, b) => a.d - b.d);
      const [nx, ny] = sides[0]!.n as [number, number];
      const cos = Math.max(-1, Math.min(1, (dx * nx + dy * ny) / l));
      sum += (Math.acos(cos) * 180) / Math.PI;
      count += 1;
    }
  }
  return { sum, count };
}
import { CORPUS } from "./corpus.mts";

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = `${HERE}../../`;
/** Screens the drawing should be readable on (the drawing area, after the app's own chrome is allowed for). */
export const SCREENS = {
  "archer-canvas": { width: 1025, height: 896 }, // DESKTOP_PROFILE in shared/layout-analysis.mts
  "laptop-1440": { width: 1440 - 240, height: 900 - 160 },
  "desktop-1920": { width: 1920 - 320, height: 1080 - 180 },
} as const;
const PRIMARY: keyof typeof SCREENS = "laptop-1440";

type Row = {
  diagram: string;
  variant: string;
  ms: number;
  frames: number;
  framesKept: boolean;
  score: number;
  valid: boolean;
  failed?: string;
  bends: number;
  excessBends: number;
  maxBends: number;
  crossings: number;
  acuteCrossings: number;
  minCrossingAngle: number | null;
  /** Lines a curve variant drew with its last fallback (square: v2's curved corners). */
  fallbacks: number;
  /** Lines a curve variant drew through borrowed route corners. */
  corners: number;
  /** Captions slid along their curve, and captions with no clear place. */
  slid: number;
  unplaced: number;
  entrySum: number;
  entryCount: number;
  throughNode: number;
  labelOverlaps: number;
  junctions: number;
  junctionLoad: number;
  peakEvents: number;
  tightRuns: number;
  shortJogs: number;
  ambiguousTurns: number;
  width: number;
  height: number;
  fit: Record<string, { zoom: number; labelPx: number }>;
};

const { values } = parseArgs({
  options: {
    variants: { type: "string" },
    only: { type: "string" },
    "save-baseline": { type: "boolean" },
    "svg-dir": { type: "string" },
  },
});
const variantNames = values.variants ? values.variants.split(",") : Object.keys(VARIANTS);
const diagrams = values.only ? values.only.split(",") : Object.keys(CORPUS);

const rows: Row[] = [];
const failures: { diagram: string; variant: string; message: string }[] = [];
for (const name of diagrams) {
  const source = readFileSync(CORPUS[name]!, "utf8");
  const view = await viewOfSource(source, name);
  for (const v of variantNames) {
    const variant = VARIANTS[v];
    if (!variant) throw new Error(`unknown variant ${v}`);
    let layout: LayoutResult;
    const started = performance.now();
    try {
      layout = await variant.layout(view, computeLayout);
    } catch (error) {
      // A variant that cannot lay a diagram out is a failure the totals must show, not a row to skip.
      const message = error instanceof Error ? error.message.slice(0, 200) : String(error);
      console.error(`${name} / ${v}: FAILED ${message}`);
      failures.push({ diagram: name, variant: v, message });
      continue;
    }
    const ms = Math.round(performance.now() - started);
    const primary: Report = measure(name, layout, SCREENS[PRIMARY]);
    const fit = Object.fromEntries(
      Object.entries(SCREENS).map(([k, s]) => {
        const r = measure(name, layout, s);
        return [k, { zoom: r.fitZoom, labelPx: r.labelPxAtFit }];
      }),
    );
    rows.push({
      diagram: name,
      variant: v,
      ms,
      frames: view.groups.length,
      framesKept: layout.groups.length === view.groups.length,
      score: primary.score,
      valid: primary.valid,
      bends: primary.bends,
      excessBends: primary.excessBends,
      maxBends: primary.maxBends,
      crossings: primary.crossings,
      acuteCrossings: primary.acuteCrossings,
      minCrossingAngle: primary.minCrossingAngle,
      fallbacks: CURVE_STATS.get(`${view.viewId ?? ""}|${v}`)?.fallbacks ?? 0,
      corners: CURVE_STATS.get(`${view.viewId ?? ""}|${v}`)?.corners ?? 0,
      slid: CURVE_STATS.get(`${view.viewId ?? ""}|${v}`)?.slid ?? 0,
      unplaced: CURVE_STATS.get(`${view.viewId ?? ""}|${v}`)?.unplaced ?? 0,
      ...(() => {
        const entry = entryOffNormal(layout);
        return { entrySum: entry.sum, entryCount: entry.count };
      })(),
      throughNode: primary.throughNode.length,
      labelOverlaps: primary.labelOverlaps.length,
      junctions: primary.congestion.junctions.length,
      junctionLoad: primary.congestion.junctionLoad,
      peakEvents: primary.congestion.peakEvents,
      tightRuns: primary.congestion.tightRuns,
      shortJogs: primary.congestion.shortJogs,
      ambiguousTurns: primary.congestion.ambiguousTurns,
      width: primary.size.width,
      height: primary.size.height,
      fit,
    });
    if (values["svg-dir"]) {
      mkdirSync(values["svg-dir"], { recursive: true });
      writeFileSync(`${values["svg-dir"]}/${name}.${v}.svg`, overlaySvg(layout, primary, `${name} · ${v}`));
    }
  }
}

const baselinePath = `${HERE}baseline.json`;
const baseline: Row[] = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : [];
const base = (d: string) => baseline.find((r) => r.diagram === d && r.variant === "baseline");
const delta = (now: number, was: number | undefined) =>
  was === undefined || now === was ? "" : `(${now - was > 0 ? "+" : ""}${now - was})`;

console.log(
  [
    "diagram".padEnd(16),
    "variant".padEnd(22),
    "score",
    "needless",
    "max",
    "cross",
    "thru",
    "lbl",
    "knot",
    "tight",
    "size".padEnd(10),
    ...Object.keys(SCREENS).map((s) => s.padEnd(14)),
  ].join(" "),
);
for (const r of rows) {
  const b = base(r.diagram);
  console.log(
    [
      r.diagram.padEnd(16),
      r.variant.padEnd(22),
      `${r.score}${delta(r.score, b?.score)}`.padEnd(5),
      `${r.excessBends}${delta(r.excessBends, b?.excessBends)}`.padEnd(8),
      String(r.maxBends).padEnd(3),
      `${r.crossings}${delta(r.crossings, b?.crossings)}`.padEnd(5),
      String(r.throughNode).padEnd(4),
      String(r.labelOverlaps).padEnd(3),
      `${r.junctionLoad}${delta(r.junctionLoad, b?.junctionLoad)}`.padEnd(8),
      String(r.tightRuns).padEnd(5),
      `${r.width}x${r.height}`.padEnd(10),
      ...Object.values(r.fit).map((f) => `${f.zoom} ${f.labelPx}px`.padEnd(14)),
      r.framesKept ? "" : "FRAMES LOST",
      r.valid ? "" : "INVALID",
    ].join(" "),
  );
}
// Totals per variant: the eval's headline.
console.log("\nvariant totals over corpus:");
for (const v of variantNames) {
  const rs = rows.filter((r) => r.variant === v);
  const sum = (k: keyof Row) => rs.reduce((s, r) => s + (r[k] as number), 0);
  const invalid = rs.filter((r) => !r.valid).length;
  const failed = failures.filter((f) => f.variant === v).length;
  const meanZoom = rs.reduce((s, r) => s + r.fit[PRIMARY]!.zoom, 0) / Math.max(1, rs.length);
  const angles = rs.map((r) => r.minCrossingAngle).filter((a): a is number => a !== null);
  console.log(
    `  ${v.padEnd(22)} score ${(sum("score") / Math.max(1, rs.length)).toFixed(1)}  bends ${sum("bends")}  needless ${sum("excessBends")}  crossings ${sum("crossings")} (acute ${sum("acuteCrossings")})  through ${sum("throughNode")}  labels ${sum("labelOverlaps")}  knots ${sum("junctionLoad")} in ${sum("junctions")} junctions  tight ${sum("tightRuns")}  jogs ${sum("shortJogs")}  ambiguous ${sum("ambiguousTurns")}  mean fit@${PRIMARY} ${meanZoom.toFixed(2)}  invalid ${invalid}  failed ${failed}  min angle ${angles.length ? Math.min(...angles) : "-"}  fallbacks ${sum("fallbacks")} corners ${sum("corners")}  labels slid ${sum("slid")} unplaced ${sum("unplaced")}  entry off-normal mean ${(sum("entrySum") / Math.max(1, sum("entryCount"))).toFixed(1)}°  layout ms mean ${Math.round(sum("ms") / Math.max(1, rs.length))} max ${Math.max(...rs.map((r) => r.ms))}`,
  );
}
if (values["save-baseline"]) {
  writeFileSync(
    baselinePath,
    JSON.stringify(
      rows.filter((r) => r.variant === "baseline"),
      null,
      1,
    ),
  );
  console.log(`baseline saved: ${baselinePath}`);
}
// A partial run (--only / --variants) must not overwrite the full record the page and baseline are built from.
const partial = values.only !== undefined || values.variants !== undefined;
writeFileSync(`${HERE}${partial ? "partial-run" : "last-run"}.json`, JSON.stringify({ rows, failures }, null, 1));
