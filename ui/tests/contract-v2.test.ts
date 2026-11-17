import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  projectEnvelope,
  type ProjectedSequence,
  type ProjectedSequenceEvent,
  type ProjectedView,
} from "../src/diagrams/projection";
import { computeSequenceLayout } from "../src/layout/sequence-layout";
import { validateEnvelope } from "../src/protocol/validate";

/**
 * Wire contract version 2 (ADR 0009), as the UI sees it: the page accepts
 * exactly version 2, and everything the widened profile adds survives
 * projection so a renderer can use it.
 *
 * The widened fixtures are what the server really emits for
 * `fixtures/*​/widened.mmd`: a Rust test compiles those sources and compares
 * the result with these same files.
 */

function fixture(name: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(`../../fixtures/protocol/valid/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function projectGraph(envelope: unknown): ProjectedView {
  const result = projectEnvelope(envelope);
  if (!result.ok) throw new Error(`rejected: ${JSON.stringify(result.errors)}`);
  if (result.type !== "graph") throw new Error("expected a graph projection");
  return result.view;
}

function projectSequence(envelope: unknown): ProjectedSequence {
  const result = projectEnvelope(envelope);
  if (!result.ok) throw new Error(`rejected: ${JSON.stringify(result.errors)}`);
  if (result.type !== "sequence") throw new Error("expected a sequence projection");
  return result.view;
}

function codes(envelope: unknown): readonly string[] {
  const result = validateEnvelope(envelope);
  return result.ok ? [] : result.errors.map((error) => error.keyword);
}

describe("schema version", () => {
  it("accepts version 2", () => {
    expect(validateEnvelope(fixture("minimal-architecture.json"))).toMatchObject({ ok: true });
    expect(projectEnvelope(fixture("minimal-architecture.json"))).toMatchObject({ ok: true });
  });

  it.each([0, 1, 3, "2"])("rejects version %j at /schemaVersion", (version) => {
    const envelope = { ...fixture("minimal-architecture.json"), schemaVersion: version };
    const result = validateEnvelope(envelope);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.instancePath)).toContain("/schemaVersion");
    }
    expect(projectEnvelope(envelope).ok).toBe(false);
  });
});

describe("graph projection carries the widened fields", () => {
  it("carries the declared direction", () => {
    expect(projectGraph(fixture("widened-freeform.json")).direction).toBe("tb");
  });

  it.each(["tb", "bt", "lr", "rl"] as const)("carries direction %s", (direction) => {
    const envelope = fixture("widened-freeform.json");
    (envelope.model as Record<string, unknown>).direction = direction;
    expect(projectGraph(envelope).direction).toBe(direction);
  });

  it("leaves the direction undefined when the model declares none", () => {
    expect(projectGraph(fixture("minimal-freeform.json")).direction).toBeUndefined();
  });

  it("rejects a direction outside the four values", () => {
    const envelope = fixture("widened-freeform.json");
    (envelope.model as Record<string, unknown>).direction = "td";
    expect(projectEnvelope(envelope).ok).toBe(false);
  });

  it("carries the widened node shapes", () => {
    const shapes = Object.fromEntries(
      projectGraph(fixture("widened-freeform.json")).nodes.map((node) => [node.id, node.shape]),
    );
    expect(shapes).toEqual({
      auth: "subroutine",
      cache: "cylinder",
      client: "stadium",
      gateway: "hexagon",
      orders: "cylinder",
    });
  });

  it("carries each edge's line, undefined meaning solid", () => {
    const lines = Object.fromEntries(
      projectGraph(fixture("widened-freeform.json")).edges.map((edge) => [edge.id, edge.line]),
    );
    expect(lines).toEqual({
      bulk: "thick",
      calls: undefined,
      checks: "thick",
      peeks: "dotted",
      reads: "dotted",
    });
  });
});

describe("sequence projection carries the widened fields", () => {
  it("carries participant kind, undefined meaning participant", () => {
    const view = projectSequence(fixture("widened-sequence.json"));
    expect(view.participants.map((p) => [p.id, p.kind])).toEqual([
      ["user", "actor"],
      ["web", undefined],
      ["api", undefined],
    ]);
  });

  it("carries autonumber, undefined meaning off", () => {
    expect(projectSequence(fixture("widened-sequence.json")).autonumber).toBe(true);
    expect(projectSequence(fixture("minimal-sequence.json")).autonumber).toBeUndefined();
  });

  it("projects note events in order, at the top level and inside fragments", () => {
    const view = projectSequence(fixture("widened-sequence.json"));

    expect(view.events[0]).toEqual({
      type: "note",
      id: "note-0",
      position: "left-of",
      participants: ["user"],
      text: "Signed out",
    });
    expect(view.events.filter((event) => event.type === "note").map((event) => event.id)).toEqual([
      "note-0",
      "note-1",
      "note-3",
    ]);

    const fragment = view.events.find((event) => event.type === "fragment");
    if (fragment?.type !== "fragment") throw new Error("expected the opt fragment");
    expect(fragment.sections[0].events[0]).toEqual({
      type: "note",
      id: "note-2",
      position: "right-of",
      participants: ["api"],
      text: "Seeds defaults",
    });
  });

  it("keeps the desugared activation shorthand as ordinary events", () => {
    const view = projectSequence(fixture("widened-sequence.json"));
    expect(view.events.slice(1, 5).map((event) => event.type)).toEqual(["message", "activate", "message", "activate"]);
  });
});

describe("note semantics", () => {
  function withEvents(events: readonly unknown[]): unknown {
    const envelope = fixture("minimal-sequence.json");
    (envelope.model as Record<string, unknown>).events = events;
    return envelope;
  }
  const note = (id: string, position: string, participants: readonly string[]) => ({
    type: "note",
    id,
    position,
    participants,
    text: "x",
  });

  it("accepts a well-formed note", () => {
    expect(codes(withEvents([note("note-0", "over", ["client", "server"])]))).toEqual([]);
  });

  it.each([
    ["an unknown participant", [note("note-0", "over", ["ghost"])], "dangling_note_participant"],
    [
      "an id shared with a message",
      [
        { type: "message", id: "note-0", from: "client", to: "server", kind: "sync" },
        note("note-0", "over", ["client"]),
      ],
      "duplicate_note_id",
    ],
    [
      "two participants beside a lifeline",
      [note("note-0", "left-of", ["client", "server"])],
      "invalid_note_participants",
    ],
    ["three participants", [note("note-0", "over", ["client", "server", "db"])], "invalid_note_participants"],
  ])("rejects %s", (_name, events, code) => {
    expect(codes(withEvents(events))).toContain(code);
  });

  it("rejects a note with no participant or an unknown position", () => {
    expect(validateEnvelope(withEvents([note("note-0", "over", [])])).ok).toBe(false);
    expect(validateEnvelope(withEvents([note("note-0", "under", ["client"])])).ok).toBe(false);
  });
});

describe("sequence layout places notes without touching messages", () => {
  function withoutNotes(events: readonly ProjectedSequenceEvent[]): ProjectedSequenceEvent[] {
    return events
      .filter((event) => event.type !== "note")
      .map((event) =>
        event.type === "fragment"
          ? {
              ...event,
              sections: event.sections.map((section) => ({
                ...section,
                events: withoutNotes(section.events),
              })),
            }
          : event,
      );
  }

  // This pinned the interim: until notes were drawn they took no space, so a
  // noted sequence laid out exactly like its stripped twin. Notes are laid out
  // now (`sequence-widened-layout.test.ts`). What still holds is that a note
  // adds a row and nothing else: the same messages, in the same order, with
  // the same numbers, and the same frames.
  it("gives notes rows of their own without disturbing what the messages are", () => {
    const view = projectSequence(fixture("widened-sequence.json"));
    const stripped = { ...view, events: withoutNotes(view.events) };
    expect(stripped.events.length).toBeLessThan(view.events.length);

    const layout = computeSequenceLayout(view);
    const bare = computeSequenceLayout(stripped);
    expect(layout.notes).toHaveLength(4);
    expect(bare.notes).toHaveLength(0);
    const identity = (l: typeof layout) => l.messages.map((m) => [m.id, m.from, m.to, m.label, m.number]);
    expect(identity(layout)).toEqual(identity(bare));
    expect(layout.messages).toHaveLength(6);
    expect(layout.fragments.map((f) => f.id)).toEqual(bare.fragments.map((f) => f.id));
    expect(layout.height).toBeGreaterThan(bare.height);
  });
});
