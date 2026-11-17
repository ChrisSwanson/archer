// The emphasis wire, written down once and read from both sides: this test
// asserts the service still produces fixtures/protocol/emphasis-wire.json, and
// ui/tests/emphasis-wire.test.ts asserts the page still understands it. The
// fixture was recorded from the Rust 0.3 server and re-recorded for ADR 0030;
// a diff here is a wire change.
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import type { GraphModel } from "../../src/model/index.ts";
import { addressable, EmphasisStore, parseEmphasis } from "../../src/service/emphasis.ts";

const FIXTURE = new URL("../../../fixtures/protocol/emphasis-wire.json", import.meta.url);

const GRAPH: GraphModel = {
  type: "freeform-graph",
  nodes: [
    { id: "web", label: "Web" },
    { id: "api", label: "API" },
  ],
  edges: [{ id: "calls", source: "web", target: "api" }],
  groups: [],
};

// Every slot, every speed, and both spellings of every optional field. Since
// ADR 0030 the agent sends no palette or state: the wire's are derived from
// each group's position, so a page from before the change still draws.
const PAYLOADS = [
  {
    id: "slots",
    viewId: "ctx",
    title: "Every slot",
    groups: [
      { id: "first", style: "highlight", label: "First", nodes: ["web"] },
      { id: "second", style: "highlight", label: "Second", nodes: ["api"] },
      { id: "third", style: "highlight", label: "Third", edges: ["calls"] },
    ],
  },
  {
    id: "speeds",
    viewId: "ctx",
    groups: [
      { id: "slow", style: "flow", label: "Slow", speed: "slow", edges: ["calls"] },
      { id: "normal", style: "flow", label: "Normal", speed: "normal", nodes: ["web"] },
      { id: "fast", style: "flow", label: "Fast", speed: "fast", nodes: ["api"] },
    ],
  },
  { id: "unpaced", viewId: "ctx", groups: [{ id: "unpaced", style: "flow", label: "Unpaced", edges: ["calls"] }] },
  {
    id: "texts",
    viewId: "ctx",
    title: "Now and proposed",
    groups: [
      {
        id: "now",
        style: "highlight",
        label: "What is there now",
        description: "Both optional strings present.",
        nodes: ["web"],
      },
      { id: "proposed", style: "highlight", label: "Refund queue (proposed)", nodes: ["api"] },
    ],
  },
];

test("the served emphasis payload is the one in the shared fixture", () => {
  const known = addressable(GRAPH);
  const store = new EmphasisStore();
  for (const raw of PAYLOADS) {
    const parsed = parseEmphasis(raw, "ctx", known);
    if (!parsed.ok) throw new Error(`refused: ${JSON.stringify(parsed.issues)}`);
    store.apply(parsed.emphasis, known);
  }
  const served = JSON.parse(JSON.stringify(store.payload("ctx"))) as unknown;
  if (process.env["ARCHER_RECORD_WIRE"] === "1") writeFileSync(FIXTURE, `${JSON.stringify(served, null, 2)}\n`);
  expect(served).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
});
