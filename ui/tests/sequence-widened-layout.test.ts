// What wire contract v2 added to a sequence, as geometry: notes, actors and
// message numbers (ADR 0009). Asserted on the layout, the pure half; the canvas
// draws what it is told (`sequence-widened-canvas.test.tsx`).
import { describe, expect, it } from "vitest";
import {
  projectEnvelope,
  type NotePosition,
  type ProjectedSequence,
  type ProjectedSequenceEvent,
} from "../src/diagrams/projection";
import {
  FRAGMENT_HEADER_HEIGHT,
  NOTE_FONT,
  computeSequenceLayout,
  type LayoutNote,
  type SequenceLayoutResult,
} from "../src/layout/sequence-layout";
import { estimateTextWidth } from "../src/layout/text-measure";
import { messageAccessibleName, messageBox, noteAccessibleName, type Box } from "../src/diagrams/sequence-nav";
import { loadValidFixture } from "./fixtures";

let nextId = 0;
const msg = (
  from: string,
  to: string,
  label: string | undefined = "call",
  kind: "sync" | "reply" | "async" = "sync",
): ProjectedSequenceEvent => ({ type: "message", id: `m${nextId++}`, from, to, label, kind });

const note = (position: NotePosition, participants: string[], text = "a note"): ProjectedSequenceEvent => ({
  type: "note",
  id: `n${nextId++}`,
  position,
  participants,
  text,
});

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

function sequence(events: ProjectedSequenceEvent[], extra: Partial<ProjectedSequence> = {}): ProjectedSequence {
  return {
    viewId: "v",
    kind: "sequence",
    title: "t",
    revision: "r",
    modelType: "sequence-trace",
    participants: [
      { id: "a", label: "Client" },
      { id: "b", label: "Server" },
      { id: "c", label: "Database" },
    ],
    events,
    ...extra,
  };
}

const LONG =
  "Tokens are rotated on every refresh, and a reused refresh token revokes the whole family, so a replay is caught the second time it is tried";

const right = (b: { x: number; width: number }): number => b.x + b.width;
const bottom = (b: { y: number; height: number }): number => b.y + b.height;
const centre = (layout: SequenceLayoutResult, id: string): number => {
  const p = layout.participants.find((entry) => entry.id === id)!;
  return p.x + p.width / 2;
};
const overlaps = (p: Box, q: Box): boolean => p.x < right(q) && q.x < right(p) && p.y < bottom(q) && q.y < bottom(p);
const only = (layout: SequenceLayoutResult): LayoutNote => {
  expect(layout.notes).toHaveLength(1);
  return layout.notes[0];
};

describe("a note has a band of its own", () => {
  const layout = computeSequenceLayout(
    sequence([
      msg("a", "b", "POST /login"),
      note("over", ["a", "b"], "TLS 1.3, mutual auth"),
      msg("b", "c", "SELECT user where the email matches and the account is not locked"),
      note("right-of", ["c"], LONG),
      frag("alt", "Credentials valid?", [
        { events: [note("over", ["b"], "cache the session"), msg("b", "a", "200 OK", "reply")] },
        { label: "Invalid", events: [note("left-of", ["a"], "count the failure"), msg("b", "a", "401", "reply")] },
      ]),
      note("left-of", ["b"], "done"),
    ]),
  );

  it("lays every note out, in source order, top to bottom", () => {
    expect(layout.notes.map((n) => n.text)).toEqual([
      "TLS 1.3, mutual auth",
      LONG,
      "cache the session",
      "count the failure",
      "done",
    ]);
    for (let i = 1; i < layout.notes.length; i++) {
      expect(layout.notes[i].y).toBeGreaterThanOrEqual(bottom(layout.notes[i - 1]));
    }
  });

  it("never shares a row with a message, its label included", () => {
    for (const n of layout.notes) {
      for (const message of layout.messages) {
        const box = messageBox(message);
        // The full width of the diagram: a band, not just a box.
        expect(n.y >= bottom(box) || bottom(n) <= box.y, `${n.text} vs ${message.label}`).toBe(true);
      }
    }
  });

  it("sits between the messages it was written between", () => {
    const [login, select] = layout.messages;
    const tls = layout.notes[0];
    expect(tls.y).toBeGreaterThan(login.y);
    expect(bottom(tls)).toBeLessThan(messageBox(select).y);
  });

  it("stays clear of every fragment header and section label", () => {
    for (const n of layout.notes) {
      for (const fragment of layout.fragments) {
        const header: Box = { x: fragment.x, y: fragment.y, width: fragment.width, height: FRAGMENT_HEADER_HEIGHT };
        expect(overlaps(n, header), `${n.text} vs header`).toBe(false);
        for (const section of fragment.sections.slice(1)) {
          const band: Box = { x: fragment.x, y: section.y, width: fragment.width, height: 18 };
          expect(overlaps(n, band), `${n.text} vs [${section.label}]`).toBe(false);
        }
      }
    }
  });

  it("is inside the extent the layout reports", () => {
    for (const n of layout.notes) {
      expect(n.x).toBeGreaterThanOrEqual(layout.originX);
      expect(right(n)).toBeLessThanOrEqual(layout.originX + layout.width);
      expect(bottom(n)).toBeLessThanOrEqual(layout.originY + layout.height);
    }
  });

  it("takes no place among the messages or the participants", () => {
    const ids = new Set(layout.notes.map((n) => n.id));
    expect(layout.messages.some((m) => ids.has(m.id))).toBe(false);
    expect(layout.participants.some((p) => ids.has(p.id))).toBe(false);
    expect(layout.messages).toHaveLength(4);
  });
});

describe("where a note sits", () => {
  it("centres `over a` on that lifeline", () => {
    const layout = computeSequenceLayout(sequence([msg("a", "b"), note("over", ["b"], "validated")]));
    const n = only(layout);
    expect(n.x + n.width / 2).toBeCloseTo(centre(layout, "b"), 5);
  });

  it("spans both lifelines for `over a,b`, in either order", () => {
    for (const pair of [
      ["a", "c"],
      ["c", "a"],
    ]) {
      const layout = computeSequenceLayout(sequence([note("over", pair, "handshake")]));
      const n = only(layout);
      expect(n.x).toBeLessThan(centre(layout, "a"));
      expect(right(n)).toBeGreaterThan(centre(layout, "c"));
    }
  });

  it("puts `right of` beside its lifeline and pushes the next lifeline clear of it", () => {
    const plain = computeSequenceLayout(sequence([msg("a", "b")]));
    const layout = computeSequenceLayout(sequence([msg("a", "b"), note("right-of", ["a"], LONG)]));
    const n = only(layout);
    expect(n.x).toBeGreaterThan(centre(layout, "a"));
    expect(right(n)).toBeLessThan(centre(layout, "b"));
    // It really had to move: the note is wider than the default pitch.
    expect(centre(layout, "b") - centre(layout, "a")).toBeGreaterThan(centre(plain, "b") - centre(plain, "a"));
  });

  it("puts `left of` beside its lifeline and pushes the previous lifeline clear of it", () => {
    const layout = computeSequenceLayout(sequence([msg("a", "b"), note("left-of", ["b"], LONG)]));
    const n = only(layout);
    expect(right(n)).toBeLessThan(centre(layout, "b"));
    expect(n.x).toBeGreaterThan(centre(layout, "a"));
  });

  it("extends the extent for `left of` the first lifeline rather than clipping", () => {
    const layout = computeSequenceLayout(sequence([msg("a", "b"), note("left-of", ["a"], LONG)]));
    const n = only(layout);
    expect(right(n)).toBeLessThan(centre(layout, "a"));
    expect(n.x).toBeLessThan(layout.participants[0].x);
    expect(layout.originX).toBeLessThanOrEqual(n.x);
    expect(layout.originX + layout.width).toBeGreaterThanOrEqual(right(layout.participants[2]));
  });

  it("extends the extent for `right of` the last lifeline rather than clipping", () => {
    const layout = computeSequenceLayout(sequence([msg("a", "b"), note("right-of", ["c"], LONG)]));
    const n = only(layout);
    expect(n.x).toBeGreaterThan(centre(layout, "c"));
    expect(right(n)).toBeGreaterThan(right(layout.participants[2]));
    expect(layout.originX + layout.width).toBeGreaterThanOrEqual(right(n));
  });

  it("clears an open activation bar beside its lifeline", () => {
    const layout = computeSequenceLayout(
      sequence([
        msg("a", "b"),
        { type: "activate", participant: "b" },
        { type: "activate", participant: "b" },
        note("right-of", ["b"], "busy"),
        note("left-of", ["b"], "busy"),
      ]),
    );
    const [rightNote, leftNote] = layout.notes;
    // Two nested bars reach 9px right of the lifeline and 5px left of it.
    expect(rightNote.x).toBeGreaterThan(centre(layout, "b") + 9);
    expect(right(leftNote)).toBeLessThan(centre(layout, "b") - 5);
  });
});

describe("a note is sized to its text", () => {
  it("wraps a long note and grows downwards, every line inside the sheet", () => {
    const short = only(computeSequenceLayout(sequence([note("over", ["b"], "ok")])));
    const long = only(computeSequenceLayout(sequence([note("over", ["b"], LONG)])));
    expect(long.lines.length).toBeGreaterThan(2);
    expect(long.lines.join(" ")).toBe(LONG);
    expect(long.height).toBeGreaterThan(short.height);
    expect(long.width).toBeGreaterThan(short.width);
    for (const line of long.lines) {
      expect(estimateTextWidth(line, NOTE_FONT)).toBeLessThan(long.width);
    }
    // Wrapped, not stretched: nowhere near the width of the text on one line.
    expect(long.width).toBeLessThan(estimateTextWidth(LONG, NOTE_FONT) / 2);
  });

  it("wraps `over a,b` to the span between the lifelines", () => {
    const layout = computeSequenceLayout(sequence([note("over", ["a", "b"], LONG)]));
    const n = only(layout);
    expect(n.lines.length).toBeGreaterThan(1);
    for (const line of n.lines) {
      expect(estimateTextWidth(line, NOTE_FONT)).toBeLessThan(n.width);
    }
    expect(right(n)).toBeLessThan(centre(layout, "c"));
  });
});

describe("a note inside a fragment", () => {
  it("is framed by it, and widens the frame when it reaches past the lifelines", () => {
    const without = computeSequenceLayout(sequence([frag("opt", "maybe", [{ events: [msg("a", "b")] }])]));
    const layout = computeSequenceLayout(
      sequence([frag("opt", "maybe", [{ events: [msg("a", "b"), note("left-of", ["a"], LONG)] }])]),
    );
    const frame = layout.fragments[0];
    const n = only(layout);
    expect(frame.x).toBeLessThan(n.x);
    expect(right(frame)).toBeGreaterThan(right(n));
    expect(frame.y).toBeLessThan(n.y);
    expect(bottom(frame)).toBeGreaterThan(bottom(n));
    expect(frame.x).toBeLessThan(without.fragments[0].x);
    expect(layout.originX).toBeLessThanOrEqual(frame.x);
  });

  it("gives a fragment that holds only a note a frame around that note", () => {
    const layout = computeSequenceLayout(
      sequence([frag("opt", "maybe", [{ events: [note("over", ["b"], "nothing yet")] }])]),
    );
    const frame = layout.fragments[0];
    const n = only(layout);
    expect(frame.y + FRAGMENT_HEADER_HEIGHT).toBeLessThanOrEqual(n.y);
    expect(bottom(frame)).toBeGreaterThan(bottom(n));
  });
});

describe("a note's accessible name", () => {
  const participants = [
    { id: "a", label: "Client" },
    { id: "b", label: "Server" },
  ];
  it.each([
    ["left-of", ["a"], "Note left of Client: signed out"],
    ["right-of", ["b"], "Note right of Server: signed out"],
    ["over", ["a"], "Note over Client: signed out"],
    ["over", ["a", "b"], "Note over Client and Server: signed out"],
  ] as const)("%s %j", (position, ids, expected) => {
    expect(noteAccessibleName({ position, participants: ids, text: "signed out" }, participants)).toBe(expected);
  });
});

describe("autonumber", () => {
  const events = (): ProjectedSequenceEvent[] => [
    msg("a", "b", "one"),
    note("over", ["a"], "not counted"),
    frag("alt", "ok", [
      { events: [msg("b", "c", "two"), msg("c", "b", "three", "reply")] },
      { label: "no", events: [msg("b", "a", "four", "reply")] },
    ]),
    msg("a", "a", "five"),
    { type: "message", id: "unlabelled", from: "a", to: "b", label: undefined, kind: "sync" },
  ];

  it("numbers every message 1..N in source order, through fragments, skipping notes", () => {
    const layout = computeSequenceLayout(sequence(events(), { autonumber: true }));
    expect(layout.messages.map((m) => [m.label, m.number])).toEqual([
      ["one", 1],
      ["two", 2],
      ["three", 3],
      ["four", 4],
      ["five", 5],
      [undefined, 6],
    ]);
  });

  it("numbers nothing when the trace did not ask for it", () => {
    for (const autonumber of [false, undefined]) {
      const layout = computeSequenceLayout(sequence(events(), { autonumber }));
      expect(layout.messages.every((m) => m.number === undefined)).toBe(true);
    }
  });

  it("reserves room for the badge: a label never reaches the badge at the start of its arrow", () => {
    const tight = "an exactly-as-wide-as-the-gap label, more or less, here";
    const plain = computeSequenceLayout(sequence([msg("a", "b", tight)]));
    const numbered = computeSequenceLayout(sequence([msg("a", "b", tight)], { autonumber: true }));
    expect(centre(numbered, "b") - centre(numbered, "a")).toBeGreaterThan(centre(plain, "b") - centre(plain, "a"));

    const m = numbered.messages[0];
    const badgeEnd = m.fromX + m.badgeWidth! / 2;
    const labelStart = (m.fromX + m.toX) / 2 - m.labelWidth / 2;
    expect(labelStart).toBeGreaterThan(badgeEnd);
  });

  it("widens the badge for a two-digit number", () => {
    const many = Array.from({ length: 12 }, () => msg("a", "b", "x"));
    const layout = computeSequenceLayout(sequence(many, { autonumber: true }));
    expect(layout.messages[11].number).toBe(12);
    expect(layout.messages[11].badgeWidth!).toBeGreaterThan(layout.messages[0].badgeWidth!);
  });

  it("includes the badge in the box the pointer and the camera use", () => {
    const layout = computeSequenceLayout(sequence([msg("b", "a", "back")], { autonumber: true }));
    const m = layout.messages[0];
    // The arrow runs right to left, so its badge is at the right-hand end.
    expect(right(messageBox(m))).toBeGreaterThanOrEqual(m.fromX + m.badgeWidth! / 2);
  });

  it("puts the number in the message's accessible name", () => {
    const layout = computeSequenceLayout(sequence(events(), { autonumber: true }));
    expect(messageAccessibleName(layout.messages[1], layout.participants)).toBe("2. Server to Database: two");
    expect(messageAccessibleName(layout.messages[5], layout.participants)).toBe("6. Client to Server");
    const off = computeSequenceLayout(sequence(events()));
    expect(messageAccessibleName(off.messages[1], off.participants)).toBe("Server to Database: two");
  });
});

describe("actors", () => {
  const withKinds = (label: string): ProjectedSequence =>
    sequence([msg("a", "b")], {
      participants: [
        { id: "a", label, kind: "actor" },
        { id: "b", label },
        { id: "c", label: "Database", kind: "participant" },
      ],
    });

  it("carries the kind of every participant, defaulting to participant", () => {
    const layout = computeSequenceLayout(withKinds("Billing administrator"));
    expect(layout.participants.map((p) => p.kind)).toEqual(["actor", "participant", "participant"]);
  });

  it("makes room in the box for the figure beside the name", () => {
    const layout = computeSequenceLayout(withKinds("Billing administrator"));
    const [actor, system] = layout.participants;
    expect(actor.width).toBeGreaterThan(system.width);
    expect(actor.height).toBe(system.height);
    expect(actor.y).toBe(system.y);
  });

  it("keeps a short-named actor at the same minimum box as anyone else", () => {
    const layout = computeSequenceLayout(withKinds("User"));
    expect(layout.participants[0].width).toBe(layout.participants[1].width);
  });
});

describe("the shared widened fixture", () => {
  it("lays out its notes, its actor and its numbers", () => {
    const projection = projectEnvelope(loadValidFixture("widened-sequence.json"));
    if (!projection.ok || projection.type !== "sequence") throw new Error("fixture did not project");
    const layout = computeSequenceLayout(projection.view);
    // Source order, the one inside the `alt` included.
    expect(layout.notes.map((n) => n.id)).toEqual(["note-0", "note-1", "note-2", "note-3"]);
    expect(layout.participants[0].kind).toBe("actor");
    expect(projection.view.autonumber).toBe(true);
    expect(layout.messages.map((m) => m.number)).toEqual(layout.messages.map((_, i) => i + 1));
  });
});
