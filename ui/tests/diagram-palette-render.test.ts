// The diagram palette as drawn (DESIGN.md, "Diagram palette"; owner, 2026-11-11, revised 2026-11-12): inked
// lines, a title over a description in the family's full ink, quiet tinted fills in dark mode, neutral
// structure (a clear outer panel, pale nested ones) and authored categories -- held on the stylesheet, the layout measurement, the canvas adapter and the export painter
// alike, so the page, an export and a miniature agree. The token floors are `diagram-palette.test.ts`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FAMILIES } from "../src/diagrams/palette";
import { toXFlowNodes } from "../src/diagrams/xflow-adapter";
import { paintGraph, paintNode } from "../src/export/svg";
import type { LayoutGroup, LayoutNode, LayoutResult } from "../src/layout/elk-layout";
import { NODE_DESCRIPTION_FONT_PX, NODE_LABEL_FONT_PX, nodeBox } from "../src/layout/graph-metrics";
import { estimateTextWidth } from "../src/layout/text-measure";
import { contrastRatio, deltaE, parseColour, type Rgb } from "./contrast";

const CSS = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): Map<string, string> {
  const at = CSS.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const body = CSS.slice(CSS.indexOf("{", at) + 1, CSS.indexOf("}", at)).replace(/\/\*[\s\S]*?\*\//g, "");
  return new Map(
    body
      .split(";")
      .map((declaration) => /^\s*([\w-]+)\s*:\s*(.+?)\s*$/s.exec(declaration))
      .filter((match) => match !== null)
      .map((match) => [match[1]!, match[2]!]),
  );
}

function block(selector: string): Map<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  const body = CSS.slice(CSS.indexOf("{", start) + 1, CSS.indexOf("}", start)).replace(/\/\*[\s\S]*?\*\//g, "");
  return new Map(
    body
      .split(";")
      .map((declaration) => /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/s.exec(declaration))
      .filter((match) => match !== null)
      .map((match) => [match[1]!, match[2]!]),
  );
}
const DARK = block(':root,\n:root[data-theme="dark"]');
const LIGHT = block(':root[data-theme="light"]');
const rgb = (theme: Map<string, string>, token: string): Rgb => parseColour(theme.get(token)!).rgb;

const node = (over: Partial<LayoutNode> & { id: string }): LayoutNode => ({
  label: over.id,
  x: 0,
  y: 0,
  width: 180,
  height: 60,
  shape: "rectangle",
  classes: [],
  groupId: undefined,
  ...over,
});
const group = (over: Partial<LayoutGroup> & { id: string }): LayoutGroup => ({
  label: over.id,
  parentId: undefined,
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  ...over,
});
const layout = (over: Partial<LayoutResult>): LayoutResult => ({
  nodes: [],
  edges: [],
  groups: [],
  width: 800,
  height: 600,
  ...over,
});

describe("A. inked lines", () => {
  // Owner, 2026-11-15: lighter than the 2026-11-11 inking (2.5px lines, 2px borders read "cartoony").
  it("draws connections at 2px, node borders at 1.5px and group borders at 2px on the page", () => {
    expect(rule(".archer-edge .react-flow__edge-path").get("stroke-width")).toBe("2");
    // Through the line roles (slice 8): --line-node is 1.5px and --line-boundary 2px.
    expect(rule(".archer-node").get("border")).toBe("var(--line-node) solid var(--node-border)");
    expect(rule(".react-flow__node.archer-group:not(.archer-element-group)").get("border")).toBe(
      "var(--line-boundary) solid var(--group-border)",
    );
    expect(rule(".archer-group.archer-element-group").get("border")).toBe(
      "var(--line-boundary) solid var(--group-border)",
    );
  });

  it("exports the same widths", () => {
    const a = node({ id: "a" });
    const b = node({ id: "b", y: 200 });
    const svg = paintGraph(
      layout({
        nodes: [a, b],
        groups: [group({ id: "g", x: -40, y: -40 })],
        edges: [
          {
            id: "e",
            source: "a",
            target: "b",
            label: undefined,
            points: [
              { x: 90, y: 60 },
              { x: 90, y: 200 },
            ],
            labelAnchor: undefined,
          },
        ],
      }),
    ).content;
    expect(svg).toMatch(/class="export-edge-line"[^>]*stroke-width="2"/);
    expect(svg).toMatch(/data-element-id="g"[^>]*><rect[^>]*stroke-width="2"/);
    expect(paintNode(a, layout({ nodes: [a] }))).toMatch(/<rect[^>]*stroke-width="1\.5"/);
  });

  it("inks the connection and the neutral node border to 4.5:1 or more on the canvas, in both themes", () => {
    for (const theme of [LIGHT, DARK]) {
      expect(contrastRatio(rgb(theme, "--edge"), rgb(theme, "--bg"))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(rgb(theme, "--node-border"), rgb(theme, "--bg"))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(rgb(theme, "--group-border"), rgb(theme, "--bg"))).toBeGreaterThanOrEqual(4.5);
    }
    // The reference's dark slate connection (owner, 2026-11-12: cool slate).
    expect(LIGHT.get("--edge")).toBe("#334155");
    expect(DARK.get("--edge")).toBe("#b4c0cd");
  });
});

describe("B. a title over a description", () => {
  const label = "Farm Core\nThe board, the chat, the task store, and a documented API that agents can read";

  it("measures the first line as a 600 title and the rest as a smaller 400 description, inside the box", () => {
    const box = nodeBox(label, "rectangle", []);
    expect(box.titleRows).toBe(1);
    expect(box.lines[0]).toBe("Farm Core");
    expect(box.lines.length).toBeGreaterThan(2);
    // The box holds the widest row in the weight and size it is drawn in, with its padding.
    for (const [index, row] of box.lines.entries()) {
      const width =
        index < box.titleRows
          ? estimateTextWidth(row, NODE_LABEL_FONT_PX, true)
          : estimateTextWidth(row, NODE_DESCRIPTION_FONT_PX, false);
      expect(width, row).toBeLessThanOrEqual(box.width - 2 * 14);
    }
    expect(box.textHeight).toBeLessThanOrEqual(box.height);
    // A label without a break is all title, as before.
    expect(nodeBox("Private VPN", "rectangle", []).titleRows).toBe(1);
  });

  it("draws the title at 700 and the description at 400 in the node's full ink, on the page and in the export", () => {
    expect(rule(".archer-node").get("font-weight")).toBe("600");
    const description = rule(".archer-node-description-row");
    expect(description.get("font-weight")).toBe("400");
    // Full ink, never the chrome's dim grey (owner, 2026-11-12): the node's own words colour, which a family sets.
    expect(description.get("color")).toBe("inherit");
    // Its size is the named canvas token for the layout's constant (`diagram-typography.test.ts`).
    expect(description.get("font-size")).toBe("var(--type-canvas-node-description)");
    expect(NODE_DESCRIPTION_FONT_PX).toBe(15);
    const box = nodeBox(label, "rectangle", []);
    const svg = paintNode(node({ id: "core", label, height: box.height, width: box.width }), layout({}));
    expect(svg).toMatch(/<text[^>]*font-size="18" font-weight="700"><tspan[^>]*>Farm Core</);
    expect(svg).toMatch(/<text[^>]*font-size="15" font-weight="400">/);
    expect(svg).not.toContain("--text-dim");
  });
});

describe("C. dark mode: bright lines, quiet fills", () => {
  const tinted = FAMILIES.filter((family) => family !== "red");

  // Owner, 2026-11-12: "dark counterpart bright border, quiet fill". A visible tint (CIEDE2000 3 or more from the
  // neutral fill), never a muddy coloured box (no more than 20, and under 1.15:1 in lightness).
  it("fills a family node with a quiet tint of the neutral dark fill", () => {
    for (const family of tinted) {
      const fill = rgb(DARK, `--family-${family}-fill`);
      expect(deltaE(fill, rgb(DARK, "--node-bg")), family).toBeGreaterThanOrEqual(3);
      expect(deltaE(fill, rgb(DARK, "--node-bg")), family).toBeLessThanOrEqual(20);
      expect(contrastRatio(fill, rgb(DARK, "--node-bg")), family).toBeLessThan(1.15);
    }
  });

  it("makes family borders and ink bright: 4.5:1 or more on the canvas and on their panel", () => {
    for (const family of FAMILIES)
      for (const part of ["border", "ink"])
        for (const ground of ["--bg", `--family-${family}-panel`])
          expect(
            contrastRatio(rgb(DARK, `--family-${family}-${part}`), rgb(DARK, ground)),
            `${family} ${part} on ${ground}`,
          ).toBeGreaterThanOrEqual(4.5);
  });

  // The bound chosen (2026-11-11): a tint you can see (CIEDE2000 3 or more from the neutral panel) and no more
  // than faint (8 or less, and under 1.15:1 in lightness), so a panel never becomes a dark, muddy coloured box.
  it("tints a panel only faintly: CIEDE2000 3 to 8 from the neutral panel, and under 1.15:1 from it", () => {
    for (const family of FAMILIES) {
      const panel = rgb(DARK, `--family-${family}-panel`);
      expect(deltaE(panel, rgb(DARK, "--group-bg")), family).toBeGreaterThanOrEqual(3);
      expect(deltaE(panel, rgb(DARK, "--group-bg")), family).toBeLessThanOrEqual(8);
      expect(contrastRatio(panel, rgb(DARK, "--group-bg")), family).toBeLessThan(1.15);
    }
  });
});

describe("D. structure is neutral; colour comes from what a thing is", () => {
  const categories = [{ name: "gpu", fill: "#ecfdf5", stroke: "#0f766e" }];
  const drawn = (groups: LayoutGroup[], nodes: LayoutNode[] = []) =>
    new Map(toXFlowNodes(layout({ groups, nodes, categories })).map((n) => [n.id, n.className ?? ""]));

  it("draws an unclassified outermost group clear and a nested one pale, with nothing inside coloured", () => {
    const classes = drawn(
      [group({ id: "server" }), group({ id: "farm", parentId: "server", x: 20, y: 40, width: 300, height: 200 })],
      [
        node({ id: "core", groupId: "farm", x: 40, y: 80 }),
        node({ id: "store", groupId: "farm", x: 40, y: 160, classes: ["database"] }),
      ],
    );
    expect(classes.get("group:server")).not.toMatch(/archer-family-|archer-group-nested/);
    expect(classes.get("group:farm")).toContain("archer-group-nested");
    expect(classes.get("group:farm")).not.toMatch(/archer-family-/);
    expect(classes.get("core")).not.toMatch(/archer-family-/);
    expect(classes.get("store")).toContain("archer-family-plum");
    // The nested step: the pale panel and the quieter outline.
    const nested = rule(".archer-group.archer-group-nested");
    expect(nested.get("--group-bg")).toBe("var(--group-bg-alt)");
    expect(nested.get("--group-border")).toBe("var(--group-border-alt)");
  });

  it("draws a classed group as a family panel, its plain nodes as light cards in its border and ink", () => {
    const classes = drawn(
      [group({ id: "gpu1", classes: ["gpu"] })],
      [node({ id: "model", groupId: "gpu1", x: 40, y: 80 })],
    );
    expect(classes.get("group:gpu1")).toContain("archer-family-teal");
    expect(classes.get("model")).toContain("archer-family-teal");
    expect(classes.get("model")).toContain("archer-family-card");
    const card = rule(".archer-node.archer-family-teal:where(.archer-family-card)");
    expect(card.get("--node-bg")).toBe("var(--family-teal-card)");
    expect(card.get("--node-text")).toBe("var(--family-teal-ink)");
  });

  it("writes every family's words, fill and border into the node's own tokens", () => {
    for (const family of FAMILIES) {
      const words = rule(`.archer-node.archer-family-${family}`);
      expect(words.get("--node-border"), family).toBe(`var(--family-${family}-border)`);
      expect(words.get("--node-text"), family).toBe(`var(--family-${family}-text)`);
      expect(rule(`.archer-node.archer-family-${family}:where(:not(.archer-family-card))`).get("--node-bg")).toBe(
        `var(--family-${family}-fill)`,
      );
      const panel = rule(`.archer-group.archer-family-${family}`);
      expect(panel.get("--group-bg"), family).toBe(`var(--family-${family}-panel)`);
      expect(panel.get("--group-caption"), family).toBe(`var(--family-${family}-ink)`);
    }
  });

  it("lets a faded family node fade: no family rule outranks the fade's", () => {
    // `.react-flow__node.archer-dimmed` is two classes; a family rule with a third (a bare `:not(...)` counts its
    // argument) would keep a faded box at full colour.
    for (const match of CSS.matchAll(/\n(\.archer-node\.archer-family-[\w-]+[^{\n]*)\{/g))
      expect(
        match[1]!.replace(/:where\([^)]*\)+/g, "").match(/\.[\w-]+|:not\(/g)?.length,
        match[1],
      ).toBeLessThanOrEqual(2);
  });

  it("exports the same: clear outer panel, pale nested one, family panel and card, full-ink words", () => {
    const svg = paintGraph(
      layout({
        categories,
        groups: [
          group({ id: "server" }),
          group({ id: "farm", parentId: "server", x: 20, y: 20, width: 200, height: 100 }),
          group({ id: "gpu1", parentId: "server", x: 20, y: 160, width: 200, height: 100, classes: ["gpu"] }),
        ],
        nodes: [node({ id: "model", groupId: "gpu1", x: 30, y: 180 })],
      }),
    ).content;
    const panel = (id: string) => new RegExp(`data-element-id="${id}"[^>]*><rect([^>]*)>`).exec(svg)![1]!;
    expect(panel("server")).toContain('fill="var(--group-bg)"');
    expect(panel("server")).toContain('stroke="var(--group-border)"');
    expect(panel("farm")).toContain('fill="var(--group-bg-alt)"');
    expect(panel("farm")).toContain('stroke="var(--group-border-alt)"');
    expect(panel("gpu1")).toContain('fill="var(--family-teal-panel)"');
    const model = paintNode(
      node({ id: "model", groupId: "gpu1", label: "Farm model\nQwen" }),
      layout({ categories, groups: [group({ id: "gpu1", classes: ["gpu"] })] }),
    );
    expect(model).toContain('fill="var(--family-teal-card)"');
    expect(model).toContain('stroke="var(--family-teal-border)"');
    expect(model).toMatch(/<g fill="var\(--family-teal-ink\)" stroke="none">/);
  });
});

describe("E. authored categories", () => {
  const categories = [
    { name: "gpu", fill: "#ecfdf5", stroke: "#0f766e" },
    { name: "sandbox", fill: "#fdf1e7", stroke: "#c2410c", dashed: true },
    { name: "real", fill: "#7f1d1d", stroke: "#450a0a" },
  ];

  it("draws gpu teal, sandbox rust and dashed, and the consequential red solid, in any source order", () => {
    for (const order of [categories, [...categories].reverse()]) {
      const classes = new Map(
        toXFlowNodes(
          layout({
            categories: order,
            nodes: [
              node({ id: "model", classes: ["gpu"] }),
              node({ id: "staging", x: 300, classes: ["sandbox"] }),
              node({ id: "ship", x: 600, classes: ["real"] }),
            ],
          }),
        ).map((n) => [n.id, n.className ?? ""]),
      );
      expect(classes.get("model")).toContain("archer-family-teal");
      expect(classes.get("staging")).toContain("archer-family-rust");
      expect(classes.get("staging")).toContain("archer-category-dashed");
      expect(classes.get("ship")).toContain("archer-family-red");
    }
    expect(rule(".archer-node.archer-category-dashed").get("border-style")).toBe("dashed");
    // On the solid red the keyboard's ring is white, until selection paints the body its own fill.
    expect(rule(".archer-node.archer-family-red:where(:not(.selected))").get("--kbd-focus")).toBe(
      "var(--family-red-text)",
    );
  });

  it("exports the same: the family's colours and words, and a dash", () => {
    const model = node({ id: "model", classes: ["gpu"] });
    const staging = node({ id: "staging", classes: ["sandbox"] });
    const ship = node({ id: "ship", classes: ["real"] });
    const drawing = layout({ categories, nodes: [model, staging, ship] });
    expect(paintNode(model, drawing)).toContain('stroke="var(--family-teal-border)"');
    expect(paintNode(model, drawing)).toContain('fill="var(--family-teal-fill)"');
    expect(paintNode(staging, drawing)).toContain('stroke-dasharray="5 3"');
    expect(paintNode(staging, drawing)).toContain('stroke="var(--family-rust-border)"');
    expect(paintNode(ship, drawing)).toContain('fill="var(--family-red-fill)"');
    expect(paintNode(ship, drawing)).toMatch(/<g fill="var\(--family-red-text\)" stroke="none">/);
  });
});

describe("export panels nest", () => {
  it("paints a parent's opaque panel before its children, whatever order the layout lists them in", () => {
    const svg = paintGraph(
      layout({
        groups: [
          group({ id: "gpu", parentId: "cluster", x: 40, y: 40, width: 100, height: 80 }),
          group({ id: "cluster", parentId: "server", x: 20, y: 20, width: 200, height: 160 }),
          group({ id: "server", x: 0, y: 0, width: 400, height: 300 }),
          group({ id: "side", x: 500, y: 0, width: 100, height: 100 }),
        ],
      }),
    ).content;
    const at = (id: string) => svg.indexOf(`data-element-id="${id}"`);
    expect(at("server")).toBeGreaterThanOrEqual(0);
    expect(at("server")).toBeLessThan(at("cluster"));
    expect(at("cluster")).toBeLessThan(at("gpu"));
  });
});

describe("F. no shadow under a node (owner, 2026-11-12: the shadows did not look clean; the Quiet Depth Rule)", () => {
  // Replaces the soft-shadow tests of 55ad5c85, which pinned the look the owner has now taken back.
  it("has no resting shadow token in either theme", () => {
    for (const theme of [LIGHT, DARK]) {
      expect(theme.has("--node-shadow")).toBe(false);
      expect(theme.has("--node-shadow-color")).toBe(false);
    }
  });

  it("casts none at rest, on hover, under the keyboard ring or as a C4 system's frame; selection keeps its glow", () => {
    expect(rule(".archer-node").has("box-shadow")).toBe(false);
    expect(rule(".archer-node.selectable:hover:not(.selected)").get("box-shadow")).toBe("var(--node-ring-hover)");
    expect(rule(".archer-node.archer-kbd-focus").get("box-shadow")).toBe("inset 0 0 0 3px var(--kbd-focus) !important");
    expect(rule(".archer-node.archer-kind-system").get("box-shadow")).toBe(
      "inset 0 0 0 2px var(--node-bg), inset 0 0 0 3px var(--node-border)",
    );
    expect(rule(".archer-node-hexagon-body").has("filter")).toBe(false);
    expect(CSS).not.toMatch(/\n\.archer-node\.archer-shape-diamond \{[^}]*filter/);
  });

  it("exports no shadow layer or filter", () => {
    const svg = paintGraph(layout({ nodes: [node({ id: "a" }), node({ id: "b", y: 200 })] })).content;
    expect(svg).not.toContain("archer-node-shadow");
    expect(svg).not.toContain("export-node-shadows");
    expect(svg).not.toContain("<filter");
  });
});
