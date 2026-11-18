// @vitest-environment jsdom
//
// Every value the contract can send is drawn as itself.
//
// The implementation plan's section 12.2, row U3. The other drawing tests
// enumerate the UI's OWN lists (`NODE_SHAPES`, `EDGE_LINES`, ...), so a value
// added to the contract and to no list here was invisible to all of them: it
// would validate, reach the canvas, and be drawn as whatever the fallback is.
//
// This one starts from the contract. It reads `schema/diagram-envelope.schema.json`
// -- the file Rust generates and the page validates against -- finds every
// closed vocabulary in it, and for each VALUE of each one sends a schema-valid
// envelope down the production path (validate -> project -> lay out -> draw)
// and reads back what was drawn. The table below says what each value must
// look like. The test fails when:
//
//   - the schema has a vocabulary the table has no entry for;
//   - a vocabulary has a value the table has no row for (or the table names a
//     value the schema has dropped);
//   - a value is not drawn as its row says;
//   - two values of one vocabulary are drawn the same, which is what a value
//     falling through to a default looks like.
//
// jsdom lays nothing out and paints nothing: what is read back is the markup
// the canvas produced and the rules the stylesheet on disk holds for it. What
// those look like on screen is the browser suite's (`geometry.e2e.ts` draws
// every shape, class, line and sequence construct in both designs).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DiagramCanvas, type CanvasState } from "../src/diagrams/DiagramCanvas";
import { projectEnvelope } from "../src/diagrams/projection";
import { kindLabel } from "../src/app/inventory";
import { computeLayout } from "../src/layout/elk-adapter";
import { computeSequenceLayout } from "../src/layout/sequence-layout";
import { declarationsOf, readStylesheet, rulesOf } from "./stylesheet";

afterEach(cleanup);

// ---- the contract, read from the files that state it ------------------------

type JsonSchema = {
  $defs: Record<string, { enum?: string[]; oneOf?: { properties?: Record<string, { const?: string }> }[] }>;
};
const schema = JSON.parse(
  readFileSync(resolve(process.cwd(), "../schema/diagram-envelope.schema.json"), "utf8"),
) as JsonSchema;

/** Every closed vocabulary the schema declares: its `enum`s, and the `type` tags of its unions. */
function vocabularies(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const [name, definition] of Object.entries(schema.$defs)) {
    if (definition.enum !== undefined) {
      found[name] = definition.enum;
    }
    const tags = (definition.oneOf ?? []).flatMap((variant) => {
      const tag = variant.properties?.type?.const;
      return tag === undefined ? [] : [tag];
    });
    if (tags.length > 0) {
      found[`${name}.type`] = tags;
    }
  }
  return found;
}

/**
 * The semantic classes. NOT in the schema, which types `classes` as free
 * strings: the closed list is the parser's, and the document that states it is
 * `ts/docs/supported-mermaid.md` ("The six built-in kinds are ...").
 * Read from there, so a class added to the profile with no drawing fails here.
 */
function semanticClasses(): string[] {
  const doc = readFileSync(resolve(process.cwd(), "../ts/docs/supported-mermaid.md"), "utf8").replace(/\s+/g, " ");
  const sentence = /The six built-in kinds are (.+?)\. A node gets one/.exec(doc);
  if (sentence === null) {
    throw new Error("ts/docs/supported-mermaid.md no longer states the built-in kinds in the sentence this test reads");
  }
  return [...sentence[1].matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

// ---- drawing one value through the production path ----------------------------

const REVISION = `sha256:${"e".repeat(64)}`;

type GraphNode = { id: string; label: string; shape?: string; classes?: string[] };
type GraphEdge = { id: string; source: string; target: string; line?: string };

function graphEnvelope(options: {
  kind?: string;
  type?: string;
  direction?: string;
  nodes?: GraphNode[];
  edges?: GraphEdge[];
}): unknown {
  return {
    schemaVersion: 2,
    view: { id: "contract", kind: options.kind ?? "freeform", title: "Contract" },
    revision: REVISION,
    model: {
      type: options.type ?? "freeform-graph",
      ...(options.direction === undefined ? {} : { direction: options.direction }),
      nodes: options.nodes ?? [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
      ],
      edges: options.edges ?? [{ id: "e", source: "a", target: "b" }],
      groups: [],
    },
  };
}

function sequenceEnvelope(events: unknown[], participants?: unknown[]): unknown {
  return {
    schemaVersion: 2,
    view: { id: "contract", kind: "sequence", title: "Contract" },
    revision: REVISION,
    model: {
      type: "sequence-trace",
      participants: participants ?? [
        { id: "p", label: "Client" },
        { id: "q", label: "Server" },
      ],
      events,
    },
  };
}

const MESSAGE = { type: "message", id: "msg-0", from: "p", to: "q", kind: "sync", label: "call" };

/** Two entities, `a` (with `attributes`) and `b`, and the relationships given. */
function erEnvelope(attributes: Record<string, unknown>[], relationships: Record<string, unknown>[] = []): unknown {
  return {
    schemaVersion: 2,
    view: { id: "contract", kind: "entity-relationship", title: "Contract" },
    revision: REVISION,
    model: {
      type: "entity-relationship",
      entities: [
        { id: "a", label: "Alpha", attributes },
        { id: "b", label: "Beta", attributes: [] },
      ],
      relationships,
    },
  };
}

/** A C4 model of the given elements (plus `p`, a person) and boundaries. */
function c4Envelope(
  options: {
    level?: string;
    title?: string;
    elements?: Record<string, unknown>[];
    boundaries?: Record<string, unknown>[];
  } = {},
): unknown {
  const elements = [
    { id: "p", kind: "person", label: "Person" },
    ...(options.elements ?? [{ id: "q", kind: "system", label: "System" }]),
  ];
  return {
    schemaVersion: 2,
    view: { id: "contract", kind: "c4", title: "Contract" },
    revision: REVISION,
    model: {
      type: "c4-model",
      level: options.level ?? "context",
      ...(options.title === undefined ? {} : { title: options.title }),
      elements,
      boundaries: options.boundaries ?? [],
      relationships: [{ id: "p--q", source: "p", target: elements[1].id }],
    },
  };
}

/** Two services joined by one edge with the given sides. */
function architectureEnvelope(
  options: { icon?: string; sourceSide?: string; targetSide?: string; groupIcon?: string } = {},
): unknown {
  return {
    schemaVersion: 2,
    view: { id: "contract", kind: "architecture", title: "Contract" },
    revision: REVISION,
    model: {
      type: "service-architecture",
      groups: options.groupIcon === undefined ? [] : [{ id: "g", label: "Group", icon: options.groupIcon }],
      services: [
        {
          id: "a",
          label: "Alpha",
          ...(options.icon === undefined ? {} : { icon: options.icon }),
          ...(options.groupIcon === undefined ? {} : { groupId: "g" }),
        },
        { id: "b", label: "Beta" },
      ],
      junctions: [],
      edges: [
        {
          id: "a--b",
          source: "a",
          target: "b",
          sourceSide: options.sourceSide ?? "right",
          targetSide: options.targetSide ?? "left",
        },
      ],
    },
  };
}

/** What a model of each newer type is drawn as, by the class family its nodes wear. */
const FIGURE_WORDS: Readonly<Record<string, string>> = {
  state: "states",
  entity: "entities",
  c4: "C4 elements",
  service: "services",
};

/** A state machine of the given states (plus `s`, a plain state) and transitions. */
function stateEnvelope(states: Record<string, unknown>[], transitions: Record<string, unknown>[] = []): unknown {
  return {
    schemaVersion: 2,
    view: { id: "contract", kind: "state", title: "Contract" },
    revision: REVISION,
    model: { type: "state-machine", states: [{ id: "s", label: "Plain" }, ...states], transitions },
  };
}

/** Validates, projects, lays out and draws an envelope: the path a presentation takes. */
async function draw(envelope: unknown): Promise<{ container: HTMLElement; state: CanvasState }> {
  const projection = projectEnvelope(envelope);
  if (!projection.ok) {
    throw new Error(`the contract refused this envelope: ${projection.errors.map((e) => e.message).join("; ")}`);
  }
  const state: CanvasState =
    projection.type === "sequence"
      ? { status: "sequence-ready", sequenceLayout: computeSequenceLayout(projection.view) }
      : projection.type === "journey"
        ? { status: "journey-ready", journey: projection.view }
        : { status: "ready", layout: await computeLayout(projection.view) };
  const { container } = render(
    <div style={{ width: 1200, height: 800 }}>
      <DiagramCanvas state={state} />
    </div>,
  );
  if (projection.type === "graph") {
    // React Flow draws an edge once both its nodes have mounted and been
    // measured, which is a commit after the nodes themselves.
    const edges = projection.view.edges.length;
    await waitFor(() => expect(container.querySelectorAll(".react-flow__edge")).toHaveLength(edges));
  }
  return { container, state };
}

const rules = rulesOf(readStylesheet());
/** The properties the stylesheet sets in rules whose selector mentions `fragment`. */
function styledBy(fragment: string): string[] {
  return [
    ...new Set(
      rules
        .filter((rule) => rule.selectors.some((selector) => selector.includes(fragment)))
        .flatMap((rule) => declarationsOf(rule.body).map(([property]) => property)),
    ),
  ];
}

/** The one class of `element` that starts with `prefix`, or "" for none. */
const classWith = (element: Element | null, prefix: string): string =>
  [...(element?.classList ?? [])].find((name) => name.startsWith(prefix)) ?? "";

// ---- what each value must be drawn as -----------------------------------------

type Vocabulary = {
  /** What each value of the vocabulary must read back as. */
  readonly expected: Readonly<Record<string, string>>;
  /** Draws one value and reads back what distinguishes it. */
  readonly drawn: (value: string) => Promise<string>;
};

/** The view kind each model type is the model OF: the page refuses any other pairing. */
const KIND_FOR_MODEL: Readonly<Record<string, string>> = {
  "architecture-graph": "c4-context",
  "data-flow-graph": "data-flow",
  "freeform-graph": "freeform",
};

const TABLE: Readonly<Record<string, Vocabulary>> = {
  NodeShape: {
    // The outline class the node wears, which the stylesheet must draw from.
    expected: {
      rectangle: "archer-shape-rectangle styled",
      rounded: "archer-shape-rounded styled",
      stadium: "archer-shape-stadium styled",
      circle: "archer-shape-circle styled",
      diamond: "archer-shape-diamond styled",
      cylinder: "archer-shape-cylinder styled",
      hexagon: "archer-shape-hexagon styled",
      subroutine: "archer-shape-subroutine styled",
    },
    drawn: async (shape) => {
      const { container } = await draw(graphEnvelope({ nodes: [{ id: "a", label: "Alpha", shape }], edges: [] }));
      const outline = classWith(container.querySelector('.react-flow__node[data-id="a"]'), "archer-shape-");
      return `${outline} ${styledBy(`.${outline}`).length > 0 ? "styled" : "UNSTYLED"}`;
    },
  },

  EdgeLine: {
    // The line class the edge wears, and the stroke property its rule changes.
    expected: {
      solid: "archer-line-solid: the base stroke",
      dotted: "archer-line-dotted: stroke-dasharray",
      thick: "archer-line-thick: stroke-width",
      dashed: "archer-line-dashed: stroke-dasharray",
      dashdot: "archer-line-dashdot: stroke-dasharray",
    },
    drawn: async (line) => {
      const { container } = await draw(graphEnvelope({ edges: [{ id: "e", source: "a", target: "b", line }] }));
      const worn = classWith(container.querySelector('.react-flow__edge[data-id="e"]'), "archer-line-");
      const changed = styledBy(`.${worn} .react-flow__edge-path`).filter((property) => property.startsWith("stroke-"));
      return `${worn}: ${changed.length === 0 ? "the base stroke" : changed.sort().join(", ")}`;
    },
  },

  Direction: {
    // Where the target of `a --> b` is laid out relative to its source.
    expected: { tb: "below", bt: "above", lr: "to the right", rl: "to the left" },
    drawn: async (direction) => {
      const { state } = await draw(graphEnvelope({ direction }));
      if (state.status !== "ready") throw new Error("a graph was not laid out as a graph");
      const at = (id: string) => state.layout.nodes.find((node) => node.id === id)!;
      const dx = at("b").x - at("a").x;
      const dy = at("b").y - at("a").y;
      return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "to the right" : "to the left") : dy > 0 ? "below" : "above";
    },
  },

  DiagramKind: {
    // The caption the tab shows beside the title. `freeform` has none by
    // design: it is the kind that claims no notation.
    expected: {
      "c4-context": "Context",
      "c4-container": "Containers",
      "c4-component": "Components",
      "c4-code": "Code",
      "data-flow": "Data flow",
      sequence: "Sequence",
      freeform: "no caption",
      state: "State",
      "entity-relationship": "Entities",
      c4: "C4",
      architecture: "Architecture",
      journey: "Journey",
    },
    drawn: async (kind) => kindLabel(kind) ?? "no caption",
  },

  "DiagramModel.type": {
    // Which canvas draws the model.
    expected: {
      "architecture-graph": "graph canvas",
      "data-flow-graph": "graph canvas",
      "freeform-graph": "graph canvas",
      "sequence-trace": "sequence canvas",
      "state-machine": "graph canvas, drawn as states",
      "entity-relationship": "graph canvas, drawn as entities",
      "c4-model": "graph canvas, drawn as C4 elements",
      "service-architecture": "graph canvas, drawn as services",
      "user-journey": "journey canvas",
    },
    drawn: async (type) => {
      const envelopes: Record<string, () => unknown> = {
        "sequence-trace": () => sequenceEnvelope([MESSAGE]),
        "state-machine": () => stateEnvelope([{ id: "t", label: "Other" }], [{ id: "s--t", source: "s", target: "t" }]),
        "entity-relationship": () =>
          erEnvelope(
            [],
            [
              {
                id: "a--b",
                source: "a",
                target: "b",
                sourceCardinality: "exactly-one",
                targetCardinality: "zero-or-more",
                identifying: true,
              },
            ],
          ),
        "c4-model": () => c4Envelope(),
        "service-architecture": () => architectureEnvelope(),
        "user-journey": () => ({
          schemaVersion: 2,
          view: { id: "contract", kind: "journey", title: "Contract" },
          revision: REVISION,
          model: {
            type: "user-journey",
            actors: [],
            sections: [{ id: "section-s", label: "S", tasks: [{ id: "t", label: "T", score: 3, actors: [] }] }],
          },
        }),
      };
      const { container } = await draw(
        (envelopes[type] ?? (() => graphEnvelope({ type, kind: KIND_FOR_MODEL[type] ?? "freeform" })))(),
      );
      const graph = container.querySelectorAll(".react-flow__node.archer-node").length;
      const sequence = container.querySelectorAll(".archer-seq-participant").length;
      if (container.querySelectorAll("[data-journey-id]").length === 2 && graph === 0 && sequence === 0)
        return "journey canvas";
      // What a figure is drawn as, by the class family it wears.
      const figures = Object.keys(FIGURE_WORDS).filter(
        (figure) => container.querySelectorAll(`.react-flow__node.archer-figure-${figure}`).length === graph,
      );
      if (graph === 2 && sequence === 0)
        return figures.length === 0 ? "graph canvas" : `graph canvas, drawn as ${FIGURE_WORDS[figures[0]]}`;
      return sequence === 2 && graph === 0 ? "sequence canvas" : "NOT DRAWN";
    },
  },

  StateKind: {
    // The class the state wears, which the stylesheet must draw from, and
    // whether its name is written in it (the pseudo-states are their shape).
    expected: {
      state: "archer-state-state styled, named",
      initial: "archer-state-initial styled, unnamed",
      final: "archer-state-final styled, unnamed",
      choice: "archer-state-choice styled, unnamed",
      fork: "archer-state-fork styled, unnamed",
      join: "archer-state-join styled, unnamed",
    },
    drawn: async (kind) => {
      const { container } = await draw(
        stateEnvelope([{ id: "k", label: "Kind", kind }], [{ id: "s--k", source: "s", target: "k" }]),
      );
      const drawn = classWith(container.querySelector('.react-flow__node[data-id="k"]'), "archer-state-");
      const named = container.querySelector('.react-flow__node[data-id="k"]')?.textContent?.includes("Kind") === true;
      return `${drawn} ${styledBy(`.${drawn}`).length > 0 ? "styled" : "UNSTYLED"}, ${named ? "named" : "unnamed"}`;
    },
  },

  Cardinality: {
    // The marks at the end of the wire, read outward from the entity.
    expected: {
      "exactly-one": "archer-er-exactly-one: 2 bars, no ring, no foot",
      "zero-or-one": "archer-er-zero-or-one: 1 bar, a ring, no foot",
      "one-or-more": "archer-er-one-or-more: 1 bar, no ring, a foot",
      "zero-or-more": "archer-er-zero-or-more: 0 bars, a ring, a foot",
    },
    drawn: async (cardinality) => {
      const { container } = await draw(
        erEnvelope(
          [],
          [
            {
              id: "a--b",
              source: "a",
              target: "b",
              sourceCardinality: "exactly-one",
              targetCardinality: cardinality,
              identifying: true,
            },
          ],
        ),
      );
      const mark = container.querySelector('.react-flow__edge[data-id="a--b"] .archer-er-mark[data-end="target"]');
      if (mark === null) return "NOT DRAWN";
      const bars = mark.querySelectorAll("line").length;
      const ring = mark.querySelector("circle") !== null;
      const foot = mark.querySelector("path") !== null;
      const worn = [...mark.classList].find((name) => name.startsWith("archer-er-") && name !== "archer-er-mark") ?? "";
      return `${worn}: ${bars} ${bars === 1 ? "bar" : "bars"}, ${ring ? "a ring" : "no ring"}, ${foot ? "a foot" : "no foot"}`;
    },
  },

  AttributeKey: {
    // The key's own word, in a chip whose class the stylesheet draws.
    expected: {
      PK: "PK in archer-er-key-PK styled",
      FK: "FK in archer-er-key-FK styled",
      UK: "UK in archer-er-key-UK styled",
    },
    drawn: async (key) => {
      const { container } = await draw(erEnvelope([{ name: "id", type: "int", keys: [key] }]));
      const chip = container.querySelector('.react-flow__node[data-id="a"] .archer-er-key');
      if (chip === null) return "NOT DRAWN";
      const drawn = classWith(chip, "archer-er-key-");
      return `${chip.textContent} in ${drawn} ${styledBy(`.${drawn}`).length > 0 ? "styled" : "UNSTYLED"}`;
    },
  },

  C4ElementKind: {
    // The word on the type line, the class the stylesheet draws from, and
    // the figure only a person carries.
    expected: {
      person: "[Person] archer-c4-person styled, with the figure",
      system: "[System] archer-c4-system styled",
      container: "[Container] archer-c4-container styled",
      component: "[Component] archer-c4-component styled",
    },
    drawn: async (kind) => {
      const { container } = await draw(c4Envelope({ elements: [{ id: "q", kind, label: "Element" }] }));
      const element = container.querySelector('.react-flow__node[data-id="q"]');
      const worn = `archer-c4-${kind}`;
      if (element === null || !element.classList.contains(worn)) return "NOT DRAWN";
      const figure = element.querySelector(".archer-c4-person-glyph") === null ? "" : ", with the figure";
      return `${element.querySelector(".archer-c4-type")?.textContent} ${worn} ${styledBy(`.${worn}`).length > 0 ? "styled" : "UNSTYLED"}${figure}`;
    },
  },

  C4ElementShape: {
    // The outline: a database is the flowchart's cylinder, a queue a box with message slots.
    expected: {
      database: "[System database] archer-shape-cylinder, archer-c4-shape-database styled",
      queue: "[System queue] archer-shape-rectangle, archer-c4-shape-queue styled",
    },
    drawn: async (shape) => {
      const { container } = await draw(c4Envelope({ elements: [{ id: "q", kind: "system", label: "Store", shape }] }));
      const element = container.querySelector('.react-flow__node[data-id="q"]');
      const worn = `archer-c4-shape-${shape}`;
      if (element === null || !element.classList.contains(worn)) return "NOT DRAWN";
      return `${element.querySelector(".archer-c4-type")?.textContent} ${classWith(element, "archer-shape-")}, ${worn} ${styledBy(`.${worn}`).length > 0 ? "styled" : "UNSTYLED"}`;
    },
  },

  C4BoundaryKind: {
    // The frame's caption word, and the class its rule is drawn from.
    expected: {
      enterprise: "[Enterprise] archer-boundary-enterprise styled",
      system: "[System] archer-boundary-system styled",
      container: "[Container] archer-boundary-container styled",
      generic: "[Boundary] archer-boundary-generic styled",
    },
    drawn: async (kind) => {
      const { container } = await draw(
        c4Envelope({
          elements: [{ id: "q", kind: "system", label: "Inside", boundaryId: "b" }],
          boundaries: [{ id: "b", kind, label: "Frame" }],
        }),
      );
      const frame = container.querySelector('.react-flow__node[data-id="b"]');
      const worn = `archer-boundary-${kind}`;
      if (frame === null || !frame.classList.contains(worn)) return "NOT DRAWN";
      return `${frame.querySelector(".archer-frame-kind")?.textContent} ${worn} ${styledBy(`.${worn}`).length > 0 ? "styled" : "UNSTYLED"}`;
    },
  },

  C4Level: {
    // The heading over the canvas, which says which level the diagram draws.
    expected: {
      context: "Shop · C4 context diagram",
      container: "Shop · C4 container diagram",
      component: "Shop · C4 component diagram",
    },
    drawn: async (level) => {
      const { container } = await draw(c4Envelope({ level, title: "Shop" }));
      return container.querySelector(".archer-canvas-heading")?.textContent ?? "NOT DRAWN";
    },
  },

  ArchitectureIcon: {
    // The pictogram drawn in the service, and in a group's caption.
    expected: {
      cloud: "archer-arch-icon-cloud in the service and the group",
      database: "archer-arch-icon-database in the service and the group",
      disk: "archer-arch-icon-disk in the service and the group",
      internet: "archer-arch-icon-internet in the service and the group",
      server: "archer-arch-icon-server in the service and the group",
    },
    drawn: async (icon) => {
      const { container } = await draw(architectureEnvelope({ icon, groupIcon: icon }));
      const inService = container.querySelector(`.react-flow__node[data-id="a"] .archer-arch-icon-${icon}`);
      const inGroup = container.querySelector(
        `.react-flow__node[data-id="g"] .archer-frame-caption .archer-arch-icon-${icon}`,
      );
      if (inService === null || inGroup === null || inService.innerHTML === "") return "NOT DRAWN";
      return `archer-arch-icon-${icon} in the service and the group`;
    },
  },

  ArchitectureSide: {
    // The side of the source the laid-out wire leaves by.
    expected: {
      left: "leaves by the left",
      right: "leaves by the right",
      top: "leaves by the top",
      bottom: "leaves by the bottom",
    },
    drawn: async (side) => {
      const { state } = await draw(architectureEnvelope({ sourceSide: side, targetSide: "left" }));
      if (state.status !== "ready") throw new Error("an architecture was not laid out as a graph");
      const source = state.layout.nodes.find((node) => node.id === "a")!;
      const start = state.layout.edges.find((edge) => edge.id === "a--b")!.points[0];
      const near = (a: number, b: number) => Math.abs(a - b) <= 1.5;
      if (near(start.x, source.x)) return "leaves by the left";
      if (near(start.x, source.x + source.width)) return "leaves by the right";
      if (near(start.y, source.y)) return "leaves by the top";
      if (near(start.y, source.y + source.height)) return "leaves by the bottom";
      return "leaves from inside";
    },
  },

  StateNotePosition: {
    // Where the note's sheet is laid out relative to its state.
    expected: { "left-of": "left of its state", "right-of": "right of its state" },
    drawn: async (position) => {
      const { container, state } = await draw(
        stateEnvelope([{ id: "n", label: "Noted", note: { position, text: "a note" } }]),
      );
      if (state.status !== "ready") throw new Error("a state machine was not laid out as a graph");
      if (container.querySelectorAll(".archer-state-note").length !== 1) return "NOT DRAWN";
      const noted = state.layout.nodes.find((node) => node.id === "n")!;
      const note = noted.note!;
      if (note.x + note.width <= noted.x) return "left of its state";
      if (note.x >= noted.x + noted.width) return "right of its state";
      return "ON its state";
    },
  },

  ParticipantKind: {
    expected: { participant: "a box", actor: "a box with the actor glyph" },
    drawn: async (kind) => {
      const { container } = await draw(
        sequenceEnvelope(
          [MESSAGE],
          [
            { id: "p", label: "Client", kind },
            { id: "q", label: "Server" },
          ],
        ),
      );
      const drawn = container.querySelector('.archer-seq-participant[data-seq-id="p"]');
      if (drawn === null) return "NOT DRAWN";
      return drawn.querySelector(".archer-seq-actor-glyph") === null ? "a box" : "a box with the actor glyph";
    },
  },

  MessageKind: {
    // The line and the arrowhead: the two marks the three kinds are told apart by.
    expected: {
      sync: "archer-seq-message--sync: solid line, filled head",
      reply: "archer-seq-message--reply: dashed line, open head",
      async: "archer-seq-message--async: solid line, open head",
    },
    drawn: async (kind) => {
      const { container } = await draw(sequenceEnvelope([{ ...MESSAGE, kind }]));
      const message = container.querySelector('.archer-seq-message[data-seq-id="msg-0"]');
      const stroke = message?.querySelector(".archer-seq-message-stroke") ?? null;
      if (message === null || stroke === null) return "NOT DRAWN";
      const dashed = stroke.querySelector("line")?.getAttribute("stroke-dasharray") != null;
      const filled = stroke.querySelector("polygon") !== null;
      return `${classWith(message, "archer-seq-message--")}: ${dashed ? "dashed" : "solid"} line, ${filled ? "filled" : "open"} head`;
    },
  },

  FragmentKind: {
    // A frame with the keyword on its chip.
    expected: {
      loop: "a frame labelled loop",
      alt: "a frame labelled alt",
      opt: "a frame labelled opt",
      par: "a frame labelled par",
    },
    drawn: async (kind) => {
      const { container } = await draw(
        sequenceEnvelope([
          {
            type: "fragment",
            id: "frag-0",
            kind,
            label: "condition",
            sections: [{ label: "condition", events: [MESSAGE] }],
          },
        ]),
      );
      const frames = container.querySelectorAll(".archer-seq-fragment rect").length;
      const chip = container.querySelector(".archer-seq-fragment-chip-text")?.textContent ?? "";
      return frames === 1 ? `a frame labelled ${chip}` : "NOT DRAWN";
    },
  },

  NotePosition: {
    // Where the sheet sits relative to the lifeline of the participant it names.
    expected: { "left-of": "left of the lifeline", "right-of": "right of the lifeline", over: "across the lifeline" },
    drawn: async (position) => {
      const { container, state } = await draw(
        sequenceEnvelope([{ type: "note", id: "note-0", position, participants: ["p"], text: "a note" }, MESSAGE]),
      );
      if (state.status !== "sequence-ready") throw new Error("a sequence was not laid out as a sequence");
      if (container.querySelectorAll(".archer-seq-note").length !== 1) return "NOT DRAWN";
      const note = state.sequenceLayout.notes[0];
      const owner = state.sequenceLayout.participants.find((participant) => participant.id === "p")!;
      const lifeline = owner.x + owner.width / 2;
      if (note.x + note.width <= lifeline) return "left of the lifeline";
      if (note.x >= lifeline) return "right of the lifeline";
      return "across the lifeline";
    },
  },

  "SequenceEvent.type": {
    // The element each kind of event puts on the canvas.
    expected: {
      message: "1 message",
      fragment: "1 fragment frame",
      note: "1 note",
      activate: "1 activation bar",
      // A deactivation draws nothing of its own: it is where the bar ENDS.
      deactivate: "the bar ends before the last message",
    },
    drawn: async (type) => {
      const second = { ...MESSAGE, id: "msg-1" };
      const third = { ...MESSAGE, id: "msg-2" };
      const events: Record<string, unknown[]> = {
        message: [MESSAGE],
        fragment: [
          { type: "fragment", id: "frag-0", kind: "opt", label: "x", sections: [{ label: "x", events: [MESSAGE] }] },
        ],
        note: [{ type: "note", id: "note-0", position: "over", participants: ["p"], text: "a note" }],
        activate: [MESSAGE, { type: "activate", participant: "q" }, second],
        deactivate: [
          MESSAGE,
          { type: "activate", participant: "q" },
          second,
          { type: "deactivate", participant: "q" },
          third,
        ],
      };
      if (!(type in events)) return "NO ENVELOPE FOR THIS EVENT";
      const { container, state } = await draw(sequenceEnvelope(events[type]));
      if (state.status !== "sequence-ready") throw new Error("a sequence was not laid out as a sequence");
      const count = (selector: string): number => container.querySelectorAll(selector).length;
      switch (type) {
        case "message":
          return `${count(".archer-seq-message")} message`;
        case "fragment":
          return `${count(".archer-seq-fragment rect")} fragment frame`;
        case "note":
          return `${count(".archer-seq-note")} note`;
        case "activate":
          return `${count(".archer-seq-activation")} activation bar`;
        default: {
          const [bar] = state.sequenceLayout.activations;
          const last = state.sequenceLayout.messages[2];
          return bar !== undefined && bar.endY < last.y ? "the bar ends before the last message" : "THE BAR NEVER ENDS";
        }
      }
    },
  },
};

/**
 * The semantic classes, held to the same table shape. A kind is told apart by
 * three marks that are not colour: its class, the word drawn over the label,
 * and a glyph of its own beside that word (checked to be its own at the foot
 * of this file). A flowchart person has no word over its label (review C.11,
 * redesign slice 4): its glyph stands beside its title instead.
 */
const SEMANTIC_CLASSES: Vocabulary = {
  expected: {
    person: "archer-kind-person, captioned none, with a glyph",
    system: "archer-kind-system, captioned system, with a glyph",
    container: "archer-kind-container, captioned container, with a glyph",
    component: "archer-kind-component, captioned component, with a glyph",
    database: "archer-kind-database, captioned database, with a glyph",
    external: "archer-kind-external, captioned external, with a glyph",
  },
  drawn: async (name) => {
    const { container } = await draw(
      graphEnvelope({ nodes: [{ id: "a", label: "Alpha", classes: [name] }], edges: [] }),
    );
    const node = container.querySelector('.react-flow__node[data-id="a"]');
    const kind = classWith(node, "archer-kind-");
    const caption = node?.querySelector(".archer-node-kind");
    const glyph = node?.querySelector(".archer-node-kind svg, .archer-node-person-glyph svg") ?? null;
    return `${kind}, captioned ${caption?.textContent ?? "none"}, ${glyph === null || glyph.innerHTML === "" ? "NO GLYPH" : "with a glyph"}`;
  },
};

/** The drawing of each kind's glyph, which must be its own. */
async function glyphOf(name: string): Promise<string> {
  const { container } = await draw(graphEnvelope({ nodes: [{ id: "a", label: "Alpha", classes: [name] }], edges: [] }));
  return (
    container.querySelector('.react-flow__node[data-id="a"] :is(.archer-node-kind, .archer-node-person-glyph) svg')
      ?.innerHTML ?? ""
  );
}

// ---- the checks ---------------------------------------------------------------

const CONTRACT = vocabularies();

describe("the table covers the contract", () => {
  it("finds the vocabularies in the schema that it expects to find", () => {
    // A guard on the reader itself: a schema reorganised so that this finds
    // nothing would otherwise pass every check below vacuously.
    expect(Object.keys(CONTRACT).length).toBeGreaterThanOrEqual(10);
    expect(CONTRACT.NodeShape).toContain("rectangle");
    expect(semanticClasses()).toContain("person");
  });

  it("has an entry for every closed vocabulary the schema declares, and for none it does not", () => {
    expect(Object.keys(TABLE).sort()).toEqual(Object.keys(CONTRACT).sort());
  });

  it.each(Object.keys(CONTRACT))("%s: has a row for every value, and for none the schema has dropped", (name) => {
    expect(Object.keys(TABLE[name]?.expected ?? {}).sort()).toEqual([...CONTRACT[name]].sort());
  });

  it("semantic classes: has a row for every class the profile supports", () => {
    expect(Object.keys(SEMANTIC_CLASSES.expected).sort()).toEqual(semanticClasses().sort());
  });
});

const CASES: { name: string; vocabulary: Vocabulary; values: string[] }[] = [
  ...Object.entries(CONTRACT).flatMap(([name, values]) =>
    TABLE[name] === undefined ? [] : [{ name, vocabulary: TABLE[name], values }],
  ),
  { name: "semantic class", vocabulary: SEMANTIC_CLASSES, values: semanticClasses() },
];

describe.each(CASES)("$name", ({ vocabulary, values }) => {
  it.each(values)("%s is drawn as itself", async (value) => {
    expect(await vocabulary.drawn(value)).toBe(vocabulary.expected[value]);
  });

  it("no value is drawn the way another value is", async () => {
    const drawn = new Map<string, string>();
    for (const value of values) {
      drawn.set(value, await vocabulary.drawn(value));
      cleanup();
    }
    const seen = new Map<string, string>();
    for (const [value, how] of drawn) {
      // The three graph models share one canvas on purpose: what tells them
      // apart is the view's kind, which has its own vocabulary above.
      if (how === "graph canvas") continue;
      expect(seen.get(how), `${value} is drawn exactly as ${seen.get(how)} is: ${how}`).toBeUndefined();
      seen.set(how, value);
    }
  });
});

describe("semantic class glyphs", () => {
  it("no two kinds share a glyph", async () => {
    const seen = new Map<string, string>();
    for (const name of semanticClasses()) {
      const glyph = await glyphOf(name);
      cleanup();
      expect(glyph, `${name} has a glyph`).not.toBe("");
      expect(seen.get(glyph), `${name} wears the glyph of ${seen.get(glyph)}`).toBeUndefined();
      seen.set(glyph, name);
    }
  });
});
