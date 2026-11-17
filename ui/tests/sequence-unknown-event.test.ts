// An event type the UI does not know, at each layer that walks events.
//
// Schema validation runs first and today rejects any `type` outside the five
// it lists, so in a matched build this path is unreachable. It becomes
// reachable the day the schema gains a sixth event type and `projection.ts`
// has not caught up -- which is exactly how `note` arrived. The validator is
// stubbed open here to stand in for that newer schema; everything after it is
// the real code.
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/protocol/validate", () => ({
  validateEnvelope: (value: unknown) => ({ ok: true, value }),
}));

import { projectEnvelope, type ProjectedSequence, type ProjectedSequenceEvent } from "../src/diagrams/projection";
import { computeSequenceLayout } from "../src/layout/sequence-layout";
import { sequenceSelectionModel } from "../src/selection/sequence-selection";
import { sequenceMove } from "../src/diagrams/sequence-nav";

const KNOWN = [
  { type: "message", id: "msg-0", from: "a", to: "b", label: "one", kind: "sync" },
  { type: "message", id: "msg-1", from: "b", to: "a", label: "two", kind: "reply" },
];

function envelope(events: unknown[]): unknown {
  return {
    schemaVersion: 2,
    view: { id: "v", kind: "sequence", title: "t" },
    revision: "sha256:0",
    model: {
      type: "sequence-trace",
      participants: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      events,
    },
  };
}

const FROM_THE_FUTURE = { type: "divider", id: "div-0", text: "later" };

describe("an event type the projection does not know", () => {
  it("is refused through the result, naming the type, rather than thrown", () => {
    let result: ReturnType<typeof projectEnvelope> | undefined;
    expect(() => {
      result = projectEnvelope(envelope([KNOWN[0], FROM_THE_FUTURE, KNOWN[1]]));
    }).not.toThrow();
    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: "unknown_sequence_event",
          message: expect.stringContaining('"divider"'),
        },
      ],
    });
  });

  it("is refused when it is nested in a fragment section, too", () => {
    const result = projectEnvelope(
      envelope([
        {
          type: "fragment",
          id: "frag-0",
          kind: "opt",
          label: "maybe",
          sections: [{ events: [KNOWN[0], FROM_THE_FUTURE] }],
        },
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.code)).toEqual(["unknown_sequence_event"]);
  });

  it("is never dropped: the same trace without it still projects", () => {
    const result = projectEnvelope(envelope(KNOWN));
    expect(result.ok).toBe(true);
  });
});

describe("the layers behind projection are total, and agree", () => {
  // Projection is the one gate, so these never see an unknown event from the
  // app. They are still handed one here -- as a cast, the only way to build
  // it -- to pin that none of them throws and all of them treat it the same
  // way: it has no row, no arrow, no stop and no place in the selection.
  const view = (events: ProjectedSequenceEvent[]): ProjectedSequence => ({
    viewId: "v",
    kind: "sequence",
    title: "t",
    revision: "r",
    modelType: "sequence-trace",
    participants: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    events,
  });
  const known = KNOWN as unknown as ProjectedSequenceEvent[];
  const withStranger = view([known[0], FROM_THE_FUTURE as unknown as ProjectedSequenceEvent, known[1]]);
  const without = view(known);

  it("layout draws the trace as if the stranger were not there", () => {
    expect(computeSequenceLayout(withStranger)).toEqual(computeSequenceLayout(without));
  });

  it("selection knows the messages and nothing else", () => {
    expect([...sequenceSelectionModel(withStranger).edgeDetails.keys()]).toEqual(["msg-0", "msg-1"]);
  });

  it("the keyboard steps from the message before it to the message after it", () => {
    const layout = computeSequenceLayout(withStranger);
    expect(sequenceMove(layout, { channel: "messages", id: "msg-0" }, "down")).toEqual({
      channel: "messages",
      id: "msg-1",
    });
  });
});
