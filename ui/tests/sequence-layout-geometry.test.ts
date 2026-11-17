// Geometry the sequence layout owes the canvas.
//
// Every case here was a defect seen in the running app: fragment frames laid
// out left of the origin and clipped, sibling and nested frames drawn on top of
// each other, an `else` label printed across the first message under it, and
// participant boxes too narrow for their own names. They are asserted on the
// layout rather than on pixels because the layout is the pure half; the canvas
// only draws what it is told.
import { describe, expect, it } from "vitest";
import type { ProjectedSequence, ProjectedSequenceEvent } from "../src/diagrams/projection";
import { PARTICIPANT_WIDTH, computeSequenceLayout, type LayoutFragment } from "../src/layout/sequence-layout";

let nextId = 0;
const msg = (
  from: string,
  to: string,
  label: string | undefined = "call",
  kind: "sync" | "reply" | "async" = "sync",
): ProjectedSequenceEvent => ({ type: "message", id: `m${nextId++}`, from, to, label, kind });

const frag = (
  kind: "loop" | "alt" | "opt" | "par",
  label: string,
  sections: { label?: string; events: ProjectedSequenceEvent[] }[],
): ProjectedSequenceEvent => ({
  type: "fragment",
  id: `f${nextId++}`,
  kind,
  label,
  sections: sections.map((s) => ({ label: s.label, events: s.events })),
});

function sequence(participants: [string, string][], events: ProjectedSequenceEvent[]): ProjectedSequence {
  return {
    viewId: "v",
    kind: "sequence",
    title: "t",
    revision: "r",
    modelType: "sequence-trace",
    participants: participants.map(([id, label]) => ({ id, label })),
    events,
  };
}

const ABC: [string, string][] = [
  ["a", "Client"],
  ["b", "Server"],
  ["c", "Database"],
];

const right = (f: { x: number; width: number }): number => f.x + f.width;
const bottom = (f: { y: number; height: number }): number => f.y + f.height;
const byKind = (fragments: readonly LayoutFragment[], kind: string): LayoutFragment => {
  const found = fragments.find((f) => f.kind === kind);
  if (!found) throw new Error(`no ${kind} fragment`);
  return found;
};

describe("sequence layout bounds", () => {
  it("reports an extent that contains every mark, including fragment overhang", () => {
    const layout = computeSequenceLayout(sequence(ABC, [frag("opt", "maybe", [{ events: [msg("a", "c")] }])]));

    const marks = [...layout.participants, ...layout.fragments];
    for (const mark of marks) {
      expect(mark.x).toBeGreaterThanOrEqual(layout.originX);
      expect(right(mark)).toBeLessThanOrEqual(layout.originX + layout.width);
      expect(mark.y).toBeGreaterThanOrEqual(layout.originY);
      expect(bottom(mark)).toBeLessThanOrEqual(layout.originY + layout.height);
    }
    // The frame really does reach past the first participant box; the extent
    // has to say so rather than assume everything starts at zero.
    expect(layout.fragments[0].x).toBeLessThan(layout.participants[0].x);
  });

  it("includes a self-message label on the last lifeline in the extent", () => {
    const layout = computeSequenceLayout(sequence(ABC, [msg("c", "c", "recompute the materialised view")]));
    const last = layout.participants[2];
    expect(layout.originX + layout.width).toBeGreaterThan(right(last) + 100);
  });
});

describe("sequence fragments", () => {
  it("insets a nested frame inside its parent on every side", () => {
    const layout = computeSequenceLayout(
      sequence(ABC, [
        frag("loop", "retry", [
          { events: [frag("alt", "ok", [{ events: [msg("a", "c")] }, { label: "fail", events: [msg("c", "a")] }])] },
        ]),
      ]),
    );
    const outer = byKind(layout.fragments, "loop");
    const inner = byKind(layout.fragments, "alt");

    expect(outer.x).toBeLessThan(inner.x);
    expect(right(outer)).toBeGreaterThan(right(inner));
    expect(outer.y).toBeLessThan(inner.y);
    expect(bottom(outer)).toBeGreaterThan(bottom(inner));
  });

  it("lists an enclosing frame before the frames it contains, so it paints underneath", () => {
    const layout = computeSequenceLayout(
      sequence(ABC, [frag("loop", "retry", [{ events: [frag("opt", "log", [{ events: [msg("a", "b")] }])] }])]),
    );
    expect(layout.fragments.map((f) => f.kind)).toEqual(["loop", "opt"]);
  });

  it("never overlaps two sibling frames", () => {
    const layout = computeSequenceLayout(
      sequence(ABC, [
        frag("alt", "valid", [{ events: [msg("b", "a")] }, { label: "invalid", events: [msg("b", "a")] }]),
        frag("opt", "profile", [{ events: [msg("a", "b")] }]),
        frag("par", "notify", [{ events: [msg("b", "a")] }, { label: "log", events: [msg("b", "c")] }]),
      ]),
    );
    const [first, second, third] = layout.fragments;
    expect(second.y).toBeGreaterThan(bottom(first));
    expect(third.y).toBeGreaterThan(bottom(second));
  });

  it("gives a section label a band of its own, clear of the message under it", () => {
    const layout = computeSequenceLayout(
      sequence(ABC, [
        frag("alt", "valid", [
          { events: [msg("b", "a", "200 OK")] },
          { label: "Invalid credentials", events: [msg("b", "a", "401 Unauthorized")] },
        ]),
      ]),
    );
    const divider = layout.fragments[0].sections[1];
    const under = layout.messages[1];
    // The label sits just under the divider; the message's own label sits just
    // above its arrow. Both are ~14px tall, so the arrow has to be well clear.
    expect(under.y - divider.y).toBeGreaterThanOrEqual(36);
  });

  it("keeps the header clear of the first message in the frame", () => {
    const layout = computeSequenceLayout(
      sequence(ABC, [frag("opt", "Fetch profile", [{ events: [msg("a", "b", "GET /profile")] }])]),
    );
    expect(layout.messages[0].y - layout.fragments[0].y).toBeGreaterThanOrEqual(36);
  });

  it("widens a frame to hold its own header", () => {
    const layout = computeSequenceLayout(
      sequence(
        [["a", "A"]],
        [frag("loop", "until the upstream circuit breaker closes again", [{ events: [msg("a", "a", "x")] }])],
      ),
    );
    expect(layout.fragments[0].width).toBeGreaterThan(300);
  });
});

describe("sequence participants and message labels", () => {
  it("widens a participant box to hold a long name without touching its neighbour", () => {
    const layout = computeSequenceLayout(
      sequence(
        [
          ["a", "Customer-facing Web Application"],
          ["b", "Identity Provider"],
        ],
        [msg("a", "b")],
      ),
    );
    const [first, second] = layout.participants;
    expect(first.width).toBeGreaterThan(PARTICIPANT_WIDTH);
    expect(second.x).toBeGreaterThan(right(first));
  });

  it("spreads two lifelines far enough apart for the label between them", () => {
    const label = "GET /authorize?response_type=code";
    const layout = computeSequenceLayout(sequence(ABC, [msg("a", "b", label)]));
    const message = layout.messages[0];
    const span =
      layout.participants[1].x +
      layout.participants[1].width / 2 -
      (layout.participants[0].x + layout.participants[0].width / 2);
    expect(message.lines).toEqual([label]);
    expect(span).toBeGreaterThanOrEqual(message.labelWidth);
  });

  it("wraps a label too long for any sensible spacing, and gives the extra lines room", () => {
    const long =
      "GET /authorize?response_type=code&client_id=abc&redirect_uri=https://example.com/callback&scope=openid profile email";
    const layout = computeSequenceLayout(
      sequence(ABC, [msg("a", "b", "short"), msg("a", "b", long), msg("b", "a", "ok")]),
    );
    const [, wrapped, after] = layout.messages;
    expect(wrapped.lines.length).toBeGreaterThan(1);
    // The row under a wrapped label is pushed down by the lines it added.
    const wrappedPitch = wrapped.y - layout.messages[0].y;
    expect(wrappedPitch).toBeGreaterThan(after.y - wrapped.y);
  });
});

describe("sequence activations", () => {
  it("starts a bar at the message that triggered it, not a row later", () => {
    const layout = computeSequenceLayout(
      sequence(ABC, [
        msg("a", "b", "POST /login"),
        { type: "activate", participant: "b" },
        msg("b", "c", "SELECT user"),
        msg("c", "b", "row", "reply"),
        { type: "deactivate", participant: "b" },
        msg("b", "a", "200", "reply"),
      ]),
    );
    const [bar] = layout.activations;
    expect(bar.startY).toBe(layout.messages[0].y);
    expect(bar.endY).toBe(layout.messages[2].y);
  });
});
