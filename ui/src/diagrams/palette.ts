/**
 * Which colour family a node or group of a graph is drawn in (DESIGN.md, "Diagram palette").
 *
 * Six chromatic families and neutral. A family names what a thing IS -- its kind, its C4 element or
 * boundary, its architecture icon, or the authored `classDef` category it wears -- and never a state:
 * selection, the keyboard and the agent's emphasis draw over it. The colours are tokens in every theme
 * block of `styles.css` (`--family-<name>-*`), so the canvas and the export painter resolve the same
 * values; nothing here holds a colour that is drawn.
 *
 * One function decides for both drawings, from what the layout already carries (a node's classes and
 * figure, a group's classes and figure, the view's categories), so a canvas, an export and a miniature
 * of one diagram cannot disagree.
 */
import type { GroupFigure, NodeFigure } from "./figures";

/**
 * No blue: blue is the reader's (selection, highlights, expand buttons). `rust` is an authored orange (a
 * walled-off sandbox); `red` is the strong dark red an author gives what is consequential ("changes the real
 * server"), drawn solid with white words.
 */
export const FAMILIES = ["violet", "teal", "green", "plum", "rust", "red"] as const;
export type Family = (typeof FAMILIES)[number];

/** An authored `classDef` category, as the envelope carries it (ADR 0009, amended 2026-11-11). */
export type Category = {
  readonly name: string;
  readonly fill?: string;
  readonly stroke?: string;
  readonly dashed?: boolean;
  /** What it means, in the author's words (`%% archer-key <name>: <meaning>`): what the Key calls it. */
  readonly meaning?: string;
};

/** What a node or group is drawn in. No family is neutral; `category` names the authored one it wears. */
export type Palette = {
  readonly family?: Family;
  readonly dashed?: true;
  readonly category?: string;
  /** It sits directly in a panel of its family: a light card in that family's border and ink. */
  readonly card?: true;
  /** A grey category with a light grey outline: the quiet neutral, a step lighter and receding (`categoryQuiet`). */
  readonly quiet?: true;
};

const NEUTRAL: Palette = {};

/** The flowchart kinds that have a family; `component` and `external` are neutral, with their word. */
const KIND_FAMILY: Readonly<Record<string, Family>> = {
  person: "violet",
  system: "teal",
  container: "green",
  database: "plum",
};

/** Each family's hue in OKLCH, from its border swatch: what an authored colour is compared against. */
const FAMILY_HUE: Readonly<Record<Family, number>> = {
  violet: 300,
  teal: 190,
  green: 150,
  plum: 345,
  rust: 42,
  red: 26,
};

/**
 * Below this OKLCH chroma a colour is not a usable hue: a grey, or a tint so pale its hue is a guess (the
 * owner's `gpu` fill `#ecfdf5` measures 0.021 and leans green; its stroke `#0f766e`, 0.086, says teal). A
 * pale fill therefore lets the stroke speak. Cool slates are greys too, though they lean blue: `#64748b`
 * measures 0.041 and `#0f172a` 0.040, so the floor sits above them. Every family border measures 0.09 or more.
 */
const MIN_CHROMA = 0.05;

/**
 * Hues no family is drawn in (OKLCH degrees, half-open): they mean something else on this page. The agent's
 * amber, which an authored colour may not borrow (it is neutral), and the reader's blue (its ink and its light
 * tint sit near 266-271), which an authored colour may use but is drawn in the nearest other family.
 */
export const RESERVED_HUES: readonly {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly authored: "neutral" | "nearest";
}[] = [
  { name: "amber", from: 55, to: 110, authored: "neutral" },
  { name: "blue", from: 235, to: 290, authored: "nearest" },
];

/** A `#rrggbb` colour's OKLCH lightness, chroma and hue (degrees), or undefined for anything else. */
export function toOklch(hex: string): { l: number; c: number; h: number } | undefined {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (match === null) return undefined;
  const channel = (offset: number): number => {
    const v = Number.parseInt(match[1]!.slice(offset, offset + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [channel(0), channel(2), channel(4)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const hue = (Math.atan2(bb, a) * 180) / Math.PI;
  return { l: lightness, c: Math.hypot(a, bb), h: (hue + 360) % 360 };
}

const hueDistance = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/**
 * The family an authored colour chooses: the one whose hue is nearest in OKLCH, so an authored blue is drawn
 * in violet (no family is blue). A grey (`MIN_CHROMA`), an unreadable value or the agent's amber chooses
 * neutral (undefined).
 */
export function familyOfColour(hex: string | undefined): Family | "grey" | undefined {
  if (hex === undefined) return "grey";
  const colour = toOklch(hex);
  if (colour === undefined || colour.c < MIN_CHROMA) return "grey";
  if (RESERVED_HUES.some((band) => band.authored === "neutral" && colour.h >= band.from && colour.h < band.to))
    return undefined;
  let best: Family = FAMILIES[0];
  for (const family of FAMILIES)
    if (hueDistance(colour.h, FAMILY_HUE[family]) < hueDistance(colour.h, FAMILY_HUE[best])) best = family;
  return best;
}

/**
 * A category's family: its fill's if the fill has a hue, else its stroke's. An amber fill is neutral
 * outright; a grey or absent fill lets the stroke speak. Source order never enters into it, so adding a
 * category recolours nothing else.
 */
export function categoryFamily(category: Pick<Category, "fill" | "stroke">): Family | undefined {
  const fill = familyOfColour(category.fill);
  if (fill !== "grey") return fill;
  const stroke = familyOfColour(category.stroke);
  return stroke === "grey" ? undefined : stroke;
}

/**
 * Whether a category with no family is the quiet neutral: its outline (`stroke`) is a light grey, OKLCH lightness
 * 0.65 or more, and its fill is grey or absent. The owner's loop tells "the AI's work" (a slate outline, `#64748b`,
 * L 0.55) from "Dropped" (a light grey one, `#9ca3af`, L 0.71) this way; their fills barely differ. The outline
 * alone decides, so a fill-only grey stays the plain neutral.
 */
function categoryQuiet(category: Pick<Category, "fill" | "stroke">): boolean {
  if (categoryFamily(category) !== undefined || familyOfColour(category.fill) !== "grey") return false;
  const stroke = category.stroke === undefined ? undefined : toOklch(category.stroke);
  return stroke !== undefined && stroke.c < MIN_CHROMA && stroke.l >= QUIET_LIGHTNESS;
}

/** The OKLCH lightness from which a grey outline is light (`categoryQuiet`). */
const QUIET_LIGHTNESS = 0.65;

export type CategoryIndex = ReadonlyMap<string, Category>;

const NO_CATEGORIES: CategoryIndex = new Map();

export function indexCategories(categories: readonly Category[] | undefined): CategoryIndex {
  return categories === undefined || categories.length === 0
    ? NO_CATEGORIES
    : new Map(categories.map((category) => [category.name, category]));
}

/** What a class draws: a kind's family (component and external neutral) or a category's; undefined for none. */
function ownOfClasses(classes: readonly string[] | undefined, categories: CategoryIndex): Palette | undefined {
  for (const name of classes ?? []) {
    if ((NEUTRAL_KINDS as readonly string[]).includes(name)) return NEUTRAL;
    const kind = KIND_FAMILY[name];
    if (kind !== undefined) return { family: kind };
    const category = categories.get(name);
    if (category !== undefined) {
      const family = categoryFamily(category);
      return {
        ...(family === undefined ? {} : { family }),
        ...(categoryQuiet(category) ? { quiet: true as const } : {}),
        ...(category.dashed === true ? { dashed: true as const } : {}),
        category: name,
      };
    }
  }
  return undefined;
}

/** The kinds that are neutral by what they are, and say so in their kind word. */
const NEUTRAL_KINDS = ["component", "external"] as const;

/**
 * What a node is drawn in by its own identity: its figure for the newer diagram types (a C4 element, a
 * service's icon, a state), else its kind or category. Undefined when it has none (`nodePalette`).
 */
export function ownNodePalette(
  node: { readonly classes?: readonly string[]; readonly figure?: NodeFigure },
  categories: CategoryIndex,
): Palette | undefined {
  const figure = node.figure;
  if (figure?.type === "c4") {
    if (figure.external) return NEUTRAL;
    if (figure.shape === "database") return { family: "plum" };
    return figure.kind === "component" ? NEUTRAL : { family: KIND_FAMILY[figure.kind]! };
  }
  if (figure?.type === "service") {
    if (figure.icon === "server") return { family: "teal" };
    if (figure.icon === "database" || figure.icon === "disk") return { family: "plum" };
    return ownOfClasses(node.classes, categories);
  }
  if (figure !== undefined) return NEUTRAL;
  return ownOfClasses(node.classes, categories);
}

/**
 * What a group is drawn in by its own identity: a C4 system or container boundary's notation, an
 * architecture group's icon, a subgraph's kind or category. A composite state is neutral. Undefined when
 * it has none, and is neutral (`groupPanelsOf`).
 */
export function ownGroupPalette(
  group: { readonly classes?: readonly string[]; readonly figure?: GroupFigure },
  categories: CategoryIndex,
): Palette | undefined {
  const figure = group.figure;
  if (figure?.type === "boundary")
    return figure.kind === "system"
      ? { family: "teal" }
      : figure.kind === "container"
        ? { family: "green" }
        : ownOfClasses(group.classes, categories);
  if (figure?.type === "zone") {
    if (figure.icon === "server") return { family: "teal" };
    if (figure.icon === "database" || figure.icon === "disk") return { family: "plum" };
    return ownOfClasses(group.classes, categories);
  }
  if (figure?.type === "composite") return NEUTRAL;
  return ownOfClasses(group.classes, categories);
}

/**
 * The theme tokens each family paints with, spelled out whole so the palette guard can see every token a
 * drawing names (`tests/palette-guard.test.ts`): the export painter resolves them per theme.
 */
export const FAMILY_TOKENS: Readonly<
  Record<
    Family,
    {
      readonly fill: string;
      readonly border: string;
      readonly ink: string;
      readonly text: string;
      readonly panel: string;
      readonly card: string;
    }
  >
> = {
  violet: {
    fill: "var(--family-violet-fill)",
    border: "var(--family-violet-border)",
    ink: "var(--family-violet-ink)",
    text: "var(--family-violet-text)",
    panel: "var(--family-violet-panel)",
    card: "var(--family-violet-card)",
  },
  teal: {
    fill: "var(--family-teal-fill)",
    border: "var(--family-teal-border)",
    ink: "var(--family-teal-ink)",
    text: "var(--family-teal-text)",
    panel: "var(--family-teal-panel)",
    card: "var(--family-teal-card)",
  },
  green: {
    fill: "var(--family-green-fill)",
    border: "var(--family-green-border)",
    ink: "var(--family-green-ink)",
    text: "var(--family-green-text)",
    panel: "var(--family-green-panel)",
    card: "var(--family-green-card)",
  },
  plum: {
    fill: "var(--family-plum-fill)",
    border: "var(--family-plum-border)",
    ink: "var(--family-plum-ink)",
    text: "var(--family-plum-text)",
    panel: "var(--family-plum-panel)",
    card: "var(--family-plum-card)",
  },
  rust: {
    fill: "var(--family-rust-fill)",
    border: "var(--family-rust-border)",
    ink: "var(--family-rust-ink)",
    text: "var(--family-rust-text)",
    panel: "var(--family-rust-panel)",
    card: "var(--family-rust-card)",
  },
  red: {
    fill: "var(--family-red-fill)",
    border: "var(--family-red-border)",
    ink: "var(--family-red-ink)",
    text: "var(--family-red-text)",
    panel: "var(--family-red-panel)",
    card: "var(--family-red-card)",
  },
};

/** The class a drawn element wears for its family (`archer-family-teal`), and for a dashed category. */
export const FAMILY_CLASS_PREFIX = "archer-family-";
export const DASHED_CATEGORY_CLASS = "archer-category-dashed";
/** A node drawn as a family panel's light card, with the family's border and ink. */
export const CARD_FAMILY_CLASS = "archer-family-card";
/** The quiet neutral (`categoryQuiet`). */
export const QUIET_NEUTRAL_CLASS = "archer-neutral-quiet";

export function paletteClasses(palette: Palette): string[] {
  return [
    ...(palette.family === undefined ? [] : [`${FAMILY_CLASS_PREFIX}${palette.family}`]),
    ...(palette.family !== undefined && palette.card === true ? [CARD_FAMILY_CLASS] : []),
    ...(palette.quiet === true ? [QUIET_NEUTRAL_CLASS] : []),
    ...(palette.dashed === true ? [DASHED_CATEGORY_CLASS] : []),
  ];
}

export type GroupPanels = ReadonlyMap<string, { readonly palette: Palette; readonly nested: boolean }>;

/**
 * Each group's panel (DESIGN.md, Diagram palette: Group panels). A group is coloured only by its own identity
 * (`ownGroupPalette`: a kind, a category, a C4 boundary's notation, an architecture icon); otherwise it is
 * neutral, and nothing flows through it (owner, 2026-11-12: colour invented for structure meant nothing). A
 * neutral panel is the outermost (a clear panel with a dark outline) or `nested` inside another panel (pale
 * slate, a quieter outline).
 */
export function groupPanelsOf(
  groups: readonly {
    readonly id: string;
    readonly parentId: string | undefined;
    readonly classes?: readonly string[];
    readonly figure?: GroupFigure;
  }[],
  categories: CategoryIndex,
): GroupPanels {
  const ids = new Set(groups.map((group) => group.id));
  return new Map(
    groups.map((group) => {
      const palette = ownGroupPalette(group, categories) ?? NEUTRAL;
      const nested = palette.family === undefined && group.parentId !== undefined && ids.has(group.parentId);
      return [group.id, { palette, nested }];
    }),
  );
}

/**
 * What a node is drawn in: its own identity; else, directly inside a family panel, a card in that family (a
 * light card with the family's border and ink, like the reference's GPU panels); else neutral. A node of its
 * own family inside that family's panel is the card too: tint on tint would say the colour twice. A closed
 * container of the nested view is its group, so it is drawn in the group's own colour, filled, or neutral.
 */
export function nodePalette(
  node: {
    readonly classes?: readonly string[];
    readonly figure?: NodeFigure;
    readonly groupId?: string | undefined;
    readonly folded?: { readonly groupId: string } | undefined;
  },
  categories: CategoryIndex,
  panels: GroupPanels = new Map(),
): Palette {
  const own = ownNodePalette(node, categories);
  const parent = node.groupId === undefined ? undefined : panels.get(node.groupId)?.palette.family;
  if (own !== undefined)
    // In a panel of its own family it is that panel's card: the panel already says the colour.
    return own.family !== undefined && own.family === parent && node.folded === undefined
      ? { ...own, card: true }
      : own;
  if (node.folded !== undefined) return panels.get(node.folded.groupId)?.palette ?? NEUTRAL;
  return parent === undefined ? NEUTRAL : { family: parent, card: true };
}

/**
 * Whether a drawing is in family colours anywhere: a node or a group with a family. Such a drawing numbers
 * its emphasis groups by default (ADR 0030, amended 2026-11-11), on the canvas and in exports.
 */
export function usesFamilyColours(drawing: {
  readonly nodes: readonly {
    readonly classes?: readonly string[];
    readonly figure?: NodeFigure;
    readonly groupId?: string | undefined;
    readonly folded?: { readonly groupId: string } | undefined;
  }[];
  readonly groups: readonly {
    readonly id: string;
    readonly parentId: string | undefined;
    readonly classes?: readonly string[];
    readonly figure?: GroupFigure;
  }[];
  readonly categories?: readonly Category[];
}): boolean {
  const categories = indexCategories(drawing.categories);
  const panels = groupPanelsOf(drawing.groups, categories);
  return (
    [...panels.values()].some((panel) => panel.palette.family !== undefined) ||
    drawing.nodes.some((node) => nodePalette(node, categories, panels).family !== undefined)
  );
}
