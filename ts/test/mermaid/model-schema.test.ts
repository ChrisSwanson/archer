// The TypeScript model's enumerations are the schema's, value for value, so
// the two cannot drift apart without a failing test.

import { expect, test } from "vitest";
import {
  ARCHITECTURE_ICONS,
  ARCHITECTURE_SIDES,
  ATTRIBUTE_KEYS,
  C4_BOUNDARY_KINDS,
  C4_ELEMENT_KINDS,
  C4_ELEMENT_SHAPES,
  C4_LEVELS,
  CARDINALITIES,
  DIAGRAM_KINDS,
  MODEL_TYPE_FOR_KIND,
  STATE_KINDS,
  STATE_NOTE_POSITIONS,
  DIRECTIONS,
  EDGE_LINES,
  FRAGMENT_KINDS,
  MESSAGE_KINDS,
  NODE_SHAPES,
  NOTE_POSITIONS,
  PARTICIPANT_KINDS,
  SCHEMA_VERSION,
  STABLE_ID_PATTERN,
} from "../../src/model/index.ts";
import { checkAgainst, envelopeSchema } from "./support/schema.ts";

const defs = envelopeSchema["$defs"] as Record<string, { enum?: unknown[]; properties?: Record<string, unknown> }>;

test.each([
  ["DiagramKind", DIAGRAM_KINDS],
  ["Direction", DIRECTIONS],
  ["EdgeLine", EDGE_LINES],
  ["FragmentKind", FRAGMENT_KINDS],
  ["MessageKind", MESSAGE_KINDS],
  ["NodeShape", NODE_SHAPES],
  ["NotePosition", NOTE_POSITIONS],
  ["ParticipantKind", PARTICIPANT_KINDS],
  ["StateKind", STATE_KINDS],
  ["StateNotePosition", STATE_NOTE_POSITIONS],
  ["Cardinality", CARDINALITIES],
  ["AttributeKey", ATTRIBUTE_KEYS],
  ["C4Level", C4_LEVELS],
  ["C4ElementKind", C4_ELEMENT_KINDS],
  ["C4ElementShape", C4_ELEMENT_SHAPES],
  ["C4BoundaryKind", C4_BOUNDARY_KINDS],
  ["ArchitectureIcon", ARCHITECTURE_ICONS],
  ["ArchitectureSide", ARCHITECTURE_SIDES],
] as const)("%s lists the schema's values", (name, values) => {
  expect([...values]).toEqual(defs[name]?.enum);
});

test("every kind maps to a model type the schema has, and every model type has a kind", () => {
  const model = envelopeSchema["$defs"] as Record<string, { oneOf?: { properties: { type: { const: string } } }[] }>;
  const types = (model["DiagramModel"]?.oneOf ?? []).map((variant) => variant.properties.type.const);
  expect(Object.keys(MODEL_TYPE_FOR_KIND).sort()).toEqual([...DIAGRAM_KINDS].sort());
  expect([...new Set(Object.values(MODEL_TYPE_FOR_KIND))].sort()).toEqual([...types].sort());
});

test("the stable-ID grammar is the schema's", () => {
  const node = defs["Node"]?.properties?.["id"] as { pattern: string };
  expect(STABLE_ID_PATTERN.source).toBe(node.pattern);
});

test("the schema version is the schema's", () => {
  const properties = envelopeSchema["properties"] as Record<string, { const?: unknown }>;
  expect(SCHEMA_VERSION).toBe(properties["schemaVersion"]?.const);
});

test("the checker refuses what the schema refuses", () => {
  expect(checkAgainst("DiagramModel", { type: "freeform-graph", nodes: [], edges: [], groups: [] })).toEqual([]);
  expect(checkAgainst("DiagramModel", { type: "freeform-graph", nodes: [], edges: [] })).not.toEqual([]);
  expect(
    checkAgainst("DiagramModel", {
      type: "freeform-graph",
      nodes: [{ id: "a", label: "A", colour: "red" }],
      edges: [],
      groups: [],
    }),
  ).not.toEqual([]);
  expect(checkAgainst("Node", { id: "-bad", label: "A" })).not.toEqual([]);
});
