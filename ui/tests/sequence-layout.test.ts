import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectEnvelope, type ProjectedSequence } from "../src/diagrams/projection";
import {
  computeSequenceLayout,
  PARTICIPANT_WIDTH,
  PARTICIPANT_HEIGHT,
  PARTICIPANT_GAP,
  ROW_HEIGHT,
} from "../src/layout/sequence-layout";

const sequenceFixturePath = fileURLToPath(
  new URL("../../fixtures/protocol/valid/minimal-sequence.json", import.meta.url),
);

function loadSequence(): ProjectedSequence {
  const fixture = JSON.parse(readFileSync(sequenceFixturePath, "utf8"));
  const result = projectEnvelope(fixture);
  if (!result.ok || result.type !== "sequence") {
    throw new Error("Failed to project sequence fixture");
  }
  return result.view;
}

describe("sequence layout", () => {
  it("produces deterministic output", () => {
    const sequence = loadSequence();
    const first = computeSequenceLayout(sequence);
    const second = computeSequenceLayout(sequence);
    expect(second).toEqual(first);
  });

  it("positions participants evenly along the X-axis", () => {
    const layout = computeSequenceLayout(loadSequence());
    expect(layout.participants).toHaveLength(3);

    layout.participants.forEach((p, i) => {
      expect(p.x).toBe(i * PARTICIPANT_GAP);
      expect(p.y).toBe(0);
      expect(p.width).toBe(PARTICIPANT_WIDTH);
      expect(p.height).toBe(PARTICIPANT_HEIGHT);
    });
  });

  it("produces messages with valid y-positions in increasing order", () => {
    const layout = computeSequenceLayout(loadSequence());
    expect(layout.messages.length).toBeGreaterThan(0);

    // All messages should have positive y values
    for (const msg of layout.messages) {
      expect(msg.y).toBeGreaterThan(PARTICIPANT_HEIGHT);
    }
  });

  it("creates activation bars from activate/deactivate pairs", () => {
    const layout = computeSequenceLayout(loadSequence());
    expect(layout.activations.length).toBeGreaterThan(0);

    for (const activation of layout.activations) {
      expect(activation.endY).toBeGreaterThanOrEqual(activation.startY);
      expect(["client", "server", "db"]).toContain(activation.participantId);
    }
  });

  it("creates fragments for alt blocks", () => {
    const layout = computeSequenceLayout(loadSequence());
    expect(layout.fragments).toHaveLength(1);

    const frag = layout.fragments[0];
    expect(frag.id).toBe("frag-0");
    expect(frag.kind).toBe("alt");
    expect(frag.width).toBeGreaterThan(0);
    expect(frag.height).toBeGreaterThan(0);
    expect(frag.sections.length).toBeGreaterThanOrEqual(1);
  });

  it("computes correct total width and height", () => {
    const layout = computeSequenceLayout(loadSequence());
    // The participants span 2 gaps + 1 box. The extent is at least that, and
    // reaches further left because the fixture's `alt` frame pads past the
    // first box -- `width` is the box the drawing occupies, not the lifelines'.
    const participantSpan = 2 * PARTICIPANT_GAP + PARTICIPANT_WIDTH;
    expect(layout.originX).toBeLessThan(0);
    expect(layout.originX + layout.width).toBeGreaterThanOrEqual(participantSpan);
    expect(layout.width).toBeGreaterThan(participantSpan);
    // Height should be positive and reasonable
    expect(layout.height).toBeGreaterThan(PARTICIPANT_HEIGHT + ROW_HEIGHT);
  });

  it("handles empty sequence", () => {
    const emptySeq: ProjectedSequence = {
      viewId: "test",
      kind: "sequence",
      title: "Empty",
      revision: "1",
      modelType: "sequence-trace",
      participants: [],
      events: [],
    };
    const layout = computeSequenceLayout(emptySeq);
    expect(layout.participants).toHaveLength(0);
    expect(layout.messages).toHaveLength(0);
    expect(layout.fragments).toHaveLength(0);
    expect(layout.activations).toHaveLength(0);
    expect(layout.width).toBe(0);
  });

  it("handles sequence with only participants and no events", () => {
    const seq: ProjectedSequence = {
      viewId: "test",
      kind: "sequence",
      title: "No events",
      revision: "1",
      modelType: "sequence-trace",
      participants: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      events: [],
    };
    const layout = computeSequenceLayout(seq);
    expect(layout.participants).toHaveLength(2);
    expect(layout.messages).toHaveLength(0);
    expect(layout.width).toBe(PARTICIPANT_GAP + PARTICIPANT_WIDTH);
  });
});
