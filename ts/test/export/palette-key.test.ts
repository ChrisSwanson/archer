import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compile } from "../../src/mermaid/index.ts";
import { exportDiagram } from "../../src/export/index.ts";
import { testResources } from "./resources.ts";

// The Diagram Key's colours travel with an exported drawing (DESIGN.md, "The Key"): beside the drawing,
// top right, as the owner's reference legend is, each row a sample in the literal colours its members are
// painted in, in the chosen theme. The owner's home rig is the reference drawing.
const HOME_RIG = resolve(import.meta.dirname, "../../../ui/tests/fixtures/palette/home-rig.mmd");
const SHIP_LOOP = resolve(import.meta.dirname, "../../../ui/tests/fixtures/palette/ship-loop.mmd");

async function exported(theme: "light" | "dark", diagramKey = true, file = HOME_RIG): Promise<string> {
  const source = await readFile(file, "utf8");
  const model = (await compile(source)).model;
  expect(model).not.toBeNull();
  const envelope = {
    schemaVersion: 2,
    revision: `sha256:${"a".repeat(64)}`,
    view: { id: "home-rig", kind: "freeform", title: "The Home Rig" },
    model,
  };
  const svg = await exportDiagram(envelope, {
    resources: await testResources(),
    mode: "presentation",
    theme,
    presentation: { diagramKey },
  });
  return new TextDecoder().decode(svg.bytes);
}

/** The attributes of the first `<tag …>` after `from` in `text`. */
function attributesAfter(text: string, from: number, tag: string): Record<string, string> {
  const at = text.indexOf(`<${tag} `, from);
  expect(at, `<${tag}> after ${from}`).toBeGreaterThanOrEqual(0);
  const open = text.slice(at, text.indexOf(">", at));
  return Object.fromEntries([...open.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
}

/** A member's painted box: a group's panel, or a node's body (after its hidden emphasis outline). */
function member(svg: string, id: string, channel: "group" | "node"): Record<string, string> {
  const at = svg.indexOf(`data-element-id="${id}"`);
  const own = attributesAfter(svg, channel === "group" ? at : svg.indexOf('class="export-node-body"', at), "rect");
  // A neutral node paints in what it inherits: the drawing's own fill and border (`--node-bg`, `--node-border`).
  const [, fill, stroke] = /<g fill="([^"]+)" stroke="([^"]+)" color=/.exec(svg)!;
  return { fill: fill!, stroke: stroke!, ...own };
}

for (const theme of ["light", "dark"] as const)
  test(`the ${theme} export keys its colours beside the drawing, in its members' literal paint`, async () => {
    const svg = await exported(theme);
    const keyAt = svg.indexOf('data-export-palette-key="true"');
    expect(keyAt, "the export's colour key").toBeGreaterThanOrEqual(0);
    const rows = [...svg.slice(keyAt).matchAll(/data-key-row="([^"]+)"/g)].map((m) => m[1]);
    // Plain structure (the home server) is neutral and has no row (owner, 2026-11-12).
    expect(rows).toEqual(["kind:Person", "category:sandbox", "category:gpu"]);
    const swatch = (row: string): Record<string, string> =>
      attributesAfter(svg, svg.indexOf(`data-key-row="${row}"`), "rect");
    // Literal colours, the same as the member each row names.
    for (const [row, id, channel] of [
      ["kind:Person", "you", "node"],
      // Every gpu member is a panel or a light card in one: the sample is the panel.
      ["category:gpu", "gpu1", "group"],
      ["category:sandbox", "staging", "node"],
    ] as const) {
      const sample = swatch(row),
        painted = member(svg, id, channel);
      expect(sample.fill, `${row} fill`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(sample.fill, `${row} fill`).toBe(painted.fill);
      expect(sample.stroke, `${row} border`).toBe(painted.stroke);
      // At the members' line role (review, 2026-11-12): a panel's 1.5px, a node's 1.5px (owner, 2026-11-15) --
      // the member's own width.
      expect(sample["stroke-width"], `${row} border width`).toBe("1.5");
      expect(sample["stroke-width"], `${row} border width`).toBe(painted["stroke-width"]);
      expect(sample["stroke-dasharray"] ?? "none", `${row} dash`).toBe(painted["stroke-dasharray"] ?? "none");
    }
    expect(swatch("category:sandbox")["stroke-dasharray"]).toBe("5 3");
    // Each row is named in words, beside its sample.
    const key = svg.slice(keyAt);
    for (const words of ["Person", "gpu", "sandbox"]) expect(key).toContain(words);
    expect(key).not.toContain("The Home Server");
    // Beside the drawing: the key starts right of every painted member.
    const open = svg.slice(svg.lastIndexOf("<g ", keyAt), svg.indexOf(">", keyAt));
    const keyX = Number(/transform="translate\(([-\d.]+)/.exec(open)?.[1]);
    const server = member(svg, "server", "group");
    expect(keyX).toBeGreaterThan(Number(server.x) + Number(server.width));
  }, 20_000);

test("the export says a kind once: its colour row keeps the glyph, the notation key drops it", async () => {
  const svg = await exported("light");
  const key = svg.slice(svg.indexOf('data-export-palette-key="true"'));
  expect(key).toContain(">Person<");
  expect(svg).not.toContain("Person: The source marks this node as a person.");
  // Plain groups need no row, so the home rig has nothing left for a notation box (owner, 2026-11-12).
  expect(svg).not.toContain("Group: A labelled frame groups nodes");
  expect(svg).not.toContain('data-export-presentation="true"');
}, 20_000);

test("what has no colour row and is not plain stays in the export's notation key: an authored line", async () => {
  const svg = await exported("light", true, SHIP_LOOP);
  const box = svg.slice(svg.indexOf('data-export-presentation="true"'));
  expect(box).toContain(">Diagram Key<");
  expect(box).toContain("Dotted line: Lessons feed back");
  expect(box).not.toContain("Group:");
}, 20_000);

test("the export's legend says each colour in the canvas's words: the author's meaning, a kind's word", async () => {
  const svg = await exported("dark");
  const key = svg.slice(svg.indexOf('data-export-palette-key="true"'));
  const labels = [...key.matchAll(/<tspan[^>]*>([^<]+)<\/tspan>/g)].map((m) => m[1]);
  expect(labels.slice(0, 3)).toEqual(["Person", "Walled-off sandbox", "Model server on a GPU"]);
}, 20_000);

test("an export without the Diagram Key has no colour key", async () => {
  expect(await exported("light", false)).not.toContain("data-export-palette-key");
});
