// Side by side, for review: the same `+` press laid out by option 1 (ELK relayout, seeded
// semi-interactively with model order off, the page's hidden fallback) and by grow in place v2 (its
// own router, the page's layout), then v2's close, as static SVG in one page with Archer's
// canvas colours, dark and light. Opt-in: NEST_COMPARE_OUT=<directory> writes index.html.
// Not a gate; docs/proposals/ws-b-boundary-zoom.md §4 and docs/proposals/zoom-layout-lab.md have
// the numbers it illustrates.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { LayoutResult } from "../src/layout/elk-layout";
import type { ProjectedView } from "../src/diagrams/projection";
import { arrowsOf } from "../src/diagrams/figures";
import { canonicalOpen } from "../src/nesting/nest-view";
import { boxes, centre, closeOut, layOut, quality, viewOf, type Laid } from "./support/nest-strategies";

const OUT = process.env.NEST_COMPARE_OUT;

const CASES = [
  { title: "Small C4: open the system", path: "ts/test/fixtures/c4/nested.mmd", from: [] as string[], open: "shop" },
  { title: "Small C4: then open the API", path: "ts/test/fixtures/c4/nested.mmd", from: ["shop"], open: "api" },
  {
    title: "23 elements: open “Shared operations”",
    path: ".archer/diagrams/service/application-components.mmd",
    from: [],
    open: "core",
  },
  {
    title: "23 elements: open “Compiler”",
    path: ".archer/diagrams/service/application-components.mmd",
    from: [],
    open: "compiler",
  },
  {
    title: "156 nodes: open Group 0",
    path: "tools/devkit/corpus/awkward/.archer/diagrams/flow-large.mmd",
    from: [],
    open: "g0",
  },
];

/**
 * The smallest scale a picture is drawn at: a very wide one scrolls sideways instead of shrinking
 * until its strokes, text and +/− vanish (strokes are also non-scaling, below).
 */
const MIN_SCALE = 0.5;

const esc = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * One picture, in the expand/collapse visual language: a closed box that can open has a light
 * accent fill and an accent "+" (its border stays neutral: emphasis owns borders); every open frame,
 * at every level, has an accent outline and an accent "−" on a neutral fill; plain boxes are
 * unchanged. Which box this press opened is said in the caption, not drawn.
 */
function svg(layout: LayoutResult, view: ProjectedView, id: string, scale: number): string {
  const pad = 16;
  const parts: string[] = [];
  const marker = `m-${id}`;
  parts.push(
    // One scale per row: each picture's width is its share of the widest in the row.
    `<svg viewBox="${-pad} ${-pad} ${layout.width + 2 * pad} ${layout.height + 2 * pad}" style="width:max(${(scale * 100).toFixed(1)}%, ${((layout.width + 2 * pad) * MIN_SCALE).toFixed(0)}px)" role="img" aria-label="layout" xmlns="http://www.w3.org/2000/svg">`,
    `<defs><marker id="${marker}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrow"/></marker></defs>`,
  );
  const depth = (groupId: string | undefined): number => {
    let d = 0;
    for (
      let g = layout.groups.find((x) => x.id === groupId);
      g !== undefined;
      g = layout.groups.find((x) => x.id === g!.parentId)
    )
      d++;
    return d;
  };
  for (const group of [...layout.groups].sort((a, b) => depth(a.id) - depth(b.id))) {
    parts.push(
      `<rect class="frame open" x="${group.x}" y="${group.y}" width="${group.width}" height="${group.height}" rx="10"/>`,
    );
    const at = group.caption ?? { x: group.x + 10, y: group.y + 8 };
    parts.push(`<text class="caption" x="${at.x}" y="${at.y + 13}">${esc(clip(group.label, 40))}</text>`);
    // Every frame in the nested view is an open container: "−" at its top right closes it
    // (ws-b plan §5; closed boxes have "+").
    const mx = group.x + group.width - 22;
    const my = group.y + 6;
    parts.push(
      `<rect class="plus" x="${mx}" y="${my}" width="16" height="16" rx="4"/><path class="plus-glyph" d="M${mx + 4},${my + 8} H${mx + 12}"/>`,
    );
  }
  // An end on a frame's edge that is not the wire's own frame end is a bundle's shared exit (or
  // a trunk's end at its frame): no arrowhead there.
  const onFrameEdge = (p: { x: number; y: number }) =>
    layout.groups.some((g) =>
      Math.abs(p.x - g.x) < 0.5 || Math.abs(p.x - g.x - g.width) < 0.5
        ? p.y >= g.y - 0.5 && p.y <= g.y + g.height + 0.5
        : (Math.abs(p.y - g.y) < 0.5 || Math.abs(p.y - g.y - g.height) < 0.5) &&
          p.x >= g.x - 0.5 &&
          p.x <= g.x + g.width + 0.5,
    );
  const isFrame = (drawnId: string) => layout.groups.some((g) => g.id === drawnId || `group:${g.id}` === drawnId);
  for (const edge of layout.edges) {
    if (edge.points.length < 2) continue;
    const bundle = edge.id.startsWith("bundle:") || edge.id.startsWith("trunk:");
    const count = bundle ? Number(/^(\d+)/.exec(edge.label ?? "")?.[1] ?? 2) : 1;
    const width = count === 1 ? 1.5 : count === 2 ? 3.5 : 5.5;
    const declared = arrowsOf(edge.figure, edge.bidirectional === true);
    const first = edge.points[0]!;
    const last = edge.points[edge.points.length - 1]!;
    const trunk = edge.id.startsWith("trunk:");
    const arrows = {
      start: declared.start && !(trunk ? isFrame(edge.source) : onFrameEdge(first) && !isFrame(edge.source)),
      end: declared.end && !(trunk ? isFrame(edge.target) : onFrameEdge(last) && !isFrame(edge.target)),
    };
    const d = edge.points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    // A trunk lists its members and their words on hover (until the page has its member list).
    const exit = trunk ? (isFrame(edge.source) ? first : last) : undefined;
    const members =
      exit === undefined
        ? []
        : layout.edges.filter(
            (m) =>
              !m.id.startsWith("trunk:") &&
              m.points.length >= 2 &&
              [m.points[0]!, m.points[m.points.length - 1]!].some(
                (p) => Math.abs(p.x - exit.x) < 0.5 && Math.abs(p.y - exit.y) < 0.5,
              ),
          );
    const title =
      members.length === 0
        ? ""
        : `<title>${esc(`${edge.label}: ${members.map((m) => `${m.source} → ${m.target}${m.label ? ` (${m.label})` : ""}`).join("; ")}`)}</title>`;
    parts.push(
      `<path class="wire${edge.line === "dotted" ? " dotted" : ""}" d="${d}" style="stroke-width:${width}"${arrows.end ? ` marker-end="url(#${marker})"` : ""}${arrows.start ? ` marker-start="url(#${marker})"` : ""}>${title}</path>`,
    );
  }
  for (const edge of layout.edges) {
    const text = edge.label;
    if (!text || edge.labelAnchor === undefined) continue;
    const a = edge.labelAnchor;
    parts.push(`<rect class="plate" x="${a.x}" y="${a.y}" width="${a.width}" height="${a.height}" rx="4"/>`);
    parts.push(
      `<text class="wire-label" x="${a.x + a.width / 2}" y="${a.y + a.height / 2 + 4}" text-anchor="middle">${esc(clip(text, 22))}</text>`,
    );
  }
  for (const node of layout.nodes) {
    const folded = view.nodes.find((n) => n.id === node.id)?.folded !== undefined;
    parts.push(
      `<rect class="node${folded ? " expandable" : ""}" x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="${node.shape === "rounded" ? 14 : 6}"/>`,
    );
    const c = centre(node);
    const description = node.figure?.type === "c4" ? node.figure.description : undefined;
    const lines = [clip(node.label, Math.max(6, Math.floor(node.width / 7.2)))];
    parts.push(
      `<text class="label" x="${c.x}" y="${c.y + (description ? -2 : 4)}" text-anchor="middle">${esc(lines[0]!)}</text>`,
    );
    if (description && folded)
      parts.push(
        `<text class="inside" x="${c.x}" y="${c.y + 14}" text-anchor="middle">${esc(clip(description, 28))}</text>`,
      );
    if (folded) {
      const x = node.x + node.width - 22;
      const y = node.y + 6;
      parts.push(
        `<rect class="plus" x="${x}" y="${y}" width="16" height="16" rx="4"/><path class="plus-glyph" d="M${x + 4},${y + 8} H${x + 12} M${x + 8},${y + 4} V${y + 12}"/>`,
      );
    }
  }
  parts.push("</svg>");
  return parts.join("");
}

/** A close (compaction) against the layout the box was opened from. */
function closeMeasures(before: Laid, open: Laid, closed: Laid): string {
  const b0 = boxes(before.layout, before.view);
  const b2 = boxes(closed.layout, closed.view);
  const ids = before.layout.nodes.map((n) => n.id).filter((id) => b2.has(id));
  const drift =
    ids.reduce(
      (sum, id) =>
        sum + Math.hypot(centre(b0.get(id)!).x - centre(b2.get(id)!).x, centre(b0.get(id)!).y - centre(b2.get(id)!).y),
      0,
    ) / Math.max(1, ids.length);
  const area = (closed.layout.width * closed.layout.height) / (before.layout.width * before.layout.height);
  const q = quality(closed.layout, closed.view);
  return `area ${(area * 100).toFixed(0)}% of before (open ${(((open.layout.width * open.layout.height) / (before.layout.width * before.layout.height)) * 100).toFixed(0)}%) · boxes ${drift.toFixed(0)} px from where they were · ${q.crossings} crossings · ${closed.ms.toFixed(0)} ms`;
}

function measures(before: Laid, after: Laid, openedDrawn: string): string {
  const b0 = boxes(before.layout, before.view);
  const b1 = boxes(after.layout, after.view);
  // The boxes both layouts draw, but the one opened; frames left out (as the measurement does).
  const ids = before.layout.nodes.map((n) => n.id).filter((id) => id !== openedDrawn && b1.has(id));
  let inversions = 0;
  let pairs = 0;
  const sign = (d: number) => (d > 8 ? 1 : d < -8 ? -1 : 0);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [p, q, r, s] = [b0.get(ids[i]!)!, b0.get(ids[j]!)!, b1.get(ids[i]!)!, b1.get(ids[j]!)!].map(centre);
      pairs++;
      if (sign(p!.x - q!.x) * sign(r!.x - s!.x) === -1 || sign(p!.y - q!.y) * sign(r!.y - s!.y) === -1) inversions++;
    }
  }
  const q = quality(after.layout, after.view);
  const searches = after.profile?.counts["search.calls"];
  return `${inversions} of ${pairs} pairs swapped · ${q.crossings} crossings · ${q.overlaps} overlapping segments · ${q.frameFaults} frame faults · ${(q.bends / Math.max(1, q.edges)).toFixed(1)} bends per wire${searches === undefined ? "" : ` · ${searches} searches`} · ${after.ms.toFixed(0)} ms`;
}

test.skipIf(OUT === undefined)(
  "renders option 1 and grow in place v2 side by side",
  async () => {
    const sections: string[] = [];
    let index = 0;
    for (const c of CASES) {
      const full = await viewOf(c.path);
      const next = canonicalOpen(full, [...c.from, c.open]);
      const before = await layOut(full, c.from, "plain");
      const option1 = await layOut(full, next, "semi-free", before);
      const grown2 = await layOut(full, next, "grow2", before, c.open);
      const closed = await closeOut(full, c.from, grown2, c.open);
      const bundled = await layOut(full, next, "grow2b", before, c.open);
      const drawn = full.groups.find((g) => g.id === c.open)?.element === true ? c.open : `group:${c.open}`;
      const widest = Math.max(before.layout.width, option1.layout.width, grown2.layout.width, bundled.layout.width);
      const openedLabel = full.groups.find((g) => g.id === c.open)?.label ?? c.open;
      const figure = (title: string, laid: Laid, note: string) =>
        `<figure><figcaption><b>${esc(title)}</b><span>${esc(note)}</span></figcaption><div class="canvas">${svg(laid.layout, laid.view, `f${index++}`, laid.layout.width / widest)}</div></figure>`;
      const large = full.nodes.length + full.groups.length > 20;
      sections.push(
        `<section><h2>${esc(c.title)}</h2><div class="row${large ? " stacked" : " four"}">` +
          figure("Before", before, "the press is on the box with +") +
          figure("Option 1: ELK relayout", option1, `opened: ${openedLabel} · ${measures(before, option1, drawn)}`) +
          figure("Grow in place v2 (lab)", grown2, `opened: ${openedLabel} · ${measures(before, grown2, drawn)}`) +
          figure(
            "v2 with bundled lines (grow2b)",
            bundled,
            `opened: ${openedLabel} · ${measures(before, bundled, drawn)}`,
          ) +
          figure("v2, closed again", closed, `closed: ${openedLabel} · ${closeMeasures(before, grown2, closed)}`) +
          `</div></section>`,
      );
    }
    const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zoom layout comparison</title>
<style>
:root{color-scheme:dark;--bg:#191816;--surface:#141311;--node-bg:#25231f;--node-border:#8c867b;--node-text:#f7f5f0;--edge:#aaa49a;--text:#eeebe5;--text-dim:#aaa49a;--text-faint:#8f8a80;--accent:#9db4ff;--accent-fill:#1f2b52;--expand-fill:#2a3a70;--bnd-bg:rgb(255 255 255 / .025);--bnd-line:#3a3632;--border:#302d29;--font:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){color-scheme:light;--bg:#ebe9e4;--surface:#f8f7f4;--node-bg:#fffefb;--node-border:#7f7a70;--node-text:#1f1d1a;--edge:#6f6a61;--text:#1f1d1a;--text-dim:#5c5850;--text-faint:#6a665e;--accent:#2645a3;--accent-fill:#e1e6f6;--expand-fill:#d6def6;--bnd-bg:rgb(0 0 0 / .03);--bnd-line:#cfcac1;--border:#d9d5cd}}
:root[data-theme="light"]{color-scheme:light;--bg:#ebe9e4;--surface:#f8f7f4;--node-bg:#fffefb;--node-border:#7f7a70;--node-text:#1f1d1a;--edge:#6f6a61;--text:#1f1d1a;--text-dim:#5c5850;--text-faint:#6a665e;--accent:#2645a3;--accent-fill:#e1e6f6;--expand-fill:#d6def6;--bnd-bg:rgb(0 0 0 / .03);--bnd-line:#cfcac1;--border:#d9d5cd}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 var(--font)}
main{max-width:1500px;margin:0 auto;padding:24px 16px 48px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:baseline;justify-content:space-between}
h1{font-size:20px;margin:0}h2{font-size:15px;margin:28px 0 10px}
p{color:var(--text-dim);max-width:70ch}
.seg{display:inline-flex;border:1px solid var(--border);border-radius:8px;overflow:hidden}
.seg button{background:none;border:0;color:var(--text-dim);font:inherit;padding:6px 12px;cursor:pointer}
.seg button[aria-pressed="true"]{background:var(--accent-fill);color:var(--text)}
.row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.row.four{grid-template-columns:repeat(2,minmax(0,1fr))}
.row.stacked{grid-template-columns:1fr}
@media (max-width:900px){.row{grid-template-columns:1fr}}
figure{margin:0;background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden}
figcaption{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-bottom:1px solid var(--border)}
figcaption span{color:var(--text-faint);font-size:12px}
.canvas{padding:8px;overflow-x:auto}.canvas svg{height:auto;display:block}
.frame,.node,.wire,.plate,.plus,.plus-glyph{vector-effect:non-scaling-stroke}
.frame{fill:var(--bnd-bg);stroke:var(--bnd-line);stroke-width:1.25}
.frame.open{stroke:var(--accent);stroke-width:2}
.node.expandable{fill:var(--expand-fill)}
.caption{fill:var(--text);font:600 12px var(--font)}
.node{fill:var(--node-bg);stroke:var(--node-border);stroke-width:1.25}
.label{fill:var(--node-text);font:500 12px var(--font)}
.inside{fill:var(--text-faint);font:400 11px var(--font)}
.wire{fill:none;stroke:var(--edge);stroke-linejoin:round}.wire.dotted{stroke-dasharray:2 4}
.arrow{fill:var(--edge)}
.plate{fill:var(--surface);stroke:var(--border)}
.wire-label{fill:var(--text-dim);font:400 11px var(--font)}
.plus{fill:var(--accent-fill);stroke:var(--accent)}.plus-glyph{stroke:var(--accent);stroke-width:1.75;stroke-linecap:round}
</style></head><body><main>
<header><h1>Opening a box: four layouts</h1><div class="seg" role="group" aria-label="Theme"><button data-v="auto">Auto</button><button data-v="dark">Dark</button><button data-v="light">Light</button></div></header>
<p>Each row is one press of <b>+</b>. Option 1 lays the whole view out again with ELK, seeded from where things were. Grow in place v2 grows the box along the flow and into free space, stretches the existing wires instead of re-routing them, and routes only the wires into the opened box with its own router (no third-party code). The last picture closes the box again by compaction, without the cached “before”. Expand and collapse look the same everywhere: a box that can open has a light blue fill and a blue +; every open frame, at every level, has a blue outline and a blue −. Borders stay neutral otherwise (in Archer, coloured borders mean emphasis). The caption names the box the press opened. Line widths stay the same on screen at any scale; a very wide picture scrolls sideways rather than shrinking below half size. Under each picture: pairs of untouched boxes that swapped left/right or above/below, wire crossings, segments of two wires drawn on one line, wires through or along a frame they have no end in, bends per wire, and the time it took here.</p>
${sections.join("\n")}
</main><script>
(function(){var root=document.documentElement,key="zoom-compare.theme",v="auto";try{v=localStorage.getItem(key)||"auto"}catch(e){}
function set(x){v=x;if(x==="auto")root.removeAttribute("data-theme");else root.setAttribute("data-theme",x);document.querySelectorAll(".seg button").forEach(function(b){b.setAttribute("aria-pressed",String(b.dataset.v===x))});try{localStorage.setItem(key,x)}catch(e){}}
document.querySelector(".seg").addEventListener("click",function(e){var b=e.target.closest("button");if(b)set(b.dataset.v)});set(v);})();
</script></body></html>`;
    mkdirSync(OUT!, { recursive: true });
    writeFileSync(join(OUT!, "index.html"), page);
    expect(sections.length).toBe(CASES.length);
  },
  120_000,
);
