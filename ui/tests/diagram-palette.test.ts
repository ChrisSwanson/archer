// The diagram palette (DESIGN.md, "Diagram palette"), measured from the stylesheet's own tokens.
//
// Every number DESIGN.md quotes for the four families and neutral is recomputed here from the literal
// values in `src/styles.css`, in both explicit theme blocks, so a later palette change that breaks a
// floor fails here rather than on someone's screen. Colours meet in more places than the canvas: a
// nested panel's border lies on its parent's panel, a connection crosses every panel and box, the
// selection blue and the agent's emphasis hues are drawn on a family's fill. All of those are measured.
//
// The second half holds `palette.ts`, the one function that decides a family, to the owner's rules:
// kinds, C4 and architecture identities, and an authored category's colour -- never its source order,
// never a reserved hue.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  categoryFamily,
  FAMILIES,
  familyOfColour,
  groupPanelsOf,
  indexCategories,
  nodePalette,
  toOklch,
  ownGroupPalette,
  RESERVED_HUES,
  usesFamilyColours,
} from "../src/diagrams/palette";
import { contrastRatio, deltaE, parseColour, type Rgb } from "./contrast";

const CSS = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");

/** The custom properties declared by the one rule whose selector is exactly `selector`. */
function block(selector: string): Map<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = CSS.slice(CSS.indexOf("{", start) + 1, CSS.indexOf("}", start)).replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = new Map<string, string>();
  for (const declaration of body.split(";")) {
    const match = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/s.exec(declaration);
    if (match !== null) tokens.set(match[1]!, match[2]!);
  }
  return tokens;
}

const THEMES = {
  light: block(':root[data-theme="light"]'),
  // The dark tokens are the default `:root` block, which also answers to `[data-theme="dark"]`.
  dark: block(':root,\n:root[data-theme="dark"]'),
} as const;

function colour(theme: keyof typeof THEMES, token: string): Rgb {
  let value = THEMES[theme].get(token);
  for (let hops = 0; value?.startsWith("var(") === true && hops < 4; hops++)
    value = THEMES[theme].get(/^var\((--[\w-]+)\)$/.exec(value)![1]!);
  expect(value, `${theme} ${token}`).toBeDefined();
  const parsed = parseColour(value!);
  // The palette's colours are opaque (DESIGN.md: never build depth from transparency).
  expect(parsed.alpha, `${theme} ${token} is opaque`).toBe(1);
  return parsed.rgb;
}

/** Fill, border, caption ink, words on the fill, panel and card of every family, as tokens. */
const FAMILY_SWATCHES = FAMILIES.map((family) => ({
  name: family,
  fill: `--family-${family}-fill`,
  border: `--family-${family}-border`,
  ink: `--family-${family}-ink`,
  text: `--family-${family}-text`,
  panel: `--family-${family}-panel`,
  card: `--family-${family}-card`,
}));
/** The light families: a tint under dark words. Red is the solid one, white words on a dark fill. */
const TINTED = FAMILY_SWATCHES.filter((swatch) => swatch.name !== "red");
const NEUTRAL_PANELS = ["--group-bg", "--group-bg-alt"];
/** Everything a node, a nested panel or a connection can be drawn on: the canvas and every panel. */
const GROUNDS = ["--bg", ...NEUTRAL_PANELS, ...FAMILY_SWATCHES.map((s) => s.panel)];
/** Every box a word sits in. */
const BOXES = ["--node-bg", ...FAMILY_SWATCHES.flatMap((s) => [s.fill, s.card])];

const lowest = (theme: keyof typeof THEMES, front: readonly string[], back: readonly string[]): number =>
  Math.min(...front.flatMap((f) => back.map((b) => contrastRatio(colour(theme, f), colour(theme, b)))));

describe.each(["light", "dark"] as const)("the diagram palette, %s", (theme) => {
  // The floors DESIGN.md quotes, light / dark.
  const floor = (light: number, dark: number): number => (theme === "light" ? light : dark);

  it("node words read in full ink on every fill, card and panel (4.5:1 or more; owner, 2026-11-12)", () => {
    // Neutral: the node text on the slate fill and on both neutral panels.
    expect(lowest(theme, ["--node-text"], ["--node-bg", ...NEUTRAL_PANELS])).toBeGreaterThanOrEqual(floor(16, 14));
    // A family's title and description are its words on its fill (white on the solid red) ...
    for (const swatch of FAMILY_SWATCHES)
      expect(contrastRatio(colour(theme, swatch.text), colour(theme, swatch.fill)), swatch.name).toBeGreaterThanOrEqual(
        floor(8, 8),
      );
    expect(colour(theme, "--family-red-text")).toEqual([255, 255, 255]);
    // ... and a card's in a family panel are its ink on the light card, which also captions the panel.
    for (const swatch of FAMILY_SWATCHES)
      for (const ground of [swatch.card, swatch.panel])
        expect(
          contrastRatio(colour(theme, swatch.ink), colour(theme, ground)),
          `${swatch.name} on ${ground}`,
        ).toBeGreaterThanOrEqual(8);
  });

  it("each caption reads on its panel: the neutral one on both neutral panels", () => {
    expect(lowest(theme, ["--group-caption"], NEUTRAL_PANELS)).toBeGreaterThanOrEqual(9.8);
  });

  it("every node and group border holds 3:1 on the canvas and on any panel it can sit in", () => {
    const borders = [
      "--node-border",
      "--group-border",
      "--group-border-alt",
      ...FAMILY_SWATCHES.filter((s) => theme === "dark" || s.name !== "red").map((s) => s.border),
    ];
    expect(lowest(theme, borders, ["--bg"])).toBeGreaterThanOrEqual(floor(4.7, 4.5));
    expect(lowest(theme, borders, GROUNDS)).toBeGreaterThanOrEqual(floor(4.3, 4.3));
    // The outermost panel's outline is the dark one; a nested panel's is quieter.
    expect(contrastRatio(colour(theme, "--group-border"), colour(theme, "--bg"))).toBeGreaterThan(
      contrastRatio(colour(theme, "--group-border-alt"), colour(theme, "--bg")),
    );
    // In light the solid red's own fill is the shape (its border only deepens it): 9:1 or more on any ground.
    if (theme === "light") expect(lowest(theme, ["--family-red-fill"], GROUNDS)).toBeGreaterThanOrEqual(9);
  });

  it("connections are a crisp line on the canvas and across every box and panel", () => {
    expect(lowest(theme, ["--edge"], ["--bg"])).toBeGreaterThanOrEqual(floor(10, 9.6));
    expect(
      lowest(theme, ["--edge"], [...GROUNDS, "--node-bg", ...TINTED.flatMap((s) => [s.fill, s.card])]),
    ).toBeGreaterThanOrEqual(8);
    // The arrowhead is filled in the line's own colour.
    expect(colour(theme, "--edge-arrow")).toEqual(colour(theme, "--edge"));
  });

  it("selection and the agent's emphasis still stand out on every family fill", () => {
    // A selected node's body is the selection fill, so its border is read there; a selected frame's border on
    // its panel; and a tinted box's on its tint.
    const tinted = ["--node-bg", ...TINTED.flatMap((s) => [s.fill, s.card])];
    expect(lowest(theme, ["--accent"], ["--accent-fill", ...tinted, ...GROUNDS])).toBeGreaterThanOrEqual(6.8);
    // DESIGN.md rounds this one to 4.27; it measures 4.267 (light, teal emphasis on the violet fill).
    expect(lowest(theme, ["--g1", "--g2", "--g3", "--g4"], tinted)).toBeGreaterThanOrEqual(4.26);
    // The solid red is too dark for a dark hue to show on it, so an emphasised red node is read where its 3px
    // border meets the ground (and by its group number): every hue holds 4.3:1 or more on any ground there.
    expect(lowest(theme, ["--g1", "--g2", "--g3", "--g4"], GROUNDS)).toBeGreaterThanOrEqual(floor(4.3, 4.3));
  });

  it("the keyboard ring shows on every fill: white on the solid red", () => {
    expect(lowest(theme, ["--kbd-focus"], ["--node-bg", ...TINTED.map((s) => s.fill)])).toBeGreaterThanOrEqual(8);
    expect(
      contrastRatio(colour(theme, "--family-red-text"), colour(theme, "--family-red-fill")),
    ).toBeGreaterThanOrEqual(8);
  });

  // Faded words sit on a FADED box (its fill at a quarter over the ground) or on a ground. They are the quietest grey
  // that still keeps 4.5:1 there (owner, 2026-11-12: the earlier `--text-dim`, at 6.4:1, faded far too slightly).
  // The solid red fill is excepted, as it is for every grey word.
  it("faded words keep 4.5:1 on every faded box, panel and the canvas, and are quieter than --text-dim", () => {
    const over = (box: Rgb, ground: Rgb): Rgb => [
      box[0] * 0.25 + ground[0] * 0.75,
      box[1] * 0.25 + ground[1] * 0.75,
      box[2] * 0.25 + ground[2] * 0.75,
    ];
    const words = colour(theme, "--text-faded");
    let worst = Infinity;
    for (const g of GROUNDS) {
      const ground = colour(theme, g);
      worst = Math.min(worst, contrastRatio(words, ground));
      for (const b of BOXES.filter((x) => x !== "--family-red-fill"))
        worst = Math.min(worst, contrastRatio(words, over(colour(theme, b), ground)));
    }
    expect(worst).toBeGreaterThanOrEqual(4.5);
    const onCanvas = (token: string) => contrastRatio(colour(theme, token), colour(theme, "--bg"));
    expect(onCanvas("--text-faded")).toBeLessThan(onCanvas("--text-dim"));
  });

  it("the quiet neutral recedes but still reads: its words 4.5:1, its border 3:1, both under the plain neutral's", () => {
    expect(contrastRatio(colour(theme, "--node-quiet-text"), colour(theme, "--node-quiet-bg"))).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(lowest(theme, ["--node-quiet-border"], GROUNDS)).toBeGreaterThanOrEqual(3);
    const onCanvas = (token: string) => contrastRatio(colour(theme, token), colour(theme, "--bg"));
    expect(onCanvas("--node-quiet-border")).toBeLessThan(onCanvas("--node-border"));
    expect(contrastRatio(colour(theme, "--node-quiet-text"), colour(theme, "--node-quiet-bg"))).toBeLessThan(
      contrastRatio(colour(theme, "--node-text"), colour(theme, "--node-bg")),
    );
    // A step you can see from the plain neutral's fill (CIEDE2000 3 or more), still a grey.
    expect(deltaE(colour(theme, "--node-quiet-bg"), colour(theme, "--node-bg"))).toBeGreaterThanOrEqual(3);
  });

  it("no family border borrows the reader's blue or the agent's amber", () => {
    for (const family of FAMILIES) {
      const [r, g, b] = colour(theme, `--family-${family}-border`);
      const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      const { h } = toOklch(hex)!;
      for (const band of RESERVED_HUES) expect(h >= band.from && h < band.to, `${family} in ${band.name}`).toBe(false);
      // And each family border chooses its own family, so an authored colour near it lands there too.
      expect(familyOfColour(hex), family).toBe(family);
    }
  });
});

describe("which family a thing is drawn in", () => {
  const none = indexCategories(undefined);

  it("four kinds have a family; component, external and no kind are neutral", () => {
    expect(nodePalette({ classes: ["person"] }, none)).toEqual({ family: "violet" });
    expect(nodePalette({ classes: ["system"] }, none)).toEqual({ family: "teal" });
    expect(nodePalette({ classes: ["container"] }, none)).toEqual({ family: "green" });
    expect(nodePalette({ classes: ["database"] }, none)).toEqual({ family: "plum" });
    for (const classes of [["component"], ["external"], []]) expect(nodePalette({ classes }, none)).toEqual({});
  });

  it("C4: Person, System, Container in theirs, a database variant plum, Component and every _Ext neutral", () => {
    const c4 = (kind: "person" | "system" | "container" | "component", more = {}) =>
      nodePalette({ figure: { type: "c4", kind, external: false, ...more } }, none);
    expect(c4("person")).toEqual({ family: "violet" });
    expect(c4("system")).toEqual({ family: "teal" });
    expect(c4("container")).toEqual({ family: "green" });
    expect(c4("container", { shape: "database" })).toEqual({ family: "plum" });
    expect(c4("container", { shape: "queue" })).toEqual({ family: "green" });
    expect(c4("component")).toEqual({});
    expect(c4("system", { external: true })).toEqual({});
    expect(c4("person", { external: true })).toEqual({});
    expect(ownGroupPalette({ figure: { type: "boundary", kind: "system" } }, none)).toEqual({ family: "teal" });
    expect(ownGroupPalette({ figure: { type: "boundary", kind: "container" } }, none)).toEqual({ family: "green" });
    // Enterprise and generic boundaries have no notation colour: they colour themselves, as a subgraph does.
    expect(ownGroupPalette({ figure: { type: "boundary", kind: "enterprise" } }, none)).toBeUndefined();
    expect(ownGroupPalette({ figure: { type: "boundary", kind: "generic" } }, none)).toBeUndefined();
  });

  it("architecture: server teal, database and disk plum; cloud, internet and no icon neutral", () => {
    const service = (icon?: "cloud" | "database" | "disk" | "internet" | "server") =>
      nodePalette({ figure: icon === undefined ? { type: "service" } : { type: "service", icon } }, none);
    expect(service("server")).toEqual({ family: "teal" });
    expect(service("database")).toEqual({ family: "plum" });
    expect(service("disk")).toEqual({ family: "plum" });
    // No colour of their own: neutral on their own, a card in a coloured group's border inside one.
    expect(service("cloud")).toEqual({});
    expect(service("internet")).toEqual({});
    expect(service()).toEqual({});
    const panels = groupPanelsOf([{ id: "zone", parentId: undefined, figure: { type: "zone", icon: "server" } }], none);
    expect(nodePalette({ figure: { type: "service", icon: "cloud" }, groupId: "zone" }, none, panels)).toEqual({
      family: "teal",
      card: true,
    });
    expect(ownGroupPalette({ figure: { type: "zone", icon: "server" } }, none)).toEqual({ family: "teal" });
    expect(ownGroupPalette({ figure: { type: "zone", icon: "cloud" } }, none)).toBeUndefined();
  });

  it("a category takes the family of its fill, else its stroke; grey and amber are neutral", () => {
    // The owner's home rig: a pale green fill with a teal stroke is teal; the sandbox's warm fill and
    // orange-red stroke are rust (owner, 2026-11-12: an isolated sandbox is not an error). A pale tint has no
    // usable hue, so the stroke decides.
    expect(categoryFamily({ fill: "#ecfdf5", stroke: "#0f766e" })).toBe("teal");
    expect(categoryFamily({ fill: "#fdf1e7", stroke: "#c2410c" })).toBe("rust");
    expect(categoryFamily({ fill: "#a855f7" })).toBe("violet");
    expect(categoryFamily({ fill: "#ec4899" })).toBe("plum");
    expect(categoryFamily({ fill: "#84cc16" })).toBe("green");
    expect(categoryFamily({ fill: "#06b6d4" })).toBe("teal");
    // Orange is rust; red is the strong dark red ("changes the real server" in the owner's loop).
    for (const orange of ["#f97316", "#ea580c", "#ff9966", "#9a3412"])
      expect(categoryFamily({ fill: orange }), orange).toBe("rust");
    for (const red of ["#7f1d1d", "#ff0000", "#dc2626", "#b91c1c", "#e11d48"])
      expect(categoryFamily({ fill: red }), red).toBe("red");
    expect(categoryFamily({ fill: "#7f1d1d", stroke: "#450a0a" })).toBe("red");
    // The agent's amber stays reserved: neutral, not the next family over.
    for (const amber of ["#f2b544", "#fef9c3", "#f59e0b", "#eab308"])
      expect(categoryFamily({ fill: amber, stroke: "#0f766e" }), amber).toBeUndefined();
    // A pale blue tint has no usable hue at all: alone it is neutral, and a stroke beside it decides.
    expect(categoryFamily({ fill: "#dbeafe" })).toBeUndefined();
    expect(categoryFamily({ fill: "#dbeafe", stroke: "#0f766e" })).toBe("teal");
    // A grey has no hue to choose with; a grey fill lets the stroke speak.
    expect(categoryFamily({ fill: "#333333" })).toBeUndefined();
    expect(categoryFamily({ fill: "#f4f4f4", stroke: "#985d7f" })).toBe("plum");
    // A cool slate is a grey, though it leans blue (the owner's "AI's work" boxes).
    for (const slate of ["#64748b", "#475569", "#334155", "#0f172a", "#94a3b8"])
      expect(categoryFamily({ fill: "#f1f5f9", stroke: slate }), slate).toBeUndefined();
    expect(categoryFamily({})).toBeUndefined();
  });

  it("blue is never a family: an authored blue takes the nearest other family, violet for an ink blue", () => {
    // Blue is the reader's: selection, highlights and expand buttons (owner, 2026-11-12).
    expect(FAMILIES as readonly string[]).not.toContain("blue");
    // The owner's loop: "you decide" is a pale blue with a royal-blue stroke.
    expect(categoryFamily({ fill: "#dbeafe", stroke: "#1d4ed8" })).toBe("violet");
    for (const blue of ["#2645a3", "#1d4ed8", "#3b82f6", "#6366f1"])
      expect(categoryFamily({ fill: blue }), blue).toBe("violet");
    // A sky blue sits nearer teal.
    expect(categoryFamily({ fill: "#0ea5e9" })).toBe("teal");
  });

  it("a category's colour never depends on where it is written or what else is there", () => {
    const gpu = { name: "gpu", fill: "#ecfdf5", stroke: "#0f766e" };
    const sandbox = { name: "sandbox", fill: "#fdf1e7", stroke: "#c2410c", dashed: true };
    const extra = { name: "inserted", fill: "#a855f7" };
    for (const order of [
      [gpu, sandbox],
      [sandbox, gpu],
      [extra, sandbox, gpu],
    ]) {
      const index = indexCategories(order);
      expect(nodePalette({ classes: ["gpu"] }, index)).toEqual({ family: "teal", category: "gpu" });
      expect(nodePalette({ classes: ["sandbox"] }, index)).toEqual({
        family: "rust",
        dashed: true,
        category: "sandbox",
      });
    }
  });

  it("an unclassified group is neutral: the outermost a clear panel, a nested one pale; nothing inherits through it", () => {
    // Owner, 2026-11-12: colouring groups by a hash of their id invented meaning (the whole server turned green).
    const categories = indexCategories([{ name: "gpu", fill: "#ecfdf5", stroke: "#0f766e" }]);
    const groups = [
      { id: "server", parentId: undefined },
      { id: "farm", parentId: "server" },
      { id: "gpu1", parentId: "server", classes: ["gpu"] },
      { id: "inGpu", parentId: "gpu1" },
      { id: "state", parentId: undefined, figure: { type: "composite" as const } },
      { id: "inState", parentId: "state" },
      { id: "deeper", parentId: "inState" },
    ];
    const panels = groupPanelsOf(groups, categories);
    expect(panels.get("server")).toEqual({ palette: {}, nested: false });
    expect(panels.get("farm")).toEqual({ palette: {}, nested: true });
    expect(panels.get("gpu1")).toEqual({ palette: { family: "teal", category: "gpu" }, nested: false });
    // A family does not flow through structure: a plain group inside the GPU panel is a neutral nested panel.
    expect(panels.get("inGpu")).toEqual({ palette: {}, nested: true });
    expect(panels.get("state")).toEqual({ palette: {}, nested: false });
    expect(panels.get("inState")).toEqual({ palette: {}, nested: true });
    expect(panels.get("deeper")).toEqual({ palette: {}, nested: true });
    // Adding a group, or listing them in another order, recolours nothing else.
    const more = groupPanelsOf([{ id: "added", parentId: undefined }, ...[...groups].reverse()], categories);
    for (const group of groups) expect(more.get(group.id), group.id).toEqual(panels.get(group.id));
    // A node with nothing of its own is neutral in a neutral group, and a card in a family panel's colours.
    expect(nodePalette({ classes: [], groupId: "farm" }, categories, panels)).toEqual({});
    expect(nodePalette({ classes: [], groupId: "server" }, categories, panels)).toEqual({});
    expect(nodePalette({ classes: [], groupId: "gpu1" }, categories, panels)).toEqual({
      family: "teal",
      card: true,
    });
    expect(nodePalette({ classes: [], groupId: "inGpu" }, categories, panels)).toEqual({});
    expect(nodePalette({ classes: ["database"], groupId: "gpu1" }, categories, panels)).toEqual({ family: "plum" });
    expect(nodePalette({ classes: ["external"], groupId: "gpu1" }, categories, panels)).toEqual({});
    // A closed container stands for its group: in the group's own colour, else neutral.
    expect(nodePalette({ classes: [], folded: { groupId: "server" } }, categories, panels)).toEqual({});
    expect(nodePalette({ classes: [], folded: { groupId: "gpu1" } }, categories, panels)).toEqual({
      family: "teal",
      category: "gpu",
    });
    expect(nodePalette({ classes: [], groupId: "server", folded: { groupId: "farm" } }, categories, panels)).toEqual(
      {},
    );
  });

  it("a node in its own family's panel is that panel's light card, like the reference's GPU cards", () => {
    const categories = indexCategories([{ name: "gpu", fill: "#ecfdf5", stroke: "#0f766e" }]);
    const panels = groupPanelsOf([{ id: "gpu1", parentId: undefined, classes: ["gpu"] }], categories);
    expect(nodePalette({ classes: ["gpu"], groupId: "gpu1" }, categories, panels)).toEqual({
      family: "teal",
      category: "gpu",
      card: true,
    });
    // Its own colour, outside the panel or in another family's, is filled.
    expect(nodePalette({ classes: ["gpu"] }, categories, panels)).toEqual({ family: "teal", category: "gpu" });
    expect(nodePalette({ classes: ["person"], groupId: "gpu1" }, categories, panels)).toEqual({ family: "violet" });
  });

  it("a grey category with a light grey outline is the quiet neutral; a slate one is the plain neutral", () => {
    // The owner's loop: "the AI's work" (slate outline) and "Dropped" (light grey outline, receding).
    expect(
      nodePalette({ classes: ["ai"] }, indexCategories([{ name: "ai", fill: "#f1f5f9", stroke: "#64748b" }])),
    ).toEqual({ category: "ai" });
    expect(
      nodePalette({ classes: ["gone"] }, indexCategories([{ name: "gone", fill: "#e5e7eb", stroke: "#9ca3af" }])),
    ).toEqual({ category: "gone", quiet: true });
    // The outline decides, never the fill alone or the order; a coloured or amber category is never quiet.
    const quiet = (category: { fill?: string; stroke?: string }) =>
      nodePalette({ classes: ["c"] }, indexCategories([{ name: "c", ...category }])).quiet === true;
    expect(quiet({ fill: "#e5e7eb" })).toBe(false);
    expect(quiet({ stroke: "#cbd5e1" })).toBe(true);
    expect(quiet({ fill: "#ffffff", stroke: "#475569" })).toBe(false);
    expect(quiet({ fill: "#fef9c3", stroke: "#fde68a" })).toBe(false);
    expect(quiet({ fill: "#ecfdf5", stroke: "#99f6e4" })).toBe(false);
  });

  it("a drawing with no kinds, categories or notation colours is in no family colours at all", () => {
    expect(
      usesFamilyColours({
        groups: [
          { id: "server", parentId: undefined },
          { id: "farm", parentId: "server" },
        ],
        nodes: [{ classes: [], groupId: "farm" }],
      }),
    ).toBe(false);
  });
});
