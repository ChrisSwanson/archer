/**
 * The Diagram Key's colour rows (DESIGN.md, "Diagram palette", "The Key"): one row for each kind family and
 * authored category the drawing shows (plain structure is neutral and has none), each with the fill, border and
 * dash its members are drawn in, and the members by name. No JSX, so the export painter reads it too: the
 * sidebar and an exported drawing key the same rows with the same tokens.
 *
 * Every decision is `palette.ts`'s (`ownNodePalette`, `ownGroupPalette`, `nodePalette`):
 * this only groups what those already decided, so a row cannot disagree with the canvas.
 */
import type { GroupFigure, NodeFigure } from "./figures";
import { ICONS } from "./key-entries";
import { type SourceOrder, writtenOrder } from "./source-order";
import {
  type Category,
  type CategoryIndex,
  FAMILY_TOKENS,
  type Family,
  type GroupPanels,
  groupPanelsOf,
  indexCategories,
  nodePalette,
  ownGroupPalette,
  ownNodePalette,
  type Palette,
} from "./palette";

/** What the Key reads of a drawing: a projected view and a layout both carry it. */
export type PaletteKeySource = {
  readonly nodes: readonly {
    readonly id: string;
    readonly label: string;
    readonly classes?: readonly string[];
    readonly figure?: NodeFigure;
    readonly groupId?: string | undefined;
    readonly folded?: { readonly groupId: string } | undefined;
  }[];
  readonly groups: readonly {
    readonly id: string;
    readonly label: string;
    readonly parentId: string | undefined;
    readonly classes?: readonly string[];
    readonly figure?: GroupFigure;
  }[];
  readonly categories?: readonly Category[];
  /** Where the source writes things (`source-order.ts`): the rows. order. */
  readonly sourceOrder?: SourceOrder;
};

export type PaletteKeyMember = { readonly id: string; readonly label: string; readonly channel: "node" | "group" };

/** A sample's paint, as theme tokens (`var(--…)`): the page draws them, the export resolves them. */
export type PaletteSwatch = {
  /** A node card, or a group's panel. */
  readonly sample: "node" | "group";
  readonly fill: string;
  readonly border: string;
  readonly dashed: boolean;
};

export type PaletteKeyRow = {
  /** Stable and unique: `kind:<name>`, `category:<name>`. */
  readonly key: string;
  readonly type: "kind" | "category";
  /** The kind's word (the notation Key's), the category's name. */
  readonly name: string;
  /**
   * What the row is called: a kind's word; a category's meaning in the author's words (`%% archer-key`), else its
   * class name as written. Each member's accessible name says the same (`membershipOf`).
   */
  readonly label: string;
  /** What sort of row, said in words beside the name ("Marked gpu in the source, dashed outline"). */
  readonly detail: string;
  /** For a kind row, the notation Key's label whose glyph it keeps (`KeySymbol`). */
  readonly glyph?: string;
  readonly family: Family | undefined;
  readonly dashed: boolean;
  readonly swatch: PaletteSwatch;
  readonly members: readonly PaletteKeyMember[];
};

/** A label's first line: a node's title, without its description. */
export const titleOf = (label: string, id: string): string => label.split("\n")[0]?.trim() || id;

const capital = (word: string): string => word[0]!.toUpperCase() + word.slice(1);

/** The flowchart kinds with a family, as their Key words. */
const KIND_WORDS: Readonly<Record<string, string>> = {
  person: "Person",
  system: "System",
  container: "Container",
  database: "Database",
};

/**
 * The notation Key's word for what gave a node its own family -- a kind, a C4 element, a service icon --
 * which is also the label whose glyph the row keeps (`KeySymbol`).
 */
function nodeKind(node: PaletteKeySource["nodes"][number]): string | undefined {
  const figure = node.figure;
  if (figure?.type === "c4") return figure.shape === "database" ? "Database" : capital(figure.kind);
  if (figure?.type === "service" && figure.icon !== undefined) return `${ICONS[figure.icon]} icon`;
  return (node.classes ?? []).map((name) => KIND_WORDS[name]).find((name) => name !== undefined);
}

/** The notation Key's word for what gave a group its own family: a C4 boundary, an architecture icon, a kind. */
function groupKind(group: PaletteKeySource["groups"][number]): string | undefined {
  const figure = group.figure;
  if (figure?.type === "boundary" && (figure.kind === "system" || figure.kind === "container"))
    return `${capital(figure.kind)} boundary`;
  if (figure?.type === "zone" && figure.icon !== undefined) return `${ICONS[figure.icon]} icon`;
  return (group.classes ?? []).map((name) => KIND_WORDS[name]).find((name) => name !== undefined);
}

const nodeSwatch = (palette: Palette): PaletteSwatch => ({
  sample: "node",
  fill:
    palette.family !== undefined
      ? FAMILY_TOKENS[palette.family].fill
      : palette.quiet === true
        ? "var(--node-quiet-bg)"
        : "var(--node-bg)",
  border:
    palette.family !== undefined
      ? FAMILY_TOKENS[palette.family].border
      : palette.quiet === true
        ? "var(--node-quiet-border)"
        : "var(--node-border)",
  dashed: palette.dashed === true,
});

const groupSwatch = (palette: Palette): PaletteSwatch => ({
  sample: "group",
  fill: palette.family === undefined ? "var(--group-bg)" : FAMILY_TOKENS[palette.family].panel,
  border: palette.family === undefined ? "var(--group-border)" : FAMILY_TOKENS[palette.family].border,
  dashed: palette.dashed === true,
});

type Draft = {
  key: string;
  type: PaletteKeyRow["type"];
  name: string;
  glyph?: string;
  palette: Palette;
  groups: PaletteKeyMember[];
  nodes: PaletteKeyMember[];
  /** A node wears the row's own fill (not only a card inside one of its panels). */
  filled: boolean;
};

/** The Key's colour rows for a drawing: kinds by family, then categories by name. */
export function paletteKeyRows(
  source: PaletteKeySource,
  categories: CategoryIndex = indexCategories(source.categories),
  panels: GroupPanels = groupPanelsOf(source.groups, categories),
): PaletteKeyRow[] {
  const drafts = new Map<string, Draft>();
  const groupById = new Map(source.groups.map((group) => [group.id, group]));
  /** The row a palette of its own belongs to, or none for a neutral kind. */
  const ownRow = (own: Palette, kind: string | undefined): Draft | undefined => {
    const [key, type, name] =
      own.category !== undefined
        ? ([`category:${own.category}`, "category", own.category] as const)
        : own.family === undefined || kind === undefined
          ? []
          : ([`kind:${kind}`, "kind", kind] as const);
    if (key === undefined) return undefined;
    let row = drafts.get(key);
    if (row === undefined) {
      row = {
        key,
        type,
        name,
        palette: own,
        groups: [],
        nodes: [],
        filled: false,
        ...(type === "kind" ? { glyph: kind! } : {}),
      };
      drafts.set(key, row);
    }
    return row;
  };
  /** A group's row: its own colour's, if it has one. Plain structure is neutral and in no row. */
  const groupRow = (id: string): Draft | undefined => {
    const group = groupById.get(id);
    const own = group === undefined ? undefined : ownGroupPalette(group, categories);
    return own === undefined || group === undefined ? undefined : ownRow(own, groupKind(group));
  };
  // Rows go in the order each is first worn in the source (owner, 2026-11-12): by where its first member is
  // written (`source-order.ts`). Only the rows' order: no colour depends on it.
  const written = new Map(writtenOrder(source).elements.map((element, at) => [`${element.kind}:${element.id}`, at]));
  const placeOf = (kind: "node" | "group", id: string): number =>
    written.get(`${kind}:${id}`) ?? written.get(`${kind === "node" ? "group" : "node"}:${id}`) ?? Infinity;
  const firstSeen = new Map<Draft, number>();
  const seen = (row: Draft, at: number): void => {
    if (at < (firstSeen.get(row) ?? Infinity)) firstSeen.set(row, at);
  };
  for (const group of source.groups) {
    const row = groupRow(group.id);
    if (row === undefined) continue;
    row.groups.push({ id: group.id, label: titleOf(group.label, group.id), channel: "group" });
    seen(row, placeOf("group", group.id));
  }
  for (const node of source.nodes) {
    const own = ownNodePalette(node, categories);
    const row =
      own !== undefined
        ? ownRow(own, nodeKind(node))
        : node.folded !== undefined
          ? groupRow(node.folded.groupId)
          : nodePalette(node, categories, panels).card === true && node.groupId !== undefined
            ? groupRow(node.groupId)
            : undefined;
    if (row === undefined) continue;
    row.nodes.push({ id: node.id, label: titleOf(node.label, node.id), channel: "node" });
    seen(row, placeOf("node", node.id));
    // A card inside a family panel is the panel's light card; anything else in the row is filled.
    if (nodePalette(node, categories, panels).card !== true) row.filled = true;
  }
  const rank = (row: Draft): [number, string] => [firstSeen.get(row) ?? Infinity, row.name];
  const compare = (a: Draft, b: Draft): number => {
    const [x, y] = [rank(a), rank(b)];
    if (x[0] !== y[0]) return x[0] < y[0] ? -1 : 1;
    return x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0;
  };
  return [...drafts.values()]
    .filter((row) => row.groups.length + row.nodes.length > 0)
    .sort(compare)
    .map((row) => {
      const dashed = row.palette.dashed === true;
      const meaning = row.type === "category" ? categories.get(row.name)?.meaning : undefined;
      // A node sample where a member wears the fill (a box is what a reader looks for); the panel where every
      // member is a panel or a card seen inside one.
      const swatch = row.filled || row.groups.length === 0 ? nodeSwatch(row.palette) : groupSwatch(row.palette);
      return {
        key: row.key,
        type: row.type,
        name: row.name,
        label: meaning ?? row.name,
        // With a meaning the row's title is the author's words, so the detail says which class it is -- in words,
        // as the Person row's detail is a sentence (review, 2026-11-12: not a bare "Category gpu").
        detail:
          row.type === "kind"
            ? "Kind"
            : `Marked${meaning === undefined ? "" : ` ${row.name}`} in the source${dashed ? ", dashed outline" : ""}`,
        ...(row.glyph === undefined ? {} : { glyph: row.glyph }),
        family: row.palette.family,
        dashed,
        swatch,
        members: [...row.groups, ...row.nodes],
      };
    });
}

/**
 * Each member's Key row in words, by `node:<id>` or `group:<id>`, for its accessible name: the author's meaning
 * ("Model server on a GPU"), else "gpu category" (a dashed one says so). Colour is never the only cue -- and a name says each thing once (DESIGN.md, the One
 * Read Rule): a kind's row is the element's own word, glyph or shape, and is kept out of its accessible name
 * (`node-shapes.test.tsx`, "keeps the kind caption out of the node's accessible name").
 */
export function membershipOf(
  rows: readonly PaletteKeyRow[],
  _source?: Pick<PaletteKeySource, "nodes" | "groups">,
): ReadonlyMap<string, string> {
  const phrases = new Map<string, string>();
  for (const row of rows) {
    if (row.type === "kind") continue;
    // The author's meaning is said as written; a bare class name is said as a category.
    const named = row.label === row.name ? `${row.name} category` : row.label;
    const phrase = `${named}${row.dashed ? ", dashed outline" : ""}`;
    for (const member of row.members) phrases.set(`${member.channel}:${member.id}`, phrase);
  }
  return phrases;
}
