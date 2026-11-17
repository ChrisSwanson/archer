/**
 * What the Diagram key says, with no JSX and no UI components, so the export painter can read it
 * without loading the page's React modules (a module-scope element there needs `React` in scope).
 * A key describes only the notation present in the drawing on screen.
 */
import type { ArchitectureIcon, AttributeKey, C4BoundaryKind, C4ElementKind, Cardinality, StateKind } from "./figures";
import { eachSequenceEvent } from "../../../shared/sequence-events.mts";
import type { LineKeyEntry, ProjectedJourney, ProjectedSequence, ProjectedView } from "./projection";

/** The architecture icons' names, as the key and its symbols spell them. */
export const ICONS: Record<ArchitectureIcon, string> = {
  cloud: "Cloud",
  database: "Database",
  disk: "Disk",
  internet: "Internet",
  server: "Server",
};

export type KeyModel =
  | { readonly type: "graph"; readonly view: ProjectedView }
  | { readonly type: "sequence"; readonly view: ProjectedSequence }
  | { readonly type: "journey"; readonly view: ProjectedJourney };
export type KeyEntry = { readonly label: string; readonly meaning: string };

const STATES: Record<StateKind, KeyEntry> = {
  state: { label: "State", meaning: "A rounded box names a state of the system." },
  initial: { label: "Start", meaning: "A filled dot marks where this state machine begins." },
  final: { label: "End", meaning: "A dot inside a ring marks where this state machine finishes." },
  choice: { label: "Choice", meaning: "A diamond is a choice between outgoing transitions." },
  fork: { label: "Fork", meaning: "A bar splits a transition into parallel paths." },
  join: { label: "Join", meaning: "A bar brings parallel paths together." },
};
const CARDINALITIES: Record<Cardinality, KeyEntry> = {
  "exactly-one": { label: "Exactly one", meaning: "Two bars at a relationship end mean exactly one related entity." },
  "zero-or-one": { label: "Zero or one", meaning: "A circle and a bar mean zero or one related entity." },
  "one-or-more": { label: "One or more", meaning: "A bar and a crow's foot mean one or more related entities." },
  "zero-or-more": { label: "Zero or more", meaning: "A circle and a crow's foot mean zero or more related entities." },
};
const KEYS: Record<AttributeKey, string> = {
  PK: "Primary key identifies a row.",
  FK: "Foreign key refers to another entity's key.",
  UK: "Unique key requires distinct values.",
};

const C4_KINDS: Record<C4ElementKind, string> = {
  person: "Person",
  system: "System",
  container: "Container",
  component: "Component",
};
const BOUNDARIES: Record<C4BoundaryKind, string> = {
  enterprise: "Enterprise boundary",
  system: "System boundary",
  container: "Container boundary",
  generic: "Boundary",
};
const MESSAGES: Record<"sync" | "reply" | "async", KeyEntry> = {
  sync: { label: "Call", meaning: "A solid line with a filled arrowhead is a synchronous message to the receiver." },
  reply: { label: "Reply", meaning: "A dashed line with an open arrowhead is a reply to the receiver." },
  async: {
    label: "Async message",
    meaning: "A solid line with an open arrowhead is an asynchronous message to the receiver.",
  },
};
const FRAGMENTS: Record<"loop" | "alt" | "opt" | "par", string> = {
  loop: "repeated steps",
  alt: "alternative paths",
  opt: "optional steps",
  par: "parallel paths",
};

const PATTERN_LABEL: Readonly<Record<"dotted" | "dashed" | "dashdot" | "thick", string>> = {
  dotted: "Dotted line",
  dashed: "Dashed line",
  dashdot: "Dash-dot line",
  thick: "Thick line",
};

/**
 * The line patterns drawn in a graph view, each with what its author says it
 * means (ADR 0030), in the order the patterns are listed. A notation that
 * gives its own dashes a meaning (ER) has none of the author's. `null` means
 * the source states no meaning: Archer never supplies one.
 */
export function authoredLineKey(
  edges: readonly { readonly line?: string }[],
  lineKey: readonly LineKeyEntry[] | undefined,
  notation: string | undefined,
): { readonly pattern: "dotted" | "dashed" | "dashdot" | "thick"; readonly meaning: string | null }[] {
  if (notation === "er") return [];
  const used = new Set(
    edges
      .map((edge) => edge.line)
      .filter((line): line is "dotted" | "dashed" | "dashdot" | "thick" => line !== undefined && line !== "solid"),
  );
  const meaning = new Map((lineKey ?? []).map((entry) => [entry.pattern, entry.meaning]));
  return (["dotted", "dashed", "dashdot", "thick"] as const)
    .filter((pattern) => used.has(pattern))
    .map((pattern) => ({ pattern, meaning: meaning.get(pattern) ?? null }));
}

/** A Key row's label: the pattern and, visible without opening the key, what it means. */
export function authoredLineLabel(row: {
  readonly pattern: keyof typeof PATTERN_LABEL;
  readonly meaning: string | null;
}): string {
  return `${PATTERN_LABEL[row.pattern]}: ${row.meaning ?? "meaning not stated"}`;
}

/**
 * The key of what is drawn. In the nested view a closed boundary hides its insides, so the key is
 * built from the view on screen; anything else is keyed from the model as drawn.
 */
export function keyOfDrawing(model: KeyModel, nestedView: ProjectedView | null): KeyModel {
  return nestedView === null || model.type !== "graph" ? model : { type: "graph", view: nestedView };
}

/** Maps projected production figures to explanations, without inferring domain meaning from a shape. */
export function diagramKeyEntries(
  model: KeyModel,
  { omitLinePatterns = false }: { omitLinePatterns?: boolean } = {},
): readonly KeyEntry[] {
  const entries = new Map<string, KeyEntry>();
  const add = (id: string, label: string, meaning: string): void => {
    entries.set(id, { label, meaning });
  };
  const entry = (id: string, value: KeyEntry): void => add(id, value.label, value.meaning);
  if (model.type === "journey") {
    if (model.view.sections.some((s) => s.tasks.length > 0)) {
      add(
        "score",
        "Satisfaction score",
        "Filled dots and the number show satisfaction: 1 is least satisfied; 5 is most satisfied.",
      );
      add(
        "rail",
        "Score rail",
        "The left rail repeats the score: dashed for 1–2, thin for 3, thick for 4–5. It does not identify an actor.",
      );
    }
    if (model.view.actors.length > 0)
      add("actors", "Actors", "Named chips identify who takes part in each task; a task can have more than one actor.");
    if (model.view.sections.length > 0)
      add("sections", "Sections", "Frames group tasks into stages, in the order written in the diagram.");
  } else if (model.type === "sequence") {
    if (model.view.participants.length > 0)
      add(
        "lifeline",
        "Lifelines",
        "Participants run across the top; dashed vertical lines follow them through time. Read messages from top to bottom.",
      );
    if (model.view.participants.some((p) => p.kind === "actor"))
      add("actor", "Actor", "The person symbol identifies a participant declared as an actor.");
    for (const event of eachSequenceEvent(model.view.events)) {
      switch (event.type) {
        case "message":
          entry(`message:${event.kind}`, MESSAGES[event.kind]);
          break;
        case "fragment":
          add(
            `fragment:${event.kind}`,
            event.kind,
            `A labelled frame groups ${FRAGMENTS[event.kind]}; section labels give their conditions.`,
          );
          break;
        case "activate":
        case "deactivate":
          add("activation", "Activation", "A narrow bar on a lifeline marks an explicitly activated period.");
          break;
        case "note":
          add("note", "Note", "A folded-corner sheet contains a note about the named participants.");
          break;
      }
    }
    if (model.view.autonumber === true)
      add("numbers", "Message numbers", "Numbers follow the message order in the diagram.");
  } else {
    const view = model.view;
    const notation = view.notation ?? "flowchart";
    for (const node of view.nodes) {
      const figure = node.figure;
      // A plain outline (rectangle, diamond, capsule...) says nothing a reader needs a key for:
      // only a kind the source declares carries meaning.
      if (figure === undefined) {
        for (const kind of node.classes)
          if (Object.hasOwn(C4_KINDS, kind) || kind === "database" || kind === "external")
            add(
              `kind:${kind}`,
              kind[0].toUpperCase() + kind.slice(1),
              `The source marks this node as ${kind === "external" ? "outside the system" : `a ${kind}`}.`,
            );
      } else
        switch (figure.type) {
          case "state":
            entry(`state:${figure.kind}`, STATES[figure.kind]);
            if (figure.note)
              add(
                "note",
                "State note",
                "A sheet beside a state provides a note; its dashed tie attaches it to that state.",
              );
            break;
          case "entity":
            add("entity", "Entity table", "The title names an entity; rows list attribute types and names.");
            for (const attribute of figure.attributes)
              for (const key of attribute.keys) add(`key:${key}`, key, KEYS[key]);
            break;
          case "c4": {
            add(
              `c4:${figure.kind}`,
              C4_KINDS[figure.kind],
              figure.kind === "person"
                ? "The person symbol represents a person or role using the system."
                : `The bracketed type identifies a ${figure.kind}; technology and description appear when supplied.`,
            );
            if (figure.external)
              add(
                "external",
                "External",
                "A dashed element outline identifies a person or system outside the modelled system.",
              );
            if (figure.shape === "database")
              add("database", "Database", "The cylinder outline identifies a data store.");
            if (figure.shape === "queue")
              add(
                "queue",
                "Queue",
                "The queue outline identifies a message queue; read its label and type line for the technology.",
              );
            break;
          }
          case "service":
            if (figure.icon)
              add(
                `icon:${figure.icon}`,
                `${ICONS[figure.icon]} icon`,
                "The icon is the service type chosen in the source; its label names the service.",
              );
            else add("service", "Service", "A box names a service; the source supplies no icon.");
            break;
          case "junction":
            add("junction", "Junction", "A small connection point joins architecture links.");
            break;
        }
    }
    for (const group of view.groups) {
      switch (group.figure?.type) {
        case "composite":
          add(
            "composite",
            "Composite state",
            "A frame encloses a state's inner state machine. Entering it starts its nested flow; it is not a deployment boundary.",
          );
          break;
        case "boundary":
          add(
            `boundary:${group.figure.kind}`,
            BOUNDARIES[group.figure.kind],
            "The labelled frame encloses elements belonging to that boundary; nested frames show containment.",
          );
          break;
        case "zone":
          add(
            "group",
            "Architecture group",
            "A labelled frame groups services. Nested frames show containment; shading is only structure, not status.",
          );
          if (group.figure.icon)
            add(
              `icon:${group.figure.icon}`,
              `${ICONS[group.figure.icon]} icon`,
              "The icon is the group type chosen in the source.",
            );
          break;
        // A plain group is a labelled frame round its members: the drawing says that plainly, and a row
        // restating it was the export's whole notation box on a coloured drawing (owner, 2026-11-12). A group's
        // colour has its own row (`palette-key.ts`).
      }
    }
    for (const edge of view.edges) {
      if (edge.figure?.type === "cardinality") {
        entry(`cardinality:${edge.figure.source}`, CARDINALITIES[edge.figure.source]);
        entry(`cardinality:${edge.figure.target}`, CARDINALITIES[edge.figure.target]);
        add(
          `relationship:${edge.line ?? "solid"}`,
          edge.line === "dotted" ? "Non-identifying relationship" : "Identifying relationship",
          edge.line === "dotted"
            ? "A dashed relationship is non-identifying; end marks give cardinality, not direction."
            : "A solid relationship is identifying; end marks give cardinality, not direction.",
        );
      } else {
        // Arrowheads need no key; a link without any does.
        if (edge.figure?.type === "ports" && !edge.figure.sourceArrow && !edge.figure.targetArrow)
          add("link", "Undirected link", "A link without arrowheads connects services without declaring a direction.");
      }
    }
    if (!omitLinePatterns)
      for (const row of authoredLineKey(view.edges, view.lineKey, notation))
        add(
          `line:${row.pattern}`,
          authoredLineLabel(row),
          row.meaning === null
            ? "The source draws this pattern without saying what it means (no `%% archer-key`)."
            : "What the diagram's author says this line pattern means.",
        );
  }
  return [...entries.values()];
}
