/**
 * Round 1 (UI/UX) batch F2: semantics, tokens, contrast and motion.
 * Each block pins one row of the round's fix list; every one failed before its fix.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toXFlowEdges, toXFlowNodes } from "../src/diagrams/xflow-adapter";
import type { LayoutResult } from "../src/layout/elk-adapter";

const css = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

describe("#6 ER relationship descriptions carry the cardinality (C-02/Cl-10a)", () => {
  const er: LayoutResult = {
    nodes: [
      {
        id: "CUSTOMER",
        x: 0,
        y: 0,
        width: 120,
        height: 60,
        label: "Customer",
        shape: "rectangle",
        classes: [],
        groupId: undefined,
      },
      {
        id: "ORDER",
        x: 0,
        y: 120,
        width: 120,
        height: 60,
        label: "Order",
        shape: "rectangle",
        classes: [],
        groupId: undefined,
      },
      {
        id: "ADDRESS",
        x: 200,
        y: 0,
        width: 120,
        height: 60,
        label: "Address",
        shape: "rectangle",
        classes: [],
        groupId: undefined,
      },
    ],
    edges: [
      // CUSTOMER ||--o{ ORDER : places
      {
        id: "places",
        source: "CUSTOMER",
        target: "ORDER",
        label: "places",
        points: [],
        labelAnchor: undefined,
        figure: { type: "cardinality", source: "exactly-one", target: "zero-or-more" },
      },
      // CUSTOMER |o..|{ ADDRESS : "" (non-identifying, no caption)
      {
        id: "lives",
        source: "CUSTOMER",
        target: "ADDRESS",
        label: undefined,
        line: "dotted",
        points: [],
        labelAnchor: undefined,
        figure: { type: "cardinality", source: "zero-or-one", target: "one-or-more" },
      },
    ],
    groups: [],
    width: 400,
    height: 200,
  } as LayoutResult;

  it("names each end's multiplicity, from the model, and whether it is identifying", () => {
    const edges = toXFlowEdges(er);
    expect(edges.find((e) => e.id === "places")!.ariaLabel).toBe(
      "Customer → Order: places, exactly one Customer to zero or more Order, identifying",
    );
    expect(edges.find((e) => e.id === "lives")!.ariaLabel).toBe(
      "Customer → Address, zero or one Customer to one or more Address, non-identifying",
    );
  });
});

describe("#8 containment is stated on each member, from the model (Cl-10c)", () => {
  const nested: LayoutResult = {
    nodes: [
      {
        id: "packing",
        x: 10,
        y: 30,
        width: 100,
        height: 40,
        label: "Packing",
        shape: undefined,
        classes: [],
        groupId: "fulfilment",
        figure: { type: "state", kind: "state" },
      },
      {
        id: "api",
        x: 10,
        y: 30,
        width: 100,
        height: 40,
        label: "API",
        shape: undefined,
        classes: [],
        groupId: "backend",
      },
      {
        id: "web",
        x: 300,
        y: 0,
        width: 100,
        height: 40,
        label: "Web",
        shape: undefined,
        classes: [],
        groupId: undefined,
      },
    ],
    edges: [],
    groups: [
      {
        id: "fulfilment",
        label: "Fulfilment",
        parentId: "platform",
        element: true,
        figure: { type: "composite" },
        x: 0,
        y: 0,
        width: 200,
        height: 120,
      },
      {
        id: "platform",
        label: "Platform",
        parentId: undefined,
        element: true,
        figure: { type: "boundary", kind: "system" },
        x: 0,
        y: 0,
        width: 260,
        height: 200,
      },
      { id: "backend", label: "Backend", parentId: undefined, x: 0, y: 220, width: 200, height: 120 },
    ],
    width: 500,
    height: 400,
  } as LayoutResult;

  it("a node in an open container says which one it is in; a frame in a frame says so too", () => {
    const nodes = toXFlowNodes(nested);
    const name = (id: string) => nodes.find((n) => n.id === id)!.ariaLabel;
    expect(name("packing")).toBe("Packing, in Fulfilment");
    // A plain group (an architecture group, a flowchart subgraph without an id of its own) is named too.
    expect(name("api")).toBe("API, in Backend");
    expect(name("fulfilment")).toBe("Fulfilment, composite state, in Platform");
    expect(name("web")).toBe("Web");
  });
});

// ---- Token arithmetic over styles.css, both themes ------------------------------------------------------------------

const STYLES = css("../src/styles.css");

/** The declarations of the first rule whose selector text starts with `head`, braces balanced. */
function block(source: string, head: string): string {
  const at = source.indexOf(head);
  if (at < 0) throw new Error(`no block ${head}`);
  let depth = 0;
  const open = source.indexOf("{", at);
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unclosed ${head}`);
}
const declarations = (body: string): Map<string, string> =>
  new Map(
    [...body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
  );

const DARK = declarations(block(STYLES, ':root,\n:root[data-theme="dark"]'));
const LIGHT = new Map([...DARK, ...declarations(block(STYLES, ':root[data-theme="light"]'))]);
const LIGHT_MEDIA = new Map([
  ...DARK,
  ...declarations(block(block(STYLES, "@media (prefers-color-scheme: light)"), ":root:not([data-theme])")),
]);
const THEMES = { dark: DARK, light: LIGHT, "light (media)": LIGHT_MEDIA } as const;

type Rgba = [number, number, number, number];
function resolve(tokens: Map<string, string>, value: string): Rgba {
  const v = value.trim();
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) return resolve(tokens, tokens.get(ref[1]!) ?? `missing ${ref[1]}`);
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*transparent\)$/.exec(v);
  if (mix) {
    const c = resolve(tokens, mix[1]!);
    return [c[0], c[1], c[2], (c[3] * Number(mix[2])) / 100];
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)).concat(1) as Rgba;
  const rgb = /^rgb\((\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*(\d+)%)?\)$/.exec(v);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4]) / 100];
  throw new Error(`cannot resolve ${v}`);
}
const over = (fg: Rgba, bg: Rgba): Rgba =>
  [0, 1, 2].map((i) => fg[i]! * fg[3] + bg[i]! * (1 - fg[3])).concat(1) as Rgba;
const lum = (c: Rgba): number =>
  c
    .slice(0, 3)
    .map((v) => v / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i]!, 0);
const ratio = (a: Rgba, b: Rgba): number => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};
const token = (tokens: Map<string, string>, name: string): Rgba => resolve(tokens, `var(${name})`);

describe("#5 off-path words keep 4.5:1; only shapes step back (C-07/Cl-05a)", () => {
  it("a dimmed box and line are marked by class, and a dimmed caption carries no opacity below 1", () => {
    const layout: LayoutResult = {
      nodes: [
        {
          id: "web",
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          label: "Web",
          shape: undefined,
          classes: [],
          groupId: undefined,
        },
        {
          id: "api",
          x: 0,
          y: 100,
          width: 100,
          height: 40,
          label: "API",
          shape: undefined,
          classes: [],
          groupId: undefined,
        },
      ],
      edges: [{ id: "calls", source: "web", target: "api", label: "calls", points: [], labelAnchor: undefined }],
      groups: [],
      width: 100,
      height: 200,
    } as LayoutResult;
    const focus = { nodeIds: ["web"] };
    const api = toXFlowNodes(layout, focus).find((n) => n.id === "api")!;
    const web = toXFlowNodes(layout, focus).find((n) => n.id === "web")!;
    expect(api.className).toContain("archer-dimmed");
    expect(web.className).not.toContain("archer-dimmed");
    const calls = toXFlowEdges(layout, focus).find((e) => e.id === "calls")!;
    expect(calls.className).toContain("archer-dimmed");
    const label = calls.labelStyle as { opacity?: number; color?: string };
    expect(label.opacity ?? 1).toBe(1);
    expect(label.color).toBe("var(--text-faded)");
  });

  it("the stylesheet undoes the box's opacity for every focus state, not only a walkthrough's", () => {
    const rule = block(STYLES, ".react-flow__node.archer-dimmed {");
    expect(rule).toMatch(/opacity:\s*1\s*!important/);
    expect(rule).toMatch(/--node-text:\s*var\(--text-faded\)/);
    // The sequence canvas dims a whole <g> by its `opacity` attribute; its words are lifted back out too.
    expect(STYLES).toMatch(/\.archer-seq-svg g\[opacity="0\.25"\]\s*\{\s*opacity:\s*1;/);
  });

  for (const [name, tokens] of Object.entries(THEMES)) {
    it(`faded words reach 4.5:1 on a faded box, a faded caption plate and inside a group: ${name}`, () => {
      const bg = token(tokens, "--bg");
      const words = token(tokens, "--text-faded");
      expect(words[3], "a solid colour, not a see-through one").toBe(1);
      const box = over(token(tokens, "--node-bg-faded"), bg);
      const inGroup = over(token(tokens, "--node-bg-faded"), over(token(tokens, "--group-bg"), bg));
      const plate = over(token(tokens, "--plate-faded"), bg);
      for (const under of [box, inGroup, plate, bg])
        expect(ratio(over(words, under), under)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("#17 a group's border and a flow's line clear 3:1 (Cl-05b, measured 1.84:1 and 1.92:1 in light)", () => {
  it("the flow line's opacity is the theme's token", () => {
    expect(block(STYLES, ".archer-edge.archer-emph.archer-emph-style-flow .react-flow__edge-path {")).toMatch(
      /stroke-opacity:\s*var\(--flow-line-opacity\)/,
    );
  });
  for (const [name, tokens] of Object.entries(THEMES)) {
    it(`containment border against the canvas and the group's own fill: ${name}`, () => {
      const bg = token(tokens, "--bg");
      const border = token(tokens, "--group-border");
      expect(ratio(border, bg)).toBeGreaterThanOrEqual(3);
      expect(ratio(border, over(token(tokens, "--group-bg"), bg))).toBeGreaterThanOrEqual(3);
    });
    it(`a flow-emphasised line at its stepped-back opacity, every hue: ${name}`, () => {
      const bg = token(tokens, "--bg");
      for (const hue of ["--g1", "--g2", "--g3", "--g4"]) {
        const c = token(tokens, hue);
        expect(
          ratio(over([c[0], c[1], c[2], Number(tokens.get("--flow-line-opacity"))], bg), bg),
          hue,
        ).toBeGreaterThanOrEqual(3);
      }
    });
  }
});

describe("#19 chrome does not animate under the OS reduced-motion setting (C-13)", () => {
  it("one rule switches off every CSS transition under reduce", () => {
    const media = block(STYLES, "@media (prefers-reduced-motion: reduce) {\n  /* Round 1 #19");
    expect(media).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{\s*transition:\s*none\s*!important;/);
  });
});

describe("#20 chrome type sizes come from the type scale (C-14/Cl-15)", () => {
  for (const file of ["ArcherSettings.css", "ArcherSettingsDialog.css", "ProjectSettings.css"])
    it(`${file} states no font size of its own`, () => {
      const sizes = [...css(`../src/app/${file}`).matchAll(/font-size:\s*([^;}]+)/g)].map((m) => m[1]!.trim());
      expect(sizes.filter((size) => !/^(var\(--type-[a-z]+\)|inherit)$/.test(size))).toEqual([]);
    });
  it("form controls take the page's type, not the browser's 13.33px", () => {
    expect(STYLES).toMatch(/:where\(button, input, select, textarea\)\s*\{\s*font:\s*inherit;/);
  });
});

describe("#22 the Protected lock is drawn on the icon scale (C-15)", () => {
  it("its size and stroke are the icon tokens", () => {
    const settings = css("../src/app/ProjectSettings.css");
    const rule = block(settings, ".archer-project-settings-lock{");
    expect(rule).toMatch(/width:var\(--icon-indicator\)/);
    expect(rule).toMatch(/height:var\(--icon-indicator\)/);
    expect(rule).toMatch(/stroke-width:var\(--icon-stroke\)/);
    expect(settings).not.toMatch(/stroke-width:1\.3/);
  });
});

describe("#23 a project-settings section's rule sits under its heading (C-17)", () => {
  it("the heading carries the rule; no section draws one above its heading", () => {
    const settings = css("../src/app/ProjectSettings.css");
    expect(settings).not.toMatch(
      /\.archer-project-settings-section\+\.archer-project-settings-section\{[^}]*border-top/,
    );
    expect(block(settings, ".archer-project-settings-section-title{")).toMatch(
      /border-bottom:var\(--line-chrome\) solid var\(--border\)/,
    );
  });
});
