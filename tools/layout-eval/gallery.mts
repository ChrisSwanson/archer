/**
 * PROTOTYPE: measure every round of every blind author in an eval directory and write gallery.json plus one overlay
 * SVG per round. Fidelity is checked so a better score can never come from dropping wires.
 *
 *   cd ui && ../node_modules/.bin/tsx ../tools/layout-eval/gallery.mts <evalDir> [--expect-nodes 16 --expect-edges 22]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { layoutOf, measure, overlaySvg } from "./report.mts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "expect-nodes": { type: "string", default: "16" }, "expect-edges": { type: "string", default: "22" } },
});
const root = positionals[0]!;
const expectNodes = Number(values["expect-nodes"]);
const expectEdges = Number(values["expect-edges"]);
const out: Record<string, unknown[]> = {};
for (const author of readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()) {
  const dir = join(root, author);
  const rounds = readdirSync(dir)
    .filter((f) => /^r\d+\.mmd$/.test(f) || f === "original.mmd")
    .sort();
  out[author] = [];
  for (const f of rounds) {
    const written = readFileSync(join(dir, f), "utf8");
    // Archer-only syntax a blind first draft does not know: give every edge an ID, drop per-subgraph `direction`.
    // Layout-neutral, so the draft's own structure is what gets measured.
    let n = 0;
    const normalised = written
      .split("\n")
      .filter((l) => !/^\s*direction\s+(LR|RL|TB|TD|BT)\s*$/.test(l))
      .map((l) =>
        /@(-->|-\.->|==>)/.test(l)
          ? l
          : l.replace(/^(\s*[A-Za-z0-9_]+)\s*(-->|-\.->|==>)/, (_, a, arrow) => `${a} e${(n += 1)}@${arrow}`),
      )
      .join("\n");
    const source = (await layoutOf(written).then(
      () => true,
      () => false,
    ))
      ? written
      : normalised;
    try {
      const layout = await layoutOf(source);
      const r = measure(`${author}/${f}`, layout);
      const svgName = f.replace(/\.mmd$/, ".svg");
      writeFileSync(join(dir, svgName), overlaySvg(layout, r, `${author} ${f}`));
      const fidelity = layout.nodes.length === expectNodes && layout.edges.length === expectEdges;
      const { wiresDetail: _w, worstWires: _ww, ...summary } = r;
      out[author]!.push({
        round: f,
        svg: `${author}/${svgName}`,
        fidelity,
        normalised: source !== written,
        source,
        ...summary,
      });
    } catch (error) {
      out[author]!.push({
        round: f,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error),
        source,
      });
    }
  }
  const notes = join(dir, "NOTES.md");
  if (existsSync(notes)) (out[author] as unknown[]).push({ notes: readFileSync(notes, "utf8") });
}
writeFileSync(join(root, "gallery.json"), JSON.stringify(out, null, 1));
for (const [author, rows] of Object.entries(out))
  for (const r of rows as Record<string, unknown>[])
    if (r["round"])
      console.log(
        `${author.padEnd(9)} ${String(r["round"]).padEnd(13)} ${r["error"] ? `ERROR ${r["error"]}` : `score ${r["score"]} ${r["grade"]}  needless ${r["excessBends"]}  max ${r["maxBends"]}  cross ${r["crossings"]}  ${(r["size"] as { width: number; height: number }).width}x${(r["size"] as { width: number; height: number }).height} fit ${r["fitZoom"]}  fidelity ${r["fidelity"] ? "ok" : "FAIL"}`}`,
      );
