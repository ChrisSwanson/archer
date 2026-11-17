/**
 * The four graph-like model types beyond the flowchart, projected onto the one
 * graph the canvas draws.
 *
 * A state machine, an entity-relationship diagram, a C4 model and a service
 * architecture are all points joined by lines, so each is drawn on the graph
 * canvas (ELK and React Flow) rather than on a canvas of its own: selection,
 * emphasis, comments, keyboard traversal and framing are the graph canvas's
 * and come with it. What differs is how each point and line LOOKS, and that is
 * a FIGURE carried beside the plain graph fields:
 *
 *   - a node's figure says what it is drawn as (a state's kind, an entity's
 *     attribute rows, a C4 element's kind and lines, a service's icon);
 *   - a group's figure says what frame it is (a composite state, a C4
 *     boundary, an architecture group); every group here is also a model
 *     ELEMENT, selectable as a node, which a flowchart subgraph is not;
 *   - an edge's figure carries what its ends look like (crow's-foot
 *     cardinalities, the side it leaves by, arrowheads).
 *
 * The ids are the model's own (`ts/src/model/elements.ts`, `elementsOf`):
 * what the reader selects here is what the agent reads back.
 */

/** Mirrors `StateKind` in the schema; absent on the wire means `state`. */
export const STATE_KINDS = ["state", "initial", "final", "choice", "fork", "join"] as const;
export type StateKind = (typeof STATE_KINDS)[number];

export const STATE_NOTE_POSITIONS = ["left-of", "right-of"] as const;
export type StateNotePosition = (typeof STATE_NOTE_POSITIONS)[number];

export const CARDINALITIES = ["zero-or-one", "exactly-one", "zero-or-more", "one-or-more"] as const;
export type Cardinality = (typeof CARDINALITIES)[number];

export const ATTRIBUTE_KEYS = ["PK", "FK", "UK"] as const;
export type AttributeKey = (typeof ATTRIBUTE_KEYS)[number];

export const C4_ELEMENT_KINDS = ["person", "system", "container", "component"] as const;
export type C4ElementKind = (typeof C4_ELEMENT_KINDS)[number];

export const C4_ELEMENT_SHAPES = ["database", "queue"] as const;
export type C4ElementShape = (typeof C4_ELEMENT_SHAPES)[number];

export const C4_BOUNDARY_KINDS = ["enterprise", "system", "container", "generic"] as const;
export type C4BoundaryKind = (typeof C4_BOUNDARY_KINDS)[number];

export const C4_LEVELS = ["context", "container", "component"] as const;
export type C4Level = (typeof C4_LEVELS)[number];

export const ARCHITECTURE_ICONS = ["cloud", "database", "disk", "internet", "server"] as const;
export type ArchitectureIcon = (typeof ARCHITECTURE_ICONS)[number];

export const ARCHITECTURE_SIDES = ["left", "right", "top", "bottom"] as const;
export type ArchitectureSide = (typeof ARCHITECTURE_SIDES)[number];

export type StateNote = { readonly position: StateNotePosition; readonly text: string };

export type EntityAttributeRow = {
  readonly name: string;
  readonly type: string;
  readonly keys: readonly AttributeKey[];
  readonly comment: string | undefined;
};

export type NodeFigure =
  | { readonly type: "state"; readonly kind: StateKind; readonly note?: StateNote }
  | { readonly type: "entity"; readonly attributes: readonly EntityAttributeRow[] }
  | {
      readonly type: "c4";
      readonly kind: C4ElementKind;
      readonly external: boolean;
      readonly shape?: C4ElementShape;
      readonly technology?: string;
      readonly description?: string;
    }
  | { readonly type: "service"; readonly icon?: ArchitectureIcon }
  | { readonly type: "junction" };

export type GroupFigure =
  | { readonly type: "composite"; readonly note?: StateNote }
  | { readonly type: "boundary"; readonly kind: C4BoundaryKind }
  | { readonly type: "zone"; readonly icon?: ArchitectureIcon };

export type EdgeFigure =
  | { readonly type: "cardinality"; readonly source: Cardinality; readonly target: Cardinality }
  | {
      readonly type: "c4";
      readonly technology?: string;
      readonly description?: string;
      readonly bidirectional: boolean;
    }
  | {
      readonly type: "ports";
      readonly sourceSide: ArchitectureSide;
      readonly targetSide: ArchitectureSide;
      readonly sourceArrow: boolean;
      readonly targetArrow: boolean;
      readonly sourceGroup: boolean;
      readonly targetGroup: boolean;
    };

/** Which notation a graph view is drawn in. Absent means a flowchart. */
export type GraphNotation = "flowchart" | "state" | "er" | "c4" | "architecture";

/** Which arrowheads an edge is drawn with. */
export type EdgeArrows = { readonly start: boolean; readonly end: boolean };

/**
 * A flowchart edge, a transition and a C4 relationship point at their target; a two-way flowchart edge
 * (`bidirectional`, `<-->`) at both ends.
 */
export function arrowsOf(figure: EdgeFigure | undefined, bidirectional = false): EdgeArrows {
  if (figure === undefined) return { start: bidirectional, end: true };
  switch (figure.type) {
    case "cardinality":
      // The crow's-foot marks are the ends: an arrowhead would be a second
      // and contradictory account of them.
      return { start: false, end: false };
    case "c4":
      return { start: figure.bidirectional, end: true };
    case "ports":
      return { start: figure.sourceArrow, end: figure.targetArrow };
  }
}

/** The words a figure adds to its element's accessible name, after the label. */
export function figureDescription(figure: NodeFigure | undefined): string | undefined {
  if (figure === undefined) return undefined;
  switch (figure.type) {
    case "state": {
      // The drawn note is hidden from screen readers, so its words are here.
      const note = figure.note === undefined ? [] : [`note: ${figure.note.text}`];
      const kind =
        figure.kind === "state"
          ? []
          : [figure.kind === "initial" || figure.kind === "final" ? `${figure.kind} state` : figure.kind];
      const words = [...kind, ...note];
      return words.length === 0 ? undefined : words.join(", ");
    }
    case "entity":
      // Every attribute, in words, as the table shows it.
      return figure.attributes.length === 0
        ? "entity"
        : `entity: ${figure.attributes
            .map((row) =>
              [row.name, row.type, ...row.keys, ...(row.comment === undefined ? [] : [row.comment])].join(" "),
            )
            .join("; ")}`;
    case "c4": {
      const words: string[] = [figure.external ? `external ${figure.kind}` : figure.kind];
      if (figure.shape !== undefined) words.push(figure.shape);
      if (figure.technology !== undefined) words.push(figure.technology);
      if (figure.description !== undefined) words.push(figure.description);
      return words.join(", ");
    }
    case "service":
      return figure.icon === undefined ? "service" : `${figure.icon} service`;
    case "junction":
      return "junction";
  }
}

/** The words a group's figure adds to its accessible name. */
export function groupDescription(figure: GroupFigure | undefined): string | undefined {
  if (figure === undefined) return undefined;
  switch (figure.type) {
    case "composite":
      return figure.note === undefined ? "composite state" : `composite state, note: ${figure.note.text}`;
    case "boundary":
      return figure.kind === "generic" ? "boundary" : `${figure.kind} boundary`;
    case "zone":
      return figure.icon === undefined ? "group" : `${figure.icon} group`;
  }
}

/** What C4 calls a boundary of each kind, on its frame. */
export const BOUNDARY_WORD: Readonly<Record<C4BoundaryKind, string>> = {
  enterprise: "Enterprise",
  system: "System",
  container: "Container",
  generic: "Boundary",
};

/** The bracketed type line of a C4 element: `[Container: TypeScript]`. */
export function c4TypeLine(figure: Extract<NodeFigure, { type: "c4" }>): string {
  const word = `${figure.external ? "External " : ""}${figure.kind[0].toUpperCase()}${figure.kind.slice(1)}`;
  const shaped = figure.shape === undefined ? word : `${word} ${figure.shape}`;
  return figure.technology === undefined ? `[${shaped}]` : `[${shaped}: ${figure.technology}]`;
}
