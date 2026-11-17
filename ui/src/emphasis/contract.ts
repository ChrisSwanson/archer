/**
 * The `set_emphasis` wire contract, as the UI reads it.
 *
 * The agent never supplies colours, CSS, or markup -- only ids drawn from the
 * compiled model plus values from closed enums. Everything here turns those
 * enums into CLASS NAMES; nothing the agent sends may reach a CSS property.
 * That is the whole reason the palette is an enum: the theme owns the colour
 * and renders it correctly in light and dark.
 *
 * Wire shape (frozen):
 *   { "schemaVersion": 1, "viewId": "...", "emphases": [<payload>, ...] }
 * carried by the `emphasis` SSE event, by `GET api/emphasis/{viewId}`, and by
 * `set_emphasis`'s own `structuredContent` on the MCP transport.
 *
 *   <payload> = { "id", "viewId", "title", "groups": [{
 *      "id", "style", "palette", "state", "speed",
 *      "label", "description", "nodes": [...], "edges": [...] }] }
 *
 * `groups: []` means cleared.
 */

/**
 * The one emphasis wire version this page reads.
 *
 * Its own number: the emphasis snapshot, the inventory and the diagram envelope
 * are versioned separately, and one moving does not move the others.
 */
export const EMPHASIS_SCHEMA_VERSION = 1;

export const EMPHASIS_STYLES = ["flow", "highlight"] as const;
/**
 * Group 1, 2 and 3 (ADR 0030). The page colours a group by its POSITION, not by
 * the palette name on the wire (the service derives that name from position).
 * Amber is the agent's voice, never a group.
 */
export const EMPHASIS_SLOTS = ["teal", "violet", "coral"] as const;
export const EMPHASIS_PALETTES = EMPHASIS_SLOTS;
export const EMPHASIS_STATES = ["existing", "proposed"] as const;
export const EMPHASIS_SPEEDS = ["slow", "normal", "fast"] as const;

export type EmphasisStyle = (typeof EMPHASIS_STYLES)[number];
export type EmphasisPalette = (typeof EMPHASIS_PALETTES)[number];
export type EmphasisState = (typeof EMPHASIS_STATES)[number];
export type EmphasisSpeed = (typeof EMPHASIS_SPEEDS)[number];

export type EmphasisGroup = {
  readonly id: string;
  readonly style: EmphasisStyle;
  readonly palette: EmphasisPalette;
  readonly state: EmphasisState;
  /** Pace of the moving arrows. `null` for `highlight`, which does not move. */
  readonly speed: EmphasisSpeed | null;
  readonly label: string;
  readonly description: string;
  readonly nodes: readonly string[];
  /** In travel order: the packet stagger reads as one payload moving through. */
  readonly edges: readonly string[];
  /** Built on the page for a walkthrough's earlier steps (ADR 0034 §4): a quieter tone of the same hue. Never on the wire. */
  readonly tone?: "walked";
  /** What a member's accessible name ends with, in place of "in highlight N: label" (a walkthrough's "step 3, current"). */
  readonly spoken?: string;
};

/** One named emphasis, as stored for a view. */
export type Emphasis = {
  readonly id: string;
  readonly viewId: string;
  readonly title: string;
  readonly groups: readonly EmphasisGroup[];
  /** `false` for an emphasis built on the page that has its own key (the walkthrough panel): no legend. Never on the wire. */
  readonly legend?: false;
};

/** The full stored list for one view, oldest-first. */
export type EmphasisSnapshot = {
  readonly viewId: string;
  readonly emphases: readonly Emphasis[];
};

/**
 * How fast a flow's moving arrows travel, in px per second of route.
 *
 * Pace is part of the CLAIM ("this hop is the expensive one"), not a viewer
 * preference, so the mapping is fixed here rather than themed. A rate rather
 * than a period, so a long hop takes longer than a short one at one pace.
 */
export const EMPHASIS_SPEED_PX_PER_SECOND: Readonly<Record<EmphasisSpeed, number>> = {
  slow: 50,
  normal: 80,
  fast: 130,
};

/**
 * Class namespace.
 *
 * `archer-emph-*` is a channel of its own, disjoint from `archer-focus-*`
 * (presentation focus, see `diagrams/focus-style.ts`). Neither namespace's
 * selectors may ever match the other's classes: focus dimming is the host's
 * published framing, emphasis is the agent pointing, and one must not capture
 * the other.
 *
 * Disjoint CLASSES are not by themselves disjoint RENDERING -- focus also sets
 * an inline `opacity`, which no class namespace can keep off an emphasised
 * element. Where the two meet, emphasis wins the opacity and is never dimmed;
 * the rule and its reasoning are in `diagrams/xflow-adapter.ts` (`dimmedBy`),
 * the one place that resolves it.
 */
export const EMPHASIS_CLASS = "archer-emph";
/** Marks the members of the group a legend row is currently isolating. */
export const EMPHASIS_MEMBER_CLASS = "archer-emph-member";
/** Set on the canvas when the viewer has asked for reduced motion. */
export const EMPHASIS_STATIC_CLASS = "archer-emph-static";

/** A walkthrough's earlier steps: the same hue, quieter (`--walked`, ADR 0034 §4). */
export const WALKED_CLASS = "archer-emph--walked";

/** The page's one word for emphasis (G17). */
export const HIGHLIGHTS = "Highlights";

/** What the reader calls an emphasis: its title, else its first group's label; never its id. */
export function emphasisName(emphasis: Emphasis): string {
  return emphasis.title || emphasis.groups[0]?.label || HIGHLIGHTS;
}

export function paletteClass(palette: EmphasisPalette): string {
  return `archer-emph-palette-${palette}`;
}

export function styleClass(style: EmphasisStyle): string {
  return `archer-emph-style-${style}`;
}

export function speedClass(speed: EmphasisSpeed): string {
  return `archer-emph-speed-${speed}`;
}

/** Whether the wire declined to say -- by omitting the key, or by nulling it. */
function absent(value: unknown): value is undefined | null {
  return value === undefined || value === null;
}

function isMember<T extends string>(values: readonly T[], candidate: unknown): candidate is T {
  return typeof candidate === "string" && (values as readonly string[]).includes(candidate);
}

function idList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.every((entry) => typeof entry === "string" && entry.length > 0) ? (value as string[]) : undefined;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function parseGroup(value: unknown): EmphasisGroup | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    return undefined;
  }
  if (!isMember(EMPHASIS_STYLES, record.style)) {
    return undefined;
  }
  // The palette is read only to stay strict about the wire: present, it must
  // be a known name; absent is fine. Which colour is drawn is the slot's.
  if (!absent(record.palette) && !isMember(EMPHASIS_PALETTES, record.palette)) {
    return undefined;
  }
  // An explicit `null` means the same as an omitted key -- the rule the server
  // already holds itself to on the way in. Getting it wrong HERE is the
  // expensive direction: a rejected group rejects the whole emphasis, and the
  // page's answer to that is a console line, so the diagram comes up with
  // nothing lit and every test still green.
  const state = absent(record.state) ? "existing" : record.state;
  if (!isMember(EMPHASIS_STATES, state)) {
    return undefined;
  }
  // Read for strictness only: since ADR 0030 "proposed" is said in the label
  // and never drawn, so every group draws as it is.
  const speed = absent(record.speed) ? undefined : record.speed;
  if (speed !== undefined && !isMember(EMPHASIS_SPEEDS, speed)) {
    return undefined;
  }
  const nodes = idList(record.nodes ?? []);
  const edges = idList(record.edges ?? []);
  if (nodes === undefined || edges === undefined) {
    return undefined;
  }
  return {
    id: record.id,
    style: record.style,
    palette: isMember(EMPHASIS_PALETTES, record.palette) ? record.palette : "teal",
    state: "existing",
    // Speed is meaningless without motion, so a highlight group never carries
    // one even if the wire offered it.
    speed: record.style === "flow" ? (speed ?? "normal") : null,
    label: text(record.label, record.id),
    description: text(record.description, ""),
    nodes,
    edges,
  };
}

/**
 * Reads one stored emphasis, or reports that it was not one.
 *
 * ATOMIC, deliberately, and unlike `parseInventory`: a payload with any problem
 * in it renders NOTHING. A partially valid emphasis would put a picture on
 * screen saying something the agent did not mean, which is worse than showing
 * nothing. A dropped tab costs one diagram; a dropped group silently changes
 * the claim the remaining groups are making.
 */
export function parseEmphasis(value: unknown): Emphasis | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    return undefined;
  }
  if (typeof record.viewId !== "string" || record.viewId.length === 0) {
    return undefined;
  }
  if (!Array.isArray(record.groups)) {
    return undefined;
  }
  const groups: EmphasisGroup[] = [];
  for (const [index, entry] of record.groups.entries()) {
    const group = parseGroup(entry);
    if (group === undefined) {
      return undefined;
    }
    // More groups than slots cannot be coloured (ADR 0030); drawing some of
    // them would change the claim the rest make, so the emphasis is refused whole.
    const slot = EMPHASIS_SLOTS[index];
    if (slot === undefined) {
      return undefined;
    }
    groups.push({ ...group, palette: slot });
  }
  return {
    id: record.id,
    viewId: record.viewId,
    title: text(record.title, ""),
    groups,
  };
}

/**
 * Reads an emphasis snapshot for one view.
 *
 * A malformed member is dropped rather than failing the snapshot: the list is
 * the whole stored set, and one bad entry must not take the others' chips off
 * the row.
 *
 * A snapshot at any other `schemaVersion` is rejected whole, and nothing in it
 * is drawn: its members would be read by rules written for a different shape,
 * and an emphasis drawn from a misreading says something its author did not
 * mean. Callers already treat `undefined` as "no snapshot here" and leave what
 * is on screen alone. The console line is logged only once the payload has the
 * shape of a snapshot, because on the MCP transport every tool result is
 * offered to this function and most of them are not snapshots at all.
 */
export function parseEmphasisSnapshot(payload: unknown): EmphasisSnapshot | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.viewId !== "string" || !Array.isArray(record.emphases)) {
    return undefined;
  }
  if (record.schemaVersion !== EMPHASIS_SCHEMA_VERSION) {
    console.error(
      `[archer] emphasis schemaVersion ${JSON.stringify(record.schemaVersion)} is not supported; ` +
        `this page reads version ${EMPHASIS_SCHEMA_VERSION}`,
    );
    return undefined;
  }
  const emphases: Emphasis[] = [];
  for (const entry of record.emphases) {
    const emphasis = parseEmphasis(entry);
    // An emphasis stored under a different view than the snapshot claims is
    // not this view's to draw.
    if (emphasis !== undefined && emphasis.viewId === record.viewId) {
      emphases.push(emphasis);
    }
  }
  return { viewId: record.viewId, emphases };
}

/** What one emphasised node or edge needs in order to draw itself. */
export type EmphasisAssignment = {
  readonly groupId: string;
  readonly style: EmphasisStyle;
  readonly palette: EmphasisPalette;
  readonly state: EmphasisState;
  readonly speed: EmphasisSpeed | null;
  /** The group's number: its position in the emphasis, from 1, kept when an earlier group is off. */
  readonly slot: number;
  /** The group's label, for the element's accessible name. */
  readonly label: string;
  /** Position of this edge in its group's travel order, and the length of it. */
  readonly hop: number;
  readonly hops: number;
  readonly classes: readonly string[];
  readonly spoken?: string;
};

export type EmphasisAssignments = {
  readonly nodes: ReadonlyMap<string, EmphasisAssignment>;
  readonly edges: ReadonlyMap<string, EmphasisAssignment>;
};

export const NO_EMPHASIS: EmphasisAssignments = { nodes: new Map(), edges: new Map() };

function classesFor(group: EmphasisGroup): readonly string[] {
  // No state class: since ADR 0030 "proposed" is said in the label, not drawn.
  const classes = [EMPHASIS_CLASS, styleClass(group.style), paletteClass(group.palette)];
  if (group.speed !== null) {
    classes.push(speedClass(group.speed));
  }
  if (group.tone === "walked") {
    classes.push(WALKED_CLASS);
  }
  return classes;
}

/**
 * A group's number, from 1: its position, which `parseEmphasis` fixed as its
 * slot colour. Read from the colour rather than the index so that a list the
 * reader has filtered (a group turned off) keeps every other group's number.
 */
export function groupSlot(group: EmphasisGroup, index = 0): number {
  const slot = (EMPHASIS_SLOTS as readonly string[]).indexOf(group.palette);
  return slot >= 0 ? slot + 1 : index + 1;
}

/**
 * What an emphasised element adds to its accessible name (WCAG 1.4.1): the
 * group's number and label, so the group is never said by colour alone.
 * Empty for an element in no group the reader has on.
 */
export function emphasisMembership(
  assignment: (Pick<EmphasisAssignment, "slot" | "label"> & { readonly spoken?: string }) | undefined,
): string {
  return assignment === undefined
    ? ""
    : assignment.spoken !== undefined
      ? `, ${assignment.spoken}`
      : `, in highlight ${assignment.slot}: ${assignment.label}`;
}

/**
 * Flattens an emphasis into per-id drawing instructions.
 *
 * An id named by two groups keeps the FIRST group's treatment. Groups are
 * ordered as the agent sent them, so this is deterministic; the alternative is
 * an element whose appearance depends on iteration order.
 */
export function assignEmphasis(emphasis: Emphasis | null | undefined): EmphasisAssignments {
  if (emphasis === null || emphasis === undefined) {
    return NO_EMPHASIS;
  }
  const nodes = new Map<string, EmphasisAssignment>();
  const edges = new Map<string, EmphasisAssignment>();

  for (const group of emphasis.groups) {
    const classes = classesFor(group);
    const base = {
      groupId: group.id,
      slot: groupSlot(group),
      label: group.label,
      style: group.style,
      palette: group.palette,
      state: group.state,
      speed: group.speed,
      classes,
      ...(group.spoken === undefined ? {} : { spoken: group.spoken }),
    } as const;
    for (const id of group.nodes) {
      if (!nodes.has(id)) {
        nodes.set(id, { ...base, hop: 0, hops: 1 });
      }
    }
    group.edges.forEach((id, hop) => {
      if (!edges.has(id)) {
        edges.set(id, { ...base, hop, hops: group.edges.length });
      }
    });
  }

  return { nodes, edges };
}

/**
 * What two or more groups both point at, as the reader would see it.
 *
 * `representativeOf` maps an id to the element that stands for it on screen:
 * the identity on a full view, and the closed boundary or bundle a hidden id
 * is drawn as at a zoom level, where two groups landing on one box share it
 * just as surely as two naming the same node. Empty means the groups are
 * disjoint and can be shown together (ADR 0030, "One / All").
 */
export function sharedParts(
  emphasis: Emphasis | null | undefined,
  representativeOf: (id: string, channel: "nodes" | "edges") => string = (id) => id,
): { readonly nodes: readonly string[]; readonly edges: readonly string[] } {
  const shared = { nodes: [] as string[], edges: [] as string[] };
  for (const channel of ["nodes", "edges"] as const) {
    const owner = new Map<string, number>();
    for (const [index, group] of (emphasis?.groups ?? []).entries()) {
      for (const id of group[channel]) {
        const seen = representativeOf(id, channel);
        const first = owner.get(seen);
        if (first === undefined) owner.set(seen, index);
        else if (first !== index && !shared[channel].includes(seen)) shared[channel].push(seen);
      }
    }
  }
  return shared;
}

/**
 * Where each of a flow's messages sits in the journey, by the order the
 * DIAGRAM has them rather than the order the payload listed them.
 *
 * A graph has no order of its own, so its packets stagger in the order the
 * agent wrote the edges (`assignEmphasis`). A sequence diagram does: it is read
 * top to bottom, and a flow whose third hop leaves before its first reads as
 * three unrelated packets. `ordered` is every drawable id in reading order;
 * what comes back is each emphasised id's place among its own group's.
 */
export function travelOrder(
  edges: ReadonlyMap<string, EmphasisAssignment>,
  ordered: readonly string[],
): ReadonlyMap<string, { readonly hop: number; readonly hops: number }> {
  const byGroup = new Map<string, string[]>();
  for (const id of ordered) {
    const assignment = edges.get(id);
    if (assignment !== undefined) {
      byGroup.set(assignment.groupId, [...(byGroup.get(assignment.groupId) ?? []), id]);
    }
  }
  const placed = new Map<string, { hop: number; hops: number }>();
  for (const ids of byGroup.values()) {
    ids.forEach((id, hop) => placed.set(id, { hop, hops: ids.length }));
  }
  return placed;
}

/**
 * Which notation the emphasis is drawn in, and so what its ids are called.
 *
 * The wire spells both `nodes` and `edges`; on a sequence diagram those are
 * participants and messages, and a legend that counted "2 nodes" beside a
 * diagram with no nodes in it would be naming things the reader cannot find.
 */
export type EmphasisNotation = "graph" | "sequence" | "journey";
